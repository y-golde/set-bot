// Minimal Slack Web API client — just what we need for "DM this email".
// Requires SLACK_BOT_TOKEN (xoxb-...) with scopes: users:read.email, chat:write.

const SLACK_API = 'https://slack.com/api';

async function slackCall(method, params, { post = false } = {}) {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) throw new Error('SLACK_BOT_TOKEN is not set');

  let url = `${SLACK_API}/${method}`;
  const init = {
    method: post ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
  };
  if (post) {
    init.body = JSON.stringify(params);
  } else {
    const qs = new URLSearchParams(params).toString();
    if (qs) url += `?${qs}`;
  }

  const res = await fetch(url, init);
  const json = await res.json();
  if (!json.ok) {
    throw new Error(`Slack ${method} failed: ${json.error}`);
  }
  return json;
}

export async function findSlackUserByEmail(email) {
  if (!email) return null;
  try {
    const res = await slackCall('users.lookupByEmail', { email });
    return res.user ?? null;
  } catch (err) {
    // Most common: users_not_found — treat as null, not throw
    if (/users_not_found/i.test(err.message)) return null;
    throw err;
  }
}

export async function sendDM(slackUserId, text, blocks = null) {
  const params = { channel: slackUserId, text };
  if (blocks) params.blocks = blocks;
  return slackCall('chat.postMessage', params, { post: true });
}

// Convenience: look up by email and DM in one call. Returns true if sent.
export async function dmByEmail(email, text, blocks = null) {
  if (!process.env.SLACK_BOT_TOKEN) {
    console.log('[slack] SLACK_BOT_TOKEN not set, skipping DM');
    return false;
  }
  const user = await findSlackUserByEmail(email);
  if (!user) {
    console.log(`[slack] No Slack user found for email ${email}`);
    return false;
  }
  await sendDM(user.id, text, blocks);
  console.log(`[slack] DMed ${email} (${user.id})`);
  return true;
}
