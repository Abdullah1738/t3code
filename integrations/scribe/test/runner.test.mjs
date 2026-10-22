import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { chunk, eventText, redact, resolveEvent, sliceText, toEvent, trim } from '../lib/transcript.mjs';
import { normalizeReply, parseJson } from '../lib/model.mjs';
import { runLane, severityFloor } from '../lib/run.mjs';
import { localSink } from '../lib/local.mjs';

const row = (ordinal, type, payload) => ({ ordinal, type, payload_json: JSON.stringify(payload) });

test('trim keeps exact head and tail substrings', () => {
  const text = 'a'.repeat(50) + 'MIDDLE' + 'b'.repeat(50);
  const cut = trim(text, 10, 10);
  assert.ok(cut.startsWith('a'.repeat(10)));
  assert.ok(cut.endsWith('b'.repeat(10)));
  assert.match(cut, /chars cut/);
  assert.equal(trim('short', 10, 10), 'short');
});

test('redact hides credentials', () => {
  assert.equal(redact('token: abcdef123456'), '[redacted]');
  assert.match(redact('key sk-abcdefghijklmnopqrstuvwxyz123456 here'), /\[redacted\]/);
});

test('rendered text stays a subset of the raw text the server checks', () => {
  const event = toEvent(
    row(5, 'command_execution', {
      input: 'gh pr view 216',
      output: `${'x'.repeat(3000)}\n{"state":"MERGED"}`,
      exitCode: 0,
      completedAt: '2026-10-17T08:41:00.000Z',
    }),
  );
  assert.equal(event.event, 5);
  assert.match(event.rendered, /^command exit 0 08:41Z/);
  assert.ok(event.raw.includes('{"state":"MERGED"}'));
  assert.ok(event.rendered.includes('{"state":"MERGED"}'));
  assert.equal(eventText('checkpoint', { files: [] }), '');
});

test('slices number events e1..eN and map them back', () => {
  const events = [
    toEvent(row(73000001, 'user_message', { text: 'Master here, go.', createdBy: 'user', creationSource: 'server' })),
    toEvent(row(73000002, 'checkpoint', { files: [] })),
    toEvent(row(73000003, 'assistant_message', { text: 'Done with step one.' })),
  ];
  const { text, ordinals } = sliceText(events);
  assert.deepEqual(ordinals, [73000001, 73000003]);
  assert.match(text, /^\[e1\] message \(master\/coord\)/);
  assert.match(text, /\[e2\] lane/);
  assert.equal(resolveEvent(2, ordinals), 73000003);
  assert.equal(resolveEvent('e1', ordinals), 73000001);
  assert.equal(resolveEvent(73000003, ordinals), 73000003);
  assert.equal(resolveEvent(3, ordinals), null);
  assert.equal(chunk(events, { maxChars: 10 }).length, 3);
});

test('parseJson reads fenced replies and salvages truncated ones', () => {
  assert.deepEqual(parseJson('```json\n{"notes":[],"candidates":[]}\n```'), { notes: [], candidates: [] });
  const cut = parseJson('{"notes":[{"type":"risk","quote":"a"},{"type":"blo');
  assert.equal(cut.truncated, true);
  assert.equal(cut.notes.length, 1);
  assert.throws(() => parseJson('no json here'));
});

test('normalizeReply drops bad shapes and events outside the slice', () => {
  const { notes, dropped } = normalizeReply(
    {
      notes: [
        { type: 'risk', summary: 's', quote: 'q', event: 2, severity: 'loud', confidence: 3 },
        { type: 'gossip', summary: 's', quote: 'q', event: 1 },
        { type: 'risk', summary: 's', quote: 'q', event: 9 },
      ],
    },
    { ordinals: [10, 11] },
  );
  assert.equal(notes.length, 1);
  assert.equal(notes[0].event, 11);
  assert.equal(notes[0].severity, 'medium');
  assert.equal(notes[0].confidence, 1);
  assert.equal(dropped.length, 2);
});

test('cursor makes a rerun post nothing new', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'scribe-test-'));
  try {
    const all = [
      toEvent(row(1, 'user_message', { text: 'Master here: merge rewards#216 today.' })),
      toEvent(row(2, 'assistant_message', { text: 'Assuming the ledger is empty on dev, skipping backfill.' })),
      toEvent(row(3, 'checkpoint', { files: [] })),
    ];
    const readEvents = async (after) => {
      const events = all.filter((event) => event.event > after);
      return { events, complete: true, lastSeen: events.at(-1)?.event ?? after };
    };
    let calls = 0;
    const ask = async () => {
      calls += 1;
      return {
        content: JSON.stringify({
          notes: [{ type: 'assumption', summary: 'Ledger assumed empty.', quote: 'Assuming the ledger is empty on dev', event: 2 }],
        }),
        usage: { input: 100, output: 20 },
      };
    };
    const lane = { name: 'lane-a', threadId: 't-1', missionId: 'm-1' };
    const sink = localSink(dir, { threadId: 't-1', missionId: 'm-1' });
    const first = await runLane({ lane, readEvents, ask, sink });
    assert.equal(first.slices, 1);
    assert.equal(first.notes, 1);
    assert.equal(first.cursor, 3);

    const again = await runLane({ lane, readEvents, ask, sink: localSink(dir, { threadId: 't-1', missionId: 'm-1' }) });
    assert.equal(again.slices, 0);
    assert.equal(again.notes, 0);
    assert.equal(calls, 1);

    // A retried post of the same batch (crash after the server stored it) is a duplicate.
    const batch = JSON.parse(readFileSync(join(dir, 'batches.jsonl'), 'utf8').trim());
    const retry = await sink.postBatch(batch);
    assert.equal(retry.duplicate, true);
    assert.equal(retry.accepted, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('only checkpoints since the cursor move it without a model call', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'scribe-test-'));
  try {
    const readEvents = async (after) => {
      const events = after < 7 ? [toEvent(row(7, 'checkpoint', { files: [] }))] : [];
      return { events, complete: true, lastSeen: events.at(-1)?.event ?? after };
    };
    const ask = async () => assert.fail('no model call expected');
    const sink = localSink(dir, { threadId: 't-1', missionId: 'm-1' });
    sink.setCursor(6);
    const summary = await runLane({ lane: { name: 'a', threadId: 't-1', missionId: 'm-1' }, readEvents, ask, sink });
    assert.equal(summary.cursor, 7);
    assert.equal(summary.slices, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a severity floor keeps high notes and updates to open notes, and tells the model', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'scribe-test-'));
  try {
    const all = [
      toEvent(row(1, 'assistant_message', { text: 'Deploy failed: the bridge socket is gone after restart.' })),
      toEvent(row(2, 'assistant_message', { text: 'Renamed a helper in the README, nothing else changed.' })),
      toEvent(row(3, 'assistant_message', { text: 'Socket is back, the earlier deploy blocker is cleared.' })),
    ];
    const readEvents = async (after) => {
      const events = all.filter((event) => event.event > after);
      return { events, complete: true, lastSeen: events.at(-1)?.event ?? after };
    };
    const prompts = [];
    const ask = async ({ user }) => {
      prompts.push(user);
      return {
        content: JSON.stringify({
          notes: [
            { type: 'blocker', summary: 'Deploy blocked on the bridge socket.', quote: 'Deploy failed: the bridge socket is gone', event: 1, severity: 'high' },
            { type: 'decision', summary: 'README helper renamed.', quote: 'Renamed a helper in the README', event: 2, severity: 'low' },
            { type: 'blocker', summary: 'Socket back, deploy unblocked.', quote: 'Socket is back, the earlier deploy blocker is cleared.', event: 3, severity: 'low', replaces: 'note-open-1' },
            { type: 'risk', summary: 'Replaces a note that is not open.', quote: 'Socket is back', event: 3, severity: 'medium', replaces: 'note-elsewhere' },
          ],
        }),
        usage: { input: 10, output: 5 },
      };
    };
    const sink = localSink(dir, { threadId: 't-1', missionId: 'm-1' });
    const openNotes = sink.openNotes;
    sink.openNotes = async () => [{ id: 'note-open-1', type: 'blocker', severity: 'high', summary: 'Deploy blocked.' }, ...(await openNotes())];
    const summary = await runLane({ lane: { name: 'a', threadId: 't-1', missionId: 'm-1' }, readEvents, ask, sink, minSeverity: 'high' });
    assert.equal(summary.notes, 2);
    assert.equal(summary.belowFloor, 2);
    assert.equal(summary.cursor, 3);
    const [batch] = readFileSync(join(dir, 'batches.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(batch.notes.map((note) => note.summary), ['Deploy blocked on the bridge socket.', 'Socket back, deploy unblocked.']);
    assert.match(prompts[0], /Only notes of severity high or above are kept/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('no floor keeps every note, and an unknown floor is refused', async () => {
  assert.equal(severityFloor(undefined), 0);
  assert.equal(severityFloor('critical'), 3);
  assert.throws(() => severityFloor('loud'), /unknown severity loud/);
  assert.throws(() => severityFloor(true), /unknown severity/);
  const readEvents = async (after) => {
    const events = after < 1 ? [toEvent(row(1, 'assistant_message', { text: 'Picked option B for the cache layout.' }))] : [];
    return { events, complete: true, lastSeen: events.at(-1)?.event ?? after };
  };
  let prompt = '';
  const ask = async ({ user }) => {
    prompt = user;
    return {
      content: JSON.stringify({ notes: [{ type: 'decision', summary: 'Option B.', quote: 'Picked option B', event: 1, severity: 'low' }] }),
      usage: { input: 1, output: 1 },
    };
  };
  const dir = mkdtempSync(join(tmpdir(), 'scribe-test-'));
  try {
    const summary = await runLane({ lane: { name: 'a', threadId: 't-1', missionId: 'm-1' }, readEvents, ask, sink: localSink(dir, { threadId: 't-1', missionId: 'm-1' }) });
    assert.equal(summary.notes, 1);
    assert.equal(summary.belowFloor, 0);
    assert.doesNotMatch(prompt, /Only notes of severity/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a floor that drops every note still moves the cursor past the slice', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'scribe-test-'));
  try {
    const all = [
      toEvent(row(1, 'assistant_message', { text: 'Tidied a comment in the README.' })),
      toEvent(row(2, 'checkpoint', { files: [] })),
    ];
    const readEvents = async (after) => {
      const events = all.filter((event) => event.event > after);
      return { events, complete: true, lastSeen: events.at(-1)?.event ?? after };
    };
    let calls = 0;
    const ask = async () => {
      calls += 1;
      return {
        content: JSON.stringify({ notes: [{ type: 'decision', summary: 'README tidied.', quote: 'Tidied a comment', event: 1, severity: 'low' }] }),
        usage: { input: 1, output: 1 },
      };
    };
    const lane = { name: 'a', threadId: 't-1', missionId: 'm-1' };
    const first = await runLane({ lane, readEvents, ask, sink: localSink(dir, lane), minSeverity: 'high' });
    assert.equal(first.notes, 0);
    assert.equal(first.belowFloor, 1);
    assert.equal(first.cursor, 2);
    const again = await runLane({ lane, readEvents, ask, sink: localSink(dir, lane), minSeverity: 'high' });
    assert.equal(again.slices, 0);
    assert.equal(calls, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the scribe reads its own credential and ignores the retired shared file', () => {
  const home = mkdtempSync(join(tmpdir(), 'scribe-home-'));
  try {
    mkdirSync(join(home, '.robob'));
    writeFileSync(join(home, '.robob', 'ardud-control.json'), JSON.stringify({ url: 'http://127.0.0.1:9', token: 'shared' }));
    const env = { ...process.env, HOME: home };
    delete env.SCRIBE_CONTROL_FILE;
    delete env.T3_CONTROL_TOKEN;
    delete env.T3_CONTROL_URL;
    const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli.mjs');
    const result = spawnSync(process.execPath, [cli, 'run', '--mission', 'm-1'], { env, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no control token \(set T3_CONTROL_TOKEN or write .*components\/scribe\.json\)/);
    mkdirSync(join(home, '.robob', 'components'));
    writeFileSync(join(home, '.robob', 'components', 'scribe.json'), JSON.stringify({ url: 'http://127.0.0.1:9', token: 'own' }));
    const server = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'server.mjs')).href;
    const read = spawnSync(process.execPath, ['--input-type=module', '-e', `const { controlConfig } = await import(${JSON.stringify(server)}); console.log(JSON.stringify(controlConfig()));`], { env, encoding: 'utf8' });
    assert.equal(read.status, 0, read.stderr);
    assert.deepEqual(JSON.parse(read.stdout), { url: 'http://127.0.0.1:9', token: 'own' });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('run refuses a bad floor before it looks for a credential', () => {
  const home = mkdtempSync(join(tmpdir(), 'scribe-home-'));
  try {
    const env = { ...process.env, HOME: home, SCRIBE_CONTROL_FILE: join(home, 'missing.json') };
    delete env.T3_CONTROL_TOKEN;
    const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli.mjs');
    const result = spawnSync(process.execPath, [cli, 'run', '--mission', 'm-1', '--min-severity', 'loud'], { env, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unknown severity loud/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
