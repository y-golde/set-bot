// Cursor AgentProvider — wraps lib/cursor.js. Deferred: launchAgent returns
// immediately, Cursor posts to the callback URL when status changes.

import { launchAgent as cursorLaunch, getAgent, getAgentConversation } from '../../cursor.js';

export const id = 'cursor';
export const kind = 'deferred';

const TERMINAL_OK = new Set(['completed', 'finished', 'succeeded', 'success', 'done']);
const TERMINAL_FAIL = new Set(['failed', 'errored', 'error', 'cancelled', 'canceled', 'timeout', 'timed_out']);

export async function launchAgent({ prompt, repoUrl, callbackUrl }) {
  const agent = await cursorLaunch({
    prompt,
    repository: repoUrl,
    webhookUrl: callbackUrl,
    model: process.env.CURSOR_MODEL || 'composer-2.5-fast',
  });
  const agentId = agent?.id ?? agent?.agentId;
  const liveUrl = agent?.target?.url ?? agent?.url ?? (agentId ? `https://cursor.com/agents/${agentId}` : null);
  return { agentId, liveUrl, raw: agent };
}

export function parseCallback(req) {
  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch {
    body = {};
  }
  const agentId = body?.id ?? body?.agentId ?? body?.agent?.id;
  if (!agentId) return null;

  const statusRaw = String(body?.status ?? body?.agent?.status ?? '').toLowerCase();
  const terminal = TERMINAL_OK.has(statusRaw) || TERMINAL_FAIL.has(statusRaw);
  return { agentId, status: statusRaw, terminal, raw: body };
}

export async function getResult(agentId, { rawCallback = null } = {}) {
  let agent = null;
  try {
    agent = await getAgent(agentId);
  } catch (e) {
    console.error('[cursor-provider] getAgent failed:', e);
  }

  const statusRaw = String(agent?.status ?? '').toLowerCase();
  const liveUrl =
    agent?.target?.url ?? agent?.url ?? `https://cursor.com/agents/${agentId}`;

  if (TERMINAL_FAIL.has(statusRaw)) {
    return { status: 'failed', statusRaw, text: '', prUrl: null, liveUrl };
  }
  const done = TERMINAL_OK.has(statusRaw);

  let text = '';
  try {
    const convo = await getAgentConversation(agentId);
    const messages = convo?.messages ?? convo ?? [];
    const last = [...messages].reverse().find((m) => (m.role ?? m.author) !== 'user');
    text = last?.text ?? last?.content ?? '';
  } catch (e) {
    console.error('[cursor-provider] getAgentConversation failed:', e);
  }
  if (!text) {
    text = agent?.summary ?? agent?.result ?? '';
  }

  return {
    status: done ? 'ok' : 'running',
    statusRaw: statusRaw || 'unknown',
    text,
    prUrl: findPrUrl(agent, text, rawCallback),
    liveUrl,
  };
}

function findPrUrl(agent, text, raw) {
  const direct =
    raw?.target?.prUrl ??
    raw?.target?.pullRequest?.url ??
    raw?.prUrl ??
    agent?.target?.prUrl ??
    agent?.pullRequest?.url ??
    agent?.pull_request?.url ??
    agent?.prUrl ??
    agent?.pr_url ??
    null;
  if (direct) return direct;
  const haystack = JSON.stringify(agent ?? {}) + '\n' + JSON.stringify(raw ?? {}) + '\n' + (text ?? '');
  const m = haystack.match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/);
  return m ? m[0] : null;
}
