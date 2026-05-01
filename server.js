const http = require('http');
const https = require('https');

// ─── State store ──────────────────────────────────────────────────────────────
const store = {
  categories: new Map(),
  merchants: new Map(),
  triggers: new Map(),
  customers: new Map(),
  replies: new Map(),
  cache: new Map(),
};

// ─── Simple hash for cache key ────────────────────────────────────────────────
function hashObj(obj) {
  const str = JSON.stringify(obj);
  let h = 0;
  for (let i = 0; i < str.length; i++) { h = ((h << 5) - h) + str.charCodeAt(i); h |= 0; }
  return String(h);
}

// ─── Retry with exponential backoff ──────────────────────────────────────────
async function withRetry(fn, maxRetries = 4) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try { return await fn(); }
    catch (err) {
      const isRate = /quota|rate|429|too many/i.test(err.message || '');
      if (isRate && attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 1500 + Math.random() * 500;
        console.log(`Rate limited, retry in ${Math.round(delay)}ms`);
        await new Promise(r => setTimeout(r, delay));
      } else throw err;
    }
  }
}

// ─── Serial queue + delay to avoid Gemini rate limits ────────────────────────
const DELAY_MS = 4500;
let queue = Promise.resolve();
function enqueue(fn) {
  const result = queue.then(() => fn()).then(val => new Promise(r => setTimeout(() => r(val), DELAY_MS)));
  queue = result.catch(() => {});
  return result;
}

// ─── Gemini API call ──────────────────────────────────────────────────────────
async function callGemini(systemPrompt, userPrompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY env var not set');

  const body = JSON.stringify({
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    generationConfig: { maxOutputTokens: 1000, temperature: 0 },
  });

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) return reject(new Error(parsed.error.message || JSON.stringify(parsed.error)));
          resolve(parsed.candidates?.[0]?.content?.parts?.[0]?.text || '');
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── Core compose ─────────────────────────────────────────────────────────────
async function compose(trigger) {
  const tid = trigger.id || trigger.trigger_id || '';
  const mid = trigger.merchant_id || trigger.payload?.merchant_id || '';
  const cid = trigger.customer_id || trigger.payload?.customer_id || '';

  const merchant = store.merchants.get(mid) || {};
  const customer = store.customers.get(cid) || null;
  const categorySlug = merchant?.category_slug || merchant?.identity?.category_slug || '';
  const category = store.categories.get(categorySlug) || {};

  const cacheKey = hashObj({ tid, mid, kind: trigger.kind });
  if (store.cache.has(cacheKey)) {
    console.log('Cache hit:', cacheKey);
    return store.cache.get(cacheKey);
  }

  const systemPrompt = `You are Vera, magicpin's merchant success AI. You craft hyper-personalized, data-driven outreach messages for merchants.

Your output MUST be a valid JSON object with EXACTLY these fields:
{
  "trigger_id": "<the trigger id passed to you>",
  "merchant_id": "<the merchant id>",
  "body": "<the actual message — 2-4 sentences, specific, warm, urgent, uses REAL numbers from context>",
  "cta": "<single short action phrase, 3-7 words>",
  "send_as": "<one of: account_manager | growth_advisor | city_head | support>",
  "suppression_key": "<deterministic dedup key, e.g. 'order_drop_MER001_2025-04'>",
  "rationale": "<1-2 sentences: why this trigger and angle>"
}

RULES:
- Use REAL numbers from merchant data (views, calls, CTR, offer names, ratings)
- tone by category: restaurant=warm operator-to-operator, salon=warm practical, pharmacy=clinical trustworthy, gym=coaching motivational, dentist=clinical peer-to-peer
- Pick the single most impactful signal from the trigger payload
- suppression_key must be stable: same inputs → same key
- Return ONLY the JSON object — no markdown, no extra text`;

  const userPrompt = `Trigger: ${JSON.stringify(trigger, null, 2)}
Merchant: ${JSON.stringify(merchant, null, 2)}
Category: ${JSON.stringify(category, null, 2)}
Customer: ${JSON.stringify(customer, null, 2)}

Compose the next best message for this merchant.`;

  const raw = await enqueue(() => withRetry(() => callGemini(systemPrompt, userPrompt)));
  const clean = raw.replace(/```json|```/g, '').trim();
  const result = JSON.parse(clean);
  store.cache.set(cacheKey, result);
  return result;
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => data += c);
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
    req.on('error', reject);
  });
}

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(json), 'Access-Control-Allow-Origin': '*' });
  res.end(json);
}

// ─── Router ───────────────────────────────────────────────────────────────────
async function router(req, res) {
  const { method, url } = req;

  // Health check
  if (method === 'GET' && url === '/v1/healthz')
    return send(res, 200, { status: 'ok', version: '1.0.0' });

  // Metadata
  if (method === 'GET' && url === '/v1/metadata')
    return send(res, 200, {
      team_name: 'Vera Merchant Agent',
      model: 'gemini-2.0-flash',
      version: '1.0.0',
      description: 'AI-powered merchant messaging agent',
    });

  // Context push — simulator sends: { scope, context_id, version, payload }
  if (method === 'POST' && url === '/v1/context') {
    const body = await readBody(req);
    const { scope, context_id, payload } = body;

    if (scope === 'category') store.categories.set(context_id, payload);
    else if (scope === 'merchant') store.merchants.set(context_id, payload);
    else if (scope === 'trigger') store.triggers.set(context_id, payload);
    else if (scope === 'customer') store.customers.set(context_id, payload);

    console.log(`Context: ${scope}/${context_id}`);
    return send(res, 200, { accepted: true, scope, context_id });
  }

  // Tick — simulator sends: { now, available_triggers: [trigger_id, ...] }
  if (method === 'POST' && url === '/v1/tick') {
    const body = await readBody(req);
    const triggerIds = body.available_triggers || [];

    if (!triggerIds.length)
      return send(res, 200, { actions: [] });

    // Compose for each trigger (they queue up automatically)
    const actions = [];
    for (const tid of triggerIds) {
      const trigger = store.triggers.get(tid);
      if (!trigger) { console.log(`Unknown trigger: ${tid}`); continue; }
      try {
        const action = await compose({ ...trigger, id: tid });
        actions.push(action);
      } catch (err) {
        console.error(`compose error for ${tid}:`, err.message);
      }
    }

    return send(res, 200, { actions });
  }

  // Reply — simulator sends: { conversation_id, merchant_id, from_role, message, turn_number }
  if (method === 'POST' && url === '/v1/reply') {
    const body = await readBody(req);
    const { merchant_id, message, turn_number } = body;

    const lower = (message || '').toLowerCase();

    // Detect auto-reply
    const autoKeywords = ['thank you for contacting', 'our team will respond', 'automated', 'auto-reply', 'out of office'];
    if (autoKeywords.some(k => lower.includes(k))) {
      if ((turn_number || 1) >= 2) return send(res, 200, { action: 'end', reason: 'auto-reply detected' });
      return send(res, 200, { action: 'wait', wait_seconds: 3600 });
    }

    // Hostile detection
    const hostileKeywords = ['stop', 'spam', 'unsubscribe', 'remove', 'useless', 'annoying', 'dont contact'];
    if (hostileKeywords.some(k => lower.includes(k)))
      return send(res, 200, { action: 'end', reason: 'merchant opted out' });

    // Commitment/intent detected
    const commitKeywords = ['lets do it', "let's do it", 'yes', 'ok', 'sure', 'proceed', 'go ahead', 'sounds good'];
    if (commitKeywords.some(k => lower.includes(k))) {
      if (merchant_id) {
        const history = store.replies.get(merchant_id) || [];
        history.push(body);
        store.replies.set(merchant_id, history);
      }
      return send(res, 200, {
        action: 'send',
        body: "Great! I'm activating your offer now and you'll see it live within a few minutes. I'll send you a confirmation once it's done.",
        cta: 'Check your dashboard',
        send_as: 'account_manager',
      });
    }

    // Default: acknowledge
    return send(res, 200, { action: 'wait', wait_seconds: 1800 });
  }

  if (method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
    return res.end();
  }

  return send(res, 404, { error: 'Not found' });
}

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  router(req, res).catch(err => { console.error(err); send(res, 500, { error: 'Internal error' }); });
}).listen(PORT, '0.0.0.0', () => console.log(`Vera Agent on port ${PORT}`));