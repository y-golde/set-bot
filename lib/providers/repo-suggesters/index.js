// RepoSuggester contract.
//
// A RepoSuggester guesses which repository a ticket belongs to, based on
// the ticket's title and surrounding context. It's invoked when a ticket
// is created and (optionally) when the user runs research/implement on a
// ticket that doesn't have a repo set yet.
//
// Suggesters are best-effort and stateless: they return a candidate URL
// plus a one-line rationale, or null if they can't make a confident guess.
// Writing the repo back to the ticket is the dispatcher's job, not the
// suggester's, so a suggester is safe to swap without touching any
// ticket-provider code.
//
// Every provider module exports an object with this shape:
//
//   {
//     id: 'unblocked',                                   // stable string, used in logs
//     suggest({ ticketName, contextBlock, ticketUrl })   // all strings, contextBlock may be ''
//       → Promise<{ repoUrl, reasoning } | null>,        //   null = no confident guess
//   }
//
// Add a new suggester by dropping a file in this directory and registering
// it below. Pick which one runs at boot time via the REPO_SUGGESTER env
// var (default: 'noop', i.e. feature off).

import * as noop from './noop.js';
import * as unblocked from './unblocked.js';

const REGISTRY = {
  [noop.id]: noop,
  [unblocked.id]: unblocked,
};

export function getRepoSuggester(id) {
  const provider = REGISTRY[id];
  if (!provider) {
    throw new Error(`Unknown repo suggester: ${id}. Known: ${Object.keys(REGISTRY).join(', ')}`);
  }
  return provider;
}

export function listRepoSuggesters() {
  return Object.keys(REGISTRY);
}

// Default suggester for ticket-created auto-triage. Env-overridable.
// Defaults to 'noop' so the feature is opt-in.
export function getDefaultRepoSuggester() {
  const id = process.env.REPO_SUGGESTER || 'noop';
  return getRepoSuggester(id);
}
