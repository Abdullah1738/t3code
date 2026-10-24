#!/usr/bin/env node
// scribe: reads mission lane transcripts and writes cited notes.
//
//   scribe run [--mission ID] [--slices N] [--min-severity S]
//                                                   one pass over every lane the server lists
//   scribe dry-run --thread ID [--name N] [--since ISO | --from EVENT] [--slices N] [--min-severity S] [--out DIR]
//                                                   one lane, real model, notes to files only
//   scribe editor --mission ID [--input FILE] [--out FILE]
//                                                   one Opus editor pass (bottom line, FYI, feed, suggestions);
//                                                   --out or --input keeps the reply in a file and stores nothing
//   scribe report --mission ID --kind update|daily [--since ISO] [--to ISO] [--save] [--out FILE] [--live]
//                                                   build a report from mission data; export it (scratch by default;
//                                                   the live Crpko status files only with --live)
//   scribe write --mission ID --kind daily|update [--day YYYY-MM-DD | --from ISO --to ISO] [--previous FILE]
//                [--out FILE] [--pack FILE] [--export FILE [--live]] [--save] [--no-model] [--config FILE]
//                                                   gather the facts pack (merged PRs or commits, reviews, releases,
//                                                   mission records), have the editor write the report, check it,
//                                                   retry once, else the plain render; to a file, with --save to
//                                                   the mission. Daily windows are whole days in the mission's zone
//                                                   (default: the last one); updates run from the last update.
//                                                   Per-mission sources: ~/.config/scribe/writer.json
//   scribe watch --mission ID [--sweep-minutes 15] [--slices N] [--min-severity S]
//                                                   a run pass whenever a lane's run settles, plus a sweep;
//                                                   runs until stopped
//
// --min-severity low|medium|high|critical keeps only notes at or above it (plus
// updates to notes already on record); by default every note is kept.
//
// Nothing here starts itself; the cutover's LaunchAgents or a person do
// (tmp/memory/cutover/scribe-schedules.json in the Robob checkout).
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendFileSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { chat, EDITOR_MODEL, SCRIBE_MODEL } from './lib/model.mjs';
import { eventsAfter, firstEventSince, openDb, threadInfo } from './lib/source.mjs';
import { runLane, severityFloor } from './lib/run.mjs';
import { localSink } from './lib/local.mjs';
import { controlConfig, serverClient, serverSink } from './lib/server.mjs';

const SCRATCH = process.env.SCRIBE_OUT || join(process.env.TMPDIR || tmpdir(), 'opencode', 'missions-scribe');

function parseArgs(argv) {
  const [cmd = 'help', ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (!arg.startsWith('--')) continue;
    const name = arg.slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith('--')) opts[name] = true;
    else {
      opts[name] = next;
      i += 1;
    }
  }
  return { cmd, opts };
}

const log = (line) => process.stderr.write(`${line}\n`);
const ask = (model) => ({ system, user }) => chat({ model, system, user });

async function dryRun(opts) {
  if (!opts.thread) throw new Error('dry-run needs --thread');
  severityFloor(opts['min-severity']);
  const db = openDb();
  const info = threadInfo(db, opts.thread);
  if (!info) throw new Error(`thread not found: ${opts.thread}`);
  const out = opts.out || join(SCRATCH, 'dry-run');
  const missionId = opts.mission || 'dry-run';
  const sink = localSink(out, { threadId: opts.thread, missionId });
  // A lane with no cursor starts at --from, or the first run since --since.
  if ((await sink.cursor()) === 0) {
    const start = opts.from ? Number(opts.from) : opts.since ? firstEventSince(db, opts.thread, opts.since) : null;
    if (start !== null && start > 0) sink.setCursor(start - 1);
  }
  const lane = {
    name: opts.name || info.title,
    purpose: opts.purpose || null,
    threadId: opts.thread,
    missionId,
    laneId: opts.lane || null,
    model: SCRIBE_MODEL,
  };
  // Dry runs keep every raw reply next to the batches, for prompt tuning.
  const askModel = ask(SCRIBE_MODEL);
  const recordingAsk = async (request) => {
    const reply = await askModel(request);
    appendFileSync(join(out, 'replies.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), ...reply })}\n`);
    return reply;
  };
  const summary = await runLane({
    lane,
    readEvents: (after, limit) => eventsAfter(db, opts.thread, after, limit),
    ask: recordingAsk,
    sink,
    maxSlices: Number(opts.slices || 3),
    minSeverity: opts['min-severity'],
    log,
  });
  db.close();
  return { ...summary, out };
}

async function run(opts, client) {
  // Checked before any lane or credential read, so a typo fails as a typo.
  severityFloor(opts['min-severity']);
  client ??= serverClient();
  const db = openDb();
  const lanes = await client.lanes(opts.mission);
  const results = [];
  for (const lane of lanes) {
    try {
      results.push(
        await runLane({
          lane: { ...lane, model: SCRIBE_MODEL },
          readEvents: (after, limit) => eventsAfter(db, lane.threadId, after, limit),
          ask: ask(SCRIBE_MODEL),
          sink: serverSink(client, lane),
          maxSlices: Number(opts.slices || 10),
          minSeverity: opts['min-severity'],
          log,
        }),
      );
    } catch (error) {
      // One broken lane must not stop the others; the next pass retries it from its cursor.
      results.push({ lane: lane.name, threadId: lane.threadId, error: error.message });
    }
  }
  db.close();
  return { lanes: results };
}

async function editor(opts) {
  if (!opts.mission) throw new Error('editor needs --mission');
  const { runEditor } = await import('./lib/editor.mjs');
  // --input reads a saved editor input instead of asking the server (a dry pass by hand).
  const client = opts.input ? null : serverClient();
  const input = opts.input
    ? JSON.parse(readFileSync(opts.input, 'utf8'))
    : await client.editorInput(opts.mission);
  const result = await runEditor({
    input,
    ask: ask(EDITOR_MODEL),
    model: EDITOR_MODEL,
    post: opts.out || !client ? null : (output) => client.postEditor(output),
  });
  const out = opts.out || (client ? null : join(SCRATCH, 'editor-reply.json'));
  if (out) write(out, `${JSON.stringify(result.output, null, 2)}\n`);
  return { ...result.summary, ...(out ? { out } : {}) };
}

async function report(opts) {
  if (!opts.mission || !['update', 'daily'].includes(opts.kind)) {
    throw new Error('report needs --mission and --kind update|daily');
  }
  const { assertWritable, exportDaily, exportUpdate } = await import('./lib/export.mjs');
  const out = opts.out || join(SCRATCH, opts.kind === 'daily' ? 'DAILY.md' : 'OWNER-UPDATES.md');
  const live = Boolean(opts.live);
  // Before the server builds (and with --save keeps) a report the file would refuse.
  assertWritable(out, { kind: opts.kind, live });
  const client = serverClient();
  const built = await client.report({
    missionId: opts.mission,
    kind: opts.kind,
    from: opts.since,
    to: opts.to,
    save: Boolean(opts.save),
  });
  const written =
    opts.kind === 'update'
      ? exportUpdate(out, built.text, { title: opts.title || opts.mission, live })
      : exportDaily(out, built.text, { live });
  return { ...written, coversFrom: built.coversFrom, coversTo: built.coversTo, open: built.open.length };
}

const HOUR_MS = 3_600_000;

/** The window, and the report it follows, for `write`. */
async function writeWindow(opts, config, db) {
  const { previousReport } = await import('./lib/writer/mission.mjs');
  const { dayWindow, lastWholeDay } = await import('./lib/writer/time.mjs');
  const kind = opts.kind;
  let from = typeof opts.from === 'string' ? new Date(opts.from).toISOString() : null;
  let to = typeof opts.to === 'string' ? new Date(opts.to).toISOString() : null;
  let label;
  if (kind === 'daily') {
    if (!from || !to) {
      const day = typeof opts.day === 'string' ? dayWindow(opts.day, config.zone) : lastWholeDay(new Date().toISOString(), config.zone);
      ({ from, to } = day);
      label = day.day;
    }
  } else {
    to ??= new Date().toISOString();
  }
  let previous = null;
  if (typeof opts.previous === 'string') {
    previous = { coversFrom: null, coversTo: from ?? to, text: readFileSync(opts.previous, 'utf8'), open: [], facts: null };
  } else {
    // A rerun of a saved window follows the report before it, not itself.
    previous = previousReport(db, { missionId: config.id, kind, to: from ?? to, strict: !from });
  }
  if (!from) from = previous?.coversTo && previous.coversTo < to ? previous.coversTo : new Date(Date.parse(to) - 4 * HOUR_MS).toISOString();
  if (!(from < to)) throw new Error(`empty window ${from} to ${to}`);
  return { from, to, previous, label: label ?? to.replace(/[:.]/g, '-') };
}

async function writeCommand(opts) {
  if (!opts.mission || !['update', 'daily'].includes(opts.kind)) {
    throw new Error('write needs --mission and --kind update|daily');
  }
  const { loadConfig } = await import('./lib/writer/config.mjs');
  const { exec } = await import('./lib/writer/sh.mjs');
  const { writeReport } = await import('./lib/writer/writer.mjs');
  const { assertWritable, exportDaily, exportUpdate, isLiveReport, replaceFile, sameFile } = await import('./lib/export.mjs');
  const config = loadConfig(opts.mission, typeof opts.config === 'string' ? opts.config : undefined);
  const live = Boolean(opts.live);
  const db = openDb();
  try {
    const { from, to, previous, label } = await writeWindow(opts, config, db);
    const out = typeof opts.out === 'string' ? opts.out : join(SCRATCH, `write-${opts.mission}-${opts.kind}-${label}.md`);
    const target = typeof opts.export === 'string' ? opts.export : null;
    const packOut = typeof opts.pack === 'string' ? opts.pack : null;
    // `out` and `pack` get every version, a failing one too, so neither is ever a
    // published file: those take --export, which only gets a version that passed
    // its checks. All three are checked before anything is written (symlinks,
    // hard links and folders that don't exist yet included), and scratch files
    // are replaced rather than written through, so a link elsewhere keeps its text.
    const scratch = [['--out', out], ...(packOut ? [['--pack', packOut]] : [])];
    for (const [flag, path] of scratch) {
      if (isLiveReport(path)) throw new Error(`refusing to write the live report file ${path} with ${flag}; publish with --export ${path} --live`);
    }
    const named = [...scratch, ...(target ? [['--export', target]] : [])];
    for (let i = 0; i < named.length; i++) {
      for (let j = i + 1; j < named.length; j++) {
        if (sameFile(named[i][1], named[j][1])) throw new Error(`${named[i][0]} and ${named[j][0]} are the same file (${named[i][1]}); give each its own`);
      }
    }
    // Before any work the file would refuse.
    if (target) assertWritable(target, { kind: opts.kind, live });
    const client = opts.save ? serverClient() : null;
    log(`write ${opts.mission} ${opts.kind} ${from} to ${to}${previous ? ` after ${previous.coversTo}` : ''}`);
    const result = await writeReport({ config, kind: opts.kind, from, to, db, exec, previous, useModel: !opts['no-model'], log });
    replaceFile(out, result.text);
    if (packOut) replaceFile(packOut, `${JSON.stringify(result.facts, null, 2)}\n`);
    const summary = {
      mission: opts.mission,
      kind: opts.kind,
      from,
      to,
      status: result.status,
      chars: result.text.length,
      merged: result.facts.pack.counts.merged,
      failedSources: result.facts.pack.errors.map((error) => error.source),
      out,
    };
    if (!result.passed) {
      // Kept in `out` to look at; never published or stored.
      throw new Error(`the report fails its checks even in plain form, so it was not exported or saved (see ${out}): ${result.facts.writer.fallbackErrors.join(' | ').slice(0, 600)}`);
    }
    if (target) {
      summary.exported =
        opts.kind === 'update'
          ? exportUpdate(target, result.text, { title: opts.title || config.title, live })
          : exportDaily(target, result.text, { live });
    }
    if (client) {
      summary.saved = await client.putReport({ missionId: opts.mission, kind: opts.kind, from, to, text: result.text, open: result.open, facts: result.facts });
    }
    return summary;
  } finally {
    db.close();
  }
}

async function watch(opts) {
  if (!opts.mission) throw new Error('watch needs --mission');
  severityFloor(opts['min-severity']);
  const { watchMission } = await import('./lib/watch.mjs');
  const config = controlConfig();
  const client = serverClient(config);
  const stop = new AbortController();
  for (const sig of ['SIGTERM', 'SIGINT']) process.once(sig, () => stop.abort());
  await watchMission({
    connect: (after, signal) =>
      fetch(`${config.url}/api/ardud/control/events?types=thread.status`, {
        headers: {
          authorization: `Bearer ${config.token}`,
          accept: 'text/event-stream',
          ...(after === undefined ? {} : { 'last-event-id': after }),
        },
        signal,
      }),
    lanes: () => client.lanes(opts.mission),
    pass: async (reason) => {
      const { lanes } = await run(opts, client);
      const notes = lanes.reduce((sum, lane) => sum + (lane.notes ?? 0), 0);
      const failed = lanes.filter((lane) => lane.error !== undefined).length;
      log(`pass (${reason}): ${lanes.length} lane(s), ${notes} note(s)${failed ? `, ${failed} failed` : ''}`);
      return lanes.map((lane) => lane.threadId);
    },
    signal: stop.signal,
    log,
    sweepMs: Number(opts['sweep-minutes'] || 15) * 60_000,
  });
  return { stopped: true };
}

const write = (path, text) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

const COMMANDS = { 'dry-run': dryRun, run: (opts) => run(opts), editor, report, write: writeCommand, watch };

const { cmd, opts } = parseArgs(process.argv.slice(2));
const handler = COMMANDS[cmd];
if (!handler) {
  process.stdout.write(
    'usage: scribe run|dry-run|editor|report|write|watch (see the header of cli.mjs or README.md)\n',
  );
  process.exit(cmd === 'help' ? 0 : 2);
}
handler(opts)
  .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
  .catch((error) => {
    log(`scribe ${cmd}: ${error.message}`);
    process.exit(1);
  });
