# monday-bot-vercel

A monday.com webhook bot deployed as a Vercel serverless function.

**Step 1 (this repo):** Listens for `create_pulse` events and posts a triage comment asking _research or implement?_

**Step 2 (upcoming):** Parses replies to trigger Cursor background agents.

---

## Architecture

```
monday.com board
  └─ webhook (create_pulse) ──► POST /api/webhook
                                    └─ lib/monday.js (GraphQL)
                                         └─ create_update mutation
```

- **Runtime:** Node 20, ESM, no dependencies
- **Deploy:** Vercel serverless (`api/webhook.js` → `/api/webhook`)
- **Auth:** Raw monday API token; optional `?secret=` query-param guard

---

## Setup

### 1. Clone & configure

```bash
git clone https://github.com/YOUR_USERNAME/monday-bot-vercel.git
cd monday-bot-vercel
cp .env.example .env
# fill in MONDAY_API_TOKEN (and optionally WEBHOOK_SHARED_SECRET)
```

### 2. Deploy to Vercel

```bash
npm i -g vercel        # one-time
vercel                  # follow prompts, link/create project
vercel --prod           # promote to production
```

### 3. Add env vars in Vercel

```bash
vercel env add MONDAY_API_TOKEN production
vercel env add WEBHOOK_SHARED_SECRET production   # optional
```

Or set them in the Vercel dashboard under **Project → Settings → Environment Variables**.

### 4. Configure the webhook in monday.com

1. Go to your board → **Integrations** (puzzle icon) → **Webhooks**
2. Click **Add Webhook**
3. Event: `When an item is created`
4. URL:
   - Without secret: `https://<your-vercel-domain>/api/webhook`
   - With secret:    `https://<your-vercel-domain>/api/webhook?secret=<WEBHOOK_SHARED_SECRET>`
5. Click **Subscribe** — monday sends a challenge GET/POST; the handler echoes it automatically.

### 5. Local development

```bash
cp .env.example .env   # fill in your token
npx vercel dev         # runs on http://localhost:3000
# then use ngrok or similar to expose /api/webhook for monday testing
```

---

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `MONDAY_API_TOKEN` | Yes | Personal API token from monday.com developer settings |
| `WEBHOOK_SHARED_SECRET` | No | If set, requests must include `?secret=<value>` |

---

## Endpoints

| Method | Path | Behaviour |
|---|---|---|
| `GET` | `/api/webhook` | Returns `{"ok":true,"service":"monday-bot"}` |
| `POST` | `/api/webhook` | Handles monday events (see below) |

### POST behaviour

| Body | Response |
|---|---|
| `{ challenge: "..." }` | `{ challenge: "..." }` — verification handshake |
| `event.type === "create_pulse"` | Posts triage comment; returns `{ ok: true }` |
| Any other event type | Logs and returns `{ ok: true }` |
| Errors | Logs and returns `{ ok: true, warning: "internal error logged" }` |

> monday retries on non-200 responses every minute for 30 minutes. The handler always returns 200 to prevent retry storms.
