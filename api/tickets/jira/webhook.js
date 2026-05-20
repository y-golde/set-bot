import { handleTicketWebhook } from '../../../lib/route-helpers.js';

export default function handler(req, res) {
  return handleTicketWebhook(req, res, 'jira');
}
