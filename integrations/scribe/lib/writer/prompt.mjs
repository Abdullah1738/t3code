// The editor's brief for one report. The header line and the closing
// sections the code owns (left hanging, usage) are not the model's job; it
// writes the body between them from the facts pack.
import { layout } from './checks.mjs';
import { packText } from './pack.mjs';
import { zoneLabel } from './time.mjs';

const STYLE = `Style:
- Plain English, like a relaxed senior engineer telling the owner what happened. Short sentences. No hype, no emojis.
- Say what each change does for the product, not how the work was organised. No internal process words: no review rounds, lanes, cells, sequence numbers, session ids, file paths of review notes, rule numbers, model or tool names.
- Use only facts in the pack. Never invent a PR, ticket, tag, time, person or outcome. If the pack does not say something was proven, say it is not proven.
- The owner never sees the pack: don't mention it ("the pack shows", "not in the pack"). Say "nothing records it yet" instead, or leave the line out.
- Cite PRs exactly as the pack writes them (repo#N), commits by the ref the pack gives, tickets by their id. No commit hashes or run ids unless the pack uses them as refs.
- Times are HH:MM in the pack's zone, exactly as the pack gives them.
- Plain Markdown only: headings, paragraphs, lists, bold. No code spans or blocks, links, square brackets, backslashes or HTML, and no emphasis inside a tag or ref.`;

const dailySections = (config, pack, shape) => {
  const unit = pack.unitKind === 'pr' ? 'PR' : 'commit';
  const lines = [
    '## Headline',
    '2-3 sentences on what the day achieved for the product. Then one line starting "Needs you:" with what waits on the owner, or "Needs you: nothing."',
    '',
    '## Built and fixed, by area',
    `One "### <Area>" per area that had merged ${unit}s, in the pack's area order. Each area: a short paragraph on what got better and why it matters, then one list line per merged ${unit}:`,
    pack.unitKind === 'pr'
      ? '- repo#N (TICKET-1) what it does, one line. HH:MM'
      : '- <ref> what it does, one line. HH:MM',
    `Every merged ${unit} in the pack appears exactly once in this section, by its exact ref. Similar small ${unit}s may share one line ("- a, b and c: ...") but none may be left out or repeated. The paragraphs describe the work without citing refs; refs go on the list lines only.`,
    ...(pack.counts.team ? ['The team\'s PRs say so on their line: "(team: <name>, reviewed by us)" when the pack marks them reviewed by us, else "(team: <name>)".'] : []),
    'When an area has more than about 12 lines, group them under short bold lead lines.',
    'End an area with "Worth presenting: ..." when something there is worth showing the owner\'s stakeholders (a feature, a fix with impact, an infra change).',
    'Do not mention refs that were not merged in this window here.',
  ];
  const owned = [shape.deployed && '"## Deployed to dev"', shape.reviews && '"## Reviews for the team"'].filter(Boolean);
  if (owned.length) {
    lines.push(
      '',
      `Don't write ${owned.join(' or ')}: the code writes ${owned.length > 1 ? 'those sections' : 'that section'} itself, one line per release run, deploy record and reviewed PR, straight from the records, and puts ${owned.length > 1 ? 'them' : 'it'} before the story arcs. Use those facts in the headline and the arcs without restating single outcomes: wherever you name a release tag, a reviewed PR or a PR a deploy carried, the code adds the record's outcome in brackets after it ("[record: run failed, nothing proven]", "[record: review: Good to merge]"). Don't write brackets like that yourself, and don't put refs or tags inside links or code spans.`,
    );
  }
  lines.push(
    '',
    '## Story arcs',
    '3-8 short paragraphs, each one thread of work told start to finish within the window (from the work items, releases and lane messages): what was wrong or wanted, what was done, where it stands now.',
    '',
    '## Follow-ups',
    '### Set today',
    'A numbered list of what we owe next: "1. What. Why. By when." Only things the pack shows are still open. Carry yesterday\'s still-open items here too and mark them "(carried)".',
    "### Yesterday's follow-ups",
    pack.previous?.followUps?.length
      ? 'One line per item in YESTERDAY\'S FOLLOW-UPS, starting with its id: "- F1 <what>: Closed HH:MM. <how>" or "Still open, <why>. Carried as item N." or "Dropped, <why>." Every item gets a line.'
      : 'Write "None were set." (the pack has no follow-ups from the day before).',
    '',
    '## Ops, briefly',
    '3-6 bullets: workflow run counts, failures worth knowing, sources that could not be read.',
  );
  return lines.join('\n');
};

const updateSections = (config, pack, shape) => {
  const lines = [
    '#### Short version',
    'Three lines at most: what moved, what shipped, what needs the owner.',
    '',
    '#### Merged since <HH:MM of the window start>',
    `Grouped by area with a bold area name, one list line per merged ${pack.unitKind === 'pr' ? 'PR' : 'commit'}: "- ref what it does. HH:MM". Every merged one appears exactly once here; the team's say "(team: <name>)", plus ", reviewed by us" when the pack marks it. Write "Nothing merged." if the pack has none.`,
  ];
  const owned = [shape.deployed && '"#### Deployed and read back"', shape.reviews && '"#### Reviews done"'].filter(Boolean);
  if (owned.length) lines.push('', `Don't write ${owned.join(' or ')}: the code writes ${owned.length > 1 ? 'those sections' : 'that section'} itself from the records. Use those facts in the short version and the arcs without restating single outcomes: wherever you name a release tag, a reviewed PR or a PR a deploy carried, the code adds the record's outcome in brackets after it ("[record: ...]"). Don't write brackets like that yourself.`);
  lines.push(
    '',
    '#### Arcs that moved',
    'One line per thread of work that changed, from the work items and lane messages.',
    '',
    '#### Needs you',
    'What waits on the owner from the WAITING section, one line each, or "Nothing."',
  );
  return lines.join('\n');
};

/** System and user messages for the editor. */
export function writerPrompt(config, pack, { kind, header }) {
  const shape = layout(kind, pack);
  const limit = config.limits[kind];
  const sections = kind === 'daily' ? dailySections(config, pack, shape) : updateSections(config, pack, shape);
  const banned = config.banned.map((re) => re.source).join('  ');
  const system = [
    `You write the ${kind === 'daily' ? 'daily summary' : '4-hour update'} of the ${pack.mission.title} mission for its owner, from a facts pack. Everything you say must come from the pack.`,
    '',
    STYLE,
    ...(banned ? ['', `Never write anything these patterns match: ${banned}`] : []),
    '',
    `The code already writes the report's title and window line (shown below) ${kind === 'update' ? 'and the closing "Left hanging" and "Usage" parts ' : ''}and checks your text afterwards: every merged ${pack.unitKind === 'pr' ? 'PR' : 'commit'} exactly once in the merged section, every ref you cite present in the pack, every required heading present, at most ${limit} characters in all. Return only the report body in Markdown, starting at the first heading below. No preamble, no code fences.`,
    '',
    'Title and window line (do not repeat them):',
    header,
    '',
    'Sections, in this order, with these exact headings:',
    sections,
  ].join('\n');
  const user = [`Facts pack (${zoneLabel(config.zone)} times):`, '', packText(config, pack)].join('\n');
  return { system, user };
}

/** The follow-up message after failed checks. */
export function fixPrompt(previousBody, errors) {
  return [
    'Your report failed these checks:',
    ...errors.map((error) => `- ${error}`),
    '',
    'Return the whole corrected report body (same headings, same rules). Change only what the checks need.',
    '',
    'Your report:',
    previousBody,
  ].join('\n');
}
