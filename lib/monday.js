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
export async function getRepoUrl(itemId, columnTitle = 'Repositories') {
  const item = await getItemWithColumns(itemId);
  if (!item) return null;

  const col = item.column_values.find(
    (c) => c.column?.title?.toLowerCase() === columnTitle.toLowerCase()
  );
  if (!col) return null;

  // Try parsed JSON value first (link / mirror / formula columns)
  if (col.value) {
    try {
      const parsed = JSON.parse(col.value);
      if (parsed?.url) return parsed.url;
    } catch { /* not JSON, fall through */ }
  }

  // Fall back to the rendered text — extract first URL we find
  const text = col.text ?? '';
  const match = text.match(/https?:\/\/\S+/);
  return match ? match[0] : (text.trim() || null);
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
