import { postUpdate, escapeHtml } from './monday.js';
import { getAgent, getAgentConversation } from './cursor.js';

const TERMINAL_OK = new Set(['completed', 'finished', 'succeeded', 'success', 'done']);
const TERMINAL_FAIL = new Set(['failed', 'errored', 'error', 'cancelled', 'canceled', 'timeout', 'timed_out']);

// Fetch the agent's final state and post a result comment on the monday item.
// `mode` is "research" | "implement" | null (null = auto-label as "Agent").
// `force=true` posts even if the agent is still running (used by /status command).
export async function postAgentResult({ itemId, agentId, mode = null, force = false }) {
  const label =
    mode === 'implement' ? 'Implementation' :
    mode === 'research' ? 'Research' :
    'Agent';

  let agentRecord = null;
  try {
    agentRecord = await getAgent(agentId);
  } catch (e) {
    console.error('[result] Failed to fetch agent:', e);
  }

  const status = String(agentRecord?.status ?? '').toLowerCase();
  const failed = TERMINAL_FAIL.has(status);
  const done = TERMINAL_OK.has(status);

  if (!done && !failed && !force) {
    return { posted: false, reason: 'agent still running' };
  }

  if (failed) {
    await postUpdate(
      itemId,
      `❌ ${label} agent ended with status <b>${escapeHtml(status || 'unknown')}</b>. Check the Cursor agent page for details.`
    );
    return { posted: true, status };
  }

  // Pull the agent's final message
  let resultText = '';
  try {
    const convo = await getAgentConversation(agentId);
    const messages = convo?.messages ?? convo ?? [];
    const last = [...messages].reverse().find((m) => (m.role ?? m.author) !== 'user');
    resultText = last?.text ?? last?.content ?? '';
  } catch (e) {
    console.error('[result] Failed to fetch conversation:', e);
  }
  if (!resultText) {
    resultText = agentRecord?.summary ?? agentRecord?.result ?? '(agent finished but produced no text)';
  }

  const prUrl = findPrUrl(agentRecord, resultText);
  const prBlock = prUrl
    ? `<br><br>📦 Pull request: <a href="${escapeHtml(prUrl)}">${escapeHtml(prUrl)}</a>`
    : '';

  const statusBanner = done
    ? `✅ <b>${label} complete</b>`
    : `🔄 <b>${label} status: ${escapeHtml(status || 'unknown')}</b>`;

  const trimmed = resultText.length > 6000 ? resultText.slice(0, 6000) + '\n…(truncated)' : resultText;
  const html = escapeHtml(trimmed).replace(/\n/g, '<br>');
  await postUpdate(itemId, `${statusBanner}${prBlock}<br><br>${html}`);
  return { posted: true, status, prUrl };
}

function findPrUrl(agent, text) {
  const direct =
    agent?.pullRequest?.url ??
    agent?.pull_request?.url ??
    agent?.prUrl ??
    agent?.pr_url ??
    null;
  if (direct) return direct;
  const haystack = JSON.stringify(agent ?? {}) + '\n' + (text ?? '');
  const m = haystack.match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/);
  return m ? m[0] : null;
}

// Look through an item's update history (newest first) for the most recent
// Cursor agent URL the bot posted, return { agentId, mode }.
export function findMostRecentAgent(item) {
  const updates = item?.updates ?? [];
  for (const u of updates) {
    const text = u.text_body ?? '';
    const m = text.match(/cursor\.com\/agents\/([\w-]+)/);
    if (m) {
      const mode = /implement/i.test(text) ? 'implement'
                 : /research/i.test(text) ? 'research'
                 : null;
      return { agentId: m[1], mode };
    }
    for (const r of (u.replies ?? [])) {
      const rt = r.text_body ?? '';
      const rm = rt.match(/cursor\.com\/agents\/([\w-]+)/);
      if (rm) {
        const mode = /implement/i.test(rt) ? 'implement'
                   : /research/i.test(rt) ? 'research'
                   : null;
        return { agentId: rm[1], mode };
      }
    }
  }
  return null;
}
