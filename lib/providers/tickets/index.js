// TicketProvider contract.
//
// A TicketProvider owns the ticket thread: parsing the inbound webhook from
// the tracker, fetching ticket context, posting comments, and looking up the
// requester's email. Providers do not know about agents — they just speak
// "ticket". The dispatcher in lib/dispatch.js wires a TicketProvider to an
// AgentProvider.
//
// Every provider module exports an object with this shape:
//
//   {
//     id: 'monday',                                      // string, stable, used in URLs/logs
//     verifyAndParse(req) → {                            // called from the route handler
//       kind: 'challenge', response,                     //   monday-style handshake → echo back
//     } | {
//       kind: 'event', event: NormalizedEvent | null,    //   real event, or null = ignore
//     } | {
//       kind: 'unauthorized' | 'bad_request', message,
//     },
//     getTicketContext(ticketId) → Promise<TicketContext>,
//     postComment(ticketId, html) → Promise<void>,       // html in the small Monday subset
//     getRequesterEmail(requesterId) → Promise<string | null>,
//     findMostRecentAgent(ticketContext) → { agentId, agentProviderId, mode } | null,
//     getTicketRef?(ticketId) → Promise<{ title, url } | null>,  // optional;
//       // a lightweight "what is this ticket called and where do I open it?"
//       // lookup used by the Slack DM header. Skipped if not implemented.
//     setRepoUrl?(ticketId, url) → Promise<boolean>,             // optional;
//       // write the repo URL back to the ticket's repo field. Returns
//       // true on success, false if the field isn't configured. Used by
//       // the auto-triage flow when the user accepts a suggestion.
//     findRepoSuggestion?(ticketContext) → { repoUrl } | null,   // optional;
//       // find the most recent "set-suggest: <url>" marker in the ticket's
//       // raw comment thread (bot-posted by the suggester flow). Used by
//       // !set use and the missing-repo fallback path.
//   }
//
// NormalizedEvent shape:
//   {
//     type: 'ticket_created' | 'reply',
//     ticketId: string,
//     ticketName?: string,         // only required for 'ticket_created'
//     requesterId: string | null,
//     text: string,                // plain text (HTML stripped)
//   }
//
// TicketContext shape:
//   {
//     id: string,
//     title: string,
//     repoUrl: string | null,
//     contextBlock: string,        // pre-formatted plain-text dump for the prompt
//     history: Array<{ author, when, text, replies }>,  // newest first
//     raw: any,                    // provider-specific blob (for findMostRecentAgent)
//   }

import * as monday from './monday.js';
import * as jira from './jira.js';

const REGISTRY = {
  [monday.id]: monday,
  [jira.id]: jira,
};

export function getTicketProvider(id) {
  const provider = REGISTRY[id];
  if (!provider) {
    throw new Error(`Unknown ticket provider: ${id}. Known: ${Object.keys(REGISTRY).join(', ')}`);
  }
  return provider;
}

export function listTicketProviders() {
  return Object.keys(REGISTRY);
}
