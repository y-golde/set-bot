import {
  postUpdate,
  escapeHtml,
  stripHtml,
  getRepoUrl,
  getBotUserId,
} from '../lib/monday.js';
import { launchAgent } from '../lib/cursor.js';

const INITIAL_COMMENT = (itemName) => `
👋 Hey team — I'm here to triage <b>${escapeHtml(itemName)}</b>.<br><br>
Before I can act, please:<br>
1. Fill in the <b>Repositories</b> column with the GitHub repo URL.<br>
2. Reply to this update with <b>research</b> or <b>implement</b>.
`.trim();

const IMPLEMENT_STUB = `🔧 <b>Implement</b> mode isn't wired up yet — coming in step 3. For now, try <b>research</b>.`;

const MISSING_REPO = `⚠️ I couldn't find a repo URL in the <b>Repositories</b> column. Please fill it in and reply <b>research</b> again.`;

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({ ok: true, service: 'monday-bot' });
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const secret = process.env.WEBHOOK_SHARED_SECRET;
  if (secret && req.query.secret !== secret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;

    if (body?.challenge) {
      return res.status(200).json({ challenge: body.challenge });
    }

    const event = body?.event;
    const type = event?.type;

    // Loop prevention: ignore anything authored by the bot itself.
    // Disable by setting DISABLE_SELF_CHECK=true (useful when the bot's token
    // belongs to a real human who also posts replies for testing).
    if (event?.userId && process.env.DISABLE_SELF_CHECK !== 'true') {
      const botId = await getBotUserId();
      if (botId && String(event.userId) === botId) {
        // Don't loop on the bot's *own* updates — recognize them by body prefix
        const text = stripHtml(event.body ?? event.textBody ?? '');
        const isBotComment = /^(👋 Hey team|🔬 Spinning up|✅ Research complete|❌ Research agent|🔧|⚠️)/.test(text);
        if (isBotComment) {
          console.log('[monday-bot] Skipping self-authored bot comment');
          return res.status(200).json({ ok: true });
        }
      }
    }

    if (type === 'create_pulse') {
      await postUpdate(event.pulseId, INITIAL_COMMENT(event.pulseName ?? 'this item'));
      console.log(`[monday-bot] Triage prompt posted on item ${event.pulseId}`);
    } else if (type === 'create_update' || type === 'create_reply') {
      await handleReply(event, req);
    } else {
      console.log(`[monday-bot] Ignoring event type: ${type ?? 'unknown'}`);
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[monday-bot] Error handling webhook:', err);
    return res.status(200).json({ ok: true, warning: 'internal error logged' });
  }
}

async function handleReply(event, req) {
  const itemId = event.pulseId;
  const text = stripHtml(event.body ?? event.textBody ?? '').toLowerCase();

  const wantsResearch = /\bresearch\b/.test(text);
  const wantsImplement = /\bimplement\b/.test(text);

  if (!wantsResearch && !wantsImplement) {
    console.log(`[monday-bot] No keyword match in reply on item ${itemId}`);
    return;
  }

  if (wantsImplement) {
    await postUpdate(itemId, IMPLEMENT_STUB);
    return;
  }

  // research mode
  const repo = await getRepoUrl(itemId);
  if (!repo) {
    await postUpdate(itemId, MISSING_REPO);
    return;
  }

  const callbackBase = `https://${req.headers.host}`;
  const callbackUrl = `${callbackBase}/api/cursor-webhook?itemId=${encodeURIComponent(itemId)}`;

  const item = event.pulseName ? `"${event.pulseName}"` : `monday item ${itemId}`;
  const prompt = `You are researching a ticket from monday.com (${item}).

Ticket title: ${event.pulseName ?? '(unknown)'}
Repository: ${repo}

Investigate the repository and produce a research brief covering:
1. Where in the codebase this change would land (files, modules, functions).
2. Relevant existing patterns or prior art.
3. Risks, unknowns, and suggested next steps.

Keep the brief tight (under ~400 words). Do not modify code.`;

  const agent = await launchAgent({
    prompt,
    repository: repo,
    webhookUrl: callbackUrl,
  });

  const agentUrl = agent?.target?.url ?? agent?.url ?? `https://cursor.com/agents/${agent?.id ?? ''}`;
  await postUpdate(
    itemId,
    `🔬 Spinning up a research agent against <a href="${escapeHtml(repo)}">${escapeHtml(repo)}</a>.<br>` +
    `Live progress: <a href="${escapeHtml(agentUrl)}">${escapeHtml(agentUrl)}</a><br><br>` +
    `I'll post the brief here when it's done.`
  );
  console.log(`[monday-bot] Launched Cursor agent ${agent?.id} for item ${itemId}`);
}
