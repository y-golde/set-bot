// No-op RepoSuggester. Returns null so the dispatcher posts no suggestion.
// This is the default — the auto-triage feature is opt-in via REPO_SUGGESTER.

export const id = 'noop';

export async function suggest() {
  return null;
}
