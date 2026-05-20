// Minimal Anthropic Messages API client — just what we need to send a
// single-turn prompt and read the model's reply text.
// Docs: https://docs.anthropic.com/en/api/messages

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';

export async function createMessage({ model, system, prompt, maxTokens = 4096, timeoutMs = 45000, mcpServers }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // The MCP connector ships behind an anthropic-beta flag. Only send it when
  // mcp_servers are actually passed.
  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': key,
    'anthropic-version': '2023-06-01',
  };
  if (mcpServers?.length) headers['anthropic-beta'] = 'mcp-client-2025-04-04';
  try {
    const res = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      signal: controller.signal,
      headers,
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        ...(system ? { system } : {}),
        ...(mcpServers?.length ? { mcp_servers: mcpServers } : {}),
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Anthropic API HTTP ${res.status}: ${text}`);
    }
    return text ? JSON.parse(text) : {};
  } finally {
    clearTimeout(timer);
  }
}

// Pull the concatenated text out of a Messages API response.
export function extractText(response) {
  const blocks = response?.content ?? [];
  return blocks
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('\n')
    .trim();
}
