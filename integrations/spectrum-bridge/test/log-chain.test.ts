import { afterEach, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Delivery } from "../src/delivery.ts";
import { chatKey, type Line, type LineInbound } from "../src/line.ts";
import { OpenChamber, type MessageRecord } from "../src/openchamber.ts";
import { Router } from "../src/router.ts";
import { ChatRegistry } from "../src/runtime.ts";
import { runIngress } from "../src/sb-ingress.ts";
import { toolLog } from "../src/toollog.ts";
import { Store } from "../src/store.ts";
import { captureLogs } from "./log-fixture.ts";

const at = Date.parse("2026-11-13T12:00:00Z");
const owner = "+15555550123";
const moni = "+15555550199";
const stores: Store[] = [];
const dirs: string[] = [];
afterEach(() => {
  setSystemTime();
  stores.splice(0).forEach(store => store.close());
  dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true }));
});

class Backend extends OpenChamber {
  records: MessageRecord[] = [];
  constructor() { super("http://127.0.0.1:1"); }
  override async request<T>(): Promise<T | undefined> { throw new Error("Unexpected backend call"); }
  override async createChat() { return { id: "ses_fixture", directory: "/Chats/fixture" }; }
  override async isSessionAutoAccepting() { return false; }
  override async permissions() { return []; }
  override async questions() { return []; }
  override async children() { return []; }
  override async statuses() { return {}; }
  override async getSession(id: string, directory: string) { return { id, directory, title: "Chat", time: { created: at, updated: at } }; }
  override async messages() { return this.records; }
  override async promptAccepted(_id: string, _dir: string, id: string) { return this.records.some(r => r.id === id); }
  override async prompt(_id: string, _dir: string, id: string, text: string) {
    this.records.push({ id, text, type: "user", time: { created: Date.now() } });
  }
}

function setup(slug: "owner" | "moni" = "owner") {
  setSystemTime(at);
  const stateRoot = mkdtempSync(join(tmpdir(), "log-chain-")); dirs.push(stateRoot);
  const store = new Store(":memory:"); stores.push(store);
  const backend = new Backend();
  const line: Line = {
    number: "+15555550999", events: async function* () {}, backfill: async () => [], outbound: async () => [],
    sendText: async () => ({ handle: "sent-fixture" }), sendApp: async () => ({ handle: "app-fixture" }),
    upload: async () => "https://cdn.example/file", getMessage: async () => undefined,
    react: async () => {}, typing: async () => {}, read: async () => {}, requestLocation: async () => {},
    setOptOut: async () => {},
    location: async () => undefined, download: async () => ({ data: new Uint8Array(), name: "file", mimeType: "text/plain" }),
  };
  const access = { people: [{ name: "Moni", role: "admin" as const, addresses: [moni] }], groups: [] };
  const registry = new ChatRegistry({ line, owner, ownerStore: store, stateRoot, access: () => access,
    build: chat => {
      if (chat.store !== store) stores.push(chat.store);
      return { router: new Router(chat.store, backend, {
        typing: async () => {}, read: async () => {}, downloadAttachment: async () => { throw new Error("Unexpected attachment"); },
      }, { owner, chatGuid: chat.info.key, timezone: "Asia/Dubai", skillPath: "/test/SKILL.md",
        alertSkillPath: "/test/alert/SKILL.md", alertSocketPath: "/test/alert.sock", openCodeConfigRoot: "/nonexistent", quietMs: 0, medsFold: false,
        context: chat.context }),
      delivery: new Delivery(chat.store, { sendText: async () => ({ providerId: "sent-fixture" }) }, {
        projectScope: "fixture", chat: chat.info.slug, chatGuid: () => chat.info.key, enabled: () => true, sleep: async () => {},
      }) };
    },
  });
  registry.restore();
  const chat = slug === "owner" ? registry.owner : registry.open(chatKey.dm(moni));
  const message = (handle: string): LineInbound => ({ handle, chat: chat.info.key, from: slug === "owner" ? owner : moni,
    text: "PRIVATE_MESSAGE", kind: "message", service: "iMessage", participants: [], sentAt: at });
  return { backend, line, chat, message, deps: { line, owner, ownerStore: store, access: async () => access,
    sink: registry.sink(async () => {}), now: () => Date.now() } };
}

const batchForms = [
  { name: "single typed", texts: ["PRIVATE_MESSAGE"] },
  { name: "typed then typed", texts: ["PRIVATE_FIRST", "PRIVATE_LAST"] },
  { name: "tapback then typed", texts: ['Loved “PRIVATE_FIRST”', "PRIVATE_LAST"] },
  { name: "typed then tapback", texts: ["PRIVATE_FIRST", 'Loved “PRIVATE_LAST”'] },
  { name: "tapback then tapback", texts: ['Loved “PRIVATE_FIRST”', 'Liked “PRIVATE_LAST”'] },
];
test.each(["owner", "moni"].flatMap(slug => batchForms.map(form => ({ slug: slug as "owner" | "moni", ...form }))))(
  "$slug $name: inbound, turn and delivered reply share the causal inbound id", async ({ slug, texts }) => {
  const h = setup(slug);
  h.line.events = async function* () {
    for (const [index, text] of texts.entries()) yield { type: "message", id: `event-${index}`, message: {
      ...h.message(index === 0 ? "inbound-fixture" : "member-fixture"), text,
    } };
  };
  const logs = await captureLogs(async () => {
    const stop = new AbortController();
    const events = h.line.events;
    h.line.events = async function* (signal) { yield* events(signal); stop.abort(); };
    await runIngress(h.deps, stop.signal);
    setSystemTime(at + 1000);
    await h.chat.parts.router.tick();
    h.backend.records.push({ id: "answer-fixture", type: "assistant", content: [{ type: "text", text: "PRIVATE_REPLY" }], finish: "stop", time: { created: at + 1000, completed: at + 2000 } },
      { id: "idle-fixture", type: "idle", outcome: "succeeded", time: { created: at + 2000 } });
    setSystemTime(at + 2000);
    await h.chat.parts.router.tick();
    await h.chat.parts.delivery.tick();
    const rollup = await toolLog.rollup("2026-11-13");
    expect(rollup?.chains[slug]).toMatchObject({ received: texts.length, turnStarted: 1, replySent: 1, completed: 1,
      receivedToStartMs: { p50: 1000, p95: 1000 }, receivedToReplyMs: { p50: 2000, p95: 2000 } });
  });
  expect(logs.find(l => l.name === "msg.received")?.ids).toMatchObject({ chat: slug, messageId: "inbound-fixture", inboundId: "inbound-fixture" });
  for (const name of ["turn.start", "turn.end", "reply.sent"]) {
    expect(logs.find(l => l.name === name)?.ids).toMatchObject({ chat: slug, inboundId: "inbound-fixture" });
  }
  expect(logs.find(l => l.name === "turn.start")?.props?.batchSize).toBe(texts.length);
  expect(logs.find(l => l.name === "msg.batched")).toMatchObject({ ids: { inboundId: "inbound-fixture" }, props: { route: "new_turn", leaderKind: "human" } });
  expect(JSON.stringify(logs)).not.toContain("PRIVATE_");
});

test.each(["full", "id-only", "backfill"])("%s ingress logs the actual notification source", async mode => {
  const h = setup();
  const stop = new AbortController();
  let polls = 0;
  h.line.backfill = async () => {
    if (mode === "backfill" || ++polls > 1) return [h.message("notified-fixture"), h.message("unrelated-fixture")];
    return [];
  };
  h.line.events = async function* () {
    if (mode !== "backfill") yield { type: "message", id: "event-fixture", message: {
      ...h.message("notified-fixture"), ...(mode === "id-only" ? { from: "" } : {}),
    } };
    stop.abort();
  };
  const logs = await captureLogs(() => runIngress(h.deps, stop.signal));
  const received = logs.filter(l => l.name === "msg.received");
  expect(received.find(l => l.ids?.messageId === "notified-fixture")?.props?.source).toBe(mode === "backfill" ? "backfill" : "live");
  if (mode !== "full") expect(received.find(l => l.ids?.messageId === "unrelated-fixture")?.props?.source).toBe("backfill");
});
