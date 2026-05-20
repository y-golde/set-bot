// Monday TicketProvider — wraps the raw monday.com GraphQL client in lib/monday.js.

import {
  postUpdate,
  getItemContext as mondayGetItemContext,
  extractRepoUrl,
  setRepoUrl as mondaySetRepoUrl,
  getUserEmail,
  stripHtml,
  getItemRef,
  getAccountSlug,
} from '../../monday.js';
import { cleanComment } from '../../comment-filter.js';

export const id = 'monday';

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

  if (body?.challenge) {
    return { kind: 'challenge', response: { challenge: body.challenge } };
  }

  const event = body?.event;
  const type = event?.type;

  if (type === 'create_pulse') {
    return {
      kind: 'event',
      event: {
        type: 'ticket_created',
        ticketId: String(event.pulseId),
        ticketName: event.pulseName ?? 'this item',
        requesterId: event.userId ? String(event.userId) : null,
        text: '',
      },
    };
  }

  if (type === 'create_update' || type === 'create_reply') {
    return {
      kind: 'event',
      event: {
        type: 'reply',
        ticketId: String(event.pulseId),
        ticketName: event.pulseName ?? null,
        requesterId: event.userId ? String(event.userId) : null,
        text: stripHtml(event.body ?? event.textBody ?? ''),
      },
    };
  }

  return { kind: 'event', event: null };
}

export async function getTicketContext(ticketId) {
  const item = await mondayGetItemContext(ticketId);
  if (!item) return null;
  const cleaned = withCleanedUpdates(item);
  return {
    id: String(item.id),
    title: item.name ?? '(unknown)',
    repoUrl: extractRepoUrl(item),
    contextBlock: JSON.stringify(cleaned, null, 2),
    history: (cleaned.updates ?? []).map((u) => ({
      author: u.creator?.name ?? 'unknown',
      when: u.created_at ?? '',
      text: u.text_body ?? '',
      replies: (u.replies ?? []).map((r) => ({
        author: r.creator?.name ?? 'unknown',
        when: r.created_at ?? '',
        text: r.text_body ?? '',
      })),
    })),
    raw: item,
  };
}

// Clone the item with bot updates / !set triggers stripped from the
// updates thread. Column `value` strings are parsed where possible so the
// agent doesn't see double-encoded JSON.
function withCleanedUpdates(item) {
  return {
    ...item,
    column_values: (item.column_values ?? []).map((c) => ({
      ...c,
      value: tryParseJson(c.value),
    })),
    updates: cleanUpdateList(item.updates ?? []),
  };
}

function cleanUpdateList(updates) {
  const out = [];
  for (const u of updates) {
    const body = (u.text_body ?? '').trim() || stripHtml(u.body ?? '');
    const text = cleanComment(body);
    const replies = (u.replies ?? [])
      .map((r) => {
        const rb = (r.text_body ?? '').trim() || stripHtml(r.body ?? '');
        const cleaned = cleanComment(rb);
        return cleaned ? { ...r, text_body: cleaned, body: undefined } : null;
      })
      .filter(Boolean);
    if (!text && replies.length === 0) continue;
    out.push({ ...u, text_body: text ?? '', body: undefined, replies });
  }
  return out;
}

function tryParseJson(s) {
  if (typeof s !== 'string' || !s) return s;
  try { return JSON.parse(s); } catch { return s; }
}

export async function postComment(ticketId, html) {
  await postUpdate(ticketId, html);
}

export async function setRepoUrl(ticketId, url) {
  return mondaySetRepoUrl(ticketId, url);
}

export async function getTicketRef(ticketId) {
  try {
    const [item, slug] = await Promise.all([getItemRef(ticketId), getAccountSlug()]);
    if (!item) return null;
    const boardId = item.board?.id;
    const url = slug && boardId
      ? `https://${slug}.monday.com/boards/${boardId}/pulses/${ticketId}`
      : null;
    return { title: item.name ?? null, url };
  } catch (e) {
    console.error('[monday-provider] getTicketRef failed:', e);
    return null;
  }
}

export async function getRequesterEmail(requesterId) {
  if (!requesterId) return null;
  try {
    return await getUserEmail(requesterId);
  } catch {
    return null;
  }
}

// Look back through the ticket's update history for the most recent agent
// the bot announced, so !set status can re-post its result. Reads the
// "agent:<provider>:<id>" marker every announcement comment emits.
export function findMostRecentAgent(context) {
  const updates = context?.raw?.updates ?? [];
  for (const u of updates) {
    const hit = scanText(u.text_body ?? '');
    if (hit) return hit;
    for (const r of u.replies ?? []) {
      const rh = scanText(r.text_body ?? '');
      if (rh) return rh;
    }
  }
  return null;
}

function scanText(text) {
  const marker = text.match(/agent:([a-z]+):([\w-]+)/);
  if (!marker) return null;
  const mode = /implement/i.test(text) ? 'implement'
             : /research/i.test(text) ? 'research'
             : null;
  return { agentProviderId: marker[1], agentId: marker[2], mode };
}

// Scan the update thread for the most recent "set-suggest: <url>" marker
// posted by the repo-suggester flow.
export function findRepoSuggestion(context) {
  const updates = context?.raw?.updates ?? [];
  for (const u of updates) {
    const hit = scanSuggestText(u.text_body ?? u.body ?? '');
    if (hit) return hit;
    for (const r of u.replies ?? []) {
      const rh = scanSuggestText(r.text_body ?? r.body ?? '');
      if (rh) return rh;
    }
  }
  return null;
}

function scanSuggestText(text) {
  const m = String(text).match(/set-suggest:\s*(https?:\/\/\S+)/i);
  return m ? { repoUrl: m[1].replace(/[<>"')]+$/, '') } : null;
}
