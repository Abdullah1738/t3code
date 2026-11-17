import { markReactionAnswered } from "./unanswered.ts";
import type { RemoteBox } from "./remote-box.ts";
import { RemoteRequestError } from "./remote-box.ts";
import { validId } from "./remote-protocol.ts";
import type { BackendKind } from "./backend.ts";
import { messageLengthError } from "./message-length.ts";
import { toolError, toolLog } from "./toollog.ts";
/**
 * Sendblue mode: one shared line, one Store + Router + Delivery per chat. The owner's chat keeps
 * the original state.sqlite so a rollback to Photon finds its history; every other chat lives
 * under chats/<slug>/ and is created on its first allowed message.
 */
import { mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { chatInfo, personFor, roleOf, slugFor } from "./access.ts";
import { appContent } from "./api.ts";
import { speakerName } from "./group-judge.ts";
import { chatHistory } from "./history.ts";
import type { Access, ChatContext, ChatInfo } from "./chats.ts";
import { chatKey, GROUP_APP_REFUSAL, LineError, type ChatKey, type Line } from "./line.ts";
import { askOwner, editAccess, location, locationRequest, type SbApiDeps, type SbApiResult } from "./sb-api.ts";
import { TYPING_WINDOW_MS, type IngressSink } from "./sb-ingress.ts";
import type { GuestDesk } from "./guest-desk.ts";
import { getSecretRequest, type SecretDeps } from "./secrets.ts";
import { SHARE_ROUTES, shareRoute, type Shares } from "./share.ts";
import { sessionMatches } from "./session.ts";
import { Store } from "./store.ts";
import { agentPolicyPath, validNotifyId, validNotifyText } from "./agent-policy.ts";
import { AGENT_BUS_WAKE_PREFIX, AgentBus, validAgentRequestId, validAnswerStatus, type AgentAnswerReceipt } from "./agent-bus.ts";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

export type ChatCore = {
  info: ChatInfo;
  remote?: RemoteBox;
  store: Store;
  /** Owner: the bridge state root. Others: chats/<slug>, so secret values never mix between chats. */
  stateRoot: string;
  secretDeps: SecretDeps;
  context: ChatContext;
  /** Bumped on every accepted inbound; a router tick that raced one keeps controls pending. */
  revision: number;
  controlsPending: boolean;
  typing: Map<string, number>;
};
export type Chat<P> = ChatCore & { parts: P };

export function optOutHealth(chats: Pick<ChatCore, "info" | "store">[], otherwiseHealthy: boolean) {
  const optedOut = chats.filter(chat => chat.store.get("optedOut") !== undefined).map(chat => chat.info.slug);
  return { status: otherwiseHealthy && optedOut.length === 0 ? "healthy" : "degraded", optedOut };
}

type Saved = Record<ChatKey, { slug: string; groupName?: string }>;
const SAVED_KEY = "sbChats";

export type RegistryOptions<P> = {
  line: Pick<Line, "react">;
  owner: string;
  ownerStore: Store;
  stateRoot: string;
  access: () => Access;
  build: (chat: ChatCore) => P;
  backend?: BackendKind;
  now?: () => number;
};

/** Directory and Robob folder safe: lowercase, no slashes, never starting with a dot or dash. */
const cleanSlug = (value: string) => value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+/, "").slice(0, 80) || "chat";

export class ChatRegistry<P> {
  private readonly byKey = new Map<ChatKey, Chat<P>>();
  private readonly bySlug = new Map<string, Chat<P>>();
  readonly ownerKey: ChatKey;
  private readonly now: () => number;

  constructor(private readonly options: RegistryOptions<P>) {
    this.ownerKey = chatKey.dm(options.owner);
    this.now = options.now ?? Date.now;
  }

  /** Opens the owner chat and every chat seen before, so queued work resumes after a restart. */
  restore(): void {
    this.open(this.ownerKey);
    for (const [key, entry] of Object.entries(this.saved())) this.open(key as ChatKey, entry.groupName);
  }

  get owner(): Chat<P> {
    return this.open(this.ownerKey);
  }

  all(): Chat<P>[] {
    return [...this.bySlug.values()];
  }

  bySlugName(slug: string): Chat<P> | undefined {
    return this.bySlug.get(slug);
  }

  get(key: ChatKey): Chat<P> | undefined {
    return this.byKey.get(key);
  }

  /** The chat whose current route is this session (route id or id@generation). */
  forSession(sessionId: string): Chat<P> | undefined {
    return this.all().find(chat => chat.remote ? chat.remote.sessionId === sessionId : sessionMatches(chat.store.get<{ id: string; generation: number } | null>("route"), sessionId));
  }

  open(key: ChatKey, groupName?: string): Chat<P> {
    const known = this.byKey.get(key);
    if (known) return known;
    const saved = this.saved();
    const slug = saved[key]?.slug ?? this.pickSlug(key, groupName);
    if (key !== this.ownerKey && !saved[key]) {
      saved[key] = { slug, ...(groupName ? { groupName } : {}) };
      this.options.ownerStore.set(SAVED_KEY, saved);
    }
    // A person writing from a second address (phone and email) joins their existing chat.
    const shared = this.bySlug.get(slug);
    if (shared) {
      this.byKey.set(key, shared);
      return shared;
    }
    const chat = this.create(key, slug, saved[key]?.groupName ?? groupName);
    this.byKey.set(key, chat);
    this.bySlug.set(slug, chat);
    return chat;
  }

  /** Ingress target: opens chats lazily and records typing per chat. */
  sink(note: IngressSink["note"], enabled: () => boolean = () => true, guest?: IngressSink["guest"], received?: (chat: Chat<P>, input: unknown) => void): IngressSink {
    return {
      ...(guest ? { guest: async (message: Parameters<NonNullable<IngressSink["guest"]>>[0]) => enabled() ? guest(message) : false } : {}),
      acceptInto: (key, groupName) => {
        if (!enabled()) return { accept: () => false };
        const chat = this.open(key, groupName);
        return {
          accept: input => {
            const id = (input as { id?: unknown }).id;
            if (typeof id !== "string") return false;
            // Same as Photon ingest: the router's quiet window counts from arrival, not from the sender's clock.
            const payload = { ...(input as object), receivedAt: this.now() };
            const created = chat.remote ? chat.remote.accept(id, payload) : chat.store.acceptInbound(id, payload);
            if (created) {
              const message = input as { attachments?: { totalBytes?: number }[]; sentAt?: number; logSource?: string };
              toolLog.capture(() => toolLog.write({ component: "ingress", kind: "event", name: "msg.received", ids: { chat: chat.info.slug, messageId: id },
                props: { bytesKnown: !message.attachments?.length || message.attachments.every(a => (a.totalBytes ?? 0) > 0), attachmentCount: message.attachments?.length ?? 0, attachmentBytes: (message.attachments ?? []).reduce((n, a) => n + (a.totalBytes ?? 0), 0),
                  receiveLagMs: Math.max(0, this.now() - (message.sentAt ?? this.now())), source: message.logSource === "backfill" ? "backfill" : "live",
                  backend: chat.remote ? "remote-box" : this.options.backend ?? "unknown" } }));
              this.touch(chat); received?.(chat, input);
            }
            return created;
          },
        };
      },
      setTyping: (key, from, on, at) => {
        const chat = this.byKey.get(key);
        if (!chat) return;
        if (on) chat.typing.set(from, at);
        else chat.typing.delete(from);
      },
      note,
    };
  }

  /** Machine input for a chat's agent (owner decisions, questions from other chats). Deduped by key. */
  wake(chat: Chat<P>, text: string, dedupeKey: string, metadata: { agentAnswer?: AgentAnswerReceipt; agentBus?: boolean } = {}): { id: string; created: boolean } {
    const id = `${metadata.agentBus ? AGENT_BUS_WAKE_PREFIX : "wake:"}${hash(dedupeKey)}`;
    const payload = { id, text, attachments: [], isAudioMessage: false, receivedAt: this.now(),
      ...(metadata.agentAnswer ? { agentAnswer: metadata.agentAnswer } : {}) };
    const created = chat.remote ? chat.remote.accept(id, payload, metadata.agentAnswer, "wake") : chat.store.acceptInbound(id, payload);
    if (created) this.touch(chat);
    return { id, created };
  }

  lastActivity(chat: Chat<P>): number | undefined {
    const row = chat.store.db.query<{ payload: string }, []>("SELECT payload FROM inbound ORDER BY rowid DESC LIMIT 1").get();
    const at = row ? (JSON.parse(row.payload) as { receivedAt?: unknown }).receivedAt : undefined;
    return typeof at === "number" ? at : undefined;
  }

  private touch(chat: Chat<P>): void {
    chat.revision++;
    chat.controlsPending = true;
  }

  private saved(): Saved {
    return this.options.ownerStore.get<Saved>(SAVED_KEY) ?? {};
  }

  private pickSlug(key: ChatKey, groupName?: string): string {
    if (key === this.ownerKey) return "owner";
    const access = this.options.access();
    if (key.startsWith("dm:") && roleOf(access, this.options.owner, chatKey.target(key)).role === "owner") return "owner";
    const base = cleanSlug(slugFor(key, access, this.options.owner, groupName));
    const person = key.startsWith("dm:") ? personFor(access, chatKey.target(key)) : undefined;
    for (let n = 1; ; n++) {
      const slug = n === 1 ? base : `${base}-${n}`;
      const taken = this.bySlug.get(slug) ?? (slug === "owner" ? this.owner : undefined);
      if (!taken) return slug;
      if (person && taken.info.kind === "dm" && taken.info.person?.name === person.name) return slug;
    }
  }

  private create(key: ChatKey, slug: string, groupName?: string): Chat<P> {
    const isOwner = slug === "owner";
    const stateRoot = isOwner ? this.options.stateRoot : join(this.options.stateRoot, "chats", slug);
    if (!isOwner) mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
    const store = isOwner ? this.options.ownerStore : new Store(join(stateRoot, "state.sqlite"));
    const info = chatInfo(isOwner ? this.ownerKey : key, slug, this.options.access(), groupName);
    const typing = new Map<string, number>();
    const context: ChatContext = {
      chat: info,
      roleOf: address => roleOf(this.options.access(), this.options.owner, address),
      typing: () => [...typing.values()].some(at => this.now() - at < TYPING_WINDOW_MS),
      react: (handle, reaction) => this.options.line.react(handle, reaction),
    };
    const core: ChatCore = { info, store, stateRoot, secretDeps: { store, stateRoot }, context, revision: 0, controlsPending: true, typing };
    return Object.assign(core, { parts: this.options.build(core) });
  }
}

type Handler = (request: Request) => Promise<Response>;

export type SbApiOptions<P extends { api: Handler }> = {
  registry: ChatRegistry<P>;
  agentBus?: AgentBus;
  line: Line;
  accessPath: string;
  enabled: () => boolean;
  health: () => Record<string, unknown>;
  /** Called after an access edit so the next message sees it without waiting for the tick. */
  reloadAccess?: () => Promise<unknown>;
  /** Scoped third parties (guest-desk.ts). Its routes are owner-chat only. */
  guests?: GuestDesk;
  /** Public Cloudflare links; any chat may share, since that is how non-owner chats get a page. */
  shares?: Shares;
};

/** Session-bound routes the per-chat Photon-era API already implements. */
const FORWARDED = ["/files", "/poll", "/secret-request", "/cancel-send"];
const TAPBACKS = ["like", "love", "dislike", "laugh", "emphasize", "question"];
const RESERVED_TARGET = /^(?:secret|wake|reset):/;
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const singleEmoji = (value: string) => [...segmenter.segment(value)].length === 1 && /\p{Extended_Pictographic}/u.test(value);
const text = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max && value.trim().length > 0;

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function only(body: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(body).some(key => !allowed.includes(key))) throw new HttpError(400, "Invalid request");
}

function parseBody(raw: Uint8Array): Record<string, unknown> | undefined {
  if (raw.length === 0) return {};
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch (caughtError) { toolError("runtime", "runtime.catch1", caughtError); return undefined; }
}

const askText = (from: ChatInfo, question: string) =>
  `[Request from the chat "${from.title}" (slug ${from.slug}), not typed by the owner. Ask the owner; pass the decision back with wake --chat ${from.slug}.]\n${question}`;
const relayText = (body: string) =>
  `[Relayed from the owner's chat, not typed by anyone here. Act on it and tell this chat what happened if they need to know.]\n${body}`;

const isAdmin = <P>(chat: Chat<P>) => chat.info.kind === "dm"
  && chat.context.roleOf(chatKey.target(chat.info.key)).role === "admin";
const adminGroup = <P>(caller: Chat<P> | undefined, target: Chat<P> | undefined) => caller !== undefined
  && isAdmin(caller) && target !== undefined && target.info.kind === "group"
  && target.store.hasInboundFrom([chatKey.target(caller.info.key), ...(caller.info.person?.addresses ?? [])]);

export function createAgentBus<P>(registry: ChatRegistry<P>, log: (event: string, code?: string) => void = () => {}, policyPath?: string): AgentBus {
  return new AgentBus({
    db: registry.owner.store.db,
    forSession: id => registry.forSession(id)?.info,
    bySlug: slug => registry.bySlugName(slug)?.info,
    policyPath,
    groupMembers: info => {
      const chat = registry.bySlugName(info.slug);
      return chat ? [...new Set(chat.store.groupAudience().map(address => chat.context.roleOf(address).name))] : [];
    },
    deliver: (target, text, key, receipt) => {
      const chat = registry.bySlugName(target.slug);
      if (!chat) throw new Error("Agent target unavailable");
      registry.wake(chat, text, key, { agentAnswer: receipt, agentBus: true });
    },
    receipt: (target, key) => {
      const chat = registry.bySlugName(target.slug);
      if (chat?.remote) return chat.remote.receipt(`${AGENT_BUS_WAKE_PREFIX}${hash(key)}`);
      const row = chat?.store.db.query<{ payload: string }, [string]>("SELECT payload FROM inbound WHERE id = ?").get(`${AGENT_BUS_WAKE_PREFIX}${hash(key)}`);
      const receipt = row ? (JSON.parse(row.payload) as { agentAnswer?: AgentAnswerReceipt }).agentAnswer : undefined;
      return receipt && validAnswerStatus(receipt.status) && Number.isSafeInteger(receipt.at)
        && Number.isSafeInteger(receipt.chars) && receipt.chars >= 0 ? receipt : undefined;
    },
    log,
  });
}

/**
 * The bridge socket in Sendblue mode. `sessionId` picks the calling chat; Photon-era routes are
 * forwarded unchanged to that chat's own API, and the multi-chat routes are handled here.
 */
export function createSbApi<P extends { api: Handler }>(options: SbApiOptions<P>, remotePrincipal?: RemoteBox, operation?: { id: string; fingerprint: string }): Handler {
  const { registry } = options;
  const bus = options.agentBus ?? createAgentBus(registry, undefined, agentPolicyPath(options.accessPath));
  const reply = (status: number, body: unknown) => Response.json(body, { status });
  const result = (outcome: SbApiResult) => reply(outcome.status, outcome.body);
  const pendingOptIns = new Set<string>();
  const invokeBus = (perform: () => SbApiResult) => operation ? bus.once(operation.id, operation.fingerprint, perform) : perform();

  return async request => {
    if (remotePrincipal) {
      const chat = registry.bySlugName("moni");
      if (!chat || chat.remote !== remotePrincipal) return reply(403, { error: "Forbidden" });
      if (!options.enabled()) return reply(503, { error: "Bridge unavailable" });
      return remotePrincipal.callback(request, { line: options.line, chat: chat.info.key,
        bus: (path, body, id, fingerprint) => createSbApi(options, undefined, { id, fingerprint })(new Request(`http://bridge${path}`, { method: "POST", body: JSON.stringify(body) })) });
    }
    const path = new URL(request.url).pathname;
    try {
      if (request.method === "GET") {
        if (path === "/health") return reply(200, options.health());
        if (path === "/router") return registry.owner.parts.api(request);
        return reply(404, { error: "Not found" });
      }
      if (request.method !== "POST") return reply(404, { error: "Not found" });
      const raw = new Uint8Array(await request.arrayBuffer());
      const body = parseBody(raw);
      const forward = async (chat: Chat<P>) => {
        const response = await chat.parts.api(new Request(request.url, { method: "POST", headers: request.headers, body: raw }));
        if (!response.ok || (path !== "/send" && path !== "/files")) return response;
        const ack = await response.json() as Record<string, unknown>;
        return Response.json({ ...ack, chat: chat.info.slug }, { status: response.status, headers: response.headers });
      };
      const sessionId = typeof body?.sessionId === "string" ? body.sessionId : undefined;
      const caller = sessionId === undefined ? undefined : registry.forSession(sessionId);

      if (path === "/secret-read" || path === "/secret-forget") {
        const token = body?.token;
        const holder = typeof token === "string" ? registry.all().find(chat => getSecretRequest(chat.store, token)) : undefined;
        return forward(holder ?? registry.owner);
      }
      // Watchers wake the owner; only `wake --chat` reaches another chat.
      if (path === "/wake" && body?.chat === undefined) return forward(registry.owner);
      if (FORWARDED.includes(path) || ((path === "/send" || path === "/app") && body?.to === undefined)) {
        // No session: the owner chat's API gives the same validation errors as before.
        if (sessionId === undefined) return forward(registry.owner);
        return caller ? forward(caller) : reply(409, { error: "No chat for this session" });
      }

      if (!body) throw new HttpError(400, "Invalid request");
      if (SHARE_ROUTES.includes(path)) {
        if (!options.shares) throw new HttpError(503, "Sharing is unavailable");
        return result(await shareRoute(options.shares, path, body));
      }
      const ownerOnly = (allowLocal: boolean) => {
        if (sessionId === undefined) {
          if (allowLocal) return;
          throw new HttpError(403, "Only the owner's chat can do this");
        }
        if (!caller) throw new HttpError(409, "No chat for this session");
        if (caller.info.kind !== "owner") throw new HttpError(403, "Only the owner's chat can do this");
      };
      // An admin's own chat may post in groups the admin has written in; everything else cross-chat stays owner-only.
      const adminCaller = caller !== undefined && isAdmin(caller);
      const callerAdminGroup = (chat: Chat<P> | undefined) => adminGroup(caller, chat);
      const live = () => { if (!options.enabled()) throw new HttpError(503, "Bridge is not ready"); };
      /** `--chat <slug>`: only the owner's agent may ask after someone else's location. */
      const locationTarget = (chat: unknown): ChatInfo | undefined => {
        if (chat === undefined) return undefined;
        if (!text(chat, 100)) throw new HttpError(400, "Invalid request");
        ownerOnly(false);
        const target = registry.bySlugName(chat);
        if (!target) throw new HttpError(404, "Unknown chat");
        return target.info;
      };
      const deps = (from?: ChatInfo): SbApiDeps => ({
        line: options.line,
        chatForSession: id => registry.forSession(id)?.info,
        owner: registry.owner.info,
        accessPath: options.accessPath,
        wakeOwner: (question, key) => { registry.wake(registry.owner, from ? askText(from, question) : question, key); },
      });

      switch (path) {
        case "/notify-rule": {
          only(body, ["sessionId", "action", "text", "id"]);
          live();
          if (!text(sessionId, 200)) throw new HttpError(400, "Invalid request");
          ownerOnly(false);
          if (body.action === "add" ? !validNotifyText(body.text) || body.id !== undefined
            : body.action === "rm" ? !validNotifyId(body.id) || body.text !== undefined
            : body.action !== "list" || body.id !== undefined || body.text !== undefined) throw new HttpError(400, "Invalid request");
          return result(bus.notifyRules({ sessionId, action: body.action as "add" | "rm" | "list",
            ...(typeof body.text === "string" ? { text: body.text } : {}), ...(typeof body.id === "number" ? { id: body.id } : {}) }));
        }
        case "/agent-ask": {
          only(body, ["sessionId", "to", "text", "dedupeKey", "parent"]);
          live();
          if (!text(sessionId, 200) || !text(body.to, 100) || !/^[a-z0-9][a-z0-9._-]{0,99}$/.test(body.to)
            || !text(body.text, 12_000) || !text(body.dedupeKey, 200)
            || (body.parent !== undefined && !validAgentRequestId(body.parent))) throw new HttpError(400, "Invalid request");
          return result(invokeBus(() => bus.ask({ sessionId, to: body.to as string, text: body.text as string, dedupeKey: body.dedupeKey as string,
            ...(typeof body.parent === "string" ? { parent: body.parent } : {}) })));
        }
        case "/agent-answer": {
          only(body, ["sessionId", "request", "text", "status"]);
          live();
          if (!text(sessionId, 200) || !validAgentRequestId(body.request)
            || !text(body.text, 12_000) || (body.status !== undefined && !validAnswerStatus(body.status))) throw new HttpError(400, "Invalid request");
          return result(invokeBus(() => bus.answer({ sessionId, request: body.request as string, text: body.text as string, status: body.status as import("./agent-bus.ts").AnswerStatus | undefined })));
        }
        case "/remote-events":
        case "/remote-resolve": {
          only(body, path === "/remote-events" ? ["sessionId", "chat", "after"] : ["sessionId", "chat", "id", "state"]);
          ownerOnly(false);
          live();
          if (body.chat !== "moni" || path === "/remote-events" && body.after !== undefined && !validId(body.after)
            || path === "/remote-resolve" && (!validId(body.id) || !["done", "pending"].includes(String(body.state)))) throw new HttpError(400, "Invalid request");
          const remote = registry.bySlugName("moni")?.remote;
          if (!remote) throw new HttpError(409, "Moni's chat is not on its box");
          try {
            return reply(200, path === "/remote-events" ? await remote.events(body.after as string | undefined) : await remote.resolve(body.id as string, body.state as "done" | "pending"));
          } catch (error) {
            if (error instanceof RemoteRequestError && error.status === 409) throw new HttpError(409, "Event is not interrupted/attachment-failed");
            throw new HttpError(502, "Box request failed");
          }
        }
        case "/agent-requests": {
          only(body, ["sessionId"]);
          live();
          if (!text(sessionId, 200)) throw new HttpError(400, "Invalid request");
          return result(bus.requests(sessionId));
        }
        case "/app": {
          if (request.headers.has("origin")) throw new HttpError(403, "Forbidden");
          only(body, ["url", "caption", "subcaption", "trailingCaption", "trailingSubcaption", "summary", "updateOf", "previewPage", "to", "dedupeKey", "sessionId"]);
          ownerOnly(false);
          live();
          const { to, dedupeKey } = body;
          const app = appContent(body);
          if (!app || !text(to, 100) || !/^[a-z0-9][a-z0-9._-]{0,99}$/.test(to) || !text(dedupeKey, 200)) {
            throw new HttpError(400, "Invalid request");
          }
          const target = registry.bySlugName(to);
          if (!target) throw new HttpError(404, "Unknown chat");
          if (target.remote) throw new HttpError(403, "Use agent-ask to reach this chat on its box");
          if (target.info.kind === "group") throw new HttpError(422, GROUP_APP_REFUSAL);
          const id = `app:${hash(`${target.info.slug}:${dedupeKey}`)}`;
          let created: boolean;
          // Like send --to, this is an owner-authorized relay, not a reply in the recipient's session.
          try { created = target.store.enqueue({ id, kind: "conversation", text: "", app }); }
          catch (caughtError) { toolError("runtime", "runtime.catch2", caughtError); throw new HttpError(409, "Operation could not be completed"); }
          return reply(created ? 202 : 200, { id, created });
        }
        case "/send": {
          only(body, ["text", "to", "dedupeKey", "sessionId"]);
          if (!callerAdminGroup(typeof body.to === "string" ? registry.bySlugName(body.to) : undefined)) ownerOnly(false);
          live();
          const { to, dedupeKey } = body;
          if (typeof body.text === "string" && body.text.length > 12_000) throw new HttpError(400, messageLengthError(body.text, 12_000));
          if (!text(body.text, 12_000) || !text(to, 100) || !text(dedupeKey, 200)) throw new HttpError(400, "Invalid request");
          const target = registry.bySlugName(to);
          if (!target) throw new HttpError(404, "Unknown chat");
          if (target.remote) throw new HttpError(403, "Use agent-ask to reach this chat on its box");
          const id = `send:${hash(`${target.info.slug}:${dedupeKey}`)}`;
          let created: boolean;
          try { created = target.store.enqueue({ id, kind: "conversation", text: body.text }); }
          catch (caughtError) { toolError("runtime", "runtime.catch3", caughtError); throw new HttpError(409, "Operation could not be completed"); }
          return reply(created ? 202 : 200, { id, created, chat: target.info.slug });
        }
        case "/wake": {
          only(body, ["text", "chat", "source", "dedupeKey", "sessionId"]);
          ownerOnly(false);
          live();
          const { chat, dedupeKey } = body;
          if (typeof body.text === "string" && body.text.length > 12_000) throw new HttpError(400, messageLengthError(body.text, 12_000));
          if (!text(body.text, 12_000) || !text(chat, 100) || !text(dedupeKey, 200)
            || (body.source !== undefined && !text(body.source, 100))) throw new HttpError(400, "Invalid request");
          const target = registry.bySlugName(chat);
          if (!target) throw new HttpError(404, "Unknown chat");
          const { id, created } = registry.wake(target, relayText(body.text), `chat:${target.info.slug}:${dedupeKey}`);
          return reply(created ? 202 : 200, { id, created });
        }
        case "/react": {
          only(body, ["target", "kind"]);
          live();
          const { target, kind } = body;
          if (!text(target, 200) || RESERVED_TARGET.test(target) || typeof kind !== "string"
            || !(TAPBACKS.includes(kind) || singleEmoji(kind))) throw new HttpError(400, "Invalid request");
          const inbound = registry.all().find(chat =>
            chat.store.db.query<{ id: string }, [string]>("SELECT id FROM inbound WHERE id = ?").get(target));
          if (!inbound) throw new HttpError(403, "Forbidden");
          await options.line.react(target, kind);
          markReactionAnswered(inbound.store, target);
          return reply(200, { id: `reaction:${hash(target + kind)}` });
        }
        case "/location-request": {
          only(body, ["sessionId", "dedupeKey", "chat"]);
          live();
          if (!sessionId || !text(body.dedupeKey, 200)) throw new HttpError(400, "Invalid request");
          const target = locationTarget(body.chat);
          const key = `sb-location-request:${hash(body.dedupeKey)}`;
          if (registry.owner.store.get(key)) return reply(200, { requested: true, created: false });
          const outcome = await locationRequest(deps(), sessionId, target);
          if (outcome.status === 202) registry.owner.store.set(key, true);
          return result(outcome);
        }
        case "/location": {
          only(body, ["sessionId", "chat"]);
          if (!sessionId) throw new HttpError(400, "Invalid request");
          return result(await location(deps(), sessionId, locationTarget(body.chat)));
        }
        case "/messages": {
          only(body, ["sessionId", "chat", "limit", "before", "id"]);
          if (!sessionId) throw new HttpError(400, "Invalid request");
          if (!caller) throw new HttpError(409, "No chat for this session");
          let chat = caller;
          if (body.chat !== undefined) {
            if (!text(body.chat, 100) || !/^[a-z0-9][a-z0-9._-]{0,99}$/.test(body.chat)) throw new HttpError(400, "Invalid request");
            const target = registry.bySlugName(body.chat);
            if (!callerAdminGroup(target)) ownerOnly(false);
            if (!target) throw new HttpError(404, "Unknown chat");
            chat = target;
          }
          const limit = body.limit === undefined ? 20 : body.limit;
          const messageId = (value: unknown) => text(value, 200) && !/[\x00-\x1f\x7f-\x9f]/.test(value);
          if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 100
            || (body.before !== undefined && !messageId(body.before)) || (body.id !== undefined && !messageId(body.id))
            || (body.before !== undefined && body.id !== undefined)) throw new HttpError(400, "Invalid request");
          const history = chatHistory(chat.store, address => speakerName(chat.context.roleOf(address), address),
            chatKey.target(registry.ownerKey), typeof body.id === "string" ? { id: body.id }
              : { limit, ...(typeof body.before === "string" ? { before: body.before } : {}) }, chat.info.kind === "owner");
          if (!history) throw new HttpError(404, "Unknown message");
          return reply(200, { chat: chat.info.slug, ...history });
        }
        case "/opt-in": {
          only(body, ["chat", "sessionId"]);
          if (body.sessionId !== undefined && !text(body.sessionId, 200)) throw new HttpError(400, "Invalid request");
          ownerOnly(true);
          live();
          if (!text(body.chat, 100)) throw new HttpError(400, "Invalid request");
          const target = registry.bySlugName(body.chat);
          if (!target) throw new HttpError(404, "Unknown chat");
          if (target.info.kind === "group") throw new HttpError(422, "Groups can't be opted in");
          if (pendingOptIns.has(target.info.slug)) throw new HttpError(409, "Opt-in already in progress");
          pendingOptIns.add(target.info.slug);
          try {
            const prior = target.store.get<{ since: number; failures: number }>("optedOut");
            await options.line.setOptOut(chatKey.target(target.info.key), false);
            target.store.db.transaction(() => {
              target.store.set("optInRevision", (target.store.get<number>("optInRevision") ?? 0) + 1);
              const current = target.store.get<{ since: number; failures: number }>("optedOut");
              // A failure concurrent with the request must remain visible until a send succeeds.
              if (prior && current?.since === prior.since && current.failures === prior.failures) {
                const pending = target.store.get<Array<typeof current>>("optOutAwaitingSend") ?? [];
                target.store.set("optOutAwaitingSend", [...pending, current]);
                target.store.db.query("DELETE FROM kv WHERE key = 'optedOut'").run();
              }
            }).immediate();
            return reply(200, { optedIn: true });
          } finally {
            pendingOptIns.delete(target.info.slug);
          }
        }
        case "/ask-owner": {
          only(body, ["text", "sessionId", "dedupeKey"]);
          live();
          if (typeof body.text === "string" && body.text.length > 12_000) throw new HttpError(400, messageLengthError(body.text, 12_000));
          if (!sessionId || !text(body.text, 12_000) || !text(body.dedupeKey, 200)) throw new HttpError(400, "Invalid request");
          return result(askOwner(deps(caller?.info), sessionId, body.text, body.dedupeKey));
        }
        case "/allow": {
          only(body, ["address", "name", "admin", "sessionId"]);
          ownerOnly(true);
          const { address, name, admin } = body;
          if (!text(address, 200) || !text(name, 100) || (admin !== undefined && typeof admin !== "boolean")) {
            throw new HttpError(400, "Invalid request");
          }
          const outcome = await editAccess(deps(), { type: "allow", address: address.trim(), name: name.trim(), admin: admin === true });
          await options.reloadAccess?.();
          return result(outcome);
        }
        case "/allow-group": {
          only(body, ["id", "name", "sessionId"]);
          ownerOnly(true);
          const { id, name } = body;
          if (!text(id, 200) || (name !== undefined && !text(name, 100))) throw new HttpError(400, "Invalid request");
          const outcome = await editAccess(deps(), { type: "allow-group", id: id.trim(), ...(name ? { name: name.trim() } : {}) });
          await options.reloadAccess?.();
          return result(outcome);
        }
        case "/guest-allow": {
          only(body, ["address", "name", "purpose", "providers", "actions", "facts", "expires", "evidence", "sessionId"]);
          // Never from a shell: a grant must come from the owner's chat, where his words are.
          ownerOnly(false);
          if (!options.guests) throw new HttpError(503, "Guests unavailable");
          const { address, name, purpose, expires } = body;
          const strings = (value: unknown, max: number, each: number): string[] | undefined =>
            value === undefined ? [] : Array.isArray(value) && value.length <= max && value.every(item => text(item, each)) ? value as string[] : undefined;
          const providers = strings(body.providers, 6, 40);
          const actions = strings(body.actions, 4, 40);
          const facts = strings(body.facts, 8, 345);
          const evidence = typeof body.evidence === "string" ? [body.evidence] : strings(body.evidence, 4, 220);
          if (!text(address, 200) || !text(name, 100) || !text(purpose, 300) || !evidence?.length
            || (expires !== undefined && !text(expires, 10)) || !providers || !actions || !facts) throw new HttpError(400, "Invalid request");
          return result(options.guests.allow({ address, name, purpose, providers: [...providers, ...actions], facts, evidence, ...(expires ? { expires } : {}) }));
        }
        case "/guest-revoke": {
          only(body, ["address", "sessionId"]);
          ownerOnly(true);
          if (!options.guests) throw new HttpError(503, "Guests unavailable");
          if (!text(body.address, 200)) throw new HttpError(400, "Invalid request");
          return result(options.guests.revoke(body.address));
        }
        case "/guests": {
          only(body, ["sessionId"]);
          ownerOnly(true);
          if (!options.guests) throw new HttpError(503, "Guests unavailable");
          return result(options.guests.list());
        }
        case "/guest-send": {
          only(body, ["address", "text", "dedupeKey", "sessionId"]);
          ownerOnly(false);
          live();
          if (!options.guests) throw new HttpError(503, "Guests unavailable");
          if (typeof body.text === "string" && body.text.length > 2_000) throw new HttpError(400, messageLengthError(body.text, 2_000));
          if (!text(body.address, 200) || !text(body.text, 2_000) || !text(body.dedupeKey, 200)) throw new HttpError(400, "Invalid request");
          return result(await options.guests.send(body.address, body.text, body.dedupeKey));
        }
        case "/share-contact": {
          only(body, ["address", "chat", "sessionId"]);
          ownerOnly(true);
          live();
          if (!options.guests) throw new HttpError(503, "Guests unavailable");
          let address = typeof body.address === "string" ? body.address : undefined;
          if (body.chat !== undefined) {
            if (!text(body.chat, 100)) throw new HttpError(400, "Invalid request");
            const target = registry.bySlugName(body.chat);
            if (!target || target.info.kind === "group") throw new HttpError(404, "Unknown chat");
            address = chatKey.target(target.info.key);
          }
          if (!text(address, 200)) throw new HttpError(400, "Invalid request");
          return result(await options.guests.share(address));
        }
        case "/chats": {
          only(body, ["sessionId"]);
          if (!adminCaller) ownerOnly(true);
          return reply(200, { chats: (adminCaller ? registry.all().filter(chat => callerAdminGroup(chat)) : registry.all()).map(chat => ({
            slug: chat.info.slug, title: chat.info.title, kind: chat.info.kind,
            ...(registry.lastActivity(chat) === undefined ? {} : { lastActivityAt: registry.lastActivity(chat) }),
          })) });
        }
        default:
          return reply(404, { error: "Not found" });
      }
    } catch (error) { toolError("runtime", "runtime.catch4", error);
      if (error instanceof HttpError) return reply(error.status, { error: error.message });
      if (error instanceof LineError) return reply(502, { error: "Sendblue request failed" });
      return reply(500, { error: "Internal error" });
    }
  };
}
