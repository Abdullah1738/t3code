import { createHash } from "node:crypto";

export const FETCH_CAUSES = ["timeout", "dns", "connect", "tls", "http_status", "body_read", "other"] as const;
export type FetchCause = typeof FETCH_CAUSES[number];
export type CardFetchFailure = {
  fetchCause: FetchCause; httpStatus?: number; urlClass: string; elapsedMs: number; bytesReceived: number;
};

// Unknown hosts can themselves contain credentials (including tunnel labels).
const HOST_CLASSES = ["cards.abdullah.fund", "abdullahs-macbook-pro.tailcca332.ts.net", "cards.tail", "trycloudflare.com", "other"];
export function cardUrlClass(url: URL): string {
  const host = url.hostname.toLowerCase();
  if (host.endsWith(".trycloudflare.com")) return "trycloudflare.com";
  return HOST_CLASSES.includes(host) ? host : "other";
}
export function cleanCardUrlClass(value: unknown): value is string {
  return typeof value === "string" && HOST_CLASSES.includes(value);
}

// Share paths contain bearer tokens, so correlate retries with an opaque digest.
export function renderCardId(pageUrl: string): string {
  return `card_${createHash("sha256").update(pageUrl).digest("hex").slice(0, 24)}`;
}
export function cleanRenderCardId(value: unknown): value is string {
  return typeof value === "string" && /^card_[a-f0-9]{24}$/.test(value);
}

const TIMEOUT = new Set(["TimeoutError", "AbortError", "ETIMEDOUT", "ESOCKETTIMEDOUT", "ABORT_ERR", "Timeout", "Aborted", "ClientAborted", "AbortedBeforeConnecting", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]);
const DNS = new Set(["ENOTFOUND", "EAI_AGAIN", "EAI_FAIL", "DNSResolveFailed", "DNSResolutionFailed"]);
const CONNECT = new Set(["ECONNREFUSED", "ECONNRESET", "ECONNABORTED", "EHOSTUNREACH", "ENETUNREACH", "ENETDOWN", "EPIPE", "UND_ERR_SOCKET", "ERR_SOCKET_CLOSED", "ConnectionRefused", "ConnectionClosed", "FailedToOpenSocket", "ProxyConnectFailed"]);
const TLS = new Set(["TLSHandshakeFailed", "CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "CERT_UNTRUSTED", "CERT_REVOKED", "InvalidCRL"]);

export function pageFetchCause(error: unknown, body = false): FetchCause {
  const pending: unknown[] = [error];
  const seen = new Set<unknown>();
  const causes = new Set<FetchCause>();
  for (let i = 0; pending.length && i < 16; i++) {
    const value = pending.shift();
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    try {
      const item = value as { name?: unknown; code?: unknown; errno?: unknown; cause?: unknown; errors?: unknown };
      for (const code of [item.name, item.code, item.errno]) {
        if (typeof code !== "string") continue;
        if (TIMEOUT.has(code)) causes.add("timeout");
        if (DNS.has(code)) causes.add("dns");
        if (CONNECT.has(code)) causes.add("connect");
        if (TLS.has(code) || code.startsWith("ERR_TLS_") || code.startsWith("ERR_SSL_")) causes.add("tls");
      }
      pending.push(item.cause);
      if (Array.isArray(item.errors)) pending.push(...item.errors.slice(0, 16));
    } catch { /* Diagnostic getters cannot change delivery behavior. */ }
  }
  // An abort wrapper can hide the actual transport cause; prefer the underlying failure.
  return (["dns", "tls", "connect", "timeout"] as const).find(cause => causes.has(cause)) ?? (body ? "body_read" : "other");
}
