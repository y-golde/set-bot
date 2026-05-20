# AGENTS.md

Guidance for AI coding agents (Cursor, Claude Code, Codex, etc.) working in this repo. Humans, see [README.md](README.md) first.

## What this is

Set is a small webhook bot that dispatches coding agents against tickets. Tickets can come from any registered **TicketProvider** (Monday today, Jira today); work can run on any registered **AgentProvider** (Cursor today, Anthropic today). The whole thing is plain Node — no framework, no TypeScript, no bundler. Read all of `api/` and `lib/` before making non-trivial changes; it's faster than guessing.

## Layout

```
api/
  tickets/
    monday/webhook.js     # POST handler for Monday events
    jira/webhook.js       # POST handler for Jira webhooks
  agents/
    cursor/callback.js    # POST handler for Cursor agent callbacks
    anthropic/callback.js # POST handler for Anthropic (sync — no-op shim)
lib/
  dispatch.js             # !set parsing, MODES, command dispatch
  route-helpers.js        # shared POST handlers used by the api/ routes
  notify.js               # comment + Slack DM helper (provider-agnostic)
  result.js               # reads agent state via AgentProvider, posts back
  monday.js               # monday.com GraphQL client
  jira.js                 # Jira REST client + HTML↔ADF helpers
  cursor.js               # Cursor Background Agents API client
  anthropic.js            # Anthropic Messages API client
  slack.js                # Slack Web API client (users.lookupByEmail, chat.postMessage)
  providers/
    tickets/
      index.js            # TicketProvider contract + registry
      monday.js           # TicketProvider implementation
      jira.js             # TicketProvider implementation
    agents/
      index.js            # AgentProvider contract + registry
      cursor.js           # AgentProvider implementation (deferred)
      anthropic.js        # AgentProvider implementation (sync)
```

## Provider contracts

The contracts live as JSDoc in `lib/providers/tickets/index.js` and `lib/providers/agents/index.js`. Adding a new tracker (e.g. Linear) or a new agent platform (e.g. GitHub Copilot Workspace) is "implement the interface, register it" — no changes to `dispatch.js` should be needed.

Provider IDs are stable strings (`monday`, `jira`, `cursor`, `anthropic`) and appear in:
- Route paths: `/api/tickets/<id>/webhook`, `/api/agents/<id>/callback`
- Comment markers: `agent:<id>:<agentId>` (used by `!set status` to find prior agents)
- Logs

### Agent provider kinds

- **deferred** (Cursor): `launchAgent` returns immediately; the agent runs out of band and POSTs back to `callbackUrl` when status changes.
- **sync** (Anthropic): `launchAgent` runs inline and returns the finished result in `launch.sync`. No callback fires.

`dispatch.js#handleSyncLaunch` posts the result right away for sync providers; `route-helpers.js#handleAgentCallback` handles deferred ones.

## Conventions

- **ESM only** (`"type": "module"`). Use `import`, not `require`.
- **No build step.** Code runs as-is on Vercel's Node 20 runtime.
- **No deps unless necessary.** The only runtime dep is `@vercel/functions` for `waitUntil`.
- **Always return 200 from webhook handlers.** Monday/Jira retry non-200 responses; real work goes in `waitUntil(...)`.
- **HTML in ticket comments, plain text everywhere else.** Each ticket provider's `postComment` accepts the small Monday-style HTML subset (`<b>`, `<br>`, `<a>`, `<code>`). Providers translate at the boundary — Jira converts to ADF in `lib/jira.js#htmlToADF`.
- **Always escape user-controlled strings** with `escapeHtml` before splicing into comments.
- **Log prefix is `[set-bot]`** for dispatcher logs; per-provider routes use `[<provider>-callback]`.
- **Persona stays light.** Set is a dog. Sign-offs use the `sign()` helper in `dispatch.js`.

## Commands

```bash
npm install
npx vercel dev         # local dev server on :3000
npx vercel             # deploy preview
npx vercel --prod      # deploy to production
```

There are no tests yet. If you add a feature complex enough to want one, add tests too — but don't introduce a test framework for a one-line change.

## Where to make common changes

| Task | File |
|---|---|
| Add a new `!set <command>` | `lib/dispatch.js` — extend the `MODES` table or the `command === 'foo'` branches in `handleReply` |
| Add a new ticket provider | New file under `lib/providers/tickets/`, register in `lib/providers/tickets/index.js`, add route under `api/tickets/<id>/` |
| Add a new agent provider | New file under `lib/providers/agents/`, register in `lib/providers/agents/index.js`, add route under `api/agents/<id>/` |
| Change what context is sent to the agent | `lib/dispatch.js` `buildPrompt` + each ticket provider's `getTicketContext` |
| Tweak result/PR formatting | `lib/result.js#postAgentResult` |
| Change Slack DM behaviour | `lib/notify.js`, `lib/slack.js` |
| Support a non-GitHub repo host | `lib/monday.js#normalizeGithubUrl` (shared by both ticket providers) |

## Things to *not* do

- **Don't add a database.** State lives on the ticket. The audit log is the comment history.
- **Don't loosen the 200-on-error contract** in webhook handlers — it's load-bearing for retry behaviour.
- **Don't add Slack as a hard dependency.** Slack DMs are best-effort.
- **Don't strip the dog persona.** It's the brand.
- **Don't put secrets in code or commits.** Use Vercel env vars. `.env` is gitignored.
- **Don't reach across provider boundaries.** Anything ticket-specific stays in `lib/providers/tickets/<id>.js` + `lib/<id>.js`. Anything agent-specific stays in `lib/providers/agents/<id>.js` + `lib/<id>.js`. `dispatch.js` and `result.js` only talk to providers through the interface.

## API drift

All four upstream APIs are young and the response shapes shift:

- **monday.com GraphQL** — versioned via `API-Version: 2024-10` header in `lib/monday.js`.
- **Jira REST** — `lib/jira.js` calls `/rest/api/3`. ADF schema is documented but evolving.
- **Cursor Background Agents** — `lib/cursor.js` calls `https://api.cursor.com/v0`. Field names like `target.url`, `pullRequest.url`, `status` have moved before. `lib/providers/agents/cursor.js#findPrUrl` reads from several locations defensively.
- **Anthropic Messages** — `lib/anthropic.js` calls `https://api.anthropic.com/v1/messages` with `anthropic-version: 2023-06-01`.

## Style

- Two-space indent, single quotes, no semicolons on import statements (match existing files).
- Prefer small top-level functions over classes.
- Comments explain *why*, not *what*.
