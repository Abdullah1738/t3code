// The sections the code writes itself, straight from the records: one line
// per release run and deploy record under "Deployed", one per reviewed PR
// (plus the QA triage list) under "Reviews". The editor doesn't write them;
// `withOwned` puts them into its text, so what a report says about a single
// run, deploy or review is never the model's wording.
import { redact } from './scrub.mjs';
import { clock } from './time.mjs';

// Characters that show nothing but can split a name: every default-ignorable,
// format and control character (soft hyphen, zero-width and joiner marks,
// bidi controls, variation selectors, NUL...), except the whitespace ones.
const INVISIBLE_CHAR = '(?![\\t\\n\\v\\f\\r])[\\p{Default_Ignorable_Code_Point}\\p{Cc}\\p{Cf}]';
const INVISIBLE = new RegExp(INVISIBLE_CHAR, 'gu');
const IS_INVISIBLE = new RegExp(`^${INVISIBLE_CHAR}$`, 'u');
// A combining mark on a plain ASCII character (no precomposed form): it
// decorates a name's letter or digit without changing what the checks read.
const MARKED = /(?<=[\x21-\x7e])\p{M}+/gu;
// Emphasis: the "*", "_" and "~" runs a Markdown renderer pairs up and
// hides (CommonMark's flanking rules; "~" pairs only with a run of the same
// length, one or two, as GitHub's strikethrough). A run nothing pairs with
// is literal text and stays: 2*3 ms, ~5 ms, snake_case, api_#1.
const SPACE = /\s/u;
const PUNCT = /[\p{P}\p{S}]/u;
// The character before / at a code-unit index, whole (surrogate pairs kept).
const charBefore = (text, index) => (index > 0 ? [...text.slice(Math.max(0, index - 2), index)].pop() : undefined);
const charAt = (text, index) => (index < text.length ? String.fromCodePoint(text.codePointAt(index)) : undefined);

/** The indices of `text` (one line) that are emphasis markers a renderer hides. */
export function emphasisMarks(text) {
  const marks = new Set();
  const stack = [];
  const space = (ch) => ch === undefined || SPACE.test(ch);
  const punct = (ch) => ch !== undefined && PUNCT.test(ch);
  for (const match of String(text).matchAll(/\*+|_+|~+/g)) {
    const ch = match[0][0];
    const length = match[0].length;
    if (ch === '~' && length > 2) continue;
    const before = charBefore(text, match.index);
    const after = charAt(text, match.index + length);
    const left = !space(after) && (!punct(after) || space(before) || punct(before));
    const right = !space(before) && (!punct(before) || space(after) || punct(after));
    const run = {
      ch,
      start: match.index,
      length,
      left: length, // markers still free at the run's inner end (an opener's right, a closer's left)
      used: 0,
      open: ch === '_' ? left && (!right || punct(before)) : left,
      close: ch === '_' ? right && (!left || punct(after)) : right,
    };
    while (run.close && run.left > 0) {
      const at = stack.findLastIndex((opener) => {
        if (opener.ch !== ch || opener.left === 0) return false;
        if (ch === '~') return opener.length === run.length;
        // CommonMark's rule of three, for runs that can both open and close.
        const both = (opener.open && opener.close) || (run.open && run.close);
        return !(both && (opener.length + run.length) % 3 === 0 && (opener.length % 3 !== 0 || run.length % 3 !== 0));
      });
      if (at === -1) break;
      const opener = stack[at];
      const take = ch === '~' ? run.left : Math.min(2, opener.left, run.left);
      for (let k = 0; k < take; k++) {
        marks.add(opener.start + opener.used + opener.left - 1 - k);
        marks.add(run.start + run.used + k);
      }
      opener.left -= take;
      run.left -= take;
      run.used += take;
      // Openers between the pair can't pair any more.
      stack.splice(at + (opener.left > 0 ? 1 : 0));
    }
    if (run.open && run.left > 0) stack.push(run);
  }
  return marks;
}

/** `text` without the emphasis markers a renderer would hide. */
const unemphasized = (text) => {
  const marks = emphasisMarks(text);
  if (!marks.size) return text;
  let out = '';
  for (let i = 0; i < text.length; i++) if (!marks.has(i)) out += text[i];
  return out;
};

/**
 * A line folded the way a reader takes it, with where each part came from:
 * each character with its combining marks in compatibility form (a
 * full-width digit or hash is a plain one, a small asterisk an asterisk),
 * then invisible characters and marks left on a plain ASCII character
 * dropped. `flat` and `reading` both start here, so record text and the
 * report are read the same way.
 */
function folded(raw) {
  let text = '';
  const at = [];
  for (const cluster of raw.matchAll(/\P{M}\p{M}*|\p{M}+/gu)) {
    // Marks on a plain ASCII character go before composing (e + accent would
    // compose to é and pass for another name); on anything else, after folding
    // (a full-width ７ folds to 7, and its mark then sits on plain ASCII).
    const base = cluster[0].codePointAt(0);
    const form = base >= 0x21 && base <= 0x7e ? String.fromCodePoint(base) : cluster[0].normalize('NFKC');
    for (const ch of form) {
      if (IS_INVISIBLE.test(ch)) continue;
      if (/^\p{M}$/u.test(ch) && /[\x21-\x7e]$/.test(text)) continue;
      text += ch;
      for (let k = 0; k < ch.length; k++) at.push(cluster.index);
    }
  }
  return { text, at };
}

// Greek or Cyrillic letters that pass for Latin ones (the micro sign and mu
// in units like 3μs don't).
const LOOKALIKE = /(?![\u00b5\u03bc])[\p{Script=Greek}\p{Script=Cyrillic}]/u;
const LOOKALIKES = new RegExp(LOOKALIKE.source, 'gu');
// A name-shaped token (letters, digits, ".", "_", "#", "-"; "/", "=" and the
// like split tokens) with a digit or "#" that mixes Latin letters with those
// look-alikes: it reads as a known name and isn't one.
const TOKEN = /[\p{L}\p{N}\p{M}._#-]+/gu;
const mixed = (token) => /[#\d]/.test(token) && /[A-Za-z]/.test(token) && LOOKALIKE.test(token);

/**
 * Record text as one plain line the report can carry as is: no newline to
 * start a heading, list line or code block, and none of the Markdown or
 * HTML (code spans, links, brackets, tags, entities, escapes, emphasis,
 * invisible characters, marks or look-alikes on a name) that could hide or
 * split a name in it. The checks refuse the same markup in the editor's
 * text (`hasMarkup`).
 */
export const flat = (config, text) => {
  let out = String(text ?? '');
  // Each pass can uncover something for the next (a look-alike turned "?"
  // after "<", emphasis that pairs once another pair is gone); a few passes
  // reach text that a pass leaves as it is.
  for (let pass = 0; pass < 6; pass++) {
    const next = flatPass(config, out);
    if (next === out) break;
    out = next;
  }
  return out;
};

const flatPass = (config, text) =>
  unemphasized(
    redact(folded(text).text, config.banned)
      .replace(/\\/g, '/')
      .replace(/`/g, "'")
      .replace(/\[/g, '(')
      .replace(/\]/g, ')')
      .replace(/&(?=#|[A-Za-z][A-Za-z0-9]*;)/g, '& ')
      .replace(/<(?=[A-Za-z!/?])/g, '< ')
      .replace(/\s+/g, ' ')
      // Look-alikes once nothing more joins tokens (v2*β* is v2β).
      .replace(TOKEN, (token) => (mixed(token) ? token.replace(LOOKALIKES, '?') : token)),
  ).trim();

/**
 * Markup a report may not use, outside the code's own pins: code spans,
 * links and other square brackets, backslash escapes, HTML tags and
 * entities, invisible characters, combining marks on plain letters and
 * digits, and name-shaped words mixing Latin letters with Greek or Cyrillic
 * look-alikes. Each can hide a name from the pins and the citation checks,
 * or show the reader something the text doesn't say.
 */
const MARKUP = [/[`\\[\]]/, /&(?:#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);/i, /<[a-z!/?]/i, new RegExp(INVISIBLE_CHAR, 'u')];

/** Whether `line` (without the code's pins) uses markup a report may not. */
export const hasMarkup = (line) => {
  const text = String(line).normalize('NFC');
  MARKED.lastIndex = 0;
  return MARKUP.some((re) => re.test(text)) || MARKED.test(text) || (text.match(TOKEN) ?? []).some(mixed);
};

/**
 * A line as the reader sees it, with where each part of it sits in the line
 * as written: invisible characters gone, compatibility forms folded (a
 * full-width hash is a hash, a small asterisk an asterisk), then emphasis
 * markers gone, in the same order `flat` takes. `text` is what is read;
 * `at[i]` is the index in `line` of the character that `text[i]` came from,
 * and `span(start, end)` the part of `line` that `text.slice(start, end)`
 * came from, with any emphasis or invisible characters right after it.
 */
export function reading(line) {
  const raw = String(line);
  const first = folded(raw);
  // Emphasis markers out, judged on the folded text (so ＊ and ﹡ count).
  const marks = emphasisMarks(first.text);
  let text = '';
  const at = [];
  for (let i = 0; i < first.text.length; i++) {
    if (marks.has(i)) continue;
    text += first.text[i];
    at.push(first.at[i]);
  }
  const kept = new Set(at);
  // `past`: carry on over a closing emphasis marker, invisible character or
  // the rest of a character's marks.
  const span = (start, end, past = true) => {
    const from = at[start];
    const last = at[end - 1];
    let to = last + String.fromCodePoint(raw.codePointAt(last)).length;
    while (past && to < raw.length && !kept.has(to)) to++;
    return [from, to];
  };
  return { text, at, span };
}

/** A line as the reader sees it (`reading(line).text`). */
export const asRead = (line) => reading(line).text;

/** Every line of `text` as the reader sees it. */
export const readLines = (text) => String(text).split('\n').map(asRead).join('\n');

/**
 * The names in `line` (matches of `patterns`, all global, on the line as
 * read) that are not written there exactly as read: split by emphasis or an
 * invisible character, or spelled with full-width or other compatibility
 * forms (web-*dev*.2, web＃2, CRP-**9999**). Each would read as a known name
 * the checks never saw.
 */
export function hiddenNames(line, patterns) {
  const read = reading(line);
  if (read.text === line) return [];
  const out = [];
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    for (const match of read.text.matchAll(pattern)) {
      const [from, to] = read.span(match.index, match.index + match[0].length, false);
      if (String(line).slice(from, to) !== match[0]) out.push(match[0]);
    }
  }
  return out;
}

/** Whether the run's carried PRs were looked up (a failed lookup says nothing about them). */
export const carriedKnown = (run) => run.carriedKnown ?? (run.carried.length > 0 || Boolean(run.previousTag));

/** "- <tag> HH:MM: carried a, b. Proven: the runtime check passed." */
export function releaseLine(config, run) {
  const name = run.tag ?? (run.service ? `${run.service} (no tag recorded)` : 'A release run with no tag recorded');
  const carried = !carriedKnown(run) ? 'what it carried is unknown' : run.carried.length ? `carried ${run.carried.join(', ')}` : `no merged PRs since ${run.previousTag}`;
  const runtime =
    run.conclusion !== 'success'
      ? 'Not proven: the run did not succeed'
      : run.runtimeChecked === null
        ? 'Not proven: no runtime check in the run'
        : run.runtimeChecked
          ? 'Proven: the runtime check passed'
          : `Not proven: the runtime check failed (${flat(config, run.runtimeFailures.join(', '))})`;
  const outcome = run.conclusion === 'success' ? '' : run.conclusion === 'failure' ? ' The run failed.' : ` The run ended ${run.conclusion ?? 'without a result'}.`;
  return `- ${flat(config, name)} ${clock(run.at, config.zone)}: ${carried}. ${runtime}.${flat(config, outcome) ? ` ${flat(config, outcome)}` : ''}`;
}

/** "- <repo> <tag> HH:MM: failed, PRs a, b. <outcome>. Failure: <why>. Read back: not recorded." */
export function deployLine(config, deploy, brief = false) {
  const prs = deploy.prs.length ? `, PRs ${deploy.prs.join(', ')}` : '';
  const outcome = flat(config, deploy.outcome) && !brief ? `. ${flat(config, deploy.outcome)}` : '';
  const failure = flat(config, deploy.failure) && !brief ? `. Failure: ${flat(config, deploy.failure)}` : '';
  const observed = flat(config, deploy.observed) || 'not recorded';
  return `- ${flat(config, deploy.repo)}${deploy.tag ? ` ${flat(config, deploy.tag)}` : ''} ${clock(deploy.at, config.zone)}: ${flat(config, deploy.status)}${prs}${outcome}${failure}. Read back: ${observed}.`;
}

/** Review decisions grouped per PR: "- repo#N (Name): verdict HH:MM, verdict HH:MM. gist" */
export function reviewLines(config, pack, brief = false) {
  const byPr = new Map();
  for (const review of pack.reviews) {
    const list = byPr.get(review.ref) ?? [];
    list.push(review);
    byPr.set(review.ref, list);
  }
  if (brief === 'compact') {
    // Tightest form: PRs grouped by the verdicts they got, without times.
    const groups = new Map();
    for (const [ref, rounds] of byPr) {
      const verdicts = flat(config, rounds.map((round) => round.verdict).join(', '));
      groups.set(verdicts, [...(groups.get(verdicts) ?? []), `${ref} (${flat(config, rounds.at(-1).person) || 'unknown author'})`]);
    }
    return [...groups].map(([verdicts, prs]) => `- ${verdicts}: ${prs.join(', ')}.`);
  }
  return [...byPr].map(([ref, rounds]) => {
    const last = rounds.at(-1);
    const verdicts = rounds.map((round) => `${round.verdict} ${clock(round.at, config.zone)}`).join(', ');
    const gist = flat(config, last.gist) && !brief ? ` ${flat(config, last.gist)}` : '';
    return `- ${ref} (${flat(config, last.person) || 'unknown author'}): ${flat(config, verdicts)}.${gist}`;
  });
}

/** One line per ticket that moved through the QA triage project. */
export function triageLines(config, pack) {
  return pack.triage.map((issue) => {
    const moves = issue.moves.map((move) => `${move.from ?? 'none'} to ${move.to ?? 'none'} ${clock(move.at, config.zone)}`).join(', ');
    const where = [issue.state, issue.project ? `in ${issue.project}` : ''].filter(Boolean).join(' ');
    return `- ${issue.id} ${flat(config, issue.title)}: ${where ? `${flat(config, where)} at the end of the day` : 'moved'}${moves ? ` (${flat(config, moves)})` : ''}.`;
  });
}

// The full heading the code writes when the editor left a section out.
const HEADINGS = {
  daily: { deployed: '## Deployed to dev', reviews: '## Reviews for the team' },
  update: { deployed: '#### Deployed and read back', reviews: '#### Reviews done' },
};

/**
 * The sections whose item lines the code owns, for a report of `kind` with
 * headings `shape` (checks.mjs `layout`): [{match, heading, lines}], where
 * `match` finds the section, `heading` is written when it is missing and
 * `lines` are the code's lines for it. `brief` drops the free-text parts
 * (deploy outcomes, review gists) to fit a size limit; 'compact' also groups
 * the reviewed PRs by their verdicts.
 */
export const OWNED_FORMS = [false, true, 'compact'];

export function ownedSections(config, pack, kind, shape, brief = false) {
  const out = [];
  if (shape.deployed) {
    const lines = pack.releases.map((run) => releaseLine(config, run));
    if (pack.deploys.length) {
      if (lines.length) lines.push('');
      lines.push('Deploy records from the review workflow:', ...pack.deploys.map((deploy) => deployLine(config, deploy, Boolean(brief))));
    }
    out.push({ match: shape.deployed, heading: HEADINGS[kind].deployed, lines });
  }
  if (shape.reviews) {
    const lines = reviewLines(config, pack, brief);
    if (kind === 'daily' && pack.triage.length) {
      if (lines.length) lines.push('');
      lines.push('Human QA triage:', ...triageLines(config, pack));
    }
    // Nothing records requests from other teams yet.
    if (kind === 'daily') lines.push('', "Other teams' requests: none recorded.");
    out.push({ match: shape.reviews, heading: HEADINGS[kind].reviews, lines });
  }
  return out;
}

// Where the code's sections go: before the arcs.
const ANCHOR = { daily: '## Story arcs', update: '#### Arcs that moved' };

const headingAt = (line) => /^(#+)\s+(.*)$/.exec(line);
const isHeading = (line, heading) => {
  const match = headingAt(line);
  const level = /^#+/.exec(heading)[0].length;
  return Boolean(match) && match[1].length === level && match[2].trim().toLowerCase().startsWith(heading.replace(/^#+\s*/, '').toLowerCase());
};

// Headings that mean one of the code's sections, at its level: the editor's
// own take on them goes. Other headings ("Review backlog", "Release risks")
// and other levels stay; what they say about single records gets pinned
// like any prose.
const OWNED_NAMES = new Set([
  'deployed',
  'deployed to dev',
  'deployed and read back',
  'deploys',
  'deployments',
  'dev deploys',
  'releases',
  'release runs',
  'reviews',
  'reviews done',
  'reviews for the team',
  'team reviews',
]);
const headingName = (text) =>
  text
    .replace(/\*+/g, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/[^a-z ]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
export const isOwnedHeading = (line) => {
  const match = headingAt(line);
  return Boolean(match) && OWNED_NAMES.has(headingName(match[2]));
};

/**
 * Which of the code's sections a heading names ('deployed' or 'reviews'),
 * by exact name, or null ("Reviews backlog" and "Deployed risks" are not one).
 */
export const ownedKind = (line) => {
  if (!isOwnedHeading(line)) return null;
  return /^(?:review|team review)/.test(headingName(headingAt(line)[2])) ? 'reviews' : 'deployed';
};

const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** What became of each run under a tag, in a few words (no refs, no tags). */
const runFact = (run) => {
  if (run.conclusion !== 'success') return `run ${run.conclusion === 'failure' ? 'failed' : run.conclusion === 'cancelled' ? 'cancelled' : 'unfinished'}, nothing proven`;
  if (run.runtimeChecked === true) return 'run succeeded, runtime check passed';
  if (run.runtimeChecked === false) return 'run succeeded, runtime check failed';
  return 'run succeeded, no runtime check';
};

/**
 * The record facts the code pins next to every mention of a release tag, a
 * reviewed PR or a PR an untagged deploy record carried, outside the code's
 * own sections: [{name, pattern, fact}]. The prose can't change what a run,
 * deploy or review came to; the reader sees the record's outcome right where
 * the prose names it.
 */
export function recordFacts(config, pack) {
  const tags = new Map();
  const refs = new Map();
  const add = (map, name, fact) => {
    if (!name) return;
    const list = map.get(name) ?? [];
    if (!list.includes(fact)) list.push(fact);
    map.set(name, list);
  };
  // Record text inside a pin: one line, no square brackets to end it early.
  const clean = (text) => flat(config, text);
  // What was read back, in the record's words (cut, and said so, past 120 characters).
  const observed = (deploy) => {
    const text = clean(deploy.observed);
    return text.length > 120 ? `${text.slice(0, 120).trimEnd()}...` : text;
  };
  const deployFact = (deploy) => `deploy record ${clean(deploy.status)}, ${observed(deploy) ? `read back: ${observed(deploy)}` : 'nothing read back'}`;
  for (const run of pack.releases) add(tags, run.tag, runFact(run));
  for (const deploy of pack.deploys) {
    if (deploy.tag) add(tags, deploy.tag, deployFact(deploy));
    for (const ref of deploy.prs) add(refs, ref, deployFact(deploy));
  }
  const verdicts = new Map();
  for (const review of pack.reviews) add(verdicts, review.ref, clean(review.verdict));
  for (const [ref, list] of verdicts) add(refs, ref, `review: ${list.filter(Boolean).join(', ')}`);
  const out = [];
  // A tag ends where a name can't go on: not inside web#2 for a tag "web", nor web-dev.10 for web-dev.1.
  for (const [tag, facts] of tags) out.push({ name: tag, pattern: new RegExp(`(?<![\\w.-])${escape(tag)}(?![\\w#\\\\-]|\\.\\w)`, 'g'), fact: facts.join('; ') });
  // A PR ref also counts with the mission's owner in front (acme/web#2) or an
  // escaped hash (web\#2). Another owner's repo of the same name is another PR.
  // GitHub owners don't care about case (ACME/web#2 is acme/web#2); repo names here are exact.
  const anyCase = (text) => [...text].map((ch) => (/[a-z]/i.test(ch) ? `[${ch.toLowerCase()}${ch.toUpperCase()}]` : escape(ch))).join('');
  const owner = config.github?.owner ? `(?:${anyCase(config.github.owner)}/)?` : '';
  for (const [ref, facts] of refs) {
    const [repo, number] = ref.split('#');
    out.push({ name: ref, pattern: new RegExp(`(?<![\\w./-])${owner}${escape(repo)}\\\\?#${number}(?!\\w)`, 'g'), fact: facts.join('; ') });
  }
  return out;
}

const PIN = / \[record: [^\]\n]*\]/g;

/** `text` without the pinned record outcomes. */
export const unpin = (text) => String(text).replace(PIN, '');

// A bare URL: a pin can't go inside one, so it goes right after it. (Code
// spans, links and other markup are refused in a report: `hasMarkup`.)
const SPANS = /https?:\/\/[^\s<>()]+/g;

// One line with every mention pinned: " [record: <facts>]" after each one
// (after closing emphasis, or after a URL holding it), several mentions at
// one place sharing a pin. Mentions are found in the line as the reader sees
// it (`reading`), so emphasis or an invisible character can't hide one.
function pinLine(raw, facts) {
  const line = unpin(raw);
  const read = reading(line);
  const spans = [...line.matchAll(SPANS)].map((match) => [match.index, match.index + match[0].length]);
  const found = [];
  for (const { pattern, fact } of facts) {
    pattern.lastIndex = 0;
    for (const match of read.text.matchAll(pattern)) {
      const [start, end] = read.span(match.index, match.index + match[0].length);
      found.push({ start, end, fact });
    }
  }
  // Longer mentions first: a name found strictly inside a longer one (web
  // inside web-dev.1) is part of it, not a mention of its own. Two names on
  // the same span (a tag that is also a reviewed PR's ref) share one pin.
  found.sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start);
  const taken = [];
  const at = new Map();
  for (const mention of found) {
    const same = (other) => other.start === mention.start && other.end === mention.end;
    const inside = (other) => !same(other) && mention.start >= other.start && mention.end <= other.end;
    if (taken.some(inside)) continue;
    if (!taken.some(same)) taken.push(mention);
    let end = mention.end;
    const span = spans.find(([from, to]) => mention.start < to && end > from);
    if (span) end = Math.max(end, span[1]);
    const list = at.get(end) ?? [];
    if (!list.includes(mention.fact)) list.push(mention.fact);
    at.set(end, list);
  }
  let out = line;
  for (const end of [...at.keys()].sort((a, b) => b - a)) out = `${out.slice(0, end)} [record: ${at.get(end).join('; ')}]${out.slice(end)}`;
  return out;
}

// The headings of the sections the code writes for this report (`shape` from checks.mjs `layout`).
const codeHeadings = (kind, shape) =>
  new Set(
    Object.entries(HEADINGS[kind] ?? {})
      .filter(([key]) => shape?.[key])
      .map(([, heading]) => heading),
  );

/**
 * Pins the record's outcome, " [record: run failed, nothing proven]", after
 * every mention of a release tag, a reviewed PR or a PR a deploy record
 * carried, on every line (headings too) outside the sections the code writes
 * itself, replacing any such pin already there. Idempotent.
 */
export function pinFacts(config, pack, text, kind, shape) {
  const facts = recordFacts(config, pack);
  // Only the first section under each of the code's headings is the code's
  // (a second one is refused by the checks, and gets pinned like prose).
  const skip = codeHeadings(kind, shape);
  const lines = String(text).split('\n');
  let skipping = 0;
  let fenced = false;
  for (let i = 0; i < lines.length; i++) {
    // Code blocks are left as written (the checks refuse them in a report).
    if (/^\s*(?:```|~~~)/.test(lines[i])) fenced = !fenced;
    if (fenced || /^\s*(?:```|~~~)/.test(lines[i])) continue;
    const heading = headingAt(lines[i]);
    if (heading) {
      const level = heading[1].length;
      if (skipping && level <= skipping) skipping = 0;
      if (!skipping && skip.has(lines[i].trim())) {
        skip.delete(lines[i].trim());
        skipping = level;
        continue;
      }
    }
    if (skipping) continue;
    // With no records, pins the editor wrote still go: only the code pins.
    lines[i] = facts.length ? pinLine(lines[i], facts) : unpin(lines[i]);
  }
  return lines.join('\n');
}

/**
 * The editor's `body` with the code's sections in place: a section the
 * editor wrote at their level under one of their names is dropped, and the
 * code's go just before the arcs (at the end when there are no arcs). Then
 * every other mention of a release tag, deploy or reviewed PR gets the
 * record's outcome pinned to it. Idempotent.
 */
export function withOwned(config, pack, kind, shape, body, brief = false) {
  return pinFacts(config, pack, placeOwned(config, pack, kind, shape, body, brief), kind, shape);
}

function placeOwned(config, pack, kind, shape, body, brief) {
  const owned = ownedSections(config, pack, kind, shape, brief);
  if (!owned.length) return body;
  // Only at the code's own level: a "### Releases" area in the built list stays.
  const ownLevel = /^#+/.exec(HEADINGS[kind].deployed)[0].length;
  const replaced = (line) => isOwnedHeading(line) && headingAt(line)[1].length === ownLevel;
  let lines = String(body).split('\n');
  for (let start = lines.findIndex(replaced); start >= 0; start = lines.findIndex(replaced)) {
    const level = headingAt(lines[start])[1].length;
    let end = lines.findIndex((line, i) => i > start && (headingAt(line)?.[1].length ?? Infinity) <= level);
    if (end < 0) end = lines.length;
    lines = [...lines.slice(0, start), ...lines.slice(end)];
  }
  const block = owned.flatMap(({ heading, lines: own }) => [heading, ...own, '']);
  let at = lines.findIndex((line) => isHeading(line, ANCHOR[kind]));
  if (at < 0) {
    while (lines.length && !lines.at(-1).trim()) lines.pop();
    return [...lines, '', ...block].join('\n').trimEnd();
  }
  return [...lines.slice(0, at), ...block, ...lines.slice(at)].join('\n');
}
