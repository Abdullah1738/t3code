#!/usr/bin/env node
// scribe: reads mission lane transcripts and writes cited notes.
//
//   scribe run [--mission ID] [--slices N]          one pass over every lane the server lists
//   scribe dry-run --thread ID [--name N] [--since ISO | --from EVENT] [--slices N] [--out DIR]
//                                                   one lane, real model, notes to files only
//   scribe editor --mission ID [--out FILE]         one Opus editor pass (bottom line, FYI, feed, suggestions)
//   scribe report --mission ID --kind update|daily [--since ISO] [--to ISO] [--save] [--out FILE]
//                                                   build a report from mission data; export it (scratch by default)
//
// Never runs on a timer by itself; a mission schedule or a person starts it.
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { chat, EDITOR_MODEL, SCRIBE_MODEL } from './lib/model.mjs';
import { eventsAfter, firstEventSince, openDb, threadInfo } from './lib/source.mjs';
import { runLane } from './lib/run.mjs';
import { localSink } from './lib/local.mjs';
import { serverClient, serverSink } from './lib/server.mjs';

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
    log,
  });
  db.close();
  return { ...summary, out };
}

async function run(opts) {
  const client = serverClient();
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
  const client = serverClient();
  const result = await runEditor({
    input: await client.editorInput(opts.mission),
    ask: ask(EDITOR_MODEL),
    post: opts.out ? null : (output) => client.postEditor(output),
  });
  if (opts.out) write(opts.out, `${JSON.stringify(result.output, null, 2)}\n`);
  return result.summary;
}

async function report(opts) {
  if (!opts.mission || !['update', 'daily'].includes(opts.kind)) {
    throw new Error('report needs --mission and --kind update|daily');
  }
  const { exportUpdate } = await import('./lib/export.mjs');
  const client = serverClient();
  const built = await client.report({
    missionId: opts.mission,
    kind: opts.kind,
    from: opts.since,
    to: opts.to,
    save: Boolean(opts.save),
  });
  const out = opts.out || join(SCRATCH, opts.kind === 'daily' ? 'DAILY.md' : 'OWNER-UPDATES.md');
  const written =
    opts.kind === 'update'
      ? exportUpdate(out, built.text, { title: opts.title || opts.mission })
      : (write(out, built.text), { path: out, inserted: true });
  return { ...written, coversFrom: built.coversFrom, coversTo: built.coversTo, open: built.open.length };
}

const write = (path, text) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

const COMMANDS = { 'dry-run': dryRun, run, editor, report };

const { cmd, opts } = parseArgs(process.argv.slice(2));
const handler = COMMANDS[cmd];
if (!handler) {
  process.stdout.write(
    'usage: scribe run|dry-run|editor|report (see the header of cli.mjs or README.md)\n',
  );
  process.exit(cmd === 'help' ? 0 : 2);
}
handler(opts)
  .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
  .catch((error) => {
    log(`scribe ${cmd}: ${error.message}`);
    process.exit(1);
  });
