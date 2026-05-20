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
  const notifyArgs = { ticketProvider, ticketId, email: notifyEmail };

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

  if (result.status === 'failed') {
    await notify(
      notifyArgs,
      `❌ ${label} agent ended with status <b>${escapeHtml(result.statusRaw || 'unknown')}</b>. ${result.text ? escapeHtml(result.text).replace(/\n/g, '<br>') : 'Check the agent page for details.'} grrr 🐶`
    );
    return { posted: true, status: result.statusRaw };
  }

  const prBlock = result.prUrl
    ? `<br><br>📦 Pull request: <a href="${escapeHtml(result.prUrl)}">${escapeHtml(result.prUrl)}</a>`
    : '';

  const statusBanner = result.status === 'ok'
    ? `✅ <b>${label} complete</b> 🐕 woof!`
    : `🔄 <b>${label} status: ${escapeHtml(result.statusRaw || 'unknown')}</b>`;

  const text = result.text || '(agent finished but produced no text)';
  const trimmed = text.length > 6000 ? text.slice(0, 6000) + '\n…(truncated)' : text;
  const html = escapeHtml(trimmed).replace(/\n/g, '<br>');
  await notify(notifyArgs, `${statusBanner}${prBlock}<br><br>${html}`);
  return { posted: true, status: result.statusRaw, prUrl: result.prUrl };
}
