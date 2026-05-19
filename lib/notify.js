import { postUpdate } from './monday.js';
import { dmByEmail } from './slack.js';

// Convert the tiny HTML subset we post on monday into Slack mrkdwn so the
// same content reads well in a DM.
export function htmlToSlack(html) {
  return String(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<b>(.*?)<\/b>/gi, '*$1*')
    .replace(/<strong>(.*?)<\/strong>/gi, '*$1*')
    .replace(/<i>(.*?)<\/i>/gi, '_$1_')
    .replace(/<em>(.*?)<\/em>/gi, '_$1_')
    .replace(/<code>(.*?)<\/code>/gi, '`$1`')
    .replace(/<a\s+href=["']([^"']+)["']>([^<]+)<\/a>/gi, '<$1|$2>')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

// Post a comment on the monday item AND DM the triggering user on Slack.
// `email` may be null — in that case the Slack DM is silently skipped.
export async function notify(itemId, html, email) {
  await postUpdate(itemId, html);
  if (email) {
    try {
      await dmByEmail(email, htmlToSlack(html));
    } catch (err) {
      console.error('[notify] Slack DM failed:', err);
    }
  }
}
