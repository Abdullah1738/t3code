import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi } from "../src/api.ts";
import type { Access } from "../src/chats.ts";
import { chatKey, GROUP_APP_REFUSAL, type Line, type LineInbound } from "../src/line.ts";
import { ChatRegistry, createSbApi, type ChatCore } from "../src/runtime.ts";
import { handleInbound, runIngress, type IngressDeps } from "../src/sb-ingress.ts";
import { Shares } from "../src/share.ts";
import { Store } from "../src/store.ts";

const owner = "+15555550123";
const moni = "+15555550199";
let access: Access;
const dirs: string[] = [];
const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fakeLine(): Line & { reactions: [string, string][]; locationRequests: string[] } {
  const reactions: [string, string][] = [];
  const locationRequests: string[] = [];
  const line: Line = {
    number: "+19362300565",
    events: async function* () {},
    backfill: async () => [],
    outbound: async () => [],
    sendText: async () => ({ handle: "out-1" }),
    upload: async () => "https://cdn.example/file.jpg",
    getMessage: async () => undefined,
    sendApp: async () => ({ handle: "app-1" }),
    react: async (handle, reaction) => { reactions.push([handle, reaction]); },
    typing: async () => {},
    read: async () => {},
    requestLocation: async chat => { locationRequests.push(chat); },
    location: async () => undefined,
    download: async () => ({ data: new Uint8Array([1]), name: "a.jpg", mimeType: "image/jpeg" }),
  };
  return Object.assign(line, { reactions, locationRequests });
}

type Parts = { api: (request: Request) => Promise<Response>; forwarded: unknown[] };

function setup(realApi = false) {
  access = {
    people: [{ name: "Moni", role: "admin", addresses: [moni, "moni@example.com"] }],
    groups: [{ id: "GRP-Allowed-123", name: "Family Trip" }],
  };
  const stateRoot = mkdtempSync(join(tmpdir(), "sb-runtime-"));
  dirs.push(stateRoot);
  const ownerStore = new Store(join(stateRoot, "state.sqlite"));
  stores.push(ownerStore);
  const line = fakeLine();
  const built: ChatCore[] = [];
  const registry = (store = ownerStore) => {
    const made = new ChatRegistry<Parts>({
      line, owner, ownerStore: store, stateRoot, access: () => access,
      build: chat => {
        built.push(chat);
        if (chat.store !== store) stores.push(chat.store);
        // Stands in for the per-chat Photon-era API: echoes which chat received the request.
        const forwarded: unknown[] = [];
        if (realApi) return { forwarded, api: createApi({ store: chat.store, photon: { react: async () => {} },
          router: () => undefined, chatGuid: () => chat.info.key, enabled: () => true, health: () => ({}) }) };
        return { forwarded, api: async request => {
          forwarded.push(await request.json());
          return Response.json({ chat: chat.info.slug, path: new URL(request.url).pathname });
        } };
      },
    });
    made.restore();
    return made;
  };
  return { stateRoot, ownerStore, line, built, registry };
}

const message = (overrides: Partial<LineInbound>): LineInbound => ({
  handle: "h-1", chat: chatKey.dm(owner), from: owner, text: "hi", kind: "message", service: "iMessage",
  participants: [], sentAt: 1_000, ...overrides,
});

describe("recipient app cards", () => {
  const card = { url: "https://ride.example.com/", caption: "Your ride", subcaption: "Driver assigned",
    trailingCaption: "Lux", trailingSubcaption: "Mercedes", summary: "Open ride" };
  function api(enabled = true) {
    const env = setup(true);
    const chats = env.registry();
    const moniChat = chats.open(chatKey.dm(moni));
    chats.owner.store.set("route", { id: "ses_owner", generation: 1 });
    moniChat.store.set("route", { id: "ses_moni", generation: 2 });
    const handler = createSbApi({ registry: chats, line: env.line, accessPath: join(env.stateRoot, "access.json"),
      enabled: () => enabled, health: () => ({}) });
    const post = async (body: Record<string, unknown>, origin?: string) => {
      const response = await handler(new Request("http://bridge/app", {
        method: "POST", headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(body),
      }));
      return { status: response.status, body: await response.json() as { id: string; created: boolean } };
    };
    return { chats, moniChat, post };
  }

  test("the owner can queue a card in Moni's outbox without borrowing her session", async () => {
    const { chats, moniChat, post } = api();
    const body = { ...card, to: "moni", dedupeKey: "ride-1", sessionId: "ses_owner@1" };
    const first = await post(body);
    expect(first.status).toBe(202);
    expect(first.body).toEqual({ id: expect.stringMatching(/^app:[a-f0-9]{64}$/), created: true });
    expect(chats.owner.store.pendingOutbox()).toEqual([]);
    expect(moniChat.store.pendingOutbox()).toEqual([{ id: first.body.id, kind: "conversation", text: "", app: card, state: "pending", attempts: 0 }]);
    expect(await post({ ...body, sessionId: "ses_owner" })).toEqual({ status: 200, body: { id: first.body.id, created: false } });
    expect((await post({ ...body, caption: "Changed" })).status).toBe(409);
    expect((await post({ ...body, url: "https://ride.example.com/other" })).status).toBe(409);
    // A relay remains valid when the destination rotates or has no active agent.
    moniChat.store.set("route", null);
    expect((await post(body)).status).toBe(200);
    expect((await post({ ...body, dedupeKey: "ride-2" })).status).toBe(202);
    expect(moniChat.store.pendingOutbox()).toHaveLength(2);
    expect((await post({ ...body, to: "owner" })).status).toBe(202);
    expect(chats.owner.store.pendingOutbox()[0]!.id).not.toBe(first.body.id);
  });

  test("stage continuation identity and immutable preview survive both enqueue routes", async () => {
    const { chats, post } = api();
    const updateOf = `app:${"a".repeat(64)}`;
    const app = { ...card, updateOf, previewPage: card.url + "stages/preparing/" };
    for (const to of [undefined, "owner"]) {
      const response = await post({ ...app, ...(to ? { to } : {}), dedupeKey: `stage-${to}`, sessionId: "ses_owner@1" });
      expect(response.status).toBe(202);
      expect(chats.owner.store.getOperation(response.body.id)?.app).toEqual(app);
      expect(chats.owner.store.get<string>(`app-latest:${updateOf}`)).toBe(response.body.id);
      expect((await post({ ...app, to, dedupeKey: `stage-${to}`, sessionId: "ses_owner@1" })).status).toBe(200);
      expect((await post({ ...app, to, previewPage: "https://elsewhere.example/", dedupeKey: "invalid", sessionId: "ses_owner@1" })).status).toBe(400);
    }
  });

  test("app cards are refused for group chats, with --to and without it", async () => {
    const { chats, post } = api();
    const group = chats.open(chatKey.group("GRP-Allowed-123"), "Family Trip");
    group.store.set("route", { id: "ses_group", generation: 3 });
    const refused = await post({ ...card, to: group.info.slug, dedupeKey: "ride-1", sessionId: "ses_owner@1" });
    expect(refused.status).toBe(422);
    expect(refused.body).toEqual({ error: GROUP_APP_REFUSAL } as never);
    expect(group.store.pendingOutbox()).toEqual([]);
    const direct = await post({ ...card, dedupeKey: "ride-2", sessionId: "ses_group@3" });
    expect(direct.status).toBe(422);
    expect(group.store.pendingOutbox()).toEqual([]);
  });

  test("without --to cards still bind to the calling chat and its generation", async () => {
    const { chats, moniChat, post } = api();
    const body = { ...card, dedupeKey: "ride-1" };
    expect((await post({ ...body, sessionId: "ses_owner@1" })).status).toBe(202);
    expect((await post({ ...body, sessionId: "ses_moni@2" })).status).toBe(202);
    expect(chats.owner.store.pendingOutbox()[0]).toMatchObject({ app: card, sessionId: "ses_owner", generation: 1 });
    expect(moniChat.store.pendingOutbox()[0]).toMatchObject({ app: card, sessionId: "ses_moni", generation: 2 });
    expect((await post({ ...body, sessionId: "ses_owner@0" })).status).toBe(409);
  });

  test("recipient routing requires the current owner session, even for admin callers", async () => {
    const { chats, moniChat, post } = api();
    const body = { ...card, to: "moni", dedupeKey: "ride-1" };
    expect((await post({ ...body, sessionId: "ses_owner" }, "https://other.example.com")).status).toBe(403);
    expect((await post(body)).status).toBe(403);
    expect((await post({ ...body, sessionId: "ses_moni@2" })).status).toBe(403);
    const person = chats.open(chatKey.dm("+15555550188"));
    person.store.set("route", { id: "ses_person", generation: 1 });
    expect((await post({ ...body, sessionId: "ses_person" })).status).toBe(403);
    expect((await post({ ...body, sessionId: "ses_unknown" })).status).toBe(409);
    expect((await post({ ...body, sessionId: "ses_owner@0" })).status).toBe(409);
    expect((await post({ ...body, sessionId: "ses_owner", to: "missing" })).status).toBe(404);
    chats.owner.store.set("route", { id: "ses_owner", generation: 2 });
    expect((await post({ ...body, sessionId: "ses_owner@1" })).status).toBe(409);
    expect(moniChat.store.pendingOutbox()).toEqual([]);
  });

  test("recipient cards keep app validation and readiness checks", async () => {
    const { moniChat, post } = api();
    const body = { ...card, to: "moni", dedupeKey: "ride-1", sessionId: "ses_owner" };
    for (const patch of [{ url: "http://ride.example.com/" }, { url: "https://user:password@ride.example.com/" },
      { caption: "" }, { subcaption: "line\nbreak" }, { trailingCaption: 123 }, { summary: "x".repeat(501) },
      { dedupeKey: "" }, { to: null }, { to: "../moni" }, { generation: 1 }, { extra: true }]) {
      expect((await post({ ...body, ...patch })).status).toBe(400);
    }
    expect(moniChat.store.pendingOutbox()).toEqual([]);
    const disabled = api(false);
    expect((await disabled.post(body)).status).toBe(503);
    expect(disabled.moniChat.store.pendingOutbox()).toEqual([]);
  });
});

describe("chat registry", () => {
  test("the owner chat uses state.sqlite; other chats are created lazily under chats/<slug>", () => {
    const { registry, ownerStore, stateRoot } = setup();
    const chats = registry();
    expect(chats.all().map(chat => chat.info.slug)).toEqual(["owner"]);
    expect(chats.owner.store).toBe(ownerStore);
    expect(chats.owner.info).toMatchObject({ key: chatKey.dm(owner), kind: "owner" });
    expect(existsSync(join(stateRoot, "chats"))).toBe(false);

    const moniChat = chats.open(chatKey.dm(moni));
    expect(moniChat.info).toMatchObject({ slug: "moni", kind: "dm", title: "Moni" });
    expect(moniChat.stateRoot).toBe(join(stateRoot, "chats", "moni"));
    expect(existsSync(join(stateRoot, "chats", "moni", "state.sqlite"))).toBe(true);

    const group = chats.open(chatKey.group("GRP-Allowed-123"), "Family Trip");
    expect(group.info.slug).toBe("group-family-trip-grp-al");
    expect(group.info).toMatchObject({ kind: "group", title: "Family Trip" });
  });

  test("a person's second address joins their chat and slugs survive a restart", () => {
    const { registry, ownerStore, built } = setup();
    const first = registry();
    const phone = first.open(chatKey.dm(moni));
    expect(first.open(chatKey.dm("moni@example.com"))).toBe(phone);
    first.open(chatKey.dm("+447000000000"));
    const madeBefore = built.length;

    // A rename in access.json must not move an existing chat to a new folder.
    access.people[0]!.name = "Monika";
    const second = registry(ownerStore);
    expect(built.length - madeBefore).toBe(3);
    expect(second.all().map(chat => chat.info.slug).sort()).toEqual(["dm-447000000000", "moni", "owner"]);
    expect(second.get(chatKey.dm("moni@example.com"))!.info.slug).toBe("moni");
  });

  test("a different person whose name slugs the same gets a numbered slug", () => {
    const { registry } = setup();
    const chats = registry();
    const first = chats.open(chatKey.dm(moni));
    access.people.push({ name: "Moni!", role: "person", addresses: ["+447000000001"] });
    const other = chats.open(chatKey.dm("+447000000001"));
    expect(other).not.toBe(first);
    expect(other.info.slug).toBe("moni-2");
  });

  test("an allowed Sendblue message lands in its own chat's store and unknown senders only produce a note", async () => {
    const { registry, ownerStore, line } = setup();
    const chats = registry();
    const notes: string[] = [];
    const deps: IngressDeps = {
      line, owner, ownerStore, access: async () => access, now: () => 5_000,
      sink: chats.sink(async (_address, text) => { notes.push(text); }),
    };
    chats.open(chatKey.dm(moni)).typing.set(moni, 4_000);
    expect(await handleInbound(deps, message({ handle: "m-1", chat: chatKey.dm(moni), from: moni, text: "hey" }))).toBe(true);
    const moniChat = chats.get(chatKey.dm(moni))!;
    expect(moniChat.store.pendingInbound().map(row => row.id)).toEqual(["m-1"]);
    // receivedAt becomes the arrival time for batching; sentAt keeps when it was sent, for the group judge.
    expect(moniChat.store.pendingInbound()[0]!.payload).toMatchObject({ text: "hey", sender: moni, sentAt: 1_000 });
    expect((moniChat.store.pendingInbound()[0]!.payload as { receivedAt: number }).receivedAt).toBeGreaterThan(1_000);
    expect(moniChat.controlsPending).toBe(true);
    expect(moniChat.typing.size).toBe(0);
    expect(chats.owner.store.pendingInbound()).toEqual([]);

    expect(await handleInbound(deps, message({ handle: "m-1", chat: chatKey.dm(moni), from: moni, text: "hey" }))).toBe(false);
    expect(await handleInbound(deps, message({ handle: "o-1", text: "owner here" }))).toBe(true);
    expect(chats.owner.store.pendingInbound().map(row => row.id)).toEqual(["o-1"]);

    expect(await handleInbound(deps, message({ handle: "x-1", chat: chatKey.dm("+447000000009"), from: "+447000000009" }))).toBe(false);
    expect(chats.get(chatKey.dm("+447000000009"))).toBeUndefined();
    expect(notes).toHaveLength(1);
  });

  test("a typing-on with no typing-off stops holding the chat after 8 s", () => {
    const { line, ownerStore, stateRoot } = setup();
    let now = 0;
    const chats = new ChatRegistry<Parts>({
      line, owner, ownerStore, stateRoot, access: () => access, now: () => now,
      build: chat => {
        if (chat.store !== ownerStore) stores.push(chat.store);
        return { forwarded: [], api: async () => Response.json({}) };
      },
    });
    chats.restore();
    const chat = chats.open(chatKey.dm(moni));
    chat.typing.set(moni, 0);
    now = 7_000;
    expect(chat.context.typing()).toBe(true);
    now = 8_500;
    expect(chat.context.typing()).toBe(false);
  });

  test("an id-only stream event pulls the full message from the message list", async () => {
    const { registry, ownerStore, line } = setup();
    const chats = registry();
    const full = message({ handle: "h-live", text: "from the list" });
    let listed = 0;
    line.backfill = async () => { listed += 1; return listed === 1 ? [] : [full]; };
    const controller = new AbortController();
    line.events = async function* () {
      // Sendblue's live stream carries only the message id for a received message.
      yield { type: "message", id: "e1", message: { ...message({ handle: "h-live" }), from: "", text: "" } };
      controller.abort();
    };
    const deps: IngressDeps = { line, owner, ownerStore, access: async () => access, now: () => 5_000, sink: chats.sink(async () => {}) };
    await runIngress(deps, controller.signal);
    expect(chats.owner.store.pendingInbound().map(row => [row.id, (row.payload as { text: string }).text])).toEqual([["h-live", "from the list"]]);
  });

  test("a disabled bridge accepts nothing", async () => {
    const { registry, ownerStore, line } = setup();
    const chats = registry();
    const deps: IngressDeps = { line, owner, ownerStore, access: async () => access, sink: chats.sink(async () => {}, () => false) };
    expect(await handleInbound(deps, message({ handle: "m-1", chat: chatKey.dm(moni), from: moni }))).toBe(false);
    expect(chats.get(chatKey.dm(moni))).toBeUndefined();
  });
});

describe("Sendblue socket API", () => {
  function api(enabled = true) {
    const env = setup();
    const chats = env.registry();
    const moniChat = chats.open(chatKey.dm(moni));
    chats.owner.store.set("route", { id: "ses_owner", generation: 1 });
    moniChat.store.set("route", { id: "ses_moni", generation: 2 });
    moniChat.store.acceptInbound("m-1", { id: "m-1", text: "hi", attachments: [], isAudioMessage: false, receivedAt: 1 });
    const handler = createSbApi({
      registry: chats, line: env.line, accessPath: join(env.stateRoot, "access.json"), enabled: () => enabled,
      health: () => ({ transport: "sendblue", line: env.line.number, chats: chats.all().length }),
    });
    const post = async (path: string, body: Record<string, unknown>) => {
      const response = await handler(new Request(`http://bridge${path}`, { method: "POST", body: JSON.stringify(body) }));
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    };
    return { ...env, chats, moniChat, handler, post };
  }

  test("messages reads only the caller's chat or permitted cross-chat history", async () => {
    const { post, chats, moniChat } = api();
    chats.owner.store.acceptInbound("o-1", { text: "owner", receivedAt: 1 });
    expect(await post("/messages", { sessionId: "ses_owner" })).toMatchObject({ status: 200, body: { chat: "owner", messages: [{ id: "o-1", from: "Abdullah" }], more: false } });
    expect(await post("/messages", { sessionId: "ses_moni" })).toMatchObject({ status: 200, body: { chat: "moni", messages: [{ id: "m-1", from: "Someone" }] } });
    expect(await post("/messages", { sessionId: "ses_owner", chat: "moni", id: "m-1" })).toMatchObject({ status: 200, body: { chat: "moni", messages: [{ id: "m-1" }] } });
    expect(await post("/messages", { sessionId: "ses_moni", chat: "owner" })).toEqual({ status: 403, body: { error: "Only the owner's chat can do this" } });
    const family = chats.open(chatKey.group("GRP-Allowed-123"), "Family Trip");
    family.store.set("route", { id: "ses_group", generation: 1 });
    family.store.acceptInbound("g-1", { text: "group", sender: " MONI@example.com", receivedAt: 2 });
    expect((await post("/messages", { sessionId: "ses_moni", chat: family.info.slug })).status).toBe(200);
    expect((await post("/messages", { sessionId: "ses_group" })).status).toBe(200);
    expect((await post("/messages", { sessionId: "ses_group", chat: "owner" })).status).toBe(403);
    const work = chats.open(chatKey.group("GRP-Work-456"), "Work");
    expect((await post("/messages", { sessionId: "ses_moni", chat: work.info.slug })).status).toBe(403);
    const guest = chats.open(chatKey.dm("+15555550188"));
    guest.store.set("route", { id: "ses_guest", generation: 1 });
    expect((await post("/messages", { sessionId: "ses_guest", chat: "moni" })).status).toBe(403);
    expect((await post("/messages", { sessionId: "ses_guest" })).status).toBe(200);
    expect(await post("/messages", { sessionId: "ses_owner", chat: "nobody" })).toEqual({ status: 404, body: { error: "Unknown chat" } });
    expect(await post("/messages", { sessionId: "ses_gone" })).toEqual({ status: 409, body: { error: "No chat for this session" } });
    expect((await post("/messages", {})).status).toBe(400);
    for (const body of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { limit: "5" }, { id: "x", before: "y" },
      { id: "" }, { before: "x".repeat(201) }, { id: "x\ny" }, { before: "x\x85y" }, { unknown: true }]) {
      expect((await post("/messages", { sessionId: "ses_owner", ...body })).status).toBe(400);
    }
    for (const body of [{ id: "missing" }, { before: "missing" }, { id: "m-1" }]) {
      expect(await post("/messages", { sessionId: "ses_owner", ...body })).toEqual({ status: 404, body: { error: "Unknown message" } });
    }
    expect(moniChat.store.pendingOutbox()).toEqual([]);
    access.people[0]!.role = "person";
    expect((await post("/messages", { sessionId: "ses_moni", chat: family.info.slug })).status).toBe(403);
  });

  test("session-bound requests go to the chat that owns the session", async () => {
    const { post } = api();
    expect(await post("/send", { text: "hi", dedupeKey: "k", sessionId: "ses_moni@2" })).toEqual({ status: 200, body: { chat: "moni", path: "/send" } });
    expect(await post("/app", { url: "https://x", sessionId: "ses_owner" })).toEqual({ status: 200, body: { chat: "owner", path: "/app" } });
    expect((await post("/files", { sessionId: "ses_gone" })).status).toBe(409);
    expect((await post("/wake", { text: "w", source: "watch", dedupeKey: "k" })).body).toEqual({ chat: "owner", path: "/wake" });
  });

  test("share routes work from any chat and say when sharing is off", async () => {
    const { post } = api();
    expect(await post("/shares", { sessionId: "ses_moni" })).toEqual({ status: 503, body: { error: "Sharing is unavailable" } });
    const env = setup();
    const registry = env.registry();
    const appsRoot = join(env.stateRoot, "apps");
    await Bun.write(join(appsRoot, "trip", "index.html"), "<h1>t</h1>");
    const shares = new Shares({ store: registry.owner.store, appsRoot,
      startTunnel: async () => ({ url: "https://x.trycloudflare.com", pid: 0, alive: () => true, stop: async () => {}, kill: () => {} }) });
    const handler = createSbApi({ registry, line: env.line, accessPath: join(env.stateRoot, "access.json"), enabled: () => true,
      health: () => ({}), shares });
    const call = async (path: string, body: unknown) => {
      const response = await handler(new Request(`http://bridge${path}`, { method: "POST", body: JSON.stringify(body) }));
      return { status: response.status, body: await response.json() };
    };
    try {
      expect(await call("/share", { app: "trip" })).toMatchObject({ status: 201, body: { url: "https://x.trycloudflare.com", created: true } });
      expect((await call("/shares", {})).body).toMatchObject({ shares: [{ app: "trip", live: true }] });
      expect(await call("/unshare", { app: "trip" })).toEqual({ status: 200, body: { app: "trip", removed: true } });
      expect((await call("/share", [])).status).toBe(400);
    } finally { await shares.stopAll(); }
  });

  test("health reports the transport, line and chat count", async () => {
    const { handler, line } = api();
    const health = await (await handler(new Request("http://bridge/health"))).json();
    expect(health).toEqual({ transport: "sendblue", line: line.number, chats: 2 });
  });

  test("owner-only commands are refused from other chats", async () => {
    const { post, stateRoot } = api();
    const fromMoni = { sessionId: "ses_moni" };
    expect((await post("/send", { text: "x", to: "owner", dedupeKey: "k", ...fromMoni })).status).toBe(403);
    expect((await post("/wake", { text: "x", chat: "owner", dedupeKey: "k", ...fromMoni })).status).toBe(403);
    expect((await post("/chats", fromMoni)).body).toEqual({ chats: [] });
    expect((await post("/allow", { address: "+447000000002", name: "Sam", ...fromMoni })).status).toBe(403);
    expect((await post("/allow-group", { id: "grp-1", ...fromMoni })).status).toBe(403);
    expect((await post("/send", { text: "x", to: "moni", dedupeKey: "k" })).status).toBe(403);
    expect(existsSync(join(stateRoot, "access.json"))).toBe(false);
  });

  test("third-party grant routes are owner-chat only; a grant can't come from a shell or another chat", async () => {
    const env = setup();
    const chats = env.registry();
    chats.owner.store.set("route", { id: "ses_owner", generation: 1 });
    chats.open(chatKey.dm(moni)).store.set("route", { id: "ses_moni", generation: 2 });
    const calls: string[] = [];
    const guests = {
      allow: () => { calls.push("allow"); return { status: 200, body: {} }; },
      revoke: () => { calls.push("revoke"); return { status: 200, body: {} }; },
      list: () => ({ status: 200, body: { guests: [] } }),
      send: async () => { calls.push("send"); return { status: 202, body: {} }; },
      share: async () => { calls.push("share"); return { status: 200, body: {} }; },
    } as unknown as NonNullable<Parameters<typeof createSbApi>[0]["guests"]>;
    const handler = createSbApi({ registry: chats, line: env.line, accessPath: join(env.stateRoot, "access.json"), enabled: () => true, health: () => ({}), guests });
    const post = async (path: string, body: Record<string, unknown>) =>
      (await handler(new Request(`http://bridge${path}`, { method: "POST", body: JSON.stringify(body) }))).status;
    const allow = { address: "+447000000002", name: "Sam", purpose: "book a meeting", providers: ["meeting"], facts: [], evidence: ["msgs:1"] };
    expect(await post("/guest-allow", { ...allow, sessionId: "ses_moni" })).toBe(403);
    expect(await post("/guest-allow", allow)).toBe(403);
    expect(await post("/guest-send", { address: "+447000000002", text: "hi", dedupeKey: "k", sessionId: "ses_moni" })).toBe(403);
    expect(await post("/guest-allow", { ...allow, extra: true, sessionId: "ses_owner" })).toBe(400);
    expect(calls).toEqual([]);
    expect(await post("/guest-allow", { ...allow, sessionId: "ses_owner" })).toBe(200);
    // First-version callers still send actions and a single evidence string.
    expect(await post("/guest-allow", { address: "+447000000002", name: "Sam", purpose: "x", actions: ["meeting"], evidence: "msgs:1", sessionId: "ses_owner" })).toBe(200);
    expect(await post("/guest-revoke", { address: "+447000000002" })).toBe(200);
    expect(await post("/share-contact", { chat: "moni", sessionId: "ses_owner" })).toBe(200);
    expect(calls).toEqual(["allow", "allow", "revoke", "share"]);
  });

  test("an admin's chat can post in groups the admin has written in, and nowhere else", async () => {
    const { post, chats, stateRoot } = api();
    const family = chats.open(chatKey.group("GRP-Allowed-123"), "Family Trip");
    family.store.acceptInbound("g-1", { id: "g-1", text: "hi", attachments: [], isAudioMessage: false, receivedAt: 2, sender: moni });
    const work = chats.open(chatKey.group("GRP-Work-456"), "Work");
    work.store.acceptInbound("g-2", { id: "g-2", text: "hi", attachments: [], isAudioMessage: false, receivedAt: 3, sender: "+447000000009" });
    const fromMoni = { sessionId: "ses_moni" };

    expect(await post("/chats", fromMoni)).toEqual({ status: 200, body: { chats: [
      { slug: "group-family-trip-grp-al", title: "Family Trip", kind: "group", lastActivityAt: 2 },
    ] } });
    const send = { text: "x", to: "group-family-trip-grp-al", dedupeKey: "k", ...fromMoni };
    expect((await post("/send", send)).status).toBe(202);
    expect(family.store.pendingOutbox().map(row => row.text)).toEqual(["x"]);
    expect((await post("/send", send)).status).toBe(200);
    for (const to of [work.info.slug, "owner", "moni", "missing"]) {
      expect((await post("/send", { text: "x", to, dedupeKey: "k2", ...fromMoni })).status).toBe(403);
    }
    expect(work.store.pendingOutbox()).toEqual([]);

    // Membership is case- and space-insensitive, and any of Moni's addresses counts.
    const club = chats.open(chatKey.group("GRP-Club-789"), "Club");
    club.store.acceptInbound("g-3", { id: "g-3", text: "hi", attachments: [], isAudioMessage: false, receivedAt: 4, sender: " MONI@example.com" });
    expect((await post("/send", { text: "y", to: club.info.slug, dedupeKey: "k3", ...fromMoni })).status).toBe(202);

    // A known non-admin person who also wrote in Family Trip gets nothing.
    const person = chats.open(chatKey.dm("+15555550188"));
    person.store.set("route", { id: "ses_person", generation: 1 });
    family.store.acceptInbound("g-4", { id: "g-4", text: "hi", attachments: [], isAudioMessage: false, receivedAt: 5, sender: "+15555550188" });
    expect((await post("/send", { text: "x", to: "group-family-trip-grp-al", dedupeKey: "k4", sessionId: "ses_person" })).status).toBe(403);
    expect((await post("/chats", { sessionId: "ses_person" })).status).toBe(403);

    // Demotion takes effect at once: access.json is read live.
    access.people[0]!.role = "person";
    expect((await post("/send", { text: "x", to: "group-family-trip-grp-al", dedupeKey: "k5", ...fromMoni })).status).toBe(403);
    expect(existsSync(join(stateRoot, "access.json"))).toBe(false);
  });
  test("the owner chat can list chats, message one and pass decisions on", async () => {
    const { post, moniChat, stateRoot } = api();
    const listed = await post("/chats", { sessionId: "ses_owner" });
    expect(listed.body.chats).toEqual([
      { slug: "owner", title: "Abdullah", kind: "owner" },
      { slug: "moni", title: "Moni", kind: "dm", lastActivityAt: 1 },
    ]);
    // The local shell (no session) may list chats and edit access too.
    expect((await post("/chats", {})).status).toBe(200);

    const sent = await post("/send", { text: "dinner at 8", to: "moni", dedupeKey: "k1", sessionId: "ses_owner" });
    expect(sent.status).toBe(202);
    expect(moniChat.store.pendingOutbox().map(row => row.text)).toEqual(["dinner at 8"]);
    expect((await post("/send", { text: "dinner at 8", to: "moni", dedupeKey: "k1", sessionId: "ses_owner" })).status).toBe(200);
    expect((await post("/send", { text: "x", to: "nobody", dedupeKey: "k2", sessionId: "ses_owner" })).status).toBe(404);

    const woke = await post("/wake", { text: "yes, book it", chat: "moni", dedupeKey: "d1", sessionId: "ses_owner" });
    expect(woke.status).toBe(202);
    const wake = moniChat.store.pendingInbound().find(row => row.id === woke.body.id)!;
    expect((wake.payload as { text: string }).text).toEndWith("\nyes, book it");

    expect((await post("/allow", { address: "+447000000002", name: "Sam", admin: true })).status).toBe(200);
    const saved = JSON.parse(readFileSync(join(stateRoot, "access.json"), "utf8")) as Access;
    expect(saved.people.some(person => person.name === "Sam" && person.role === "admin")).toBe(true);
  });

  test("ask-owner wakes the owner's chat with the asking chat named", async () => {
    const { post, chats } = api();
    const asked = await post("/ask-owner", { text: "Can I order sushi?", dedupeKey: "q1", sessionId: "ses_moni" });
    expect(asked.status).toBe(202);
    const rows = chats.owner.store.pendingInbound();
    expect(rows).toHaveLength(1);
    expect((rows[0]!.payload as { text: string }).text).toContain("wake --chat moni");
    expect((rows[0]!.payload as { text: string }).text).toContain("Can I order sushi?");
    expect((await post("/ask-owner", { text: "Can I order sushi?", dedupeKey: "q1", sessionId: "ses_moni" })).status).toBe(202);
    expect(chats.owner.store.pendingInbound()).toHaveLength(1);
    expect((await post("/ask-owner", { text: "?", dedupeKey: "q2", sessionId: "ses_owner" })).status).toBe(400);
  });

  test("react takes a tapback or one emoji on an inbound message of any chat", async () => {
    const { post, line } = api();
    expect((await post("/react", { target: "m-1", kind: "love" })).status).toBe(200);
    expect((await post("/react", { target: "m-1", kind: "🔥" })).status).toBe(200);
    expect((await post("/react", { target: "m-1", kind: "🔥🔥" })).status).toBe(400);
    expect((await post("/react", { target: "m-1", kind: "fire" })).status).toBe(400);
    expect((await post("/react", { target: "nope", kind: "love" })).status).toBe(403);
    expect(line.reactions).toEqual([["m-1", "love"], ["m-1", "🔥"]]);
  });

  test("location requests go to the calling 1:1 chat once per key", async () => {
    const { post, line } = api();
    expect((await post("/location-request", { dedupeKey: "l1", sessionId: "ses_moni" })).status).toBe(202);
    expect((await post("/location-request", { dedupeKey: "l1", sessionId: "ses_moni" })).status).toBe(200);
    expect(line.locationRequests).toEqual([chatKey.dm(moni)]);
    expect((await post("/location", { sessionId: "ses_moni" })).body).toEqual({ location: "none" });
    expect((await post("/location", { sessionId: "ses_gone" })).status).toBe(409);
  });

  test("the owner chat asks for its own location or, with --chat, someone else's", async () => {
    const { post, line } = api();
    expect((await post("/location-request", { dedupeKey: "o1", sessionId: "ses_owner" })).status).toBe(202);
    expect((await post("/location-request", { dedupeKey: "o2", sessionId: "ses_owner", chat: "moni" })).status).toBe(202);
    expect((await post("/location-request", { dedupeKey: "o2", sessionId: "ses_owner", chat: "moni" })).status).toBe(200);
    expect(line.locationRequests).toEqual([chatKey.dm(owner), chatKey.dm(moni)]);
    expect((await post("/location", { sessionId: "ses_owner", chat: "moni" })).body).toEqual({ location: "none" });
    expect((await post("/location", { sessionId: "ses_owner", chat: "nobody" })).status).toBe(404);
    // Only the owner's agent may look up another chat.
    expect((await post("/location", { sessionId: "ses_moni", chat: "owner" })).status).toBe(403);
    expect((await post("/location-request", { dedupeKey: "m9", sessionId: "ses_moni", chat: "owner" })).status).toBe(403);
    expect(line.locationRequests).toHaveLength(2);
  });

  test("a bridge that is not ready refuses sends but still lists chats", async () => {
    const { post } = api(false);
    expect((await post("/send", { text: "x", to: "moni", dedupeKey: "k", sessionId: "ses_owner" })).status).toBe(503);
    expect((await post("/chats", { sessionId: "ses_owner" })).status).toBe(200);
  });
});

test("recipient sends, wakes and guest sends report their own message length limit", async () => {
  const env = setup(true);
  const registry = env.registry();
  registry.open(chatKey.dm(moni));
  env.ownerStore.set("route", { id: "ses_owner", generation: 1 });
  const guests = { send: async () => { throw new Error("must not send"); } } as unknown as NonNullable<Parameters<typeof createSbApi>[0]["guests"]>;
  const handler = createSbApi({ registry, line: env.line, accessPath: join(env.stateRoot, "access.json"),
    enabled: () => true, health: () => ({}), guests });
  for (const [path, limit, extra] of [
    ["/send", 12_000, { to: "moni" }],
    ["/wake", 12_000, { chat: "moni", source: "watch" }],
    ["/guest-send", 2_000, { address: "+15555550198" }],
  ] as const) {
    const response = await handler(new Request(`http://bridge${path}`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "x".repeat(limit + 412), dedupeKey: "long", sessionId: "ses_owner", ...extra }) }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: `message too long: ${(limit + 412).toLocaleString("en-US")} chars, limit ${limit.toLocaleString("en-US")}; split it or send as a card` });
  }
});

test("accepted live and backfill ingress logs canonical chat ids and failure tags", async () => {
  const { captureLogs } = await import("./log-fixture.ts");
  const logs = await captureLogs(async () => {
    const h = setup();
    const deps: IngressDeps = { line: h.line, owner, ownerStore: h.ownerStore, access: async () => access,
      sink: h.registry().sink(async () => {}, () => true) };
    const message: LineInbound = { handle: "log-live", chat: chatKey.dm(owner), from: owner, text: "PRIVATE_INBOUND", kind: "message", service: "iMessage", participants: [], sentAt: Date.now() - 100 };
    await handleInbound(deps, message);
    await handleInbound(deps, { ...message, handle: "log-backfill" }, "backfill");
    expect(await handleInbound(deps, message)).toBe(false);
    const { backfill } = await import("../src/sb-ingress.ts");
    await backfill({ ...deps, line: { ...h.line, backfill: async () => [{ ...message, handle: "failed-inbound" }] },
      sink: { ...deps.sink, acceptInto: () => { throw new Error("PRIVATE_ERROR"); } } }, Date.now);

  });
  expect(logs.filter(l => l.name === "msg.received").map(l => [l.ids?.chat, l.props?.source])).toEqual([["owner", "live"], ["owner", "backfill"]]);
  expect(logs.some(l => l.name === "bridge.catch" && l.component === "sb-ingress")).toBe(true);
  expect(JSON.stringify(logs)).not.toContain("PRIVATE_");
});

test("late Sendblue failures retain the status code but never the provider's error text", async () => {
  const { observedLine } = await import("../src/sb-main.ts");
  const { captureLogs } = await import("./log-fixture.ts");
  const logs = await captureLogs(async () => {
    const line = fakeLine();
    line.events = async function* () {
      yield { type: "status", id: "status-failed", handle: "sent-fixture", status: "failed", errorCode: "STOP", errorMessage: "PRIVATE_PROVIDER_MESSAGE", at: Date.now() };
      yield { type: "status", id: "status-delivered", handle: "sent-ok", status: "delivered", at: Date.now() };
    };
    for await (const _event of observedLine(line, { synchronized: true, lastEventAt: 0 }, () => ({ chat: "moni", operationId: "operation-fixture", inboundId: "inbound-fixture", threadId: "thread-fixture" })).events(new AbortController().signal)) { /* drain fixture */ }
  });
  expect(logs.find(l => l.name === "reply.failed")?.error?.tag).toBe("sendblue.stop_opt_out");
  expect(logs.find(l => l.name === "reply.failed")?.ids).toMatchObject({ chat: "moni", operationId: "operation-fixture", inboundId: "inbound-fixture", threadId: "thread-fixture" });
  expect(logs.filter(l => l.name === "reply.failed")).toHaveLength(1);
  expect(JSON.stringify(logs)).not.toContain("PRIVATE_PROVIDER_MESSAGE");
});

test("send and file acknowledgements name the routed recipient for owner, Moni, groups and retries", async () => {
  const env = setup(true);
  const chats = env.registry();
  const targets = [chats.owner, chats.open(chatKey.dm(moni)), chats.open(chatKey.group("GRP-Allowed-123"), "Family Trip")];
  const handler = createSbApi({ registry: chats, line: env.line, accessPath: join(env.stateRoot, "access.json"), enabled: () => true, health: () => ({}) });
  const post = async (path: string, body: Record<string, unknown>) => {
    const response = await handler(new Request(`http://bridge${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  for (const [index, target] of targets.entries()) {
    const sessionId = `session-${index}`;
    target.store.set("route", { id: sessionId, generation: 1 });
    for (const path of ["/send", "/files"]) {
      const body = { sessionId, dedupeKey: `${path}-${index}`, text: "hello", ...(path === "/files" ? { base64: "aGk=", name: "a.txt", mimeType: "text/plain" } : {}) };
      const first = await post(path, body);
      expect(first).toMatchObject({ status: 202, body: { created: true, chat: target.info.slug } });
      expect(await post(path, body)).toEqual({ status: 200, body: { ...first.body, created: false } });
    }
  }
  for (const target of targets) {
    const first = await post("/send", { text: "relay", to: target.info.slug, sessionId: "session-0", dedupeKey: `relay-${target.info.slug}` });
    expect(first).toMatchObject({ status: 202, body: { chat: target.info.slug } });
    expect((await post("/send", { text: "relay", to: target.info.slug, sessionId: "session-0", dedupeKey: `relay-${target.info.slug}` })).body).toMatchObject({ created: false, chat: target.info.slug });
  }
});
