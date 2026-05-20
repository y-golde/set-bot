// AgentProvider contract.
//
// An AgentProvider executes work: it launches a coding agent, parses the
// callback when one fires, and reads back the agent's result. Providers
// come in two flavours:
//   - "deferred": launchAgent returns immediately; the agent runs out of
//     band and POSTs to callbackUrl when its status changes. (Cursor.)
//   - "sync": launchAgent runs the work inline and returns the finished
//     result. No callback ever fires. (Anthropic, in this codebase.)
//
// Every provider module exports an object with this shape:
//
//   {
//     id: 'cursor',                            // string, stable, used in URLs/logs
//     kind: 'deferred' | 'sync',
//     launchAgent({ prompt, repoUrl, callbackUrl, mode }) → Promise<{
//       agentId: string,                       // provider-local id
//       liveUrl?: string,                      // URL the user can open mid-run
//       sync?: { status, text, prUrl? },       // populated when kind === 'sync'
//     }>,
//     parseCallback?(req) → {                  // only for deferred providers
//       agentId, status, terminal: boolean, raw,
//     } | null,
//     getResult(agentId, { rawCallback? }) → Promise<{
//       status: 'ok' | 'failed' | 'running',
//       statusRaw: string,
//       text: string,
//       prUrl: string | null,
//     }>,
//   }

import * as cursor from './cursor.js';
import * as anthropic from './anthropic.js';

const REGISTRY = {
  [cursor.id]: cursor,
  [anthropic.id]: anthropic,
};

export function getAgentProvider(id) {
  const provider = REGISTRY[id];
  if (!provider) {
    throw new Error(`Unknown agent provider: ${id}. Known: ${Object.keys(REGISTRY).join(', ')}`);
  }
  return provider;
}

export function listAgentProviders() {
  return Object.keys(REGISTRY);
}

// Pick the default agent provider for new runs. Env-overridable.
export function getDefaultAgentProvider() {
  const id = process.env.AGENT_PROVIDER || 'cursor';
  return getAgentProvider(id);
}
