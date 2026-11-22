import { afterEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi } from "../src/api.ts";
import { Delivery } from "../src/delivery.ts";
import { classifyAsk, flushDigest, formatDigest, latestDigestSlot, type AskDetail, type AskLookup, type DigestItem } from "../src/digest.ts";
import { enqueueNotice } from "../src/notification-policy.ts";
import { redact } from "../src/redact.ts";
import { Store } from "../src/store.ts";
import { useToolLogFixture } from "./toollog-fixture.ts";

const logs = useToolLogFixture();
const slot = Date.parse("2026-11-22T05:00:00Z");
const ask: AskDetail = { cardId: "card-fixture", text: "Choose the release day", blocking: false, closedAt: null };
const notice = (id = "first", key = "watchers:128:q1") => ({ id, askKey: key, source: "Watchers board", text: "#128 q1 Choose the release day", severity: "attention" });
const stores: Store[] = [];
const dirs: string[] = [];
function setup(lookup: AskLookup = async () => ask) {
  const store = new Store(":memory:"); stores.push(store);
  const api = createApi({ store, enabled: () => true, chatId: () => 1, timezone: "Asia/Dubai", health: () => ({}), getAsk: lookup });
  const post = (body: Record<string, unknown> = {}) => api(new Request("http://bridge/notify", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: "Watchers board", text: "#128 q1 Choose the release day", severity: "attention", dedupeKey: "first", askKey: "watchers:128:q1", ...body }),
  }));
  return { store, post };
}
async function queue(store: Store, id = "first", key = "watchers:128:q1", detail = ask, at = slot - 1) {
  return enqueueNotice(store, notice(id, key), at, await classifyAsk(key, async () => detail));
}
afterEach(() => { setSystemTime(); for (const store of stores.splice(0)) store.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test.each([
  [true, "decision", 1], [false, "decision", 0], [true, "notice", 0], [false, "notice", 0],
])("admission blocking=%s kind=%s gives %s immediate sends", async (blocking, kind, sent) => {
  const h = setup(async () => ({ ...ask, blocking, kind }));
  expect((await h.post()).status).toBe(202);
  expect(h.store.pendingOutbox()).toHaveLength(sent);
  if (!sent) {
    expect(h.store.get("digest-item:watchers:128:q1")).toMatchObject({ cardId: ask.cardId, kind });
    expect(h.store.db.query("SELECT key FROM kv WHERE key LIKE 'ask-timing-key:%'").all()).toHaveLength(0);
    expect(logs.entries().find(e => e.name === "tg.digest")).toMatchObject({ props: { action: "queued", board: "watchers", kind } });
  }
});

test.each(["Robob board #582", "Robob board -582", "Robob board 582", "Robob board"])('legacy admission resolves %s before queuing', async source => {
  const keys: string[] = [];
  const h = setup(async key => { keys.push(key); return ask; });
  expect((await h.post({ source, text: "#582 q2 needs a decision", askKey: undefined })).status).toBe(202);
  expect(keys).toEqual(["robob:582:q2"]);
  expect(h.store.pendingOutbox()).toHaveLength(0);
});

test.each(["network", "http500", "shape", "timeout"])('lookup %s fails open', async failure => {
  const h = setup(async () => {
    if (failure === "shape") return { ...ask, blocking: undefined } as unknown as AskDetail;
    if (failure === "timeout") throw new DOMException("private", "TimeoutError");
    throw new Error(failure);
  });
  expect((await h.post()).status).toBe(202);
  expect(h.store.pendingOutbox()).toHaveLength(1);
  expect(logs.entries().some(e => e.name === "tg.digest" && e.props?.action === "classifyFailed")).toBe(true);
});

test("lookup deadline aborts even an unresponsive injected lookup", async () => {
  const controller = new AbortController();
  controller.abort(new DOMException("deadline", "TimeoutError"));
  const timeout = spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
  try {
    expect(await classifyAsk("watchers:128:q1", async () => new Promise(() => {}))).toBeUndefined();
    expect(logs.entries().at(-1)).toMatchObject({ props: { action: "classifyFailed" }, error: { tag: "tg.digest.timeout" } });
  } finally { timeout.mockRestore(); }
});

test("404 and answered asks drop with replay receipts; changed classification does not conflict on retry", async () => {
  let detail: AskDetail | undefined;
  let lookups = 0;
  const h = setup(async () => { lookups++; return detail; });
  expect((await h.post()).status).toBe(200);
  detail = ask;
  expect((await h.post()).status).toBe(200);
  expect(lookups).toBe(1);
  expect(h.store.pendingOutbox()).toHaveLength(0);
  detail = { ...ask, answer: { verdict: "picked" } };
  expect((await h.post({ dedupeKey: "answered" })).status).toBe(200);
  expect(logs.entries().filter(e => e.name === "tg.digest" && e.props?.action === "dropClosed")).toHaveLength(2);
});

test("non-ask notices never look up and keep immediate delivery", async () => {
  const h = setup(async () => { throw new Error("must not look up"); });
  expect((await h.post({ source: "offbox", askKey: undefined, text: "watcher failed" })).status).toBe(202);
  expect(h.store.pendingOutbox()[0]?.text).toBe("[offbox] watcher failed");
  expect(logs.entries().filter(e => e.name === "tg.digest")).toHaveLength(0);
});

test("one line per ask; slots and restart cannot enqueue the digest twice", async () => {
  const dir = mkdtempSync(join(tmpdir(), "telegram-digest-")); dirs.push(dir);
  const file = join(dir, "bridge.sqlite");
  let store = new Store(file);
  try {
    await queue(store);
    await queue(store, "second");
    await flushDigest(store, slot - 1, async () => ask);
    expect(store.pendingOutbox()).toHaveLength(0);
    await flushDigest(store, slot, async () => ask);
    expect(store.pendingOutbox()).toHaveLength(1);
    expect(store.pendingOutbox()[0]?.id).toBe(`digest:${slot}`);
    expect(store.pendingOutbox()[0]?.text.match(/• #128/g)).toHaveLength(1);
    expect(store.get<string>("log:severity:" + `digest:${slot}`)).toBe("info");
    store.close(); store = new Store(file);
    await queue(store, "other", "robob:2:q2", ask, slot + 1);
    await flushDigest(store, slot + 1, async () => ask);
    expect(store.pendingOutbox()).toHaveLength(1);
    await flushDigest(store, slot + 5 * 3_600_000, async () => ask);
    expect(store.pendingOutbox()).toHaveLength(2);
  } finally { store.close(); }
});

test("downtime flushes only the latest missed slot and items after it wait", async () => {
  const { store } = setup();
  await queue(store);
  await queue(store, "late", "robob:2:q1", ask, slot + 10 * 3_600_000 + 1);
  await flushDigest(store, slot + 11 * 3_600_000, async () => ask);
  expect(store.pendingOutbox().map(x => x.id)).toEqual([`digest:${slot + 10 * 3_600_000}`]);
  expect(store.get("digest-item:robob:2:q1")).toBeDefined();
});

test("closed asks drop, newly blocking asks promote, notice stays in digest and failed reads remain included", async () => {
  const { store } = setup();
  for (const id of ["closed", "gone", "answered", "blocking", "notice", "failed"]) await queue(store, id, `watchers:128:q${["closed", "gone", "answered", "blocking", "notice", "failed"].indexOf(id) + 1}`);
  await flushDigest(store, slot, async key => {
    if (key.endsWith("q1")) return { ...ask, closedAt: new Date(slot).toISOString() };
    if (key.endsWith("q2")) return;
    if (key.endsWith("q3")) return { ...ask, answer: {} };
    if (key.endsWith("q4")) return { ...ask, blocking: true };
    if (key.endsWith("q5")) return { ...ask, blocking: true, kind: "notice" };
    throw new Error("offline");
  });
  expect(store.pendingOutbox().map(x => x.id)).toEqual(["blocking", `digest:${slot}`]);
  expect(store.get<string>("ask-timing-key:blocking")).toBe("watchers:128:q4");
  expect(store.get<string[]>(`ask-timing-keys:digest:${slot}`)).toEqual(["watchers:128:q5", "watchers:128:q6"]);
  expect(logs.entries().find(e => e.name === "tg.digest" && e.props?.action === "flush")).toMatchObject({ props: { slot, items: 2, boards: 1, dropped: 3, promoted: 1, truncated: 0 } });
});

test("a blocking admission promotes an already queued ask immediately", async () => {
  const { store } = setup();
  await queue(store);
  expect(enqueueNotice(store, notice("blocking"), slot, undefined)).toBe(true);
  expect(store.pendingOutbox().map(x => x.id)).toEqual(["first"]);
  expect(store.get("digest-item:watchers:128:q1")).toBeUndefined();
});

const fixture = (board: string, n: number, queuedAt = n): DigestItem => ({ askKey: `${board}:${n}:q1`, cardId: `card-fixture-${n}`, board,
  title: `Choose release ${n}`, kind: "decision", queuedAt, revision: 1, noticeId: `notice-${board}-${n}`, source: "fixture", text: "Choose release", severity: "info" });

test("format groups boards by count, lines newest first, with exact ask links", () => {
  const result = formatDigest([fixture("Robob".toLowerCase(), 1), fixture("watchers", 2), fixture("watchers", 3)], slot);
  expect(result.text).toBe("[Robob] Asks digest, 09:00 Dubai: 3 open (2 boards)\n\nwatchers\n• #3 Choose release 3 — https://robob.tail/needs-you?ask=card-fixture-3:q1\n• #2 Choose release 2 — https://robob.tail/needs-you?ask=card-fixture-2:q1\n\nrobob\n• #1 Choose release 1 — https://robob.tail/needs-you?ask=card-fixture-1:q1\nAll: https://robob.tail/needs-you");
  expect(redact(result.text)).toBe(result.text);
});

test("format redacts before shortening and truncation keeps newest lines under 3800 characters", () => {
  const items = Array.from({ length: 100 }, (_, n) => ({ ...fixture("watchers", n + 1), title: "x".repeat(85) + " token=PRIVATE_SECRET" }));
  const result = formatDigest(items, slot);
  expect(result.text.length).toBeLessThan(3_800);
  expect(result.text).toContain("• #100");
  expect(result.text).toContain(`+${result.truncated} more on watchers`);
  expect(result.text).not.toContain("PRIVATE_SECRET");
  expect(result.truncated).toBeGreaterThan(0);
  const manyBoards = formatDigest(Array.from({ length: 100 }, (_, n) => fixture("board-" + n.toString().padStart(3, "0") + "x".repeat(70), n)), slot);
  expect(manyBoards.text.length).toBeLessThan(3_800);
  expect(manyBoards.text).toEndWith("All: https://robob.tail/needs-you");
});

test("timings are deferred until acceptance, retry independently, include truncated asks, and report once per ask", async () => {
  const { store } = setup();
  const keys = Array.from({ length: 50 }, (_, n) => `watchers:${n + 1}:q1`);
  for (const [n, key] of keys.entries()) await queue(store, `notice-${n}`, key);
  const sent: string[] = [];
  const reports: { key: string; at: number }[] = [];
  let failReport = true;
  setSystemTime(slot);
  const delivery = new Delivery(store, {
    sendMessage: async ({ text }) => { sent.push(text); return { providerId: sent.length }; },
    sendDocument: async () => { throw new Error("no document"); },
  }, { enabled: () => true, chatId: () => 1, sleep: async () => {}, getAsk: async () => ask,
    askNotified: async (key, at) => { if (failReport) throw new Error("offline"); reports.push({ key, at }); } });
  expect(reports).toHaveLength(0);
  await delivery.tick();
  expect(sent).toHaveLength(1);
  expect(sent[0]).toContain("more on watchers");
  expect(sent[0]).toContain("?ask=card-fixture:q1");
  await delivery.tick();
  expect(reports).toHaveLength(0);
  failReport = false;
  await delivery.tick(); await delivery.tick();
  expect(reports).toHaveLength(keys.length);
  expect(reports.map(x => x.key).sort()).toEqual(keys.sort());
  expect(reports.every(x => x.at === slot)).toBe(true);
  expect(store.db.query("SELECT key FROM kv WHERE key LIKE 'digest-item:%'").all()).toHaveLength(0);
  // A later reminder follows normal delivery without reporting the ask a second time.
  setSystemTime(slot + 86_400_000);
  enqueueNotice(store, notice("reminder", "watchers:1:q1"));
  await delivery.tick(); await delivery.tick();
  expect(sent).toHaveLength(2);
  expect(reports).toHaveLength(keys.length);
});

test("digest transaction rollback leaves the queue and slot recoverable", async () => {
  const { store } = setup(); await queue(store);
  store.db.exec("CREATE TRIGGER reject_digest BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT, 'rejected'); END");
  await expect(flushDigest(store, slot, async () => ask)).rejects.toThrow("rejected");
  expect(store.get("digest-last-slot")).toBeUndefined();
  expect(store.get("digest-item:watchers:128:q1")).toBeDefined();
  store.db.exec("DROP TRIGGER reject_digest");
  await flushDigest(store, slot, async () => ask);
  expect(store.pendingOutbox()).toHaveLength(1);
});

test.each([["04:59:59Z", -14], ["05:00:00Z", 0], ["09:59:59Z", 0], ["10:00:00Z", 5], ["15:00:00Z", 10]])("slot at %s", (time, hours) => {
  expect(latestDigestSlot(Date.parse("2026-11-22T" + time))).toBe(slot + hours * 3_600_000);
});


test("one refresh budget bounds the whole batch, keeps failed reads, and performs no lookups in SQLite", async () => {
  const { store } = setup();
  for (let n = 1; n <= 20; n++) await queue(store, `n${n}`, `watchers:${n}:q1`);
  const controller = new AbortController();
  const timeout = spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
  let lookups = 0;
  try {
    await flushDigest(store, slot, async (_key, signal) => {
      expect(store.db.inTransaction).toBe(false);
      expect(signal).toBe(controller.signal);
      lookups++;
      // All workers start together, then the shared deadline expires.
      if (lookups === 8) controller.abort(new DOMException("deadline", "TimeoutError"));
      return new Promise(() => {});
    });
    expect(lookups).toBe(8);
    expect(store.pendingOutbox()).toHaveLength(1);
    expect(store.get<string[]>(`ask-timing-keys:digest:${slot}`)).toHaveLength(20);
  } finally { timeout.mockRestore(); }
});

test("accepted digest timing receipts survive restart without a second send or report", async () => {
  const dir = mkdtempSync(join(tmpdir(), "telegram-digest-timing-")); dirs.push(dir);
  const file = join(dir, "bridge.sqlite");
  let store = new Store(file);
  let sends = 0;
  const reports: string[] = [];
  const transport = { sendMessage: async () => { sends++; return { providerId: sends }; }, sendDocument: async () => ({}) };
  const options = { enabled: () => true, chatId: () => 1, sleep: async () => {}, getAsk: async () => ask };
  try {
    await queue(store);
    setSystemTime(slot);
    await new Delivery(store, transport, { ...options, askNotified: async () => { throw new Error("offline"); } }).tick();
    store.close(); store = new Store(file);
    const delivery = new Delivery(store, transport, { ...options, askNotified: async key => { reports.push(key); } });
    await delivery.tick(); await delivery.tick();
    expect(sends).toBe(1);
    expect(reports).toEqual(["watchers:128:q1"]);
    store.close(); store = new Store(file);
    await new Delivery(store, transport, { ...options, askNotified: async key => { reports.push(key); } }).tick();
    expect(reports).toHaveLength(1);
  } finally { store.close(); }
});


test.each([
  ["open", false], ["closed", false], ["blocking", false],
  ["open", true], ["closed", true], ["blocking", true],
])("repeat during stale %s refresh joins current slot; changed=%s", async (state, changed) => {
  const { store } = setup(); await queue(store);
  await flushDigest(store, slot, async () => {
    await queue(store, "repeat", "watchers:128:q1", changed ? { ...ask, title: "Updated question" } : ask, slot + 1);
    if (state === "closed") return { ...ask, closedAt: new Date(slot).toISOString() };
    return { ...ask, blocking: state === "blocking" };
  });
  expect(store.pendingOutbox()).toHaveLength(1);
  expect(store.pendingOutbox()[0]?.id).toBe(`digest:${slot}`);
  expect(store.pendingOutbox()[0]?.text).toContain(changed ? "Updated question" : ask.text);
  expect(store.get("digest-item:watchers:128:q1")).toBeUndefined();
  await flushDigest(store, slot, async () => ask);
  expect(store.pendingOutbox()).toHaveLength(1);
});

test("an immediate promotion during refresh cannot also appear in the digest", async () => {
  const { store } = setup(); await queue(store);
  await flushDigest(store, slot, async () => {
    enqueueNotice(store, notice("promote"), slot);
    return ask;
  });
  expect(store.pendingOutbox().map(x => x.id)).toEqual(["first"]);
  expect(store.get("digest-item:watchers:128:q1")).toBeUndefined();
});

test.each([false, true])("report recovery retains earliest acceptance even after a reminder; legacy=%s", async legacy => {
  const { store } = setup();
  const key = "watchers:128:q1";
  await queue(store);
  let reporting = false;
  let sends = 0;
  const reported: number[] = [];
  const delivery = new Delivery(store, {
    sendMessage: async () => ({ providerId: ++sends }), sendDocument: async () => ({}),
  }, { enabled: () => true, chatId: () => 1, sleep: async () => {}, getAsk: async () => ask,
    askNotified: async (_key, at) => { if (!reporting) throw new Error("offline"); reported.push(at); } });
  setSystemTime(slot);
  await delivery.tick();
  if (legacy) {
    store.db.query("DELETE FROM kv WHERE key = ?").run(`ask-timing-pending:${key}`);
    store.set("ask-timing-pending:zz-old-operation", { key, at: slot });
  }
  setSystemTime(slot + 86_400_000);
  enqueueNotice(store, notice("notify:000", key));
  await delivery.tick();
  expect(sends).toBe(2);
  expect(store.get<{ at: number }>(`ask-timing-pending:${key}`)?.at).toBe(legacy ? slot + 86_400_000 : slot);
  reporting = true;
  await delivery.tick(); await delivery.tick();
  expect(reported).toEqual([slot]);
  expect(store.db.query("SELECT key FROM kv WHERE key LIKE 'ask-timing-pending:%'").all()).toHaveLength(0);
});
