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
    expect(shares.list()).toEqual([{ app: "trip", url: result.url, startedAt: clock, expiresAt: clock + 7 * DAY, live: true, permanent: false }]);
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

describe("Shares on a stable origin", () => {
  const ORIGIN = "https://cards.example.test";
  let port: number;
  let onOrigin: Shares;
  const makeOrigin = () => new Shares({ store, appsRoot, startTunnel: fakeTunnel, now: () => clock, origin: { url: ORIGIN, port },
    log: (event, code) => events.push(code ? `${event} ${code}` : event) });
  const local = (url: string) => url.replace(ORIGIN, `http://127.0.0.1:${port}`);
  beforeEach(async () => {
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    port = probe.port!;
    await probe.stop(true);
    onOrigin = makeOrigin();
  });
  afterEach(async () => { await onOrigin.stopAll(); });

  test("a share is an unguessable path on the origin, serving only that app, with no tunnel of its own", async () => {
    await app("trip", PAGE.replace("</title>", "</title><script>fetch('data.json')</script>"));
    await fs.writeFile(join(appsRoot, "trip", "data.json"), "{\"ok\":true}");
    const result = await onOrigin.share("trip");
    expect(result.url).toMatch(/^https:\/\/cards\.example\.test\/s\/[A-Za-z0-9_-]{22}\/$/);
    expect(result).toMatchObject({ created: true, metadataWarnings: [] });
    expect(tunnels).toHaveLength(0);
    const page = await fetch(local(result.url), { headers: { "x-forwarded-host": "cards.example.test" } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain(`content="${result.url}cover.png"`);
    expect(await (await fetch(local(result.url) + "data.json")).json()).toEqual({ ok: true });
    const bare = await fetch(local(result.url).slice(0, -1), { redirect: "manual" });
    expect([bare.status, bare.headers.get("location")]).toEqual([308, new URL(result.url).pathname]);
    const token = new URL(result.url).pathname.split("/")[2]!;
    for (const path of [`/s/${token}/_secret/`, `/s/${token}/../other.html`, `/s/${token}/..%2fother.html`, `/s/${token}/.env`,
      "/s/AAAAAAAAAAAAAAAAAAAAAA/", "/trip/", "/", "/other.html", `/s/${token.slice(1)}/`]) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`);
      expect([path, response.status]).toEqual([path, 404]);
      expect(await response.text()).not.toContain("PRIVATE");
    }
    expect(await (await fetch(`http://127.0.0.1:${port}/healthz`)).text()).toBe("ok\n");
    expect(onOrigin.list()).toEqual([{ app: "trip", url: result.url, startedAt: clock, expiresAt: Number.MAX_SAFE_INTEGER, live: true, permanent: true }]);
  });

  test("the link stays the same across bridge restarts and never expires, and has no 10-share cap", async () => {
    const first = await onOrigin.share("trip", 2);
    clock += 400 * DAY;
    expect(await onOrigin.share("trip", 1)).toMatchObject({ url: first.url, created: false });
    await onOrigin.stopAll();
    onOrigin = makeOrigin();
    await onOrigin.restore();
    expect(onOrigin.list().map(share => [share.app, share.url, share.live])).toEqual([["trip", first.url, true]]);
    expect((await fetch(local(first.url))).status).toBe(200);
    for (let i = 0; i < MAX_LIVE_SHARES + 2; i++) { await app(`a${i}`); expect((await onOrigin.share(`a${i}`)).created).toBe(true); }
    expect(tunnels).toHaveLength(0);
    expect(events).toEqual([]);
  });

  test("an unshared link stops working and re-sharing gives a new token; an origin link never expires on its own", async () => {
    const first = await onOrigin.share("trip");
    clock += 400 * DAY;
    await onOrigin.sweep();
    expect((await fetch(local(first.url))).status).toBe(200);
    expect(events).toEqual([]);
    await onOrigin.unshare("trip");
    expect((await fetch(local(first.url))).status).toBe(404);
    const second = await onOrigin.share("trip");
    expect(second.url).not.toBe(first.url);
    await onOrigin.unshare("trip");
    expect((await fetch(local(second.url))).status).toBe(404);
  });

  test("a symlink swap of an app's index can't retarget its link to another app's files", async () => {
    await app("other");
    await fs.writeFile(join(appsRoot, "other", "private.txt"), "PRIVATE");
    const result = await onOrigin.share("trip");
    const token = new URL(result.url).pathname.split("/")[2]!;
    await fs.rm(join(appsRoot, "trip", "index.html"));
    await fs.symlink(join(appsRoot, "other", "index.html"), join(appsRoot, "trip", "index.html"));
    // The swapped index resolves outside the app's directory, so neither the page nor other's files are served.
    for (const path of [`/s/${token}/`, `/s/${token}/private.txt`]) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`);
      expect([path, response.status]).toEqual([path, 404]);
      expect(await response.text()).not.toContain("PRIVATE");
    }
  });

  test("/healthz fails when a live origin share's page is gone, and that share reports not live", async () => {
    const result = await onOrigin.share("trip");
    expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);
    await fs.rm(join(appsRoot, "trip", "index.html"));
    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect([health.status, await health.text()]).toEqual([503, "broken shares: trip\n"]);
    expect(onOrigin.list()).toEqual([{ app: "trip", url: result.url, startedAt: clock, expiresAt: Number.MAX_SAFE_INTEGER, live: false, permanent: true }]);
    expect((await fetch(local(result.url))).status).toBe(404);
  });

  test("a missing page keeps its link: the sweep doesn't drop it, and restoring the page recovers the same URL", async () => {
    const result = await onOrigin.share("trip");
    await fs.rename(join(appsRoot, "trip"), join(appsRoot, "trip-away"));
    await onOrigin.sweep();
    expect(events).toEqual([]);
    expect(onOrigin.list()).toEqual([{ app: "trip", url: result.url, startedAt: clock, expiresAt: Number.MAX_SAFE_INTEGER, live: false, permanent: true }]);
    expect((await fetch(local(result.url))).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(503);
    await fs.rename(join(appsRoot, "trip-away"), join(appsRoot, "trip"));
    expect((await fetch(local(result.url))).status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);
    expect((await onOrigin.share("trip")).url).toBe(result.url);
  });

  test("a whole-folder swap to a symlink outside the apps folder can't be served through the token", async () => {
    const outside = join(base, "outside");
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(join(outside, "private.txt"), "PRIVATE");
    await fs.writeFile(join(outside, "index.html"), PAGE);
    const result = await onOrigin.share("trip");
    const token = new URL(result.url).pathname.split("/")[2]!;
    await fs.rename(join(appsRoot, "trip"), join(appsRoot, "trip-away"));
    await fs.symlink(outside, join(appsRoot, "trip"));
    for (const path of [`/s/${token}/`, `/s/${token}/private.txt`]) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`);
      expect([path, response.status]).toEqual([path, 404]);
      expect(await response.text()).not.toContain("PRIVATE");
    }
    expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(503);
  });

  test("a whole-folder swap to a sibling app can't be served through the token", async () => {
    await app("other");
    await fs.writeFile(join(appsRoot, "other", "private.txt"), "PRIVATE");
    const result = await onOrigin.share("trip");
    const token = new URL(result.url).pathname.split("/")[2]!;
    await fs.rename(join(appsRoot, "trip"), join(appsRoot, "trip-away"));
    await fs.symlink(join(appsRoot, "other"), join(appsRoot, "trip"));
    for (const path of [`/s/${token}/`, `/s/${token}/private.txt`]) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`);
      expect([path, response.status]).toEqual([path, 404]);
      expect(await response.text()).not.toContain("PRIVATE");
    }
  });

  test("quick-tunnel shares from before move to the origin once, and then never expire", async () => {
    const old = await shares.share("trip", 3);
    await shares.stopAll();
    await onOrigin.restore();
    const moved = onOrigin.list()[0]!;
    expect(moved.url).toMatch(/^https:\/\/cards\.example\.test\/s\//);
    expect(moved).toMatchObject({ app: "trip", startedAt: clock, expiresAt: Number.MAX_SAFE_INTEGER, live: true });
    expect(old.expiresAt).toBeLessThan(Number.MAX_SAFE_INTEGER);
    expect(events).toEqual([`share-moved trip ${old.url} ${moved.url}`]);
    expect(tunnels).toHaveLength(1);
    await onOrigin.sweep();
    expect(onOrigin.list()[0]!.url).toBe(moved.url);
  });

  test("a share fails instead of handing out a dead link when the origin port is taken", async () => {
    const squatter = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("other") });
    try {
      const error = await onOrigin.share("trip").catch(e => e);
      expect(error).toMatchObject({ status: 502 });
      expect(store.get("share:trip")).toBeUndefined();
      expect(events).toEqual([`share-origin-failed ${port}`]);
    } finally { await squatter.stop(true); }
    expect((await onOrigin.share("trip")).created).toBe(true);
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
