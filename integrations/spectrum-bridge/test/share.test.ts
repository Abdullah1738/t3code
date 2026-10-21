import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod } from "node:fs/promises";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cloudflaredTunnel, MAX_LIVE_SHARES, parseTunnelUrl, ShareError, shareRoute, Shares, type StartTunnel, type Tunnel } from "../src/share.ts";
import { Store } from "../src/store.ts";

const DAY = 24 * 60 * 60_000;
const PAGE = `<title>T</title><meta property="og:title" content="T"><meta property="og:description" content="D"><meta property="og:image" content="cover.png">`;

let base: string;
let appsRoot: string;
let store: Store;
let clock: number;
let tunnels: (Tunnel & { port: number; dead: boolean })[];
let events: string[];
let failNext: boolean;
let shares: Shares;

const fakeTunnel: StartTunnel = async port => {
  if (failNext) { failNext = false; throw new Error("boom"); }
  const tunnel = {
    url: `https://t${tunnels.length + 1}.trycloudflare.com`, pid: 0, port, dead: false,
    alive: () => !tunnel.dead, stop: async () => { tunnel.dead = true; }, kill: () => { tunnel.dead = true; },
  };
  tunnels.push(tunnel);
  return tunnel;
};

const app = async (slug: string, html = PAGE) => {
  await fs.mkdir(join(appsRoot, slug), { recursive: true });
  await fs.writeFile(join(appsRoot, slug, "index.html"), html);
};
const make = () => new Shares({ store, appsRoot, startTunnel: fakeTunnel, now: () => clock,
  log: (event, code) => events.push(code ? `${event} ${code}` : event) });

beforeEach(async () => {
  base = await fs.mkdtemp(join(tmpdir(), "spectrum-share-test-"));
  appsRoot = join(base, "apps");
  await app("trip");
  await fs.mkdir(join(appsRoot, "_secret"), { recursive: true });
  await fs.writeFile(join(appsRoot, "_secret", "index.html"), "PRIVATE");
  await fs.writeFile(join(appsRoot, "other.html"), "PRIVATE");
  store = new Store(":memory:");
  clock = 1_000_000;
  tunnels = [];
  events = [];
  failNext = false;
  shares = make();
});
afterEach(async () => {
  await shares.stopAll();
  store.close();
  await fs.rm(base, { recursive: true, force: true });
});

test("parses the quick tunnel URL out of cloudflared's boxed log line", () => {
  const log = "2026-10-21T10:00:00Z INF |  https://quiet-river-sample-words.trycloudflare.com                    |\n";
  expect(parseTunnelUrl(log)).toBe("https://quiet-river-sample-words.trycloudflare.com");
  expect(parseTunnelUrl("INF Requesting new quick Tunnel on trycloudflare.com...")).toBeUndefined();
  expect(parseTunnelUrl("https://api.trycloudflare.com/tunnel")).toBe("https://api.trycloudflare.com");
});

describe("Shares", () => {
  test("creates a share, serves only that app over loopback, and persists the record", async () => {
    const result = await shares.share("trip");
    expect(result).toEqual({ url: "https://t1.trycloudflare.com", created: true, expiresAt: clock + 7 * DAY, metadataWarnings: [] });
    const record = store.get<{ url: string; port: number; startedAt: number; expiresAt: number }>("share:trip")!;
    expect(record).toMatchObject({ url: result.url, startedAt: clock, expiresAt: clock + 7 * DAY, port: tunnels[0]!.port });
    const origin = `http://127.0.0.1:${record.port}`;
    const page = await fetch(`${origin}/`, { headers: { "x-forwarded-host": "t1.trycloudflare.com" } });
    expect(await page.text()).toContain(`content="https://t1.trycloudflare.com/cover.png"`);
    for (const path of ["/_secret/", "/../_secret/index.html", "/..%2fother.html", "/trip/", "/.env"]) {
      const response = await fetch(origin + path);
      expect([path, response.status]).toEqual([path, 404]);
      expect(await response.text()).not.toContain("PRIVATE");
    }
    expect(shares.list()).toEqual([{ app: "trip", url: result.url, startedAt: clock, expiresAt: clock + 7 * DAY, live: true }]);
  });

  test("reuses a live share and only ever extends its expiry", async () => {
    await app("trip", "<h1>bare</h1>");
    await shares.share("trip", 2);
    clock += DAY;
    const again = await shares.share("trip", 1);
    expect(again).toMatchObject({ url: "https://t1.trycloudflare.com", created: false, expiresAt: 1_000_000 + 2 * DAY });
    expect(again.metadataWarnings).toEqual(["missing <title>", "missing og:title", "missing og:description", "missing og:image"]);
    expect((await shares.share("trip", 30)).expiresAt).toBe(clock + 30 * DAY);
    expect(tunnels).toHaveLength(1);
  });

  test("validates the slug, days and that the app exists", async () => {
    for (const [slug, days, status] of [["../x", 7, 400], ["Trip", 7, 400], ["trip", 0, 400], ["trip", 31, 400], ["trip", 1.5, 400],
      ["missing", 7, 404], ["_secret", 7, 400]] as const) {
      const error = await shares.share(slug, days).catch(e => e);
      expect([slug, days, error instanceof ShareError && error.status]).toEqual([slug, days, status]);
    }
    expect(tunnels).toHaveLength(0);
  });

  test("caps live shares, counting only unexpired records", async () => {
    for (let i = 0; i < MAX_LIVE_SHARES; i++) { await app(`a${i}`); await shares.share(`a${i}`); }
    const error = await shares.share("trip").catch(e => e);
    expect(error).toBeInstanceOf(ShareError);
    expect(error.status).toBe(409);
    await shares.unshare("a0");
    expect((await shares.share("trip")).created).toBe(true);
  });

  test("unshare stops the tunnel and the loopback server and drops the record", async () => {
    await shares.share("trip");
    const { port } = store.get<{ port: number }>("share:trip")!;
    expect(await shares.unshare("trip")).toEqual({ app: "trip", removed: true });
    expect(tunnels[0]!.dead).toBe(true);
    expect(store.get("share:trip")).toBeUndefined();
    expect(await fetch(`http://127.0.0.1:${port}/`).then(() => "open", () => "closed")).toBe("closed");
    expect(await shares.unshare("trip")).toEqual({ app: "trip", removed: false });
  });

  test("sweep stops expired shares", async () => {
    await shares.share("trip", 1);
    clock += DAY;
    await shares.sweep();
    expect(tunnels[0]!.dead).toBe(true);
    expect(store.get("share:trip")).toBeUndefined();
    expect(events).toEqual(["share-expired trip"]);
  });

  test("sweep re-creates a share whose tunnel died, keeping its expiry", async () => {
    const first = await shares.share("trip");
    tunnels[0]!.dead = true;
    clock += 1000;
    await shares.sweep();
    const record = store.get<{ url: string; startedAt: number; expiresAt: number }>("share:trip")!;
    expect(record).toMatchObject({ url: "https://t2.trycloudflare.com", startedAt: 1_000_000, expiresAt: first.expiresAt });
    expect(events).toEqual(["share-restarted trip https://t1.trycloudflare.com https://t2.trycloudflare.com"]);
  });

  test("a bridge restart re-creates unexpired shares with new URLs and drops expired or deleted ones", async () => {
    await app("gone");
    await app("old");
    await shares.share("trip");
    await shares.share("gone");
    await shares.share("old", 1);
    await shares.stopAll();
    expect(tunnels.every(tunnel => tunnel.dead)).toBe(true);
    await fs.rm(join(appsRoot, "gone"), { recursive: true });
    clock += DAY;
    shares = make();
    await shares.restore();
    expect(shares.list().map(share => [share.app, share.url, share.live])).toEqual([["trip", "https://t4.trycloudflare.com", true]]);
    expect(events).toEqual(["share-dropped gone", "share-expired old", "share-restarted trip https://t1.trycloudflare.com https://t4.trycloudflare.com"]);
  });

  test("a failed restart keeps the record for the next sweep", async () => {
    await shares.share("trip");
    await shares.stopAll();
    failNext = true;
    await shares.sweep();
    expect(events).toEqual(["share-restart-failed trip"]);
    expect(store.get("share:trip")).toBeDefined();
    await shares.sweep();
    expect(shares.list()[0]!.live).toBe(true);
  });

  test("a tunnel that fails to start leaves no record or server behind", async () => {
    failNext = true;
    const error = await shares.share("trip").catch(e => e);
    expect(error).toMatchObject({ status: 502 });
    expect(store.get("share:trip")).toBeUndefined();
    expect(shares.list()).toEqual([]);
  });

  test("killAll ends every tunnel synchronously", async () => {
    await shares.share("trip");
    shares.killAll();
    expect(tunnels[0]!.dead).toBe(true);
  });
});

describe("shareRoute", () => {
  test("maps share, unshare and shares requests to responses", async () => {
    expect(await shareRoute(shares, "/share", { app: "trip" })).toMatchObject({ status: 201, body: { url: "https://t1.trycloudflare.com", created: true } });
    expect(await shareRoute(shares, "/share", { app: "trip", days: 3 })).toMatchObject({ status: 200, body: { created: false } });
    expect((await shareRoute(shares, "/shares", {})).body).toMatchObject({ shares: [{ app: "trip", live: true }] });
    expect(await shareRoute(shares, "/unshare", { app: "trip" })).toEqual({ status: 200, body: { app: "trip", removed: true } });
    expect(await shareRoute(shares, "/share", { app: "nope" })).toMatchObject({ status: 404 });
    for (const body of [{}, { app: 1 }, { app: "trip", days: "3" }, { app: "trip", extra: true }]) {
      expect(await shareRoute(shares, "/share", body)).toEqual({ status: 400, body: { error: "Invalid request" } });
    }
    expect((await shareRoute(shares, "/shares", { app: "trip" })).status).toBe(400);
  });
});

describe("cloudflaredTunnel", () => {
  const fake = async (script: string) => {
    const bin = join(base, "cloudflared");
    await fs.writeFile(bin, `#!/bin/sh\n${script}\n`);
    await chmod(bin, 0o755);
    return bin;
  };

  test("waits for the URL and a registered connection, and passes the local port", async () => {
    const bin = await fake(`echo "INF |  https://fake-words.trycloudflare.com  |" >&2
echo "args $*" > "${base}/args"
echo "INF Registered tunnel connection connIndex=0" >&2
exec sleep 30`);
    const tunnel = await cloudflaredTunnel(bin, 5000)(4321);
    try {
      expect(tunnel.url).toBe("https://fake-words.trycloudflare.com");
      expect(tunnel.alive()).toBe(true);
      expect(await fs.readFile(join(base, "args"), "utf8")).toContain("tunnel --no-autoupdate --metrics 127.0.0.1:0 --grace-period 1s --url http://127.0.0.1:4321");
    } finally { await tunnel.stop(); }
    expect(tunnel.alive()).toBe(false);
  });

  test("fails when cloudflared exits early or never opens a tunnel", async () => {
    await expect(cloudflaredTunnel(await fake(`echo "ERR failed" >&2; exit 1`), 5000)(1)).rejects.toMatchObject({ status: 502 });
    await expect(cloudflaredTunnel(await fake(`exec sleep 30`), 200)(1)).rejects.toMatchObject({ status: 504 });
    await expect(cloudflaredTunnel("relative/cloudflared")(1)).rejects.toMatchObject({ status: 500 });
  });
});
