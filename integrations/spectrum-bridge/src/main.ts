import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { connect } from "node:net";
import { join } from "node:path";
import { createApi } from "./api.ts";
import { startAppsServer } from "./apps.ts";
import { Delivery } from "./delivery.ts";
import { alertSkillPath, loadConfig, skillPath, stateRoot, telegramBridgeSocket, transportKind } from "./config.ts";
import { ingest } from "./ingress.ts";
import { acquireLock } from "./lock.ts";
import { backendKind, createBackend } from "./backend.ts";
import { RobobBackend, retireUnresolvedRoute } from "./robob.ts";
import { backfillOrigins, OriginBackfill } from "./origin-backfill.ts";
import { canonicalOwnerChat, Photon } from "./photon.ts";
import { publish } from "./publish.ts";
import { Router } from "./router.ts";
import { serveSendblue } from "./sb-main.ts";
import { sweepSecrets } from "./secrets.ts";
import { Store } from "./store.ts";
import { transcribe } from "./stt.ts";
import { socketPost, telegramOutlet } from "./telegram-fallback.ts";
import { createAttachmentRecovery } from "./local-attachments.ts";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

// Only fixed event names and safe codes enter logs; never exception bodies or message text.
function log(event: string, code?: string): void {
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...(code ? { code } : {}) }));
}
function errorCode(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" && /^[a-zA-Z0-9_]{1,60}$/.test(code) ? code : "operationFailed";
}

async function cloudRequest(path: string, body?: unknown): Promise<any> {
  const id = process.env.SPECTRUM_PROJECT_ID!;
  const secret = process.env.SPECTRUM_PROJECT_SECRET!;
  const response = await fetch(`https://spectrum.photon.codes/projects/${encodeURIComponent(id)}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    proxy: "", verbose: false,
    redirect: "error", signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Photon HTTP ${response.status}`);
  const result = await response.json() as any;
  if (!result.succeed) throw new Error("Photon request rejected");
  return result.data;
}

async function removeStaleSocket(path: string): Promise<void> {
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
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
  // Sendblue owns its own serve loop; branching before Photon is built leaves the Photon path untouched.
  if (transportKind(config) === "sendblue") return serveSendblue(config, mode, { log, errorCode, removeStaleSocket });
  const photon = new Photon(process.env.SPECTRUM_PROJECT_ID ?? "", process.env.SPECTRUM_PROJECT_SECRET ?? "");
  const kind = backendKind(process.env, config);
  const backend = await createBackend(kind, config);
  if (mode === "check" || mode === "pair") {
    try {
      await photon.check();
      const billing = await cloudRequest("/billing/subscription");
      const health = await backend.health();
      if (billing.tier !== "pro" || billing.status !== "active") throw new Error("Active Pro plan required");
      if (health?.status !== "ok" || typeof health.openchamberVersion !== "string") throw new Error("Backend not healthy");
      if (backend instanceof RobobBackend && !await backend.chatRootRegistered()) throw new Error("iMessage chat root is not a Robob project");
      log("checks-passed");
      if (mode === "pair") {
        const user = await cloudRequest("/users/", { type: "shared", phoneNumber: config.owner });
        if (user.phoneNumber !== config.owner || !/^\+[1-9]\d{6,14}$/.test(user.assignedPhoneNumber)) {
          throw new Error("Unexpected owner assignment");
        }
        // This is the public contact the owner needs to message, not an authentication secret.
        console.log(JSON.stringify({ assignedPhoneNumber: user.assignedPhoneNumber, sentMessages: 0 }));
      } else {
        console.log(JSON.stringify({ plan: "pro", backend: kind, backendVersion: health?.openchamberVersion, enabled: config.enabled }));
      }
    } finally { await photon.close(); }
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
  // Retire only unsent legacy observer output. Agent-authored notify:* operations are untouched.
  store.db.query("UPDATE outbox SET state = 'cancelled' WHERE id LIKE 'juno:%' AND state IN ('pending', 'uncertain', 'failed')").run();
  const projectScope = hash(process.env.SPECTRUM_PROJECT_ID!);
  const identity = { project: projectScope, owner: config.owner };
  const previousIdentity = store.get<typeof identity>("identity");
  if (previousIdentity && JSON.stringify(previousIdentity) !== JSON.stringify(identity)) {
    throw new Error("Stored identity changed; explicit migration required");
  }
  store.set("identity", identity);
  if (store.get<number>("bootstrapCutoff") === undefined) store.set("bootstrapCutoff", Date.now());
  log("backend-selected", kind);
  let stopping = false;
  let synchronized = false;
  let controlsPending = true;
  let ingressRevision = 0;
  let router: Router | undefined;
  let chatGuid = store.get<string>("chatGuid");
  let paired = store.get<boolean>("paired") === true;
  if (chatGuid) { chatGuid = canonicalOwnerChat(chatGuid, config.owner); store.set("chatGuid", chatGuid); }
  const recoverAttachment = createAttachmentRecovery({
    rememberedChat: { get: () => store.get<number>("imsgChatId"), set: id => store.set("imsgChatId", id) },
  });
  const makeRouter = () => chatGuid ? new Router(store, backend, photon, {
    ...config, chatGuid, skillPath, alertSkillPath, alertSocketPath: telegramBridgeSocket,
    transcribe: input => transcribe(input), log, recoverAttachment,
  }) : undefined;
  router = makeRouter();
  const health = { photonLastOk: 0, backendLastOk: 0, lastError: "", startedAt: Date.now() };
  const ready = () => config.enabled && paired && synchronized;
  // Mini-app hosting is optional; a busy port or unwritable root must not stop messaging.
  let apps: ReturnType<typeof startAppsServer> | undefined;
  let appsUrl: string | undefined;
  const secretDeps = { store, stateRoot };
  try {
    await mkdir(config.appsRoot, { recursive: true, mode: 0o700 });
    apps = startAppsServer(config.appsRoot, config.appsPort, secretDeps);
    log("apps-listening");
  } catch (error) {
    log("apps-unavailable", errorCode(error));
  }
  // The tailscale CLI can hang (e.g. a stuck launch), which would time out every secure form.
  // Remember the last verified URL for this apps port and fall back to it when publishing stalls.
  const PUBLISH_WAIT_MS = 6_000;
  const publishApps = async () => {
    if (!apps) throw new Error("Apps server unavailable");
    const saved = store.get<{ port: number; url: string } | null>("appsPublished");
    const known = saved?.port === apps.port ? saved.url : undefined;
    const attempt = publish(apps.port).then(({ url }) => {
      store.set("appsPublished", { port: apps!.port, url });
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
  api = createApi({ store, photon, router: () => router, chatGuid: () => chatGuid,
    ...(apps ? { secrets: { stateRoot, publishApps } } : {}),
    enabled: ready, health: () => ({
      status: Date.now() - health.photonLastOk < 60_000 && Date.now() - health.backendLastOk < 60_000 ? "healthy" : "degraded",
      photonConnected: Date.now() - health.photonLastOk < 60_000,
      openchamberConnected: Date.now() - health.backendLastOk < 60_000,
      uptimeSeconds: Math.floor((Date.now() - health.startedAt) / 1000),
      lastEventAt: health.photonLastOk,
      catchingUp: !synchronized,
      ...(appsUrl ? { appsUrl } : {}),
      appsRoot: config.appsRoot,
    }) });
  // Outage alerts and the Telegram copy of stuck images and cards go through the telegram bridge.
  const outlet = telegramOutlet({
    post: socketPost(telegramBridgeSocket), appsRoot: config.appsRoot,
    appsUrl: () => store.get<{ port: number; url: string } | null>("appsPublished")?.url,
    blob: sha256 => store.getBlob(sha256),
  });
  const delivery = new Delivery(store, photon, { projectScope, chatGuid: () => chatGuid,
    beforeSend: async item => router?.beforeSend(item) ?? "send",
    enabled: () => ready() && !controlsPending && !stopping, log,
    ...(config.enabled ? outlet : {}) });
  delivery.recover();

  async function receive(): Promise<void> {
    let backoff = 2_000;
    while (!stopping) {
      try {
        let complete = false;
        for await (const event of photon.catchUp(store.get<number>("photonCursor"))) {
          if (stopping) break;
          if (ingest(store, event, config.owner, config.enabled)) {
            ingressRevision++;
            controlsPending = true;
            chatGuid = store.get<string>("chatGuid");
            paired = true;
            router ??= makeRouter();
          }
          if (event.type === "catchup.complete") { complete = true; break; }
        }
        if (!complete) throw new Error("Catch-up ended without completion");
        synchronized = true;
        health.photonLastOk = Date.now();
        backoff = 2_000;
        await sleep(2_000);
      } catch (error) {
        synchronized = false;
        controlsPending = true;
        health.lastError = errorCode(error);
        log("receive-unavailable", health.lastError);
        await sleep(backoff);
        backoff = Math.min(60_000, backoff * 2);
      }
    }
  }
  // Sessions created before OpenChamber learned the iMessage origin are marked
  // in small background passes; inbound handling never waits on them.
  const originBackfill = new OriginBackfill(() => backfillOrigins(store, backend, undefined,
    // Robob keeps origins in its own table, so sessions marked in OpenChamber are marked again there.
    kind === "robob" ? "robob-origin-marked:" : undefined), log);
  async function tick(): Promise<void> {
    let backendCheckedAt = 0;
    let secretsSweptAt = 0;
    let routeCheckedAt = 0;
    while (!stopping) {
      // Runs even when messaging is not ready: submitted values must still expire on time.
      if (Date.now() - secretsSweptAt >= 30_000) {
        secretsSweptAt = Date.now();
        await sweepSecrets(secretDeps).catch(() => log("secret-sweep-failed"));
      }
      if (!originBackfill.done) void originBackfill.kick();
      if (backend instanceof RobobBackend && ready() && !router?.status().activeTurn && Date.now() - routeCheckedAt >= 30_000) {
        routeCheckedAt = Date.now();
        // A stored ses_ route the OpenCode import never mapped starts a fresh chat instead of stalling.
        if (await retireUnresolvedRoute(store, backend).catch(() => false)) log("route-unresolved-retired");
      }
      if (ready()) {
        const revision = ingressRevision;
        try {
          await router?.tick();
          if (revision === ingressRevision && synchronized) controlsPending = false;
        } catch { log("router-tick-failed"); }
        if (Date.now() - backendCheckedAt >= 30_000) {
          backendCheckedAt = Date.now();
          await backend.health().then(() => { health.backendLastOk = Date.now(); }, () => {});
        }
      }
      await sleep(1_000);
    }
  }
  const timer = setInterval(() => {
    void delivery.tick().catch(() => log("sender-failed"));
  }, 1_000);
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    await server.stop(true);
    await apps?.stop().catch(() => {});
    if (chatGuid) await photon.typing(chatGuid, false).catch(() => {});
    await photon.close();
    // In-flight rows are intentionally recovered on the next startup rather than marked successful.
    process.exit(0);
  };
  process.once("SIGTERM", () => { void stop(); });
  process.once("SIGINT", () => { void stop(); });
  log(config.enabled ? "bridge-awaiting-owner" : "bridge-disabled");
  await Promise.all([receive(), tick()]);
}

if (import.meta.main) main().catch(error => { log("bridge-start-failed", errorCode(error)); process.exit(1); });
