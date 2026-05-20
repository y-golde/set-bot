import { handleAgentCallback } from '../../../lib/route-helpers.js';

export default function handler(req, res) {
  return handleAgentCallback(req, res, 'cursor');
}
