import { postUpdate, escapeHtml } from '../lib/monday.js';
import { getAgent, getAgentConversation } from '../lib/cursor.js';

// Cursor calls this when a background agent finishes.
// We expect ?itemId=<monday item id> on the query string (set when we launched it).
export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({ ok: true, service: 'monday-bot-cursor-callback' });
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const itemId = req.query.itemId;
    const agentId = body?.id ?? body?.agentId ?? body?.agent?.id;
    const status = body?.status ?? body?.agent?.status;

    console.log(`[cursor-webhook] item=${itemId} agent=${agentId} status=${status}`);

    if (!itemId || !agentId) {
      return res.status(200).json({ ok: true, warning: 'missing itemId or agentId' });
    }

    // Only act on terminal states
    const done = ['completed', 'finished', 'succeeded', 'success'].includes(String(status).toLowerCase());
    const failed = ['failed', 'errored', 'error', 'cancelled', 'canceled'].includes(String(status).toLowerCase());

    if (!done && !failed) {
      return res.status(200).json({ ok: true, ignored: 'non-terminal status' });
    }

    if (failed) {
      await postUpdate(itemId, `❌ Research agent ended with status <b>${escapeHtml(status)}</b>. Check the Cursor agent page for details.`);
      return res.status(200).json({ ok: true });
    }

    // Pull the agent's final message(s) and post as a comment
    let resultText = '';
    try {
      const convo = await getAgentConversation(agentId);
      const messages = convo?.messages ?? convo ?? [];
      // Take the last assistant/agent message text
      const last = [...messages].reverse().find((m) => (m.role ?? m.author) !== 'user');
      resultText = last?.text ?? last?.content ?? '';
    } catch (e) {
      console.error('[cursor-webhook] Failed to fetch conversation:', e);
    }

    if (!resultText) {
      // Fall back to the agent record's summary field if available
      try {
        const a = await getAgent(agentId);
        resultText = a?.summary ?? a?.result ?? '(agent finished but produced no text)';
      } catch {
        resultText = '(agent finished but produced no text)';
      }
    }

    const trimmed = resultText.length > 6000 ? resultText.slice(0, 6000) + '\n…(truncated)' : resultText;
    const html = escapeHtml(trimmed).replace(/\n/g, '<br>');
    await postUpdate(itemId, `✅ <b>Research complete</b><br><br>${html}`);

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[cursor-webhook] Error:', err);
    return res.status(200).json({ ok: true, warning: 'internal error logged' });
  }
}
