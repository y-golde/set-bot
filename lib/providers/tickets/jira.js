// Jira TicketProvider.
//
// Webhook event types we care about (configure in your Jira project's
// "System → WebHooks" or via Automation rules):
//   - jira:issue_created  →  ticket_created
//   - comment_created     →  reply
//
// Repo URL is read from a custom field (JIRA_REPO_FIELD env var). If unset,
// the provider falls back to extracting the first GitHub URL from the
// description.

import {
  getIssue,
  listComments,
  addComment,
  getUserEmail as jiraGetUserEmail,
  htmlToADF,
  adfToText,
  repoFieldId,
} from '../../jira.js';
import { normalizeGithubUrl } from '../../monday.js';

export const id = 'jira';

export function verifyAndParse(req) {
  const secret = process.env.WEBHOOK_SHARED_SECRET;
  if (secret && req.query?.secret !== secret) {
    return { kind: 'unauthorized', message: 'bad shared secret' };
  }

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch {
    return { kind: 'bad_request', message: 'invalid JSON' };
  }

  const type = body?.webhookEvent;

  if (type === 'jira:issue_created') {
    const issue = body.issue ?? {};
    return {
      kind: 'event',
      event: {
        type: 'ticket_created',
        ticketId: String(issue.key ?? issue.id),
        ticketName: issue.fields?.summary ?? 'this issue',
        requesterId: issue.fields?.reporter?.accountId ?? null,
        text: '',
      },
    };
  }

  if (type === 'comment_created') {
    const issue = body.issue ?? {};
    const comment = body.comment ?? {};
    return {
      kind: 'event',
      event: {
        type: 'reply',
        ticketId: String(issue.key ?? issue.id),
        ticketName: issue.fields?.summary ?? null,
        requesterId: comment.author?.accountId ?? null,
        text: adfToText(comment.body) || String(comment.body ?? ''),
      },
    };
  }

  return { kind: 'event', event: null };
}

export async function getTicketContext(ticketId) {
  const [issue, commentPage] = await Promise.all([
    getIssue(ticketId),
    listComments(ticketId).catch(() => ({ comments: [] })),
  ]);
  if (!issue) return null;

  const fields = issue.fields ?? {};
  const descriptionText = adfToText(fields.description);
  const repoUrl = extractRepoUrl(issue, descriptionText);

  const history = (commentPage.comments ?? []).map((c) => ({
    author: c.author?.displayName ?? 'unknown',
    when: c.created ?? '',
    text: adfToText(c.body),
    replies: [],
  }));

  const contextBlock = formatJiraContext({
    title: fields.summary ?? '',
    description: descriptionText,
    history,
  });

  return {
    id: String(issue.key ?? issue.id),
    title: fields.summary ?? '(unknown)',
    repoUrl,
    contextBlock,
    history,
    raw: { issue, comments: commentPage.comments ?? [] },
  };
}

function extractRepoUrl(issue, descriptionText) {
  const fieldId = repoFieldId();
  if (fieldId) {
    const raw = issue.fields?.[fieldId];
    if (raw) {
      const value = typeof raw === 'string' ? raw : (raw.url ?? raw.value ?? '');
      const normalized = normalizeGithubUrl(value);
      if (normalized) return normalized;
    }
  }
  const m = (descriptionText ?? '').match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+/);
  return m ? normalizeGithubUrl(m[0]) : null;
}

function formatJiraContext({ title, description, history }) {
  const lines = [];
  if (description?.trim()) {
    lines.push('Description:', description.trim());
  }
  if (history.length) {
    lines.push('', 'Conversation (oldest first):');
    for (const c of [...history].reverse()) {
      const body = c.text?.trim();
      if (body) lines.push(`[${c.when}] ${c.author}: ${body}`);
    }
  }
  return lines.join('\n');
}

export async function postComment(ticketId, html) {
  await addComment(ticketId, htmlToADF(html));
}

export async function getRequesterEmail(requesterId) {
  return jiraGetUserEmail(requesterId);
}

export function findMostRecentAgent(context) {
  const comments = context?.raw?.comments ?? [];
  for (const c of comments) {
    const text = adfToText(c.body);
    const marker = text.match(/agent:([a-z]+):([\w-]+)/);
    if (marker) {
      const mode = /implement/i.test(text) ? 'implement'
                 : /research/i.test(text) ? 'research'
                 : null;
      return { agentProviderId: marker[1], agentId: marker[2], mode };
    }
  }
  return null;
}
