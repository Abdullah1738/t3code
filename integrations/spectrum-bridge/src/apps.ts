import { realpath, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { createSecretHandler, renderSecretMessage, SECRET_PAGE_HEADERS, type SecretDeps, validToken } from "./secrets.ts";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".json": "application/json",
  ".map": "application/json", ".txt": "text/plain; charset=utf-8", ".md": "text/markdown; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".avif": "image/avif", ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2",
  ".ttf": "font/ttf", ".otf": "font/otf", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4",
  ".mp4": "video/mp4", ".webm": "video/webm", ".pdf": "application/pdf", ".wasm": "application/wasm",
  ".webmanifest": "application/manifest+json", ".xml": "application/xml",
};

const headers = { "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" };
const notFound = () => new Response("Not found", { status: 404, headers: { ...headers, "Content-Type": "text/plain; charset=utf-8" } });

export const validAppSlug = (value: unknown): value is string => typeof value === "string" && /^[a-z0-9-]{1,64}$/.test(value);

export function contentType(path: string): string {
  return TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

/** Resolves a URL path to a regular file strictly inside root, or undefined. */
export async function resolveAppFile(root: string, pathname: string): Promise<string | undefined> {
  let decoded: string;
  try { decoded = decodeURIComponent(pathname); } catch { return; }
  if (!decoded.startsWith("/") || /[\x00-\x1f\x7f\\]/.test(decoded)) return;
  const segments = decoded.split("/").filter(Boolean);
  // Dot segments cover both traversal and hidden files such as .env or .git.
  if (segments.some(segment => segment.startsWith("."))) return;
  let base: string;
  try { base = await realpath(root); } catch { return; }
  let candidate = resolve(base, ...segments);
  if (candidate !== base && !candidate.startsWith(base + sep)) return;
  try {
    let real = await realpath(candidate);
    if (real !== base && !real.startsWith(base + sep)) return;
    let info = await stat(real);
    if (info.isDirectory()) {
      candidate = resolve(real, "index.html");
      real = await realpath(candidate);
      if (!real.startsWith(base + sep)) return;
      info = await stat(real);
    }
    return info.isFile() ? real : undefined;
  } catch {
    return;
  }
}

// Link-preview fetchers ignore relative URLs in these tags.
const ABSOLUTE_META = new Set(["og:image", "og:image:url", "og:image:secure_url", "og:url", "twitter:image", "twitter:image:src"]);
type Element = { getAttribute(name: string): string | null };
const metaKey = (element: Element) => (element.getAttribute("property") ?? element.getAttribute("name") ?? "").trim().toLowerCase();

/** The https origin the visitor used: tailscale serve and Cloudflare both forward the public host. */
export function publicOrigin(request: Request): string | undefined {
  const host = (request.headers.get("x-forwarded-host")?.split(",")[0] ?? request.headers.get("host") ?? "").trim().toLowerCase();
  return /^[a-z0-9.-]+(?::\d{1,5})?$/.test(host) ? `https://${host}` : undefined;
}

/** Rewrites relative og:image / og:url / twitter:image values against the page's public URL. */
export function absoluteMeta(html: string, pageUrl: string): string {
  return new HTMLRewriter().on("meta", {
    element(element) {
      if (!ABSOLUTE_META.has(metaKey(element))) return;
      const content = element.getAttribute("content")?.trim();
      if (!content || /^https?:\/\//i.test(content)) return;
      try { element.setAttribute("content", new URL(content, pageUrl).href); } catch { /* left as written */ }
    },
  }).transform(html);
}

/** What a page lacks for a rich link preview, so the agent can fix it before sending the link. */
export function metadataWarnings(html: string): string[] {
  const seen = new Set<string>();
  let title = "";
  new HTMLRewriter()
    .on("meta", { element(element) { if (element.getAttribute("content")?.trim()) seen.add(metaKey(element)); } })
    .on("title", { text(chunk) { title += chunk.text; } })
    .transform(html);
  const missing = title.trim() ? [] : ["missing <title>"];
  for (const key of ["og:title", "og:description", "og:image"]) if (!seen.has(key)) missing.push(`missing ${key}`);
  return missing;
}

/** Serves one resolved file; HTML gets absolute preview URLs for the host it was requested through. */
export async function fileResponse(request: Request, file: string): Promise<Response> {
  const type = contentType(file);
  const origin = publicOrigin(request);
  if (type.startsWith("text/html") && origin) {
    let path = new URL(request.url).pathname;
    // A directory served without its trailing slash still resolves relative paths inside it.
    if (file.endsWith("/index.html") && !path.endsWith("/") && !path.endsWith(".html")) path += "/";
    const html = absoluteMeta(await Bun.file(file).text(), origin + path);
    return new Response(request.method === "HEAD" ? null : html, {
      headers: { ...headers, "Content-Type": type, "Content-Length": String(Buffer.byteLength(html)) },
    });
  }
  const body = Bun.file(file);
  return new Response(request.method === "HEAD" ? null : body, {
    headers: { ...headers, "Content-Type": type, "Content-Length": String(body.size) },
  });
}

export const SECRET_PREFIX = "/_secret/";

/** One chat's secret store, or (Sendblue mode) a lookup of the chat that issued a token. */
export type AppsSecrets = SecretDeps | ((token: string) => SecretDeps | undefined);

export function createAppsHandler(root: string, secrets?: AppsSecrets): (request: Request) => Promise<Response> {
  const handlers = new WeakMap<SecretDeps, ReturnType<typeof createSecretHandler>>();
  const handlerFor = (token: string) => {
    const deps = typeof secrets === "function" ? secrets(token) : secrets;
    if (!deps) return undefined;
    let handler = handlers.get(deps);
    if (!handler) { handler = createSecretHandler(deps); handlers.set(deps, handler); }
    return handler;
  };
  return async request => {
    const pathname = new URL(request.url).pathname;
    // The reserved prefix never falls through to static files, even without the secrets dependency.
    if (pathname === "/_secret" || pathname.startsWith(SECRET_PREFIX)) {
      const token = pathname.slice(SECRET_PREFIX.length);
      const secretHandler = validToken(token) ? handlerFor(token) : undefined;
      if (!secretHandler || !validToken(token)) {
        void request.body?.cancel().catch(() => {});
        return new Response(renderSecretMessage("Not found", "This form is no longer available."), { status: 404, headers: SECRET_PAGE_HEADERS });
      }
      return secretHandler(request, token);
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405, headers: { ...headers, Allow: "GET, HEAD" } });
    }
    const file = await resolveAppFile(root, pathname);
    return file ? fileResponse(request, file) : notFound();
  };
}

/**
 * Public share of one app: only files under that app's directory, never the secret forms,
 * other apps, dotfiles or listings. `root` is already resolved, so a later symlink swap cannot widen it.
 */
export function createShareHandler(root: string): (request: Request) => Promise<Response> {
  return async request => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405, headers: { ...headers, Allow: "GET, HEAD" } });
    }
    const pathname = new URL(request.url).pathname;
    if (pathname === "/_secret" || pathname.startsWith(SECRET_PREFIX)) return notFound();
    const file = await resolveAppFile(root, pathname);
    return file ? fileResponse(request, file) : notFound();
  };
}

/** Loopback-only static server for owner-built mini apps; public exposure is the tailnet proxy's job. */
export function startAppsServer(root: string, port: number, secrets?: AppsSecrets): { port: number; stop(): Promise<void> } {
  const server = Bun.serve({ hostname: "127.0.0.1", port, maxRequestBodySize: 64 * 1024, fetch: createAppsHandler(root, secrets) });
  return { port: server.port ?? port, stop: () => server.stop(true) };
}
