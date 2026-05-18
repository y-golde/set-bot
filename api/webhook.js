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

const IMPLEMENT_STUB = `🔧 <b>Implement</b> mode isn't wired up yet — coming in step 3. For now, try <b>research</b>.`;

const MISSING_REPO = `⚠️ I couldn't find a repo URL in the <b>Repositories</b> column. Please fill it in and try again.`;

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

  // Hand the heavy work to waitUntil and return 200 immediately so monday
  // doesn't retry while we're talking to Cursor.
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

  // Strict trigger: only act when the user explicitly opts in.
  // This also kills the bot-replying-to-itself loop, since the bot never
  // starts its own comments with this phrase.
  const match = text.match(/^\s*SYSTEM\s+OVERRIDE\s+(\w+)/i);
  if (!match) {
    console.log(`[monday-bot] No SYSTEM OVERRIDE in reply on item ${itemId}`);
    return;
  }
  const command = match[1].toLowerCase();

  if (command === 'implement') {
    await postUpdate(itemId, IMPLEMENT_STUB);
    return;
  }
  if (command !== 'research') {
    console.log(`[monday-bot] Unknown command "${command}" on item ${itemId}`);
    return;
  }

  // Fetch the full item with columns + update/reply history.
  const item = await getItemContext(itemId);
  const repo = extractRepoUrl(item);
  if (!repo) {
    await postUpdate(itemId, MISSING_REPO);
    return;
  }
  const itemName = item?.name ?? event.pulseName ?? '(unknown)';
  const contextBlock = formatItemContext(item);

  // Acknowledge first so the user sees activity even if Cursor is slow.
  await postUpdate(
    itemId,
    `🔬 Kicking off a research agent against <a href="${escapeHtml(repo)}">${escapeHtml(repo)}</a>. I'll post the agent link once it spins up.`
  );

  const callbackUrl = `https://${host}/api/cursor-webhook?itemId=${encodeURIComponent(itemId)}`;
  const prompt = `You are researching a ticket from monday.com.

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

Do not modify code. Keep the brief tight (under ~400 words).`;

  try {
    const agent = await launchAgent({
      prompt,
      repository: repo,
      webhookUrl: callbackUrl,
      model: process.env.CURSOR_MODEL || 'gpt-5.5-medium',
    });
    const agentUrl = agent?.target?.url ?? agent?.url ?? `https://cursor.com/agents/${agent?.id ?? ''}`;
    await postUpdate(
      itemId,
      `🚀 Research agent is running.<br>Live progress: <a href="${escapeHtml(agentUrl)}">${escapeHtml(agentUrl)}</a>`
    );
    console.log(`[monday-bot] Launched Cursor agent ${agent?.id} for item ${itemId}`);
  } catch (err) {
    console.error('[monday-bot] Cursor launch failed:', err);
    await postUpdate(
      itemId,
      `❌ Couldn't launch the research agent: <code>${escapeHtml(err.message ?? String(err))}</code>`
    );
  }
}
