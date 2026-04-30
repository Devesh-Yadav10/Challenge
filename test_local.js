// test_local.js — run with: node test_local.js
const http = require('http');

const BASE = 'http://localhost:3000';

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const json = body ? JSON.stringify(body) : undefined;
    const options = {
      hostname: 'localhost',
      port: 3000,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(json ? { 'Content-Length': Buffer.byteLength(json) } : {}),
      },
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (json) req.write(json);
    req.end();
  });
}

async function run() {
  console.log('\n=== Vera Agent Local Tests ===\n');

  // 1. Health check
  let r = await request('GET', '/v1/healthz');
  console.log('GET /v1/healthz →', r.status, r.body.status);

  // 2. Metadata
  r = await request('GET', '/v1/metadata');
  console.log('GET /v1/metadata →', r.status, r.body.team);

  // 3. Push context
  const merchant = {
    merchant: {
      id: 'MER_001',
      name: 'Spice Garden Restaurant',
      city: 'Delhi',
      locality: 'Pitampura',
      phone: '+91-9876543210',
      joined_days_ago: 120,
    },
    category: 'restaurant',
    performance: {
      orders_last_7d: 23,
      orders_prev_7d: 41,
      revenue_last_7d: 11500,
      revenue_prev_7d: 20300,
      avg_rating: 3.9,
      reviews_count: 87,
      repeat_customer_pct: 38,
    },
    offers: [
      { id: 'OFR_A', name: '20% off on orders above ₹499', status: 'inactive', last_used_days_ago: 15 },
      { id: 'OFR_B', name: 'Buy 1 Get 1 on Thali', status: 'active' },
    ],
    triggers: [
      { type: 'order_drop', severity: 'high', detail: 'Orders dropped 44% vs last week' },
      { type: 'offer_inactive', severity: 'medium', detail: 'Best performing offer OFR_A has been inactive for 15 days' },
      { type: 'rating_risk', severity: 'medium', detail: 'Rating 3.9 — below 4.0 threshold for featured listing' },
    ],
  };

  r = await request('POST', '/v1/context', merchant);
  console.log('POST /v1/context →', r.status, r.body);

  // 4. Tick
  console.log('\nGenerating message (this calls Claude API)...');
  r = await request('POST', '/v1/tick', { merchant_id: 'MER_001' });
  console.log('POST /v1/tick →', r.status);
  if (r.body.message) {
    console.log('\n--- RESULT ---');
    console.log('Message   :', r.body.message);
    console.log('CTA       :', r.body.cta);
    console.log('Send-as   :', r.body.send_as);
    console.log('Suppress  :', r.body.suppression_key);
    console.log('Rationale :', r.body.rationale);
    console.log('--------------\n');
  } else {
    console.log('Response:', r.body);
  }

  // 5. Reply
  r = await request('POST', '/v1/reply', {
    merchant_id: 'MER_001',
    message: 'Yes please activate the offer',
    channel: 'whatsapp',
  });
  console.log('POST /v1/reply →', r.status, r.body);

  console.log('\n=== All tests passed ===\n');
}

run().catch(console.error);
