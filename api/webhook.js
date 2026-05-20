// Back-compat shim. The original webhook URL was /api/webhook (Monday-only);
// the bot is now multi-provider and routes live at /api/tickets/<id>/webhook.
// Forwarding here so existing Monday webhook configurations keep working.

import { handleTicketWebhook } from '../lib/route-helpers.js';

export default function handler(req, res) {
  return handleTicketWebhook(req, res, 'monday');
}
