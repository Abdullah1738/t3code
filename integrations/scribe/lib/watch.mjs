// Keeps scribe passes going for one mission: a pass when a lane's run settles, and a sweep
// every `sweepMs` for runs that go long or settles missed while the stream was down.
// Passes never overlap; requests that arrive during a pass fold into one more pass.

export const SETTLED = new Set(['completed', 'failed', 'cancelled', 'interrupted']);

/** Server-sent event frames from a fetch body: `{ id?, event?, data }`, comments skipped. */
export async function* parseSse(body, signal) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let frame = {};
  let data = [];
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let index;
      while ((index = buffer.search(/\r?\n/)) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + (buffer[index] === '\r' ? 2 : 1));
        if (line === '') {
          if (data.length > 0) {
            try {
              yield { ...frame, data: JSON.parse(data.join('\n')) };
            } catch {
              // A frame that is not JSON carries nothing scribe needs.
            }
          }
          frame = {};
          data = [];
          continue;
        }
        if (line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const field = colon < 0 ? line : line.slice(0, colon);
        const raw = colon < 0 ? '' : line.slice(colon + 1);
        const text = raw.startsWith(' ') ? raw.slice(1) : raw;
        if (field === 'data') data.push(text);
        else if (field === 'id') frame.id = text;
        else if (field === 'event') frame.event = text;
      }
      if (done) return;
    }
  } finally {
    reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Runs `pass` one at a time; requests during a pass become a single follow-up pass. */
export function serialPasses(pass, log) {
  let running = null;
  let pending = null;
  const loop = async (reason) => {
    let next = reason;
    while (next !== null) {
      pending = null;
      try {
        await pass(next);
      } catch (error) {
        log(`pass (${next}) failed: ${error.message}`);
      }
      next = pending;
    }
    running = null;
  };
  return {
    request(reason) {
      if (running !== null) {
        pending ??= reason;
        return running;
      }
      running = loop(reason);
      return running;
    },
    idle: () => running ?? Promise.resolve(),
  };
}

const wait = (ms, signal) =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true });
  });

/**
 * Follows the control event stream until `signal` aborts. `connect(after)` returns a fetch
 * response for `/api/ardud/control/events`; `after` is the last event id seen, so a reconnect
 * replays what it missed. `pass(reason)` runs one scribe pass and returns the lane threads it
 * covered. A settled run on a thread the last pass did not cover asks the server for lanes
 * again, at most once per `lanesTtlMs`, so a new lane is picked up on its first settle.
 */
export async function watchMission({
  connect,
  lanes,
  pass,
  signal,
  log = () => {},
  sweepMs = 15 * 60_000,
  retryMs = 1_000,
  maxRetryMs = 60_000,
  lanesTtlMs = 60_000,
  now = Date.now,
}) {
  let known = new Set();
  let knownAt = -Infinity;
  const passes = serialPasses(async (reason) => {
    const threads = await pass(reason);
    known = new Set(threads);
    knownAt = now();
  }, log);
  const isLane = async (threadId) => {
    if (known.has(threadId)) return true;
    if (now() - knownAt < lanesTtlMs) return false;
    known = new Set((await lanes()).map((lane) => lane.threadId));
    knownAt = now();
    return known.has(threadId);
  };

  passes.request('start');
  const sweep = setInterval(() => passes.request('sweep'), sweepMs);
  let after;
  let delay = retryMs;
  try {
    while (!signal?.aborted) {
      try {
        const response = await connect(after, signal);
        if (!response.ok) throw new Error(`event stream answered ${response.status}`);
        for await (const frame of parseSse(response.body, signal)) {
          if (frame.id !== undefined) after = frame.id;
          if (frame.event === 'ready') delay = retryMs;
          if (frame.event === 'error') throw new Error('event stream reported an error');
          const event = frame.data;
          if (event?.type !== 'thread.status' || !SETTLED.has(event.status)) continue;
          if (await isLane(event.threadId).catch(() => false)) passes.request(`settled ${event.threadId}`);
        }
        log('event stream closed; reconnecting');
      } catch (error) {
        if (signal?.aborted) break;
        log(`event stream: ${error.message}; retrying in ${Math.round(delay / 1000)}s`);
      }
      await wait(delay, signal);
      delay = Math.min(delay * 2, maxRetryMs);
    }
  } finally {
    clearInterval(sweep);
    await passes.idle();
  }
}
