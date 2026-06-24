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
const cache = {};
const CACHE_MS = 30 * 60 * 1000;

// ── Fetch one page with retry on 429 ─────────────────────────────────────────
async function fetchPage(startDate, endDate, page, retries = 0) {
  try {
    const { data } = await ss.get('/shipments', {
      params: { shipDateStart: startDate, shipDateEnd: endDate, pageSize: 500, page }
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

    const result = {
      generatedAt:     new Date().toISOString(),
      dateRange:       `${startDate} → ${endDate}`,
      totalShipments:  total,
      carrierBreakdown,
      productBreakdown
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
const SHOPIFY_SHOP          = process.env.SHOPIFY_SHOP || 'whygolf.myshopify.com';
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
