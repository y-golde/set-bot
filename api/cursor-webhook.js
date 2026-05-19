import { waitUntil } from '@vercel/functions';
import { postAgentResult } from '../lib/result.js';
import { postUpdate, escapeHtml, getItemContext } from '../lib/monday.js';

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

  console.log(`[cursor-webhook] item=${itemId} agent=${agentId} mode=${mode} body=${JSON.stringify(body).slice(0, 500)}`);

  if (!itemId || !agentId) {
    return res.status(200).json({ ok: true, warning: 'missing itemId or agentId' });
  }

  const status = String(body?.status ?? body?.agent?.status ?? '').toLowerCase();
  const terminalOk = ['completed', 'finished', 'succeeded', 'success', 'done'].includes(status);
  const terminalFail = ['failed', 'errored', 'error', 'cancelled', 'canceled', 'timeout', 'timed_out'].includes(status);
  const isTerminal = terminalOk || terminalFail;

  waitUntil(
    (async () => {
      if (isTerminal) {
        await postAgentResult({ itemId, agentId, mode, webhookBody: body });
      } else {
        // First non-terminal event we receive — post the agent URL once.
        await maybePostAgentUrl({ itemId, agentId, mode, webhookBody: body });
      }
    })().catch((err) => console.error('[cursor-webhook] processing failed:', err))
  );

  return res.status(200).json({ ok: true });
}

async function maybePostAgentUrl({ itemId, agentId, mode, webhookBody }) {
  const agentUrl =
    webhookBody?.target?.url ??
    webhookBody?.url ??
    `https://cursor.com/agents/${agentId}`;

  // Dedup: if we already posted this agent's URL on the ticket, skip.
  const item = await getItemContext(itemId);
  const haystack = JSON.stringify(item?.updates ?? '');
  if (haystack.includes(agentId)) {
    console.log(`[cursor-webhook] agent ${agentId} already announced on item ${itemId}`);
    return;
  }

  const label = mode === 'implement' ? 'Implementation' : 'Research';
  await postUpdate(
    itemId,
    `🚀 ${label} agent is running.<br>Live progress: <a href="${escapeHtml(agentUrl)}">${escapeHtml(agentUrl)}</a>`
  );
  console.log(`[cursor-webhook] Announced agent ${agentId} on item ${itemId}`);
}
