// Anthropic AgentProvider — runs synchronously: launchAgent calls the
// Messages API and returns the model's answer inline. There is no callback;
// the dispatcher posts the result to the ticket right away.
//
// This is suitable for "research" mode where the model reasons from the
// prompt context alone. "implement" mode is accepted but the answer is a
// plan / patch sketch — the provider does not clone the repo or open PRs.
// For full code-edit + PR flows, route to the Cursor provider.

import { createMessage, extractText } from '../../anthropic.js';

export const id = 'anthropic';
export const kind = 'sync';

const DEFAULT_MODEL = 'claude-opus-4-7';

const SYSTEM = `You are Set, a helpful coding assistant responding to a ticket from a project tracker.
- Respond in plain text, not Markdown headings — your output is rendered as ticket comment HTML.
- Be specific. Cite file paths and line numbers when discussing code.
- If the task asks for implementation but you cannot run tools to edit the repo, say so plainly and provide the smallest concrete patch sketch you can.
- Keep answers under ~600 words unless the user clearly wants more.`;

export async function launchAgent({ prompt, mode, repoUrl }) {
  const agentId = generateAgentId();
  const userPrompt = composePrompt({ prompt, mode, repoUrl });

  let response;
  try {
    response = await createMessage({
      model: process.env.ANTHROPIC_MODEL || DEFAULT_MODEL,
      system: SYSTEM,
      prompt: userPrompt,
      maxTokens: 4096,
    });
  } catch (err) {
    return {
      agentId,
      liveUrl: null,
      sync: { status: 'failed', statusRaw: err?.message ?? 'error', text: '', prUrl: null, error: err },
    };
  }

  const text = extractText(response);
  return {
    agentId,
    liveUrl: null,
    sync: { status: 'ok', statusRaw: 'completed', text, prUrl: null },
  };
}

// No callback for sync providers — kept as a hint to route handlers.
export function parseCallback() {
  return null;
}

// Sync provider doesn't persist agent state across runs, so /status from a
// later command can't replay the result. Surface that honestly.
export async function getResult() {
  return {
    status: 'failed',
    statusRaw: 'unsupported',
    text: 'The Anthropic provider runs synchronously — its result was posted at launch time and is not stored. Re-run the command to get a fresh answer.',
    prUrl: null,
    liveUrl: null,
  };
}

function composePrompt({ prompt, mode, repoUrl }) {
  const header = mode === 'implement'
    ? '(Implementation request — without a sandbox you cannot actually clone or edit files. Provide the smallest concrete patch sketch and call out follow-ups.)'
    : '';
  const repoLine = repoUrl ? `Repository for context: ${repoUrl}` : '';
  return [header, repoLine, prompt].filter(Boolean).join('\n\n');
}

function generateAgentId() {
  return 'ant-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}
