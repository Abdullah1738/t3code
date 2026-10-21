/**
 * Sendblue mode: one shared line, one Store + Router + Delivery per chat. The owner's chat keeps
 * the original state.sqlite so a rollback to Photon finds its history; every other chat lives
 * under chats/<slug>/ and is created on its first allowed message.
 */
import { mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { chatInfo, personFor, roleOf, slugFor } from "./access.ts";
import type { Access, ChatContext, ChatInfo } from "./chats.ts";
import { chatKey, LineError, type ChatKey, type Line } from "./line.ts";
import { askOwner, editAccess, location, locationRequest, type SbApiDeps, type SbApiResult } from "./sb-api.ts";
import { TYPING_WINDOW_MS, type IngressSink } from "./sb-ingress.ts";
import type { GuestDesk } from "./guest-desk.ts";
import { getSecretRequest, type SecretDeps } from "./secrets.ts";
import { sessionMatches } from "./session.ts";
import { Store } from "./store.ts";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

export type ChatCore = {
  info: ChatInfo;
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

type Saved = Record<ChatKey, { slug: string; groupName?: string }>;
const SAVED_KEY = "sbChats";

export type RegistryOptions<P> = {
  line: Pick<Line, "react">;
  owner: string;
  ownerStore: Store;
  stateRoot: string;
  access: () => Access;
  build: (chat: ChatCore) => P;
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
    return this.all().find(chat => sessionMatches(chat.store.get<{ id: string; generation: number } | null>("route"), sessionId));
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
  sink(note: IngressSink["note"], enabled: () => boolean = () => true, guest?: IngressSink["guest"]): IngressSink {
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
            const created = chat.store.acceptInbound(id, { ...(input as object), receivedAt: this.now() });
            if (created) this.touch(chat);
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
  wake(chat: Chat<P>, text: string, dedupeKey: string): { id: string; created: boolean } {
    const id = `wake:${hash(dedupeKey)}`;
    const created = chat.store.acceptInbound(id, { id, text, attachments: [], isAudioMessage: false, receivedAt: this.now() });
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
  line: Line;
  accessPath: string;
  enabled: () => boolean;
  health: () => Record<string, unknown>;
  /** Called after an access edit so the next message sees it without waiting for the tick. */
  reloadAccess?: () => Promise<unknown>;
  /** Scoped third parties (guest-desk.ts). Its routes are owner-chat only. */
  guests?: GuestDesk;
};

/** Session-bound routes the per-chat Photon-era API already implements. */
const FORWARDED = ["/files", "/poll", "/app", "/secret-request"];
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
  } catch { return undefined; }
}

const askText = (from: ChatInfo, question: string) =>
  `[Request from the chat "${from.title}" (slug ${from.slug}), not typed by the owner. Ask the owner; pass the decision back with wake --chat ${from.slug}.]\n${question}`;
const relayText = (body: string) =>
  `[Relayed from the owner's chat, not typed by anyone here. Act on it and tell this chat what happened if they need to know.]\n${body}`;

/**
 * The bridge socket in Sendblue mode. `sessionId` picks the calling chat; Photon-era routes are
 * forwarded unchanged to that chat's own API, and the multi-chat routes are handled here.
 */
export function createSbApi<P extends { api: Handler }>(options: SbApiOptions<P>): Handler {
  const { registry } = options;
  const reply = (status: number, body: unknown) => Response.json(body, { status });
  const result = (outcome: SbApiResult) => reply(outcome.status, outcome.body);

  return async request => {
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
      const forward = (chat: Chat<P>) => chat.parts.api(new Request(request.url, { method: "POST", headers: request.headers, body: raw }));
      const sessionId = typeof body?.sessionId === "string" ? body.sessionId : undefined;
      const caller = sessionId === undefined ? undefined : registry.forSession(sessionId);

      if (path === "/secret-read" || path === "/secret-forget") {
        const token = body?.token;
        const holder = typeof token === "string" ? registry.all().find(chat => getSecretRequest(chat.store, token)) : undefined;
        return forward(holder ?? registry.owner);
      }
      // Watchers wake the owner; only `wake --chat` reaches another chat.
      if (path === "/wake" && body?.chat === undefined) return forward(registry.owner);
      if (FORWARDED.includes(path) || (path === "/send" && body?.to === undefined)) {
        // No session: the owner chat's API gives the same validation errors as before.
        if (sessionId === undefined) return forward(registry.owner);
        return caller ? forward(caller) : reply(409, { error: "No chat for this session" });
      }

      if (!body) throw new HttpError(400, "Invalid request");
      const ownerOnly = (allowLocal: boolean) => {
        if (sessionId === undefined) {
          if (allowLocal) return;
          throw new HttpError(403, "Only the owner's chat can do this");
        }
        if (!caller) throw new HttpError(409, "No chat for this session");
        if (caller.info.kind !== "owner") throw new HttpError(403, "Only the owner's chat can do this");
      };
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
        case "/send": {
          only(body, ["text", "to", "dedupeKey", "sessionId"]);
          ownerOnly(false);
          live();
          const { to, dedupeKey } = body;
          if (!text(body.text, 12_000) || !text(to, 100) || !text(dedupeKey, 200)) throw new HttpError(400, "Invalid request");
          const target = registry.bySlugName(to);
          if (!target) throw new HttpError(404, "Unknown chat");
          const id = `send:${hash(`${target.info.slug}:${dedupeKey}`)}`;
          let created: boolean;
          try { created = target.store.enqueue({ id, kind: "conversation", text: body.text }); }
          catch { throw new HttpError(409, "Operation could not be completed"); }
          return reply(created ? 202 : 200, { id, created });
        }
        case "/wake": {
          only(body, ["text", "chat", "source", "dedupeKey", "sessionId"]);
          ownerOnly(false);
          live();
          const { chat, dedupeKey } = body;
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
          const inbound = registry.all().some(chat =>
            chat.store.db.query<{ id: string }, [string]>("SELECT id FROM inbound WHERE id = ?").get(target));
          if (!inbound) throw new HttpError(403, "Forbidden");
          await options.line.react(target, kind);
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
        case "/ask-owner": {
          only(body, ["text", "sessionId", "dedupeKey"]);
          live();
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
          ownerOnly(true);
          return reply(200, { chats: registry.all().map(chat => ({
            slug: chat.info.slug, title: chat.info.title, kind: chat.info.kind,
            ...(registry.lastActivity(chat) === undefined ? {} : { lastActivityAt: registry.lastActivity(chat) }),
          })) });
        }
        default:
          return reply(404, { error: "Not found" });
      }
    } catch (error) {
      if (error instanceof HttpError) return reply(error.status, { error: error.message });
      if (error instanceof LineError) return reply(502, { error: "Sendblue request failed" });
      return reply(500, { error: "Internal error" });
    }
  };
}
