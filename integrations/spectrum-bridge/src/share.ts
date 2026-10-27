/**
 * Public links for people off the tailnet. With a public origin configured (a named Cloudflare
 * tunnel such as cards.abdullah.fund, run by its own LaunchAgent), every share is a path on one
 * loopback server, /s/<random token>/, serving only that app's directory: the URL survives bridge
 * and tunnel restarts and lives until it expires or is unshared. Without one, each shared app gets
 * its own loopback server behind a Cloudflare quick tunnel the bridge starts; a quick tunnel's URL
 * dies with its process, so a restart means a new URL.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { createShareHandler, metadataWarnings, notFoundResponse, resolveAppFile, serveAppFile, validAppSlug } from "./apps.ts";
import type { Store } from "./store.ts";

export const DEFAULT_CLOUDFLARED_BIN = "/opt/homebrew/bin/cloudflared";
export const DEFAULT_SHARE_DAYS = 7;
export const MAX_SHARE_DAYS = 30;
export const MAX_LIVE_SHARES = 10;
const DAY_MS = 24 * 60 * 60_000;
const KEY_PREFIX = "share:";

/** `token` marks a share on the public origin; quick-tunnel shares have `pid` instead. */
/** `root` (origin shares only) is the approved app directory's real path, fixed at share time. */
export type ShareRecord = { url: string; port: number; startedAt: number; expiresAt: number; pid?: number; token?: string; root?: string };
export type Tunnel = { url: string; pid: number; alive(): boolean; stop(): Promise<void>; kill(): void };
export type StartTunnel = (localPort: number) => Promise<Tunnel>;
export type ShareResult = { url: string; created: boolean; expiresAt: number; metadataWarnings: string[] };

export class ShareError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const TUNNEL_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
// The URL is printed a moment before the edge accepts traffic; a preview fetched in between fails.
const REGISTERED = /Registered tunnel connection/;

export const parseTunnelUrl = (text: string): string | undefined => text.match(TUNNEL_URL)?.[0];

/** Starts `cloudflared tunnel --url` and resolves once it has a URL and a live edge connection. */
export function cloudflaredTunnel(bin = process.env.CLOUDFLARED_BIN ?? DEFAULT_CLOUDFLARED_BIN, timeoutMs = 30_000): StartTunnel {
  return async port => {
    // Checked per call so a bad override fails one share, not the bridge start.
    if (!isAbsolute(bin) || bin.includes("\0")) throw new ShareError(500, "CLOUDFLARED_BIN must be an absolute path");
    let child;
    try {
      child = Bun.spawn([bin, "tunnel", "--no-autoupdate", "--metrics", "127.0.0.1:0", "--grace-period", "1s",
        "--url", `http://127.0.0.1:${port}`], { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
    } catch {
      throw new ShareError(502, "cloudflared is unavailable");
    }
    let exited = false;
    const done = child.exited.then(() => { exited = true; });
    const kill = () => { if (!exited) child.kill("SIGKILL"); };
    const tunnel = (url: string): Tunnel => ({
      url, pid: child.pid, alive: () => !exited, kill,
      async stop() {
        if (exited) return;
        child.kill("SIGTERM");
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([done, new Promise(resolve => { timer = setTimeout(resolve, 2_000); })]);
        clearTimeout(timer);
        kill();
      },
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise<Tunnel>((resolve, reject) => {
        timer = setTimeout(() => reject(new ShareError(504, "cloudflared did not open a tunnel in time")), timeoutMs);
        void (async () => {
          const decoder = new TextDecoder();
          let text = "";
          let url: string | undefined;
          let settled = false;
          // Keep draining after the URL, or cloudflared blocks on a full stderr pipe.
          for await (const chunk of child.stderr) {
            if (settled) continue;
            text = (text + decoder.decode(chunk, { stream: true })).slice(-16_384);
            url ??= parseTunnelUrl(text);
            if (url && REGISTERED.test(text)) { settled = true; resolve(tunnel(url)); }
          }
          if (!settled) reject(new ShareError(502, "cloudflared exited before the tunnel was ready"));
        })().catch(() => reject(new ShareError(502, "cloudflared output could not be read")));
      });
    } catch (error) {
      kill();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };
}

type Live = { server: ReturnType<typeof Bun.serve>; tunnel: Tunnel };
type Log = (event: string, code?: string) => void;

/** The stable public origin and the loopback port its tunnel points at. */
export type ShareOrigin = { url: string; port: number };

const TOKEN = /^[A-Za-z0-9_-]{22}$/;
const SHARE_PATH = /^\/s\/([A-Za-z0-9_-]{22})(\/.*)?$/;
// Origin shares don't expire: a card link lives until it is unshared or its app is removed.
const NEVER = Number.MAX_SAFE_INTEGER;
// 128 random bits: the token is the only thing between a link and the page.
const newToken = () => Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url");
const originUrl = (origin: ShareOrigin, token: string) => `${origin.url}/s/${token}/`;
const onOrigin = (origin: ShareOrigin, record: ShareRecord) =>
  record.token !== undefined && TOKEN.test(record.token) && record.url === originUrl(origin, record.token)
  && typeof record.root === "string";

export type SharesOptions = {
  /** The owner store: shares are bridge-wide, not per chat. */
  store: Store;
  appsRoot: string;
  startTunnel: StartTunnel;
  /** When set, shares are paths on this origin instead of one quick tunnel each. */
  origin?: ShareOrigin;
  log?: Log;
  now?: () => number;
};

export class Shares {
  private readonly live = new Map<string, Live>();
  private server: ReturnType<typeof Bun.serve> | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private sweeping = false;
  private readonly now: () => number;
  private readonly log: Log;

  constructor(private readonly options: SharesOptions) {
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => {});
  }

  /** Returns a public URL for the app, reusing its live tunnel; a longer --days extends it. */
  share(slug: string, days = DEFAULT_SHARE_DAYS): Promise<ShareResult> {
    return this.serialized(async () => {
      if (!validAppSlug(slug)) throw new ShareError(400, "--app must be 1-64 characters of a-z, 0-9, or -");
      if (!Number.isInteger(days) || days < 1 || days > MAX_SHARE_DAYS) throw new ShareError(400, `--days must be 1 to ${MAX_SHARE_DAYS}`);
      const index = await this.index(slug);
      if (!index) throw new ShareError(404, `No app at ${this.options.appsRoot}/${slug}/index.html`);
      const warnings = metadataWarnings(await Bun.file(index).text());
      const expiresAt = this.now() + days * DAY_MS;
      const record = this.record(slug);
      const origin = this.options.origin;
      if (origin) {
        if (!this.serveOrigin()) throw new ShareError(502, `The share server can't listen on 127.0.0.1:${origin.port}`);
        if (record && onOrigin(origin, record)) {
          this.save(slug, { ...record, root: dirname(index) });
          return { url: record.url, created: false, expiresAt: NEVER, metadataWarnings: warnings };
        }
        await this.close(slug);
        const token = newToken();
        this.save(slug, { url: originUrl(origin, token), port: origin.port, token, startedAt: this.now(),
          expiresAt: NEVER, root: dirname(index) });
        return { url: originUrl(origin, token), created: true, expiresAt: NEVER, metadataWarnings: warnings };
      }
      if (record && this.live.get(slug)?.tunnel.alive()) {
        record.expiresAt = Math.max(record.expiresAt, expiresAt);
        this.save(slug, record);
        return { url: record.url, created: false, expiresAt: record.expiresAt, metadataWarnings: warnings };
      }
      await this.close(slug);
      const others = this.records().filter(([other, saved]) => other !== slug && saved.expiresAt > this.now());
      if (others.length >= MAX_LIVE_SHARES) throw new ShareError(409, `At most ${MAX_LIVE_SHARES} live shares; unshare one first`);
      const started = await this.start(slug, dirname(index));
      this.save(slug, { ...started, startedAt: this.now(), expiresAt });
      return { url: started.url, created: true, expiresAt, metadataWarnings: warnings };
    });
  }

  unshare(slug: string): Promise<{ app: string; removed: boolean }> {
    return this.serialized(async () => {
      if (!validAppSlug(slug)) throw new ShareError(400, "--app must be 1-64 characters of a-z, 0-9, or -");
      const removed = this.record(slug) !== undefined || this.live.has(slug);
      await this.close(slug);
      this.forget(slug);
      return { app: slug, removed };
    });
  }

  list(): { app: string; url: string; startedAt: number; expiresAt: number; live: boolean }[] {
    return this.records().map(([app, record]) => ({
      app, url: record.url, startedAt: record.startedAt, expiresAt: record.expiresAt, live: this.alive(app, record),
    }));
  }

  /** Bridge start: kills tunnels a crashed bridge left behind, then brings unexpired shares back. */
  async restore(): Promise<void> {
    for (const [, record] of this.records()) if (record.pid) reapOrphan(record.pid, record.port);
    await this.sweep();
  }

  /** The origin's loopback server: /healthz for the tunnel's health check, /s/<token>/... for shares. */
  private serveOrigin(): boolean {
    const origin = this.options.origin;
    if (!origin) return false;
    if (this.server) return true;
    try {
      this.server = Bun.serve({ hostname: "127.0.0.1", port: origin.port, maxRequestBodySize: 1024, fetch: request => this.handle(request) });
      return true;
    } catch {
      this.log("share-origin-failed", String(origin.port));
      return false;
    }
  }

  private async handle(request: Request): Promise<Response> {
    const { pathname, search } = new URL(request.url);
    if (pathname === "/healthz") return this.health(this.options.origin!);
    const match = SHARE_PATH.exec(pathname);
    const origin = this.options.origin!;
    const found = match ? this.records().find(([, record]) => record.token === match[1] && onOrigin(origin, record)) : undefined;
    // The root is the directory approved at share time; an app's index being swapped later can't retarget the token.
    if (!match || !found || !found[1].root) return notFoundResponse();
    // Pages load data.json and assets relative to their directory, so the share root needs its slash.
    if (match[2] === undefined) return new Response(null, { status: 308, headers: { Location: `/s/${match[1]}/${search}`, "Cache-Control": "no-store" } });
    return serveAppFile(request, found[1].root, match[2]);
  }

  /**
   * The tunnel's health check, and it must mean the card links work. 503 names the broken shares: a live origin
   * share whose page no longer serves (its index was removed or moved out of its directory), so a dead page can't
   * read as healthy.
   */
  private async health(origin: ShareOrigin): Promise<Response> {
    const broken: string[] = [];
    for (const [slug, record] of this.records()) {
      if (!onOrigin(origin, record) || !record.root) continue;
      const index = await this.index(slug);
      if (!index || dirname(index) !== record.root) broken.push(slug);
    }
    const headers = { "Cache-Control": "no-store", "Content-Type": "text/plain" };
    if (broken.length === 0) return new Response("ok\n", { headers });
    return new Response(`broken shares: ${broken.join(", ")}\n`, { status: 503, headers });
  }

  private alive(slug: string, record: ShareRecord): boolean {
    // An origin share is live only while its page still exists where it was approved.
    if (record.token) return this.server !== undefined && record.root !== undefined && existsSync(join(record.root, "index.html"));
    return this.live.get(slug)?.tunnel.alive() ?? false;
  }

  /** Stops expired shares and re-creates any whose tunnel died. Overlapping calls are skipped. */
  async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      await this.serialized(async () => {
        const origin = this.options.origin;
        if (origin) this.serveOrigin();
        for (const [slug, record] of this.records()) {
          if (origin) {
            if (onOrigin(origin, record)) {
              // An origin share whose app was removed has nothing to serve; drop it rather than leave a dead link.
              if (!(await this.index(slug))) { await this.close(slug); this.forget(slug); this.log("share-dropped", slug); }
              continue;
            }
            // A quick-tunnel share (or one on an older origin) moves to the origin once. The move makes it permanent
            // (origin shares don't expire) and binds the approved directory, which is still the app's current one.
            const index = await this.index(slug);
            await this.close(slug);
            if (!index) { this.forget(slug); this.log("share-dropped", slug); continue; }
            const token = newToken();
            const url = originUrl(origin, token);
            this.save(slug, { url, port: origin.port, token, startedAt: record.startedAt, expiresAt: NEVER, root: dirname(index) });
            this.log("share-moved", `${slug} ${record.url} ${url}`);
            continue;
          }
          if (record.expiresAt <= this.now()) {
            await this.close(slug);
            this.forget(slug);
            this.log("share-expired", slug);
            continue;
          }
          if (this.live.get(slug)?.tunnel.alive()) continue;
          await this.close(slug);
          const index = await this.index(slug);
          if (!index) {
            this.forget(slug);
            this.log("share-dropped", slug);
            continue;
          }
          try {
            const started = await this.start(slug, dirname(index));
            this.save(slug, { ...record, ...started });
            this.log("share-restarted", `${slug} ${record.url} ${started.url}`);
          } catch {
            this.log("share-restart-failed", slug);
          }
        }
      });
    } finally {
      this.sweeping = false;
    }
  }

  /** Bridge stop: tunnels end with the bridge, records stay so the next start re-creates them. */
  async stopAll(): Promise<void> {
    await Promise.all([...this.live.keys()].map(slug => this.close(slug)));
    const server = this.server;
    this.server = undefined;
    await server?.stop(true);
  }

  /** Synchronous last resort for process exit, where async cleanup never runs. */
  killAll(): void {
    for (const { tunnel } of this.live.values()) tunnel.kill();
  }

  private async start(slug: string, root: string): Promise<{ url: string; port: number; pid: number }> {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, maxRequestBodySize: 1024, fetch: createShareHandler(root) });
    const port = server.port!;
    try {
      const tunnel = await this.options.startTunnel(port);
      this.live.set(slug, { server, tunnel });
      return { url: tunnel.url, port, pid: tunnel.pid };
    } catch (error) {
      await server.stop(true);
      throw error instanceof ShareError ? error : new ShareError(502, "Tunnel could not be started");
    }
  }

  private async close(slug: string): Promise<void> {
    const live = this.live.get(slug);
    if (!live) return;
    this.live.delete(slug);
    await live.tunnel.stop().catch(() => live.tunnel.kill());
    await live.server.stop(true);
  }

  private index(slug: string): Promise<string | undefined> {
    return resolveAppFile(this.options.appsRoot, `/${slug}/index.html`);
  }

  private records(): [string, ShareRecord][] {
    return this.options.store.db.query<{ key: string; value: string }, []>(
      `SELECT key, value FROM kv WHERE key LIKE '${KEY_PREFIX}%' ORDER BY key`,
    ).all().map(row => [row.key.slice(KEY_PREFIX.length), JSON.parse(row.value) as ShareRecord]);
  }

  private record(slug: string): ShareRecord | undefined {
    return this.options.store.get<ShareRecord>(KEY_PREFIX + slug);
  }

  private save(slug: string, record: ShareRecord): void {
    this.options.store.set(KEY_PREFIX + slug, record);
  }

  private forget(slug: string): void {
    this.options.store.db.query("DELETE FROM kv WHERE key = ?").run(KEY_PREFIX + slug);
  }

  private serialized<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => {});
    return next;
  }
}

/** Kills a tunnel only if that PID is still the cloudflared this bridge started for that port. */
function reapOrphan(pid: number, port: number): void {
  if (!Number.isInteger(pid) || pid <= 1) return;
  const ps = spawnSync("/bin/ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
  const command = ps.status === 0 ? ps.stdout : "";
  if (!command.includes("cloudflared") || !new RegExp(`--url http://127\\.0\\.0\\.1:${port}(?:\\s|$)`).test(command)) return;
  try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
}

export const SHARE_ROUTES = ["/share", "/unshare", "/shares"];

/** Socket routes shared by the Photon and Sendblue APIs; callers pass a parsed JSON object body. */
export async function shareRoute(shares: Shares, path: string, body: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
  const allowed = path === "/share" ? ["app", "days"] : path === "/unshare" ? ["app"] : [];
  if (Object.keys(body).some(key => !allowed.includes(key))) return { status: 400, body: { error: "Invalid request" } };
  try {
    if (path === "/shares") return { status: 200, body: { shares: shares.list() } };
    const app = body.app;
    if (typeof app !== "string") return { status: 400, body: { error: "Invalid request" } };
    if (path === "/unshare") return { status: 200, body: await shares.unshare(app) };
    const days = body.days === undefined ? DEFAULT_SHARE_DAYS : body.days;
    if (typeof days !== "number") return { status: 400, body: { error: "Invalid request" } };
    const result = await shares.share(app, days);
    return { status: result.created ? 201 : 200, body: result };
  } catch (error) {
    if (error instanceof ShareError) return { status: error.status, body: { error: error.message } };
    return { status: 502, body: { error: "Share failed" } };
  }
}
