import 'dotenv/config';
import express from 'express';
import axios   from 'axios';
import cors    from 'cors';
import path    from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname)));   // serves index.html

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
    fedex:       'FedEx',
    stamps_com:  'USPS (Stamps)',
    usps:        'USPS',
    ups:         'UPS',
    ups_walleted:'UPS (Account 2)',
    ups_wn:      'UPS (Account 3)',
  };
  return map[code] || code;
}

// ── Fetch all shipments (last 3 months, all pages) ────────────────────────────
async function fetchShipments() {
  const startDate = monthsAgo(3);
  let page = 1, all = [];

  while (true) {
    const { data } = await ss.get('/shipments', {
      params: { shipDateStart: startDate, pageSize: 500, page }
    });

    const valid = (data.shipments || []).filter(s => !s.voided && s.shipmentCost > 0);
    all = all.concat(valid);

    if (page >= data.pages) break;
    page++;

    // Respect ShipStation rate limit (40 req/min)
    await new Promise(r => setTimeout(r, 200));
  }

  return all;
}

// ── Analytics endpoint ────────────────────────────────────────────────────────
app.get('/api/analytics', async (req, res) => {
  try {
    const shipments = await fetchShipments();

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

    res.json({
      generatedAt:     new Date().toISOString(),
      dateRange:       `${monthsAgo(3)} → today`,
      totalShipments:  total,
      carrierBreakdown,
      productBreakdown
    });

  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = 3001;
app.listen(PORT, () => {
  console.log(`\n✅ Server running at http://localhost:${PORT}`);
  console.log(`   Open http://localhost:${PORT} in your browser\n`);
});
