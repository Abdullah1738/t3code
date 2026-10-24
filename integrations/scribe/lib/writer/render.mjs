// The parts of a report the code writes itself: the title and window line,
// the closing "Left hanging" and "Usage" parts of an update, and the plain
// fallback body used when the editor's text fails its checks twice.
import { countRef, layout } from './checks.mjs';
import { flat, unpin, withOwned } from './lines.mjs';
import { byArea } from './pack.mjs';
import { clock, longDay, parts, stamp, zoneLabel } from './time.mjs';

const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

const unitNoun = (pack, count) => plural(count, pack.unitKind === 'pr' ? 'PR' : 'commit');

/** The merged/reviews/releases sentence both headers share. */
function countsLine(pack, kind) {
  const { counts } = pack;
  const merged =
    pack.unitKind === 'pr'
      ? `Merged: ${unitNoun(pack, counts.merged)} (${counts.ours} built by us, ${counts.team} by the team).`
      : `Merged: ${unitNoun(pack, counts.merged)}${counts.team ? ` (${counts.ours} ours, ${counts.team} by others)` : ''}.`;
  const parts_ = [merged];
  if (pack.reviews.length) parts_.push(`Team reviews: ${plural(counts.reviews, 'decision')} on ${unitNoun({ unitKind: 'pr' }, counts.reviewedPrs)}.`);
  if (pack.releases.length) parts_.push(`${kind === 'daily' ? 'Dev deploys' : 'Releases'}: ${plural(counts.releases, 'release run')} (${counts.releasesOk} succeeded).`);
  return parts_.join(' ');
}

const sameDay = (a, b, zone) => {
  const x = parts(a, zone);
  const y = parts(b, zone);
  return x.year === y.year && x.month === y.month && x.day === y.day;
};

/**
 * The title and window line. A daily is titled by the day it covers; an
 * update by its time range (its `###` heading is what the running update file
 * dedupes on).
 */
export function reportHeader(config, pack, kind) {
  const zone = config.zone;
  const label = zoneLabel(zone);
  const { from, to } = pack.window;
  if (kind === 'daily') {
    return [`# ${flat(config, pack.mission.title)} daily, ${longDay(from, zone)} (${label} day)`, '', `_Window: ${stamp(from, zone)} to ${stamp(to, zone)} ${label} time. ${countsLine(pack, kind)}_`].join('\n');
  }
  // An update that ends exactly at midnight still reads as the same day.
  const end = new Date(Date.parse(to) - 1).toISOString();
  const range = sameDay(from, end, zone) ? `${stamp(from, zone)} to ${clock(to, zone)}` : `${stamp(from, zone)} to ${stamp(to, zone)}`;
  return [`### ${flat(config, pack.mission.title)} update, ${range} ${label}`, '', `_${countsLine(pack, kind)}_`].join('\n');
}

/**
 * The closing parts of an update: what changed among the items the previous
 * update left open (changed ones only, plus a count of the rest), and usage.
 */
export function updateTail(config, pack, hang, usage) {
  const zone = config.zone;
  const lines = [];
  if (pack.previous) {
    lines.push(`#### Left hanging from ${clock(pack.previous.coversTo, zone)}`);
    if (hang.changed.length) for (const item of hang.changed) lines.push(`- **${flat(config, item.label)}:** ${flat(config, item.outcome)}`);
    else lines.push('- Nothing that was open has changed.');
    if (hang.unchanged) {
      lines.push(
        `- Still open from before: ${hang.unchanged}${hang.longOpen ? `, ${hang.longOpen} of them for more than 12 hours` : ''}. The mission desk lists them.`,
      );
    }
    lines.push('');
  }
  lines.push('#### Usage');
  const scribe = pack.work.usage;
  const n = (value) => Number(value ?? 0).toLocaleString('en-US');
  lines.push(`- Note taking: ${plural(scribe.batches, 'batch', 'batches')}, ${n(scribe.inputTokens)} tokens in, ${n(scribe.outputTokens)} out.`);
  lines.push(usage && (usage.input || usage.output) ? `- This update: ${n(usage.input)} tokens in, ${n(usage.output)} out.` : '- This update: no model call.');
  return lines.join('\n');
}

// One list line for a merged unit: "- ref (TICKET-1) title. HH:MM", marked
// when it is the team's.
const unitLine = (config, pack, unit, titleMax = Infinity, reviewedMark = true) => {
  const tickets = unit.tickets.length ? ` (${unit.tickets.join(', ')})` : '';
  // The tightest plain version leaves "reviewed by us" to the review pin.
  const team = unit.ours ? '' : ` (team: ${flat(config, unit.person)}${unit.reviewed && reviewedMark ? ', reviewed by us' : ''})`;
  // A title that starts with its own ticket ("CRP-1: ...") says it twice.
  let title = flat(config, unit.title)
    .replace(/^\s*[A-Z][A-Z0-9]*-\d+(?:\/\d+)*\s*:\s*/, (lead) => (unit.tickets.some((ticket) => lead.includes(ticket)) ? '' : lead))
    .replace(/\.\s*$/, '');
  if (title.length > titleMax) title = titleMax > 0 ? `${title.slice(0, titleMax).trimEnd()}...` : '';
  return `- ${unit.ref}${tickets}${title ? ` ${title}` : ''}${team}. ${clock(unit.mergedAt, config.zone)}`;
};

// How much the plain render keeps when it has to fit the size limit: every
// merged unit, release, deploy record and reviewed PR always stays (the
// checks need them); work items, open items, deploy outcomes, gists, the
// merged units' titles and at last the review list's per-PR lines (grouped
// by verdict instead) shrink.
const LEVELS = [
  { work: 80, open: Infinity, brief: false, titles: Infinity, reviewedMark: true },
  { work: 25, open: 25, brief: true, titles: Infinity, reviewedMark: true },
  { work: 0, open: 8, brief: true, titles: Infinity, reviewedMark: true },
  { work: 0, open: 8, brief: true, titles: 60, reviewedMark: true },
  { work: 0, open: 8, brief: true, titles: 0, reviewedMark: true },
  { work: 0, open: 8, brief: 'compact', titles: 0, reviewedMark: false },
];
export const FALLBACK_LEVELS = LEVELS.length;

const workLines = (config, pack, max) => {
  const moved = pack.work.workItems.filter((item) => item.moves.length);
  const lines = max
    ? moved
        .slice(-max)
        .map((item) => `- ${flat(config, item.title)}: at ${flat(config, item.stage)} by the end (${item.moves.map((move) => `${move.stage} ${clock(move.at, config.zone)}`).join(', ')}).`)
    : [];
  if (moved.length > max) lines.unshift(max ? `- ${moved.length - max} earlier work items also moved; the last ${max} follow.` : `- ${plural(moved.length, 'work item')} moved; the mission desk has them.`);
  return lines;
};

const openLines = (config, pack, max = Infinity) => {
  const lines = pack.open.slice(0, max).map((item) => `${flat(config, item.label)} (since ${stamp(item.since, config.zone)})`);
  if (pack.open.length > max) lines.push(`${pack.open.length - max} more open items are on the mission desk.`);
  return lines;
};

const opsLines = (config, pack) => {
  const lines = pack.workflows.map((flow) => `- ${flat(config, flow.repo)} "${flat(config, flow.workflow)}": ${plural(flow.runs, 'run')}, ${flow.success} ok, ${flow.failure} failed.`);
  for (const error of pack.errors) lines.push(`- Could not read ${flat(config, error.source)}: ${flat(config, error.message)}.`);
  return lines.length ? lines : ['- Nothing to note.'];
};

/**
 * The plain body: every fact as a list under the same headings the editor
 * uses, so the checks pass and nothing goes missing. `note` says why it is
 * plain.
 */
// At most this many merged units are added to an editor's text that left them out.
export const MEND_MAX = 5;

/**
 * An editor's text that left out a few merged units (and passes every other
 * check) keeps its writing: the code adds the missing ones as plain lines at
 * the end of the built section, under a line that says they were not
 * written up. Returns {text, added}, or null when there is nothing to add or
 * too much.
 */
export function mendBuilt(config, pack, kind, text) {
  const heading = layout(kind, pack).built;
  const level = /^#+/.exec(heading)[0].length;
  const title = heading.replace(/^#+\s*/, '').toLowerCase();
  const lines = text.split('\n');
  const start = lines.findIndex((line) => {
    const match = /^(#+)\s+(.*)$/.exec(line);
    return match && match[1].length === level && match[2].trim().toLowerCase().startsWith(title);
  });
  if (start < 0) return null;
  let end = lines.findIndex((line, i) => i > start && /^(#+)\s/.exec(line)?.[1].length <= level);
  if (end < 0) end = lines.length;
  const built = unpin(lines.slice(start + 1, end).join('\n'));
  const missing = pack.units.filter((unit) => countRef(built, unit.ref, config) === 0);
  if (!missing.length || missing.length > MEND_MAX) return null;
  while (end > start + 1 && !lines[end - 1].trim()) end -= 1;
  // Its own sub-heading in a daily (so it doesn't read as part of the last area); a bold line in an update.
  const lead = level < 3 ? `${'#'.repeat(level + 1)} Also merged, not written up` : '**Also merged, not written up:**';
  const added = ['', lead, ...missing.map((unit) => unitLine(config, pack, unit))];
  return { text: [...lines.slice(0, end), ...added, ...lines.slice(end)].join('\n'), added: missing.map((unit) => unit.ref) };
}

export function fallbackBody(config, pack, kind, note, level = 0) {
  const shape = layout(kind, pack);
  const zone = config.zone;
  const keep = LEVELS[Math.min(level, LEVELS.length - 1)];
  const out = [];
  const open = openLines(config, pack, keep.open);
  if (kind === 'daily') {
    out.push('## Headline', note, '', pack.open.length ? `Needs you: ${pack.open.length} open (listed under Follow-ups).` : 'Needs you: nothing.', '');
    out.push('## Built and fixed, by area');
    for (const group of byArea(config, pack.units)) {
      out.push('', `### ${flat(config, group.area)}`);
      for (const unit of group.units) out.push(unitLine(config, pack, unit, keep.titles, keep.reviewedMark));
    }
    if (!pack.units.length) out.push('', `Nothing merged.`);
    const work = workLines(config, pack, keep.work);
    out.push('', '## Story arcs', ...(work.length ? work : ['- No tracked work items moved.']));
    out.push('', '## Follow-ups', '### Set today');
    const carried = pack.previous?.followUps ?? [];
    let n = 0;
    // Only real items get numbers: the next daily accounts for each one.
    for (const item of open.slice(0, Math.min(pack.open.length, keep.open))) out.push(`${++n}. ${item}`);
    if (pack.open.length > keep.open) out.push(open.at(-1));
    const carriedAs = new Map();
    for (const item of carried) {
      carriedAs.set(item.id, ++n);
      out.push(`${n}. ${flat(config, item.what)} (carried)`);
    }
    if (!n) out.push('Nothing open.');
    out.push('', "### Yesterday's follow-ups");
    if (carried.length) for (const item of carried) out.push(`- ${flat(config, item.id)} ${flat(config, item.what).replace(/[.\s]+$/, '')}: not checked in this version; carried as item ${carriedAs.get(item.id)}.`);
    else out.push('None were set.');
    out.push('', '## Ops, briefly', ...opsLines(config, pack));
    return withOwned(config, pack, kind, shape, out.join('\n'), keep.brief);
  }

  out.push('#### Short version', note, '');
  out.push(`#### Merged since ${clock(pack.window.from, zone)}`);
  for (const group of byArea(config, pack.units)) {
    out.push(`**${flat(config, group.area)}**`);
    for (const unit of group.units) out.push(unitLine(config, pack, unit, keep.titles, keep.reviewedMark));
  }
  if (!pack.units.length) out.push('Nothing merged.');
  const work = workLines(config, pack, keep.work);
  out.push('', '#### Arcs that moved', ...(work.length ? work : ['- No tracked work items moved.']));
  out.push('', '#### Needs you', ...(open.length ? open.map((item) => `- ${item}`) : ['Nothing.']));
  return withOwned(config, pack, kind, shape, out.join('\n'), keep.brief);
}
