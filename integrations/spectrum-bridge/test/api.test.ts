import { afterEach, expect, setSystemTime, test } from "bun:test";
import { createHash } from "node:crypto";
import { createApi, MAX_FILE_BODY } from "../src/api.ts";
import { MAX_FILE_BYTES } from "../src/cli.ts";
import type { Photon } from "../src/photon.ts";
import type { Router } from "../src/router.ts";
import { Store } from "../src/store.ts";

const stores: Store[] = [];
const now = Date.parse("2026-09-10T00:00:00Z");
const file = { base64: Buffer.from("PRIVATE_FILE_CONTENT\x00\xff").toString("base64"), name: "report.pdf",
  mimeType: "application/pdf", text: "A report", dedupeKey: "file-1", sessionId: "current" };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

function setup() {
  setSystemTime(now);
  const store = new Store(":memory:");
  stores.push(store);
  const reactions: Parameters<Photon["react"]>[] = [];
  const state = {
    enabled: true, chat: "iMessage;-;+15555550123" as string | undefined, routed: false,
    health: { ok: true } as Record<string, unknown>, reactionError: false,
    routerStatus: { route: null, pending: [] } as unknown,
  };
  // Any Router access beyond the /router status surface would risk consuming
  // conversational ingress or creating a session.
  const router = new Proxy({} as Router, {
    get(_target, property) {
      if (property === "routerStatus") return () => state.routerStatus;
      throw new Error("Unexpected Router access");
    },
  });
  const photon: Pick<Photon, "react"> = {
    async react(...args) {
      reactions.push(args);
      if (state.reactionError) throw new Error("PRIVATE_PROVIDER_CREDENTIAL");
    },
  };
  const options = { store, photon, router: () => state.routed ? router : undefined, chatGuid: () => state.chat,
    enabled: () => state.enabled, health: () => state.health };
  const api = createApi(options);
  const get = (path: string) => api(new Request(`http://bridge${path}`));
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) => api(new Request(`http://bridge${path}`, {
    method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
  }));
  return { store, state, reactions, options, api, get, post };
}

afterEach(() => {
  setSystemTime();
  for (const store of stores.splice(0)) store.close();
});

test("health projects safe fields and never exposes credentials, chat identity, or session state", async () => {
  const h = setup();
  h.state.health = {
    ok: true, connected: false, status: "degraded", uptimeSeconds: 12, lastEventAt: now,
    lastTickAt: "PRIVATE_TIMESTAMP", photonConnected: { secret: "PRIVATE_NESTED" },
    secret: "PRIVATE_SECRET", token: "PRIVATE_TOKEN", projectId: "PRIVATE_PROJECT",
    error: "PRIVATE_ERROR", sessionId: "PRIVATE_SESSION", config: { secret: "PRIVATE_CONFIG" },
  };
  const response = await h.get("/health");
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ ok: true, connected: false, status: "degraded", uptimeSeconds: 12,
    lastEventAt: now, enabled: true, paired: true, ready: false });
  h.state.health = { status: "PRIVATE_STATUS", uptimeSeconds: Infinity, lastEventAt: -1 };
  h.state.enabled = false;
  h.state.chat = undefined;
  expect(await (await h.get("/health")).json()).toEqual({ enabled: false, paired: false, ready: false });
  const failing = createApi({ ...h.options, health() { throw new Error("PRIVATE_HEALTH"); } });
  const failure = await failing(new Request("http://bridge/health"));
  expect(failure.status).toBe(409);
  expect(await failure.json()).toEqual({ error: "Operation could not be completed" });
});

test("router status is read-only, available without pairing, and reports nothing without a Router", async () => {
  const h = setup();
  h.state.enabled = false;
  h.state.chat = undefined;
  const absent = await h.get("/router");
  expect(absent.status).toBe(200);
  expect(await absent.json()).toEqual({ route: null, pending: [] });
  h.state.routed = true;
  h.state.routerStatus = {
    route: { id: "session-1", directory: "/PRIVATE_DIR/chats/2026-09-19/session-x", generation: 4 },
    pending: [{ id: "req-1", kind: "permission", state: "pending", operationState: "sent" },
      { id: "req-2", kind: "question", state: "expired", operationState: null }],
  };
  const active = await h.get("/router");
  expect(active.status).toBe(200);
  expect(await active.json()).toEqual(h.state.routerStatus);
});

test("mutations require enabled pairing and refuse group, empty, and malformed chat GUIDs", async () => {
  const h = setup();
  h.store.set("route", { id: "current", generation: 1 });
  for (const state of [{ enabled: false }, { chat: undefined }, { chat: "" }, { chat: "iMessage;+;group" },
    { chat: "iMessage;-;" }, { chat: "iMessage;-;owner;other" }, { chat: "any;-;owner\n" }]) {
    h.state.enabled = true;
    h.state.chat = "iMessage;-;+15555550123";
    Object.assign(h.state, state);
    for (const [path, body] of [["/files", file], ["/react", { target: "any", kind: "like" }]] as const) {
      const response = await h.post(path, body);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "Bridge is not ready" });
    }
  }
  expect(h.store.pendingOutbox()).toEqual([]);
  expect(h.reactions).toEqual([]);
});

test("Origin is rejected on every route, including empty/null, and methods and unknown paths fail closed", async () => {
  const h = setup();
  for (const origin of ["https://untrusted.invalid", "null", ""]) {
    for (const path of ["/health", "/router"]) {
      expect((await h.api(new Request(`http://bridge${path}`, { headers: { Origin: origin } }))).status).toBe(403);
    }
    expect((await h.post("/react", { target: "x", kind: "like" }, { Origin: origin })).status).toBe(403);
    expect((await h.post("/files", file, { Origin: origin })).status).toBe(403);
  }
  for (const [method, path] of [["GET", "/missing"], ["GET", "/react"], ["GET", "/files"], ["PUT", "/files"],
    ["OPTIONS", "/react"], ["POST", "/health"], ["POST", "/router"], ["GET", "/notify"], ["POST", "/notify"],
    ["GET", "/reminders"], ["POST", "/reminders"]]) {
    const response = await h.api(new Request(`http://bridge${path}`, { method }));
    expect(response.status).toBe(404);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  }
  expect(h.store.pendingOutbox()).toEqual([]);
});

test("body parsing rejects malformed JSON, types, encodings, and oversize declared or streamed bytes", async () => {
  const h = setup();
  for (const body of ["{PRIVATE_JSON", "null", "[]", "true", "1", '"string"', ""]) {
    const response = await h.api(new Request("http://bridge/react", { method: "POST", headers: { "Content-Type": "application/json" }, body }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid request" });
  }
  expect((await h.post("/react", { target: "x", kind: "like" }, { "Content-Type": "text/plain" })).status).toBe(400);
  expect((await h.post("/react", { target: "x", kind: "like" }, { "Content-Length": "20481" })).status).toBe(413);
  expect((await h.post("/react", { target: "x", kind: "like" }, { "Content-Length": "-1" })).status).toBe(400);
  const invalid = new Request("http://bridge/react", { method: "POST", headers: { "Content-Type": "application/json" }, body: new Uint8Array([0xff]) });
  expect((await h.api(invalid)).status).toBe(400);
  let cancelled = false;
  let reads = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) { reads++; controller.enqueue(new Uint8Array(4096).fill(32)); },
    cancel() { cancelled = true; },
  });
  const response = await h.api(new Request("http://bridge/react", {
    method: "POST", headers: { "Content-Type": "application/json", "Content-Length": "1" }, body: stream,
  }));
  expect(response.status).toBe(413);
  expect(cancelled).toBe(true);
  expect(reads).toBeLessThanOrEqual(7);
  expect(h.store.pendingOutbox()).toEqual([]);
});

test("reactions authorize only authenticated inbound IDs or outbound provider IDs and use stable operations", async () => {
  const h = setup();
  h.store.acceptInbound("inbound", { text: "authenticated" });
  h.store.updateInbound("inbound", "done");
  h.store.enqueue({ id: "operation", kind: "conversation", text: "answer" });
  h.store.outboxState("operation", "sent", "provider");
  for (const target of ["inbound", "provider"]) {
    for (const kind of ["like", "love", "dislike", "laugh", "emphasize", "question"] as const) {
      for (let i = 0; i < 2; i++) expect((await h.post("/react", { target, kind })).status).toBe(200);
      const expected: Parameters<Photon["react"]> = [h.state.chat!, target, kind, `reaction:${hash(target + kind)}`];
      expect(h.reactions.at(-1)).toEqual(expected);
      expect(h.reactions.at(-2)).toEqual(expected);
    }
  }
  const count = h.reactions.length;
  for (const target of ["arbitrary-message", "operation", "last", "' OR 1=1 --"]) {
    expect((await h.post("/react", { target, kind: "like" })).status).toBe(403);
  }
  for (const body of [{ target: "inbound", kind: "heart" }, { target: "", kind: "like" }, { target: "x".repeat(201), kind: "like" },
    { target: "inbound", kind: "like", chatGuid: "other" }]) expect((await h.post("/react", body)).status).toBe(400);
  expect(h.reactions).toHaveLength(count);
  h.state.reactionError = true;
  const failure = await h.post("/react", { target: "inbound", kind: "like" });
  expect(failure.status).toBe(409);
  expect(await failure.json()).toEqual({ error: "Operation could not be completed" });
  expect(h.store.get("route")).toBeUndefined();
});

test("files atomically queue bytes and descriptors, dedupe across handlers, and never invoke a model or Photon", async () => {
  const h = setup();
  h.store.set("route", { id: "current", generation: 2 });
  h.store.acceptInbound("pending", { text: "Do not submit" });
  const response = await h.post("/files", file);
  const id = `file:${hash(file.dedupeKey)}`;
  expect(response.status).toBe(202);
  expect(await response.json()).toEqual({ id, created: true });
  const data = Buffer.from(file.base64, "base64");
  const attachment = { sha256: createHash("sha256").update(data).digest("hex"), name: file.name, mimeType: file.mimeType, size: data.length };
  expect(h.store.getOperation(id)).toEqual({ id, kind: "conversation", text: file.text, attachment,
    sessionId: "current", generation: 2, state: "pending", attempts: 0 });
  expect(Buffer.from(h.store.getBlob(attachment.sha256))).toEqual(data);
  expect(h.store.get<{ spec: string }>(`api:file:${id}`)?.spec)
    .toBe(JSON.stringify({ id, kind: "conversation", text: file.text, attachment, sessionId: "current", generation: 2 }));
  h.store.outboxState(id, "sent", "provider-file");
  const replay = await createApi(h.options)(new Request("http://bridge/files", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(file),
  }));
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual({ id, created: false });
  expect(h.store.getOperation(id)?.state).toBe("sent");
  const concurrent = await Promise.all(Array.from({ length: 8 }, () => h.post("/files", { ...file, dedupeKey: "concurrent" })));
  expect(concurrent.map(res => res.status).sort()).toEqual([200, 200, 200, 200, 200, 200, 200, 202]);
  expect(h.store.db.query("SELECT sha256 FROM blobs").all()).toEqual([{ sha256: attachment.sha256 }]);
  expect(h.store.get<{ id: string; generation: number }>("route")).toEqual({ id: "current", generation: 2 });
  expect(h.store.pendingInbound()).toEqual([{ id: "pending", state: "pending", payload: { text: "Do not submit" } }]);
  expect(h.reactions).toEqual([]);
});

test("one-time notification files moved to the telegram bridge; a session binding is mandatory", async () => {
  const h = setup();
  h.store.set("route", { id: "current", generation: 2 });
  const { sessionId, ...withoutSession } = file;
  expect((await h.post("/files", withoutSession)).status).toBe(400);
  expect(h.store.pendingOutbox()).toEqual([]);
  expect(h.store.db.query("SELECT * FROM blobs").all()).toEqual([]);
  void sessionId;
});

test("session files bind the current generation and reject stale, missing, or malformed routes without writes", async () => {
  const h = setup();
  h.store.set("route", { id: "current", generation: 7 });
  const id = `file:${hash(file.dedupeKey)}`;
  expect((await h.post("/files", file)).status).toBe(202);
  expect(h.store.getOperation(id)).toMatchObject({ kind: "conversation", sessionId: "current", generation: 7, text: file.text });
  expect((await h.post("/files", file)).status).toBe(200);
  for (const route of [null, { id: "new", generation: 8 }, { id: "current", generation: -1 },
    { id: "current" }, { id: "current", generation: "7" }, { id: "current", generation: 1.5 }]) {
    h.store.set("route", route);
    for (const dedupeKey of [file.dedupeKey, "new-file"]) {
      expect((await h.post("/files", { ...file, dedupeKey })).status).toBe(409);
    }
  }
  h.store.set("route", { id: "current", generation: 8 });
  expect((await h.post("/files", file)).status).toBe(409);
  expect(h.store.getOperation(id)).toMatchObject({ generation: 7, state: "pending" });
  expect(h.store.getOperation(`file:${hash("new-file")}`)).toBeUndefined();
  expect(h.store.db.query("SELECT sha256 FROM blobs").all()).toHaveLength(1);
  expect(h.reactions).toEqual([]);
});

test("a chat reset in place keeps its id, so a generation-tagged session rejects sends from before the reset", async () => {
  const h = setup();
  h.store.set("route", { id: "current", generation: 7 });
  const id = `file:${hash(file.dedupeKey)}`;
  expect((await h.post("/files", { ...file, sessionId: "current@7" })).status).toBe(202);
  // The canonical chat id is stored, never the tag.
  expect(h.store.getOperation(id)).toMatchObject({ sessionId: "current", generation: 7 });
  expect((await h.post("/files", { ...file, sessionId: "current@6", dedupeKey: "stale" })).status).toBe(409);
  expect((await h.post("/files", { ...file, sessionId: "other@7", dedupeKey: "other" })).status).toBe(409);
  h.store.set("route", { id: "current", generation: 8 });
  expect((await h.post("/files", { ...file, sessionId: "current@7", dedupeKey: "after-reset" })).status).toBe(409);
  // The bare id still follows the live chat (robob-watch and wacli-guard read it from the route).
  expect((await h.post("/files", { ...file, dedupeKey: "bare" })).status).toBe(202);
  expect(h.store.getOperation(`file:${hash("bare")}`)).toMatchObject({ sessionId: "current", generation: 8 });
  for (const key of ["stale", "other", "after-reset"]) expect(h.store.getOperation(`file:${hash(key)}`)).toBeUndefined();
});

test("file dedupe conflicts and transaction failures roll back blob, operation, and metadata changes", async () => {
  const h = setup();
  h.store.set("route", { id: "current", generation: 1 });
  expect((await h.post("/files", file)).status).toBe(202);
  const snapshot = () => ({ blobs: h.store.db.query("SELECT * FROM blobs").all(),
    outbox: h.store.db.query("SELECT * FROM outbox").all(), kv: h.store.db.query("SELECT * FROM kv").all() });
  const before = snapshot();
  for (const change of [{ base64: "YWJj" }, { name: "other.pdf" }, { mimeType: "text/plain" }, { text: "other" }]) {
    const response = await h.post("/files", { ...file, ...change });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "Operation could not be completed" });
    expect(snapshot()).toEqual(before);
  }
  // An outbox collision without API metadata fails after putBlob; that insertion must roll back.
  const collision = `file:${hash("collision")}`;
  h.store.enqueue({ id: collision, kind: "conversation", text: "pre-existing", sessionId: "current", generation: 1 });
  const collided = snapshot();
  expect((await h.post("/files", { ...file, base64: "YWJj", dedupeKey: "collision" })).status).toBe(409);
  expect(snapshot()).toEqual(collided);
  h.store.db.exec("CREATE TRIGGER fail_file_kv BEFORE INSERT ON kv BEGIN SELECT RAISE(ABORT, 'PRIVATE_DB_ERROR'); END");
  expect((await h.post("/files", { ...file, base64: "ZGVm", dedupeKey: "fail-kv" })).status).toBe(409);
  expect(snapshot()).toEqual(collided);
});

test("files accept only strict canonical base64, bounded metadata, and bytes rather than arbitrary paths", async () => {
  const h = setup();
  h.store.set("route", { id: "current", generation: 1 });
  for (const base64 of [undefined, null, 123, [], "", "YQ", "YQ=", "YQ===", "YR==", "YWJ=", "YWJj\n", " YWJj",
    "Y WJj", "-w==", "_w==", "====", "YQ==YWJj", "YQ==\x00", "data:text/plain;base64,YQ=="]) {
    expect((await h.post("/files", { ...file, base64 })).status).toBe(400);
  }
  for (const name of [undefined, null, 1, "", " ", ".", "..", "/tmp/report.pdf", "dir/report.pdf", "dir\\report.pdf", "C:report.pdf",
    "report\n.pdf", "report\x00.pdf", "report\x7f.pdf", "report\u0085.pdf", "x".repeat(256), "\u4e2d".repeat(86)]) {
    expect((await h.post("/files", { ...file, name })).status).toBe(400);
  }
  for (const mimeType of [undefined, null, 1, "", "text", "/plain", "text/", "text/*", "text/plain; charset=utf-8", "text/plain\n",
    "text/plain\x00", "text/\u4e2d", "x/" + "a".repeat(99)]) {
    expect((await h.post("/files", { ...file, mimeType })).status).toBe(400);
  }
  for (const change of [{ dedupeKey: undefined }, { dedupeKey: "" }, { dedupeKey: " " }, { dedupeKey: "k".repeat(201) }, { dedupeKey: 1 },
    { text: null }, { text: [] }, { text: "t".repeat(12_001) }, { sessionId: null }, { sessionId: "" }, { sessionId: "old new" },
    { sessionId: "s".repeat(201) }, { sessionId: "old\n" }, { file: "/PRIVATE_FILE" }, { path: "/PRIVATE_FILE" },
    { url: "file:///PRIVATE_FILE" }, { attachment: {} }, { chatGuid: "other" }, { source: "other" }, { replyTo: "other" }, { generation: 1 }]) {
    const response = await h.post("/files", { ...file, ...change });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid request" });
  }
  expect((await h.post("/files", { file: "/PRIVATE_FILE", dedupeKey: "path", sessionId: "current" })).status).toBe(400);
  expect(h.store.db.query("SELECT * FROM blobs").all()).toEqual([]);
  expect(h.store.pendingOutbox()).toEqual([]);
  expect((await h.post("/files", { ...file, base64: "/w==", name: "x".repeat(255), mimeType: "x/" + "a".repeat(98),
    text: "t".repeat(12_000), dedupeKey: "k".repeat(200) })).status).toBe(202);
});

test("files accept exactly 20 MiB and reject larger decoded bytes even at the same base64 length", async () => {
  const h = setup();
  h.store.set("route", { id: "current", generation: 1 });
  const data = Buffer.alloc(MAX_FILE_BYTES, 0xff);
  expect((await h.post("/files", { ...file, base64: data.toString("base64") })).status).toBe(202);
  const operation = h.store.getOperation(`file:${hash(file.dedupeKey)}`)!;
  expect(operation.attachment?.size).toBe(MAX_FILE_BYTES);
  expect(Buffer.from(h.store.getBlob(operation.attachment!.sha256))).toEqual(data);
  for (const extra of [1, 2]) {
    expect((await h.post("/files", { ...file, base64: Buffer.alloc(MAX_FILE_BYTES + extra).toString("base64"), dedupeKey: "oversize" })).status).toBe(413);
  }
  expect(h.store.db.query("SELECT sha256 FROM blobs").all()).toHaveLength(1);
});

test("only /files has a 28 MiB JSON budget, including declared and streaming limits", async () => {
  const h = setup();
  h.store.set("route", { id: "current", generation: 1 });
  expect((await h.post("/files", file, { "Content-Length": String(MAX_FILE_BODY) })).status).toBe(202);
  expect((await h.post("/files", { ...file, dedupeKey: "boundary" }, { "Content-Length": String(MAX_FILE_BODY + 1) })).status).toBe(413);
  expect((await h.post("/files", file, { "Content-Type": "text/plain" })).status).toBe(400);
  expect((await h.post("/files", file, { "Content-Length": "-1" })).status).toBe(400);
  for (const path of ["/react"]) {
    expect((await h.post(path, { target: "x".repeat(20 * 1024), kind: "like" })).status).toBe(413);
  }
  let reads = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) { reads++; controller.enqueue(new Uint8Array(1024 * 1024).fill(32)); },
    cancel() { cancelled = true; },
  });
  expect((await h.api(new Request("http://bridge/files", {
    method: "POST", headers: { "Content-Type": "application/json", "Content-Length": "1" }, body: stream,
  }))).status).toBe(413);
  expect(cancelled).toBe(true);
  expect(reads).toBeLessThanOrEqual(30);
});
