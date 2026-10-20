import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseSse, serialPasses, watchMission } from '../lib/watch.mjs';

const encoder = new TextEncoder();
const streamOf = (chunks) =>
  new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
const frame = (id, data, event) =>
  `${event ? `event: ${event}\n` : ''}id: ${id}\ndata: ${JSON.stringify(data)}\n\n`;
const status = (threadId, value) => ({ type: 'thread.status', threadId, runId: 'run-1', status: value });

test('parseSse reads frames split across chunks, skips comments and keeps ids', async () => {
  const text = `retry: 3000\nid: 4\nevent: ready\ndata: {"type":"ready"}\n\n: ping\n\r\nid: 5\r\ndata: {"type":"thread.status",\r\ndata: "status":"completed"}\r\n\r\n`;
  const frames = [];
  for await (const item of parseSse(streamOf([text.slice(0, 17), text.slice(17, 60), text.slice(60)]))) {
    frames.push(item);
  }
  assert.deepEqual(frames, [
    { id: '4', event: 'ready', data: { type: 'ready' } },
    { id: '5', data: { type: 'thread.status', status: 'completed' } },
  ]);
});

test('passes never overlap, and requests during a pass fold into one more pass', async () => {
  const ran = [];
  let release;
  const first = new Promise((resolve) => (release = resolve));
  const passes = serialPasses(async (reason) => {
    ran.push(reason);
    if (reason === 'start') await first;
  }, () => {});
  passes.request('start');
  passes.request('settled a');
  passes.request('settled b');
  assert.deepEqual(ran, ['start']);
  release();
  await passes.idle();
  assert.deepEqual(ran, ['start', 'settled a']);
});

test('a settled lane run starts a pass; running, foreign and replayed-after streams do not lose it', async () => {
  const stop = new AbortController();
  const passes = [];
  const connects = [];
  let laneReads = 0;
  await watchMission({
    connect: async (after) => {
      connects.push(after);
      if (connects.length === 1) {
        return new Response(
          streamOf([
            frame(6, { type: 'ready', sequence: 6 }, 'ready'),
            frame(7, status('thread-lane', 'running')),
            frame(8, status('thread-other', 'completed')),
            frame(9, status('thread-lane', 'completed')),
          ]),
        );
      }
      stop.abort();
      return new Response(streamOf([]));
    },
    lanes: async () => {
      laneReads += 1;
      return [{ threadId: 'thread-lane' }];
    },
    pass: async (reason) => {
      passes.push(reason);
      return ['thread-lane'];
    },
    signal: stop.signal,
    retryMs: 1,
  });
  assert.deepEqual(passes, ['start', 'settled thread-lane']);
  // The reconnect resumes after the last event it saw, so a settle in the gap is replayed.
  assert.deepEqual(connects, [undefined, '9']);
  assert.ok(laneReads <= 1, `asked the server for lanes ${laneReads} times`);
});

test('the sweep runs passes while the stream is quiet, and a refused stream is retried', async () => {
  const stop = new AbortController();
  const passes = [];
  let connects = 0;
  await watchMission({
    connect: async (_after, signal) => {
      connects += 1;
      if (connects < 3) return new Response('nope', { status: 503 });
      // A stream that stays open until the watch stops, as fetch's body does.
      return new Response(
        new ReadableStream({
          start: (controller) =>
            signal.addEventListener('abort', () => controller.error(new Error('aborted')), { once: true }),
        }),
      );
    },
    lanes: async () => [],
    pass: async (reason) => {
      passes.push(reason);
      if (passes.filter((item) => item === 'sweep').length === 2) stop.abort();
      return [];
    },
    signal: stop.signal,
    sweepMs: 5,
    retryMs: 1,
  });
  assert.equal(passes[0], 'start');
  assert.ok(passes.filter((item) => item === 'sweep').length >= 2);
  assert.ok(connects >= 3, `connected ${connects} times`);
});
