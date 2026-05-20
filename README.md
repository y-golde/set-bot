# Set 🐕

> A pluggable ticket-bot that dispatches coding agents. Plug in any tracker (Monday, Jira) and any agent platform (Cursor, Anthropic) — they talk through a small provider interface.

Set is named after [my dog](https://github.com/y-golde). When a new ticket is created, Set drops in a triage comment. Reply with `!set research` or `!set implement` and Set spins up an agent against the repo named on the ticket, then posts the result (and a PR link, when relevant) back as a comment — and DMs the requester on Slack if their email matches a Slack user.

---

## What it does

```
ticket tracker (Monday / Jira)
  ├─ ticket created     ──► Set posts: "Hi! Reply !set research or !set implement"
  └─ reply "!set …"     ──► Set launches an agent (Cursor / Anthropic) against
                              the repo on the ticket, posts the agent URL, and
                              (when the agent finishes) posts the result + PR link.
```

Supported commands (anyone on the board / project can use them):

| Command | What it does |
|---|---|
| `!set research` | Spins up an agent that investigates and posts a brief. No code changes. |
| `!set implement` | Spins up an agent that writes code and opens a PR. |
| `!set status` | Re-posts the latest agent's status / result on the ticket. |
| `!set help` | Lists commands. |

Add `--agent=<id>` to any command to override the default agent provider for that run, e.g. `!set research --agent=anthropic`.

## Architecture

- **Runtime:** Node 20, ESM, one runtime dependency (`@vercel/functions`).
- **Deploy:** Vercel serverless functions, one route per provider.
- **Storage:** none. State lives on the ticket itself (comment history is the audit log).
- **Providers:** ticket trackers and agent platforms are pluggable behind small interfaces in [`lib/providers/`](lib/providers/). Today: Monday + Jira for tickets, Cursor + Anthropic for agents.

See [AGENTS.md](AGENTS.md) for a tour of the code layout and the provider contracts.

### Endpoints

| Method | Path | Behaviour |
|---|---|---|
| `POST` | `/api/tickets/monday/webhook` | Monday events |
| `POST` | `/api/tickets/jira/webhook` | Jira webhooks |
| `POST` | `/api/agents/cursor/callback` | Cursor agent status callbacks |
| `POST` | `/api/agents/anthropic/callback` | Symmetry only — Anthropic is synchronous |
| `GET` | any of the above | Health check |

The handler always returns 200 so the tracker doesn't retry-storm on transient failures — actual work happens in `waitUntil`.

---

## Setup

### 1. Clone & configure

```bash
git clone https://github.com/y-golde/set-bot.git
cd set-bot
cp .env.example .env
# fill in the env vars for the providers you want
```

### 2. Deploy to Vercel

```bash
npm i -g vercel
vercel
vercel --prod
```

### 3. Add env vars in Vercel

At minimum:
- `AGENT_PROVIDER` (`cursor` or `anthropic`)
- The credentials for the chosen agent provider (`CURSOR_API_KEY` or `ANTHROPIC_API_KEY`)
- The credentials for each ticket tracker you'll wire up (`MONDAY_API_TOKEN` and/or `JIRA_BASE_URL` + `JIRA_EMAIL` + `JIRA_API_TOKEN`)

See [`.env.example`](.env.example) for the full list with comments.

### 4. Configure the webhook in your tracker

**Monday.com.** Board → **Integrations** (puzzle icon) → **Webhooks** → **Add Webhook**, then add three subscriptions pointing at the same URL:
- `When an item is created`
- `When an update is created`
- `When someone replies to an update`

URL: `https://<your-vercel-domain>/api/tickets/monday/webhook` (or `?secret=<WEBHOOK_SHARED_SECRET>`).

Add a **Repositories** column to the board (link, text, or formula — anything whose `text` resolves to a GitHub repo URL, `owner/repo` slug, or bare repo name when `DEFAULT_REPO_OWNER` is set).

**Jira Cloud.** Project settings → **System WebHooks** (or use an Automation rule) and subscribe to:
- `Issue created`
- `Comment created`

URL: `https://<your-vercel-domain>/api/tickets/jira/webhook`.

To store the repo URL on each issue, either:
- Add a custom field (e.g. "Repository") and set `JIRA_REPO_FIELD=customfield_XXXXX`, or
- Mention the GitHub URL anywhere in the issue description — Set will pick it up.

### 5. Local development

```bash
cp .env.example .env
npx vercel dev         # http://localhost:3000
# then expose /api publicly (e.g. via ngrok) so the tracker can reach it
```

---

## Environment variables

| Variable | Required for | Description |
|---|---|---|
| `AGENT_PROVIDER` | all | Default agent provider — `cursor` or `anthropic`. |
| `WEBHOOK_SHARED_SECRET` |  | If set, ticket webhook requests must include `?secret=<value>`. |
| `MONDAY_API_TOKEN` | Monday | Personal API token from monday.com developer settings. |
| `JIRA_BASE_URL` | Jira | `https://<your-org>.atlassian.net` |
| `JIRA_EMAIL` | Jira | Email used for Basic auth. |
| `JIRA_API_TOKEN` | Jira | Token from id.atlassian.com → API tokens. |
| `JIRA_REPO_FIELD` |  | Custom-field id holding the repo URL (e.g. `customfield_10042`). Optional. |
| `CURSOR_API_KEY` | Cursor | Cursor Background Agents API key. |
| `CURSOR_MODEL` |  | Cursor agent model. Defaults to `composer-2.5-fast`. |
| `ANTHROPIC_API_KEY` | Anthropic | Anthropic API key. |
| `ANTHROPIC_MODEL` |  | Anthropic model. Defaults to `claude-opus-4-7`. |
| `DEFAULT_REPO_OWNER` |  | GitHub org/user prefix used when the repo field contains a bare repo name. |
| `SLACK_BOT_TOKEN` |  | Slack bot token (`xoxb-…`). Enables DMs. Needs `users:read.email` and `chat:write` scopes. |
| `AUTHORIZED_USER_IDS` |  | Comma-separated user IDs allowed to issue `!set` commands. Currently unused. |

---

## Contributing

PRs and issues welcome. The project is small enough to read top to bottom in one sitting — [`AGENTS.md`](AGENTS.md) has a quick tour, and the provider interfaces are documented inline in [`lib/providers/tickets/index.js`](lib/providers/tickets/index.js) and [`lib/providers/agents/index.js`](lib/providers/agents/index.js).

Adding a new tracker (Linear, GitHub Issues, …) or a new agent platform (GitHub Copilot Workspace, Replit Ghostwriter, …) is "implement the interface, register it" — no changes to the dispatcher needed.

## License

[MIT](LICENSE) © Yonatan Golde
