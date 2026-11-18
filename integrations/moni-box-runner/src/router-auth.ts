import { chmodSync, closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

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
export async function routerReady(config: ReturnType<typeof routerConfig>, log: (code: string, detail: { reason: string }) => void = () => {}): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${config.boxLivezPort}/livez`, { redirect: "error", signal: AbortSignal.timeout(1_500) });
    try {
      const body: unknown = await response.json().catch(() => null);
      const data = body && typeof body === "object" ? body as Record<string, unknown> : {};
      if (response.status === 503) {
        const reason = typeof data.reason === "string" && ["no_worker", "not_ready", "heartbeat_stale", "shutting_down"].includes(data.reason) ? data.reason : "unknown";
        log("router-unready", { reason });
      }
      return response.status === 200 && data.ready === true;
    } finally { await response.body?.cancel().catch(() => {}); }
  } catch { return false; }
}
export function startRouterGate(config: ReturnType<typeof routerConfig>, unavailable: () => void) {
  // Claude can substitute an empty header when apiKeyHelper fails. Refuse before any prompt reaches the Mac.
  return Bun.serve({ hostname: "127.0.0.1", port: 0, maxRequestBodySize: 100 * 1024 * 1024, async fetch(request) {
    let key: string;
    try { key = readRouterKey(config.routerKeyFile); }
    catch { unavailable(); return Response.json({ error: ROUTER_KEY_ERROR }, { status: 503 }); }
    if (request.headers.get("x-api-key") !== key) {
      unavailable(); return Response.json({ error: ROUTER_KEY_ERROR }, { status: 401 });
    }
    const url = new URL(request.url), headers = new Headers(request.headers);
    headers.delete("host"); headers.delete("authorization");
    try {
      return await fetch(`http://127.0.0.1:${config.boxRouterPort}${url.pathname}${url.search}`, {
        method: request.method, headers, body: request.body, redirect: "error", signal: request.signal, decompress: false,
      });
    } catch { return Response.json({ error: "router-unavailable" }, { status: 503 }); }
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
