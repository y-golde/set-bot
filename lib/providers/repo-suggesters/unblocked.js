// Unblocked RepoSuggester.
//
// Calls Unblocked's Answers API directly:
//   PUT  /answers/{questionId}   — submit the question (returns 204)
//   GET  /answers/{questionId}   — poll until state === 'complete'
//
// Docs: https://docs.getunblocked.com/api-reference/quickstart
//
// Env:
//   UNBLOCKED_API_TOKEN   — Personal or Team Access Token (Bearer)
//   UNBLOCKED_API_URL     — optional override of the API base
//                           (default: https://getunblocked.com/api/v1)
//
// Returns { repoUrl, reasoning } when the answer commits to a single URL,
// or null when there's no env config, the poll times out, or no URL is
// found in the answer.

import { normalizeGithubUrl } from '../../monday.js';

export const id = 'unblocked';

const DEFAULT_BASE_URL = 'https://getunblocked.com/api/v1';
const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_MS = 50_000;

const QUESTION_TEMPLATE = (ticketName, contextBlock, ticketUrl) => `
You are doing repo triage for a project-tracker ticket. Using your knowledge of this organization's codebase, pick the single GitHub repository that most likely owns this work.

Ticket title: ${ticketName || '(untitled)'}
${ticketUrl ? `Ticket URL: ${ticketUrl}\n` : ''}
Full ticket data from the project tracker:
---
${contextBlock || '(no additional context)'}
---

Reply with EXACTLY two lines, no preamble, no Markdown, no extra prose:

REPO: <https URL of the repo, or NONE if you can't decide>
REASON: <under 15 words — one short clause, no full sentences>

Return "REPO: NONE" if the ticket is too vague to attribute confidently.
`.trim();

export async function suggest({ ticketName, contextBlock, ticketUrl }) {
  const token = process.env.UNBLOCKED_API_TOKEN;
  if (!token) {
    console.log('[repo-suggest:unblocked] UNBLOCKED_API_TOKEN not set — skipping');
    return null;
  }
  const baseUrl = (process.env.UNBLOCKED_API_URL || DEFAULT_BASE_URL).replace(/\/$/, '');

  const questionId = crypto.randomUUID();
  const question = QUESTION_TEMPLATE(ticketName, contextBlock, ticketUrl);

  try {
    await submitQuestion({ baseUrl, token, questionId, question });
    const answer = await pollAnswer({ baseUrl, token, questionId });
    if (!answer) return null;
    return parseSuggestion(answer);
  } catch (err) {
    console.error('[repo-suggest:unblocked] failed:', err);
    return null;
  }
}

async function submitQuestion({ baseUrl, token, questionId, question }) {
  const res = await fetch(`${baseUrl}/answers/${encodeURIComponent(questionId)}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ question }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Unblocked submit HTTP ${res.status}: ${text}`);
  }
}

async function pollAnswer({ baseUrl, token, questionId }) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const res = await fetch(`${baseUrl}/answers/${encodeURIComponent(questionId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Unblocked poll HTTP ${res.status}: ${text}`);
    }
    const body = await res.json();
    if (body?.state === 'complete') return body.result?.answer ?? '';
    if (body?.state && body.state !== 'processing') {
      throw new Error(`Unblocked unexpected state: ${body.state}`);
    }
  }
  console.warn(`[repo-suggest:unblocked] poll timed out after ${POLL_TIMEOUT_MS}ms`);
  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Parse the "REPO: ...\nREASON: ..." block out of an Unblocked answer.
// The model sometimes wraps URLs in <…> or [text](url) Markdown; strip that.
export function parseSuggestion(text) {
  if (!text) return null;
  const repoMatch = text.match(/REPO:\s*([^\n]+)/i);
  const reasonMatch = text.match(/REASON:\s*([^\n]+)/i);
  if (!repoMatch) return null;
  let raw = repoMatch[1].trim();
  if (!raw || /^none$/i.test(raw)) return null;
  // Markdown link form: [text](https://…) — keep the URL inside parens.
  const mdLink = raw.match(/\((https?:\/\/[^\s)]+)\)/);
  if (mdLink) raw = mdLink[1];
  // Strip wrapping angle-brackets / quotes / trailing punctuation.
  raw = raw.replace(/^[<\["']+|[>\]"'.,]+$/g, '').trim();
  const repoUrl = normalizeGithubUrl(raw);
  if (!repoUrl) return null;
  const reasoning = reasonMatch ? reasonMatch[1].trim() : '';
  return { repoUrl, reasoning };
}
