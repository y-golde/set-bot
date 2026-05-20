// Back-compat shim. Cursor callbacks now live at /api/agents/cursor/callback.
// Existing in-flight agents launched against the old URL still land here.

import { waitUntil } from '@vercel/functions';
import { getAgentProvider } from '../lib/providers/agents/index.js';
import { getTicketProvider } from '../lib/providers/tickets/index.js';
import { postAgentResult } from '../lib/result.js';
import { notify } from '../lib/notify.js';
import { escapeHtml } from '../lib/monday.js';

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({ ok: true, service: 'set-bot-cursor-callback-legacy' });
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const ticketId = req.query.itemId;
  const mode = req.query.mode === 'implement' ? 'implement' : 'research';
  const userId = req.query.userId ?? null;
  if (!ticketId) {
    return res.status(200).json({ ok: true, warning: 'missing itemId' });
  }

  const agentProvider = getAgentProvider('cursor');
  const ticketProvider = getTicketProvider('monday');
  const parsed = agentProvider.parseCallback(req);
  if (!parsed) {
    return res.status(200).json({ ok: true, warning: 'missing agentId' });
  }

  waitUntil(
    (async () => {
      const notifyEmail = userId ? await ticketProvider.getRequesterEmail(userId).catch(() => null) : null;
      if (parsed.terminal) {
        await postAgentResult({
          ticketProvider,
          agentProvider,
          ticketId,
          agentId: parsed.agentId,
          mode,
          webhookBody: parsed.raw,
          notifyEmail,
        });
      } else {
        const liveUrl = parsed.raw?.target?.url ?? parsed.raw?.url ?? `https://cursor.com/agents/${parsed.agentId}`;
        const context = await ticketProvider.getTicketContext(ticketId);
        const haystack = JSON.stringify(context?.history ?? '');
        if (haystack.includes(parsed.agentId)) return;
        const label = mode === 'implement' ? 'Implementation' : 'Research';
        await notify(
          { ticketProvider, ticketId, email: notifyEmail },
          `🚀 ${label} agent is running.<br>Live progress: <a href="${escapeHtml(liveUrl)}">${escapeHtml(liveUrl)}</a><br><sub>agent:cursor:${parsed.agentId}</sub> 🐕 bark!`
        );
      }
    })().catch((err) => console.error('[cursor-webhook-legacy] processing failed:', err))
  );

  return res.status(200).json({ ok: true });
}
