import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createApi } from "../src/api.ts";
import { parseCommand } from "../src/cli.ts";
import { Delivery } from "../src/delivery.ts";
import { Store } from "../src/store.ts";
import { ChatRegistry, createSbApi } from "../src/runtime.ts";
import type { Line } from "../src/line.ts";

const stores: Store[] = [];
const key = "memory-capture-stall:old-incident";
const id = `send:${createHash("sha256").update(key).digest("hex")}`;
const warning = "Memory capture has not completed successfully for 6 hours; new sessions may not be saved.";

function setup() {
  const store = new Store(":memory:");
  stores.push(store);
  store.set("route", { id: "owner", generation: 1 });
  const api = createApi({ store, photon: { react: async () => {} }, router: () => undefined,
    chatGuid: () => "iMessage;-;+15555550123", enabled: () => true, health: () => ({ ok: true }) });
  const post = (path: string, body: unknown) => api(new Request(`http://bridge${path}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }));
  const enqueue = () => post("/send", { text: warning, dedupeKey: key, sessionId: "owner@1" });
  const cancel = () => post("/cancel-send", { dedupeKey: key, sessionId: "owner@1" });
  return { store, post, enqueue, cancel, api };
}

afterEach(() => { for (const store of stores.splice(0)) store.close(); });

test("capture recovery retires its pending warning before the real worker sends it", async () => {
  const h = setup();
  await h.enqueue();
  h.store.set(`retry:${id}`, Date.now() + 60_000);
  const sent: string[] = [];
  const delivery = new Delivery(h.store, { sendText: async input => {
    sent.push(input.text); return { providerId: String(sent.length) };
  } }, { projectScope: "test", chatGuid: () => "chat", enabled: () => true, sleep: async () => {} });
  await delivery.tick();
  expect(sent).toEqual([]);
  expect(await (await h.cancel()).json()).toMatchObject({ cancelled: true });
  h.store.set(`retry:${id}`, 0);
  await delivery.tick();
  expect(sent).toEqual([]);
  expect(h.store.getOperation(id)?.state).toBe("cancelled");
  await h.post("/send", { text: warning, dedupeKey: "memory-capture-stall:new-incident", sessionId: "owner@1" });
  await delivery.tick();
  expect(sent).toEqual([warning]);
});

test("cancellation during the worker's async guard cannot resurrect a queued warning", async () => {
  const h = setup();
  await h.enqueue();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let sends = 0;
  const delivery = new Delivery(h.store, { sendText: async () => { sends++; return { providerId: "sent" }; } },
    { projectScope: "test", chatGuid: () => "chat", enabled: () => true,
      beforeSend: async () => { entered.resolve(); await release.promise; return "send"; } });
  const tick = delivery.tick();
  await entered.promise;
  await h.cancel();
  release.resolve();
  await tick;
  expect(sends).toBe(0);
  expect(h.store.getOperation(id)?.state).toBe("cancelled");
});

test.each([
  ["pending", 0, undefined, false, true],
  ["pending", 2, false, false, true],
  ["pending", 2, true, false, false],
  ["pending", 2, undefined, false, false],
  ["pending", 0, undefined, true, false],
  ["sending", 1, true, false, false],
  ["uncertain", 1, true, false, false],
  ["sent", 1, false, false, false],
  ["failed", 1, false, false, false],
  ["cancelled", 0, undefined, false, true],
] as const)("cancellation preserves outbox evidence: %s/%i/%s/checkpoint=%s", async (state, attempts, ambiguous, checkpoint, cancelled) => {
  const h = setup();
  await h.enqueue();
  h.store.db.query("UPDATE outbox SET state=?, attempts=? WHERE id=?").run(state, attempts, id);
  if (ambiguous !== undefined) h.store.set(`sendAmbiguous:${id}`, ambiguous);
  if (checkpoint) h.store.set(`chunk:${id}:0`, { accepted: true });
  expect(await (await h.cancel()).json()).toMatchObject({ cancelled });
  expect(h.store.getOperation(id)?.state).toBe(cancelled ? "cancelled" : state);
});

test("cancelling before a delayed enqueue fences the key and retries are idempotent", async () => {
  const h = setup();
  await h.cancel();
  await h.cancel();
  expect((await h.enqueue()).status).toBe(409);
  expect(h.store.getOperation(id)).toBeUndefined();
  expect((await h.post("/cancel-send", { dedupeKey: key, sessionId: "stale" })).status).toBe(409);
});

test("cancel-send CLI requires a key and session without accepting message content", () => {
  expect(parseCommand(["cancel-send", "--key", key, "--session", "owner@1"]))
    .toEqual({ method: "POST", path: "/cancel-send", body: { dedupeKey: key, sessionId: "owner@1" } });
  expect(() => parseCommand(["cancel-send", "--key", key])).toThrow();
  expect(() => parseCommand(["cancel-send", "--session", "owner@1"])).toThrow();
  expect(() => parseCommand(["cancel-send", "--key", key, "--session", "owner@1", "--text", warning])).toThrow();
});

test("Sendblue forwards cancellation to the calling chat's API", async () => {
  const h = setup();
  const line = { react: async () => {} } as unknown as Line;
  const registry = new ChatRegistry({ line, owner: "+15555550123", ownerStore: h.store,
    stateRoot: "/unused", access: () => ({ people: [], groups: [] }), build: () => ({ api: h.api }) });
  registry.restore();
  const api = createSbApi({ registry, line, accessPath: "/unused", enabled: () => true, health: () => ({ ok: true }) });
  await h.enqueue();
  const response = await api(new Request("http://bridge/cancel-send", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: "owner@1", dedupeKey: key }),
  }));
  expect(response.status).toBe(200);
  expect(h.store.getOperation(id)?.state).toBe("cancelled");
});
