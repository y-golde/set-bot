// Provider-agnostic command dispatch.
//
// Both ticket-webhook routes (Monday, Jira) parse their inbound payload into
// a NormalizedEvent (see lib/providers/tickets/index.js) and hand it here.
// This module owns the !set parsing, the MODES table, and the launch path.
// It calls into a TicketProvider for ticket I/O and an AgentProvider for
// the actual agent work.

import { escapeHtml } from './monday.js';
import { notify, resolveRef } from './notify.js';
import { getAgentProvider, getDefaultAgentProvider } from './providers/agents/index.js';
import { postAgentResult, buildLinksLine } from './result.js';

const DOG_SOUNDS = ['woof', 'bark', 'arf', 'woof woof', 'bork', '*tail wag*', 'awoo', 'ruff'];
const sign = (mood) => {
  if (mood === 'angry') return ' grrr 🐶';
  if (mood === 'sad') return ' *whimper* 🐶';
  if (mood === 'happy') return ' 🐕 ' + DOG_SOUNDS[Math.floor(Math.random() * DOG_SOUNDS.length)] + '!';
  return ' — ' + DOG_SOUNDS[Math.floor(Math.random() * DOG_SOUNDS.length)] + '!';
};

const INITIAL_COMMENT = (itemName) => `
🐕 Hi! I'm <b>Set</b> — I help triage <b>${escapeHtml(itemName)}</b>.<br><br>
Fill in the repo URL on the ticket, then reply with one of:<br>
• <code>!set research</code> — I'll spin up an agent to investigate the question and post a brief here.<br>
• <code>!set implement</code> — I'll spin up an agent to make the code changes and open a PR.<br>
• <code>!set status</code> — re-post the latest agent's progress / result.<br>
• <code>!set help</code> — show the full command list.<br><br>
Anyone on this board can use the commands — go ahead!${sign('happy')}
`.trim();

const HELP_COMMENT = `
🐕 <b>Set — command list</b><br><br>
<code>!set research</code> — kick off a research agent against the ticket's repo.<br>
<code>!set implement</code> — kick off an implementation agent (writes code + opens a PR).<br>
<code>!set status</code> — re-post the latest agent's status / result on this ticket.<br>
<code>!set help</code> — show this list.<br><br>
Add <code>--agent=cursor|anthropic</code> to override the default agent provider.${sign('happy')}
`.trim();

const MISSING_REPO = `⚠️ I couldn't find a repo URL on this ticket. Please add one and try again.${sign('sad')}`;

const MODES = {
  research: {
    emoji: '🔬',
    label: 'research',
    ackVerb: 'Kicking off a research agent',
    buildPrompt: ({ itemName, repo, contextBlock }) => `You are researching a ticket from a project tracker.

Ticket title: ${itemName}
Repository: ${repo}

Full ticket data (raw JSON from the project tracker — every field,
column, and comment that the API exposed):
---
${contextBlock || '(no additional context)'}
---

Treat the ticket title, fields, and conversation above as the combined
request from the team. Investigate the repository and produce a brief that
directly answers it. Cover:
1. The specific answer or finding (files, configs, values, commands).
2. Where in the codebase the answer lives (paths + line numbers if helpful).
3. Any caveats, gotchas, or relevant nearby context.

Note: comments starting with "!set" are bot triggers, not part of the
question. Bot status comments (🔬, 🚀, ✅, ❌, ⚠️, 🔧, 👋, 🐕) and any
"woof"/"bark" sign-offs can also be ignored — that's just the bot's persona.

Use whatever MCP servers / tools you have available (logging backends,
observability platforms, search, etc.) when the question involves
production behavior or runtime data — query them directly instead of
guessing from the code.

Do not modify code. Keep the brief tight (under ~400 words).`,
  },
  implement: {
    emoji: '🔧',
    label: 'implement',
    ackVerb: 'Kicking off an implementation agent',
    buildPrompt: ({ itemName, repo, contextBlock }) => `You are implementing a ticket from a project tracker.

Ticket title: ${itemName}
Repository: ${repo}

Full ticket data (raw JSON from the project tracker — every field,
column, and comment that the API exposed):
---
${contextBlock || '(no additional context)'}
---

Treat the ticket title, fields, and conversation above as the combined
request from the team. Implement the change in the repository:
1. Read the relevant files to understand the existing patterns.
2. Make the minimum set of code changes needed to satisfy the request.
3. Run/lint/test where appropriate; fix anything you break.
4. Commit on a new branch and open a pull request.

The PR description should restate the request, summarize what changed
and why, and list any follow-ups or caveats. Link back to the originating
ticket at the top of the PR description.

Note: comments starting with "!set" are bot triggers, not part of the
question. Bot status comments and any "woof"/"bark" sign-offs can also be
ignored — that's just the bot's persona.

Use whatever MCP servers / tools you have available (logging backends,
observability platforms, search, etc.) when the task requires understanding
production behavior or runtime data before changing code — query them
directly instead of guessing.

If the request is ambiguous or you cannot proceed safely, stop and explain
what you need rather than guessing.`,
  },
};

// Entry point — called from each ticket-webhook route after the provider
// parses the inbound payload into a NormalizedEvent.
export async function handleEvent({ event, ticketProvider, host }) {
  if (event.type === 'ticket_created') {
    await ticketProvider.postComment(event.ticketId, INITIAL_COMMENT(event.ticketName ?? 'this item'));
    console.log(`[set-bot] Triage prompt posted on ${ticketProvider.id} ticket ${event.ticketId}`);
    return;
  }

  if (event.type === 'reply') {
    await handleReply({ event, ticketProvider, host });
    return;
  }

  console.log(`[set-bot] Ignoring event type: ${event.type}`);
}

async function handleReply({ event, ticketProvider, host }) {
  const ticketId = event.ticketId;
  const text = event.text;

  const match = text.match(/^\s*!set\s+(\w+)([^\n]*)?/i);
  if (!match) {
    console.log(
      `[set-bot] No !set command on ${ticketProvider.id} ticket ${ticketId}. ` +
      `Text (first 200 chars): ${JSON.stringify(text.slice(0, 200))}`
    );
    return;
  }

  const command = match[1].toLowerCase();
  const rest = match[2] ?? '';
  const flags = parseFlags(rest);

  console.log(`[set-bot] !set ${command} from user ${event.requesterId} on ${ticketProvider.id}:${ticketId}`);

  const requesterEmail = await ticketProvider.getRequesterEmail(event.requesterId).catch(() => null);
  const notifyArgs = { ticketProvider, ticketId, email: requesterEmail };

  if (command === 'help') {
    await notify(notifyArgs, HELP_COMMENT);
    return;
  }

  if (command === 'status') {
    const context = await ticketProvider.getTicketContext(ticketId);
    const found = ticketProvider.findMostRecentAgent(context);
    if (!found) {
      await notify(notifyArgs, `⚠️ No previous agent found on this ticket.${sign('sad')}`);
      return;
    }
    let agentProvider;
    try {
      agentProvider = getAgentProvider(found.agentProviderId);
    } catch (err) {
      await notify(notifyArgs, `⚠️ ${escapeHtml(err.message)}${sign('sad')}`);
      return;
    }
    await postAgentResult({
      ticketProvider,
      agentProvider,
      ticketId,
      agentId: found.agentId,
      mode: found.mode,
      force: true,
      notifyEmail: requesterEmail,
    });
    return;
  }

  const mode = MODES[command];
  if (!mode) {
    await notify(notifyArgs, `🐕 I don't know <code>${escapeHtml(command)}</code>. Try <code>!set help</code>.${sign('sad')}`);
    return;
  }

  let agentProvider;
  try {
    agentProvider = flags.agent ? getAgentProvider(flags.agent) : getDefaultAgentProvider();
  } catch (err) {
    await notify(notifyArgs, `⚠️ ${escapeHtml(err.message)}${sign('sad')}`);
    return;
  }

  const context = await ticketProvider.getTicketContext(ticketId);
  const repo = context?.repoUrl;
  if (!repo) {
    await notify(notifyArgs, MISSING_REPO);
    return;
  }
  const itemName = context?.title ?? event.ticketName ?? '(unknown)';
  const contextBlock = context?.contextBlock ?? '';

  // Resolve the ticket ref once and thread it through. notify() and the
  // links line in handleSyncLaunch / agent announcement both reuse it.
  notifyArgs.ref = await resolveRef(ticketProvider, ticketId).catch(() => null);

  await notify(
    notifyArgs,
    `${mode.emoji} ${mode.ackVerb} (<code>${agentProvider.id}</code>) against <a href="${escapeHtml(repo)}">${escapeHtml(repo)}</a>. I'll post the agent link once it spins up.${sign()}`
  );

  const callbackUrl = host
    ? `https://${host}/api/agents/${agentProvider.id}/callback` +
      `?ticket=${encodeURIComponent(ticketProvider.id)}:${encodeURIComponent(ticketId)}` +
      `&mode=${mode.label}` +
      (event.requesterId ? `&requester=${encodeURIComponent(event.requesterId)}` : '')
    : null;
  const prompt = mode.buildPrompt({ itemName, repo, contextBlock });

  try {
    const launch = await agentProvider.launchAgent({
      prompt,
      repoUrl: repo,
      callbackUrl,
      mode: mode.label,
    });

    if (agentProvider.kind === 'sync') {
      await handleSyncLaunch({ launch, mode, agentProvider, notifyArgs });
      return;
    }

    const liveUrl = launch.liveUrl ?? '';
    const agentMarker = launch.agentId ? `<br><sub>agent:${agentProvider.id}:${launch.agentId}</sub>` : '';
    await notify(
      notifyArgs,
      `🚀 ${capitalize(mode.label)} agent is running.<br>` +
      (liveUrl ? `Live progress: <a href="${escapeHtml(liveUrl)}">${escapeHtml(liveUrl)}</a>` : 'Live progress link not available.') +
      agentMarker +
      sign('happy')
    );
    console.log(`[set-bot] Launched ${agentProvider.id} ${mode.label} agent ${launch.agentId} for ${ticketProvider.id}:${ticketId}`);
  } catch (err) {
    console.error(`[set-bot] ${agentProvider.id} ${mode.label} launch failed:`, err);
    const isTimeout = err?.name === 'AbortError' || /aborted|timeout/i.test(err?.message ?? '');
    if (isTimeout) {
      await notify(
        notifyArgs,
        `⏳ ${capitalize(mode.label)} agent was submitted, but the provider didn't respond in time. It's almost certainly running. I'll post the result automatically when it finishes, or reply <code>!set status</code> for an update.${sign()}`
      );
    } else {
      await notify(
        notifyArgs,
        `❌ Couldn't launch the ${mode.label} agent: <code>${escapeHtml(err.message ?? String(err))}</code>${sign('angry')}`
      );
    }
  }
}

async function handleSyncLaunch({ launch, mode, agentProvider, notifyArgs }) {
  const result = launch.sync;
  const linksLine = buildLinksLine({
    ref: notifyArgs.ref,
    agentProvider,
    agentId: launch.agentId,
    liveUrl: launch.liveUrl,
  });

  if (result.status === 'failed') {
    await notify(
      notifyArgs,
      `❌ ${capitalize(mode.label)} agent (<code>${agentProvider.id}</code>) failed: <code>${escapeHtml(result.statusRaw ?? 'error')}</code>${linksLine}${sign('angry')}`
    );
    return;
  }

  const trimmed = (result.text ?? '').length > 6000
    ? result.text.slice(0, 6000) + '\n…(truncated)'
    : (result.text ?? '');
  const html = escapeHtml(trimmed).replace(/\n/g, '<br>');
  await notify(
    notifyArgs,
    `✅ <b>${capitalize(mode.label)} complete</b> (<code>${agentProvider.id}</code>)${linksLine}<br><br>${html}${sign('happy')}`
  );
}

function parseFlags(rest) {
  const flags = {};
  const re = /--(\w+)(?:=([\w-]+))?/g;
  let m;
  while ((m = re.exec(rest)) !== null) {
    flags[m[1].toLowerCase()] = m[2] ?? true;
  }
  return flags;
}

function capitalize(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}
