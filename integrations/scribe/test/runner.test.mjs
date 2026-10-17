import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chunk, eventText, redact, resolveEvent, sliceText, toEvent, trim } from '../lib/transcript.mjs';
import { normalizeReply, parseJson } from '../lib/model.mjs';
import { runLane } from '../lib/run.mjs';
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
