import { randomUUID } from "node:crypto";
import type { LogLine } from "./toollog.ts";

export const API_PATHS = ["/health", "/send", "/files", "/file", "/messages", "/wake", "/wake/:id", "/poll", "/app", "/react",
  "/cancel-send", "/router", "/secret-request", "/secret-read", "/secret-forget", "/agent-ask", "/agent-answer",
  "/agent-requests", "/allow", "/allow-group", "/ask-owner", "/chats", "/guest-allow", "/guest-revoke", "/guest-send",
  "/guests", "/location", "/location-request", "/notify-rule", "/opt-in", "/remote-events", "/remote-resolve",
  "/share", "/share-contact", "/shares", "/unshare", "/unknown"] as const;
export const REQUEST_PHASES = ["connect", "write", "await_headers", "read_body"] as const;
export type TraceEntry = Omit<LogLine, "ts" | "tool" | "error">;
export const requestPath = (path: string): string => {
  const literal = path.split("?")[0]!;
  return API_PATHS.some(value => value === literal) ? literal : literal.startsWith("/wake/") ? "/wake/:id" : "/unknown";
};
export const requestId = (value: string | null): string =>
  value && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value) ? value : randomUUID();

// Keep millisecond precision for normal handlers, then second bins up to a one-day tail.
export const handlerBin = (ms: number) => Math.min(86_400_000, ms <= 60_000 ? Math.max(0, Math.round(ms)) : Math.ceil(ms / 1000) * 1000);
export function histogramPercentile(histogram: Map<number, number>, fraction: number): number {
  const total = [...histogram.values()].reduce((sum, n) => sum + n, 0);
  let count = 0;
  for (const [ms, n] of [...histogram].sort((a, b) => a[0] - b[0])) {
    count += n;
    if (count >= Math.ceil(total * fraction)) return ms;
  }
  return 0;
}

export function createRequestTrace(emit: (entry: TraceEntry) => void, options: {
  now?: () => number; clock?: () => number; loopLag?: () => number;
} = {}) {
  const now = options.now ?? (() => performance.now());
  const clock = options.clock ?? Date.now;
  const buckets = new Map<string, { minute: number; seen: number; count: number; path: string; method: string; status: number; histogram: Map<number, number>; max: number }>();
  const write = (entry: TraceEntry) => { try { emit(entry); } catch { /* Diagnostics must not change request outcomes. */ } };
  function flush(all = false) {
    const minute = Math.floor(clock() / 60_000);
    for (const [key, bucket] of buckets) if (all || bucket.minute !== minute) {
      buckets.delete(key);
      if (!bucket.count) continue;
      write({ component: "api", kind: "perf", name: "api.request.rollup", ok: bucket.status < 400,
        props: { method: bucket.method, path: bucket.path, status: bucket.status, count: bucket.count,
          minute: bucket.minute * 60_000, p50: histogramPercentile(bucket.histogram, .5),
          p95: histogramPercentile(bucket.histogram, .95), max: bucket.max },
        requests: { histogram: [...bucket.histogram] } });
    }
  }
  return {
    flush,
    async handle(request: Request, handler: (request: Request) => Response | Promise<Response>): Promise<Response> {
      const started = now();
      const path = requestPath(new URL(request.url).pathname);
      const id = requestId(request.headers.get("X-Bridge-Request-Id"));
      // The CLI supplies Content-Length. Chunked/absent lengths are explicitly unknown.
      const length = request.headers.get("content-length");
      const bodyBytesKnown = length !== null && /^\d+$/.test(length) && Number.isSafeInteger(Number(length));
      let status = 500;
      try {
        const response = await handler(request);
        status = response.status;
        return response;
      } finally {
        const handlerMs = Math.max(0, now() - started);
        flush();
        const method = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(request.method) ? request.method : "OTHER";
        const key = `${path}:${method}:${status}`;
        const bucket = buckets.get(key) ?? { minute: Math.floor(clock() / 60_000), seen: 0, count: 0, path, method, status, histogram: new Map<number, number>(), max: 0 };
        buckets.set(key, bucket);
        if (++bucket.seen <= 60 || ["/send", "/files", "/file", "/messages", "/wake"].includes(path)) {
          write({ component: "api", kind: "perf", name: "api.request", ok: status < 400, ids: { requestId: id },
            props: { method, path, status, bodyBytes: bodyBytesKnown ? Number(length) : 0, bodyBytesKnown,
              handlerMs, loopLagMs: options.loopLag?.() ?? 0, ok: status < 400 } });
        } else {
          bucket.count++;
          const bin = handlerBin(handlerMs);
          bucket.histogram.set(bin, (bucket.histogram.get(bin) ?? 0) + 1);
          bucket.max = Math.max(bucket.max, handlerMs);
        }
      }
    },
  };
}
