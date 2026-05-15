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
    ups_walleted: 'UPS (WhyGolf)',
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

    const carriers   = {};   // { code: { count, totalCost, services: { code: count } } }
    const products   = {};   // { name: { totalCost, count } }

    for (const s of shipments) {
      const c    = s.carrierCode  || 'unknown';
      const svc  = s.serviceCode  || 'unknown';
      const cost = s.shipmentCost || 0;

      // ── carrier / service rollup ──
      if (!carriers[c]) carriers[c] = { count: 0, totalCost: 0, services: {} };
      carriers[c].count++;
      carriers[c].totalCost += cost;
      carriers[c].services[svc] = (carriers[c].services[svc] || 0) + 1;

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
      .map(([code, d]) => ({
        code,
        label:      carrierLabel(code),
        count:      d.count,
        pct:        +((d.count / total) * 100).toFixed(1),
        avgCost:    +(d.totalCost / d.count).toFixed(2),
        totalCost:  +d.totalCost.toFixed(2),
        services:   Object.entries(d.services)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([svc, cnt]) => ({
            service: svc,
            count:   cnt,
            pct:     +((cnt / d.count) * 100).toFixed(1)
          }))
      }));

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

// Temporary: list all carriers from ShipStation
app.get('/api/carriers', requireAuth, async (req, res) => {
  try {
    const { data } = await ss.get('/carriers');
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n✅ Server running at http://localhost:${PORT}`);
  console.log(`   Open http://localhost:${PORT} in your browser\n`);
});
