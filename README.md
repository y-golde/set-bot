# Set 🐕

> A pluggable ticket-bot that dispatches coding agents. Plug in any tracker (Monday, Jira) and any agent platform (Cursor, Anthropic) — they talk through a small provider interface.

Set is named after [my dog](https://github.com/y-golde). When a new ticket is created, Set drops in a triage comment — and, if a **repo suggester** is configured, follows up with a guess at which repository the ticket belongs to. Reply with `!set research` or `!set implement` and Set spins up an agent against the repo on the ticket (or the accepted suggestion), then posts the result (and a PR link, when relevant) back as a comment — and DMs the requester on Slack if their email matches a Slack user.

---

## What it does

```
ticket tracker (Monday / Jira)
  ├─ ticket created     ──► Set posts: "Hi! Reply !set research or !set implement"
  │                     ──► (optional) repo suggester posts: "🔎 my guess: <repo>"
  ├─ reply "!set use"   ──► Set saves the suggested repo onto the ticket field.
  └─ reply "!set …"     ──► Set launches an agent (Cursor / Anthropic) against
                              the repo on the ticket (auto-accepts the suggestion
                              if the field is empty), posts the agent URL, and
                              (when the agent finishes) posts the result + PR link.
```

Supported commands (anyone on the board / project can use them):

| Command | What it does |
|---|---|
| `!set research` | Spins up an agent that investigates and posts a brief. No code changes. |
| `!set implement` | Spins up an agent that writes code and opens a PR. |
| `!set use [repo-url]` | Accepts the suggested repo (or override with a URL) and writes it to the ticket. |
| `!set status` | Re-posts the latest agent's status / result on the ticket. |
| `!set help` | Lists commands. |

Add `--agent=<id>` to any command to override the default agent provider for that run, e.g. `!set research --agent=anthropic`.

## Auto-triage (optional)

If you have a tool that knows your org's repos (today: [Unblocked](https://docs.getunblocked.com/api-reference/quickstart)), Set can guess which repo a new ticket belongs to and offer it back. The user accepts with `!set use`, or just runs `!set research` / `!set implement` and Set auto-accepts the most recent suggestion.

Enable it by setting:

```
REPO_SUGGESTER=unblocked
UNBLOCKED_API_TOKEN=…             # Personal or Team Access Token from Unblocked
# UNBLOCKED_API_URL=https://getunblocked.com/api/v1   # optional override
```

The suggester is pluggable: add a new file under `lib/providers/repo-suggesters/` for any other knowledge tool (Glean, Sourcegraph, etc.) and point `REPO_SUGGESTER` at its id. Default is `noop` (feature off).

## Architecture

- **Runtime:** Node 20, ESM, one runtime dependency (`@vercel/functions`).
- **Deploy:** Vercel serverless functions, one route per provider.
- **Storage:** none. State lives on the ticket itself (comment history is the audit log).
- **Providers:** ticket trackers, agent platforms, and repo suggesters are pluggable behind small interfaces in [`lib/providers/`](lib/providers/). Today: Monday + Jira for tickets, Cursor + Anthropic for agents, Unblocked (and a no-op default) for repo suggesters.

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

### Core

| Variable | Description |
|---|---|
| `AGENT_PROVIDER` | Default agent provider — `cursor` or `anthropic`. |
| `WEBHOOK_SHARED_SECRET` | If set, ticket webhook requests must include `?secret=<value>`. |

### Ticket providers

#### Monday

| Variable | Description |
|---|---|
| `MONDAY_API_TOKEN` | Personal API token from monday.com developer settings. |

#### Jira

| Variable | Description |
|---|---|
| `JIRA_BASE_URL` | `https://<your-org>.atlassian.net` |
| `JIRA_EMAIL` | Email used for Basic auth. |
| `JIRA_API_TOKEN` | Token from id.atlassian.com → API tokens. |
| `JIRA_REPO_FIELD` | Custom-field id holding the repo URL (e.g. `customfield_10042`). Optional. |

### Agent providers

#### Cursor

| Variable | Description |
|---|---|
| `CURSOR_API_KEY` | Cursor Background Agents API key. |
| `CURSOR_MODEL` | Cursor agent model. Defaults to `composer-2.5-fast`. |

#### Anthropic

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic API key. |
| `ANTHROPIC_MODEL` | Anthropic model. Defaults to `claude-opus-4-7`. |

### Repo resolution

| Variable | Description |
|---|---|
| `DEFAULT_REPO_OWNER` | GitHub org/user prefix used when the repo field contains a bare repo name. |

### Slack notifications

| Variable | Description |
|---|---|
| `SLACK_BOT_TOKEN` | Slack bot token (`xoxb-…`). Enables DMs. Needs `users:read.email` and `chat:write` scopes. |
| `AUTHORIZED_USER_IDS` | Comma-separated user IDs allowed to issue `!set` commands. Currently unused. |

---

## Contributing

PRs and issues welcome. The project is small enough to read top to bottom in one sitting — [`AGENTS.md`](AGENTS.md) has a quick tour, and the provider interfaces are documented inline in [`lib/providers/tickets/index.js`](lib/providers/tickets/index.js) and [`lib/providers/agents/index.js`](lib/providers/agents/index.js).

Adding a new tracker (Linear, GitHub Issues, …) or a new agent platform (GitHub Copilot Workspace, Replit Ghostwriter, …) is "implement the interface, register it" — no changes to the dispatcher needed.

## License

[MIT](LICENSE) © Yonatan Golde
