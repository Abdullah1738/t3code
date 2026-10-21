import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { createServer } from "node:http";
import * as os from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isLocalCommand, parseCommand, parseLocalCommand, runLocalCommand } from "../src/cli.ts";
import type { Exec } from "../src/publish.ts";

const session = ["--session", "s-1", "--key", "k-1"];
const TOKEN = "A".repeat(42) + "_";
const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

describe("secret-request and secret commands", () => {
  test("secret-request parses repeated field specs", () => {
    expect(parseCommand(["secret-request", "--purpose", "Sign in to example.com", "--field", "email:Email",
      "--field", "password:Password:password", "--field=otp:Code:otp", ...session])).toEqual({
      method: "POST", path: "/secret-request", body: { purpose: "Sign in to example.com", dedupeKey: "k-1", sessionId: "s-1",
        fields: [{ name: "email", label: "Email", type: "text" }, { name: "password", label: "Password", type: "password" },
          { name: "otp", label: "Code", type: "otp" }] } });
  });

  test("secret-request --card adds the standard card fields ahead of any others", () => {
    const command = parseCommand(["secret-request", "--purpose", "Pay", "--card", "--field", "zip:Postcode:postal-code", ...session]);
    expect((command.body as { fields: unknown[] }).fields).toEqual([
      { name: "card_name", label: "Name on card", type: "card-name" },
      { name: "card_number", label: "Card number", type: "card-number" },
      { name: "card_expiry", label: "Expiry (MM/YY)", type: "card-expiry" },
      { name: "card_cvc", label: "Security code", type: "card-cvc" },
      { name: "zip", label: "Postcode", type: "postal-code" },
    ]);
    expect(() => parseCommand(["secret-request", "--purpose", "Pay", "--card", ...Array.from({ length: 5 }, (_, i) => ["--field", `f${i}:L`]).flat(), ...session])).toThrow("1 to 8");
  });

  test("secret-request validates purpose, fields, and session", () => {
    const base = ["secret-request", "--purpose", "P", ...session];
    expect(() => parseCommand(base)).toThrow("--field must be given 1 to 8 times");
    expect(() => parseCommand([...base, ...Array.from({ length: 9 }, (_, i) => ["--field", `f${i}:L`]).flat()])).toThrow("1 to 8");
    expect(() => parseCommand([...base, "--field", "a:A", "--field", "a:B"])).toThrow("distinct");
    expect(() => parseCommand([...base, "--field", "Bad:Label"])).toThrow("--field must be name:Label[:type]");
    expect(() => parseCommand([...base, "--field", "a"])).toThrow("--field must be name:Label[:type]");
    expect(() => parseCommand(["secret-request", "--field", "a:A", ...session])).toThrow("--purpose is required");
    expect(() => parseCommand(["secret-request", "--purpose", "a\nb", "--field", "a:A", ...session])).toThrow("--purpose must be");
    expect(() => parseCommand(["secret-request", "--purpose", "P", "--field", "a:A", "--key", "k"])).toThrow("--session is required");
  });

  test("secret reads one field or forgets", () => {
    expect(parseCommand(["secret", "--token", TOKEN, "--field", "password"])).toEqual({
      method: "POST", path: "/secret-read", body: { token: TOKEN, field: "password" } });
    expect(parseCommand(["secret", "--token", TOKEN, "--forget"])).toEqual({ method: "POST", path: "/secret-forget", body: { token: TOKEN } });
    expect(() => parseCommand(["secret", "--token", TOKEN])).toThrow("--field is required");
    expect(() => parseCommand(["secret", "--token", "short", "--field", "a"])).toThrow("Invalid --token");
    expect(() => parseCommand(["secret", "--token", TOKEN, "--field", "Bad"])).toThrow("Invalid --field");
    expect(() => parseCommand(["secret", "--token", TOKEN, "--field", "a", "--field", "b"])).toThrow("Duplicate command option");
    expect(() => parseCommand(["secret", "--token", TOKEN, "--forget", "--field", "a"])).toThrow("--forget does not take --field");
    expect(() => parseCommand(["secret", "--token", TOKEN, "--forget=yes"])).toThrow("Invalid command arguments");
  });
});

test("share, unshare and shares go to the bridge with validated slugs and days", () => {
  expect(isLocalCommand(["share"])).toBe(false);
  expect(parseCommand(["share", "--app", "trip-plan"])).toEqual({ method: "POST", path: "/share", body: { app: "trip-plan" } });
  expect(parseCommand(["share", "--app", "trip-plan", "--days", "30"])).toEqual({ method: "POST", path: "/share", body: { app: "trip-plan", days: 30 } });
  expect(parseCommand(["unshare", "--app", "trip-plan"])).toEqual({ method: "POST", path: "/unshare", body: { app: "trip-plan" } });
  expect(parseCommand(["shares"])).toEqual({ method: "POST", path: "/shares", body: {} });
  expect(() => parseCommand(["share"])).toThrow("--app is required");
  for (const app of ["Upper", "../x", "a_b"]) expect(() => parseCommand(["share", "--app", app])).toThrow("--app must be");
  for (const days of ["0", "31", "1.5", "100", "x"]) expect(() => parseCommand(["share", "--app", "a", "--days", days])).toThrow("--days must be 1 to 30");
  expect(() => parseCommand(["unshare", "--app", "a", "--days", "2"])).toThrow();
});

describe("publish and unpublish commands", () => {
  test("parse locally and validate ports and slugs", () => {
    expect(isLocalCommand(["publish"])).toBe(true);
    expect(isLocalCommand(["send"])).toBe(false);
    expect(parseLocalCommand(["publish", "--port", "3000"])).toEqual({ command: "publish", localPort: 3000 });
    expect(parseLocalCommand(["publish", "--app", "habit-tracker"])).toEqual({ command: "publish", app: "habit-tracker" });
    expect(parseLocalCommand(["unpublish", "--port", "18402"])).toEqual({ command: "unpublish", port: 18402 });
    expect(() => parseLocalCommand(["publish"])).toThrow("exactly one of --port or --app");
    expect(() => parseLocalCommand(["publish", "--port", "1", "--app", "x"])).toThrow("exactly one");
    for (const port of ["0", "65536", "1e3", "-1", "abc", " 80"]) {
      expect(() => parseLocalCommand(["publish", "--port", port])).toThrow();
    }
    for (const app of ["Upper", "a/b", "..", "a".repeat(65), "a_b"]) expect(() => parseLocalCommand(["publish", "--app", app])).toThrow("--app must be");
    for (const port of ["443", "8443", "10000", "18399", "18500"]) {
      expect(() => parseLocalCommand(["unpublish", "--port", port])).toThrow("18400 to 18499");
    }
    expect(() => parseCommand(["publish", "--port", "3000"])).toThrow("run locally");
  });

  test("publish --app checks the app exists and appends the slug path", async () => {
    const root = await fs.mkdtemp(join(os.tmpdir(), "spectrum-cli-publish-"));
    try {
      await fs.mkdir(join(root, "tracker"));
      await fs.writeFile(join(root, "tracker", "index.html"), "<h1>x</h1>");
      const web: Record<string, string> = { "443": "http://127.0.0.1:57123" };
      const exec: Exec = async args => {
        const key = args.join(" ");
        if (key === "serve status --json") {
          return { code: 0, stdout: JSON.stringify({ TCP: Object.fromEntries(Object.keys(web).map(p => [p, { HTTPS: true }])),
            Web: Object.fromEntries(Object.entries(web).map(([p, proxy]) => [`mac.ts.net:${p}`, { Handlers: { "/": { Proxy: proxy } } }])) }), stderr: "" };
        }
        if (key === "status --json") return { code: 0, stdout: JSON.stringify({ Self: { DNSName: "mac.ts.net." } }), stderr: "" };
        const match = key.match(/^serve --bg --https=(\d+) (\S+)$/);
        if (match) { web[match[1]!] = match[2]!; return { code: 0, stdout: "", stderr: "" }; }
        return { code: 1, stdout: "", stderr: "" };
      };
      const apps = async () => ({ appsRoot: root, appsPort: 18791 });
      expect(await runLocalCommand({ command: "publish", app: "tracker" }, { exec, apps }))
        .toEqual({ url: "https://mac.ts.net:18400/tracker/", port: 18400, created: true,
          metadataWarnings: ["missing <title>", "missing og:title", "missing og:description", "missing og:image"] });
      await expect(runLocalCommand({ command: "publish", app: "missing" }, { exec, apps })).rejects.toThrow("No app at");
      expect(await runLocalCommand({ command: "publish", localPort: 18791 }, { exec, apps }))
        .toEqual({ url: "https://mac.ts.net:18400", port: 18400, created: false });
      await expect(runLocalCommand({ command: "publish", localPort: 57123 }, { exec, apps })).rejects.toThrow("tailnet root");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

test("the CLI prints secret values raw and other secret responses as projected JSON", async () => {
  const home = await fs.mkdtemp(join(os.tmpdir(), "spectrum-cli-secret-"));
  const socket = join(home, "s.sock");
  const requests: { path?: string; body: unknown }[] = [];
  let status = 200;
  let reply: unknown;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push({ path: req.url, body: JSON.parse(Buffer.concat(chunks).toString()) });
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(reply));
  });
  const run = async (...args: string[]) => {
    const child = Bun.spawn([process.execPath, "run", cli, ...args], { env: { HOME: home, SPECTRUM_BRIDGE_SOCKET: socket }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, exitCode };
  };
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve); });
    reply = { value: "p@ss word\n" };
    expect(await run("secret", "--token", TOKEN, "--field", "password")).toEqual({ stdout: "p@ss word\n", stderr: "", exitCode: 0 });
    reply = { value: "x" };
    expect((await run("secret", "--token", TOKEN, "--field", "otp")).stdout).toBe("x");
    reply = { forgotten: true, extra: "PRIVATE" };
    expect(await run("secret", "--token", TOKEN, "--forget")).toEqual({ stdout: `{"forgotten":true}\n`, stderr: "", exitCode: 0 });
    reply = { token: TOKEN, url: `https://mac.ts.net:18400/_secret/${TOKEN}`, expiresAt: 1, extra: "PRIVATE" };
    expect(await run("secret-request", "--purpose", "P", "--field", "a:A", ...session)).toEqual({
      stdout: `${JSON.stringify({ token: TOKEN, url: `https://mac.ts.net:18400/_secret/${TOKEN}`, expiresAt: 1 })}\n`, stderr: "", exitCode: 0 });
    status = 410;
    reply = { error: "Expired" };
    expect(await run("secret", "--token", TOKEN, "--field", "password")).toEqual({
      stdout: "", stderr: `${JSON.stringify({ error: "Bridge request failed (HTTP 410): Expired" })}\n`, exitCode: 1 });
    expect(requests.map(entry => entry.path)).toEqual(["/secret-read", "/secret-read", "/secret-forget", "/secret-request", "/secret-read"]);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await fs.rm(home, { recursive: true, force: true });
  }
});
