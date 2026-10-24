// Follow-ups a daily sets for the next day ("### Set today") and how the next
// daily accounts for them ("### Yesterday's follow-ups").

/** The text of `## heading` (or `### heading`) up to the next heading of the same or higher level. */
export function section(text, heading) {
  const lines = String(text ?? '').split('\n');
  const level = /^#+/.exec(heading)[0].length;
  const title = heading.replace(/^#+\s*/, '').toLowerCase();
  const start = lines.findIndex((line) => {
    const match = /^(#+)\s+(.*)$/.exec(line);
    return match && match[1].length === level && match[2].trim().toLowerCase().startsWith(title);
  });
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const match = /^(#+)\s/.exec(lines[i]);
    if (match && match[1].length <= level) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).join('\n');
}

/**
 * The numbered "Set today" items of a daily as [{id: 'F1', what}], in order.
 * Continuation lines join their item.
 */
export function parseSetToday(text) {
  const body = section(text, '### Set today');
  if (body === null) return [];
  const items = [];
  for (const line of body.split('\n')) {
    const numbered = /^\s*(\d+)[.)]\s+(.*)$/.exec(line);
    if (numbered) {
      items.push({ id: `F${items.length + 1}`, what: numbered[2].trim() });
    } else if (items.length && line.trim() && !/^\s*[-*]\s/.test(line)) {
      items[items.length - 1].what = `${items[items.length - 1].what} ${line.trim()}`;
    }
  }
  return items;
}

/** The follow-ups a previous daily set: from its stored facts, else parsed from its text. */
export function previousFollowUps(previous) {
  if (!previous) return [];
  const stored = previous.facts?.followUps?.set;
  if (Array.isArray(stored)) return stored.filter((item) => item && typeof item.id === 'string' && typeof item.what === 'string');
  return parseSetToday(previous.text);
}

const OUTCOME = /\b(closed|done|dropped|carried|still open)\b/i;

/**
 * Which previous follow-ups the "Yesterday's follow-ups" section accounts for.
 * Each needs a line starting with its id and saying closed, dropped, carried
 * or still open.
 */
export function accountFor(text, previous) {
  const body = section(text, "### Yesterday's follow-ups") ?? '';
  const lines = body.split('\n');
  const missing = [];
  const unresolved = [];
  for (const item of previous) {
    const line = lines.find((candidate) => new RegExp(`^\\s*[-*]?\\s*\\**${item.id}\\b`).test(candidate));
    if (!line) missing.push(item.id);
    else if (!OUTCOME.test(line)) unresolved.push(item.id);
  }
  return { missing, unresolved };
}
