import { dmByEmail } from './slack.js';

// Convert the tiny HTML subset we post on ticket comments into Slack mrkdwn
// so the same content reads well in a DM.
export function htmlToSlack(html) {
  // Stash anchors first as placeholders so they survive the strip-tags pass.
  // (Slack's <URL|TEXT> link format looks like an HTML tag to a naive regex.)
  const links = [];
  let s = String(html).replace(
    /<a\s+href=["']([^"']+)["']>([^<]+)<\/a>/gi,
    (_, href, t) => {
      const i = links.push({ href, t }) - 1;
      return ` LINK${i} `;
    }
  );

  s = s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<b>(.*?)<\/b>/gi, '*$1*')
    .replace(/<strong>(.*?)<\/strong>/gi, '*$1*')
    .replace(/<i>(.*?)<\/i>/gi, '_$1_')
    .replace(/<em>(.*?)<\/em>/gi, '_$1_')
    .replace(/<code>(.*?)<\/code>/gi, '`$1`')
    // Strip remaining tags — but only ones that start with a letter, so
    // we don't accidentally eat the link placeholders below.
    .replace(/<\/?[a-zA-Z][^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

  s = s.replace(/ LINK(\d+) /g, (_, i) => {
    const { href, t } = links[Number(i)];
    return `<${href}|${t}>`;
  });

  return s.trim();
}

// Short-lived ref cache so 2-3 notify calls per event don't refetch the
// title. Keyed by "providerId:ticketId". Per-cold-start in-memory only.
const _refCache = new Map();
const REF_TTL_MS = 60_000;

export async function resolveRef(ticketProvider, ticketId, providedRef) {
  if (providedRef !== undefined) return providedRef;
  if (typeof ticketProvider.getTicketRef !== 'function') return null;
  const key = `${ticketProvider.id}:${ticketId}`;
  const cached = _refCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.ref;
  let ref = null;
  try {
    ref = await ticketProvider.getTicketRef(ticketId);
  } catch (e) {
    console.error('[notify] getTicketRef failed:', e);
  }
  _refCache.set(key, { ref, expires: Date.now() + REF_TTL_MS });
  return ref;
}

function slackEscape(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
}

function buildSlackHeader(ticketProvider, ticketId, ref) {
  const idPart = `${ticketProvider.id}:${ticketId}`;
  const title = (ref?.title ?? '').trim();
  if (title && ref?.url) {
    return `*Re:* <${ref.url}|${slackEscape(title)}>  _(${idPart})_`;
  }
  if (title) {
    return `*Re:* ${slackEscape(title)}  _(${idPart})_`;
  }
  if (ref?.url) {
    return `*Re:* <${ref.url}|ticket ${idPart}>`;
  }
  return `*Re:* ticket _(${idPart})_`;
}

// Post a comment via the given TicketProvider AND DM the triggering user on
// Slack. The Slack DM is prefixed with a "Re: <ticket title>" header so the
// recipient knows which ticket the message refers to.
//
// First argument is { ticketProvider, ticketId, email, ref? }. Pass `ref` to
// skip the lookup; otherwise notify calls ticketProvider.getTicketRef once
// and caches it for ~60s.
export async function notify({ ticketProvider, ticketId, email, ref }, html) {
  await ticketProvider.postComment(ticketId, html);
  if (!email) return;
  try {
    const resolved = await resolveRef(ticketProvider, ticketId, ref);
    const header = buildSlackHeader(ticketProvider, ticketId, resolved);
    await dmByEmail(email, `${header}\n\n${htmlToSlack(html)}`);
  } catch (err) {
    console.error('[notify] Slack DM failed:', err);
  }
}
