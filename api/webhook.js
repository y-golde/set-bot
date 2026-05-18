import { postUpdate, escapeHtml } from '../lib/monday.js';

export default async function handler(req, res) {
  // Browser sanity check
  if (req.method === 'GET') {
    return res.status(200).json({ ok: true, service: 'monday-bot' });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Optional shared-secret guard via ?secret= query param
  const secret = process.env.WEBHOOK_SHARED_SECRET;
  if (secret && req.query.secret !== secret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;

    // monday.com webhook verification handshake
    if (body?.challenge) {
      return res.status(200).json({ challenge: body.challenge });
    }

    const event = body?.event;

    if (event?.type === 'create_pulse') {
      const itemId = String(event.pulseId);
      const itemName = escapeHtml(event.pulseName ?? 'this item');
      const comment = `Hey team 👋 — quick triage on <b>${itemName}</b>: should this be <b>research</b> or <b>implement</b>?`;

      await postUpdate(itemId, comment);
      console.log(`[monday-bot] Posted triage comment on item ${itemId}`);
    } else {
      console.log(`[monday-bot] Ignoring event type: ${event?.type ?? 'unknown'}`);
    }

    // Always 200 — monday retries on anything else, causing storms
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[monday-bot] Error handling webhook:', err);
    // Still 200 to prevent monday retry storms
    return res.status(200).json({ ok: true, warning: 'internal error logged' });
  }
}
