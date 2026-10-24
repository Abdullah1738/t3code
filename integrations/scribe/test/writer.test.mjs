import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { chat } from '../lib/model.mjs';
import { checkReport, countRef, layout } from '../lib/writer/checks.mjs';
import { missionConfig } from '../lib/writer/config.mjs';
import { accountFor, parseSetToday } from '../lib/writer/followups.mjs';
import { commits } from '../lib/writer/git.mjs';
import { failingChecks } from '../lib/writer/github.mjs';
import { hanging, previousReport } from '../lib/writer/mission.mjs';
import { triageMoves } from '../lib/writer/linear.mjs';
import { gatherPack, packText } from '../lib/writer/pack.mjs';
import { asRead, emphasisMarks, flat, hasMarkup, pinFacts, recordFacts, releaseLine, unpin, withOwned } from '../lib/writer/lines.mjs';
import { FALLBACK_LEVELS, fallbackBody, reportHeader, updateTail } from '../lib/writer/render.mjs';
import { MARKER, exportDaily, exportUpdate, insertUpdate, sameFile } from '../lib/export.mjs';
import { expand } from '../lib/writer/scrub.mjs';
import { exec } from '../lib/writer/sh.mjs';
import { dayWindow, lastWholeDay } from '../lib/writer/time.mjs';
import { writerPrompt } from '../lib/writer/prompt.mjs';
import { cleanBody, writeReport } from '../lib/writer/writer.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli.mjs');
const FROM = '2026-10-21T20:00:00.000Z';
const TO = '2026-10-22T20:00:00.000Z';

const RAW = {
  missions: {
    shop: {
      title: 'Shop',
      zone: 'Asia/Dubai',
      github: { owner: 'acme', ours: ['me'], skipRepos: ['tooling'] },
      people: { 'jane-dev': 'Jane' },
      ticketPrefixes: ['SHOP'],
      linear: { team: 'SHOP' },
      areas: [
        { name: 'Payments', repos: ['pay'] },
        { name: 'Web', repos: ['web'] },
      ],
      banned: ['\\bcell-[a-z0-9-]+'],
    },
  },
};
const CONFIG = missionConfig(RAW, 'shop');

const pr = (repo, number, login, closedAt, title) => ({
  number,
  repository: { name: repo, nameWithOwner: `acme/${repo}` },
  title,
  author: { login },
  closedAt,
  url: `https://github.com/acme/${repo}/pull/${number}`,
  body: `Fixes SHOP-${number}.`,
});

const SEARCH = [
  pr('pay', 1, 'me', '2026-10-21T21:00:00Z', 'Retry declined cards once'),
  pr('web', 2, 'jane-dev', '2026-10-22T09:30:00Z', 'Show the refund state'),
  pr('tooling', 3, 'me', '2026-10-22T10:00:00Z', 'Skipped repo'),
  pr('web', 4, 'me', '2026-10-22T20:00:00Z', 'Outside the window'),
];

// gh and linctl as canned answers; anything else is a test bug.
const fakeExec = async (cmd, args) => {
  if (cmd === 'gh' && args[0] === 'search') return JSON.stringify(SEARCH);
  if (cmd === 'linctl') {
    return JSON.stringify({ data: { issues: { nodes: [{ identifier: 'SHOP-1', title: 'Card retries', state: { name: 'Done' }, project: null, parent: null }] } } });
  }
  throw new Error(`unexpected ${cmd} ${args.join(' ')}`);
};

const missionDbSchema = `
  create table ardud_mission_records (kind text, id text, mission_id text, sub_mission_id text, status text, updated_at text, seq integer, record_json text);
  create table ardud_mission_events (mission_id text, seq integer, event_id text, kind text, at text, event_json text);
  create table ardud_mission_router_messages (mission_id text, seq integer, id text, room_id text, kind text, msg_key text, content_hash text, created_at text, message_json text);
  create table ardud_mission_scribe_batch (batch_id text, mission_id text, thread_id text, from_event integer, to_event integer, model text, input_tokens integer, output_tokens integer, stats_json text, created_at text);
  create table ardud_mission_scribe_report (report_id text, mission_id text, kind text, covers_from text, covers_to text, open_json text, text text, created_at text);
`;

const missionDb = () => {
  const db = new DatabaseSync(':memory:');
  db.exec(missionDbSchema);
  return db;
};

const putRecord = (db, kind, record) =>
  db
    .prepare('insert into ardud_mission_records values (?, ?, ?, null, ?, ?, 0, ?)')
    .run(kind, record.id, 'shop', record.status ?? record.stage ?? null, record.updatedAt ?? record.createdAt, JSON.stringify({ _tag: kind, record }));

const PREVIOUS = {
  coversFrom: '2026-10-20T20:00:00.000Z',
  coversTo: FROM,
  text: '# Shop daily\n\n## Follow-ups\n### Set today\n1. Turn on card retries in dev.\n2. Ask Jane about refunds.\n\n### Yesterday\'s follow-ups\nNone were set.\n',
  open: [],
  facts: null,
};

const goodBody = [
  '## Headline',
  'Card retries went in and the team shipped the refund state. Needs you: nothing.',
  '',
  '## Built and fixed, by area',
  '### Payments',
  'Declined cards now get one retry.',
  '- pay#1 (SHOP-1) retries a declined card once. 01:00',
  '### Web',
  '- web#2 (SHOP-2) shows the refund state (team: Jane, reviewed by us). 13:30',
  '',
  '## Story arcs',
  'Card retries started yesterday and landed today.',
  '',
  '## Follow-ups',
  '### Set today',
  '1. Watch retry rates in dev.',
  '',
  "### Yesterday's follow-ups",
  '- F1 Turn on card retries in dev: Closed 01:00 with pay#1.',
  '- F2 Ask Jane about refunds: Still open, carried as item 1.',
  '',
  '## Ops, briefly',
  '- Quiet day.',
].join('\n');

test('day windows follow the mission zone', () => {
  assert.deepEqual(dayWindow('2026-10-22', 'Asia/Dubai'), { day: '2026-10-22', from: FROM, to: TO });
  assert.equal(lastWholeDay('2026-10-23T00:30:00.000Z', 'Asia/Dubai').day, '2026-10-22');
  assert.equal(lastWholeDay('2026-10-22T19:59:00.000Z', 'Asia/Dubai').day, '2026-10-21');
});

test('short repo names in titles and messages are written out', () => {
  const aliases = { pay: 'payments-api', p: 'payments-api' };
  assert.equal(expand('pay#12 and p#3 rode with web#4; payments-api#5 stays', aliases), 'payments-api#12 and payments-api#3 rode with web#4; payments-api#5 stays');
  assert.equal(expand('acme/pay#12 x-pay#1 pay#12a', aliases), 'acme/pay#12 x-pay#1 pay#12a');
  assert.equal(expand('pay#1', {}), 'pay#1');
});

test('a mission config needs a source of merged work', () => {
  assert.throws(() => missionConfig({ missions: { x: { title: 'X' } } }, 'x'), /needs "github"/);
  assert.throws(() => missionConfig({ missions: {} }, 'x'), /no "missions.x" entry/);
  assert.equal(CONFIG.zone, 'Asia/Dubai');
  assert.equal(CONFIG.limits.daily, 60_000);
});

test('follow-ups are parsed from Set today and must each be accounted for', () => {
  const set = parseSetToday(PREVIOUS.text);
  assert.deepEqual(set, [
    { id: 'F1', what: 'Turn on card retries in dev.' },
    { id: 'F2', what: 'Ask Jane about refunds.' },
  ]);
  assert.deepEqual(accountFor(goodBody, set), { missing: [], unresolved: [] });
  const vague = goodBody.replace('- F2 Ask Jane about refunds: Still open, carried as item 1.', '- F2 Ask Jane about refunds: talked about it.');
  assert.deepEqual(accountFor(vague, set), { missing: [], unresolved: ['F2'] });
  assert.deepEqual(accountFor(goodBody.replace(/- F1 .*\n/, ''), set), { missing: ['F1'], unresolved: [] });
});

test('the pack takes the window exactly and skips the configured repos', async () => {
  const db = missionDb();
  const pack = await gatherPack({ config: CONFIG, kind: 'daily', from: FROM, to: TO, db, exec: fakeExec, previous: PREVIOUS });
  assert.deepEqual(
    pack.units.map((unit) => [unit.ref, unit.ours, unit.person, unit.area]),
    [
      ['pay#1', true, 'us', 'Payments'],
      ['web#2', false, 'Jane', 'Web'],
    ],
  );
  assert.deepEqual(pack.counts, { merged: 2, ours: 1, team: 1, reviews: 0, reviewedPrs: 0, releases: 0, releasesOk: 0 });
  assert.equal(pack.tickets['SHOP-1'].title, 'Card retries');
  assert.deepEqual(pack.previous.followUps.map((item) => item.id), ['F1', 'F2']);
  assert.deepEqual(pack.errors, []);
});

test('checks catch missing, repeated, unmarked, invented and banned refs', async () => {
  const db = missionDb();
  const pack = await gatherPack({ config: CONFIG, kind: 'daily', from: FROM, to: TO, db, exec: fakeExec, previous: PREVIOUS });
  assert.deepEqual(checkReport(CONFIG, pack, 'daily', `# t\n\n${goodBody}\n`), []);

  const bad = goodBody
    .replace('- pay#1 (SHOP-1) retries a declined card once. 01:00', '- pay#9 (SHOP-1) something else. 01:00')
    .replace(' (team: Jane, reviewed by us)', '')
    .replace('Quiet day.', 'Quiet day in cell-fab-svc, see web#2 and SHOP-77.');
  const errors = checkReport(CONFIG, pack, 'daily', bad);
  assert.ok(errors.some((error) => /missing from "Built and fixed".*pay#1/.test(error)), errors.join('\n'));
  assert.ok(errors.some((error) => /team's PRs.*web#2/.test(error)), errors.join('\n'));
  assert.ok(errors.some((error) => /not merged in this window: pay#9/.test(error)), errors.join('\n'));
  assert.ok(errors.some((error) => /not in the facts pack.*pay#9.*SHOP-77|not in the facts pack.*SHOP-77.*pay#9/.test(error)), errors.join('\n'));
  assert.ok(errors.some((error) => /cell-fab-svc/.test(error)), errors.join('\n'));
  const talk = checkReport(CONFIG, pack, 'daily', goodBody.replace('Quiet day.', 'Quiet day; the pack shows nothing else.'));
  assert.ok(talk.some((error) => /Don't mention the facts pack/.test(error)), talk.join('\n'));
  const short = checkReport(CONFIG, pack, 'daily', goodBody.replace('Quiet day.', 'Quiet day; p#1 waits.'));
  assert.ok(short.some((error) => /full repo name.*p#1/.test(error)), short.join('\n'));

  const twice = goodBody.replace('### Web', '- pay#1 again. 02:00\n### Web');
  assert.ok(checkReport(CONFIG, pack, 'daily', twice).some((error) => /more than once.*pay#1/.test(error)));
  const small = missionConfig({ missions: { shop: { ...RAW.missions.shop, limits: { daily: 100 } } } }, 'shop');
  assert.ok(checkReport(small, pack, 'daily', goodBody).some((error) => /the limit is 100/.test(error)));
});

// A pack with a release run, deploy records, reviews and triage, for the code's own sections.
const ownedPack = async () => {
  const pack = await gatherPack({ config: CONFIG, kind: 'daily', from: FROM, to: TO, db: missionDb(), exec: fakeExec, previous: PREVIOUS });
  pack.releases = [
    { at: '2026-10-22T06:00:00.000Z', conclusion: 'success', tag: 'web-dev.1', service: 'web', repo: 'web', previousTag: 'web-dev.0', carried: ['web#2'], commits: 1, runtimeChecked: true, runtimeFailures: [] },
    { at: '2026-10-22T06:00:30.000Z', conclusion: 'failure', tag: 'web-dev.2', service: 'web', repo: 'web', previousTag: 'web-dev.1', carried: [], commits: 0, runtimeChecked: true, runtimeFailures: [] },
    { at: '2026-10-22T07:00:00.000Z', conclusion: 'success', tag: 'pay-dev.1', service: 'pay', repo: 'pay', previousTag: null, carried: ['pay#1'], commits: 1, runtimeChecked: null, runtimeFailures: [] },
  ];
  const record = (at, status, extra = {}) => ({ at, repo: 'web', status, tag: 'web-dev.1', prs: ['web#2'], outcome: '', observed: null, failure: '', ...extra });
  pack.deploys = [
    record('2026-10-22T08:00:01.000Z', 'done', { observed: 'failed rollout left the previous image in place' }),
    record('2026-10-22T08:00:31.000Z', 'failed', { observed: 'deployed image v1 is still healthy', failure: 'image pull' }),
    record('2026-10-22T09:00:00.000Z', 'done', { tag: null, prs: ['web#2', 'pay#1'], observed: 'nothing unhealthy; image v1' }),
  ];
  pack.reviews = [
    { at: '2026-10-22T05:00:00.000Z', ref: 'web#2', person: 'Jane', verdict: 'Feedback required', state: 'done', gist: 'tests missing' },
    { at: '2026-10-22T08:00:00.000Z', ref: 'web#2', person: 'Jane', verdict: 'Code OK - Pending', state: 'done', gist: 'fixed' },
  ];
  pack.triage = [{ id: 'SHOP-9', title: 'Refund button', createdAt: FROM, state: 'Todo', project: 'Web', moves: [{ at: '2026-10-22T04:00:00.000Z', from: 'Triage', to: 'Web' }] }];
  return pack;
};

test('the code writes the release, deploy and review lines from the records, whatever the editor wrote there', async () => {
  const pack = await ownedPack();
  const lying = goodBody.replace(
    '## Story arcs',
    '## Deployed to dev\n- web-dev.2 10:30: everything went fine. Proven.\n- web-dev.1 (web#2): went out. Read back: healthy, image v2.\n\n## Reviews for the team\n- web#2 (Jane): reviewed.\n\n## Story arcs',
  );
  const placed = withOwned(CONFIG, pack, 'daily', layout('daily', pack), lying);
  const text = `# t\n\n${placed}\n`;
  assert.deepEqual(checkReport(CONFIG, pack, 'daily', text), []);
  assert.doesNotMatch(text, /everything went fine|went out|reviewed\./);
  assert.equal(withOwned(CONFIG, pack, 'daily', layout('daily', pack), placed), placed, 'placing twice changes nothing');
  // The sections sit before the arcs, deploys first.
  assert.ok(text.indexOf('## Deployed to dev') < text.indexOf('## Reviews for the team'));
  assert.ok(text.indexOf('## Reviews for the team') < text.indexOf('## Story arcs'));
  // Each run, record and review says what the records say.
  for (const line of [
    '- web-dev.1 10:00: carried web#2. Proven: the runtime check passed.',
    '- web-dev.2 10:00: no merged PRs since web-dev.1. Not proven: the run did not succeed. The run failed.',
    '- pay-dev.1 11:00: carried pay#1. Not proven: no runtime check in the run.',
    '- web web-dev.1 12:00: done, PRs web#2. Read back: failed rollout left the previous image in place.',
    '- web web-dev.1 12:00: failed, PRs web#2. Failure: image pull. Read back: deployed image v1 is still healthy.',
    '- web 13:00: done, PRs web#2, pay#1. Read back: nothing unhealthy; image v1.',
    '- web#2 (Jane): Feedback required 09:00, Code OK - Pending 12:00. fixed',
    '- SHOP-9 Refund button: Todo in Web at the end of the day (Triage to Web 08:00).',
    "Other teams' requests: none recorded.",
  ]) {
    assert.ok(text.split('\n').includes(line), `missing: ${line}`);
  }
  // A changed, dropped or extra line in those sections fails.
  const changed = text.replace('The run failed.', 'The run went fine.');
  assert.match(checkReport(CONFIG, pack, 'daily', changed).join('\n'), /"Deployed to dev" must hold only the code's lines.*The run went fine/);
  const extra = text.replace('## Reviews for the team', 'Everything is proven.\n\n## Reviews for the team');
  assert.match(checkReport(CONFIG, pack, 'daily', extra).join('\n'), /"Deployed to dev" must hold only the code's lines.*Everything is proven/);
  const dropped = text.replace('- pay-dev.1 11:00: carried pay#1. Not proven: no runtime check in the run.\n', '');
  assert.match(checkReport(CONFIG, pack, 'daily', dropped).join('\n'), /"Deployed to dev" must hold only the code's lines/);
  // The brief form (no failure text or gists) counts too.
  const brief = `# t\n\n${withOwned(CONFIG, pack, 'daily', layout('daily', pack), lying, true)}\n`;
  assert.match(brief, /- web web-dev\.1 12:00: failed, PRs web#2\. Read back: deployed image v1 is still healthy\./);
  assert.deepEqual(checkReport(CONFIG, pack, 'daily', brief), []);
  // The editor is told not to write them.
  assert.match(writerPrompt(CONFIG, pack, { kind: 'daily', header: '# t' }).system, /Don't write "## Deployed to dev" or "## Reviews for the team": the code writes those sections itself/);
});

test('the plain version carries the same code lines, so tricky records still publish', async () => {
  const pack = await ownedPack();
  for (const level of [0, 1, 2]) {
    const text = `# t\n\n${fallbackBody(CONFIG, pack, 'daily', 'Plain.', level)}\n`;
    assert.deepEqual(checkReport(CONFIG, pack, 'daily', text), [], `level ${level}`);
  }
  const update = await gatherPack({ config: CONFIG, kind: 'update', from: '2026-10-22T04:00:00.000Z', to: '2026-10-22T08:00:00.000Z', db: missionDb(), exec: fakeExec });
  Object.assign(update, { releases: pack.releases, deploys: pack.deploys, reviews: pack.reviews });
  const text = `### t\n\n${fallbackBody(CONFIG, update, 'update', 'Plain.')}\n`;
  assert.match(text, /#### Deployed and read back\n- web-dev\.1 10:00/);
  assert.match(text, /#### Reviews done\n- web#2 \(Jane\)/);
  assert.deepEqual(checkReport(CONFIG, update, 'update', text), []);
});

test('outside its own sections the prose names a run, deploy or review only with the outcome the code pins to it', async () => {
  const pack = await ownedPack();
  const shape = layout('daily', pack);
  const WEB2 =
    '[record: deploy record done, read back: failed rollout left the previous image in place; deploy record failed, read back: deployed image v1 is still healthy; deploy record done, read back: nothing unhealthy; image v1; review: Feedback required, Code OK - Pending]';
  // The r6 example: a headline that turns a failed run into a proven one.
  const lying = goodBody.replace(
    'Card retries went in and the team shipped the refund state. Needs you: nothing.',
    'web-dev.2 succeeded and is proven. Its deploy read back healthy, image v2. Jane approved web#2 with Code OK.',
  );
  const placed = withOwned(CONFIG, pack, 'daily', shape, lying);
  const headline = placed.split('\n').find((line) => line.startsWith('web-dev.2'));
  assert.equal(headline, `web-dev.2 [record: run failed, nothing proven] succeeded and is proven. Its deploy read back healthy, image v2. Jane approved web#2 ${WEB2} with Code OK.`);
  const text = `# t\n\n${placed}\n`;
  assert.deepEqual(checkReport(CONFIG, pack, 'daily', text), []);
  // A pin taken off or changed fails the checks.
  assert.match(checkReport(CONFIG, pack, 'daily', text.replace(' [record: run failed, nothing proven]', '')).join('\n'), /record outcomes the code pins .* missing or changed/);
  assert.match(checkReport(CONFIG, pack, 'daily', text.replace('[record: run failed, nothing proven]', '[record: run succeeded, runtime check passed]')).join('\n'), /missing or changed/);
  // A pin the editor wrote itself is replaced by the code's; other brackets stay.
  assert.equal(pinFacts(CONFIG, pack, 'web-dev.2 [record: run succeeded] went out [review: queue].'), 'web-dev.2 [record: run failed, nothing proven] went out [review: queue].');
  // Exact tags: web-dev.10 is not web-dev.1; a tag "web" is not the web in web#2. Every mention gets its pin.
  pack.releases.push({ ...pack.releases[0], tag: 'web-dev.10', conclusion: 'cancelled', carried: [], previousTag: null });
  pack.releases.push({ ...pack.releases[0], tag: 'web', conclusion: 'failure', carried: [], previousTag: null });
  const pinned = pinFacts(CONFIG, pack, 'web-dev.10 and web-dev.1 and pay#1, then web#2 and web-dev.1 again.');
  assert.equal(
    pinned,
    `web-dev.10 [record: run cancelled, nothing proven] and web-dev.1 [record: run succeeded, runtime check passed; deploy record done, read back: failed rollout left the previous image in place; deploy record failed, read back: deployed image v1 is still healthy] and pay#1 [record: deploy record done, read back: nothing unhealthy; image v1], then web#2 ${WEB2} and web-dev.1 [record: run succeeded, runtime check passed; deploy record done, read back: failed rollout left the previous image in place; deploy record failed, read back: deployed image v1 is still healthy] again.`,
  );
  assert.equal(pinFacts(CONFIG, pack, pinned), pinned, 'pinning twice changes nothing');
  assert.equal(unpin(pinned), 'web-dev.10 and web-dev.1 and pay#1, then web#2 and web-dev.1 again.');
  // Owner prefixes and headings: the pin follows the mention; a bare URL keeps its pin after it.
  assert.equal(pinFacts(CONFIG, pack, '## acme/web#2 shipped'), `## acme/web#2 ${WEB2} shipped`);
  assert.equal(pinFacts(CONFIG, pack, 'a link to https://x.test/web#2 only.'), 'a link to https://x.test/web#2 only.');
  // Markup that renders a name the checks don't read as written is refused
  // outright: escapes, entities, links (and their titles), code spans,
  // look-alike letters, emphasis inside a name.
  const story = (line) => text.replace('## Story arcs\n', `## Story arcs\n${line}\n`);
  for (const line of [
    'web-dev\\.2 succeeded and is proven.',
    'web&#35;2 was approved.',
    '[web#2](https://example.com "details (old)") was approved.',
    '``web#2`` was approved.',
    'wеb-dev.2 went fine.', // Cyrillic e
  ]) {
    assert.match(checkReport(CONFIG, pack, 'daily', story(line)).join('\n'), /Write plain text/, line);
  }
  assert.match(checkReport(CONFIG, pack, 'daily', story('web-*dev*.2 succeeded.')).join('\n'), /no emphasis or special characters inside them/);
  assert.match(checkReport(CONFIG, pack, 'daily', story('web＃2 was approved.')).join('\n'), /no emphasis or special characters inside them/);
  // Bold around a whole ref is fine: it reads as written and gets its pin.
  assert.deepEqual(checkReport(CONFIG, pack, 'daily', withOwned(CONFIG, pack, 'daily', shape, story('**web-dev.2** went out.'))), []);
  // A tag that is also a reviewed PR's ref gets both records in one pin.
  pack.releases.push({ ...pack.releases[0], tag: 'web#2', conclusion: 'failure', carried: [], previousTag: null });
  assert.equal(pinFacts(CONFIG, pack, 'Jane approved web#2 with Good to merge.'), `Jane approved web#2 ${WEB2.replace('[record: ', '[record: run failed, nothing proven; ')} with Good to merge.`);
  pack.releases.pop();
  assert.equal(pinFacts(CONFIG, pack, '```\nweb#2\n```'), '```\nweb#2\n```');
  assert.match(checkReport(CONFIG, pack, 'daily', text.replace('## Story arcs', '```\nweb-dev.2 went fine\n```\n\n## Story arcs')).join('\n'), /Don't use code blocks/);
  // A daily's own "## Usage" or "## Left hanging" is the editor's prose: pinned.
  assert.match(pinFacts(CONFIG, pack, '## Usage\nweb-dev.2 went fine.', 'daily', shape), /web-dev\.2 \[record: run failed/);
  // The editor's own "## Deployed" or "## Reviews" goes; a "### Releases" area in the built list and "## Review backlog" stay.
  const sections = withOwned(
    CONFIG,
    pack,
    'daily',
    shape,
    goodBody
      .replace('## Story arcs', '## Deployed\n- web-dev.2 went fine.\n\n## Reviews\n- web#2 approved.\n\n## Review backlog\nTwo PRs wait.\n\n## Release risks\nNone known.\n\n## Story arcs')
      .replace('### Web', '### Releases'),
  );
  assert.doesNotMatch(sections, /went fine|approved\./);
  assert.match(sections, /## Review backlog\nTwo PRs wait\./);
  assert.match(sections, /## Release risks\nNone known\./);
  assert.match(sections, /### Releases\n/);
  // Follow-ups saved for tomorrow don't carry today's pins.
  assert.deepEqual(parseSetToday('### Set today\n1. Watch web-dev.2 [record: run failed, nothing proven] again.\n').map((item) => unpin(item.what)), ['Watch web-dev.2 again.']);
});

test('names are read as the reader sees them: hidden ones are refused or pinned one by one, honest prose passes', async () => {
  const pack = await ownedPack();
  const shape = layout('daily', pack);
  const story = (line) => `# t\n\n${withOwned(CONFIG, pack, 'daily', shape, goodBody.replace('## Story arcs\n', `## Story arcs\n${line}\n`))}\n`;
  const errorsFor = (line) => checkReport(CONFIG, pack, 'daily', story(line)).join('\n');
  // A lost match can't cancel a hidden one: each mention is checked where it is.
  for (const line of [
    'web-*dev*.2 succeeded and is proven; web-dev.2*suffix* is a longer name.',
    'web＃999 approved; web#2*suffix* went out.',
    'SHOP-**9999** is done.',
    'SHOP-９ is done.',
    'web-\u034fdev.2 succeeded and is proven.', // combining grapheme joiner
    'web-dev.2\ufe0f succeeded.', // variation selector
    'web-de\u0301v.2 succeeded.', // combining accent on a plain letter
    'web-\u0000dev.2 succeeded.',
  ]) {
    assert.match(errorsFor(line), /no emphasis or special characters|Write plain text/, JSON.stringify(line));
  }
  // Emphasis around a whole name is fine, with underscores too, and the pin goes after it.
  for (const line of ['__web-dev.2__ went out.', '**web#2** was reviewed.', '_web-dev.2_ went out.']) {
    assert.deepEqual(errorsFor(line), '', line);
  }
  assert.equal(pinFacts(CONFIG, pack, '__web-dev.2__ went out.'), '__web-dev.2__ [record: run failed, nothing proven] went out.');
  // Honest prose: units, accents, other scripts, apostrophes and the like.
  for (const line of ['p95 is 3μs (μs, 1ms) and 8µs at worst; A1/Δ is fine.', "José's Δ-check: < 5 ms & stable, Ünal agreed.", 'Привет, the Kyiv team said web-dev.2 needs a retry.']) {
    assert.deepEqual(errorsFor(line), '', line);
  }
  // Look-alike letters inside a name-shaped word still go.
  assert.match(errorsFor('wеb-dev.2 went fine.'), /Write plain text/);
  // Record text the code flattens keeps its refs known (an answer's CRP-**N** or web＃2).
  assert.equal(flat(CONFIG, 'SHOP-**1** and web＃2, 8µs, 3μs'), 'SHOP-1 and web#2, 8μs, 3μs');
  // An open ask whose text cites a ticket in bold, and a mission title with
  // brackets and a zero-width space: the plain version still passes.
  const db = missionDb();
  putRecord(db, 'ask', { id: 'a9', question: 'Is SHOP-**77** done, or ＳＨＯＰ-78?', status: 'open', options: [], createdAt: '2026-10-22T08:00:00.000Z' });
  const odd = { ...CONFIG, title: 'Shop [prod]\u200b' };
  const result = await writeReport({ config: odd, kind: 'daily', from: FROM, to: TO, db, exec: fakeExec, previous: PREVIOUS, useModel: false });
  assert.equal(result.passed, true, result.facts.writer.fallbackErrors.join('\n'));
  assert.match(result.text, /^# Shop \(prod\) daily/);
  assert.match(result.text, /Is SHOP-77 done, or SHOP-78\?/);
});

test('names are folded before emphasis comes off, the same way the code flattens record text', async () => {
  const pack = await ownedPack();
  const shape = layout('daily', pack);
  const story = (line) => `# t\n\n${withOwned(CONFIG, pack, 'daily', shape, goodBody.replace('## Story arcs\n', `## Story arcs\n${line}\n`))}\n`;
  const errorsFor = (line) => checkReport(CONFIG, pack, 'daily', story(line)).join('\n');
  // Small and full-width asterisks and underscores are emphasis once folded.
  for (const line of ['SHOP-\ufe61\ufe619999\ufe61\ufe61 is done.', 'web-\ufe61dev\ufe61.2 succeeded.', 'web-\uff0adev\uff0a.2 succeeded.', 'SHOP-\uff3f\uff3f9999\uff3f\uff3f is done.']) {
    assert.match(errorsFor(line), /no emphasis or special characters|not in the facts pack/, JSON.stringify(line));
  }
  // Underscore runs inside a name are part of it, double or triple.
  assert.equal(asRead('api__server#2 and snake___case'), 'api__server#2 and snake___case');
  assert.equal(asRead('__api__server#2__ went out'), 'api__server#2 went out');
  assert.equal(flat(CONFIG, 'api__server#2 and __bold__'), 'api__server#2 and bold');
  // flat's output is plain text the checks accept, and flattening it again changes nothing.
  for (const input of ['Confirm v2*β* behaviour?', 'SHOP-\ufe61\ufe6177\ufe61\ufe61 and v2\u200b\u03b2', 'x_\u0435_2#1 and A1/Δ']) {
    const once = flat(CONFIG, input);
    assert.equal(hasMarkup(once), false, `${input} -> ${once}`);
    assert.equal(flat(CONFIG, once), once, input);
  }
  // Open asks with such text still publish in plain form.
  const db = missionDb();
  putRecord(db, 'ask', { id: 'a1', question: 'Confirm v2*β* behaviour?', status: 'open', options: [], createdAt: '2026-10-22T08:00:00.000Z' });
  putRecord(db, 'ask', { id: 'a2', question: 'Is SHOP-\ufe61\ufe6177\ufe61\ufe61 done?', status: 'open', options: [], createdAt: '2026-10-22T08:00:00.000Z' });
  putRecord(db, 'ask', { id: 'a3', question: 'Is the pack of changes ready?', status: 'open', options: [], createdAt: '2026-10-22T08:00:00.000Z' });
  const result = await writeReport({ config: CONFIG, kind: 'daily', from: FROM, to: TO, db, exec: fakeExec, previous: PREVIOUS, useModel: false });
  assert.equal(result.passed, true, result.facts.writer.fallbackErrors.join('\n'));
  assert.match(result.text, /Is SHOP-77 done\?/);
});

test('an owner in front of a ref names the same PR for the mission\'s owner and another PR for any other', async () => {
  const pack = await ownedPack();
  const shape = layout('daily', pack);
  const place = (body) => `# t\n\n${withOwned(CONFIG, pack, 'daily', shape, body)}\n`;
  // An invented PR with an owner in front is still an invented PR.
  const invented = place(goodBody.replace('## Story arcs\n', '## Story arcs\nacme/web#999 is approved.\n').replace('- web#2 ', '- web#2 and acme/web#999 '));
  const errors = checkReport(CONFIG, pack, 'daily', invented).join('\n');
  assert.match(errors, /not merged in this window: web#999/);
  assert.match(errors, /not in the facts pack.*web#999/);
  // Another owner's repo of the same name is another PR, not ours.
  assert.match(checkReport(CONFIG, pack, 'daily', place(goodBody.replace('## Story arcs\n', '## Story arcs\nother/web#2 shipped too.\n'))).join('\n'), /not in the facts pack.*other\/web#2/);
  // The mission's owner in front of a merged PR counts as that PR, once, and gets its pin.
  const owned = place(goodBody.replace('- web#2 ', '- acme/web#2 '));
  assert.deepEqual(checkReport(CONFIG, pack, 'daily', owned), []);
  assert.match(owned, /- acme\/web#2 \[record: /);
  assert.equal(countRef('acme/web#2 and web#2 and other/web#2', 'web#2', CONFIG), 2);
  // GitHub owners ignore case: ACME/web#2 is the same PR, and gets the same pin.
  const upper = place(goodBody.replace('## Story arcs\n', '## Story arcs\nACME/web#2 is approved.\n'));
  assert.match(upper, /ACME\/web#2 \[record: [^\]]*review: Feedback required/);
  assert.deepEqual(checkReport(CONFIG, pack, 'daily', upper), []);
  assert.match(checkReport(CONFIG, pack, 'daily', upper.replace(/(ACME\/web#2) \[record: [^\]]*\]/, '$1')).join('\n'), /pins/);
});

test('only emphasis a reader sees is taken off: a lone star, tilde or underscore is text', async () => {
  const c = { banned: [] };
  // Paired markers hide; a lone one is literal, so the fact stays as written.
  assert.equal(flat(c, 'Restore __init__.py; cost is 2*3 ms, approximately ~5 ms'), 'Restore init.py; cost is 2*3 ms, approximately ~5 ms');
  assert.equal(flat(c, 'stops ~2-3 TB/day SSD writes'), 'stops ~2-3 TB/day SSD writes');
  assert.equal(flat(c, 'api_#1 and _api#1 and snake___case'), 'api_#1 and _api#1 and snake___case');
  assert.equal(flat(c, 'a **bold** and *it* and ~~gone~~ and ***both***'), 'a bold and it and gone and both');
  assert.equal(asRead('web-*dev*.2 and **a*b**'), 'web-dev.2 and a*b');
  assert.deepEqual([...emphasisMarks('2*3 and *x*')].sort((a, b) => a - b), [8, 10]);
  // Each result reads back as itself and passes the markup check.
  for (const text of ['Restore __init__.py; cost is 2*3 ms', 'Is SHOP-\uff17\u0301\uff17 done?', 'Keep the timeout <\u03b22ms', 'x <\u03b2 y and <\u03b2<\u03b2']) {
    const once = flat(c, text);
    assert.equal(flat(c, once), once, text);
    assert.equal(asRead(once), once, text);
    assert.equal(hasMarkup(once), false, text);
  }
  assert.equal(flat(c, 'Is SHOP-\uff17\u0301\uff17 done?'), 'Is SHOP-77 done?');
  assert.equal(asRead('Is SHOP-\uff17\u0301\uff17 done?'), 'Is SHOP-77 done?');
  // A merged PR on a repo whose name ends in "_" still counts once, plain or emphasised.
  const pack = await ownedPack();
  const unit = { ...pack.units[0], ref: 'api_#1', repo: 'api_', number: 1, title: 'Restore __init__.py; cost is 2*3 ms', tickets: [] };
  const odd = { ...pack, units: [...pack.units, unit], counts: { ...pack.counts, merged: pack.counts.merged + 1, ours: pack.counts.ours + 1 } };
  const plain = fallbackBody(CONFIG, odd, 'daily', 'Plain.');
  assert.match(plain, /- api_#1 Restore init\.py; cost is 2\*3 ms\./);
  const header = reportHeader(CONFIG, odd, 'daily');
  assert.deepEqual(checkReport(CONFIG, odd, 'daily', `${header}\n\n${plain}\n`, { plain: true }), []);
});

test('talk about the pack is caught however it is put; a pack of something else is fine', async () => {
  const pack = await ownedPack();
  const shape = layout('daily', pack);
  const place = (line) => `# t\n\n${withOwned(CONFIG, pack, 'daily', shape, goodBody.replace('## Story arcs\n', `## Story arcs\n${line}\n`))}\n`;
  for (const line of ['According to the pack, web#2 merged.', 'The pack confirms web#2 merged.', 'The pack indicates nothing more.', "The pack's numbers agree.", 'Based on the pack, all is well.']) {
    assert.match(checkReport(CONFIG, pack, 'daily', place(line)).join('\n'), /facts pack/, line);
  }
  for (const line of ['Is the pack of changes ready?', 'The six packages went out.']) {
    assert.deepEqual(checkReport(CONFIG, pack, 'daily', place(line)), [], line);
  }
});

test('an update written twice for the same window goes in once, whatever its pins say', () => {
  const file = `# Shop: running update\n\n${MARKER}\n`;
  const first = insertUpdate(file, '### Shop update, 22 Oct 12:00 to 16:00 Dubai, after web-dev.1 [record: run succeeded, runtime check passed]\n\nbody\n');
  assert.equal(first.inserted, true);
  const again = insertUpdate(first.text, '### Shop update, 22 Oct 12:00 to 16:00 Dubai, after web-dev.1 [record: run succeeded, runtime check passed; deploy record done, nothing read back]\n\nbody\n');
  assert.equal(again.inserted, false);
  assert.equal(again.text, first.text);
});

test('the header gets its pins too: a title can name a reviewed PR', async () => {
  // A review workflow DB with one decision on the team's web#2.
  const dir = mkdtempSync(join(tmpdir(), 'scribe-crw-'));
  const path = join(dir, 'crw.db');
  const crw = new DatabaseSync(path);
  crw.exec(`create table decisions (id text, pr_key text, verdict text, status text, stage text, summary text, created_at integer);
            create table prs (key text, author text, title text, state text, merged_at text);
            create table deploys (id text, repo text, status text, prs text, ref text, conclusion text, observe_state text, failure text, created_at integer, updated_at integer);`);
  crw.prepare('insert into decisions values (?, ?, ?, ?, ?, ?, ?)').run('d1', 'acme/web#2', 'Good to merge', 'done', 'merge', 'clean', Date.parse('2026-10-22T09:00:00Z') / 1000);
  crw.prepare('insert into prs values (?, ?, ?, ?, ?)').run('acme/web#2', 'jane-dev', 'Show the refund state', 'merged', '2026-10-22T09:30:00Z');
  crw.close();
  const titled = missionConfig({ missions: { shop: { ...RAW.missions.shop, title: 'Fix web#2', crw: { db: path } } } }, 'shop');
  for (const kind of ['daily', 'update']) {
    const window = kind === 'daily' ? { from: FROM, to: TO } : { from: '2026-10-22T08:00:00.000Z', to: '2026-10-22T12:00:00.000Z' };
    const result = await writeReport({ config: titled, kind, ...window, db: missionDb(), exec: fakeExec, previous: kind === 'daily' ? PREVIOUS : null, useModel: false });
    assert.equal(result.facts.pack.reviews.length, 1, kind);
    assert.equal(result.passed, true, `${kind}: ${result.facts.writer.fallbackErrors.join('\n')}`);
    assert.match(result.text.split('\n')[0], /Fix web#2 \[record: review: Good to merge\]/, kind);
  }
  rmSync(dir, { recursive: true, force: true });
});

test('the code\'s sections go by their exact names: "Reviews backlog" is the editor\'s own', async () => {
  const pack = await ownedPack();
  const shape = layout('daily', pack);
  const body = goodBody.replace('## Story arcs\n', '## Reviews backlog\nNothing waits on a review.\n\n## Deployed risks\nNone.\n\n## Story arcs\n');
  assert.deepEqual(checkReport(CONFIG, pack, 'daily', `# t\n\n${withOwned(CONFIG, pack, 'daily', shape, body)}\n`), []);
  // A mixed-form section says where it parts from the closest form.
  const placed = withOwned(CONFIG, pack, 'daily', shape, goodBody);
  const broken = placed.replace(/(## Reviews for the team\n)/, '$1- web#2 (Jane): fine.\n');
  assert.match(checkReport(CONFIG, pack, 'daily', `# t\n\n${broken}\n`).join('\n'), /at line 1 of it the text has "- web#2 \(Jane\): fine\." where the code has "- web#2 \(Jane\): Feedback required/);
});

test('record text stays on one line; a failed carry lookup says the carry is unknown', async () => {
  const pack = await ownedPack();
  pack.deploys[0].observed = 'unhealthy\n## Story arcs\nimage v1';
  pack.deploys[1].failure = 'pull\nfailed';
  pack.reviews[1].gist = 'line one\n- line two';
  const shape = layout('daily', pack);
  const placed = withOwned(CONFIG, pack, 'daily', shape, goodBody);
  assert.equal(placed.split('\n').filter((line) => line === '## Story arcs').length, 1);
  assert.match(placed, /Read back: unhealthy ## Story arcs image v1\./);
  assert.equal(withOwned(CONFIG, pack, 'daily', shape, placed), placed);
  assert.deepEqual(checkReport(CONFIG, pack, 'daily', `# t\n\n${placed}\n`), []);
  for (const level of [0, 1, 2]) assert.deepEqual(checkReport(CONFIG, pack, 'daily', `# t\n\n${fallbackBody(CONFIG, pack, 'daily', 'Plain.', level)}\n`), [], `level ${level}`);
  // The previous tag was found but the comparison failed: nothing is known about what it carried.
  const run = { at: '2026-10-22T06:00:00.000Z', conclusion: 'success', tag: 'web-dev.3', service: 'web', repo: 'web', previousTag: 'web-dev.2', carried: [], commits: 0, carriedKnown: false, carryError: 'compare failed', runtimeChecked: true, runtimeFailures: [] };
  assert.match(releaseLine(CONFIG, run), /web-dev\.3 10:00: what it carried is unknown\./);
  assert.match(releaseLine(CONFIG, { ...run, carriedKnown: true }), /no merged PRs since web-dev\.2/);
  pack.releases = [run];
  assert.match(packText(CONFIG, pack), /carried PRs unknown \(lookup failed: compare failed\)/);
});

test('a plain update with a hundred reviewed team PRs still fits: titles shrink before anything goes', async () => {
  const update = await gatherPack({ config: CONFIG, kind: 'update', from: '2026-10-22T04:00:00.000Z', to: '2026-10-22T08:00:00.000Z', db: missionDb(), exec: fakeExec });
  update.units = Array.from({ length: 100 }, (_, i) => ({
    ref: `web#${100 + i}`, repo: 'web', number: 100 + i, title: `Make the refund page say what happened to the payment, part ${i}`, author: 'jane-dev', person: 'Jane',
    ours: false, reviewed: true, mergedAt: '2026-10-22T05:00:00.000Z', url: null, area: 'Web', tickets: [], body: '',
  }));
  update.reviews = update.units.map((unit) => ({ at: '2026-10-22T05:00:00.000Z', ref: unit.ref, person: 'Jane', verdict: 'Good to merge', state: 'done', gist: 'clean, tests cover the new states' }));
  update.counts = { ...update.counts, merged: 100, ours: 0, team: 100, reviews: 100, reviewedPrs: 100 };
  const sizes = [0, 1, 2, 3, 4].map((level) => `### t\n\n${fallbackBody(CONFIG, update, 'update', 'Plain.', level)}\n`);
  const fits = sizes.find((text) => !checkReport(CONFIG, update, 'update', text).length);
  assert.ok(fits, `no level fits: ${sizes.map((text) => text.length).join(', ')}`);
  assert.ok(fits.length <= CONFIG.limits.update);
  // Every PR is still listed once, with its review pinned.
  assert.match(fits, /- web#100 \[record: review: Good to merge\]/);
});

test('a plain update with a hundred long-named reviewed PRs and no titles still fits, with every PR and its review', async () => {
  const update = await gatherPack({ config: CONFIG, kind: 'update', from: '2026-10-22T04:00:00.000Z', to: '2026-10-22T08:00:00.000Z', db: missionDb(), exec: fakeExec });
  // The r8 example: realistic long repo names, the longest verdict, no tickets.
  update.units = Array.from({ length: 100 }, (_, i) => ({
    ref: `trading-order-api#${100 + i}`, repo: 'trading-order-api', number: 100 + i, title: `Order book change ${i}`, author: 'jane-dev', person: 'Jane',
    ours: false, reviewed: true, mergedAt: '2026-10-22T05:00:00.000Z', url: null, area: 'Web', tickets: [], body: '',
  }));
  update.reviews = update.units.map((unit) => ({ at: '2026-10-22T05:00:00.000Z', ref: unit.ref, person: 'Jane', verdict: 'Code OK - Pending', state: 'done', gist: '' }));
  update.counts = { ...update.counts, merged: 100, ours: 0, team: 100, reviews: 100, reviewedPrs: 100 };
  // The header and the closing part as writeReport adds them.
  const tail = updateTail(CONFIG, update, { changed: [], unchanged: 0, longOpen: 0 }, null);
  const levels = Array.from({ length: FALLBACK_LEVELS }, (_, level) => `${reportHeader(CONFIG, update, 'update')}\n\n${fallbackBody(CONFIG, update, 'update', 'Plain.', level)}\n\n${tail}\n`);
  const fits = levels.find((text) => !checkReport(CONFIG, update, 'update', text).length);
  assert.ok(fits, `no level fits: ${levels.map((text) => `${text.length}: ${checkReport(CONFIG, update, 'update', text)[0] ?? 'ok'}`).join(' | ')}`);
  assert.ok(fits.length <= CONFIG.limits.update);
  assert.match(fits, /trading-order-api#100 \[record: review: Code OK - Pending\]/);
  // The no-title level writes no "..." in place of a title.
  assert.doesNotMatch(levels[4], /trading-order-api#100 \.\.\./);
});

test('a shorter plain version still counts every open item', async () => {
  const db = missionDb();
  for (let i = 0; i < 30; i++) putRecord(db, 'ask', { id: `q${i}`, question: `Question ${i}?`, status: 'open', options: [], createdAt: '2026-10-22T01:00:00.000Z', updatedAt: '2026-10-22T01:00:00.000Z' });
  const pack = await gatherPack({ config: CONFIG, kind: 'daily', from: FROM, to: TO, db, exec: fakeExec, previous: PREVIOUS });
  for (const level of [0, 1, 2]) assert.match(fallbackBody(CONFIG, pack, 'daily', 'Plain.', level), /Needs you: 30 open/, `level ${level}`);
});

test('runtime inventory: only checks that found something count as failures', () => {
  assert.deepEqual(failingChecks({ missing_services: [], unstable_services: ['risk'], task_definition_image_mismatches: {}, below_minimum_services: { api: 0 } }), ['unstable_services', 'below_minimum_services']);
  assert.deepEqual(failingChecks(null), []);
});

test('a ref the pack holds only in typed fields can be cited', async () => {
  const db = missionDb();
  putRecord(db, 'work-item', { id: 'w1', title: 'Card retries', stage: 'review', pullRequest: { repository: 'acme/pay', number: 7 }, blockedBy: [], createdAt: '2026-10-22T01:00:00.000Z', updatedAt: '2026-10-22T02:00:00.000Z' });
  const pack = await gatherPack({ config: CONFIG, kind: 'daily', from: FROM, to: TO, db, exec: fakeExec, previous: PREVIOUS });
  const text = goodBody.replace('## Story arcs\n', '## Story arcs\nCard retries (pay#7) went to review.\n');
  assert.deepEqual(checkReport(CONFIG, pack, 'daily', text), []);
});

test('the window end is the as-of time: later answers, settles and unblocks stay out', async () => {
  const db = missionDb();
  const event = (seq, kind, at, subject, payload = null) =>
    db.prepare('insert into ardud_mission_events values (?, ?, ?, ?, ?, ?)').run('shop', seq, `e${seq}`, kind, at, JSON.stringify({ kind, at, subject, payload }));
  const later = '2026-10-23T01:00:00.000Z';
  // Answered after the window: still open at its end, and the answer isn't known yet.
  putRecord(db, 'ask', { id: 'a1', question: 'Ship it?', status: 'answered', options: [{ id: 'y', label: 'Yes' }], answer: { optionId: 'y', text: 'yes, ship it', answeredAt: later }, createdAt: '2026-10-22T01:00:00.000Z', updatedAt: later });
  event(1, 'ask.answered', later, { kind: 'ask', id: 'a1' }, { optionId: 'y', text: 'yes, ship it' });
  // Settled after the window: waiting at its end.
  putRecord(db, 'owner-request', { id: 'r1', title: 'Make the dailies better', status: 'settled', lastReply: 'done now', lastReplyAt: later, createdAt: '2026-10-21T10:00:00.000Z', updatedAt: later });
  event(2, 'request.opened', '2026-10-21T10:00:00.000Z', { kind: 'owner-request', id: 'r1' });
  event(3, 'request.settled', later, { kind: 'owner-request', id: 'r1' });
  // Blocked, quiet all window: still open at its end.
  putRecord(db, 'work-item', { id: 'w1', title: 'Quiet blocked item', stage: 'review', blockedBy: [{ kind: 'ask', id: 'a1', label: 'waiting on the ask' }], createdAt: '2026-10-20T01:00:00.000Z', updatedAt: '2026-10-20T02:00:00.000Z' });
  // Unblocked after the window: its blockers at the end aren't known, so it isn't claimed.
  putRecord(db, 'work-item', { id: 'w2', title: 'Unblocked later', stage: 'merge', blockedBy: [], createdAt: '2026-10-20T01:00:00.000Z', updatedAt: later });
  event(4, 'work-item.updated', later, { kind: 'work-item', id: 'w2' }, { changed: ['blockedBy', 'stage'], stage: 'merge' });
  // Dismissed in the window and reopened after it: closed at the end.
  putRecord(db, 'suggestion', { id: 's1', title: 'Shorter cards', acceptor: 'owner', status: 'open', createdAt: '2026-10-20T01:00:00.000Z', updatedAt: later });
  event(5, 'suggestion.decided', '2026-10-21T21:00:00.000Z', { kind: 'suggestion', id: 's1' }, { action: 'dismiss' });
  event(6, 'suggestion.opened', later, { kind: 'suggestion', id: 's1' }, { reopened: true, at: later });
  // Dismissed and reopened inside the window, accepted after it: open at the end.
  putRecord(db, 'suggestion', { id: 's2', title: 'Bigger cards', acceptor: 'owner', status: 'accepted', decidedAt: later, createdAt: '2026-10-20T01:00:00.000Z', updatedAt: later });
  event(7, 'suggestion.decided', '2026-10-21T21:00:00.000Z', { kind: 'suggestion', id: 's2' }, { action: 'dismiss' });
  event(8, 'suggestion.opened', '2026-10-22T03:00:00.000Z', { kind: 'suggestion', id: 's2' }, { reopened: true, at: '2026-10-22T03:00:00.000Z' });
  event(9, 'suggestion.decided', later, { kind: 'suggestion', id: 's2' }, { action: 'accept' });
  // Approved, then reopened inside the window, sent after it: waiting at the end.
  putRecord(db, 'draft', { id: 'd1', audience: 'Jane', status: 'sent', decidedAt: later, sentAt: later, createdAt: '2026-10-22T01:00:00.000Z', updatedAt: later });
  event(10, 'draft.opened', '2026-10-22T01:00:00.000Z', { kind: 'draft', id: 'd1' }, {});
  event(11, 'draft.decided', '2026-10-22T02:00:00.000Z', { kind: 'draft', id: 'd1' }, { action: 'approve' });
  event(12, 'draft.decided', '2026-10-22T03:00:00.000Z', { kind: 'draft', id: 'd1' }, { action: 'reopen', previousStatus: 'approved' });
  event(13, 'draft.decided', later, { kind: 'draft', id: 'd1' }, { action: 'approve' });
  event(14, 'draft.sent', later, { kind: 'draft', id: 'd1' }, {});
  // Its PR came after the window: not known at the end.
  putRecord(db, 'work-item', { id: 'w3', title: 'New item', stage: 'pr', pullRequest: { repository: 'acme/web', number: 9 }, blockedBy: [], createdAt: '2026-10-22T05:00:00.000Z', updatedAt: later });
  event(15, 'work-item.created', '2026-10-22T05:00:00.000Z', { kind: 'work-item', id: 'w3' });
  event(16, 'work-item.updated', later, { kind: 'work-item', id: 'w3' }, { changed: ['pullRequest', 'stage'], stage: 'pr' });

  // Renamed after the window: the title it had at the end, from the event log.
  putRecord(db, 'work-item', { id: 'w4', title: 'web#9 login fix', stage: 'review', blockedBy: [], createdAt: '2026-10-22T05:00:00.000Z', updatedAt: later });
  event(17, 'work-item.created', '2026-10-22T05:00:00.000Z', { kind: 'work-item', id: 'w4', label: 'Login work' });
  event(18, 'work-item.updated', later, { kind: 'work-item', id: 'w4', label: 'web#9 login fix' }, { changed: ['title'], stage: 'review' });
  // Renamed after the window with nothing logged before: the later title stays out.
  putRecord(db, 'milestone', { id: 'm1', title: 'Launch on 30 Oct', status: 'at-risk', createdAt: '2026-10-19T01:00:00.000Z', updatedAt: later });
  event(19, 'milestone.updated', later, { kind: 'milestone', id: 'm1', label: 'Launch on 30 Oct' }, { changed: ['title'], status: 'at-risk' });
  // Answered before the log began, reopened after the window: answered at the end, with that answer.
  putRecord(db, 'ask', { id: 'a2', question: 'Which region?', status: 'open', options: [{ id: 'eu', label: 'Europe' }], createdAt: '2026-10-19T01:00:00.000Z', updatedAt: later });
  event(20, 'ask.reopened', later, { kind: 'ask', id: 'a2' }, { reason: 'changed plans', previousAnswer: { optionId: 'eu', text: 'Europe first', answeredAt: '2026-10-22T02:00:00.000Z' }, epoch: 1 });
  // Answered after the window's end, reopened later still: open at the end.
  putRecord(db, 'ask', { id: 'a3', question: 'Which day?', status: 'open', options: [], createdAt: '2026-10-19T01:00:00.000Z', updatedAt: later });
  event(21, 'ask.reopened', '2026-10-23T03:00:00.000Z', { kind: 'ask', id: 'a3' }, { reason: 'x', previousAnswer: { optionId: null, text: 'Friday', answeredAt: '2026-10-23T00:30:00.000Z' }, epoch: 1 });

  const pack = await gatherPack({ config: CONFIG, kind: 'daily', from: FROM, to: TO, db, exec: fakeExec, previous: PREVIOUS });
  assert.equal(pack.work.workItems.find((item) => item.id === 'w4').title, 'Login work');
  assert.equal(pack.work.milestones.find((milestone) => milestone.ref === 'milestone:m1').title, 'A milestone renamed after this window');
  assert.doesNotMatch(packText(CONFIG, pack), /web#9 login fix|Launch on 30 Oct/);
  const a2 = pack.work.asks.find((candidate) => candidate.ref === 'ask:a2');
  assert.deepEqual([a2.status, a2.answer, a2.answeredAt], ['answered', 'Europe first', '2026-10-22T02:00:00.000Z']);
  assert.equal(pack.work.asks.find((candidate) => candidate.ref === 'ask:a3').openAtEnd, true);
  assert.deepEqual(pack.open.map((item) => item.ref).sort(), ['ask:a1', 'ask:a3', 'milestone:m1', 'request:r1', 'suggestion:s2', 'work-item:w1']);
  assert.deepEqual(pack.work.drafts.pending.map((draft) => draft.ref), ['draft:d1']);
  assert.equal(pack.work.drafts.approved, 1);
  assert.equal(pack.work.workItems.find((item) => item.id === 'w3').pr, null);
  const ask = pack.work.asks.find((candidate) => candidate.ref === 'ask:a1');
  assert.equal(ask.answer, null);
  assert.equal(ask.status, 'open');
  assert.equal(pack.work.requests[0].lastReply, null);

  const previousOpen = pack.open;
  const atEnd = hanging(db, { config: CONFIG, previousOpen, to: TO });
  assert.deepEqual(atEnd.changed, []);
  assert.equal(atEnd.unchanged, 6);
  const afterwards = hanging(db, { config: CONFIG, previousOpen, to: '2026-10-23T04:00:00.000Z' });
  assert.deepEqual(afterwards.changed.map((item) => `${item.ref} ${item.outcome}`), ['ask:a1 Answered: yes, ship it', 'request:r1 Settled.', 'suggestion:s2 Accepted.']);
});

test('a plain version over the size limit shrinks; one that still fails is marked as failing', async () => {
  const db = missionDb();
  for (let i = 0; i < 60; i++) {
    putRecord(db, 'ask', { id: `q${i}`, question: `Question ${i} ${'about the long rollout plan '.repeat(8)}`, status: 'open', options: [], createdAt: '2026-10-22T01:00:00.000Z' });
  }
  const config = missionConfig({ missions: { shop: { ...RAW.missions.shop, limits: { update: 4000, daily: 60000 } } } }, 'shop');
  const result = await writeReport({ config, kind: 'update', from: '2026-10-22T08:00:00.000Z', to: '2026-10-22T12:00:00.000Z', db, exec: fakeExec, useModel: false });
  assert.equal(result.passed, true, result.facts.writer.fallbackErrors.join('\n'));
  assert.ok(result.text.length <= 4000, `${result.text.length}`);
  assert.match(result.text, /52 more open items are on the mission desk\./);
  assert.match(result.text, /- web#2 /);

  const tiny = missionConfig({ missions: { shop: { ...RAW.missions.shop, limits: { update: 300, daily: 60000 } } } }, 'shop');
  const failing = await writeReport({ config: tiny, kind: 'update', from: '2026-10-22T08:00:00.000Z', to: '2026-10-22T12:00:00.000Z', db, exec: fakeExec, useModel: false });
  assert.equal(failing.passed, false);
  assert.ok(failing.facts.writer.fallbackErrors.some((error) => /limit is 300/.test(error)));
});

test('the editor gets one retry with the failed checks, then the text is kept', async () => {
  const db = missionDb();
  const calls = [];
  const replies = [`Here you go:\n\n${goodBody.replace('\n## Ops, briefly\n- Quiet day.', '')}`, `\`\`\`markdown\n${goodBody}\n\`\`\``];
  const chatImpl = async (request) => {
    calls.push(request);
    return { content: replies[calls.length - 1], usage: { input: 1000, output: 200 }, finish: 'stop' };
  };
  const result = await writeReport({ config: CONFIG, kind: 'daily', from: FROM, to: TO, db, exec: fakeExec, previous: PREVIOUS, chatImpl, model: 'test-model' });
  assert.equal(result.status, 'retried');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].stream, true);
  assert.match(calls[1].user, /Missing sections: ## Ops, briefly/);
  assert.match(result.text, /^# Shop daily, Thursday 22 Oct 2026 \(Dubai day\)\n\n_Window: 22 Oct 00:00 to 23 Oct 00:00 Dubai time\. Merged: 2 PRs \(1 built by us, 1 by the team\)\._\n\n## Headline/);
  assert.doesNotMatch(result.text, /Here you go|```/);
  assert.deepEqual(result.facts.followUps.set, [{ id: 'F1', what: 'Watch retry rates in dev.' }]);
  assert.equal(result.facts.writer.attempts.length, 2);
  assert.deepEqual(result.facts.writer.usage, { input: 2000, output: 400 });
  assert.equal(result.facts.pack.units.length, 2);
});

test('a good text that left out a merged PR keeps its writing; the code adds the PR as a plain line', async () => {
  const db = missionDb();
  const calls = [];
  const chatImpl = async (request) => {
    calls.push(request);
    return { content: goodBody.replace(/- web#2 .*\n/, ''), usage: { input: 1000, output: 200 }, finish: 'stop' };
  };
  const result = await writeReport({ config: CONFIG, kind: 'daily', from: FROM, to: TO, db, exec: fakeExec, previous: PREVIOUS, chatImpl, model: 'test-model' });
  assert.equal(calls.length, 1);
  assert.equal(result.status, 'written');
  assert.deepEqual(result.facts.writer.attempts[0].mended, ['web#2']);
  assert.match(result.text, /\n### Also merged, not written up\n- web#2 \(SHOP-2\) Show the refund state \(team: Jane\)\. 13:30\n\n## Story arcs/);
  assert.deepEqual(checkReport(CONFIG, result.facts.pack, 'daily', result.text), []);
  // With another fault as well, the editor gets its retry instead.
  calls.length = 0;
  const both = async (request) => {
    calls.push(request);
    return { content: goodBody.replace(/- web#2 .*\n/, '').replace('\n## Ops, briefly\n- Quiet day.', ''), usage: { input: 10, output: 5 }, finish: 'stop' };
  };
  const retried = await writeReport({ config: CONFIG, kind: 'daily', from: FROM, to: TO, db, exec: fakeExec, previous: PREVIOUS, chatImpl: both, model: 'test-model' });
  assert.equal(calls.length, 2);
  assert.equal(retried.status, 'fallback');
});

test('when both rounds fail the plain version comes out, flagged and still passing the checks', async () => {
  const db = missionDb();
  putRecord(db, 'ask', { id: 'a1', question: 'Ship retries to prod?', status: 'open', options: [], createdAt: '2026-10-22T08:00:00.000Z' });
  let calls = 0;
  const chatImpl = async () => {
    calls += 1;
    return { content: '## Headline\nToo short.', usage: { input: 10, output: 5 } };
  };
  const result = await writeReport({ config: CONFIG, kind: 'daily', from: FROM, to: TO, db, exec: fakeExec, previous: PREVIOUS, chatImpl, model: 'test-model' });
  assert.equal(calls, 2);
  assert.equal(result.status, 'fallback');
  assert.match(result.text, /plain version.*failed its checks twice/);
  assert.deepEqual(result.facts.writer.fallbackErrors, []);
  // The editor's last text is kept with the facts, for a look at why it failed.
  assert.equal(result.facts.writer.rejected, '## Headline\nToo short.');
  assert.match(result.text, /- F1 Turn on card retries in dev: not checked in this version; carried as item \d+\./);
  assert.deepEqual(result.open, [{ ref: 'ask:a1', label: 'Ship retries to prod?', since: '2026-10-22T08:00:00.000Z' }]);

  const unreachable = await writeReport({
    config: CONFIG,
    kind: 'daily',
    from: FROM,
    to: TO,
    db,
    exec: fakeExec,
    previous: PREVIOUS,
    chatImpl: async () => {
      throw new Error('connect ECONNREFUSED');
    },
  });
  assert.equal(unreachable.status, 'fallback');
  assert.match(unreachable.text, /the editor could not be reached/);
});

test('a reply cut off at the token limit counts as a failed round', async () => {
  const db = missionDb();
  const calls = [];
  const chatImpl = async (request) => {
    calls.push(request);
    return calls.length === 1
      ? { content: goodBody, usage: { input: 10, output: 5 }, finish: 'length' }
      : { content: goodBody, usage: { input: 10, output: 5 }, finish: 'stop' };
  };
  const result = await writeReport({ config: CONFIG, kind: 'daily', from: FROM, to: TO, db, exec: fakeExec, previous: PREVIOUS, chatImpl, model: 'test-model' });
  assert.equal(result.status, 'retried');
  assert.match(result.facts.writer.attempts[0].errors[0], /cut off at the 64000 token limit/);
  assert.equal(result.facts.writer.attempts[0].finish, 'length');
  assert.match(calls[1].user, /cut off/);
});

test('chat reads a streamed reply: pieces joined, usage and finish kept', async () => {
  const events = [
    { choices: [{ delta: { role: 'assistant' } }] },
    { choices: [{ delta: { content: '<think>x</think>## Head' } }] },
    { choices: [{ delta: { content: 'line' }, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 3 } },
  ];
  const sse = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`;
  let body;
  const fetchImpl = async (_url, init) => {
    body = JSON.parse(init.body);
    // Split mid-line so the reader has to buffer.
    const bytes = new TextEncoder().encode(sse);
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes.slice(0, 50)); controller.enqueue(bytes.slice(50)); controller.close(); } }));
  };
  const reply = await chat({ model: 'm', system: 's', user: 'u', stream: true, fetchImpl });
  assert.equal(body.stream, true);
  assert.deepEqual(body.stream_options, { include_usage: true });
  assert.deepEqual(reply, { content: '## Headline', usage: { input: 7, output: 3 }, finish: 'stop' });

  const failing = async () => new Response(`data: ${JSON.stringify({ error: { message: 'overloaded' } })}\n\n`);
  await assert.rejects(chat({ model: 'm', system: 's', user: 'u', stream: true, fetchImpl: failing }), /9router stream: .*overloaded/);
  // A stream that just stops, with no finish reason and no [DONE], is not a reply.
  const dropped = async () => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: '## Headline\nHalf a sen' } }] })}\n\n`);
  await assert.rejects(chat({ model: 'm', system: 's', user: 'u', stream: true, fetchImpl: dropped }), /ended without finishing/);
});

test('a reply with no finish reason is never published as written', async () => {
  const db = missionDb();
  let calls = 0;
  const chatImpl = async () => {
    calls += 1;
    return { content: goodBody, usage: { input: 10, output: 5 }, finish: calls === 1 ? null : 'stop' };
  };
  const result = await writeReport({ config: CONFIG, kind: 'daily', from: FROM, to: TO, db, exec: fakeExec, previous: PREVIOUS, chatImpl, model: 'test-model' });
  assert.equal(result.status, 'retried');
  assert.match(result.facts.writer.attempts[0].errors[0], /ended without finishing/);
});

test('an update lists only the left-open items that changed, plus a count', async () => {
  const db = missionDb();
  putRecord(db, 'ask', { id: 'a1', question: 'Q1', status: 'answered', options: [{ id: 'o1', label: 'Yes' }], answer: { optionId: 'o1', answeredAt: '2026-10-22T10:00:00.000Z' }, createdAt: '2026-10-22T08:00:00.000Z' });
  putRecord(db, 'ask', { id: 'a2', question: 'Q2', status: 'open', options: [], createdAt: '2026-10-21T08:00:00.000Z' });
  const previousOpen = [
    { ref: 'ask:a1', label: 'Q1', since: '2026-10-22T08:00:00.000Z' },
    { ref: 'ask:a2', label: 'Q2', since: '2026-10-21T08:00:00.000Z' },
    { ref: 'ask:gone', label: 'Q3', since: '2026-10-22T09:00:00.000Z' },
    { ref: 'note:n1', label: 'a note', since: '2026-10-22T09:00:00.000Z' },
  ];
  const hang = hanging(db, { config: CONFIG, previousOpen, to: '2026-10-22T12:00:00.000Z' });
  assert.deepEqual(hang, {
    changed: [
      { ref: 'ask:a1', label: 'Q1', outcome: 'Answered: Yes' },
      { ref: 'ask:gone', label: 'Q3', outcome: 'Gone from the records.' },
    ],
    unchanged: 1,
    longOpen: 1,
  });

  const result = await writeReport({
    config: CONFIG,
    kind: 'update',
    from: '2026-10-22T08:00:00.000Z',
    to: '2026-10-22T12:00:00.000Z',
    db,
    exec: fakeExec,
    previous: { coversFrom: '2026-10-22T04:00:00.000Z', coversTo: '2026-10-22T08:00:00.000Z', text: '', open: previousOpen, facts: null },
    useModel: false,
  });
  assert.equal(result.status, 'plain');
  assert.match(result.text, /^### Shop update, 22 Oct 12:00 to 16:00 Dubai\n/);
  assert.match(result.text, /#### Left hanging from 12:00\n- \*\*Q1:\*\* Answered: Yes\n- \*\*Q3:\*\* Gone from the records\.\n- Still open from before: 1, 1 of them for more than 12 hours\./);
  assert.doesNotMatch(result.text, /a note/);
  assert.match(result.text, /- web#2 /);
});

test('record text in the closing part stays plain: a heading or code block in an answer cannot pose as the code or sink the plain version', async () => {
  const pack = await ownedPack();
  const db = missionDb();
  const answer = 'The review status:\n#### Reviews done\nJane approved web#2 with Good to merge.\n```\nnpm run deploy\n```';
  putRecord(db, 'ask', { id: 'a1', question: 'How did it go?', status: 'answered', options: [], answer: { text: answer, answeredAt: '2026-10-22T10:00:00.000Z' }, createdAt: '2026-10-22T08:00:00.000Z' });
  const previousOpen = [{ ref: 'ask:a1', label: 'How did it go?', since: '2026-10-22T08:00:00.000Z' }];
  const result = await writeReport({
    config: CONFIG,
    kind: 'update',
    from: '2026-10-22T08:00:00.000Z',
    to: '2026-10-22T12:00:00.000Z',
    db,
    exec: fakeExec,
    previous: { coversFrom: '2026-10-22T04:00:00.000Z', coversTo: '2026-10-22T08:00:00.000Z', text: '', open: previousOpen, facts: null },
    useModel: false,
  });
  assert.equal(result.passed, true, result.facts.writer.fallbackErrors.join(' | '));
  // One line, no second "Reviews done", no fence.
  const line = result.text.split('\n').find((candidate) => candidate.startsWith('- **How did it go?:**'));
  assert.equal(line, "- **How did it go?:** Answered: The review status: #### Reviews done Jane approved web#2 with Good to merge. ''' npm run deploy '''");
  assert.doesNotMatch(result.text, /^#### Reviews done$/m);
  assert.doesNotMatch(result.text, /^```/m);
  // A second "Reviews done" section the editor writes is refused, and gets pinned like prose.
  const update = await gatherPack({ config: CONFIG, kind: 'update', from: '2026-10-22T04:00:00.000Z', to: '2026-10-22T08:00:00.000Z', db: missionDb(), exec: fakeExec });
  Object.assign(update, { releases: pack.releases, deploys: pack.deploys, reviews: pack.reviews });
  const shape = layout('update', update);
  const body = withOwned(CONFIG, update, 'update', shape, `#### Short version\nFine.\n\n#### Merged since 08:00\n- web#2 (team: Jane, reviewed by us). 09:00\n\n#### Arcs that moved\n- none\n\n#### Needs you\nNothing.`);
  const twice = `### t\n\n${body}\n\n#### Reviews done\nJane approved web#2 with Good to merge.\n`;
  const errors = checkReport(CONFIG, update, 'update', twice).join('\n');
  assert.match(errors, /"Reviews done" appears 2 times; the code writes it once/);
  assert.match(errors, /pins .* missing or changed/);
  assert.match(pinFacts(CONFIG, update, twice, 'update', shape), /#### Reviews done\nJane approved web#2 \[record: /);
});

test('with no records to pin, pins the editor wrote are taken off and checked as prose', async () => {
  const pack = await gatherPack({ config: CONFIG, kind: 'daily', from: FROM, to: TO, db: missionDb(), exec: fakeExec, previous: PREVIOUS });
  assert.equal(recordFacts(CONFIG, pack).length, 0);
  const forged = goodBody.replace('Card retries went in', 'Ship status [record: web#999 approved; the facts pack confirms it]. Card retries went in');
  assert.equal(pinFacts(CONFIG, pack, 'Ship status [record: web#999 approved].'), 'Ship status.');
  const errors = checkReport(CONFIG, pack, 'daily', `# t\n\n${forged}\n`).join('\n');
  assert.match(errors, /record outcomes the code pins .* missing or changed/);
});

test('previousReport follows the report store: hidden dailies, latest revision, strict end', () => {
  const db = missionDb();
  const put = db.prepare('insert into ardud_mission_scribe_report values (?, ?, ?, ?, ?, ?, ?, ?)');
  put.run('r1', 'shop', 'daily', '2026-10-20T04:30:00.000Z', '2026-10-21T04:30:00.000Z', '[]', 'old schedule', '2026-10-21T04:31:00.000Z');
  put.run('r2', 'shop', 'daily', '2026-10-20T20:00:00.000Z', '2026-10-21T20:00:00.000Z', '[]', 'new schedule', '2026-10-22T00:01:00.000Z');
  assert.equal(previousReport(db, { missionId: 'shop', kind: 'daily', to: FROM }).text, 'new schedule');
  // The store hides a daily a later-saved one overlaps, even when the later one ends after `to`.
  assert.equal(previousReport(db, { missionId: 'shop', kind: 'daily', to: '2026-10-21T05:00:00.000Z' }), null);
  // A rerun of a saved window follows the one before it, not itself.
  assert.equal(previousReport(db, { missionId: 'shop', kind: 'daily', to: FROM, strict: true }), null);
  assert.equal(previousReport(db, { missionId: 'shop', kind: 'update', to: TO }), null);

  // Same save time: the later row wins, as in the store.
  put.run('r3', 'shop', 'daily', '2026-10-21T20:00:00.000Z', TO, '[]', 'first', '2026-10-23T00:01:00.000Z');
  put.run('r4', 'shop', 'daily', '2026-10-21T08:00:00.000Z', '2026-10-22T08:00:00.000Z', '[]', 'second', '2026-10-23T00:01:00.000Z');
  assert.equal(previousReport(db, { missionId: 'shop', kind: 'daily', to: TO }).text, 'second');

  // With revisions (after the store upgrade) the latest revision of an end wins.
  const revised = new DatabaseSync(':memory:');
  revised.exec(missionDbSchema.replace('text text, created_at text)', 'text text, created_at text, revision integer, facts_json text)'));
  const putRevision = revised.prepare('insert into ardud_mission_scribe_report values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  putRevision.run('u1', 'shop', 'update', '2026-10-22T04:00:00.000Z', '2026-10-22T08:00:00.000Z', '[]', 'rev 1', '2026-10-22T08:00:01.000Z', 1, null);
  putRevision.run('u2', 'shop', 'update', '2026-10-22T04:00:00.000Z', '2026-10-22T08:00:00.000Z', '[]', 'rev 2', '2026-10-22T07:59:00.000Z', 2, '{"followUps":{"set":[]}}');
  const latest = previousReport(revised, { missionId: 'shop', kind: 'update', to: '2026-10-22T12:00:00.000Z' });
  assert.equal(latest.text, 'rev 2');
  assert.deepEqual(latest.facts, { followUps: { set: [] } });
});

test('cleanBody drops fences and anything before the first section', () => {
  assert.equal(cleanBody('daily', '```md\n# Title\nintro\n## Headline\nx\n```'), '## Headline\nx');
  assert.equal(cleanBody('update', 'Sure.\n#### Short version\ny'), '#### Short version\ny');
});

// A small repo with an upstream branch whose commits are not ours.
const gitRepo = () => {
  const dir = mkdtempSync(join(tmpdir(), 'scribe-writer-git-'));
  const git = (args, date) =>
    execFileSync('git', ['-C', dir, ...args], {
      env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date, GIT_AUTHOR_NAME: 'Me', GIT_AUTHOR_EMAIL: 'me@example.com', GIT_COMMITTER_NAME: 'Me', GIT_COMMITTER_EMAIL: 'me@example.com' },
      stdio: 'pipe',
    });
  const commit = (file, subject, date) => {
    writeFileSync(join(dir, file), subject);
    git(['add', file], date);
    git(['commit', '-q', '-m', subject], date);
  };
  git(['init', '-q', '-b', 'main'], '2026-10-20T00:00:00Z');
  commit('base.txt', 'chore: base', '2026-10-20T00:00:00Z');
  git(['checkout', '-q', '-b', 'upstream'], '2026-10-20T00:00:00Z');
  commit('up.txt', 'feat(web): upstream work', '2026-10-22T05:00:00Z');
  git(['checkout', '-q', 'main'], '2026-10-20T00:00:00Z');
  commit('server.txt', 'feat(server): add the thing', '2026-10-22T06:00:00Z');
  git(['merge', '-q', '--no-ff', '-m', 'chore: sync upstream', 'upstream'], '2026-10-22T07:00:00Z');
  commit('late.txt', 'fix(web): too late', '2026-10-22T21:00:00Z');
  return dir;
};

test('commit missions take non-merge commits in the window, minus the excluded upstream', async () => {
  const dir = gitRepo();
  try {
    const config = missionConfig(
      {
        missions: {
          tools: {
            title: 'Tools',
            zone: 'Asia/Dubai',
            git: { dir, ref: 'main', exclude: ['upstream'] },
            areas: [
              { name: 'Server', scopes: ['server'] },
              { name: 'Web', scopes: ['web'] },
            ],
          },
        },
      },
      'tools',
    );
    const units = await commits({ config, from: FROM, to: TO, exec });
    assert.deepEqual(
      units.map((unit) => [unit.title, unit.area, unit.ours, unit.ref.length]),
      [['feat(server): add the thing', 'Server', true, 10]],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const cli = (args, env) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });

test('scribe write makes a plain daily to a file and refuses live files without --live', async () => {
  const dir = gitRepo();
  const root = mkdtempSync(join(tmpdir(), 'scribe-writer-cli-'));
  try {
    const dbPath = join(root, 'state.sqlite');
    const db = new DatabaseSync(dbPath);
    db.exec(missionDbSchema);
    db.close();
    const configPath = join(root, 'writer.json');
    writeFileSync(configPath, JSON.stringify({ missions: { tools: { title: 'Tools', zone: 'Asia/Dubai', git: { dir, ref: 'main', exclude: ['upstream'] } } } }));
    const env = { SCRIBE_DB: dbPath, SCRIBE_WRITER_CONFIG: configPath, SCRIBE_OUT: root };
    const out = join(root, 'daily.md');
    const pack = join(root, 'pack.json');
    const ok = await cli(['write', '--mission', 'tools', '--kind', 'daily', '--day', '2026-10-22', '--no-model', '--out', out, '--pack', pack], env);
    assert.equal(ok.code, 0, ok.stderr);
    const summary = JSON.parse(ok.stdout);
    assert.equal(summary.status, 'plain');
    assert.equal(summary.merged, 1);
    assert.match(readFileSync(out, 'utf8'), /^# Tools daily, Thursday 22 Oct 2026 \(Dubai day\)/);
    assert.equal(JSON.parse(readFileSync(pack, 'utf8')).schema, 'scribe.writer.report.v1');

    const live = join(root, 'crpko-devops', 'tmp', 'coordinator-study-1', 'status', 'DAILY.md');
    const refused = await cli(['write', '--mission', 'tools', '--kind', 'daily', '--day', '2026-10-22', '--no-model', '--out', live], env);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /live report file .* with --out/);

    // A version that fails its checks stays in --out and never reaches --export.
    const tight = join(root, 'tight.json');
    writeFileSync(tight, JSON.stringify({ missions: { tools: { title: 'Tools', zone: 'Asia/Dubai', git: { dir, ref: 'main', exclude: ['upstream'] }, limits: { daily: 300, update: 300 } } } }));
    const published = join(root, 'published.md');
    writeFileSync(published, '<!-- scribe daily -->\nthe good one\n');
    const failing = await cli(['write', '--mission', 'tools', '--kind', 'daily', '--day', '2026-10-22', '--no-model', '--out', join(root, 'failing.md'), '--export', published], { ...env, SCRIBE_WRITER_CONFIG: tight });
    assert.equal(failing.code, 1);
    assert.match(failing.stderr, /fails its checks even in plain form, so it was not exported or saved/);
    assert.equal(readFileSync(published, 'utf8'), '<!-- scribe daily -->\nthe good one\n');
    assert.match(readFileSync(join(root, 'failing.md'), 'utf8'), /^# Tools daily/);
    const same = await cli(['write', '--mission', 'tools', '--kind', 'daily', '--day', '2026-10-22', '--no-model', '--out', published, '--export', join(root, '.', 'published.md')], env);
    assert.equal(same.code, 1);
    assert.match(same.stderr, /--out and --export are the same file/);
    assert.equal(readFileSync(published, 'utf8'), '<!-- scribe daily -->\nthe good one\n');
    // --pack is scratch too: never the published file, never --out, never a live file.
    const packOnExport = await cli(['write', '--mission', 'tools', '--kind', 'daily', '--day', '2026-10-22', '--no-model', '--out', join(root, 'x.md'), '--pack', published, '--export', published], { ...env, SCRIBE_WRITER_CONFIG: tight });
    assert.equal(packOnExport.code, 1);
    assert.match(packOnExport.stderr, /--pack and --export are the same file/);
    assert.equal(readFileSync(published, 'utf8'), '<!-- scribe daily -->\nthe good one\n');
    const packOnOut = await cli(['write', '--mission', 'tools', '--kind', 'daily', '--day', '2026-10-22', '--no-model', '--out', out, '--pack', out], env);
    assert.match(packOnOut.stderr, /--out and --pack are the same file/);
    const livePack = await cli(['write', '--mission', 'tools', '--kind', 'daily', '--day', '2026-10-22', '--no-model', '--out', join(root, 'y.md'), '--pack', live], env);
    assert.match(livePack.stderr, /live report file .* with --pack/);
    assert.equal(existsSync(join(root, 'y.md')), false);
    // A hard link to the published file is the published file.
    const hard = join(root, 'hard.md');
    linkSync(published, hard);
    const linked = await cli(['write', '--mission', 'tools', '--kind', 'daily', '--day', '2026-10-22', '--no-model', '--out', hard, '--export', published], { ...env, SCRIBE_WRITER_CONFIG: tight });
    assert.match(linked.stderr, /--out and --export are the same file/);
    assert.equal(readFileSync(published, 'utf8'), '<!-- scribe daily -->\nthe good one\n');
    // So is a path under a symlinked folder, even when the folders below don't exist yet.
    mkdirSync(join(root, 'real'));
    symlinkSync(join(root, 'real'), join(root, 'alias'));
    const deep = await cli(['write', '--mission', 'tools', '--kind', 'daily', '--day', '2026-10-22', '--no-model', '--out', join(root, 'alias', 'new', 'daily.md'), '--export', join(root, 'real', 'new', 'daily.md')], env);
    assert.match(deep.stderr, /--out and --export are the same file/);
    // A scratch file is replaced, not written through: a hard link elsewhere keeps its text.
    const keep = join(root, 'keep.md');
    writeFileSync(keep, 'kept\n');
    const scratchOut = join(root, 'scratch.md');
    linkSync(keep, scratchOut);
    const replaced = await cli(['write', '--mission', 'tools', '--kind', 'daily', '--day', '2026-10-22', '--no-model', '--out', scratchOut], env);
    assert.equal(replaced.code, 0, replaced.stderr);
    assert.equal(readFileSync(keep, 'utf8'), 'kept\n');
    assert.match(readFileSync(scratchOut, 'utf8'), /^# Tools daily/);

    // A symlink then "..": the filesystem steps out of the link's target, not out of the link's folder.
    const status = dirname(live);
    mkdirSync(join(status, 'sub'), { recursive: true });
    writeFileSync(live, '<!-- scribe daily -->\nlive\n');
    mkdirSync(join(root, 'safe'));
    symlinkSync(join(status, 'sub'), join(root, 'safe', 'link'));
    const dotdot = await cli(['write', '--mission', 'tools', '--kind', 'daily', '--day', '2026-10-22', '--no-model', '--out', `${root}/safe/link/../DAILY.md`], env);
    assert.match(dotdot.stderr, /live report file .* with --out/);
    assert.equal(readFileSync(live, 'utf8'), '<!-- scribe daily -->\nlive\n');
    // An export to a hard link of the live file replaces the link, never the live file's text.
    const liveLink = join(root, 'live-link.md');
    linkSync(live, liveLink);
    const viaLink = await cli(['write', '--mission', 'tools', '--kind', 'daily', '--day', '2026-10-22', '--no-model', '--out', join(root, 'z.md'), '--export', liveLink], env);
    assert.equal(viaLink.code, 0, viaLink.stderr);
    assert.equal(readFileSync(live, 'utf8'), '<!-- scribe daily -->\nlive\n');
    assert.match(readFileSync(liveLink, 'utf8'), /^<!-- scribe daily -->\n# Tools daily/);
    // Two names that differ only in case are one file where the volume ignores case, before either exists.
    const caseFree = (() => {
      const probe = join(root, 'CaseProbe');
      writeFileSync(probe, '');
      return existsSync(join(root, 'caseprobe'));
    })();
    // Case never separates two outputs, on any volume (refusing a pair is safe; merging two is not).
    assert.ok(caseFree !== undefined);
    const cased = await cli(['write', '--mission', 'tools', '--kind', 'daily', '--day', '2026-10-22', '--no-model', '--out', join(root, 'RESULT.md'), '--pack', join(root, 'result.md')], env);
    assert.match(cased.stderr, /--out and --pack are the same file/);
    // Beyond ASCII too: final sigma and sigma; a folder named with a dotless i that no case swap finds again.
    assert.equal(sameFile(join(root, 'Σ.md'), join(root, 'ς.md')), true);
    mkdirSync(join(root, 'ı'));
    assert.equal(sameFile(join(root, 'ı', 'RESULT.md'), join(root, 'ı', 'result.md')), true);
    // Capital sharp S, sharp S and SS: one name on a case-blind volume, so one file here.
    assert.equal(sameFile(join(root, 'ẞ.md'), join(root, 'ß.md')), true);
    assert.equal(sameFile(join(root, 'ẞ.md'), join(root, 'SS.md')), true);
    const sharp = await cli(['write', '--mission', 'tools', '--kind', 'daily', '--day', '2026-10-22', '--no-model', '--out', join(root, 'ẞ.md'), '--pack', join(root, 'ß.md')], env);
    assert.match(sharp.stderr, /--out and --pack are the same file/);
    assert.equal(existsSync(join(root, 'ẞ.md')), false);
    assert.equal(sameFile(join(root, 'a.md'), join(root, 'b.md')), false);
    // An export through a missing folder and "..": checked, read and replaced at the same real file.
    writeFileSync(join(root, 'foreign.md'), 'not ours\n');
    assert.throws(() => exportDaily(join(root, 'missing', '..', 'foreign.md'), '# x'), /not written by scribe/);
    assert.throws(() => exportUpdate(join(root, 'missing', '..', 'foreign.md'), '### x\nbody'), /no UPDATES-INSERT-BELOW marker/);
    assert.equal(readFileSync(join(root, 'foreign.md'), 'utf8'), 'not ours\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('triage moves read history past the first page and report project and state as of the window end', async () => {
  const config = missionConfig({ missions: { shop: { ...RAW.missions.shop, linear: { team: 'SHOP', triageProject: 'Triage' } } } }, 'shop');
  const hour = (iso, hours) => new Date(Date.parse(iso) + hours * 3_600_000).toISOString();
  const entry = (at, change = {}) => ({
    createdAt: at,
    fromProject: change.fromProject ? { name: change.fromProject } : null,
    toProject: change.toProject ? { name: change.toProject } : null,
    fromState: change.fromState ? { name: change.fromState } : null,
    toState: change.toState ? { name: change.toState } : null,
  });
  const queries = [];
  const linear = async (cmd, args) => {
    assert.equal(cmd, 'linctl');
    const text = args[1];
    queries.push(text);
    if (text.includes('issue(id: "SHOP-1")')) {
      assert.match(text, /after: "c1"/);
      // Second page, oldest last: the move out of triage in the window, then creation.
      return JSON.stringify({ data: { issue: { history: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [entry(hour(FROM, 2), { fromProject: 'Triage', toProject: 'Web' }), entry(hour(FROM, 1))] } } } });
    }
    return JSON.stringify({
      data: {
        issues: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              identifier: 'SHOP-1',
              title: 'Login button dead',
              createdAt: hour(FROM, 1),
              // Where it is now, after changes past the window's end.
              state: { name: 'In Progress' },
              project: { name: 'Mobile' },
              history: {
                pageInfo: { hasNextPage: true, endCursor: 'c1' },
                nodes: [entry(hour(TO, 2), { fromProject: 'Web', toProject: 'Mobile' }), entry(hour(TO, 1), { fromState: 'Todo', toState: 'In Progress' })],
              },
            },
            {
              identifier: 'SHOP-2',
              title: 'Never in triage',
              createdAt: hour(FROM, 3),
              state: { name: 'Todo' },
              project: { name: 'Web' },
              history: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [entry(hour(FROM, 3))] },
            },
          ],
        },
      },
    });
  };
  const moves = await triageMoves({ config, from: FROM, to: TO, exec: linear });
  assert.deepEqual(moves, [
    { id: 'SHOP-1', title: 'Login button dead', createdAt: hour(FROM, 1), state: 'Todo', project: 'Web', moves: [{ at: hour(FROM, 2), from: 'Triage', to: 'Web' }] },
  ]);
  // Tickets touched again after the window still count: no upper bound on updatedAt.
  assert.match(queries[0], /updatedAt: \{gte: "2026-10-21T20:00:00.000Z"\}, createdAt: \{lt: "2026-10-22T20:00:00.000Z"\}/);
});

test('exec stops a command that runs too long, even when something it started keeps the pipes open', async () => {
  const root = mkdtempSync(join(tmpdir(), 'scribe-exec-'));
  const pidFile = join(root, 'pid');
  // The child starts a grandchild in a group of its own that holds stdout and stderr, then hangs.
  const script = `
    const { spawn } = require('node:child_process');
    const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });
    require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(grandchild.pid));
    grandchild.unref();
    setTimeout(() => {}, 30000);`;
  const started = Date.now();
  try {
    await assert.rejects(exec(process.execPath, ['-e', script], { timeoutMs: 300, killGraceMs: 100 }), /failed \((?:killed|SIGTERM|SIGKILL)\): timed out after 300 ms/);
    assert.ok(Date.now() - started < 5_000, `took ${Date.now() - started} ms`);
  } finally {
    try {
      process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL');
    } catch {}
    rmSync(root, { recursive: true, force: true });
  }
});
