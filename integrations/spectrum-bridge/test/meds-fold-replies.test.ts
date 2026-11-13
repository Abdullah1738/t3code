import { afterEach, expect, test } from "bun:test";
import { createApi } from "../src/api.ts";
import type { ChatContext, ChatInfo } from "../src/chats.ts";
import { Delivery } from "../src/delivery.ts";
import { OpenChamber, type MessageRecord, type PermissionRequest, type QuestionRequest, type SessionRecord } from "../src/openchamber.ts";
import { TransportError, type NormalizedInbound, type Photon } from "../src/photon.ts";
import { Router } from "../src/router.ts";
import { Store } from "../src/store.ts";
import { fakeFold, HOLD_FOLD, LINE } from "./meds-fold-fixture.ts";

class Backend extends OpenChamber {
  records: MessageRecord[] = [];
  constructor() { super("http://127.0.0.1:1"); }
  override async request<T>(): Promise<T | undefined> { throw new Error("Unexpected backend request"); }
  override async createChat(): Promise<SessionRecord> { return { id: "ses_1", directory: "/Chats/ses_1" } as SessionRecord; }
  override async isSessionAutoAccepting() { return false; }
  override async permissions(): Promise<PermissionRequest[]> { return []; }
  override async questions(): Promise<QuestionRequest[]> { return []; }
  override async children(): Promise<SessionRecord[]> { return []; }
  override async statuses() { return {}; }
  override async messages() { return this.records; }
  override async getSession(): Promise<SessionRecord> { return { id: "ses_1", directory: "/Chats/ses_1", title: "Chat" } as SessionRecord; }
  override async promptAccepted(_id: string, _directory: string, messageId: string) { return this.records.some(r => r.id === messageId); }
  override async prompt(_id: string, _directory: string, messageId: string, text: string) {
    this.records.push({ id: messageId, type: "user", text, time: { created: Date.now() } });
  }
  finish(texts: readonly string[]) {
    for (const text of texts) this.records.push({ id: `answer_${this.records.length}`, type: "assistant", agent: "build",
      model: { providerID: "test", id: "model" }, content: [{ type: "text", text }], answer: true,
      finish: "stop", time: { created: Date.now(), completed: Date.now() } });
    this.records.push({ id: `idle_${this.records.length}`, type: "idle", outcome: "succeeded", time: { created: Date.now() } });
  }
}

const harnesses: { store: Store; fake: ReturnType<typeof fakeFold> }[] = [];
function setup(opts: { kind?: ChatInfo["kind"]; slug?: string; tool?: boolean; body?: string; disabled?: boolean } = {}) {
  const fake = fakeFold(opts.body);
  const store = new Store(":memory:");
  const backend = new Backend();
  const kind = opts.kind ?? "owner";
  const chat: ChatInfo = { key: kind === "group" ? "group:test" : "dm:+15555550123", kind, slug: opts.slug ?? "owner", title: "Test" };
  const context: ChatContext = { chat, roleOf: () => ({ name: "Test", role: "owner" }), typing: () => false, react: async () => {} };
  const transport = { async typing() {}, async read() {}, async downloadAttachment() { throw new Error("Unexpected download"); } };
  const router = new Router(store, backend, transport, { owner: "+15555550123", chatGuid: chat.key, context,
    timezone: "Asia/Dubai", skillPath: "/test/skill", alertSkillPath: "/test/alert", alertSocketPath: "/test/socket",
    openCodeConfigRoot: "/nonexistent", quietMs: 0, replyMode: opts.tool ? "tool" : "final", medsFold: opts.disabled ? false : fake.options });
  const api = createApi({ store, photon: { react: async () => {} },
    router: () => router, chatGuid: () => chat.key, enabled: () => true, health: () => ({}),
    foldText: (text, operationId) => router.foldToolText(text, operationId) });
  const input = (id: string, extra: Partial<NormalizedInbound> = {}) => store.acceptInbound(id, {
    id, text: kind === "group" ? "Robob hello" : "hello", source: "typed", sender: "+15555550123", receivedAt: Date.now(),
    attachments: [], isAudioMessage: false, ...extra,
  } satisfies NormalizedInbound);
  const h = {
    fake, store, backend, router, api,
    input,
    async start(extra: Partial<NormalizedInbound> = {}, id = "typed-1") {
      input(id, extra);
      await router.tick();
    },
    async finish(texts: readonly string[] = ["Reply"]) { backend.finish(texts); await router.tick(); },
    sends: () => store.pendingOutbox().filter(row => row.kind === "conversation"),
    send(text: string, dedupeKey = "send-1") {
      return api(new Request("http://local/send", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, dedupeKey, sessionId: "ses_1" }) }));
    },
  };
  harnesses.push(h);
  return h;
}
afterEach(() => { for (const h of harnesses.splice(0).reverse()) { h.store.close(); h.fake.close(); } });

test("final replies append to the last queued text, and another poll never folds again", async () => {
  const h = setup(); await h.start(); await h.finish(["First", "Last"]);
  expect(h.sends().map(row => row.text)).toEqual(["First", `Last\n\n${LINE}`]);
  expect(h.fake.calls()).toBe(1);
  await h.router.tick(); expect(h.fake.calls()).toBe(1);
});

test.each([
  ["empty", ""], ["exit", "process.exit(1)"], ["junk", "console.log('private junk')"],
] as const)("final reply fails open for %s", async (_name, body) => {
  const h = setup({ body }); await h.start(); await h.finish();
  expect(h.sends().map(row => row.text)).toEqual(["Reply"]);
  expect(h.fake.calls()).toBe(1);
});

test("slow final hook sends unchanged within 2.5 seconds", async () => {
  const h = setup({ body: `await Bun.sleep(5000); console.log(${JSON.stringify(LINE)})` }); await h.start();
  const start = performance.now(); await h.finish();
  expect(performance.now() - start).toBeLessThan(2500);
  expect(h.sends().map(row => row.text)).toEqual(["Reply"]);
});

test.each([
  { kind: "dm" as const, slug: "moni" }, { kind: "group" as const, slug: "group-test" },
  { kind: "dm" as const, slug: "guest" }, { kind: "owner" as const, slug: "moni" }, { disabled: true },
])("skips chat/disabled %j in both reply modes", async opts => {
  for (const tool of [false, true]) {
    const h = setup({ ...opts, tool }); await h.start();
    if (tool) expect((await h.send("Reply")).status).toBe(202); else await h.finish();
    expect(h.fake.calls()).toBe(0);
  }
});

test.each(["background", "watcher", "request", "composed", "missing_source", "voice", "poll", "tapback", "empty_input", "no_turn"])(
  "skips %s owner turns in both reply modes", async mode => {
    for (const tool of [false, true]) {
      const h = setup({ tool }); await h.start();
      const turn = h.store.get<Record<string, unknown>>("activeTurn")!;
      if (mode === "background") h.store.set("activeTurn", { ...turn, background: true });
      if (mode === "watcher") h.store.set("activeTurn", { ...turn, inboundId: "wake:test" });
      if (mode === "request") h.store.set("activeTurn", { ...turn, origin: "request" });
      if (["composed", "missing_source", "voice", "empty_input"].includes(mode)) {
        const input = { id: "typed-1", text: mode === "empty_input" ? "" : "hello", source: mode === "missing_source" ? undefined : mode === "composed" ? "composed" : "typed",
          attachments: [], isAudioMessage: mode === "voice" };
        h.store.db.query("UPDATE inbound SET payload = ? WHERE id = ?").run(JSON.stringify(input), "typed-1");
      }
      if (mode === "poll" || mode === "tapback") {
        const input: NormalizedInbound = { id: "typed-1", source: "typed", text: mode === "tapback" ? 'Loved “hello”' : "hello", attachments: [], isAudioMessage: false,
          ...(mode === "poll" ? { poll: { guid: "poll", optionIdentifier: "a", optionText: "A", vote: "voted", operationId: "request:test" } as const } : {}) };
        h.store.db.query("UPDATE inbound SET payload = ? WHERE id = ?").run(JSON.stringify(input), "typed-1");
      }
      if (mode === "no_turn") h.store.set("activeTurn", null);
      if (tool) await h.send("Reply"); else await h.finish();
      expect(h.fake.calls()).toBe(0);
    }
  });

test.each([{ texts: [] }, { texts: ["NO_REPLY"] }])("no text %j never invokes the hook", async ({ texts }) => {
  const h = setup(); await h.start(); await h.finish(texts);
  expect(h.fake.calls()).toBe(0); expect(h.sends()).toHaveLength(0);
});

test("tool mode folds first send only and accepted/conflicting retries never run it again", async () => {
  const h = setup({ tool: true }); await h.start();
  expect((await h.send("First")).status).toBe(202);
  expect((await h.send("First")).status).toBe(200);
  expect((await h.send("Changed")).status).toBe(409);
  expect((await h.send("Second", "send-2")).status).toBe(202);
  expect(h.sends().map(row => row.text)).toEqual([`First\n\n${LINE}`, "Second"]);
  expect(h.fake.calls()).toBe(1);
  await h.finish(); expect(h.fake.calls()).toBe(1);
  await h.start({}, "typed-2"); await h.send("New turn", "send-3"); expect(h.fake.calls()).toBe(2);
});

test("concurrent duplicate tool sends share the fold and store one augmented row", async () => {
  const h = setup({ tool: true }); await h.start();
  const responses = await Promise.all([h.send("First"), h.send("First")]);
  expect(responses.map(r => r.status).sort()).toEqual([200, 202]);
  expect(h.sends().map(row => row.text)).toEqual([`First\n\n${LINE}`]); expect(h.fake.calls()).toBe(1);
});

test("file-only, notices, invalid and cancelled sends never invoke the hook", async () => {
  const h = setup({ tool: true }); await h.start();
  const file = await h.api(new Request("http://local/files", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ base64: Buffer.from("test").toString("base64"), name: "test.txt", mimeType: "text/plain", text: "", dedupeKey: "file", sessionId: "ses_1" }) }));
  expect(file.status).toBe(202);
  h.store.enqueue({ id: "notice", kind: "control", text: "Bridge notice" });
  expect((await h.send("NO_REPLY")).status).toBe(202);
  const stale = await h.api(new Request("http://local/send", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "Reply", dedupeKey: "stale", sessionId: "old" }) }));
  expect(stale.status).toBe(409);
  await h.api(new Request("http://local/cancel-send", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ dedupeKey: "cancelled", sessionId: "ses_1" }) }));
  expect((await h.send("Reply", "cancelled")).status).toBe(409); expect(h.fake.calls()).toBe(0);
});

test("delivery retry and recovery reuse folded outbox text without invoking the hook", async () => {
  const h = setup({ tool: true }); await h.start(); await h.send("Reply");
  const row = h.sends()[0]!;
  const delivered: string[] = [];
  const transport = { async sendText(input: Parameters<Photon["sendText"]>[0]) {
    delivered.push(input.text);
    if (delivered.length === 1) throw new TransportError("tokenNetwork", true);
    return { providerId: "test-delivered" };
  } };
  const options = { projectScope: "fold-test", enabled: () => true, chatGuid: () => "dm:+15555550123", sleep: async () => {} };
  await new Delivery(h.store, transport, options).tick();
  h.store.outboxState(row.id, "uncertain");
  h.store.set(`retry:${row.id}`, 0);
  const recovered = new Delivery(h.store, transport, options); recovered.recover(); await recovered.tick();
  expect(h.store.getOperation(row.id)?.state).toBe("sent");
  expect(delivered).toHaveLength(2);
  expect(delivered.every(text => (text.match(/💊/g) ?? []).length === 1)).toBe(true);
  expect(h.fake.calls()).toBe(1);
});

test.each([
  { name: "typed", source: "typed" as const, audio: false, fold: true },
  { name: "voice", source: "composed" as const, audio: true, fold: false },
  { name: "composed", source: "composed" as const, audio: false, fold: false },
  { name: "unknown", source: undefined, audio: false, fold: false },
])("sealed batch metadata: typed then $name", async row => {
  for (const tool of [false, true]) {
    const h = setup({ tool }); h.input("first"); h.input("second", { text: "second input", source: row.source, isAudioMessage: row.audio });
    await h.router.tick();
    expect(h.store.get<NormalizedInbound>("batch:first")?.batchIds).toEqual(["first", "second"]);
    if (tool) await h.send("Reply"); else await h.finish();
    expect(h.fake.calls()).toBe(row.fold ? 1 : 0);
  }
});

test.each(["closed", "background", "replaced", "generation"])("concurrent sends while hook pending and turn %s", async change => {
  const h = setup({ tool: true, body: HOLD_FOLD }); await h.start();
  const started = h.fake.started();
  const responses = Promise.all([h.send("Reply"), h.send("Reply")]);
  await started;
  const turn = h.store.get<Record<string, unknown>>("activeTurn")!;
  if (change === "closed") h.store.set("activeTurn", null);
  if (change === "background") h.store.set("activeTurn", { ...turn, background: true });
  if (change === "replaced") h.store.set("activeTurn", { ...turn, messageId: "replacement", startedAt: Number(turn.startedAt) + 1 });
  if (change === "generation") h.store.set("route", { ...h.store.get<Record<string, unknown>>("route"), generation: 2 });
  h.fake.release();
  expect((await responses).map(r => r.status).sort()).toEqual(change === "generation" ? [409, 409] : [200, 202]);
  expect(h.sends().map(row => row.text)).toEqual(change === "generation" ? [] : ["Reply"]);
  expect(h.fake.calls()).toBe(1);
});

test("environment switch disables folds", async () => {
  const previous = process.env.SPECTRUM_MEDS_FOLD_ENABLED;
  try {
    process.env.SPECTRUM_MEDS_FOLD_ENABLED = "0";
    const h = setup(); await h.start(); await h.finish();
    expect(h.sends().map(row => row.text)).toEqual(["Reply"]); expect(h.fake.calls()).toBe(0);
  } finally {
    if (previous === undefined) delete process.env.SPECTRUM_MEDS_FOLD_ENABLED;
    else process.env.SPECTRUM_MEDS_FOLD_ENABLED = previous;
  }
});

test("an interrupted complete reply folds before enqueue", async () => {
  const h = setup(); await h.start(); h.backend.finish(["Recovered"]);
  const idle = h.backend.records.at(-1)!;
  if (idle.type === "idle") idle.outcome = "interrupted";
  await h.router.tick();
  expect(h.sends().map(row => row.text)).toEqual([`Recovered\n\n${LINE}`]); expect(h.fake.calls()).toBe(1);
});

test("failure-preserved successful replies fold, and the failure notice does not", async () => {
  const h = setup(); await h.start(); h.backend.finish(["Earlier"]); h.backend.finish(["Failed partial"]);
  const idle = h.backend.records.at(-1)!;
  if (idle.type === "idle") idle.outcome = "failed";
  await h.router.tick();
  expect(h.sends().map(row => row.text)).toEqual([`Earlier\n\n${LINE}`]); expect(h.fake.calls()).toBe(1);
  expect(h.store.pendingOutbox().filter(row => row.kind === "control").every(row => !row.text.includes("💊"))).toBe(true);
});

test("early acknowledgement stays unchanged and the eventual final text carries the fold", async () => {
  const h = setup(); await h.start(); h.backend.finish(["Acknowledged"]); h.backend.records.pop();
  const early = h.backend.records.at(-1)!;
  if (early.type === "assistant") { early.finish = "tool-calls"; early.continued = true; }
  await h.router.tick();
  expect(h.sends().map(row => row.text)).toEqual(["Acknowledged"]); expect(h.fake.calls()).toBe(0);
  await h.finish(["Final reply"]);
  expect(h.sends().map(row => row.text)).toEqual(["Acknowledged", `Final reply\n\n${LINE}`]); expect(h.fake.calls()).toBe(1);
});
