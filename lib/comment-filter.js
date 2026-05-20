// Drop our own bot updates and strip `!set` trigger lines from the ticket
// conversation before handing it to the agent. The agent prompt already
// tells the model to ignore them, but cutting them at the source is
// cheaper than having the model do it and prevents the bot's "🚀 Research
// agent is running" chatter from looking like instructions.

// Every bot status comment starts with one of these emoji from
// lib/dispatch.js#sign() + the MODES/announcement table.
const BOT_EMOJI_PREFIX = /^\s*(?:🐕|🔬|🔧|🚀|✅|❌|⚠️|🔄|⏳|🔎)/;

export function isBotComment(text) {
  return BOT_EMOJI_PREFIX.test(String(text ?? ''));
}

// If the update starts with "!set <command>", drop just that line — anything
// the user wrote on subsequent lines is real content the agent should see.
export function stripSetTrigger(text) {
  const lines = String(text ?? '').split('\n');
  if (lines.length && /^\s*!set\s+\w+/i.test(lines[0])) {
    lines.shift();
    return lines.join('\n').trim();
  }
  return text ?? '';
}

// Combined helper: returns the cleaned text, or null if the comment is bot
// chatter / pure command with nothing else worth keeping.
export function cleanComment(text) {
  const t = String(text ?? '').trim();
  if (!t) return null;
  if (isBotComment(t)) return null;
  const stripped = stripSetTrigger(t).trim();
  if (!stripped) return null;
  return stripped;
}
