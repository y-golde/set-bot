// Cursor Background Agents API client.
// Docs: https://docs.cursor.com/background-agent (verify exact request/response
// shape against current docs — API is young and may shift).

const CURSOR_API_URL = 'https://api.cursor.com/v0';

async function cursorFetch(path, init = {}, { timeoutMs = 20000 } = {}) {
  const key = process.env.CURSOR_API_KEY;
  if (!key) throw new Error('CURSOR_API_KEY is not set');

  // Cursor's POST /agents can hang for a long time. Use AbortController so
  // we don't sit on the full 60s Vercel function budget waiting for a
  // response that may never come.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${CURSOR_API_URL}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`,
        ...(init.headers ?? {}),
      },
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Cursor API HTTP ${res.status}: ${text}`);
    }
    return text ? JSON.parse(text) : {};
  } finally {
    clearTimeout(timer);
  }
}

export async function launchAgent({
  prompt,
  repository,
  ref = 'main',
  webhookUrl,
  model,
}) {
  const body = {
    prompt: { text: prompt },
    source: { repository, ref },
    ...(model ? { model } : {}),
    ...(webhookUrl ? { webhook: { url: webhookUrl } } : {}),
  };
  return cursorFetch('/agents', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function getAgent(agentId) {
  return cursorFetch(`/agents/${agentId}`);
}

export async function getAgentConversation(agentId) {
  return cursorFetch(`/agents/${agentId}/conversation`);
}
