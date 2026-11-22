import { chmodSync, closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";

export const ROUTER_KEY_ERROR = "router-key-unavailable";
export function routerConfig(config: { boxRouterPort?: unknown; macRouterPort?: unknown; boxLivezPort?: unknown; macLivezPort?: unknown; routerKeyFile?: unknown }) {
  const boxRouterPort = config.boxRouterPort === undefined ? 19465 : config.boxRouterPort, macRouterPort = config.macRouterPort === undefined ? 20128 : config.macRouterPort;
  const boxLivezPort = config.boxLivezPort === undefined ? 19466 : config.boxLivezPort, macLivezPort = config.macLivezPort === undefined ? 20129 : config.macLivezPort;
  const routerKeyFile = config.routerKeyFile === undefined ? "/home/user/person/secrets/9router-key" : config.routerKeyFile;
  if (![boxRouterPort, macRouterPort, boxLivezPort, macLivezPort].every(p => typeof p === "number" && Number.isInteger(p) && p >= 1024 && p <= 65535)
    || boxLivezPort === boxRouterPort
    || typeof routerKeyFile !== "string" || !isAbsolute(routerKeyFile) || /[\0\r\n]/.test(routerKeyFile)) throw new Error("Invalid router configuration");
  return { boxRouterPort: boxRouterPort as number, macRouterPort: macRouterPort as number,
    boxLivezPort: boxLivezPort as number, macLivezPort: macLivezPort as number, routerKeyFile };
}
export function readRouterKey(path: string): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid?.() || stat.size > 16384) throw new Error();
    const key = readFileSync(fd, "utf8").trim();
    if (!key || /[^\x21-\x7e]/.test(key)) throw new Error();
    return key;
  } catch { throw new Error(ROUTER_KEY_ERROR); }
  finally { if (fd !== undefined) closeSync(fd); }
}
type RouterFailure = { reason: "no_worker" | "not_ready" | "heartbeat_stale" | "shutting_down" | "unknown" | "timeout" | "unreachable" | "not_ready_body"; ms: number }
  | { reason: "bad_status"; ms: number; status: number };
type RouterOutcome = RouterFailure | { reason: "ready"; ms: number };
type RouterReadinessLog = ({ code: "router-unready" } & RouterFailure)
  | { code: "router-ready"; downMs: number; failures: number };

export function createRouterReadinessTracker(log: (event: RouterReadinessLog) => void, now: () => number = () => performance.now()) {
  let episode: { since: number; reason: RouterFailure["reason"]; failures: number } | undefined;
  return (outcome: RouterOutcome) => {
    if (outcome.reason === "ready") {
      if (episode) {
        const { since, failures } = episode; episode = undefined;
        log({ code: "router-ready", downMs: Math.round(now() - since), failures });
      }
      return;
    }
    const previousReason = episode?.reason;
    episode ??= { since: now(), reason: outcome.reason, failures: 0 };
    episode.failures++;
    episode.reason = outcome.reason;
    if (previousReason !== outcome.reason) {
      log(outcome.reason === "bad_status"
        ? { code: "router-unready", reason: outcome.reason, ms: outcome.ms, status: outcome.status }
        : { code: "router-unready", reason: outcome.reason, ms: outcome.ms });
    }
  };
}

export async function routerReady(config: ReturnType<typeof routerConfig>, track: (outcome: RouterOutcome) => void = () => {}, now: () => number = () => performance.now()): Promise<boolean> {
  const start = now(), signal = AbortSignal.timeout(1_500);
  let outcome: RouterOutcome;
  const elapsed = () => Math.round(now() - start);
  try {
    const response = await fetch(`http://127.0.0.1:${config.boxLivezPort}/livez`, { redirect: "manual", signal });
    try {
      if (response.status !== 200 && response.status !== 503) {
        outcome = { reason: "bad_status", status: response.status, ms: elapsed() };
      } else {
        let body: unknown;
        try { body = await response.json(); }
        catch (error) { if (!(error instanceof SyntaxError)) throw error; }
        const data = body && typeof body === "object" ? body as Record<string, unknown> : {};
        let reason: RouterOutcome["reason"];
        if (response.status === 503) {
          switch (data.reason) {
            case "no_worker": case "not_ready": case "heartbeat_stale": case "shutting_down": reason = data.reason; break;
            default: reason = "unknown";
          }
        } else reason = data.ready === true ? "ready" : "not_ready_body";
        outcome = { reason, ms: elapsed() };
      }
    } finally { await response.body?.cancel().catch(() => {}); }
  } catch (error) {
    const timeout = signal.aborted || error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name);
    outcome = { reason: timeout ? "timeout" : "unreachable", ms: elapsed() };
  }
  track(outcome);
  return outcome.reason === "ready";
}
async function shortResetMs(response: Response): Promise<number | undefined> {
  const after = response.headers.get("retry-after");
  let ms: number;
  if (after !== null) {
    ms = /^\d+(?:\.\d+)?$/.test(after) ? Number(after) * 1000
      : /^[A-Za-z]{3},/.test(after) ? Math.max(0, Date.parse(after) - Date.now()) : NaN;
  } else {
    const reader = response.clone().body?.getReader();
    if (!reader) return;
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if ((size += value.length) > 64 * 1024) return;
        chunks.push(value);
      }
      const bytes = Buffer.concat(chunks), encoding = response.headers.get("content-encoding");
      const text = (encoding === "gzip" ? gunzipSync(bytes, { maxOutputLength: 64 * 1024 })
        : encoding === "deflate" ? inflateSync(bytes, { maxOutputLength: 64 * 1024 })
        : encoding === "br" ? brotliDecompressSync(bytes, { maxOutputLength: 64 * 1024 }) : bytes).toString();
      const hint = /reset\s+after\s+(\d+(?:\.\d+)?)\s*(ms|s)\b/i.exec(text);
      if (!hint) return;
      ms = Number(hint[1]) * (hint[2]!.toLowerCase() === "ms" ? 1 : 1000);
    } catch { return; }
    finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
  return Number.isFinite(ms) && ms >= 0 && ms <= 10_000 ? ms : undefined;
}

/**
 * Without `bearer` the client must already send the router key as x-api-key (Claude's apiKeyHelper).
 * With `bearer` (a per-run token) the client is Antigravity: it never sees the router key, the gate
 * accepts only `Authorization: Bearer <token>` and forwards with the real key in its place.
 */
export function startRouterGate(config: ReturnType<typeof routerConfig>, unavailable: () => void, options: {
  bearer?: string;
  retry429?: { signal?: AbortSignal; onRetry: (count: number) => void; onExhausted: () => void };
} = {}) {
  // Claude can substitute an empty header when apiKeyHelper fails. Refuse before any prompt reaches the Mac.
  return Bun.serve({ hostname: "127.0.0.1", port: 0, maxRequestBodySize: 100 * 1024 * 1024, async fetch(request) {
    let key: string;
    try { key = readRouterKey(config.routerKeyFile); }
    catch { unavailable(); return Response.json({ error: ROUTER_KEY_ERROR }, { status: 503 }); }
    if (options.bearer !== undefined) {
      if (!options.bearer || request.headers.get("authorization") !== `Bearer ${options.bearer}`) return Response.json({ error: "gate-token" }, { status: 401 });
    } else if (request.headers.get("x-api-key") !== key) {
      unavailable(); return Response.json({ error: ROUTER_KEY_ERROR }, { status: 401 });
    }
    const url = new URL(request.url), headers = new Headers(request.headers);
    headers.delete("host"); headers.delete("authorization");
    if (options.bearer !== undefined) { headers.set("x-api-key", key); headers.set("x-goog-api-key", key); }
    const retry = options.retry429;
    const externalSignal = retry?.signal ? AbortSignal.any([request.signal, retry.signal]) : request.signal;
    const budget = new AbortController(), signal = AbortSignal.any([externalSignal, budget.signal]);
    let deadline = 0, timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Only opt-in clients buffer bodies. A stream is never forwarded twice.
      const buffered = retry && request.body ? await request.arrayBuffer() : undefined;
      for (let attempt = 1; ; attempt++) {
        const response = await fetch(`http://127.0.0.1:${config.boxRouterPort}${url.pathname}${url.search}`, {
          method: request.method, headers, body: buffered ?? request.body, redirect: "error", signal, decompress: false,
        });
        if (!retry || response.status !== 429) return response;
        deadline ||= performance.now() + 10_000;
        timer ??= setTimeout(() => budget.abort(), Math.max(0, deadline - performance.now()));
        const reset = attempt < 3 && buffered ? await shortResetMs(response) : undefined;
        if (reset === undefined || reset >= deadline - performance.now()) {
          retry.onExhausted();
          void response.body?.cancel().catch(() => {});
          return Response.json({ error: "router-retries-exhausted" }, { status: 503 });
        }
        retry.onRetry(attempt);
        await response.body?.cancel();
        await delay(reset, undefined, { signal });
      }
    } catch {
      if (deadline && !externalSignal.aborted) retry?.onExhausted();
      return Response.json({ error: "router-unavailable" }, { status: 503 });
    } finally { clearTimeout(timer); }
  } });
}
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
export function routerSettings(root: string, keyFile: string): string {
  const dir = join(root, "claude"); mkdirSync(dir, { recursive: true, mode: 0o700 }); chmodSync(dir, 0o700);
  const helper = join(dir, "9router-key-helper"), settings = join(dir, "router-settings.json");
  writeFileSync(helper, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(import.meta.path)} --key ${quote(keyFile)}\n`, { mode: 0o700 });
  chmodSync(helper, 0o700);
  writeFileSync(settings, JSON.stringify({ apiKeyHelper: quote(helper), fastMode: false }), { mode: 0o600 }); chmodSync(settings, 0o600);
  return settings;
}
if (import.meta.main) {
  try {
    const [mode, path] = process.argv.slice(2);
    if (mode === "--check-config") readRouterKey(routerConfig(JSON.parse(readFileSync(path!, "utf8"))).routerKeyFile);
    else if (mode === "--key" && path && isAbsolute(path)) process.stdout.write(readRouterKey(path));
    else throw new Error();
  } catch { process.stderr.write(`${ROUTER_KEY_ERROR}\n`); process.exitCode = 1; }
}
