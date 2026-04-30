const http = require('http');
const https = require('https');

// In-memory state store
const store = {
  contexts: new Map(),
  replies: new Map(),
};

// ─── Anthropic API call ───────────────────────────────────────────────────────
async function callClaude(systemPrompt, userPrompt) {
  const body = JSON.stringify({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1000,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) return reject(new Error(parsed.error.message));
          const text = parsed.content?.map((c) => c.text || '').join('') || '';
          resolve(text);
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── Core compose logic ───────────────────────────────────────────────────────
async function compose(context) {
  const { merchant, category, performance, offers, triggers } = context;

  const systemPrompt = `You are Vera, magicpin's merchant success AI. You craft hyper-personalized, data-driven messages for merchants on the magicpin platform.

Your output MUST be a valid JSON object with EXACTLY these fields:
{
  "message": "<the actual message to send to the merchant — 2-4 sentences max, specific, warm, urgent>",
  "cta": "<a single short action phrase, 3-7 words, e.g. 'Activate offer now' or 'Check your dashboard'>",
  "send_as": "<one of: account_manager | growth_advisor | city_head | support>",
  "suppression_key": "<a stable string key to deduplicate, e.g. 'low_orders_week_2025-04'>",
  "rationale": "<1-2 sentences explaining WHY you picked this trigger and angle>"
}

RULES:
- Use REAL numbers from the data (revenue, order counts, ratings, offer names)
- Match tone to category: restaurants=warm/inviting, pharmacy=clinical/trust, salon=visual/aspirational, grocery=utility/value
- Pick the SINGLE most impactful trigger to address
- The message must create urgency without being pushy
- suppression_key must be deterministic (same inputs → same key) so we don't re-send
- Return ONLY the JSON object, no markdown, no extra text`;

  const userPrompt = `Merchant context:
${JSON.stringify({ merchant, category, performance, offers, triggers }, null, 2)}

Compose the next best message for this merchant.`;

  const raw = await callClaude(systemPrompt, userPrompt);
  // Strip any accidental markdown fences
  const clean = raw.replace(/```json|```/g, '').trim();
  return JSON.parse(clean);
}

// ─── HTTP request handler ─────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(json),
    'Access-Control-Allow-Origin': '*',
  });
  res.end(json);
}

async function router(req, res) {
  const { method, url } = req;

  // Health check
  if (method === 'GET' && url === '/v1/healthz') {
    return send(res, 200, { status: 'ok', version: '1.0.0' });
  }

  // Metadata
  if (method === 'GET' && url === '/v1/metadata') {
    return send(res, 200, {
      team: 'Claude Vera Agent',
      model: 'claude-sonnet-4-20250514',
      version: '1.0.0',
      description: 'AI-powered merchant messaging agent using Claude Sonnet',
      endpoints: ['/v1/healthz', '/v1/metadata', '/v1/context', '/v1/tick', '/v1/reply'],
    });
  }

  // Push merchant context
  if (method === 'POST' && url === '/v1/context') {
    const body = await readBody(req);
    const id = body?.merchant?.id || body?.merchant_id || `merchant_${Date.now()}`;
    store.contexts.set(id, { ...body, received_at: Date.now() });
    return send(res, 200, { status: 'accepted', merchant_id: id });
  }

  // Tick — generate the next message
  if (method === 'POST' && url === '/v1/tick') {
    const body = await readBody(req);
    const id = body?.merchant_id || body?.merchant?.id;

    if (!id) return send(res, 400, { error: 'merchant_id required' });

    const context = store.contexts.get(id);
    if (!context) return send(res, 404, { error: 'No context found for merchant. Call /v1/context first.' });

    // Merge any tick-level overrides
    const merged = { ...context, ...body };

    try {
      const result = await compose(merged);
      return send(res, 200, result);
    } catch (err) {
      console.error('compose error:', err.message);
      return send(res, 500, { error: 'compose failed', detail: err.message });
    }
  }

  // Reply handler
  if (method === 'POST' && url === '/v1/reply') {
    const body = await readBody(req);
    const id = body?.merchant_id;
    if (id) {
      const history = store.replies.get(id) || [];
      history.push({ ...body, ts: Date.now() });
      store.replies.set(id, history);

      // Update context with reply signal so next tick is aware
      const ctx = store.contexts.get(id) || {};
      ctx.last_reply = body;
      store.contexts.set(id, ctx);
    }
    return send(res, 200, { status: 'recorded' });
  }

  // OPTIONS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
    return res.end();
  }

  return send(res, 404, { error: 'Not found' });
}

// ─── Start server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
  router(req, res).catch((err) => {
    console.error('Unhandled error:', err);
    send(res, 500, { error: 'Internal server error' });
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Vera Agent listening on port ${PORT}`);
});
