// Code checks on a written report against its facts pack (format spec
// section 10): every merged unit exactly once, team work marked, the code's
// own lines for every release run, deploy record and reviewed PR (and the
// record's outcome pinned wherever the prose names one), every citation in
// the pack, yesterday's follow-ups accounted for, banned words absent, size
// within limits.
import { accountFor, section } from './followups.mjs';
import { OWNED_FORMS, hasMarkup, hiddenNames, ownedKind, ownedSections, pinFacts, readLines, recordFacts, unpin } from './lines.mjs';
import { packText } from './pack.mjs';
import { bannedHits } from './scrub.mjs';

const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A PR ref, with an owner in front or not (acme/web#2): group 1 the owner, group 2 repo#N.
const PR_REF = /(?<![\w./-])(?:([A-Za-z0-9][\w.-]*)\/)?([A-Za-z0-9][\w.-]*#\d+)(?!\w)/g;
const COMMIT_REF = /(?<![\w/])([0-9a-f]{10})(?![\w])/g;

// The editor pointing at its input: "the pack shows", "not in the pack", "the facts pack".
const PACK_TALK = /\b(?:facts pack|(?:according to|based on|going by|in|from|by|per|inside|within) the pack|the pack's|the pack (?:(?:also|still|only|even|clearly|never|\w+ly) )?(?:\w+s|has|have|does|doesn't|did|didn't|is|isn't|was|wasn't|gave|showed|said|listed|recorded|held|noted|mentioned|confirmed|indicated|contained))\b/i;

// The mission's own GitHub owner, if it has one: acme/web#2 is web#2 there.
const ownerOf = (config) => config?.github?.owner?.toLowerCase() ?? null;

/** A PR ref match as the pack names it: repo#N for the mission's owner, owner/repo#N for any other. */
const prName = (config, match) => (match[1] && match[1].toLowerCase() !== ownerOf(config) ? `${match[1]}/${match[2]}` : match[2]);

/**
 * Occurrences of `ref` in `text`, as a whole token: with the mission's owner
 * in front (acme/web#2) or not. Another owner's repo of the same name is
 * another PR.
 */
export function countRef(text, ref, config = null) {
  const owner = config?.github?.owner;
  const prefix = owner && ref.includes('#') && !ref.includes('/') ? `(?:${escape(owner)}\\/)?` : '';
  return [...String(text).matchAll(new RegExp(`(?<![\\w./-])${prefix}${escape(ref)}(?!\\w)`, 'gi'))].filter((match) => match[0].slice(-ref.length) === ref).length;
}

/** The patterns (all global) that find a citation: PR refs, ticket ids, and commit refs for commit missions. */
function citationPatterns(config, unitKind) {
  const out = [PR_REF];
  if (config.ticketPrefixes.length) out.push(new RegExp(`\\b(?:${config.ticketPrefixes.map(escape).join('|')})-\\d+\\b`, 'g'));
  if (unitKind === 'commit') out.push(COMMIT_REF);
  return out;
}

/** Every PR ref, ticket id and (for commit missions) commit ref cited in `text`. */
export function citations(config, text, unitKind) {
  const out = new Set();
  for (const pattern of citationPatterns(config, unitKind)) {
    pattern.lastIndex = 0;
    for (const match of String(text).matchAll(pattern)) out.add(pattern === PR_REF ? prName(config, match) : (match[1] ?? match[0]));
  }
  return out;
}

// The section under the exact heading line `heading`, or null.
function sectionAt(text, heading) {
  const lines = String(text).split('\n');
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start < 0) return null;
  const level = /^#+/.exec(heading)[0].length;
  const end = lines.findIndex((line, i) => i > start && /^(#+)\s/.test(line) && /^#+/.exec(line)[0].length <= level);
  return lines.slice(start + 1, end < 0 ? lines.length : end).join('\n');
}

/** The headings a report of `kind` must have for this pack. */
export function layout(kind, pack) {
  const deployed = pack.releases.length > 0 || pack.deploys.length > 0;
  const reviews = pack.reviews.length > 0 || pack.triage.length > 0;
  if (kind === 'daily') {
    return {
      built: '## Built and fixed',
      deployed: deployed ? '## Deployed to dev' : null,
      reviews: reviews ? '## Reviews for the team' : null,
      required: [
        '## Headline',
        '## Built and fixed',
        ...(deployed ? ['## Deployed to dev'] : []),
        ...(reviews ? ['## Reviews for the team'] : []),
        '## Story arcs',
        '## Follow-ups',
        '### Set today',
        "### Yesterday's follow-ups",
        '## Ops, briefly',
      ],
    };
  }
  return {
    built: '#### Merged since',
    deployed: deployed ? '#### Deployed' : null,
    reviews: pack.reviews.length ? '#### Reviews' : null,
    required: [
      '#### Merged since',
      ...(deployed ? ['#### Deployed'] : []),
      ...(pack.reviews.length ? ['#### Reviews'] : []),
      '#### Arcs that moved',
      '#### Needs you',
    ],
  };
}

const sample = (items, max = 15) => `${items.slice(0, max).join(', ')}${items.length > max ? ` and ${items.length - max} more` : ''}`;

/**
 * Every ref the pack knows, from its typed fields (not only what the model's
 * text shows): merged units and their tickets, reviewed PRs, deploy records,
 * release carries, work items' PRs, triage tickets.
 */
export function packRefs(pack) {
  const out = new Set();
  for (const unit of pack.units) {
    out.add(unit.ref);
    for (const id of unit.tickets) out.add(id);
  }
  for (const [id, ticket] of Object.entries(pack.tickets ?? {})) {
    out.add(id);
    if (ticket.parent?.id) out.add(ticket.parent.id);
  }
  for (const review of pack.reviews) out.add(review.ref);
  for (const deploy of pack.deploys) for (const ref of deploy.prs) out.add(ref);
  for (const run of pack.releases) for (const ref of run.carried) out.add(ref);
  for (const item of [...pack.work.workItems, ...(pack.work.blocked ?? [])]) if (item.pr) out.add(item.pr);
  for (const issue of pack.triage) out.add(issue.id);
  return out;
}

// The start of a line, for an error message the editor can act on.
const quote = (line) => `"${line.trim().slice(0, 140)}${line.trim().length > 140 ? '...' : ''}"`;

/**
 * The code owns the release, deploy and review sections (lines.mjs): each
 * must hold exactly the code's lines, in their full or brief form, and
 * nothing else. Returns what differs.
 */
export function ownedProblems(config, pack, kind, text) {
  const shape = layout(kind, pack);
  const forms = OWNED_FORMS.map((form) => ownedSections(config, pack, kind, shape, form));
  const problems = [];
  forms[0].forEach((owned, i) => {
    // The section goes by its exact name at the code's level ("Reviews
    // backlog" is another section); one of them: a second could say anything.
    const key = ownedKind(owned.heading);
    const level = /^#+/.exec(owned.heading)[0].length;
    const headings = text.split('\n').filter((line) => /^(#+)\s/.test(line) && /^#+/.exec(line)[0].length === level && ownedKind(line) === key);
    if (!headings.length) return; // reported as a missing section
    const name = owned.heading.replace(/^#+\s*/, '');
    if (headings.length > 1) problems.push(`"${name}" appears ${headings.length} times; the code writes it once`);
    const said = sectionAt(text, headings[0].trim())
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    // The lines must be exactly one of the code's forms (full, brief, compact).
    const wants = forms.map((form) => form[i].lines.filter(Boolean));
    if (wants.some((want) => want.length === said.length && want.every((line, j) => line === said[j]))) return;
    // The first line no form has there, against the form that agrees longest.
    const agree = (want) => {
      let j = 0;
      while (j < said.length && j < want.length && said[j] === want[j]) j++;
      return j;
    };
    const want = wants.reduce((best, form) => (agree(form) > agree(best) ? form : best));
    const differs = agree(want);
    const theirs = differs < said.length ? quote(said[differs]) : 'nothing more';
    const ours = differs < want.length ? quote(want[differs]) : 'nothing more';
    problems.push(`"${name}" must hold only the code's lines; at line ${differs + 1} of it the text has ${theirs} where the code has ${ours}`);
  });
  return problems;
}

/**
 * The checks `text` fails, as plain sentences the editor can act on. Empty
 * means it passed.
 */
export function checkReport(config, pack, kind, text, { plain: codeWritten = false } = {}) {
  const errors = [];
  const limit = config.limits[kind];
  if (text.length > limit) errors.push(`The report is ${text.length} characters; the limit is ${limit}. Tighten the prose, keep every list line.`);

  const hits = bannedHits(text, config.banned);
  if (hits.length) errors.push(`Remove these words, which must not appear: ${sample(hits.map((hit) => `"${hit.match}" (line ${hit.line})`), 10)}.`);
  // The checks below read the text without the code's pinned record outcomes
  // (record text in a pin can hold refs, "done" and the like).
  const plain = unpin(text);
  // The reader never sees the pack, so the editor can't point at it. (Record
  // text can say "pack" for its own reasons, and the plain version is all
  // record text: that one isn't held to this.)
  const packTalk = codeWritten ? [] : plain.split('\n').flatMap((line, index) => (PACK_TALK.test(line) ? [index + 1] : []));
  if (packTalk.length) errors.push(`Don't mention the facts pack; the owner never sees it (lines ${sample(packTalk, 10)}). Say "nothing records it yet" or leave the point out.`);

  // Code blocks would hide record mentions from the pins (and a report has no use for them).
  const fences = plain.split('\n').flatMap((line, index) => (/^\s*(?:```|~~~)/.test(line) ? [index + 1] : []));
  if (fences.length) errors.push(`Don't use code blocks (lines ${sample(fences, 10)}); write plain sentences and lists.`);
  // Markup that renders a name the checks can't read (web&#35;2, web-dev\.1,
  // a link title, a look-alike letter), or a name split by emphasis
  // (web-*dev*.1): what the reader sees must be what was checked.
  const markup = plain.split('\n').flatMap((line, index) => (hasMarkup(line) ? [index + 1] : []));
  if (markup.length) errors.push(`Write plain text: no code spans, links, square brackets, backslashes, HTML or look-alike letters (lines ${sample(markup, 10)}).`);
  // Every tag, ref, ticket or commit the reader sees must be written exactly
  // so: one split by emphasis or an invisible character, or spelled in
  // full-width digits, would read as a name the checks never saw.
  const names = [...recordFacts(config, pack).map((fact) => fact.pattern), ...citationPatterns(config, pack.unitKind)];
  const hidden = plain.split('\n').flatMap((line, index) => (hiddenNames(line, names).length ? [index + 1] : []));
  if (hidden.length) errors.push(`Write tags and refs as plain text, with no emphasis or special characters inside them (lines ${sample(hidden, 10)}).`);
  // From here on the text is read as the reader sees it (bold or underscored refs count).
  const read = readLines(plain);

  const shape = layout(kind, pack);
  const missingSections = shape.required.filter((heading) => section(text, heading) === null);
  if (missingSections.length) errors.push(`Missing sections: ${missingSections.join(', ')}.`);

  const built = section(read, shape.built) ?? '';
  const missing = [];
  const repeated = [];
  const unmarked = [];
  for (const unit of pack.units) {
    const count = countRef(built, unit.ref, config);
    if (count === 0) missing.push(unit.ref);
    else if (count > 1) repeated.push(unit.ref);
    else if (!unit.ours && pack.unitKind === 'pr') {
      const line = built.split('\n').find((candidate) => countRef(candidate, unit.ref, config) > 0) ?? '';
      if (!/\bteam\b/i.test(line)) unmarked.push(unit.ref);
    }
  }
  if (missing.length) errors.push(`These merged ${pack.unitKind === 'pr' ? 'PRs' : 'commits'} are missing from "${shape.built.replace(/^#+\s*/, '')}" (each must appear exactly once, by its exact ref): ${sample(missing, 500)}.`);
  if (repeated.length) errors.push(`These appear more than once in "${shape.built.replace(/^#+\s*/, '')}"; keep each on one line only: ${sample(repeated)}.`);
  if (unmarked.length) errors.push(`These are the team's PRs; their lines must say "(team: <name>)": ${sample(unmarked)}.`);

  const units = new Set(pack.units.map((unit) => unit.ref));
  // The update's closing part repeats the labels the previous report left open.
  const previousLabels = (pack.previous?.open ?? []).map((item) => item.label).join('\n');
  // The pack read the same way: record text the code flattens into the report
  // (CRP-**13561** in an answer comes out as CRP-13561) is still known.
  const known = new Set([...packRefs(pack), ...citations(config, readLines(`${packText(config, pack)}\n${previousLabels}`), pack.unitKind)]);
  const extra = [...citations(config, built, pack.unitKind)].filter((ref) => !units.has(ref) && (ref.includes('#') || pack.unitKind === 'commit') && !/^[A-Z]+-\d+$/.test(ref));
  if (extra.length) errors.push(`"${shape.built.replace(/^#+\s*/, '')}" lists refs that were not merged in this window: ${sample(extra)}. Move them to the story arcs or drop them.`);
  const unknown = [...citations(config, read, pack.unitKind)].filter((ref) => !known.has(ref));
  if (unknown.length) errors.push(`These refs are not in the facts pack; use only refs the pack gives, written exactly: ${sample(unknown)}.`);
  if (pack.unitKind === 'pr') {
    // Lane messages use short names (risk#171, BO#352); the owner reads full repo names.
    const repos = new Set([
      ...config.areas.flatMap((area) => area.repos),
      ...pack.units.map((unit) => unit.repo),
      ...pack.reviews.map((review) => review.ref.split('#')[0]),
      ...pack.deploys.map((deploy) => deploy.repo),
      ...pack.releases.map((run) => run.repo).filter(Boolean),
      ...[...packRefs(pack)].filter((ref) => ref.includes('#')).map((ref) => ref.split('#')[0]),
    ]);
    const short = [...citations(config, read, pack.unitKind)].filter((ref) => ref.includes('#') && !repos.has(ref.split('#')[0]));
    if (short.length) errors.push(`Write PR refs with the full repo name the pack uses for them, not a short name: ${sample(short)}.`);
  }

  const owned = ownedProblems(config, pack, kind, text);
  if (owned.length) errors.push(`The release, deploy and review lists are the code's: ${sample(owned, 10)}.`);
  // Everywhere else, each mention of a release tag, deploy or reviewed PR
  // carries the record's outcome, pinned by the code.
  const said = text.split('\n');
  const unpinned = pinFacts(config, pack, text, kind, shape)
    .split('\n')
    .flatMap((line, index) => (line !== said[index] ? [index + 1] : []));
  if (unpinned.length) errors.push(`The record outcomes the code pins after release tags and reviewed PRs are missing or changed (lines ${sample(unpinned, 10)}).`);

  if (kind === 'daily') {
    const followUps = pack.previous?.followUps ?? [];
    if (followUps.length) {
      const { missing: notListed, unresolved } = accountFor(read, followUps);
      if (notListed.length) errors.push(`"Yesterday's follow-ups" must have one line per item, starting with its id: missing ${notListed.join(', ')}.`);
      if (unresolved.length) errors.push(`Say for each of these whether it is closed, dropped, carried or still open, and why: ${unresolved.join(', ')}.`);
    }
  }
  return errors;
}
