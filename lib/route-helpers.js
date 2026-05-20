import { waitUntil } from '@vercel/functions';
import { handleEvent } from './dispatch.js';
import { getTicketProvider } from './providers/tickets/index.js';
import { getAgentProvider } from './providers/agents/index.js';
import { postAgentResult } from './result.js';

// Generic POST handler for a ticket-webhook route. Each api/tickets/<id>/
// webhook.js calls this with its provider id.
export async function handleTicketWebhook(req, res, providerId) {
  if (req.method === 'GET') {
    return res.status(200).json({ ok: true, service: `set-bot-${providerId}-webhook` });
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const provider = getTicketProvider(providerId);
  const parsed = provider.verifyAndParse(req);

  if (parsed.kind === 'unauthorized') {
    return res.status(401).json({ error: parsed.message });
  }
  if (parsed.kind === 'bad_request') {
    console.error(`[set-bot] ${providerId} bad request: ${parsed.message}`);
    return res.status(200).json({ ok: true });
  }
  if (parsed.kind === 'challenge') {
    return res.status(200).json(parsed.response);
  }

  if (!parsed.event) {
    return res.status(200).json({ ok: true });
  }

  const host = req.headers.host;
  waitUntil(
    handleEvent({ event: parsed.event, ticketProvider: provider, host }).catch((err) => {
      console.error(`[set-bot] ${providerId} processing error:`, err);
    })
  );

  return res.status(200).json({ ok: true });
}

// Generic POST handler for an agent-callback route. The launching dispatcher
// encoded the originating ticket as `?ticket=<providerId>:<ticketId>`.
export async function handleAgentCallback(req, res, providerId) {
  if (req.method === 'GET') {
    return res.status(200).json({ ok: true, service: `set-bot-${providerId}-callback` });
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const agentProvider = getAgentProvider(providerId);
  if (agentProvider.kind === 'sync') {
    // Sync providers shouldn't be calling back. Ignore politely.
    return res.status(200).json({ ok: true, warning: 'sync provider — callback ignored' });
  }

  const ticketRef = String(req.query.ticket ?? '');
  const [ticketProviderId, ticketId] = ticketRef.split(':');
  if (!ticketProviderId || !ticketId) {
    return res.status(200).json({ ok: true, warning: 'missing ticket reference' });
  }

  let ticketProvider;
  try {
    ticketProvider = getTicketProvider(ticketProviderId);
  } catch (err) {
    console.error(`[set-bot] ${providerId} callback: unknown ticket provider`, err);
    return res.status(200).json({ ok: true });
  }

  const parsed = agentProvider.parseCallback(req);
  if (!parsed) {
    return res.status(200).json({ ok: true, warning: 'missing agentId' });
  }

  const mode = req.query.mode === 'implement' ? 'implement' : 'research';
  const requesterId = req.query.requester ?? null;

  console.log(`[${providerId}-callback] ticket=${ticketProviderId}:${ticketId} agent=${parsed.agentId} mode=${mode} status=${parsed.status} terminal=${parsed.terminal}`);

  waitUntil(
    (async () => {
      const notifyEmail = requesterId ? await ticketProvider.getRequesterEmail(requesterId).catch(() => null) : null;
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
        await maybeAnnounceAgent({
          ticketProvider,
          agentProvider,
          ticketId,
          agentId: parsed.agentId,
          mode,
          raw: parsed.raw,
          notifyEmail,
        });
      }
    })().catch((err) => console.error(`[${providerId}-callback] processing failed:`, err))
  );

  return res.status(200).json({ ok: true });
}

async function maybeAnnounceAgent({ ticketProvider, agentProvider, ticketId, agentId, mode, raw, notifyEmail }) {
  const liveUrl =
    raw?.target?.url ??
    raw?.url ??
    null;

  const context = await ticketProvider.getTicketContext(ticketId);
  const haystack = JSON.stringify(context?.history ?? '');
  if (haystack.includes(agentId)) {
    console.log(`[${agentProvider.id}-callback] agent ${agentId} already announced on ${ticketProvider.id}:${ticketId}`);
    return;
  }

  const label = mode === 'implement' ? 'Implementation' : 'Research';
  const { notify } = await import('./notify.js');
  const { escapeHtml } = await import('./monday.js');
  await notify(
    { ticketProvider, ticketId, email: notifyEmail },
    `🚀 ${label} agent is running.` +
    (liveUrl ? `<br>Live progress: <a href="${escapeHtml(liveUrl)}">${escapeHtml(liveUrl)}</a>` : '') +
    `<br><sub>agent:${agentProvider.id}:${agentId}</sub> 🐕 bark!`
  );
  console.log(`[${agentProvider.id}-callback] Announced agent ${agentId} on ${ticketProvider.id}:${ticketId}`);
}
