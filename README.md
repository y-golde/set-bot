# Set 🐕

> A monday.com bot that triages tickets and dispatches [Cursor background agents](https://docs.cursor.com/background-agent) to investigate or implement them.

Set is named after [my dog](https://github.com/y-golde). When a new item is created on a monday board, Set drops in a triage comment. Reply with `!set research` or `!set implement` and Set spins up a Cursor agent against the repo named on the ticket, then posts the result (and a PR link, when relevant) back as a comment — and DMs the requester on Slack if their email matches a Slack user.

---

## What it does

```
monday.com board
  ├─ item created       ──► Set posts: "Hi! Reply !set research or !set implement"
  └─ reply "!set …"     ──► Set launches a Cursor agent against the repo in the
                              "Repositories" column, posts the agent URL, and
                              (when the agent finishes) posts the result + PR link.
```

Supported commands (anyone on the board can use them):

| Command | What it does |
|---|---|
| `!set research` | Spins up a Cursor agent that investigates and posts a brief. No code changes. |
| `!set implement` | Spins up a Cursor agent that writes code and opens a PR. |
| `!set status` | Re-posts the latest agent's status / result on the ticket. |
| `!set help` | Lists commands. |

## Architecture

- **Runtime:** Node 20, ESM, one runtime dependency (`@vercel/functions`).
- **Deploy:** two Vercel serverless functions in [`api/`](api/) — one webhook for monday events, one callback for Cursor.
- **Storage:** none. State lives on the monday ticket itself (comment history is the audit log).
- **Auth:** raw monday API token; optional `?secret=` query-param guard on the webhook.

See [AGENTS.md](AGENTS.md) for a tour of the code layout.

---

## Setup

### 1. Clone & configure

```bash
git clone https://github.com/y-golde/set-bot.git
cd set-bot
cp .env.example .env
# fill in MONDAY_API_TOKEN (and optionally the others)
```

### 2. Deploy to Vercel

```bash
npm i -g vercel        # one-time
vercel                 # follow prompts, link/create project
vercel --prod          # promote to production
```

### 3. Add env vars in Vercel

```bash
vercel env add MONDAY_API_TOKEN production
vercel env add CURSOR_API_KEY production
vercel env add WEBHOOK_SHARED_SECRET production   # optional but recommended
vercel env add SLACK_BOT_TOKEN production         # optional, enables DMs
vercel env add DEFAULT_REPO_OWNER production      # optional
```

Or set them in the dashboard: **Project → Settings → Environment Variables**.

### 4. Configure the webhook in monday.com

On the board:

1. Go to **Integrations** (puzzle icon) → **Webhooks**
2. **Add Webhook**, then add three subscriptions pointing at the same URL:
   - `When an item is created`
   - `When an update is created`
   - `When someone replies to an update`
3. URL:
   - Without secret: `https://<your-vercel-domain>/api/webhook`
   - With secret:    `https://<your-vercel-domain>/api/webhook?secret=<WEBHOOK_SHARED_SECRET>`

monday sends a challenge GET/POST on subscribe; the handler echoes it back automatically.

Add a **Repositories** column to the board (link, text, or formula — anything whose `text` resolves to a GitHub repo URL, `owner/repo` slug, or bare repo name when `DEFAULT_REPO_OWNER` is set).

### 5. Local development

```bash
cp .env.example .env   # fill in your tokens
npx vercel dev         # runs on http://localhost:3000
# then expose /api/webhook publicly (e.g. via ngrok) so monday can reach it
```

---

## Environment variables

| Variable | Required | Description |
|---|:---:|---|
| `MONDAY_API_TOKEN` | ✅ | Personal API token from monday.com developer settings. |
| `CURSOR_API_KEY` | ✅ | Cursor Background Agents API key ([cursor.com/settings → API Keys](https://cursor.com/settings)). |
| `WEBHOOK_SHARED_SECRET` |  | If set, requests must include `?secret=<value>`. |
| `CURSOR_MODEL` |  | Cursor agent model. Defaults to `composer-2.5-fast`. |
| `DEFAULT_REPO_OWNER` |  | GitHub org/user prefix used when the Repositories column contains a bare repo name. |
| `SLACK_BOT_TOKEN` |  | Slack bot token (`xoxb-…`). Enables DMs to the user who triggered the command. Needs `users:read.email` and `chat:write` scopes. |
| `AUTHORIZED_USER_IDS` |  | Comma-separated monday user IDs allowed to issue `!set` commands. Currently unused — commands are open to everyone on the board. Kept for future tightening. |

---

## Endpoints

| Method | Path | Behaviour |
|---|---|---|
| `GET` | `/api/webhook` | Health check — returns `{"ok":true,"service":"set-bot"}`. |
| `POST` | `/api/webhook` | Handles monday events (challenge handshake, `create_pulse`, `create_update`, `create_reply`). |
| `GET` | `/api/cursor-webhook` | Health check. |
| `POST` | `/api/cursor-webhook` | Cursor calls this when an agent makes progress or finishes; Set posts the result on the originating monday ticket. |

The handler always returns 200 so monday doesn't retry-storm on transient failures — actual work happens in `waitUntil`.

---

## Contributing

PRs and issues welcome. The project is small enough to read top to bottom in one sitting — [`AGENTS.md`](AGENTS.md) has a quick tour.

If you're using Set internally and adapting it (different ticket tracker, different agent platform, extra commands), feel free to fork — there's no clever framework here, just a webhook handler and two API clients.

## License

[MIT](LICENSE) © Yonatan Golde
