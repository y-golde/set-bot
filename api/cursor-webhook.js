import { waitUntil } from '@vercel/functions';
import { postUpdate, escapeHtml } from '../lib/monday.js';
import { getAgent, getAgentConversation } from '../lib/cursor.js';

// Cursor calls this when a background agent finishes.
// Query string from the launch URL carries:
//   ?itemId=<monday item id>&mode=<research|implement>
export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({ ok: true, service: 'monday-bot-cursor-callback' });
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch {
    body = {};
  }

  const itemId = req.query.itemId;
  const mode = (req.query.mode === 'implement') ? 'implement' : 'research';
  const agentId = body?.id ?? body?.agentId ?? body?.agent?.id;
  const status = body?.status ?? body?.agent?.status;

  console.log(`[cursor-webhook] item=${itemId} agent=${agentId} mode=${mode} status=${status}`);

  if (!itemId || !agentId) {
    return res.status(200).json({ ok: true, warning: 'missing itemId or agentId' });
  }

  const s = String(status ?? '').toLowerCase();
  const done = ['completed', 'finished', 'succeeded', 'success'].includes(s);
  const failed = ['failed', 'errored', 'error', 'cancelled', 'canceled'].includes(s);
  if (!done && !failed) {
    return res.status(200).json({ ok: true, ignored: 'non-terminal status' });
  }

  // Respond immediately, post the result comment in the background.
  waitUntil(
    postResultComment({ itemId, agentId, mode, status, failed, body }).catch((err) =>
      console.error('[cursor-webhook] post-result failed:', err)
    )
  );

  return res.status(200).json({ ok: true });
}

async function postResultComment({ itemId, agentId, mode, status, failed, body }) {
  const label = mode === 'implement' ? 'Implementation' : 'Research';

  if (failed) {
    await postUpdate(
      itemId,
      `❌ ${label} agent ended with status <b>${escapeHtml(status)}</b>. Check the Cursor agent page for details.`
    );
    return;
  }

  // Pull the agent's final message
  let resultText = '';
  try {
    const convo = await getAgentConversation(agentId);
    const messages = convo?.messages ?? convo ?? [];
    const last = [...messages].reverse().find((m) => (m.role ?? m.author) !== 'user');
    resultText = last?.text ?? last?.content ?? '';
  } catch (e) {
    console.error('[cursor-webhook] Failed to fetch conversation:', e);
  }

  // Fetch the agent record — used for fallback summary AND PR link extraction
  let agentRecord = null;
  try {
    agentRecord = await getAgent(agentId);
  } catch (e) {
    console.error('[cursor-webhook] Failed to fetch agent:', e);
  }

  if (!resultText) {
    resultText = agentRecord?.summary ?? agentRecord?.result ?? '(agent finished but produced no text)';
  }

  // For implement mode, surface the PR link if Cursor created one.
  let prBlock = '';
  if (mode === 'implement') {
    const prUrl = findPrUrl(agentRecord, body, resultText);
    if (prUrl) {
      prBlock = `<br><br>📦 Pull request: <a href="${escapeHtml(prUrl)}">${escapeHtml(prUrl)}</a>`;
    }
  }

  const trimmed = resultText.length > 6000 ? resultText.slice(0, 6000) + '\n…(truncated)' : resultText;
  const html = escapeHtml(trimmed).replace(/\n/g, '<br>');
  await postUpdate(itemId, `✅ <b>${label} complete</b>${prBlock}<br><br>${html}`);
}

// Best-effort PR URL extraction — Cursor's response shape isn't fully
// documented, so check the obvious places and fall back to a regex over
// any text we have.
function findPrUrl(agent, webhookBody, text) {
  const direct =
    agent?.pullRequest?.url ??
    agent?.pull_request?.url ??
    agent?.prUrl ??
    agent?.pr_url ??
    webhookBody?.pullRequest?.url ??
    webhookBody?.pull_request?.url ??
    webhookBody?.prUrl ??
    null;
  if (direct) return direct;

  const haystack = [
    JSON.stringify(agent ?? {}),
    JSON.stringify(webhookBody ?? {}),
    text ?? '',
  ].join('\n');
  const m = haystack.match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/);
  return m ? m[0] : null;
}
