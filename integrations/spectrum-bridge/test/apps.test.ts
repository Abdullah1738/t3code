import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { absoluteMeta, contentType, createAppsHandler, createShareHandler, metadataWarnings, resolveAppFile, startAppsServer } from "../src/apps.ts";
import { APPS_DEFAULTS, appsConfig, loadAppsConfig, shareOriginConfig } from "../src/config.ts";

let base: string;
let root: string;
beforeEach(async () => {
  base = await fs.mkdtemp(join(tmpdir(), "spectrum-apps-test-"));
  root = join(base, "apps");
  await fs.mkdir(join(root, "tracker", "assets"), { recursive: true });
  await fs.writeFile(join(root, "index.html"), "<h1>root</h1>");
  await fs.writeFile(join(root, "tracker", "index.html"), "<h1>tracker</h1>");
  await fs.writeFile(join(root, "tracker", "assets", "app.js"), "console.log(1)");
  await fs.writeFile(join(root, "tracker", "data.json"), "{}");
  await fs.writeFile(join(root, ".env"), "PRIVATE");
  await fs.mkdir(join(root, ".git"));
  await fs.writeFile(join(root, ".git", "config"), "PRIVATE");
  await fs.mkdir(join(root, "empty"));
  await fs.writeFile(join(base, "secret.txt"), "PRIVATE");
  await fs.symlink(join(base, "secret.txt"), join(root, "escape.txt"));
  await fs.symlink(base, join(root, "outside"));
  await fs.symlink(join(root, "tracker", "data.json"), join(root, "inside.json"));
});
afterEach(async () => { await fs.rm(base, { recursive: true, force: true }); });

describe("apps static server", () => {
  const get = (path: string, method = "GET") => createAppsHandler(root)(new Request(`http://127.0.0.1${path}`, { method }));

  test("serves files and directory index pages with content types and no-cache", async () => {
    for (const [path, body, type] of [["/", "<h1>root</h1>", "text/html; charset=utf-8"],
      ["/tracker", "<h1>tracker</h1>", "text/html; charset=utf-8"], ["/tracker/", "<h1>tracker</h1>", "text/html; charset=utf-8"],
      ["/tracker/assets/app.js", "console.log(1)", "text/javascript; charset=utf-8"],
      ["/tracker/data.json?x=1", "{}", "application/json"], ["/inside.json", "{}", "application/json"],
      ["/tracker/%61ssets/app.js", "console.log(1)", "text/javascript; charset=utf-8"]]) {
      const response = await get(path);
      expect([path, response.status]).toEqual([path, 200]);
      expect(await response.text()).toBe(body);
      expect(response.headers.get("content-type")).toBe(type);
      expect(response.headers.get("cache-control")).toBe("no-cache");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    }
    const head = await get("/tracker/data.json", "HEAD");
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  test.each(["/.env", "/.git/config", "/%2e%2e/secret.txt", "/tracker/../../secret.txt", "/..%2fsecret.txt",
    "/escape.txt", "/outside/secret.txt", "/empty", "/empty/", "/missing", "/tracker/%00", "/%E0%A4%A", "/tracker%5cdata.json",
    "/%5c..%5csecret.txt"])("refuses %s", async path => {
    const response = await get(path);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("PRIVATE");
  });

  test("rejects mutating methods", async () => {
    expect((await get("/", "POST")).status).toBe(405);
    expect((await get("/", "DELETE")).status).toBe(405);
  });

  test("a missing root serves nothing", async () => {
    expect(await resolveAppFile(join(base, "nope"), "/index.html")).toBeUndefined();
  });

  test("content types fall back to octet-stream", () => {
    expect(contentType("a.CSS")).toBe("text/css; charset=utf-8");
    expect(contentType("a.svg")).toBe("image/svg+xml");
    expect(contentType("a.unknown")).toBe("application/octet-stream");
  });

  test("binds only to loopback on an ephemeral port and stops cleanly", async () => {
    const server = startAppsServer(root, 0);
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/tracker/`);
      expect(await response.text()).toBe("<h1>tracker</h1>");
    } finally { await server.stop(); }
  });

  test("a second bind on a busy port throws for the caller to log", async () => {
    const server = startAppsServer(root, 0);
    try {
      expect(() => startAppsServer(root, server.port)).toThrow();
    } finally { await server.stop(); }
  });
});

test("apps config applies defaults and validates overrides", () => {
  expect(appsConfig({})).toEqual({ ...APPS_DEFAULTS });
  expect(APPS_DEFAULTS.appsPort).toBe(18791);
  expect(APPS_DEFAULTS.appsRoot).toEndWith("/.local/share/imessage-apps");
  expect("appsPublicUrl" in APPS_DEFAULTS).toBe(false);
  expect(appsConfig({ appsRoot: "/srv/apps", appsPort: 9000 })).toEqual({ appsRoot: "/srv/apps", appsPort: 9000 });
  for (const bad of [{ appsRoot: "relative" }, { appsPort: 0 }, { appsPort: 70000 }, { appsPort: 1.5 }]) {
    expect(() => appsConfig(bad as never)).toThrow("Invalid bridge configuration");
  }
});

test("shareOrigin is an https origin without a path plus a loopback port, or unset", () => {
  expect(shareOriginConfig(undefined)).toBeUndefined();
  expect(shareOriginConfig({ url: "https://cards.abdullah.fund/", port: 18793 })).toEqual({ url: "https://cards.abdullah.fund", port: 18793 });
  for (const bad of [{ url: "http://cards.abdullah.fund", port: 18793 }, { url: "https://cards.abdullah.fund/x", port: 18793 },
    { url: "https://localhost", port: 18793 }, { url: "https://cards.abdullah.fund", port: 80 }, { url: "https://a.b", port: "18793" },
    { url: "https://a.b.c?x", port: 18793 }, null, "https://a.b"]) {
    expect(() => shareOriginConfig(bad)).toThrow("Invalid bridge configuration");
  }
});

test("the CLI reads only apps settings, defaulting when the config file is absent", async () => {
  await fs.writeFile(join(base, "config.json"), JSON.stringify({ owner: "+15555550123", appsPort: 9100, appsPublicUrl: "https://old:8443" }));
  expect(await loadAppsConfig(base)).toEqual({ appsRoot: APPS_DEFAULTS.appsRoot, appsPort: 9100 });
  expect(await loadAppsConfig(join(base, "missing"))).toEqual({ ...APPS_DEFAULTS });
  await fs.writeFile(join(base, "config.json"), "{not json");
  await expect(loadAppsConfig(base)).rejects.toThrow("Invalid bridge configuration");
});

const RICH = `<html><head><title>Trip</title><meta property="og:title" content="Trip"><meta property="og:description" content="Plan">
<meta property="og:image" content="assets/cover.png"><meta property="og:url" content="./"><meta name="twitter:image" content="/tracker/x.png">
<meta property="og:image:alt" content="assets/alt"><meta property="og:image:secure_url" content="https://cdn.example/c.png"></head></html>`;

describe("link preview metadata", () => {
  test("relative og/twitter URLs become absolute for the forwarded public host", async () => {
    await fs.writeFile(join(root, "tracker", "index.html"), RICH);
    for (const [path, page] of [["/tracker/", "https://a-b.trycloudflare.com/tracker/"], ["/tracker", "https://a-b.trycloudflare.com/tracker/"],
      ["/tracker/index.html", "https://a-b.trycloudflare.com/tracker/"]]) {
      const response = await createAppsHandler(root)(new Request(`http://127.0.0.1:18791${path}`,
        { headers: { host: "127.0.0.1:18791", "x-forwarded-host": "a-b.trycloudflare.com" } }));
      const html = await response.text();
      expect(html).toContain(`content="${page}assets/cover.png"`);
      expect(html).toContain(`property="og:url" content="${page}"`);
      expect(html).toContain(`content="https://a-b.trycloudflare.com/tracker/x.png"`);
      expect(html).toContain(`content="assets/alt"`);
      expect(html).toContain(`content="https://cdn.example/c.png"`);
      expect(response.headers.get("content-length")).toBe(String(Buffer.byteLength(html)));
    }
    // Cloudflare sends the public host as Host; a bad host leaves the page untouched.
    const viaHost = await createAppsHandler(root)(new Request("http://x.trycloudflare.com/tracker/", { headers: { host: "x.trycloudflare.com" } }));
    expect(await viaHost.text()).toContain(`content="https://x.trycloudflare.com/tracker/assets/cover.png"`);
    const bad = await createAppsHandler(root)(new Request("http://127.0.0.1/tracker/", { headers: { host: "evil\"host" } }));
    expect(await bad.text()).toContain(`content="assets/cover.png"`);
  });

  test("warnings list what a rich preview still lacks", () => {
    expect(metadataWarnings(RICH)).toEqual([]);
    expect(metadataWarnings("<h1>x</h1>")).toEqual(["missing <title>", "missing og:title", "missing og:description", "missing og:image"]);
    expect(metadataWarnings(`<title> </title><meta property="og:title" content=""><meta name="og:description" content="d">`))
      .toEqual(["missing <title>", "missing og:title", "missing og:image"]);
  });

  test("absoluteMeta leaves non-preview tags and unparseable values alone", () => {
    expect(absoluteMeta(`<meta name="description" content="a/b">`, "https://h/x/")).toBe(`<meta name="description" content="a/b">`);
    expect(absoluteMeta(`<meta property="OG:IMAGE" content="i.png">`, "https://h/x/")).toBe(`<meta property="OG:IMAGE" content="https://h/x/i.png">`);
  });
});

describe("share handler", () => {
  const share = (path: string, method = "GET") => createShareHandler(join(root, "tracker"))(new Request(`http://127.0.0.1${path}`, { method }));

  test("serves only the shared app's directory at /", async () => {
    expect(await (await share("/")).text()).toBe("<h1>tracker</h1>");
    expect(await (await share("/assets/app.js")).text()).toBe("console.log(1)");
    expect((await share("/data.json", "HEAD")).status).toBe(200);
    expect((await share("/", "POST")).status).toBe(405);
    // URL parsing folds a leading ../ back to the share root, never its parent.
    for (const path of ["/../index.html", "/%2e%2e/index.html"]) expect(await (await share(path)).text()).toBe("<h1>tracker</h1>");
  });

  test.each(["/tracker/", "/..%2findex.html", "/../.env", "/_secret", "/_secret/",
    `/_secret/${"a".repeat(43)}`, "/assets", "/assets/", "/.hidden", "/%2e%2e%2f%2e%2e%2fsecret.txt"])("refuses %s", async path => {
    await fs.mkdir(join(root, "tracker", "_secret"), { recursive: true });
    await fs.writeFile(join(root, "tracker", "_secret", "index.html"), "PRIVATE");
    await fs.writeFile(join(root, "tracker", ".hidden"), "PRIVATE");
    const response = await share(path);
    expect([path, response.status]).toEqual([path, 404]);
    expect(await response.text()).not.toContain("PRIVATE");
  });
});

test("the reserved /_secret prefix never serves static files, with or without the secrets dependency", async () => {
  await fs.mkdir(join(root, "_secret"), { recursive: true });
  await fs.writeFile(join(root, "_secret", "index.html"), "PRIVATE");
  for (const path of ["/_secret", "/_secret/", "/_secret/index.html", `/_secret/${"a".repeat(43)}`]) {
    const response = await createAppsHandler(root)(new Request(`http://127.0.0.1${path}`));
    expect([path, response.status]).toEqual([path, 404]);
    expect(await response.text()).not.toContain("PRIVATE");
    expect(response.headers.get("cache-control")).toBe("no-store");
  }
});
