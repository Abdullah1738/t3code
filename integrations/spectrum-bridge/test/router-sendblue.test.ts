import { afterEach, expect, setSystemTime, test } from "bun:test";
import type { ChatContext, ChatInfo, Role } from "../src/chats.ts";
import { TransportError, type NormalizedInbound, type Photon } from "../src/photon.ts";
import { Router, sendblueContextPrompt } from "../src/router.ts";
import { Store } from "../src/store.ts";
import { OpenChamber, type MessageRecord, type PermissionRequest, type QuestionRequest, type SessionRecord } from "../src/openchamber.ts";

// Sendblue mode: the router gets a ChatContext and the chat key as its chat guid.
// The backend is a minimal recorder; the Photon-mode suite covers the rest of the router.
const DM_KEY = "dm:+971585933213";
const GROUP_KEY = "group:abc123def456";

type Prompt = { id: string; text: string; system?: string };

class Recorder extends OpenChamber {
  prompts: Prompt[] = [];
  records: MessageRecord[] = [];
  constructor() { super("http://127.0.0.1:1"); }
  override async request<T>(): Promise<T | undefined> { throw new Error("Unexpected backend access"); }
  override async promptAccepted(_id: string, _directory: string, messageId: string) {
    return this.records.some(m => m.id === messageId && m.type === "user");
  }
  override async createChat(): Promise<SessionRecord> { return { id: "ses_1", directory: "/Chats/ses_1" } as SessionRecord; }
  override async isSessionAutoAccepting() { return false; }
  override async permissions(): Promise<PermissionRequest[]> { return []; }
  override async questions(): Promise<QuestionRequest[]> { return []; }
  override async prompt(id: string, _directory: string, messageId: string, text: string, system?: string) {
    this.prompts.push({ id, text, system });
    this.records.push({ id: messageId, type: "user", content: [{ type: "text", text }] } as unknown as MessageRecord);
  }
}

const roles: Record<string, { name: string; role: Role }> = {
  "+971585933213": { name: "Moni", role: "admin" },
  "+447700900123": { name: "Tom", role: "guest" },
};

function context(kind: ChatInfo["kind"], over: Partial<ChatContext> = {}) {
  const chat: ChatInfo = kind === "group"
    ? { key: GROUP_KEY, slug: "group-friends-abc123", kind: "group", title: "Friends" }
    : kind === "owner"
      ? { key: "dm:+15555550123", slug: "owner", kind: "owner", title: "Abdullah" }
      : { key: DM_KEY, slug: "moni", kind: "dm", title: "Moni" };
  const reacted: [string, string][] = [];
  const ctx: ChatContext & { reacted: [string, string][]; typingState: { value: boolean } } = {
    chat,
    roleOf: address => roles[address] ?? { name: address, role: "guest" },
    typing: () => typingState.value,
    react: async (handle, reaction) => { reacted.push([handle, reaction]); },
    reacted,
    typingState: { value: false },
    ...over,
  };
  const typingState = ctx.typingState;
  return ctx;
}

function setup(ctx: ReturnType<typeof context>, overrides: { quietMs?: number; getMessage?: (guid: string) => Promise<unknown> } = {}) {
  const store = new Store(":memory:");
  stores.push(store);
  const backend = new Recorder();
  const transport = {
    async typing() {},
    async read() {},
    async downloadAttachment() { return { data: new Uint8Array(), mimeType: "image/png", name: "x.png" }; },
    getMessage: overrides.getMessage as Photon["getMessage"],
  } as Pick<Photon, "typing" | "read" | "downloadAttachment"> & Partial<Pick<Photon, "getMessage">>;
  const router = new Router(store, backend, transport, {
    owner: "+15555550123", timezone: "Asia/Dubai", chatGuid: ctx.chat.key,
    skillPath: "/private/test/notification-skill/SKILL.md", alertSkillPath: "/private/test/telegram-skill/SKILL.md",
    alertSocketPath: "/private/test/telegram.sock", openCodeConfigRoot: "/nonexistent/opencode-config",
    context: ctx, ...overrides,
  });
  const input = (id: string, text: string, sender: string, extra: Partial<NormalizedInbound> = {}) =>
    store.acceptInbound(id, { id, text, sender, attachments: [], isAudioMessage: false, receivedAt: Date.now(), ...extra } satisfies NormalizedInbound);
  return { store, backend, router, input };
}

const stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.db.close(); });

test("sendblue debounce waits 2 s of quiet after the latest member, not 15 s", async () => {
  const start = Date.parse("2026-10-21T10:00:00Z");
  setSystemTime(start);
  const h = setup(context("dm"));
  h.input("a", "hello", DM_KEY);
  await h.router.tick();
  expect(h.backend.prompts).toHaveLength(0);
  setSystemTime(start + 1_900);
  await h.router.tick();
  expect(h.backend.prompts).toHaveLength(0);
  setSystemTime(start + 2_100);
  await h.router.tick();
  expect(h.backend.prompts).toHaveLength(1);
  setSystemTime(start);
});

test("a typing sender extends the debounce, but never past 90 s from the oldest member", async () => {
  const start = Date.parse("2026-10-21T11:00:00Z");
  setSystemTime(start);
  const ctx = context("dm");
  ctx.typingState.value = true;
  const h = setup(ctx);
  h.input("a", "one", DM_KEY, { receivedAt: start });
  setSystemTime(start + 5_000);
  await h.router.tick();
  expect(h.backend.prompts).toHaveLength(0);
  setSystemTime(start + 89_000);
  await h.router.tick();
  expect(h.backend.prompts).toHaveLength(0);
  setSystemTime(start + 91_000);
  await h.router.tick();
  expect(h.backend.prompts).toHaveLength(1);
  setSystemTime(start);
});

test("group batches name each sender, and guests carry their address", async () => {
  const start = Date.parse("2026-10-21T12:00:00Z");
  setSystemTime(start);
  const h = setup(context("group"), { quietMs: 0 });
  h.input("m1", "robob book a table", "+971585933213");
  h.input("g1", "and me too robob", "+447700900123");
  await h.router.tick();
  expect(h.backend.prompts).toHaveLength(1);
  expect(h.backend.prompts[0]!.text).toContain("Moni: robob book a table");
  expect(h.backend.prompts[0]!.text).toContain("Tom (+447700900123): and me too robob");
  setSystemTime(start);
});

test("the owner's own chat keeps its text unprefixed", async () => {
  const start = Date.parse("2026-10-21T13:00:00Z");
  setSystemTime(start);
  const h = setup(context("owner"), { quietMs: 0 });
  h.input("o1", "what's on today", "+15555550123");
  await h.router.tick();
  expect(h.backend.prompts[0]!.text).toBe("what's on today");
  setSystemTime(start);
});

test("the admin role prompt says Moni acts like the owner; guests need ask-owner", () => {
  const admin = sendblueContextPrompt(context("dm"), false, ["+971585933213"]);
  expect(admin).toContain("Moni (admin)");
  expect(admin).toContain("moni-prefs.md");
  expect(admin).toContain("offbox-person");
  const guest = sendblueContextPrompt(context("group"), false, ["+447700900123"]);
  expect(guest).toContain("Tom (guest)");
  expect(guest).toContain("ask-owner");
  expect(guest).toContain("silent observer");
  expect(guest).toContain("send no tapback");
  expect(guest).not.toContain("A tapback (`react --kind like` or an emoji) plus NO_REPLY is a complete answer");
  expect(guest).toContain("NO_REPLY");
  expect(guest).not.toContain("send --to");
  const owner = sendblueContextPrompt(context("owner"), false, []);
  expect(owner).toContain("send --to <slug>");
  expect(owner).not.toContain("ask-owner");
});

test("every chat's prompt says which link kind to create and to fill preview metadata", () => {
  for (const kind of ["owner", "dm", "group"] as const) {
    const prompt = sendblueContextPrompt(context(kind), false, []);
    expect(prompt).toContain("owner's own chat use `publish --app SLUG`");
    expect(prompt).toContain("any group or anyone else use `share --app SLUG");
    expect(prompt).toContain("og:title, og:description and og:image");
  }
});

test("👀 is sent once for a non-owner batch and never in the owner chat", async () => {
  const start = Date.parse("2026-10-21T14:00:00Z");
  setSystemTime(start);
  const moni = context("dm");
  const h = setup(moni, { quietMs: 0 });
  h.input("m1", "can you check my ride", DM_KEY);
  await h.router.tick();
  expect(moni.reacted).toEqual([["m1", "👀"]]);
  expect(h.backend.prompts[0]!.system).toContain("The 👀 reaction to this message is already sent");
  setSystemTime(start);

  const owner = context("owner");
  const ho = setup(owner, { quietMs: 0 });
  ho.input("o1", "hi", "+15555550123");
  await ho.router.tick();
  expect(owner.reacted).toEqual([]);
  expect(ho.backend.prompts[0]!.system).not.toContain("already sent");
  setSystemTime(start);
});

test("the Photon prompt has no Sendblue sections", async () => {
  const start = Date.parse("2026-10-21T15:00:00Z");
  setSystemTime(start);
  const store = new Store(":memory:");
  stores.push(store);
  const backend = new Recorder();
  const transport: Pick<Photon, "typing" | "read" | "downloadAttachment"> = {
    async typing() {}, async read() {}, async downloadAttachment() { return { data: new Uint8Array(), mimeType: "image/png", name: "x.png" }; },
  };
  const router = new Router(store, backend, transport, {
    owner: "+15555550123", timezone: "Asia/Dubai", chatGuid: "iMessage;-;+15555550123",
    skillPath: "/private/test/notification-skill/SKILL.md", alertSkillPath: "/private/test/telegram-skill/SKILL.md",
    alertSocketPath: "/private/test/telegram.sock", openCodeConfigRoot: "/nonexistent/opencode-config", quietMs: 0,
  });
  store.acceptInbound("p1", { id: "p1", text: "hello", attachments: [], isAudioMessage: false, receivedAt: Date.now() } satisfies NormalizedInbound);
  await router.tick();
  const system = backend.prompts[0]!.system!;
  expect(system).not.toContain("Chat: ");
  expect(system).not.toContain("Senders in this batch");
  expect(system).not.toContain("already sent");
  expect(system).toContain("Bridge CLI:");
  setSystemTime(start);
});

test("reply target in Sendblue mode resolves only inside this chat", async () => {
  const start = Date.parse("2026-10-21T16:00:00Z");
  setSystemTime(start);
  const seen: string[] = [];
  const h = setup(context("dm"), {
    quietMs: 0,
    getMessage: async (guid: string) => {
      seen.push(guid);
      return { chatGuids: [DM_KEY], isFromMe: false, content: { text: "the earlier message" } };
    },
  });
  h.input("r1", "that one", "+971585933213", { replyTo: "foreign-guid" });
  await h.router.tick();
  expect(seen).toEqual(["foreign-guid"]);
  expect(h.backend.prompts[0]!.text).toContain("the earlier message");
  setSystemTime(start);
});

// Polls like OpenCode 2: the prompt lands as a user record and `final` closes the turn.
class Polling extends Recorder {
  override async prompt(id: string, _directory: string, messageId: string, text: string, system?: string) {
    this.prompts.push({ id, text, system });
    this.records.push({ id: messageId, type: "user", text, time: { created: Date.now() } } as MessageRecord);
  }
  override async messages() { return this.records; }
  override async statuses() { return {}; }
  override async getSession(id: string, directory: string) { return { id, directory, title: "Chat", time: { created: 0, updated: 0 } } as SessionRecord; }
  override async children() { return []; }
  final(text = "Done") {
    this.records.push({ id: `msg_a_${this.records.length}`, type: "assistant", agent: "build", model: { providerID: "test", id: "model" },
      content: [{ type: "text", text }], finish: "stop", time: { created: Date.now(), completed: Date.now() } } as MessageRecord);
    this.records.push({ id: `msg_idle_${this.records.length}`, type: "idle", outcome: "succeeded", time: { created: Date.now() } } as MessageRecord);
  }
}

function live(ctx: ReturnType<typeof context>, typing?: (active: boolean) => Promise<void>) {
  const store = new Store(":memory:");
  stores.push(store);
  const backend = new Polling();
  const hints: string[] = [];
  const logs: [string, string | undefined][] = [];
  const transport = {
    async typing(_chat: string, active: boolean) { hints.push(active ? "start" : "stop"); await typing?.(active); },
    async read() { hints.push("read"); },
    async downloadAttachment() { return { data: new Uint8Array(), mimeType: "image/png", name: "x.png" }; },
  } as Pick<Photon, "typing" | "read" | "downloadAttachment">;
  const react = ctx.react;
  ctx.react = async (handle, reaction) => { hints.push(`react:${reaction}`); await react(handle, reaction); };
  const originalPrompt = backend.prompt.bind(backend);
  backend.prompt = async (...args) => { hints.push("prompt"); await originalPrompt(...args); };
  const router = new Router(store, backend, transport, {
    owner: "+15555550123", timezone: "Asia/Dubai", chatGuid: ctx.chat.key,
    skillPath: "/private/test/notification-skill/SKILL.md", alertSkillPath: "/private/test/telegram-skill/SKILL.md",
    alertSocketPath: "/private/test/telegram.sock", openCodeConfigRoot: "/nonexistent/opencode-config",
    context: ctx, quietMs: 0, log: (event, code) => { logs.push([event, code]); },
  });
  const input = (id: string, text: string, sender: string) =>
    store.acceptInbound(id, { id, text, sender, attachments: [], isAudioMessage: false, receivedAt: Date.now() } satisfies NormalizedInbound);
  return { store, backend, router, input, hints, logs };
}

test("typing starts when a batch is taken, before the prompt, refreshes every 20 s and stops when the turn ends", async () => {
  const start = Date.parse("2026-10-21T12:00:00Z");
  setSystemTime(start);
  const h = live(context("owner"));
  h.input("a", "where am I", "dm:+15555550123");
  await h.router.tick();
  // Marked read once, then typing, all before the prompt goes to the agent.
  expect(h.hints).toEqual(["read", "start", "prompt"]);
  for (let i = 0; i < 3; i++) await h.router.tick();
  setSystemTime(start + 19_000);
  await h.router.tick();
  expect(h.hints).toEqual(["read", "start", "prompt"]);
  setSystemTime(start + 20_500);
  await h.router.tick();
  expect(h.hints).toEqual(["read", "start", "prompt", "start"]);
  h.backend.final();
  await h.router.tick();
  await h.router.tick();
  expect(h.hints).toEqual(["read", "start", "prompt", "start", "stop"]);
  expect(h.logs.filter(([event]) => event.startsWith("typing"))).toEqual([["typing-started", undefined], ["typing-stopped", undefined]]);
  setSystemTime(start);
});

test("a slow thread list never sits between a text and its prompt or a finished run and its reply", async () => {
  setSystemTime(Date.parse("2026-10-21T12:00:00Z"));
  const h = live(context("owner"));
  let lists = 0;
  let release!: (statuses: Record<string, never>) => void;
  const list = new Promise<Record<string, never>>(resolve => { release = resolve; });
  Object.assign(h.backend, {
    statuses: () => { lists++; return list; },
    sessionBusy: async () => h.backend.records.length > 0 && h.backend.records.at(-1)!.type !== "idle",
  });
  h.input("a", "hi", "dm:+15555550123");
  await h.router.tick();
  expect(h.backend.prompts).toHaveLength(1);
  h.backend.final("Hello");
  await h.router.tick();
  expect(h.store.pendingOutbox().map(item => item.text)).toEqual(["Hello"]);
  // The second turn goes through the busy check on the existing conversation.
  h.input("b", "again", "dm:+15555550123");
  await h.router.tick();
  expect(h.backend.prompts).toHaveLength(2);
  expect(lists).toBe(1);
  expect(h.logs.filter(([event]) => !event.startsWith("typing"))).toEqual([
    ["batch-sealed", "owner a"], ["prompt-accepted", "owner a"], ["run-completed-seen", "owner a"], ["reply-enqueued", "owner a"],
    ["batch-sealed", "owner b"], ["prompt-accepted", "owner b"],
  ]);
  release({});
  await list;
});

test("the 👀 tapback clears the bubble, so typing is re-armed right after it", async () => {
  setSystemTime(Date.parse("2026-10-21T12:00:00Z"));
  const h = live(context("dm"));
  h.input("a", "can you book a car", DM_KEY);
  await h.router.tick();
  expect(h.hints).toEqual(["read", "start", "react:👀", "start", "prompt"]);
});

test("a follow-up from Moni mid-turn is steered with its own 👀, typing stays on, and one reply closes the turn", async () => {
  setSystemTime(Date.parse("2026-10-21T12:00:00Z"));
  const moni = context("dm");
  const h = live(moni);
  const steers: { messageId: string; text: string; guidance?: string }[] = [];
  Object.assign(h.backend, {
    async steer(_id: string, _directory: string, messageId: string, text: string, guidance?: string) {
      h.hints.push("steer");
      steers.push({ messageId, text, guidance });
      h.backend.records.push({ id: messageId, type: "user", text, time: { created: Date.now() } } as MessageRecord);
      return "steered";
    },
  });
  h.input("m1", "book a car", "+971585933213");
  await h.router.tick();
  h.input("m2", "to the mall", "+971585933213");
  await h.router.tick();
  expect(h.hints).toEqual(["read", "start", "react:👀", "start", "prompt", "read", "react:👀", "start", "steer"]);
  expect(moni.reacted).toEqual([["m1", "👀"], ["m2", "👀"]]);
  expect(steers).toEqual([{ messageId: expect.stringMatching(/^msg_/), text: "Moni: to the mall", guidance: expect.stringContaining("already sent") }]);
  expect(steers[0]!.guidance).toContain("[\"m2\"]");
  h.backend.final("Booked to the mall");
  await h.router.tick();
  expect(h.store.pendingOutbox().filter(op => op.kind === "conversation").map(op => [op.text, op.replyTo])).toEqual([["Booked to the mall", "m1"]]);
  expect(h.store.pendingInbound()).toEqual([]);
  expect(h.hints.at(-1)).toBe("stop");
});

test("groups and bridge wakes never show typing", async () => {
  setSystemTime(Date.parse("2026-10-21T12:00:00Z"));
  const g = live(context("group"));
  g.input("a", "hey robob, what's the plan", "+447700900123");
  await g.router.tick();
  await g.router.tick();
  expect(g.hints.filter(hint => hint === "start")).toEqual([]);
  const w = live(context("owner"));
  w.input("wake:abc", "[Watcher] the parcel arrived", "dm:+15555550123");
  await w.router.tick();
  await w.router.tick();
  expect(w.backend.prompts).toHaveLength(1);
  expect(w.hints.filter(hint => hint === "start" || hint === "read")).toEqual([]);
});

test("a failed typing call is logged with its code instead of vanishing", async () => {
  setSystemTime(Date.parse("2026-10-21T12:00:00Z"));
  const h = live(context("owner"), async () => { throw new TransportError("http_503:worker_unavailable", true, false); });
  h.input("a", "hi", "dm:+15555550123");
  await h.router.tick();
  expect(h.backend.prompts).toHaveLength(1);
  expect(h.logs).toContainEqual(["typing-start-failed", "http_503:worker_unavailable"]);
});

test("location guidance points at the Sendblue commands, never Find My, and only the owner gets --chat", () => {
  const owner = sendblueContextPrompt(context("owner"), false, []);
  const moni = sendblueContextPrompt(context("dm"), true, []);
  const group = sendblueContextPrompt(context("group"), true, []);
  expect(owner).toContain("location --session CURRENT_SESSION_ID` (add `--chat moni`");
  expect(owner).toContain("Never use Find My");
  expect(moni).toContain("location-request --session CURRENT_SESSION_ID --key UNIQUE_KEY`, say you've asked");
  expect(moni).not.toContain("--chat");
  expect(group).toContain("Location: not available in groups");
});

test("groups: a message nobody addressed to Robob never wakes him, gets no 👀, and rides along later as context", async () => {
  const start = Date.parse("2026-10-22T09:00:00Z");
  setSystemTime(start);
  const ctx = context("group");
  const h = setup(ctx, { quietMs: 0 });
  h.input("a", "Na middle is awful babe", "+971585933213");
  h.input("b", "Laughed at \u201cShe's in the group ya numpty\u201d", "+447700900123");
  h.input("c", "Thanks Robob!", "+447700900123");
  await h.router.tick();
  await h.router.tick();
  expect(h.backend.prompts).toHaveLength(0);
  expect(ctx.reacted).toEqual([]);
  expect(h.store.pendingInbound()).toEqual([]);
  h.input("d", "Robob can you check the weather in Duisburg tomorrow?", "+971585933213");
  await h.router.tick();
  expect(h.backend.prompts).toHaveLength(1);
  const prompt = h.backend.prompts[0]!.text;
  expect(prompt).toContain("not addressed to you. Context only");
  expect(prompt).toContain(JSON.stringify("Moni: Na middle is awful babe"));
  expect(prompt).toContain("Tom (+447700900123): Thanks Robob!");
  expect(prompt.endsWith("Moni: Robob can you check the weather in Duisburg tomorrow?")).toBe(true);
  expect(ctx.reacted).toEqual([["d", "👀"]]);
  expect(h.store.get<string[]>("group-observed")).toEqual([]);
  setSystemTime(start);
});

test("groups: a swipe reply to Robob's message wakes him; a reply to someone else does not", async () => {
  const start = Date.parse("2026-10-22T09:10:00Z");
  setSystemTime(start);
  const h = setup(context("group"), { quietMs: 0 });
  h.store.enqueue({ id: "reply:1:x", kind: "conversation", text: "Gate is B30", sessionId: "ses_0", generation: 1 });
  h.store.outboxState("reply:1:x", "sent", "robob-msg");
  h.input("a", "is that the final one?", "+447700900123", { replyTo: "someone-else" });
  await h.router.tick();
  expect(h.backend.prompts).toHaveLength(0);
  h.input("b", "is that the final one?", "+447700900123", { replyTo: "robob-msg" });
  await h.router.tick();
  expect(h.backend.prompts).toHaveLength(1);
  setSystemTime(start);
});

test("groups: the person Robob just asked something may answer unnamed; others stay observed", async () => {
  const start = Date.parse("2026-10-22T09:20:00Z");
  setSystemTime(start);
  const ctx = context("group");
  const h = setup(ctx, { quietMs: 0 });
  h.store.set("group-engaged:+971585933213", start - 60_000);
  h.store.set("group-engaged:+447700900123", start - 10 * 60_000);
  h.input("a", "also add a gem kit", "+971585933213");
  h.input("b", "lol nice", "+447700900123");
  await h.router.tick();
  expect(h.backend.prompts).toHaveLength(1);
  expect(h.backend.prompts[0]!.text).toContain("Moni: also add a gem kit");
  // Tom's line was not for Robob: it is quoted as context only, never as part of what woke him.
  expect(h.backend.prompts[0]!.text).toContain(JSON.stringify("Tom (+447700900123): lol nice"));
  expect(h.backend.prompts[0]!.text.endsWith("Moni: also add a gem kit")).toBe(true);
  // Woken only as a follow-up, so no 👀.
  expect(ctx.reacted).toEqual([]);
  setSystemTime(start);
});

test("groups: watcher wakes and owner relays are never gated", async () => {
  const start = Date.parse("2026-10-22T09:30:00Z");
  setSystemTime(start);
  const h = setup(context("group"), { quietMs: 0 });
  h.store.acceptInbound("wake:abc", { id: "wake:abc", text: "[Watcher event from flights] EK57 gate B30", attachments: [], isAudioMessage: false, receivedAt: start });
  await h.router.tick();
  expect(h.backend.prompts).toHaveLength(1);
  setSystemTime(start);
});

test("direct chats are never gated", async () => {
  const start = Date.parse("2026-10-22T09:40:00Z");
  setSystemTime(start);
  const ctx = context("dm");
  const h = setup(ctx, { quietMs: 0 });
  h.input("a", "lol ok", DM_KEY);
  await h.router.tick();
  expect(h.backend.prompts).toHaveLength(1);
  expect(h.backend.prompts[0]!.text).not.toContain("Context only");
  expect(ctx.reacted).toEqual([["a", "👀"]]);
  setSystemTime(start);
});
