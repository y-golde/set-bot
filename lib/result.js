import { escapeHtml } from './monday.js';
import { notify } from './notify.js';

// Fetch the agent's final state via the AgentProvider and post a result
// comment on the ticket. `mode` is "research" | "implement" | null (null =
// auto-label as "Agent"). `force=true` posts even if the agent is still
// running (used by !set status).
export async function postAgentResult({
  ticketProvider,
  agentProvider,
  ticketId,
  agentId,
  mode = null,
  force = false,
  webhookBody = null,
  notifyEmail = null,
}) {
  const label =
    mode === 'implement' ? 'Implementation' :
    mode === 'research' ? 'Research' :
    'Agent';

  // Resolve the ticket ref once and pass it through to notify so the Slack
  // header and the result-message links use the same title/URL without a
  // second API call.
  const ref = typeof ticketProvider.getTicketRef === 'function'
    ? await ticketProvider.getTicketRef(ticketId).catch(() => null)
    : null;
  const notifyArgs = { ticketProvider, ticketId, email: notifyEmail, ref };

  let result;
  try {
    result = await agentProvider.getResult(agentId, { rawCallback: webhookBody });
  } catch (err) {
    console.error('[result] getResult failed:', err);
    await notify(notifyArgs, `⚠️ Couldn't fetch ${label} agent state: <code>${escapeHtml(err.message ?? String(err))}</code> grrr 🐶`);
    return { posted: true, status: 'error' };
  }

  if (result.status === 'running' && !force) {
    return { posted: false, reason: 'agent still running' };
  }

  const linksLine = buildLinksLine({ ref, agentProvider, agentId, liveUrl: result.liveUrl });

  if (result.status === 'failed') {
    const failText = result.text ? `<br><br>${escapeHtml(result.text).replace(/\n/g, '<br>')}` : '';
    await notify(
      notifyArgs,
      `❌ ${label} agent ended with status <b>${escapeHtml(result.statusRaw || 'unknown')}</b>.${linksLine}${failText} grrr 🐶`
    );
    return { posted: true, status: result.statusRaw };
  }

  const prBlock = result.prUrl
    ? `<br>📦 Pull request: <a href="${escapeHtml(result.prUrl)}">${escapeHtml(result.prUrl)}</a>`
    : '';

  const statusBanner = result.status === 'ok'
    ? `✅ <b>${label} complete</b> 🐕 woof!`
    : `🔄 <b>${label} status: ${escapeHtml(result.statusRaw || 'unknown')}</b>`;

  const text = result.text || '(agent finished but produced no text)';
  const trimmed = text.length > 6000 ? text.slice(0, 6000) + '\n…(truncated)' : text;
  const html = escapeHtml(trimmed).replace(/\n/g, '<br>');
  await notify(notifyArgs, `${statusBanner}${linksLine}${prBlock}<br><br>${html}`);
  return { posted: true, status: result.statusRaw, prUrl: result.prUrl };
}

// Build a "📎 Ticket · 🤖 Agent" line for the result comment. Links are
// dropped when their URL isn't known (e.g. Anthropic sync runs have no
// live URL). Returns "" if neither link is available.
export function buildLinksLine({ ref, agentProvider, agentId, liveUrl }) {
  const parts = [];
  if (ref?.url) {
    parts.push(`📎 <a href="${escapeHtml(ref.url)}">${escapeHtml(ref.title || 'ticket')}</a>`);
  }
  if (liveUrl) {
    const providerLabel = agentProvider?.id ? capitalize(agentProvider.id) : 'Agent';
    parts.push(`🤖 <a href="${escapeHtml(liveUrl)}">${escapeHtml(providerLabel)} agent</a>`);
  } else if (agentId && agentProvider?.id) {
    parts.push(`🤖 <code>${escapeHtml(agentProvider.id)}:${escapeHtml(agentId)}</code>`);
  }
  return parts.length ? `<br>${parts.join('  ·  ')}` : '';
}

function capitalize(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}
