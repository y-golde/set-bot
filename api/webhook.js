import { waitUntil } from '@vercel/functions';
import {
  postUpdate,
  escapeHtml,
  stripHtml,
  getItemContext,
  formatItemContext,
  extractRepoUrl,
} from '../lib/monday.js';
import { launchAgent } from '../lib/cursor.js';

const INITIAL_COMMENT = (itemName) => `
👋 Hey team — I'm here to triage <b>${escapeHtml(itemName)}</b>.<br><br>
Before I can act, please:<br>
1. Fill in the <b>Repositories</b> column with the GitHub repo URL.<br>
2. Reply with <code>SYSTEM OVERRIDE research</code> or <code>SYSTEM OVERRIDE implement</code>.
`.trim();

const MISSING_REPO = `⚠️ I couldn't find a repo URL in the <b>Repositories</b> column. Please fill it in and try again.`;

const MODES = {
  research: {
    emoji: '🔬',
    label: 'research',
    ackVerb: 'Kicking off a research agent',
    autoCreatePR: false,
    buildPrompt: ({ itemName, repo, contextBlock }) => `You are researching a ticket from monday.com.

Ticket title: ${itemName}
Repository: ${repo}

Full ticket context (column values + conversation history):
---
${contextBlock || '(no additional context)'}
---

Treat the ticket title, column values, and conversation above as the
combined request from the team. Investigate the repository and produce
a brief that directly answers it. Cover:
1. The specific answer or finding (files, configs, values, commands).
2. Where in the codebase the answer lives (paths + line numbers if helpful).
3. Any caveats, gotchas, or relevant nearby context.

Note: comments starting with "SYSTEM OVERRIDE" are bot triggers, not
part of the question. Bot status comments (🔬, 🚀, ✅, ❌, ⚠️, 🔧, 👋)
can also be ignored.

Do not modify code. Keep the brief tight (under ~400 words).`,
  },
  implement: {
    emoji: '🔧',
    label: 'implement',
    ackVerb: 'Kicking off an implementation agent',
    autoCreatePR: true,
    buildPrompt: ({ itemName, repo, contextBlock }) => `You are implementing a ticket from monday.com.

Ticket title: ${itemName}
Repository: ${repo}

Full ticket context (column values + conversation history):
---
${contextBlock || '(no additional context)'}
---

Treat the ticket title, column values, and conversation above as the
combined request from the team. Implement the change in the repository:
1. Read the relevant files to understand the existing patterns.
2. Make the minimum set of code changes needed to satisfy the request.
3. Run/lint/test where appropriate; fix anything you break.
4. Commit on a new branch and open a pull request.

The PR description should restate the request, summarize what changed
and why, and list any follow-ups or caveats. Link back to the monday
ticket title at the top of the PR description.

Note: comments starting with "SYSTEM OVERRIDE" are bot triggers, not
part of the question. Bot status comments (🔬, 🚀, ✅, ❌, ⚠️, 🔧, 👋)
can also be ignored.

If the request is ambiguous or you cannot proceed safely, stop and
explain what you need rather than guessing.`,
  },
};

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({ ok: true, service: 'monday-bot' });
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const secret = process.env.WEBHOOK_SHARED_SECRET;
  if (secret && req.query.secret !== secret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch (err) {
    console.error('[monday-bot] Bad JSON body:', err);
    return res.status(200).json({ ok: true });
  }

  if (body?.challenge) {
    return res.status(200).json({ challenge: body.challenge });
  }

  const event = body?.event;
  const type = event?.type;
  const host = req.headers.host;

  waitUntil(
    processEvent(type, event, host).catch((err) => {
      console.error('[monday-bot] Background processing error:', err);
    })
  );

  return res.status(200).json({ ok: true });
}

async function processEvent(type, event, host) {
  if (type === 'create_pulse') {
    await postUpdate(event.pulseId, INITIAL_COMMENT(event.pulseName ?? 'this item'));
    console.log(`[monday-bot] Triage prompt posted on item ${event.pulseId}`);
    return;
  }
  if (type === 'create_update' || type === 'create_reply') {
    await handleReply(event, host);
    return;
  }
  console.log(`[monday-bot] Ignoring event type: ${type ?? 'unknown'}`);
}

async function handleReply(event, host) {
  const itemId = event.pulseId;
  const text = stripHtml(event.body ?? event.textBody ?? '');

  const match = text.match(/^\s*SYSTEM\s+OVERRIDE\s+(\w+)/i);
  if (!match) {
    console.log(`[monday-bot] No SYSTEM OVERRIDE in reply on item ${itemId}`);
    return;
  }
  const command = match[1].toLowerCase();
  const mode = MODES[command];
  if (!mode) {
    console.log(`[monday-bot] Unknown command "${command}" on item ${itemId}`);
    return;
  }

  const item = await getItemContext(itemId);
  const repo = extractRepoUrl(item);
  if (!repo) {
    await postUpdate(itemId, MISSING_REPO);
    return;
  }
  const itemName = item?.name ?? event.pulseName ?? '(unknown)';
  const contextBlock = formatItemContext(item);

  await postUpdate(
    itemId,
    `${mode.emoji} ${mode.ackVerb} against <a href="${escapeHtml(repo)}">${escapeHtml(repo)}</a>. I'll post the agent link once it spins up.`
  );

  const callbackUrl = `https://${host}/api/cursor-webhook?itemId=${encodeURIComponent(itemId)}&mode=${mode.label}`;
  const prompt = mode.buildPrompt({ itemName, repo, contextBlock });

  try {
    const agent = await launchAgent({
      prompt,
      repository: repo,
      webhookUrl: callbackUrl,
      model: process.env.CURSOR_MODEL || 'gpt-5.5-high',
      autoCreatePR: mode.autoCreatePR,
    });
    const agentUrl = agent?.target?.url ?? agent?.url ?? `https://cursor.com/agents/${agent?.id ?? ''}`;
    await postUpdate(
      itemId,
      `🚀 ${mode.label[0].toUpperCase() + mode.label.slice(1)} agent is running.<br>Live progress: <a href="${escapeHtml(agentUrl)}">${escapeHtml(agentUrl)}</a>`
    );
    console.log(`[monday-bot] Launched Cursor ${mode.label} agent ${agent?.id} for item ${itemId}`);
  } catch (err) {
    console.error(`[monday-bot] Cursor ${mode.label} launch failed:`, err);
    await postUpdate(
      itemId,
      `❌ Couldn't launch the ${mode.label} agent: <code>${escapeHtml(err.message ?? String(err))}</code>`
    );
  }
}
