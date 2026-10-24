// Free text from logs and records names tools, models and internal keys the
// reports must not carry. Sentences that match a banned pattern are dropped.

const SENTENCE = /[^.!?\n]+(?:[.!?]+|\n|$)/g;

const hits = (text, banned) =>
  banned.some((re) => {
    re.lastIndex = 0;
    return re.test(text);
  });

/** `text` without the sentences matching `banned`, cut to `max` chars. */
export function scrub(text, banned, max = Infinity) {
  const value = String(text ?? '').trim();
  if (!value) return '';
  const kept = banned.length ? (value.match(SENTENCE) ?? []).filter((sentence) => !hits(sentence, banned)).join('') : value;
  const out = kept.replace(/\s+/g, ' ').trim();
  return out.length > max ? `${out.slice(0, max).trimEnd()}...` : out;
}

/** `text` with every banned match replaced by "...": for labels and titles the code writes itself. */
export function redact(text, banned) {
  let out = String(text ?? '');
  for (const re of banned) {
    re.lastIndex = 0;
    out = out.replace(re, '...');
  }
  return out;
}

/** `text` with short repo names in PR refs written out: {risk: 'risk-engine'} turns risk#12 into risk-engine#12. */
export function expand(text, aliases = {}) {
  const names = Object.keys(aliases);
  if (!names.length) return String(text ?? '');
  const escaped = names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).sort((a, b) => b.length - a.length);
  const re = new RegExp(`(?<![\\w./-])(${escaped.join('|')})#(\\d+)(?!\\w)`, 'g');
  return String(text ?? '').replace(re, (_, name, number) => `${aliases[name]}#${number}`);
}

/** Every banned match in `text`, as {pattern, match, line}. */
export function bannedHits(text, banned) {
  const out = [];
  const lines = String(text).split('\n');
  for (const re of banned) {
    lines.forEach((line, index) => {
      re.lastIndex = 0;
      for (const match of line.matchAll(re)) out.push({ pattern: re.source, match: match[0], line: index + 1 });
    });
  }
  return out;
}
