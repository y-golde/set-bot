import { waitUntil } from '@vercel/functions';
import { postAgentResult } from '../lib/result.js';

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

  waitUntil(
    postAgentResult({ itemId, agentId, mode, webhookBody: body }).catch((err) =>
      console.error('[cursor-webhook] post-result failed:', err)
    )
  );

  return res.status(200).json({ ok: true });
}
