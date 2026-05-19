import { waitUntil } from '@vercel/functions';
import {
  postUpdate,
  escapeHtml,
  stripHtml,
  getItemContext,
  formatItemContext,
  extractRepoUrl,
  getBotUserId,
  getUserEmail,
} from '../lib/monday.js';
import { launchAgent } from '../lib/cursor.js';
import { postAgentResult, findMostRecentAgent } from '../lib/result.js';
import { notify } from '../lib/notify.js';

// Pick a random dog sound to sign off each message. Set is a dog.
const DOG_SOUNDS = ['woof', 'bark', 'arf', 'woof woof', 'bork', '*tail wag*', 'awoo', 'ruff'];
const sign = (mood) => {
  // Allow callers to bias the sound by mood
  if (mood === 'angry') return ' grrr 🐶';
  if (mood === 'sad') return ' *whimper* 🐶';
  if (mood === 'happy') return ' 🐕 ' + DOG_SOUNDS[Math.floor(Math.random() * DOG_SOUNDS.length)] + '!';
  return ' — ' + DOG_SOUNDS[Math.floor(Math.random() * DOG_SOUNDS.length)] + '!';
};

const INITIAL_COMMENT = (itemName) => `
🐕 Hi! I'm <b>Set</b> — I help triage <b>${escapeHtml(itemName)}</b>.<br><br>
Please fill in the <b>Repositories</b> column with the GitHub repo URL, then a maintainer will kick off research or implement from here.${sign('happy')}
`.trim();

const HELP_COMMENT = `
🐕 <b>Set — command list</b><br><br>
<code>!set research</code> — kick off a Cursor research agent against the ticket's repo.<br>
<code>!set implement</code> — kick off a Cursor implementation agent (writes code + opens a PR).<br>
<code>!set status</code> — re-post the latest agent's status / result on this ticket.<br>
<code>!set help</code> — show this list.<br><br>
Commands only work when posted from the Set account.${sign('happy')}
`.trim();

const MISSING_REPO = `⚠️ I couldn't find a repo URL in the <b>Repositories</b> column. Please fill it in and try again.${sign('sad')}`;

const MODES = {
  research: {
    emoji: '🔬',
    label: 'research',
    ackVerb: 'Kicking off a research agent',
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

You have access to a Coralogix MCP server. Use it whenever the question
involves production logs, errors, runtime behavior, or service metrics —
query Coralogix directly instead of guessing from the code.

Note: comments starting with "!set" are bot triggers (e.g. "!set
research", "!set implement"), not part of the question. Bot status
comments (🔬, 🚀, ✅, ❌, ⚠️, 🔧, 👋, 🐕) and any "woof"/"bark"
sign-offs can also be ignored — that's just the bot's persona.

Do not modify code. Keep the brief tight (under ~400 words).`,
  },
  implement: {
    emoji: '🔧',
    label: 'implement',
    ackVerb: 'Kicking off an implementation agent',
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

You have access to a Coralogix MCP server. Use it whenever the task
requires understanding production logs, errors, runtime behavior, or
service metrics before changing code — query Coralogix directly
instead of guessing.

Note: comments starting with "!set" are bot triggers (e.g. "!set
research", "!set implement"), not part of the question. Bot status
comments (🔬, 🚀, ✅, ❌, ⚠️, 🔧, 👋, 🐕) and any "woof"/"bark"
sign-offs can also be ignored — that's just the bot's persona.

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

  const match = text.match(/^\s*!set\s+(\w+)/i);
  if (!match) {
    console.log(
      `[set-bot] No !set command in reply on item ${itemId}. ` +
      `Raw text (first 200 chars): ${JSON.stringify(text.slice(0, 200))}`
    );
    return;
  }

  // Commands only work when sent from Set's monday account
  // (the user whose API token we're using). Anyone else gets ignored.
  const botUserId = await getBotUserId();
  if (!botUserId || String(event.userId ?? '') !== botUserId) {
    console.log(
      `[set-bot] !set command from non-Set user ${event.userId} (bot=${botUserId}) — ignoring`
    );
    return;
  }

  const command = match[1].toLowerCase();
  const triggerUserId = event.userId ?? null;
  const triggerEmail = await getUserEmail(triggerUserId).catch(() => null);

  if (command === 'help') {
    await notify(itemId, HELP_COMMENT, triggerEmail);
    return;
  }

  // "status" — find the most recent agent on this ticket and post its result.
  if (command === 'status') {
    const item = await getItemContext(itemId);
    const found = findMostRecentAgent(item);
    if (!found) {
      await notify(itemId, `⚠️ No previous agent found on this ticket.${sign('sad')}`, triggerEmail);
      return;
    }
    await postAgentResult({
      itemId,
      agentId: found.agentId,
      mode: found.mode,
      force: true,
      notifyEmail: triggerEmail,
    });
    return;
  }

  const mode = MODES[command];
  if (!mode) {
    await notify(itemId, `🐕 I don't know <code>${escapeHtml(command)}</code>. Try <code>!set help</code>.${sign('sad')}`, triggerEmail);
    return;
  }

  const item = await getItemContext(itemId);
  const repo = extractRepoUrl(item);
  if (!repo) {
    await notify(itemId, MISSING_REPO, triggerEmail);
    return;
  }
  const itemName = item?.name ?? event.pulseName ?? '(unknown)';
  const contextBlock = formatItemContext(item);

  await notify(
    itemId,
    `${mode.emoji} ${mode.ackVerb} against <a href="${escapeHtml(repo)}">${escapeHtml(repo)}</a>. I'll post the agent link once it spins up.${sign()}`,
    triggerEmail
  );

  // Pass triggerUserId through so cursor-webhook can DM the same user on completion.
  const callbackUrl = `https://${host}/api/cursor-webhook` +
    `?itemId=${encodeURIComponent(itemId)}` +
    `&mode=${mode.label}` +
    (triggerUserId ? `&userId=${encodeURIComponent(triggerUserId)}` : '');
  const prompt = mode.buildPrompt({ itemName, repo, contextBlock });

  try {
    const agent = await launchAgent({
      prompt,
      repository: repo,
      webhookUrl: callbackUrl,
      model: process.env.CURSOR_MODEL || 'composer-2.5-fast',
    });
    const agentUrl = agent?.target?.url ?? agent?.url ?? `https://cursor.com/agents/${agent?.id ?? ''}`;
    await notify(
      itemId,
      `🚀 ${mode.label[0].toUpperCase() + mode.label.slice(1)} agent is running.<br>Live progress: <a href="${escapeHtml(agentUrl)}">${escapeHtml(agentUrl)}</a>${sign('happy')}`,
      triggerEmail
    );
    console.log(`[monday-bot] Launched Cursor ${mode.label} agent ${agent?.id} for item ${itemId}`);
  } catch (err) {
    console.error(`[monday-bot] Cursor ${mode.label} launch failed:`, err);
    const isTimeout = err?.name === 'AbortError' || /aborted|timeout/i.test(err?.message ?? '');
    if (isTimeout) {
      await notify(
        itemId,
        `⏳ ${mode.label[0].toUpperCase() + mode.label.slice(1)} agent was submitted, but Cursor didn't respond with the agent URL in time. It's almost certainly running. I'll post the result automatically when it finishes, or reply <code>!set status</code> for an update.${sign()}`,
        triggerEmail
      );
    } else {
      await notify(
        itemId,
        `❌ Couldn't launch the ${mode.label} agent: <code>${escapeHtml(err.message ?? String(err))}</code>${sign('angry')}`,
        triggerEmail
      );
    }
  }
}
