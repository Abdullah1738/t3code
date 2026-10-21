/**
 * Sendblue serve loop. Kept apart from main.ts so the Photon path stays exactly as it was:
 * main.ts hands over before it constructs Photon.
 */
import { chmod, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { accessPath, accessReloader, emptyAccess } from "./access.ts";
import { createApi } from "./api.ts";
import { startAppsServer } from "./apps.ts";
import { backendKind, createBackend } from "./backend.ts";
import type { Access } from "./chats.ts";
import { alertSkillPath, skillPath, stateRoot, telegramBridgeSocket, type Config } from "./config.ts";
import { Delivery } from "./delivery.ts";
import type { Line, LineEvent } from "./line.ts";
import { acquireLock } from "./lock.ts";
import type { ChatBackend } from "./openchamber.ts";
import type { Photon } from "./photon.ts";
import { publish } from "./publish.ts";
import { RobobBackend, retireUnresolvedRoute } from "./robob.ts";
import { Router } from "./router.ts";
import { ChatRegistry, createSbApi, type ChatCore } from "./runtime.ts";
import { runIngress } from "./sb-ingress.ts";
import { sbTransport } from "./sb-transport.ts";
import { GuestDesk } from "./guest-desk.ts";
import { flightyDb } from "./guest-flight.ts";
import { DEFAULT_GUEST_EFFORT, DEFAULT_GUEST_MODEL, GuestResponder, openRouterComplete } from "./guest-responder.ts";
import { GuestBook } from "./guests.ts";
import { getSecretRequest, sweepSecrets } from "./secrets.ts";
import { cloudflaredTunnel, Shares } from "./share.ts";
import { Sendblue } from "./sendblue.ts";
import { Store } from "./store.ts";
import { transcribe } from "./stt.ts";
import { socketPost, telegramOutlet } from "./telegram-fallback.ts";

export type MainIo = {
  log: (event: string, code?: string) => void;
  errorCode: (error: unknown) => string;
  removeStaleSocket: (path: string) => Promise<void>;
};

type Parts = { router: Router; delivery: Delivery; api: (request: Request) => Promise<Response>; backend: ChatBackend; busy: boolean };

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

export function sendblueLine(config: Config, env: Record<string, string | undefined> = process.env): Sendblue {
  const keyId = env.SENDBLUE_API_KEY_ID ?? "";
  const secret = env.SENDBLUE_API_SECRET ?? "";
  const number = config.sendblueNumber ?? "";
  if (!keyId || !secret || !/^\+[1-9]\d{6,14}$/.test(number)) throw new Error("Sendblue credentials or line number missing");
  return new Sendblue({ keyId, secret, number, ...(config.cardApp ? { cardApp: config.cardApp } : {}) });
}

/**
 * Wraps the line so health can see the stream: a finished backfill means caught up, and any
 * event means the connection is alive. Explicit delegation keeps Sendblue's private fields intact.
 */
function observedLine(line: Line, seen: { synchronized: boolean; lastEventAt: number }): Line {
  return {
    get number() { return line.number; },
    async *events(signal: AbortSignal): AsyncIterable<LineEvent> {
      for await (const event of line.events(signal)) {
        seen.lastEventAt = Date.now();
        yield event;
      }
    },
    backfill: async sinceMs => {
      const messages = await line.backfill(sinceMs);
      seen.synchronized = true;
      seen.lastEventAt = Date.now();
      return messages;
    },
    outbound: (chat, sinceMs) => line.outbound(chat, sinceMs),
    sendText: (chat, text, options) => line.sendText(chat, text, options),
    upload: file => line.upload(file),
    getMessage: handle => line.getMessage(handle),
    sendApp: (chat, card) => line.sendApp(chat, card),
    react: (handle, reaction) => line.react(handle, reaction),
    typing: (chat, options) => line.typing(chat, options),
    read: chat => line.read(chat),
    requestLocation: chat => line.requestLocation(chat),
    location: address => line.location(address),
    download: (url, maxBytes, timeoutMs) => line.download(url, maxBytes, timeoutMs),
  };
}

export async function serveSendblue(config: Config, mode: string, io: MainIo): Promise<void> {
  const { log, errorCode } = io;
  const line = sendblueLine(config);
  const kind = backendKind(process.env, config);
  const backend = await createBackend(kind, config);
  if (mode === "check" || mode === "pair") {
    const health = await backend.health();
    if (health?.status !== "ok") throw new Error("Backend not healthy");
    if (backend instanceof RobobBackend && !await backend.chatRootRegistered()) throw new Error("iMessage chat root is not a Robob project");
    log("checks-passed");
    // Sendblue has no pairing step: the owner just texts the line.
    console.log(JSON.stringify({ transport: "sendblue", line: line.number, backend: kind, enabled: config.enabled }));
    return;
  }

  let api: ((request: Request) => Promise<Response>) | undefined;
  const releaseLock = acquireLock(join(stateRoot, "bridge.lock"));
  process.once("exit", releaseLock);
  const socketPath = join(stateRoot, "bridge.sock");
  await io.removeStaleSocket(socketPath);
  // Bind before opening SQLite: a second process must not run crash recovery on live sends.
  const server = Bun.serve({
    unix: socketPath,
    maxRequestBodySize: 28 * 1024 * 1024,
    fetch: request => api ? api(request) : Response.json({ error: "Bridge starting" }, { status: 503 }),
  });
  await chmod(socketPath, 0o600);
  const ownerStore = new Store(join(stateRoot, "state.sqlite"));
  // A separate key from Photon's "identity", so rolling back to Photon still starts.
  const identity = { line: line.number, owner: config.owner };
  const previousIdentity = ownerStore.get<typeof identity>("sendblueIdentity");
  if (previousIdentity && JSON.stringify(previousIdentity) !== JSON.stringify(identity)) {
    throw new Error("Stored identity changed; explicit migration required");
  }
  ownerStore.set("sendblueIdentity", identity);
  log("backend-selected", kind);
  log("transport-selected", "sendblue");

  const projectScope = hash(`sendblue:${line.number}`);
  const accessFile = accessPath(stateRoot);
  const reload = accessReloader(accessFile);
  let access: Access = emptyAccess;
  const refreshAccess = async () => { access = await reload().catch(() => access); };
  await refreshAccess();

  let stopping = false;
  const seen = { synchronized: false, lastEventAt: 0 };
  const health = { backendLastOk: 0, startedAt: Date.now() };
  const ready = () => config.enabled && seen.synchronized;
  const observed = observedLine(line, seen);

  let apps: ReturnType<typeof startAppsServer> | undefined;
  let appsUrl: string | undefined;
  let registry: ChatRegistry<Parts> | undefined;
  try {
    await mkdir(config.appsRoot, { recursive: true, mode: 0o700 });
    // Secure forms resolve to the chat that issued the token, so the value lands in that chat's store.
    apps = startAppsServer(config.appsRoot, config.appsPort,
      token => registry?.all().find(chat => getSecretRequest(chat.store, token))?.secretDeps);
    log("apps-listening");
  } catch (error) {
    log("apps-unavailable", errorCode(error));
  }
  const PUBLISH_WAIT_MS = 6_000;
  const publishApps = async () => {
    if (!apps) throw new Error("Apps server unavailable");
    const saved = ownerStore.get<{ port: number; url: string } | null>("appsPublished");
    const known = saved?.port === apps.port ? saved.url : undefined;
    const attempt = publish(apps.port).then(({ url }) => {
      ownerStore.set("appsPublished", { port: apps!.port, url });
      appsUrl = url;
      return url;
    });
    if (!known) return attempt;
    attempt.catch(error => log("apps-publish-failed", errorCode(error)));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fallback = new Promise<string>(resolve => { timer = setTimeout(() => resolve(known), PUBLISH_WAIT_MS); });
    try {
      appsUrl = await Promise.race([attempt.catch(() => known), fallback]);
      return appsUrl;
    } finally { clearTimeout(timer); }
  };
  const shares = new Shares({ store: ownerStore, appsRoot: config.appsRoot, startTunnel: cloudflaredTunnel(), log });
  process.once("exit", () => shares.killAll());
  void shares.restore().catch(() => log("share-sweep-failed"));
  const post = socketPost(telegramBridgeSocket);
  const outlet = telegramOutlet({
    post, appsRoot: config.appsRoot,
    appsUrl: () => ownerStore.get<{ port: number; url: string } | null>("appsPublished")?.url,
    blob: sha256 => ownerStore.getBlob(sha256),
  });

  const build = (chat: ChatCore): Parts => {
    const isOwner = chat.info.kind === "owner";
    const chatBackend = !isOwner && backend instanceof RobobBackend
      ? backend.forChat(`chats/${chat.info.slug}`, chat.info.title) : backend;
    const transport = sbTransport(observed, chat.info.key, chat.store);
    // getMessage may resolve undefined for an unknown handle; the router's reply lookup already treats a throw there as unavailable.
    const router = new Router(chat.store, chatBackend, transport as unknown as ConstructorParameters<typeof Router>[2], {
      ...config, chatGuid: chat.info.key, skillPath, alertSkillPath, alertSocketPath: telegramBridgeSocket,
      transcribe: input => transcribe(input), log, context: chat.context,
    });
    const delivery = new Delivery(chat.store, transport, {
      projectScope, chatGuid: () => chat.info.key,
      beforeSend: async item => router.beforeSend(item),
      enabled: () => ready() && !chat.controlsPending && !stopping, log,
      // Outage alerts only for the owner's chat; other chats must not page the owner per message.
      ...(config.enabled && isOwner ? outlet : {}),
    });
    delivery.recover();
    const chatApi = createApi({
      store: chat.store,
      photon: { react: (_chat, target, reaction) => line.react(target, reaction) } satisfies Pick<Photon, "react">,
      router: () => router, chatGuid: () => chat.info.key,
      ...(apps ? { secrets: { stateRoot: chat.stateRoot, publishApps } } : {}),
      enabled: ready, health: () => ({}),
    });
    return { router, delivery, api: chatApi, backend: chatBackend, busy: false };
  };
  registry = new ChatRegistry<Parts>({ line, owner: config.owner, ownerStore, stateRoot, access: () => access, build });
  registry.restore();
  const chats = registry;

  // Scoped third parties: grants in guests.json, audit in guests-audit.jsonl (guests.ts).
  const guestBook = new GuestBook(stateRoot);
  const wakeOwner = (text: string, key: string) => { chats.wake(chats.owner, text, key); };
  /** A plain bridge line into the owner's chat, no agent turn. */
  const tellOwner = (text: string, key: string) => {
    try { chats.owner.store.enqueue({ id: `guest-note:${hash(key)}`, kind: "conversation", text }); } catch { log("guest-note-failed"); }
  };
  const shareContact = (address: string) => line.shareContact(address);
  const flights = flightyDb();
  const guestResponder = new GuestResponder({
    line: observed, store: ownerStore, book: guestBook, wakeOwner, tellOwner, timezone: config.timezone, log, flights,
    complete: openRouterComplete(config.guestModel ?? DEFAULT_GUEST_MODEL, config.guestEffort ?? DEFAULT_GUEST_EFFORT),
    shareContact: async address => { await shareContact(address); },
  });
  const guestDesk = new GuestDesk({
    book: guestBook, responder: guestResponder, ownerStore, owner: config.owner, lineNumber: line.number,
    providerDeps: { timezone: config.timezone, flights },
    sendText: (chat, text) => observed.sendText(chat, text), shareContact, wakeOwner, tellOwner, log,
    note: async (address, text) => { await post("/notify", { source: "iMessage bridge", severity: "info", text, dedupeKey: `sb-guest:${address}` }); },
  });

  api = createSbApi({
    registry: chats, line, accessPath: accessFile, enabled: ready, reloadAccess: refreshAccess, guests: guestDesk, shares,
    health: () => {
      const backendOk = Date.now() - health.backendLastOk < 60_000;
      // The event stream heartbeats below the Line API, so a quiet line is not a dead one; backfill success is the signal.
      return {
        status: backendOk && seen.synchronized ? "healthy" : "degraded",
        transport: "sendblue", line: line.number, chats: chats.all().length,
        lastEventAt: seen.lastEventAt, connected: seen.synchronized, openchamberConnected: backendOk,
        uptimeSeconds: Math.floor((Date.now() - health.startedAt) / 1000),
        catchingUp: !seen.synchronized, enabled: config.enabled, paired: true, ready: ready(),
        ...(appsUrl ? { appsUrl } : {}), appsRoot: config.appsRoot,
      };
    },
  });

  // Unknown senders: one Telegram note per address, so the owner can allow them.
  const note = async (address: string, text: string) => {
    await post("/notify", { source: "iMessage bridge", severity: "info", text, dedupeKey: `sb-note:${address}` });
  };
  const abort = new AbortController();
  const ingress = runIngress({
    line: observed, owner: config.owner, ownerStore, access: async () => access,
    sink: chats.sink(note, () => config.enabled, message => guestDesk.unknown(message)), log,
  }, abort.signal);

  async function tick(): Promise<void> {
    let backendCheckedAt = 0;
    let secretsSweptAt = 0;
    let routeCheckedAt = 0;
    let flightsCheckedAt = 0;
    let sharesSweptAt = Date.now();
    while (!stopping) {
      await refreshAccess();
      if (Date.now() - sharesSweptAt >= 30_000) {
        sharesSweptAt = Date.now();
        void shares.sweep().catch(() => log("share-sweep-failed"));
      }
      if (Date.now() - secretsSweptAt >= 30_000) {
        secretsSweptAt = Date.now();
        for (const chat of chats.all()) await sweepSecrets(chat.secretDeps).catch(() => log("secret-sweep-failed"));
      }
      if (ready() && Date.now() - flightsCheckedAt >= 60_000) {
        flightsCheckedAt = Date.now();
        await guestResponder.flightTick().catch(() => log("guest-flight-tick-failed"));
      }
      if (ready() && Date.now() - routeCheckedAt >= 30_000) {
        routeCheckedAt = Date.now();
        for (const chat of chats.all()) {
          const chatBackend = chat.parts.backend;
          if (!(chatBackend instanceof RobobBackend) || chat.parts.router.status().activeTurn) continue;
          if (await retireUnresolvedRoute(chat.store, chatBackend).catch(() => false)) log("route-unresolved-retired");
        }
      }
      if (ready()) {
        // Chats tick independently so one slow turn never holds up another chat.
        for (const chat of chats.all()) {
          if (chat.parts.busy) continue;
          chat.parts.busy = true;
          const revision = chat.revision;
          void chat.parts.router.tick().then(() => {
            if (revision === chat.revision && seen.synchronized) chat.controlsPending = false;
          }, () => log("router-tick-failed")).finally(() => { chat.parts.busy = false; });
        }
        if (Date.now() - backendCheckedAt >= 30_000) {
          backendCheckedAt = Date.now();
          await backend.health().then(() => { health.backendLastOk = Date.now(); }, () => {});
        }
      }
      await sleep(1_000);
    }
  }
  const timer = setInterval(() => {
    for (const chat of chats.all()) void chat.parts.delivery.tick().catch(() => log("sender-failed"));
  }, 1_000);
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    abort.abort();
    clearInterval(timer);
    await server.stop(true);
    await apps?.stop().catch(() => {});
    await shares.stopAll().catch(() => {});
    // In-flight rows are intentionally recovered on the next startup rather than marked successful.
    process.exit(0);
  };
  process.once("SIGTERM", () => { void stop(); });
  process.once("SIGINT", () => { void stop(); });
  log(config.enabled ? "bridge-awaiting-owner" : "bridge-disabled");
  await Promise.all([ingress, tick()]);
}
