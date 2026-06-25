import 'dotenv/config';
import express from 'express';
import axios   from 'axios';
import cors    from 'cors';
import path    from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app = express();
app.use(cors({ origin: '*' }));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, x-password');
  next();
});
app.use(express.json());
app.use(express.static(path.join(__dirname)));   // serves index.html

// ── Auth ──────────────────────────────────────────────────────────────────────
const PASSWORD = process.env.DASHBOARD_PASSWORD || 'golf';

app.post('/api/login', (req, res) => {
  const { password } = req.body;
  if (password === PASSWORD) {
    res.json({ success: true });
  } else {
    res.status(401).json({ success: false, error: 'Wrong password' });
  }
});

function requireAuth(req, res, next) {
  const pw = req.headers['x-password'];
  if (pw === PASSWORD) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// ── ShipStation client ────────────────────────────────────────────────────────
const SS_AUTH = Buffer.from(
  `${process.env.SHIPSTATION_API_KEY}:${process.env.SHIPSTATION_API_SECRET}`
).toString('base64');

const ss = axios.create({
  baseURL: 'https://ssapi.shipstation.com',
  headers: { Authorization: `Basic ${SS_AUTH}` }
});

// ── Store ID → label map ──────────────────────────────────────────────────────
const STORE_LABELS = {
  304177: 'WhyGolf Retail (DTC)',
  342112: 'WhyGolf Wholesale',
  325792: 'Amazon FBM',
  188942: 'Manual Orders',
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function monthsAgo(n) {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  return d.toISOString().split('T')[0];
}

function carrierLabel(code) {
  const map = {
    fedex:        'FedEx',
    stamps_com:   'USPS',
    usps:         'USPS',
    ups:          'UPS (ShipStation)',
    ups_walleted: 'UPS (WhyGolf + Unishippers)',
    ups_wn:       'UPS (Unishippers)',
  };
  return map[code] || code;
}

// ── Cache (30 min, keyed by date range) ──────────────────────────────────────
const cache        = {};  // ShipStation analytics cache
const shopifyCache = {};  // Shopify overview cache
const CACHE_MS = 30 * 60 * 1000;

// ── Fetch one page with retry on 429 ─────────────────────────────────────────
async function fetchPage(startDate, endDate, page, retries = 0) {
  try {
    const { data } = await ss.get('/shipments', {
      params: { shipDateStart: startDate, shipDateEnd: endDate, pageSize: 500, page, includeShipmentItems: true }
    });
    return data;
  } catch (err) {
    if (err.response?.status === 429 && retries < 5) {
      const wait = 2000 * (retries + 1); // 2s, 4s, 6s, 8s, 10s
      console.log(`Rate limited on page ${page}, retrying in ${wait}ms...`);
      await new Promise(r => setTimeout(r, wait));
      return fetchPage(startDate, endDate, page, retries + 1);
    }
    throw err;
  }
}

// ── Fetch all shipments for a date range ──────────────────────────────────────
async function fetchShipments(startDate, endDate) {
  let page = 1, all = [];

  while (true) {
    const data = await fetchPage(startDate, endDate, page);

    const valid = (data.shipments || []).filter(s => !s.voided && s.shipmentCost > 0);
    all = all.concat(valid);

    if (page >= data.pages) break;
    page++;

    // Respect ShipStation rate limit (40 req/min)
    await new Promise(r => setTimeout(r, 300));
  }

  return all;
}

// ── Analytics endpoint ────────────────────────────────────────────────────────
app.get('/api/analytics', requireAuth, async (req, res) => {
  try {
    // Return cached data if fresh
    const startDate = req.query.start || monthsAgo(3);
    const endDate   = req.query.end   || new Date().toISOString().split('T')[0];
    const cacheKey  = `${startDate}_${endDate}`;

    if (cache[cacheKey] && Date.now() - cache[cacheKey].ts < CACHE_MS) {
      return res.json({ ...cache[cacheKey].data, cached: true });
    }

    const shipments = await fetchShipments(startDate, endDate);

    const carriers   = {};
    const products   = {};
    const stores     = {};

    // Services that charge dim weight on ALL packages (no size threshold)
    const AIR_SERVICES = new Set([
      'fedex_2day', 'fedex_2day_am', 'fedex_express_saver',
      'fedex_first_overnight', 'fedex_priority_overnight', 'fedex_standard_overnight',
      'fedex_international_priority', 'fedex_international_economy',
      'ups_next_day_air', 'ups_next_day_air_saver', 'ups_next_day_air_early_am',
      'ups_2nd_day_air', 'ups_2nd_day_air_am', 'ups_3_day_select',
    ]);

    // Dim divisor by carrier
    function dimDivisor(carrierCode) {
      return (carrierCode === 'stamps_com' || carrierCode === 'usps') ? 166 : 139;
    }

    // Compute dimensional weight for a shipment (returns null if not applicable)
    function calcDimWeight(carrierCode, serviceCode, dims) {
      if (!dims?.length || !dims?.width || !dims?.height) return null;
      const cuIn = dims.length * dims.width * dims.height;
      const isAir = AIR_SERVICES.has(serviceCode);
      if (!isAir && cuIn <= 1728) return null; // ground threshold: 1 cu ft
      return cuIn / dimDivisor(carrierCode);
    }

    for (const s of shipments) {
      const c    = s.carrierCode  || 'unknown';
      const svc  = s.serviceCode  || 'unknown';
      const cost = s.shipmentCost || 0;

      // Store / channel tracking
      const sid = s.advancedOptions?.storeId;
      if (sid) {
        if (!stores[sid]) stores[sid] = { count: 0, units: 0 };
        stores[sid].count++;
        const units = (s.shipmentItems || []).reduce((sum, i) => sum + (i.quantity || 1), 0);
        stores[sid].units += units || 1;
      }

      if (!carriers[c]) carriers[c] = {
        count: 0, totalCost: 0, services: {},
        actualWeightOz: 0, weightCount: 0,
        dimWeightLbs: 0, dimWeightCount: 0,
        billableWeightLbs: 0, billableCount: 0,
        dimL: 0, dimW: 0, dimH: 0, dimCount: 0,
        dimGroups: {},
      };
      carriers[c].count++;
      carriers[c].totalCost += cost;
      carriers[c].services[svc] = (carriers[c].services[svc] || 0) + 1;

      // ── weight rollup ──
      const actualOz  = s.weight?.value || 0;
      const actualLbs = actualOz / 16;
      if (actualOz) {
        carriers[c].actualWeightOz += actualOz;
        carriers[c].weightCount++;
      }

      // ── dimensional weight rollup ──
      const dims    = s.dimensions;
      const dimWt   = calcDimWeight(c, svc, dims);
      if (dims?.length && dims?.width && dims?.height) {
        carriers[c].dimL += dims.length;
        carriers[c].dimW += dims.width;
        carriers[c].dimH += dims.height;
        carriers[c].dimCount++;
        // Group by rounded dimensions
        const key = `${Math.round(dims.length)}x${Math.round(dims.width)}x${Math.round(dims.height)}`;
        carriers[c].dimGroups[key] = (carriers[c].dimGroups[key] || 0) + 1;
      }
      if (dimWt !== null) {
        carriers[c].dimWeightLbs   += dimWt;
        carriers[c].dimWeightCount++;
        // billable = max(actual, dim)
        carriers[c].billableWeightLbs += Math.max(actualLbs, dimWt);
        carriers[c].billableCount++;
      } else if (actualOz) {
        carriers[c].billableWeightLbs += actualLbs;
        carriers[c].billableCount++;
      }

      // ── product rollup ──
      const items = s.shipmentItems || [];
      if (items.length === 0) continue;

      const costPerItem = cost / items.length;

      for (const item of items) {
        const name = item.name || item.sku || 'Unknown Product';
        if (!products[name]) products[name] = { totalCost: 0, count: 0 };
        products[name].totalCost += costPerItem;
        products[name].count++;
      }
    }

    const total = shipments.length;

    // ── format carrier breakdown ──
    const carrierBreakdown = Object.entries(carriers)
      .sort((a, b) => b[1].count - a[1].count)
      .map(([code, d]) => {
        const avgL = d.dimCount ? +(d.dimL / d.dimCount).toFixed(1) : null;
        const avgW = d.dimCount ? +(d.dimW / d.dimCount).toFixed(1) : null;
        const avgH = d.dimCount ? +(d.dimH / d.dimCount).toFixed(1) : null;
        const divisor = dimDivisor(code);
        return {
          code,
          label:             carrierLabel(code),
          count:             d.count,
          pct:               +((d.count / total) * 100).toFixed(1),
          avgCost:           +(d.totalCost / d.count).toFixed(2),
          totalCost:         +d.totalCost.toFixed(2),
          avgActualWeight:   d.weightCount   ? +((d.actualWeightOz / d.weightCount) / 16).toFixed(2) : null,
          avgDimWeight:      d.dimWeightCount ? +(d.dimWeightLbs / d.dimWeightCount).toFixed(2) : null,
          avgBillableWeight: d.billableCount  ? +(d.billableWeightLbs / d.billableCount).toFixed(2) : null,
          dimAppliesPct:     d.dimCount       ? +((d.dimWeightCount / d.dimCount) * 100).toFixed(0) : 0,
          dimDivisor:        divisor,
          avgDimensions:     avgL ? { l: avgL, w: avgW, h: avgH } : null,
          dimCoverage:       d.dimCount ? +((d.dimCount / d.count) * 100).toFixed(0) : 0,
          topDimensions:     Object.entries(d.dimGroups)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3)
            .map(([key, cnt]) => {
              const [l, w, h] = key.split('x').map(Number);
              return { dims: `${l}" × ${w}" × ${h}"`, count: cnt, pct: +((cnt / d.dimCount) * 100).toFixed(1) };
            }),
          services:          Object.entries(d.services)
            .sort((a, b) => b[1] - a[1])
            .map(([svc, cnt]) => ({
              service: svc,
              count:   cnt,
              pct:     +((cnt / d.count) * 100).toFixed(1)
            }))
        };
      });

    // ── format product breakdown ──
    const productBreakdown = Object.entries(products)
      .map(([name, d]) => ({
        name,
        avgCost:  +(d.totalCost / d.count).toFixed(2),
        shipments: d.count
      }))
      .sort((a, b) => b.shipments - a.shipments)
      .slice(0, 30);

    const storeBreakdown = Object.entries(stores)
      .sort((a, b) => b[1].count - a[1].count)
      .map(([id, d]) => ({
        storeId: Number(id),
        name:    STORE_LABELS[Number(id)] || `Store ${id}`,
        count:   d.count,
        units:   d.units,
        pct:     +((d.count / total) * 100).toFixed(1),
      }));

    const result = {
      generatedAt:     new Date().toISOString(),
      dateRange:       `${startDate} → ${endDate}`,
      totalShipments:  total,
      carrierBreakdown,
      productBreakdown,
      storeBreakdown,
    };

    cache[cacheKey] = { data: result, ts: Date.now() };
    res.json(result);

  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Shopify OAuth ─────────────────────────────────────────────────────────────
const SHOPIFY_CLIENT_ID     = process.env.SHOPIFY_CLIENT_ID;
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const SHOPIFY_SHOP          = process.env.SHOPIFY_SHOP || 'protransition.myshopify.com';
const RAILWAY_URL           = 'https://averywgp1-production.up.railway.app';

app.get('/shopify/install', (req, res) => {
  const redirectUri = `${RAILWAY_URL}/shopify/callback`;
  const scopes = 'read_orders,read_products,read_fulfillments,write_fulfillments';
  const installUrl = `https://${SHOPIFY_SHOP}/admin/oauth/authorize?client_id=${SHOPIFY_CLIENT_ID}&scope=${scopes}&redirect_uri=${redirectUri}`;
  res.redirect(installUrl);
});

app.get('/shopify/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('Missing code');
  try {
    const { data } = await axios.post(`https://${SHOPIFY_SHOP}/admin/oauth/access_token`, {
      client_id:     SHOPIFY_CLIENT_ID,
      client_secret: SHOPIFY_CLIENT_SECRET,
      code,
    });
    // Display the token so you can copy it into Railway env vars
    res.send(`
      <h2>Shopify Connected!</h2>
      <p>Copy this token into Railway as <strong>SHOPIFY_ACCESS_TOKEN</strong>:</p>
      <code style="font-size:14px;word-break:break-all">${data.access_token}</code>
      <p>Once saved in Railway, you can close this tab.</p>
    `);
  } catch (err) {
    res.status(500).send(`OAuth error: ${err.response?.data?.error_description || err.message}`);
  }
});

// ── Shopify API client ────────────────────────────────────────────────────────
const shopify = axios.create({
  baseURL: `https://${SHOPIFY_SHOP}/admin/api/2026-04`,
  headers: { 'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN }
});

// Fetch international orders for Putting Thing + Wrist-X
app.get('/api/shopify/international-orders', requireAuth, async (req, res) => {
  try {
    const startDate = req.query.start || monthsAgo(3);
    const endDate   = req.query.end   || new Date().toISOString().split('T')[0];

    let orders = [], pageInfo = null;

    while (true) {
      let params;
      if (pageInfo) {
        params = { limit: 250, page_info: pageInfo };
      } else {
        params = {
          status: 'any',
          created_at_min: `${startDate}T00:00:00Z`,
          created_at_max: `${endDate}T23:59:59Z`,
          limit: 250,
          fields: 'id,name,created_at,shipping_address,line_items,total_price,fulfillment_status',
        };
      }

      const resp = await shopify.get('/orders.json', { params });
      const batch = resp.data.orders || [];
      orders = orders.concat(batch);

      const link = resp.headers['link'] || '';
      const next = link.match(/<[^>]+page_info=([^>&"]+)[^>]*>;\s*rel="next"/);
      if (!next || batch.length < 250) break;
      pageInfo = next[1];
      await new Promise(r => setTimeout(r, 300));
    }

    // Filter: international only (non-US) + contains Putting Thing or Wrist-X
    const TARGET_PRODUCTS = ['putting thing', 'wrist-x', 'wristx', 'wrist x'];

    const filtered = orders.filter(o => {
      const country = o.shipping_address?.country_code || '';
      if (country === 'US' || !country) return false;
      return o.line_items?.some(item =>
        TARGET_PRODUCTS.some(t => item.name?.toLowerCase().includes(t) || item.title?.toLowerCase().includes(t))
      );
    });

    // Summarize
    const summary = {
      totalOrders: filtered.length,
      dateRange: `${startDate} → ${endDate}`,
      byCountry: {},
      byProduct: {},
      orders: filtered.map(o => ({
        id:        o.name,
        date:      o.created_at?.split('T')[0],
        country:   o.shipping_address?.country_code,
        total:     o.total_price,
        status:    o.fulfillment_status || 'unfulfilled',
        products:  o.line_items?.map(i => ({ name: i.title, qty: i.quantity })),
      }))
    };

    for (const o of filtered) {
      const c = o.shipping_address?.country_code || 'Unknown';
      summary.byCountry[c] = (summary.byCountry[c] || 0) + 1;
      for (const item of o.line_items || []) {
        const name = item.title || item.name || 'Unknown';
        if (TARGET_PRODUCTS.some(t => name.toLowerCase().includes(t))) {
          summary.byProduct[name] = (summary.byProduct[name] || 0) + item.quantity;
        }
      }
    }

    res.json(summary);
  } catch (err) {
    console.error('Shopify error:', err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Shopify 360 Overview ──────────────────────────────────────────────────────
app.get('/api/shopify/overview', requireAuth, async (req, res) => {
  try {
    const startDate = req.query.start || monthsAgo(3);
    const endDate   = req.query.end   || new Date().toISOString().split('T')[0];
    const cacheKey  = `shopify_${startDate}_${endDate}`;

    if (shopifyCache[cacheKey] && Date.now() - shopifyCache[cacheKey].ts < CACHE_MS) {
      return res.json({ ...shopifyCache[cacheKey].data, cached: true });
    }

    let orders = [], pageInfo = null;
    while (true) {
      let params;
      if (pageInfo) {
        params = { limit: 250, page_info: pageInfo };
      } else {
        params = {
          status: 'any',
          created_at_min: `${startDate}T00:00:00Z`,
          created_at_max: `${endDate}T23:59:59Z`,
          limit: 250,
          fields: 'id,created_at,shipping_address,line_items,total_price',
        };
      }
      const resp = await shopify.get('/orders.json', { params });
      const batch = resp.data.orders || [];
      orders = orders.concat(batch);
      const link = resp.headers['link'] || '';
      const next = link.match(/<[^>]+page_info=([^>&"]+)[^>]*>;\s*rel="next"/);
      if (!next || batch.length < 250) break;
      pageInfo = next[1];
      await new Promise(r => setTimeout(r, 50));
    }

    let usCount = 0, intlCount = 0;
    const byCountry = {}, byState = {}, byProduct = {};

    for (const o of orders) {
      const cc = o.shipping_address?.country_code || 'Unknown';
      const isUS = cc === 'US';
      isUS ? usCount++ : intlCount++;

      if (isUS) {
        const state = o.shipping_address?.province_code || 'Unknown';
        byState[state] = (byState[state] || 0) + 1;
      } else {
        byCountry[cc] = (byCountry[cc] || 0) + 1;
      }

      for (const item of o.line_items || []) {
        const name = item.title || 'Unknown';
        if (/package.?protection|returns?|extend/i.test(name)) continue;
        if (!byProduct[name]) byProduct[name] = { units: 0, orders: 0 };
        byProduct[name].units  += item.quantity || 0;
        byProduct[name].orders += 1;
      }
    }

    const total = orders.length;
    const topCountries = Object.entries(byCountry).sort((a,b)=>b[1]-a[1]).slice(0,10).map(([c,n])=>({country:c,orders:n,pct:+((n/total)*100).toFixed(1)}));
    const topStates    = Object.entries(byState).sort((a,b)=>b[1]-a[1]).slice(0,10).map(([s,n])=>({state:s,orders:n,pct:+((n/total)*100).toFixed(1)}));
    const topProducts  = Object.entries(byProduct).sort((a,b)=>b[1].orders-a[1].orders).slice(0,10).map(([name,d])=>({name,orders:d.orders,units:d.units}));

    // Fetch product images
    let productImages = {};
    try {
      const { data: prodData } = await shopify.get('/products.json', { params: { fields: 'title,image', limit: 250 } });
      for (const p of prodData.products || []) {
        if (p.image?.src) productImages[p.title] = p.image.src;
      }
    } catch(e) {}
    const topProductsWithImages = topProducts.map(p => ({ ...p, image: productImages[p.name] || null }));

    const result = {
      dateRange: `${startDate} → ${endDate}`,
      totalOrders: total,
      domestic:      { count: usCount,   pct: +((usCount/total)*100).toFixed(1) },
      international: { count: intlCount, pct: +((intlCount/total)*100).toFixed(1) },
      topCountries,
      topStates,
      topProducts: topProductsWithImages,
    };
    shopifyCache[cacheKey] = { data: result, ts: Date.now() };
    res.json(result);
  } catch (err) {
    console.error('Shopify overview error:', err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Shopify Returns / Package Protection ─────────────────────────────────────
app.get('/api/shopify/returns', requireAuth, async (req, res) => {
  try {
    const startDate = req.query.start || monthsAgo(3);
    const endDate   = req.query.end   || new Date().toISOString().split('T')[0];
    const cacheKey  = `returns_${startDate}_${endDate}`;

    if (shopifyCache[cacheKey] && Date.now() - shopifyCache[cacheKey].ts < CACHE_MS) {
      return res.json({ ...shopifyCache[cacheKey].data, cached: true });
    }

    let orders = [], pageInfo = null;
    while (true) {
      let params;
      if (pageInfo) {
        params = { limit: 250, page_info: pageInfo };
      } else {
        params = {
          status: 'any',
          created_at_min: `${startDate}T00:00:00Z`,
          created_at_max: `${endDate}T23:59:59Z`,
          limit: 250,
          fields: 'id,created_at,line_items,refunds,financial_status,shipping_address',
        };
      }
      const resp = await shopify.get('/orders.json', { params });
      const batch = resp.data.orders || [];
      orders = orders.concat(batch);
      const link = resp.headers['link'] || '';
      const next = link.match(/<[^>]+page_info=([^>&"]+)[^>]*>;\s*rel="next"/);
      if (!next || batch.length < 250) break;
      pageInfo = next[1];
      await new Promise(r => setTimeout(r, 50));
    }

    const PP_RE = /package.?protection|extend/i;
    let ppOrders = 0, ppRevenue = 0, usDtcOrders = 0;
    const returnsByProduct = {};
    let totalReturnedUnits = 0;

    for (const order of orders) {
      const isUS = (order.shipping_address?.country_code || '').toUpperCase() === 'US';
      if (isUS) usDtcOrders++;
      const ppItem = (order.line_items || []).find(i => PP_RE.test(i.title || ''));
      if (ppItem) {
        ppOrders++;
        ppRevenue += parseFloat(ppItem.price || 0) * (ppItem.quantity || 1);
      }
      for (const refund of order.refunds || []) {
        for (const ri of refund.refund_line_items || []) {
          const name = ri.line_item?.title || 'Unknown';
          if (PP_RE.test(name)) continue;
          returnsByProduct[name] = (returnsByProduct[name] || 0) + ri.quantity;
          totalReturnedUnits += ri.quantity;
        }
      }
    }

    const topReturns = Object.entries(returnsByProduct)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([name, qty]) => ({
        name, quantity: qty,
        pct: +((qty / Math.max(totalReturnedUnits, 1)) * 100).toFixed(1),
      }));

    const result = {
      dateRange:         `${startDate} → ${endDate}`,
      totalOrders:       orders.length,
      packageProtection: {
        orders:    ppOrders,
        optInRate: +((ppOrders / Math.max(usDtcOrders, 1)) * 100).toFixed(1),
        usDtcOrders,
        revenue:   +ppRevenue.toFixed(2),
      },
      totalReturnedUnits,
      topReturns,
    };
    shopifyCache[cacheKey] = { data: result, ts: Date.now() };
    res.json(result);
  } catch (err) {
    console.error('Returns error:', err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── HyperSKU ─────────────────────────────────────────────────────────────────
let hyperskuToken = null;
let hyperskuTokenExpiry = 0;

async function getHyperskuToken() {
  if (hyperskuToken && Date.now() < hyperskuTokenExpiry) return hyperskuToken;
  const { data } = await axios.post('https://api.hypersku.com/api/auth/admin/token', {
    username: process.env.HYPERSKU_USERNAME,
    password: process.env.HYPERSKU_PASSWORD,
  });
  hyperskuToken = data.token;
  hyperskuTokenExpiry = Date.now() + 60 * 60 * 1000; // cache 1 hour
  return hyperskuToken;
}

app.get('/api/hypersku/orders', requireAuth, async (req, res) => {
  try {
    const token = await getHyperskuToken();
    const { data } = await axios.get('https://api.hypersku.com/api/order/list', {
      headers: { Authorization: `Bearer ${token}` },
      params: {
        pageNo: req.query.page || 1,
        pageSize: req.query.pageSize || 50,
        startTime: req.query.start,
        endTime: req.query.end,
      }
    });
    res.json(data);
  } catch (err) {
    console.error('HyperSKU error:', err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n✅ Server running at http://localhost:${PORT}`);
  console.log(`   Open http://localhost:${PORT} in your browser\n`);
});
