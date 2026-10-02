import { afterEach, expect, test } from "bun:test";
import { OpenChamber } from "../src/openchamber.ts";
import { backfillOrigins, OriginBackfill, ownedSessions } from "../src/origin-backfill.ts";
import { Store } from "../src/store.ts";

const stores: Store[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(servers.splice(0).map(server => server.stop(true)));
});

function seeded(): Store {
  const store = new Store(":memory:");
  stores.push(store);
  store.set("route", { id: "ses_route", directory: "/Chats/route", generation: 3, createdAt: 1 });
  store.set("seed:ses_rotated", "Continuity: ...");
  store.enqueue({ id: "reply:1:msg_a", kind: "conversation", text: "hi", sessionId: "ses_old", generation: 1 });
  store.enqueue({ id: "reply:3:msg_b", kind: "conversation", text: "hi", sessionId: "ses_route", generation: 3 });
  store.enqueue({ id: "turn:2:msg_c:approval", kind: "control", text: "ok?", sessionId: "ses_older", generation: 2 });
  store.enqueue({ id: "control:abc", kind: "control", text: "no session" });
  // A historical notification can name any session; it is never an owned one.
  store.enqueue({ id: "notify:x", kind: "notification", text: "done", sessionId: "ses_someone_elses" });
  return store;
}

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
// RFC 7386, as OpenChamber's metadata store applies it.
const merge = (base: unknown, patch: Record<string, unknown>): Record<string, unknown> => {
  const result: Record<string, unknown> = isObject(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(patch)) result[key] = isObject(value) ? merge(result[key], value) : value;
  return result;
};

/** OpenCode's session read plus OpenChamber's serialized metadata route. */
function backendWith(metadata: Map<string, unknown>, flaky: Set<string>, patches: string[]) {
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch: async request => {
      const parts = new URL(request.url).pathname.split("/").map(decodeURIComponent);
      if (request.method === "POST") {
        const id = parts.at(-2)!;
        if (flaky.has(id)) return Response.json({ error: "conflict" }, { status: 409 });
        patches.push(id);
        metadata.set(id, merge(metadata.get(id), ((await request.json()) as { patch: Record<string, unknown> }).patch));
        return Response.json({ metadata: metadata.get(id) });
      }
      const id = parts.at(-1)!;
      if (!metadata.has(id)) return Response.json({ _tag: "SessionNotFoundError", sessionID: id }, { status: 404 });
      return Response.json({ data: { id, location: { directory: `/Chats/${id}` }, metadata: metadata.get(id) } });
    },
  });
  servers.push(server);
  return new OpenChamber(server.url.origin);
}

test("owned sessions are the route, rotated routes and every conversation session", () => {
  expect(ownedSessions(seeded()).sort((a, b) => a.id.localeCompare(b.id))).toEqual([
    { id: "ses_old" }, { id: "ses_older" }, { id: "ses_rotated" }, { id: "ses_route", directory: "/Chats/route" },
  ]);
});

test("marks each owned session once, keeps other metadata and retries only what failed", async () => {
  const store = seeded();
  const metadata = new Map<string, unknown>([
    ["ses_route", { openchamber: { assist: { recap: "kept" } }, other: 1 }],
    ["ses_old", { openchamber: { origin: "imessage" } }],
    ["ses_older", {}],
    ["ses_rotated", { openchamber: { goal: { status: "active" } } }],
  ]);
  const flaky = new Set(["ses_rotated"]);
  const patches: string[] = [];
  const backend = backendWith(metadata, flaky, patches);

  expect(await backfillOrigins(store, backend)).toEqual({ marked: 2, already: 1, missing: 0, pending: 1 });
  expect(metadata.get("ses_route")).toEqual({ openchamber: { assist: { recap: "kept" }, origin: "imessage" }, other: 1 });
  expect(metadata.get("ses_older")).toEqual({ openchamber: { origin: "imessage" } });
  expect(metadata.get("ses_someone_elses")).toBeUndefined();

  // The next pass reads back what it wrote and retries what failed. Another
  // writer replaced one object in between, so that one is marked again.
  flaky.clear();
  patches.length = 0;
  metadata.set("ses_older", { openchamber: { assist: { recap: "raced" } } });
  expect(await backfillOrigins(store, backend)).toEqual({ marked: 2, already: 1, missing: 0, pending: 0 });
  expect(patches.sort()).toEqual(["ses_older", "ses_rotated"]);
  expect(metadata.get("ses_rotated")).toEqual({ openchamber: { goal: { status: "active" }, origin: "imessage" } });
  expect(metadata.get("ses_older")).toEqual({ openchamber: { assist: { recap: "raced" }, origin: "imessage" } });
  expect(await backfillOrigins(store, backend)).toEqual({ marked: 0, already: 2, missing: 0, pending: 0 });
  // Everything is confirmed now: nothing is read again.
  expect(await backfillOrigins(store, backend)).toEqual({ marked: 0, already: 0, missing: 0, pending: 0 });

  // A session OpenCode reports not found is settled, not retried forever.
  store.set("seed:ses_deleted", "Continuity: ...");
  expect(await backfillOrigins(store, backend)).toEqual({ marked: 0, already: 0, missing: 1, pending: 0 });
  expect(await backfillOrigins(store, backend)).toEqual({ marked: 0, already: 0, missing: 0, pending: 0 });
});

test("each pass handles a bounded batch and reports the rest as pending", async () => {
  const store = seeded();
  const asked: string[] = [];
  const backend = { markImessageOrigin: async (id: string) => { asked.push(id); return "already" as const; } };
  expect(await backfillOrigins(store, backend, 2)).toEqual({ marked: 0, already: 2, missing: 0, pending: 2 });
  expect(await backfillOrigins(store, backend, 2)).toEqual({ marked: 0, already: 2, missing: 0, pending: 0 });
  expect(new Set(asked).size).toBe(4);
});

test("an unreachable backend ends the pass early and marks nothing as done", async () => {
  const store = seeded();
  let calls = 0;
  const backend = { markImessageOrigin: async () => { calls++; throw Object.assign(new Error("down"), { status: 0 }); } };
  expect(await backfillOrigins(store, backend)).toEqual({ marked: 0, already: 0, missing: 0, pending: 4 });
  expect(calls).toBe(1);
  expect(store.db.query("SELECT count(*) AS n FROM kv WHERE key LIKE 'origin-marked:%'").get()).toEqual({ n: 0 });
});

test("the background runner is single-flight, returns at once, and backs off on failure", async () => {
  let clock = 0;
  const logs: string[] = [];
  const results: Array<() => Promise<{ marked: number; already: number; missing: number; pending: number }>> = [];
  let release!: () => void;
  let started = 0;
  const runner = new OriginBackfill(() => { started++; return results.shift()!(); }, event => logs.push(event),
    { now: () => clock, nextPassMs: 60_000, initialBackoffMs: 30_000, maxBackoffMs: 120_000 });

  // A slow pass: kicks while it runs start nothing new.
  results.push(() => new Promise(resolve => { release = () => resolve({ marked: 3, already: 0, missing: 0, pending: 5 }); }));
  const first = runner.kick();
  expect(runner.kick()).toBe(first);
  expect(started).toBe(1);
  release();
  await first;
  expect(logs).toEqual(["origin-backfill-marked"]);
  // Not due yet.
  expect(runner.kick()).toBeUndefined();
  expect(started).toBe(1);

  // Failures back off, doubling up to the cap; a thrown pass never escapes.
  for (const wait of [60_000, 30_000, 60_000, 120_000, 120_000]) {
    clock += wait;
    results.push(async () => { throw new Error("down"); });
    await runner.kick();
  }
  expect(started).toBe(6);
  expect(logs.filter(event => event === "origin-backfill-failed")).toHaveLength(5);

  // No progress with sessions waiting (every one failed) also counts as a failure.
  clock += 120_000;
  results.push(async () => ({ marked: 0, already: 0, missing: 0, pending: 4 }));
  await runner.kick();
  expect(logs.at(-1)).toBe("origin-backfill-failed");

  // Read-back pass confirms everything: done, never runs again.
  clock += 120_000;
  results.push(async () => ({ marked: 0, already: 4, missing: 0, pending: 0 }));
  await runner.kick();
  expect(runner.done).toBe(true);
  clock += 10 * 60 * 60_000;
  expect(runner.kick()).toBeUndefined();
  expect(started).toBe(8);
});
