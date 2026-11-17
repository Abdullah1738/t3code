import { afterEach, describe, expect, jest, mock, setSystemTime, test } from "bun:test";
import { chatKey, type Line, type LineInbound } from "../src/line.ts";
import { backfill, handleInbound, runIngress, type IngressDeps } from "../src/sb-ingress.ts";
import { Store } from "../src/store.ts";

const owner = "+15555550123";
const start = Date.parse("2026-11-04T20:00:00Z");
const stores: Store[] = [];
afterEach(() => {
  jest.useRealTimers();
  setSystemTime();
  for (const store of stores.splice(0)) store.close();
});

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function message(handle: string, sentAt = start): LineInbound {
  return { handle, sentAt, chat: chatKey.dm(owner), from: owner, text: "hello", kind: "message", service: "iMessage", participants: [] };
}

function setup() {
  const store = new Store(":memory:");
  stores.push(store);
  const opened = deferred();
  const closed = deferred();
  const controller = new AbortController();
  const line: Line = {
    number: "+15555550999",
    async *events(signal) {
      opened.resolve();
      try {
        if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
      } finally { closed.resolve(); }
    },
    backfill: async () => [], outbound: async () => [],
    sendText: async () => ({ handle: "out" }), sendApp: async () => ({ handle: "app" }),
    upload: async () => "https://cdn.example/file", getMessage: async () => undefined,
    react: async () => {}, typing: async () => {}, read: async () => {}, requestLocation: async () => {},
    setOptOut: async () => {},
    location: async () => undefined, download: async () => ({ data: new Uint8Array(), name: "file", mimeType: "text/plain" }),
  };
  const notify = mock(async (_text: string, _key: string) => true);
  const log = mock((_event: string, _code?: string) => {});
  const deps: IngressDeps = {
    line, owner, ownerStore: store, access: async () => ({ people: [], groups: [] }), now: () => Date.now(), notify, log,
    sink: {
      acceptInto: () => ({ accept: input => store.acceptInbound((input as { id: string }).id, input) }),
      setTyping: () => {}, note: async () => {},
    },
  };
  return { store, line, deps, notify, log, controller, opened, closed };
}

describe("Sendblue periodic ingress backfill", () => {
  test("a silent live stream recovers a missed message at 60 s, not at the next reconnect", async () => {
    jest.useFakeTimers();
    setSystemTime(start);
    const h = setup();
    let available: LineInbound[] = [];
    const listed = mock(async () => available);
    h.line.backfill = listed;
    const accepted = deferred();
    h.deps.sink.setTyping = () => accepted.resolve();
    const run = runIngress(h.deps, h.controller.signal);
    try {
      await h.opened.promise;
      expect(listed).toHaveBeenCalledTimes(1);
      available = [message("missed")];
      jest.advanceTimersByTime(59_999);
      expect(h.store.pendingInbound()).toHaveLength(0);
      expect(listed).toHaveBeenCalledTimes(1);
      jest.advanceTimersByTime(1);
      expect(listed).toHaveBeenCalledTimes(2);
      await accepted.promise;
      expect(h.store.pendingInbound().map(row => row.id)).toEqual(["missed"]);
      expect(listed).toHaveBeenCalledTimes(2);
      expect(h.notify).not.toHaveBeenCalled();
    } finally {
      h.controller.abort();
      await run;
    }
    await h.closed.promise;
    expect(h.log).toHaveBeenCalledWith("ingress-backfill-periodic", "1");
    expect(jest.getTimerCount()).toBe(0);
    jest.advanceTimersByTime(180_000);
    expect(listed).toHaveBeenCalledTimes(2);
  });

  test.each([119_999, 120_000, 120_001])("backfill alarms only for a newly accepted message older than 2 min (age=%s)", async age => {
    const h = setup();
    h.line.backfill = async () => [message("gap", start - age)];
    await backfill(h.deps, () => start);
    await backfill(h.deps, () => start + 60_000);
    expect(h.store.pendingInbound()).toHaveLength(1);
    expect(h.notify).toHaveBeenCalledTimes(age > 120_000 ? 1 : 0);
    if (age > 120_000) {
      expect(h.notify).toHaveBeenCalledWith(
        "iMessage backfill recovered a message more than 2 minutes after it was sent.", "imessage-ingress-gap",
      );
      expect(h.log).toHaveBeenCalledWith("ingress-backfill-gap", "120s");
    }
  });

  test("the periodic backfill logs and alerts once for an old missed message, despite overlapping results", async () => {
    jest.useFakeTimers();
    setSystemTime(start);
    const h = setup();
    const alerted = deferred();
    h.notify.mockImplementation(async () => { alerted.resolve(); return true; });
    let calls = 0;
    h.line.backfill = async () => ++calls === 1 ? [] : [message("old-missed", start - 120_000)];
    const run = runIngress(h.deps, h.controller.signal);
    try {
      await h.opened.promise;
      jest.advanceTimersByTime(60_000);
      await alerted.promise;
      // An id-only event or another backfill may return the same handle while the periodic pass is still finishing.
      await backfill(h.deps, () => start + 60_000);
      expect(h.store.pendingInbound().map(row => row.id)).toEqual(["old-missed"]);
      expect(h.notify).toHaveBeenCalledTimes(1);
      expect(h.log).toHaveBeenCalledWith("ingress-backfill-gap", "180s");
    } finally { h.controller.abort(); await run; }
    expect(jest.getTimerCount()).toBe(0);
  });

  test("a failed periodic pass is logged without closing the live stream or stopping later backfills", async () => {
    jest.useFakeTimers();
    setSystemTime(start);
    const h = setup();
    const failure = deferred();
    h.log.mockImplementation(event => { if (event === "ingress-backfill-failed") failure.resolve(); });
    let calls = 0;
    h.line.backfill = async () => {
      calls++;
      if (calls === 2) throw new Error("offline");
      return calls === 1 ? [] : [message("after-retry")];
    };
    const accepted = deferred();
    h.deps.sink.setTyping = () => accepted.resolve();
    const run = runIngress(h.deps, h.controller.signal);
    try {
      await h.opened.promise;
      jest.advanceTimersByTime(60_000);
      await failure.promise;
      // Let the pass's finally release the in-flight guard before advancing the fake clock.
      await Promise.resolve();
      jest.advanceTimersByTime(60_000);
      await accepted.promise;
      expect(calls).toBe(3);
      expect(h.store.pendingInbound().map(row => row.id)).toEqual(["after-retry"]);
    } finally { h.controller.abort(); await run; }
  });

  test("abort clears the timer and drops a periodic fetch that finishes after shutdown", async () => {
    jest.useFakeTimers();
    setSystemTime(start);
    const h = setup();
    const fetching = deferred();
    const fetched = deferred<LineInbound[]>();
    let calls = 0;
    h.line.backfill = async () => {
      if (++calls === 1) return [];
      fetching.resolve();
      return fetched.promise;
    };
    const run = runIngress(h.deps, h.controller.signal);
    await h.opened.promise;
    jest.advanceTimersByTime(60_000);
    await fetching.promise;
    jest.advanceTimersByTime(120_000);
    expect(calls).toBe(2);
    h.controller.abort();
    expect(jest.getTimerCount()).toBe(0);
    fetched.resolve([message("too-late", start - 180_000)]);
    await run;
    expect(h.store.pendingInbound()).toHaveLength(0);
    expect(h.notify).not.toHaveBeenCalled();
  });

  test.each(["periodic", "id-only"])("%s backfill shares its fetch with other triggers and live delivery", async first => {
    jest.useFakeTimers();
    setSystemTime(start);
    const h = setup();
    const requestId = deferred();
    const idRead = deferred();
    const fetching = deferred();
    const fetched = deferred<LineInbound[]>();
    const continued = deferred();
    const delivered = deferred();
    const silent = h.line.events;
    const incoming = message("overlap", start - 180_000);
    let calls = 0;
    let active = 0;
    let maxActive = 0;
    h.line.backfill = async () => {
      calls++;
      active++;
      maxActive = Math.max(maxActive, active);
      try {
        if (calls === 1) return [];
        fetching.resolve();
        return await fetched.promise;
      } finally { active--; }
    };
    h.line.events = async function* (signal) {
      h.opened.resolve();
      await requestId.promise;
      yield { type: "message", id: "id-only", message: {
        ...incoming,
        get from() { idRead.resolve(); return ""; },
      } };
      continued.resolve();
      yield { type: "message", id: "live-duplicate", message: incoming };
      delivered.resolve();
      yield* silent(signal);
    };
    const run = runIngress(h.deps, h.controller.signal);
    try {
      await h.opened.promise;
      if (first === "periodic") {
        jest.advanceTimersByTime(60_000);
        await fetching.promise;
        requestId.resolve();
        await idRead.promise;
      } else {
        requestId.resolve();
        await fetching.promise;
      }
      jest.advanceTimersByTime(120_000);
      expect(calls).toBe(2);
      expect(maxActive).toBe(1);
      fetched.resolve([incoming]);
      await continued.promise;
      await delivered.promise;
      expect(h.store.pendingInbound().map(row => row.id)).toEqual(["overlap"]);
      expect(h.notify).toHaveBeenCalledTimes(1);
      expect(calls).toBe(2);
      expect(maxActive).toBe(1);
    } finally {
      fetched.resolve([]);
      requestId.resolve();
      h.controller.abort();
      await run;
    }
    expect(jest.getTimerCount()).toBe(0);
  });

  test("a live stream drop removes its timer during backoff and the next stream gets one timer", async () => {
    jest.useFakeTimers();
    setSystemTime(start);
    const h = setup();
    const drop = deferred();
    const failed = deferred();
    const reopened = deferred();
    let streams = 0;
    const silent = h.line.events;
    h.line.events = async function* (signal) {
      if (++streams === 1) {
        h.opened.resolve();
        await drop.promise;
        throw new Error("stream dropped");
      }
      reopened.resolve();
      yield* silent(signal);
    };
    h.log.mockImplementation(event => { if (event === "ingress-unavailable") failed.resolve(); });
    const listed = mock(async () => []);
    h.line.backfill = listed;
    const run = runIngress(h.deps, h.controller.signal);
    try {
      await h.opened.promise;
      expect(jest.getTimerCount()).toBe(1);
      drop.resolve();
      await failed.promise;
      expect(jest.getTimerCount()).toBe(1); // retry timeout, not the old interval
      jest.advanceTimersByTime(1_999);
      expect(listed).toHaveBeenCalledTimes(1);
      jest.advanceTimersByTime(1);
      await reopened.promise;
      expect(listed).toHaveBeenCalledTimes(2);
      expect(jest.getTimerCount()).toBe(1);
      jest.advanceTimersByTime(59_999);
      expect(listed).toHaveBeenCalledTimes(2);
      jest.advanceTimersByTime(1);
      expect(listed).toHaveBeenCalledTimes(3);
    } finally { h.controller.abort(); await run; }
    expect(jest.getTimerCount()).toBe(0);
  });

  test("abort during a failed startup's backoff exits immediately without another fetch", async () => {
    jest.useFakeTimers();
    const h = setup();
    const failed = deferred();
    h.log.mockImplementation(event => { if (event === "ingress-unavailable") failed.resolve(); });
    const listed = mock(async (): Promise<LineInbound[]> => { throw new Error("offline"); });
    h.line.backfill = listed;
    const run = runIngress(h.deps, h.controller.signal);
    await failed.promise;
    h.controller.abort();
    await run;
    expect(jest.getTimerCount()).toBe(0);
    jest.advanceTimersByTime(60_000);
    expect(listed).toHaveBeenCalledTimes(1);
  });

  test("an alert failure is logged but does not lose the message or the rest of the backfill", async () => {
    const h = setup();
    h.notify.mockImplementation(async () => { throw new Error("Telegram unavailable"); });
    h.line.backfill = async () => [message("old", start - 180_000), message("next")];
    await backfill(h.deps, () => start);
    expect(h.store.pendingInbound().map(row => row.id)).toEqual(["old", "next"]);
    expect(h.log).toHaveBeenCalledWith("ingress-gap-notify-failed");
  });

  test("old messages from our own line or blocked senders never raise a gap alarm", async () => {
    const h = setup();
    h.line.backfill = async () => [
      { ...message("own", start - 180_000), from: h.line.number },
      { ...message("blocked", start - 180_000), from: "+15555550888", chat: chatKey.dm("+15555550888") },
    ];
    await backfill(h.deps, () => start);
    expect(h.store.pendingInbound()).toHaveLength(0);
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.log).not.toHaveBeenCalled();
  });

  test.each([
    { path: "allowed live delivery", guest: false, live: true, seen: false, alerts: 0 },
    { path: "allowed backfill recovery", guest: false, live: false, seen: false, alerts: 1 },
    { path: "guest live delivery still queued", guest: true, live: true, seen: false, alerts: 0 },
    { path: "guest delivered before ingress marker existed", guest: true, live: false, seen: true, alerts: 0 },
    { path: "guest backfill recovery", guest: true, live: false, seen: false, alerts: 1 },
  ])("gap detection across ingress forms: $path", async row => {
    const h = setup();
    const incoming = row.guest
      ? { ...message("matrix"), from: "+15555550888", chat: chatKey.dm("+15555550888") }
      : message("matrix");
    // The active-grant guest hook returns true for already queued messages, unlike Store.acceptInbound.
    if (row.guest) h.deps.sink.guest = async () => true;
    if (row.seen) h.store.set(`guest-seen:${incoming.handle}`, true);
    if (row.live) expect(await handleInbound(h.deps, incoming)).toBe(true);
    h.line.backfill = async () => [incoming];
    await Promise.all([backfill(h.deps, () => start + 180_000), backfill(h.deps, () => start + 180_000)]);
    await backfill(h.deps, () => start + 240_000);
    expect(h.notify).toHaveBeenCalledTimes(row.alerts);
    expect(h.log.mock.calls.filter(([event]) => event === "ingress-backfill-gap")).toHaveLength(row.alerts);
  });
});
