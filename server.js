const http = require('http');
const https = require('https');

const store = {
  contexts: new Map(),
  replies: new Map(),
  cache: new Map(),
};

function hashContext(context) {
  const str = JSON.stringify({
    merchant: context.merchant?.id,
    category: context.category,
    triggers: context.triggers,
    performance: context.performance,
    offers: context.offers?.map(o => o.id + o.status),
  });
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return String(hash);
}

async function withRetry(fn, maxRetries = 4) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isRateLimit = err.message?.toLowerCase().includes('quota') ||
                          err.message?.toLowerCase().includes('rate') ||
                          err.message?.toLowerCase().includes('429') ||
                          err.message?.toLowerCase().includes('too many');
      if (isRateLimit && attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 1000 + Math.random() * 500;
        console.log(`Rate limited, retrying in ${Math.round(delay)}ms (attempt ${attempt + 1})`);
        await new Promise(r => setTimeout(r, delay));
      } else {
        throw err;
      }
    }
  }
}

let queue = Promise.resolve();
function enqueue(fn) {
  const result = queue.then(() => fn());
  queue = result.catch(() => {});
  return result;
}

async function callGemini(systemPrompt, userPrompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY env var not set');

  const body = JSON.stringify({
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    generationConfig: { maxOutputTokens: 1000, temperature: 0 },
  });

  return new Promise((resolve, reject) => {
    const path = `/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
    const options = {
      hostname: 'generativelanguage.googleapis.com',
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) return reject(new Error(parsed.error.message || JSON.stringify(parsed.error)));
          const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text || '';
          resolve(text);
        } catch (e) { reject(e); }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function compose(context) {
  const cacheKey = hashContext(context);
  if (store.cache.has(cacheKey)) {
    console.log('Cache hit:', cacheKey);
    return store.cache.get(cacheKey);
  }

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
- suppression_key must be deterministic (same inputs = same key) so we do not re-send
- Return ONLY the JSON object, no markdown fences, no extra text`;

  const userPrompt = `Merchant context:
${JSON.stringify({ merchant, category, performance, offers, triggers }, null, 2)}

Compose the next best message for this merchant.`;

  const raw = await enqueue(() => withRetry(() => callGemini(systemPrompt, userPrompt)));
  const clean = raw.replace(/```json|```/g, '').trim();
  const result = JSON.parse(clean);

  store.cache.set(cacheKey, result);
  return result;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch { resolve({}); }
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

  if (method === 'GET' && url === '/v1/healthz')
    return send(res, 200, { status: 'ok', version: '1.0.0' });

  if (method === 'GET' && url === '/v1/metadata')
    return send(res, 200, {
      team: 'Vera Merchant Agent',
      model: 'gemini-2.0-flash',
      version: '1.0.0',
      description: 'AI-powered merchant messaging agent using Gemini 2.0 Flash',
      endpoints: ['/v1/healthz', '/v1/metadata', '/v1/context', '/v1/tick', '/v1/reply'],
    });

  if (method === 'POST' && url === '/v1/context') {
    const body = await readBody(req);
    const id = body?.merchant?.id || body?.merchant_id || `merchant_${Date.now()}`;
    store.contexts.set(id, { ...body, received_at: Date.now() });
    return send(res, 200, { status: 'accepted', merchant_id: id });
  }

  if (method === 'POST' && url === '/v1/tick') {
    const body = await readBody(req);
    const id = body?.merchant_id || body?.merchant?.id;
    if (!id) return send(res, 400, { error: 'merchant_id required' });
    const context = store.contexts.get(id);
    if (!context) return send(res, 404, { error: 'No context found. Call /v1/context first.' });
    const merged = { ...context, ...body };
    try {
      const result = await compose(merged);
      return send(res, 200, result);
    } catch (err) {
      console.error('compose error:', err.message);
      return send(res, 500, { error: 'compose failed', detail: err.message });
    }
  }

  if (method === 'POST' && url === '/v1/reply') {
    const body = await readBody(req);
    const id = body?.merchant_id;
    if (id) {
      const history = store.replies.get(id) || [];
      history.push({ ...body, ts: Date.now() });
      store.replies.set(id, history);
      const ctx = store.contexts.get(id) || {};
      ctx.last_reply = body;
      store.contexts.set(id, ctx);
    }
    return send(res, 200, { status: 'recorded' });
  }

  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  return send(res, 404, { error: 'Not found' });
}

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