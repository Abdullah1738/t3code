import { toolError } from "./toollog.ts";
import { isAbsolute } from "node:path";

/** The only tailnet HTTPS ports this bridge may create or remove. */
export const PUBLISH_MIN = 18400;
export const PUBLISH_MAX = 18499;
export const DEFAULT_TAILSCALE_BIN = "/usr/local/bin/tailscale";

export type ExecResult = { code: number; stdout: string; stderr: string };
export type Exec = (args: string[]) => Promise<ExecResult>;
export type Published = { url: string; port: number; created: boolean };

export class PublishError extends Error {}

type Handler = { host: string; port: number; path: string; proxy: string };
type ServeState = { ports: Set<number>; handlers: Handler[] };

const validPort = (port: unknown): port is number => Number.isInteger(port) && (port as number) >= 1 && (port as number) <= 65535;
export const inPublishRange = (port: unknown): port is number =>
  Number.isInteger(port) && (port as number) >= PUBLISH_MIN && (port as number) <= PUBLISH_MAX;
const validHost = (host: unknown): host is string =>
  typeof host === "string" && host.length <= 253 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/i.test(host);

export function tailscaleExec(bin = process.env.TAILSCALE_BIN ?? DEFAULT_TAILSCALE_BIN, timeoutMs = 20_000): Exec {
  if (!isAbsolute(bin) || bin.includes("\0")) throw new PublishError("TAILSCALE_BIN must be an absolute path");
  return async args => {
    let child;
    try {
      child = Bun.spawn([bin, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    } catch (caughtError) { toolError("publish", "publish.catch1", caughtError);
      throw new PublishError("tailscale is unavailable");
    }
    const timer = setTimeout(() => child.kill(), timeoutMs);
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      return { code, stdout, stderr };
    } finally {
      clearTimeout(timer);
    }
  };
}

/** Port of a plain local HTTP proxy target such as http://127.0.0.1:8080, otherwise undefined. */
export function localTarget(proxy: unknown): number | undefined {
  if (typeof proxy !== "string") return;
  let url: URL;
  try { url = new URL(proxy); } catch (caughtError) { toolError("publish", "publish.catch2", caughtError); return; }
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname) || url.username || url.password
    || (url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) return;
  const port = Number(url.port);
  return url.port && validPort(port) ? port : undefined;
}

export function parseServeStatus(text: string): ServeState {
  let raw: unknown;
  try { raw = text.trim() ? JSON.parse(text) : {}; } catch (caughtError) { toolError("publish", "publish.catch3", caughtError); throw new PublishError("tailscale returned invalid serve status"); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new PublishError("tailscale returned invalid serve status");
  const { TCP: tcp, Web: web } = raw as { TCP?: unknown; Web?: unknown };
  const ports = new Set<number>();
  if (tcp && typeof tcp === "object") {
    for (const key of Object.keys(tcp)) {
      const port = Number(key);
      if (/^\d+$/.test(key) && validPort(port)) ports.add(port);
    }
  }
  const handlers: Handler[] = [];
  if (web && typeof web === "object") {
    for (const [key, value] of Object.entries(web)) {
      const split = key.lastIndexOf(":");
      const port = Number(key.slice(split + 1));
      if (split <= 0 || !/^\d+$/.test(key.slice(split + 1)) || !validPort(port)) continue;
      ports.add(port);
      const entries = (value as { Handlers?: unknown })?.Handlers;
      if (!entries || typeof entries !== "object") continue;
      for (const [path, handler] of Object.entries(entries)) {
        const proxy = (handler as { Proxy?: unknown })?.Proxy;
        handlers.push({ host: key.slice(0, split), port, path, proxy: typeof proxy === "string" ? proxy : "" });
      }
    }
  }
  return { ports, handlers };
}

async function run(exec: Exec, args: string[]): Promise<string> {
  const result = await exec(args);
  // tailscale output is never surfaced; it may describe unrelated services.
  if (result.code !== 0) throw new PublishError(`tailscale ${args[0]} failed`);
  return result.stdout;
}

const readServe = async (exec: Exec) => parseServeStatus(await run(exec, ["serve", "status", "--json"]));

async function selfDnsName(exec: Exec): Promise<string> {
  let status: unknown;
  try { status = JSON.parse(await run(exec, ["status", "--json"])); } catch (error) { toolError("publish", "publish.catch4", error);
    throw error instanceof PublishError ? error : new PublishError("tailscale returned invalid status");
  }
  const name = (status as { Self?: { DNSName?: unknown } })?.Self?.DNSName;
  const host = typeof name === "string" ? name.replace(/\.$/, "") : undefined;
  if (!validHost(host)) throw new PublishError("Tailnet DNS name unavailable");
  return host.toLowerCase();
}

const httpsUrl = (host: string, port: number) => `https://${host}${port === 443 ? "" : `:${port}`}`;

/** Every mutating tailscale call goes through here, so no port outside the range can be touched. */
async function mutate(exec: Exec, port: number, args: string[]): Promise<void> {
  if (!inPublishRange(port)) throw new PublishError(`Only tailnet ports ${PUBLISH_MIN}-${PUBLISH_MAX} may be changed`);
  await run(exec, args);
}

// Serializes publish/unpublish inside one process so two callers cannot pick the same free port.
let queue: Promise<unknown> = Promise.resolve();
function serialized<T>(task: () => Promise<T>): Promise<T> {
  const next = queue.then(task, task);
  queue = next.catch((caughtError) => { toolError("publish", "publish.catch5", caughtError);});
  return next;
}

/** Returns the tailnet HTTPS URL that proxies to 127.0.0.1:localPort, creating one in the reserved range if needed. */
export function publish(localPort: number, { exec = tailscaleExec() }: { exec?: Exec } = {}): Promise<Published> {
  return serialized(async () => {
    if (!validPort(localPort)) throw new PublishError("Local port must be 1-65535");
    const state = await readServe(exec);
    const root = state.handlers.find(handler => handler.port === 443 && handler.path === "/");
    if (root && localTarget(root.proxy) === localPort) throw new PublishError("Refusing to publish the port served at the tailnet root");
    const existing = state.handlers.find(handler => handler.path === "/" && localTarget(handler.proxy) === localPort && validHost(handler.host));
    if (existing) return { url: httpsUrl(existing.host.toLowerCase(), existing.port), port: existing.port, created: false };
    const host = await selfDnsName(exec);
    let port: number | undefined;
    for (let candidate = PUBLISH_MIN; candidate <= PUBLISH_MAX; candidate++) {
      if (!state.ports.has(candidate)) { port = candidate; break; }
    }
    if (port === undefined) throw new PublishError(`No free tailnet port in ${PUBLISH_MIN}-${PUBLISH_MAX}`);
    await mutate(exec, port, ["serve", "--bg", `--https=${port}`, `http://127.0.0.1:${localPort}`]);
    const after = await readServe(exec);
    const served = after.handlers.find(handler => handler.port === port && handler.path === "/");
    if (!served || localTarget(served.proxy) !== localPort) throw new PublishError("Tailnet publish could not be verified");
    return { url: httpsUrl(host, port), port, created: true };
  });
}

/** Removes a tailnet port this bridge may own; ports outside the range are never touched. */
export function unpublish(port: number, { exec = tailscaleExec() }: { exec?: Exec } = {}): Promise<{ port: number; removed: true }> {
  return serialized(async () => {
    if (!inPublishRange(port)) throw new PublishError(`Only tailnet ports ${PUBLISH_MIN}-${PUBLISH_MAX} may be unpublished`);
    const state = await readServe(exec);
    if (!state.ports.has(port)) throw new PublishError("Port is not published");
    await mutate(exec, port, ["serve", `--https=${port}`, "off"]);
    if ((await readServe(exec)).ports.has(port)) throw new PublishError("Tailnet unpublish could not be verified");
    return { port, removed: true };
  });
}
