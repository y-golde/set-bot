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

// Find a repo URL inside the "Repositories" column.
// Handles link columns (JSON value), text columns, and plain URLs.
// Accepts bare repo names ("foo"), "owner/repo" slugs, and full URLs;
// normalizes everything to https://github.com/<owner>/<repo>.
// Bare names are prefixed with DEFAULT_REPO_OWNER from env.
export async function getRepoUrl(itemId, columnTitle = 'Repositories') {
  const item = await getItemWithColumns(itemId);
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

// Cached bot user ID for loop prevention. Re-fetched per cold start.
let _botUserId = null;
export async function getBotUserId() {
  if (_botUserId) return _botUserId;
  const data = await mondayGraphQL(`query { me { id } }`);
  _botUserId = String(data?.me?.id ?? '');
  return _botUserId;
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
