const MONDAY_API_URL = 'https://api.monday.com/v2';

export async function mondayGraphQL(query, variables = {}) {
  const token = process.env.MONDAY_API_TOKEN;
  if (!token) throw new Error('MONDAY_API_TOKEN is not set');

  const res = await fetch(MONDAY_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // monday uses the raw token — no "Bearer" prefix
      'Authorization': token,
      'API-Version': '2024-10',
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`monday API HTTP ${res.status}: ${text}`);
  }

  const json = await res.json();

  if (json.errors?.length) {
    throw new Error(`monday API error: ${JSON.stringify(json.errors)}`);
  }

  return json.data;
}

export async function postUpdate(itemId, body) {
  const query = `
    mutation PostUpdate($itemId: ID!, $body: String!) {
      create_update(item_id: $itemId, body: $body) { id }
    }
  `;
  return mondayGraphQL(query, { itemId: String(itemId), body });
}

export async function getItemWithColumns(itemId) {
  const query = `
    query GetItem($itemId: [ID!]) {
      items(ids: $itemId) {
        id
        name
        column_values {
          id
          text
          value
          type
          column { title }
        }
      }
    }
  `;
  const data = await mondayGraphQL(query, { itemId: [String(itemId)] });
  return data?.items?.[0] ?? null;
}

// Full context for an item: columns plus the entire update/reply thread,
// formatted as a transcript ready to drop into a prompt.
// Whether the Item.description field is available on the current monday
// API version. Set lazily on first call; if the GraphQL response complains
// about the field we fall back to a description-less query and remember it.
let _descriptionAvailable = true;

export async function getItemContext(itemId, { updateLimit = 50 } = {}) {
  const buildQuery = (withDescription) => `
    query GetItemContext($itemId: [ID!], $limit: Int!) {
      items(ids: $itemId) {
        id
        name
        ${withDescription ? 'description' : ''}
        board { id }
        column_values {
          id
          text
          value
          type
          column { title }
        }
        updates(limit: $limit) {
          id
          text_body
          body
          created_at
          creator { name }
          replies {
            id
            text_body
            body
            created_at
            creator { name }
          }
        }
      }
    }
  `;
  const vars = { itemId: [String(itemId)], limit: updateLimit };
  try {
    const data = await mondayGraphQL(buildQuery(_descriptionAvailable), vars);
    return data?.items?.[0] ?? null;
  } catch (e) {
    if (_descriptionAvailable && /description|Cannot query field/i.test(e.message)) {
      console.warn('[monday] Item.description not in schema, falling back');
      _descriptionAvailable = false;
      const data = await mondayGraphQL(buildQuery(false), vars);
      return data?.items?.[0] ?? null;
    }
    throw e;
  }
}

// Render columns + updates as plain text for inclusion in a prompt.
export function formatItemContext(item) {
  if (!item) return '';
  const lines = [];

  // Item-level description ("Item card description" on Monday's UI). Lives
  // outside column_values and is the most common place teams paste the
  // ticket body.
  const desc = (item.description ?? '').trim();
  if (desc) {
    lines.push('Description:', desc, '');
  }

  const filledCols = [];
  for (const c of item.column_values ?? []) {
    if (!c.column?.title) continue;
    const v = readColumnText(c);
    if (v) filledCols.push({ title: c.column.title, value: v });
  }
  if (filledCols.length) {
    lines.push('Column values:');
    for (const c of filledCols) {
      lines.push(`- ${c.title}: ${c.value}`);
    }
  }

  // Chronological order — monday returns newest first
  const updates = [...(item.updates ?? [])].reverse();
  if (updates.length) {
    lines.push('', 'Conversation (oldest first):');
    for (const u of updates) {
      const who = u.creator?.name ?? 'unknown';
      const when = u.created_at ?? '';
      const body = readUpdateBody(u);
      if (body) lines.push(`[${when}] ${who}: ${body}`);
      for (const r of u.replies ?? []) {
        const rw = r.creator?.name ?? 'unknown';
        const rt = r.created_at ?? '';
        const rb = readUpdateBody(r);
        if (rb) lines.push(`  ↳ [${rt}] ${rw}: ${rb}`);
      }
    }
  }

  return lines.join('\n');
}

// Best-effort extraction of a column value as plain text. Falls back to
// parsing `value` JSON for long_text / doc columns, where `text` is often
// empty when the cell contains formatted content.
function readColumnText(col) {
  const t = (col.text ?? '').trim();
  if (t) return t;
  if (col.value) {
    try {
      const parsed = JSON.parse(col.value);
      const v = parsed?.text ?? parsed?.content ?? parsed?.url ?? '';
      if (typeof v === 'string' && v.trim()) return v.trim();
    } catch { /* not JSON */ }
  }
  return '';
}

// Updates have both `text_body` (plain) and `body` (HTML). Prefer text_body;
// fall back to stripped HTML so we don't lose multi-line content when Monday
// returns an empty text_body for rich-formatted updates.
function readUpdateBody(u) {
  const t = (u.text_body ?? '').trim();
  if (t) return t;
  return stripHtml(u.body ?? '');
}

// Find a repo URL inside the named column on a fetched item.
// Handles link columns (JSON value), text columns, and plain URLs.
// Accepts bare repo names ("foo"), "owner/repo" slugs, and full URLs;
// normalizes everything to https://github.com/<owner>/<repo>.
// Bare names are prefixed with DEFAULT_REPO_OWNER from env.
export function extractRepoUrl(item, columnTitle = 'Repositories') {
  if (!item) return null;
  const col = item.column_values.find(
    (c) => c.column?.title?.toLowerCase() === columnTitle.toLowerCase()
  );
  if (!col) return null;

  let raw = null;

  // Try parsed JSON value first (link / mirror / formula columns)
  if (col.value) {
    try {
      const parsed = JSON.parse(col.value);
      if (parsed?.url) raw = parsed.url;
    } catch { /* not JSON, fall through */ }
  }

  if (!raw) {
    const text = col.text ?? '';
    const urlMatch = text.match(/https?:\/\/\S+/);
    raw = urlMatch ? urlMatch[0] : text.trim();
  }

  return normalizeGithubUrl(raw);
}

// Convenience wrapper kept for callers that only want the URL.
export async function getRepoUrl(itemId, columnTitle = 'Repositories') {
  const item = await getItemWithColumns(itemId);
  return extractRepoUrl(item, columnTitle);
}

export function normalizeGithubUrl(input) {
  if (!input) return null;
  const s = String(input).trim().replace(/\.git$/, '').replace(/\/$/, '');
  if (!s) return null;

  // Already a full URL — return as-is
  if (/^https?:\/\//i.test(s)) return s;

  // owner/repo slug
  if (/^[\w.-]+\/[\w.-]+$/.test(s)) return `https://github.com/${s}`;

  // bare repo name — prefix with default org from env
  if (/^[\w.-]+$/.test(s)) {
    const owner = process.env.DEFAULT_REPO_OWNER;
    if (!owner) return null;
    return `https://github.com/${owner}/${s}`;
  }

  return null;
}

// Fetch a monday user's email by user ID. Used to find their Slack handle.
const _userEmailCache = new Map();
export async function getUserEmail(userId) {
  if (!userId) return null;
  const key = String(userId);
  if (_userEmailCache.has(key)) return _userEmailCache.get(key);
  const data = await mondayGraphQL(
    `query GetUser($ids: [ID!]) { users(ids: $ids) { id email } }`,
    { ids: [key] }
  );
  const email = data?.users?.[0]?.email ?? null;
  _userEmailCache.set(key, email);
  return email;
}

// Cached bot user ID for loop prevention. Re-fetched per cold start.
let _botUserId = null;
export async function getBotUserId() {
  if (_botUserId) return _botUserId;
  const data = await mondayGraphQL(`query { me { id } }`);
  _botUserId = String(data?.me?.id ?? '');
  return _botUserId;
}

// Workspace slug (e.g. "acme" in https://acme.monday.com). Auto-fetched
// once per cold start. Used to build human-friendly item URLs.
let _accountSlug = null;
export async function getAccountSlug() {
  if (_accountSlug !== null) return _accountSlug;
  try {
    const data = await mondayGraphQL(`query { me { account { slug } } }`);
    _accountSlug = data?.me?.account?.slug ?? '';
  } catch (e) {
    console.error('[monday] getAccountSlug failed:', e);
    _accountSlug = '';
  }
  return _accountSlug || null;
}

// Lightweight "just enough to build a Slack header" lookup — name + board id.
// Separate from getItemContext() because the latter pulls 50 updates.
export async function getItemRef(itemId) {
  const data = await mondayGraphQL(
    `query GetItemRef($itemId: [ID!]) {
       items(ids: $itemId) { id name board { id } }
     }`,
    { itemId: [String(itemId)] }
  );
  return data?.items?.[0] ?? null;
}

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// monday update bodies arrive as HTML — strip tags for keyword matching
export function stripHtml(s) {
  return String(s ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}
