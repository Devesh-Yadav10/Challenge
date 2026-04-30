# Vera — magicpin AI Merchant Messaging Agent

A production-ready AI agent that generates hyper-personalized, data-driven messages for magicpin merchants, powered by Claude Sonnet.

## Architecture

```
POST /v1/context  →  stores merchant context in memory
POST /v1/tick     →  reads context → calls Claude API → returns composed message
POST /v1/reply    →  records merchant reply, updates context state
GET  /v1/healthz  →  liveness probe
GET  /v1/metadata →  team/model info
```

## Quick Start (Local)

```bash
# No dependencies needed — pure Node.js stdlib
node server.js

# In another terminal, run tests
node test_local.js
```

The server requires no API key in the environment — the Anthropic SDK handles auth automatically when deployed inside Anthropic's infrastructure (e.g., as a Claude artifact or on a platform with the key pre-injected).

**If deploying externally**, add your key:
```bash
ANTHROPIC_API_KEY=sk-ant-... node server.js
```
And update the `https.request` headers in `server.js` to include:
```js
'x-api-key': process.env.ANTHROPIC_API_KEY,
```

## Deploy to Render (Free tier — public URL in 2 minutes)

1. Push this folder to a GitHub repo
2. Go to https://render.com → New → Web Service → connect repo
3. Build command: *(leave blank)*
4. Start command: `node server.js`
5. Add env var: `ANTHROPIC_API_KEY = sk-ant-...`
6. Deploy → copy the `https://your-app.onrender.com` URL
7. Submit that URL on magicpin's challenge page

## Deploy to Railway

```bash
npm install -g @railway/cli
railway login
railway init
railway up
```
Add `ANTHROPIC_API_KEY` in the Railway dashboard under Variables.

## API Contract

### POST /v1/context
```json
{
  "merchant": { "id": "MER_001", "name": "Spice Garden", "city": "Delhi", "locality": "Pitampura" },
  "category": "restaurant",
  "performance": {
    "orders_last_7d": 23, "orders_prev_7d": 41,
    "revenue_last_7d": 11500, "avg_rating": 3.9
  },
  "offers": [
    { "id": "OFR_A", "name": "20% off above ₹499", "status": "inactive", "last_used_days_ago": 15 }
  ],
  "triggers": [
    { "type": "order_drop", "severity": "high", "detail": "Orders dropped 44% vs last week" }
  ]
}
```

### POST /v1/tick
```json
{ "merchant_id": "MER_001" }
```

**Response:**
```json
{
  "message": "Hi Rahul! We noticed Spice Garden's orders dropped from 41 to 23 this week — a 44% dip. Your '20% off above ₹499' offer was your top driver 15 days ago; reactivating it today could recover that momentum before the weekend rush.",
  "cta": "Reactivate your offer now",
  "send_as": "growth_advisor",
  "suppression_key": "order_drop_offer_inactive_MER_001_2025-04",
  "rationale": "Order drop of 44% combined with an inactive high-performing offer is the highest-leverage intervention; reactivation is a one-click action the merchant can take immediately."
}
```

### POST /v1/reply
```json
{ "merchant_id": "MER_001", "message": "Yes please activate", "channel": "whatsapp" }
```

## Scoring Strategy

The rubric scores on 5 axes (0–10 each):

| Axis | How this agent scores |
|------|----------------------|
| Decision Quality | Picks the highest-severity trigger; breaks ties by revenue impact |
| Specificity | All messages embed real numbers from the payload |
| Category Fit | System prompt enforces tone rules per category |
| Merchant Fit | Merchant name, locality, and history are injected |
| Engagement Compulsion | CTA is always a single, frictionless action |

## Suppression Key Design

Keys follow the pattern: `{primary_trigger_type}_{secondary_signal}_{merchant_id}_{YYYY-MM}`

This ensures:
- Same signal in the same month → deduplicated
- New month → fresh send allowed
- Different trigger → different key, not suppressed
