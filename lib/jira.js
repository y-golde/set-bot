// Minimal Jira Cloud REST client — just what we need for "fetch issue +
// post comment". Auth is Basic (email + API token). Docs:
//   https://developer.atlassian.com/cloud/jira/platform/rest/v3/

const _userEmailCache = new Map();

function authHeader() {
  const email = process.env.JIRA_EMAIL;
  const token = process.env.JIRA_API_TOKEN;
  if (!email || !token) {
    throw new Error('JIRA_EMAIL and JIRA_API_TOKEN must be set');
  }
  return 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');
}

function baseUrl() {
  const url = process.env.JIRA_BASE_URL;
  if (!url) throw new Error('JIRA_BASE_URL is not set (e.g. https://your-org.atlassian.net)');
  return url.replace(/\/$/, '');
}

// Public-facing browse URL for an issue (e.g. https://org.atlassian.net/browse/ABC-1).
export function issueBrowseUrl(issueKey) {
  try {
    return `${baseUrl()}/browse/${encodeURIComponent(issueKey)}`;
  } catch {
    return null;
  }
}

async function jiraFetch(path, init = {}) {
  const url = `${baseUrl()}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: authHeader(),
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Jira API HTTP ${res.status} at ${path}: ${text}`);
  }
  return text ? JSON.parse(text) : {};
}

// Lightweight ref fetch — just summary, for building a Slack header.
export async function getIssueRef(issueKey) {
  return jiraFetch(`/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=summary`);
}

export async function getIssue(issueKey) {
  // Fetch all fields. The agent reads raw JSON, and curating a subset means
  // we miss whichever custom field the team uses for the actual description.
  return jiraFetch(`/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=*all`);
}

export async function listComments(issueKey, { limit = 50 } = {}) {
  return jiraFetch(`/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment?maxResults=${limit}&orderBy=-created`);
}

export async function addComment(issueKey, adfBody) {
  return jiraFetch(`/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`, {
    method: 'POST',
    body: JSON.stringify({ body: adfBody }),
  });
}

export async function getUserEmail(accountId) {
  if (!accountId) return null;
  if (_userEmailCache.has(accountId)) return _userEmailCache.get(accountId);
  try {
    const user = await jiraFetch(`/rest/api/3/user?accountId=${encodeURIComponent(accountId)}`);
    const email = user?.emailAddress ?? null;
    _userEmailCache.set(accountId, email);
    return email;
  } catch {
    return null;
  }
}

// Field id (e.g. "customfield_10042") of the custom field that holds the
// repo URL. Optional — when unset, the provider falls back to parsing the
// description.
export function repoFieldId() {
  return process.env.JIRA_REPO_FIELD || '';
}

// Convert the tiny HTML subset we post on Monday into a minimal ADF document.
// ADF is JSON; we render <br> as paragraph breaks and inline anchors/code/bold
// as the corresponding marks.
export function htmlToADF(html) {
  const blocks = String(html ?? '').split(/<br\s*\/?>(?:\s*<br\s*\/?>)*|\n\n+/i);
  const content = blocks
    .map((block) => block.trim())
    .filter((block) => block.length > 0)
    .map((block) => ({ type: 'paragraph', content: inlineToADF(block) }));
  if (content.length === 0) {
    content.push({ type: 'paragraph', content: [{ type: 'text', text: ' ' }] });
  }
  return { type: 'doc', version: 1, content };
}

function inlineToADF(s) {
  // Tokenise on tags we care about; everything else becomes plain text with
  // entity decoding. Order matters: anchors first so their inner text doesn't
  // get re-parsed.
  const tokens = [];
  let i = 0;
  const re = /<a\s+href=["']([^"']+)["']>([\s\S]*?)<\/a>|<b>([\s\S]*?)<\/b>|<strong>([\s\S]*?)<\/strong>|<i>([\s\S]*?)<\/i>|<em>([\s\S]*?)<\/em>|<code>([\s\S]*?)<\/code>/gi;
  let m;
  while ((m = re.exec(s)) !== null) {
    if (m.index > i) tokens.push({ text: decode(s.slice(i, m.index)) });
    if (m[1] !== undefined) tokens.push({ text: decode(m[2]), marks: [{ type: 'link', attrs: { href: m[1] } }] });
    else if (m[3] !== undefined || m[4] !== undefined) tokens.push({ text: decode(m[3] ?? m[4]), marks: [{ type: 'strong' }] });
    else if (m[5] !== undefined || m[6] !== undefined) tokens.push({ text: decode(m[5] ?? m[6]), marks: [{ type: 'em' }] });
    else if (m[7] !== undefined) tokens.push({ text: decode(m[7]), marks: [{ type: 'code' }] });
    i = m.index + m[0].length;
  }
  if (i < s.length) tokens.push({ text: decode(s.slice(i)) });

  return tokens
    .filter((t) => t.text && t.text.length > 0)
    .map((t) => ({ type: 'text', ...t }));
}

function decode(s) {
  return String(s)
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

// Flatten ADF (or a string) to plain text.
export function adfToText(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (node.type === 'text') return node.text ?? '';
  if (Array.isArray(node.content)) {
    return node.content.map(adfToText).join(node.type === 'paragraph' ? '' : '\n');
  }
  return '';
}
