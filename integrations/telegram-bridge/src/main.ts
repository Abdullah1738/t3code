import { chmod, lstat, unlink } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";
import { createApi } from "./api.ts";
import { Attention } from "./attention.ts";
import { backendConnection, backendKind, loadConfig, spectrumBridgeSocket, stateRoot } from "./config.ts";
import { Delivery } from "./delivery.ts";
import { ControlClient } from "./control.ts";
import { acquireLock } from "./lock.ts";
import { OpenChamber, type AlertBackend } from "./openchamber.ts";
import { RobobAlertBackend } from "./robob.ts";
import { Store } from "./store.ts";
import { Telegram } from "./telegram.ts";
import { toolError, toolLog } from "./toollog.ts";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Only fixed event names and safe codes enter logs; never exception bodies or message text.
function log(event: string, code?: string): void {
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...(code ? { code } : {}) }));
}
function errorCode(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" && /^[a-zA-Z0-9_]{1,60}$/.test(code) ? code : "operationFailed";
}

async function removeStaleSocket(path: string): Promise<void> {
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") toolLog({ component: "telegram", kind: "event", name: "tg.main.socketAbsent", ok: true });
    else { toolError("telegram", "tg.main.socketStat", undefined, error); throw error; }
  });
  if (!info) return;
  if (!info.isSocket() || info.uid !== process.getuid?.()) throw new Error("Unsafe socket path");
  const stale = await new Promise<boolean>((resolve, reject) => {
    const socket = connect(path);
    socket.once("connect", () => { socket.destroy(); resolve(false); });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNREFUSED") resolve(true);
      else reject(new Error("Could not verify old bridge socket"));
    });
    socket.setTimeout(1_000, () => { socket.destroy(); reject(new Error("Old bridge socket is busy")); });
  });
  if (!stale) throw new Error("Bridge is already running");
  const current = await lstat(path);
  if (current.ino !== info.ino) throw new Error("Bridge socket changed");
  await unlink(path);
}

async function main(): Promise<void> {
  process.umask(0o077);
  const config = await loadConfig();
  const mode = process.argv[2] ?? "serve";
  if (!["serve", "check", "pair"].includes(mode)) throw new Error("Unknown bridge command");
  const token = process.env.TELEGRAM_BOT_TOKEN ?? "";
  const telegram = new Telegram(token, config.owner);
  const kind = backendKind(process.env, config);
  const backend: AlertBackend = kind === "robob" ? new RobobAlertBackend({ log })
    : await backendConnection().then(connection => new OpenChamber(connection.baseUrl, connection.headers));
  if (mode === "check" || mode === "pair") {
    try {
      const me = await telegram.check();
      const health = await backend.health();
      if (health?.status !== "ok" || typeof health.openchamberVersion !== "string") throw new Error("Backend not healthy");
      log("checks-passed");
      if (mode === "pair") {
        console.log(JSON.stringify({
          bot: me.username,
          ownerConfigured: config.owner !== "",
          instructions: config.owner === ""
            ? "Send /start to the bot from the owner Telegram account, copy the numeric user ID it replies with into config.json as \"owner\", then restart the bridge."
            : "Send /start to the bot from the owner Telegram account to bind the chat. No other account is accepted.",
        }));
      } else {
        console.log(JSON.stringify({ backend: kind, backendVersion: health?.openchamberVersion, enabled: config.enabled, ownerConfigured: config.owner !== "" }));
      }
    } finally { await telegram.stop(); }
    return;
  }

  let api: ReturnType<typeof createApi> | undefined;
  const releaseLock = acquireLock(join(stateRoot, "bridge.lock"));
  process.once("exit", releaseLock);
  const socketPath = join(stateRoot, "bridge.sock");
  await removeStaleSocket(socketPath);
  // Bind before opening SQLite: a second process must not run crash recovery on live sends.
  const server = Bun.serve({
    unix: socketPath,
    maxRequestBodySize: 28 * 1024 * 1024,
    fetch: request => api ? api(request) : Response.json({ error: "Bridge starting" }, { status: 503 }),
  });
  await chmod(socketPath, 0o600);
  const store = new Store(join(stateRoot, "state.sqlite"));
  const identity = { bridge: "telegram", owner: config.owner };
  const previousIdentity = store.get<typeof identity>("identity");
  if (previousIdentity && JSON.stringify(previousIdentity) !== JSON.stringify(identity)) {
    throw new Error("Stored identity changed; explicit migration required");
  }
  store.set("identity", identity);
  const shutdown = new AbortController();
  let stopping = false;
  let chatId = store.get<number>("chatId");
  let paired = chatId !== undefined;
  const health = { telegramLastOk: 0, backendLastOk: 0, lastError: "", startedAt: Date.now() };
  const ready = () => config.enabled && paired;
  api = createApi({ store, enabled: ready, chatId: () => chatId, timezone: config.timezone, health: () => ({
    status: Date.now() - health.telegramLastOk < 90_000 && Date.now() - health.backendLastOk < 90_000 ? "healthy" : "degraded",
    telegramConnected: Date.now() - health.telegramLastOk < 90_000,
    openchamberConnected: Date.now() - health.backendLastOk < 90_000,
    uptimeSeconds: Math.floor((Date.now() - health.startedAt) / 1_000),
    lastEventAt: health.telegramLastOk,
    lastError: health.lastError,
    board: backend.boardStatus?.(),
  }) });
  const attention = new Attention(store, backend, telegram, {
    chatId: () => chatId,
    spectrumSocket: spectrumBridgeSocket,
    log,
  });
  const delivery = new Delivery(store, telegram, {
    chatId: () => chatId,
    enabled: () => ready() && !stopping,
    beforeSend: item => attention.beforeSend(item),
    askNotified: (key, at) => new ControlClient().askNotified(key, at),
    log,
  });
  delivery.recover();

  async function updates(): Promise<void> {
    await telegram.start({
      onBound: boundChat => {
        if (chatId === boundChat) return;
        store.set("chatId", boundChat);
        chatId = boundChat;
        paired = true;
        log("owner-bound");
      },
      onMessage: async update => {
        health.telegramLastOk = Date.now();
        await attention.handleUpdate(update);
      },
      log,
    });
  }
  async function ping(): Promise<void> {
    while (!stopping) {
      const ok = await telegram.ping().catch(error => { toolError("telegram", "tg.main.ping", undefined, error); return false; });
      if (ok) health.telegramLastOk = Date.now();
      else if (!stopping) log("telegram-unavailable");
      await sleep(30_000);
    }
  }
  async function events(path: "/api/event" | "/api/openchamber/events"): Promise<void> {
    if (!(backend instanceof OpenChamber)) return;
    while (!stopping) {
      try {
        for await (const event of backend.events(path, shutdown.signal)) {
          if (stopping) break;
          health.backendLastOk = Date.now();
          attention.processEvent(event);
        }
      } catch (error) { toolError("telegram", "tg.main.backendEvents", undefined, error); if (!stopping) log("backend-events-unavailable"); }
      if (!stopping) await sleep(5_000);
    }
  }
  async function controlEvents(): Promise<void> {
    if (!(backend instanceof RobobAlertBackend)) return;
    // The control stream's keepalives are SSE comments, so a quiet stream proves nothing; check health directly.
    const healthTimer = setInterval(() => {
      void backend.health().then(() => { health.backendLastOk = Date.now(); }, error => { toolError("telegram", "tg.main.backendHealth", undefined, error); });
    }, 30_000);
    shutdown.signal.addEventListener("abort", () => clearInterval(healthTimer), { once: true });
    while (!stopping) {
      try {
        for await (const event of backend.notifications(shutdown.signal, () => { health.backendLastOk = Date.now(); })) {
          if (stopping) break;
          health.backendLastOk = Date.now();
          attention.processNotification(event);
        }
      } catch (error) { toolError("telegram", "tg.main.controlEvents", undefined, error); if (!stopping) log("backend-events-unavailable"); }
      if (!stopping) await sleep(5_000);
    }
  }
  const timer = setInterval(() => {
    if (ready()) store.enqueueDueReminders(Date.now());
    void delivery.tick().catch(error => { toolError("telegram", "tg.main.senderTick", undefined, error); log("sender-failed"); });
  }, 1_000);
  const attentionTimer = setInterval(() => {
    if (ready()) void attention.tick().catch(error => { toolError("telegram", "tg.main.attentionTick", undefined, error); log("attention-unavailable"); });
  }, 5_000);
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    shutdown.abort();
    clearInterval(timer);
    clearInterval(attentionTimer);
    attention.stop();
    await server.stop(true);
    await telegram.stop();
    // In-flight rows are intentionally recovered on the next startup rather than marked successful.
    process.exit(0);
  };
  process.once("SIGTERM", () => { void stop(); });
  process.once("SIGINT", () => { void stop(); });
  log("backend-selected", kind);
  log(config.enabled ? "bridge-awaiting-owner" : "bridge-disabled");
  // `/api/event` is OpenChamber's pass-through of OpenCode 2's single wire
  // stream; OpenChamber-owned events travel on `/api/openchamber/events`.
  await Promise.all([updates(), ping(), events("/api/event"), events("/api/openchamber/events"), controlEvents()]);
}

if (import.meta.main) main().catch(error => { toolError("telegram", "tg.main.startFailed", undefined, error); log("bridge-start-failed", errorCode(error)); process.exit(1); });
