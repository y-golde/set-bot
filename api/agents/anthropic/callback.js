import { handleAgentCallback } from '../../../lib/route-helpers.js';

// Anthropic is a sync provider — it doesn't fire callbacks. This route exists
// for URL symmetry with deferred providers and politely no-ops if hit.
export default function handler(req, res) {
  return handleAgentCallback(req, res, 'anthropic');
}
