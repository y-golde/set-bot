# AGENTS.md

Guidance for AI coding agents (Cursor, Claude Code, Codex, etc.) working in this repo. Humans, see [README.md](README.md) first.

## What this is

Set is a small monday.com webhook bot that dispatches Cursor background agents. The whole thing is ~600 lines of plain Node — no framework, no TypeScript, no bundler. Read all of `api/` and `lib/` before making non-trivial changes; it's faster than guessing.

## Layout

```
api/
  webhook.js          # POST handler for monday events (create_pulse, create_update, create_reply)
  cursor-webhook.js   # POST handler for Cursor agent callbacks
lib/
  monday.js           # monday.com GraphQL client + helpers (postUpdate, getItemContext, extractRepoUrl, …)
  cursor.js           # Cursor Background Agents API client (launchAgent, getAgent, getAgentConversation)
  result.js           # Reads agent state, posts result + PR link back to monday
  notify.js           # Posts a monday update AND DMs the triggering user on Slack
  slack.js            # Minimal Slack Web API client (users.lookupByEmail, chat.postMessage)
```

## Conventions

- **ESM only** (`"type": "module"` in `package.json`). Use `import`, not `require`.
- **No build step.** Code runs as-is on Vercel's Node 20 runtime.
- **No deps unless necessary.** The only runtime dep is `@vercel/functions` for `waitUntil`. Don't add a framework or HTTP client — `fetch` is built in.
- **Always return 200 from webhook handlers.** monday retries non-200 responses for 30 minutes. Real work goes in `waitUntil(...)` so the response can be sent immediately while processing happens in the background. Errors are logged, not surfaced as 5xx.
- **HTML in monday comments, plain text everywhere else.** monday's `create_update` mutation accepts a small HTML subset (`<b>`, `<br>`, `<a>`, `<code>`). `lib/notify.js#htmlToSlack` mirrors that into Slack mrkdwn.
- **Always escape user-controlled strings** with `escapeHtml` before splicing into update bodies. Item names, error messages, agent output — all of it.
- **Log prefix is `[set-bot]`.** Match it for new log lines so existing log filters keep working.
- **Persona stays light.** Set is a dog. Sign-offs use the `sign()` helper in `api/webhook.js`. Don't sprinkle emoji elsewhere.

## Commands

```bash
npm install            # install @vercel/functions
npx vercel dev         # local dev server on :3000
npx vercel             # deploy preview
npx vercel --prod      # deploy to production
```

There are no tests yet. If you add a feature complex enough to want one, add tests too — but don't introduce a test framework for a one-line change.

## Where to make common changes

| Task | File |
|---|---|
| Add a new `!set <command>` | `api/webhook.js` — extend the `MODES` table or the `command === 'foo'` branches in `handleReply` |
| Change what context is sent to the agent | `lib/monday.js#getItemContext` / `formatItemContext`, then the `buildPrompt` functions in `api/webhook.js` |
| Tweak result/PR formatting | `lib/result.js#postAgentResult` |
| Change Slack DM behaviour | `lib/notify.js`, `lib/slack.js` |
| Support a different repo column name | `lib/monday.js#extractRepoUrl` (defaults to `"Repositories"`) |
| Support a non-GitHub repo host | `lib/monday.js#normalizeGithubUrl` — currently hard-codes `github.com` |

## Things to *not* do

- **Don't add a database.** State lives on the monday ticket. The audit log is the comment history.
- **Don't loosen the 200-on-error contract** in webhook handlers — it's load-bearing for retry behaviour.
- **Don't add Slack as a hard dependency.** Slack DMs are best-effort; absence of `SLACK_BOT_TOKEN` must not break the monday flow.
- **Don't strip the dog persona.** It's the brand.
- **Don't put secrets in code or commits.** Use Vercel env vars. `.env` is gitignored.

## API drift

Both upstream APIs are young and the response shapes shift:

- **monday.com GraphQL** — versioned via `API-Version: 2024-10` header in `lib/monday.js`. Bump the version intentionally, not casually; check the [changelog](https://developer.monday.com/api-reference/docs/changelog).
- **Cursor Background Agents** — `lib/cursor.js` calls `https://api.cursor.com/v0`. Field names like `target.url`, `pullRequest.url`, `status` have moved before. `lib/result.js#findPrUrl` reads from several locations defensively — extend that pattern rather than assuming a single shape.

## Style

- Two-space indent, single quotes, no semicolons on import statements (match existing files).
- Prefer small top-level functions over classes.
- Comments explain *why*, not *what*. The code already says what.
