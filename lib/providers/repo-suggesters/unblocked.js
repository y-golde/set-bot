// Unblocked RepoSuggester.
//
// Asks Claude to pick the most likely repository for a ticket, using
// Unblocked's remote MCP server as the source of cross-repo institutional
// context. Unblocked is "just" an MCP server here — swap any other
// MCP-compatible knowledge tool by writing a sibling suggester file.
//
// Env:
//   UNBLOCKED_MCP_URL    — Unblocked's remote MCP endpoint (required)
//   UNBLOCKED_MCP_TOKEN  — bearer token for the MCP endpoint (required)
//   UNBLOCKED_MCP_NAME   — display name for the MCP server (default 'unblocked')
//   ANTHROPIC_API_KEY    — already required by the anthropic agent provider
//   ANTHROPIC_MODEL      — optional override (defaults to claude-opus-4-7)
//
// Returns { repoUrl, reasoning } when Claude commits to a single URL,
// or null when there's no env config or the model can't decide.

import { createMessage, extractText } from '../../anthropic.js';
import { normalizeGithubUrl } from '../../monday.js';

export const id = 'unblocked';

const DEFAULT_MODEL = 'claude-opus-4-7';

const SYSTEM = `You are a triage assistant. Given a ticket from a project tracker, pick the single repository in this organization that most likely owns the work.

Use the Unblocked MCP tools available to you to search the org's PRs, docs, issues, and code history. Prefer repos that have recently shipped related changes or that match the ticket's domain.

Reply with EXACTLY two lines, no preamble, no Markdown, no extra prose:

REPO: <https URL of the repo, or NONE if you can't decide>
REASON: <under 15 words — one short clause, no full sentences>

Do NOT guess if the ticket is too vague — return "REPO: NONE" instead.`;

export async function suggest({ ticketName, contextBlock, ticketUrl }) {
  const mcpUrl = process.env.UNBLOCKED_MCP_URL;
  const mcpToken = process.env.UNBLOCKED_MCP_TOKEN;
  if (!mcpUrl || !mcpToken) {
    console.log('[repo-suggest:unblocked] UNBLOCKED_MCP_URL or UNBLOCKED_MCP_TOKEN not set — skipping');
    return null;
  }

  const userPrompt = [
    `Ticket title: ${ticketName ?? '(untitled)'}`,
    ticketUrl ? `Ticket URL: ${ticketUrl}` : '',
    '',
    'Full ticket data from the project tracker:',
    '---',
    contextBlock || '(no additional context)',
    '---',
    '',
    'Which repository in this org most likely owns this work?',
  ].filter(Boolean).join('\n');

  let response;
  try {
    response = await createMessage({
      model: process.env.ANTHROPIC_MODEL || DEFAULT_MODEL,
      system: SYSTEM,
      prompt: userPrompt,
      maxTokens: 256,
      timeoutMs: 50_000,
      mcpServers: [
        {
          type: 'url',
          url: mcpUrl,
          name: process.env.UNBLOCKED_MCP_NAME || 'unblocked',
          authorization_token: mcpToken,
        },
      ],
    });
  } catch (err) {
    console.error('[repo-suggest:unblocked] Anthropic call failed:', err);
    return null;
  }

  const text = extractText(response);
  return parseSuggestion(text);
}

// Parse the "REPO: ...\nREASON: ..." block. Returns null if the model
// declined to commit or the URL doesn't normalize to a GitHub repo.
export function parseSuggestion(text) {
  if (!text) return null;
  const repoMatch = text.match(/REPO:\s*([^\n]+)/i);
  const reasonMatch = text.match(/REASON:\s*([^\n]+)/i);
  if (!repoMatch) return null;
  const raw = repoMatch[1].trim();
  if (!raw || /^none$/i.test(raw)) return null;
  // Strip angle-brackets / markdown if the model wrapped the URL.
  const cleaned = raw.replace(/^[<\[(]|[>\])]$/g, '').trim();
  const repoUrl = normalizeGithubUrl(cleaned);
  if (!repoUrl) return null;
  const reasoning = reasonMatch ? reasonMatch[1].trim() : '';
  return { repoUrl, reasoning };
}
