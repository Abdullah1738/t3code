import { request } from "node:http";
import { isAbsolute } from "node:path";
import { toolError } from "./toollog.ts";

export type RouterStatus = {
  route: { id: string; directory: string; generation: number } | null;
  pending: Array<{ id: string; kind: string; state: string; operationState: string | null; sessionId?: string; directory?: string }>;
};

const MAX_STATUS_BYTES = 64 * 1024;

function identifier(value: unknown): string | undefined {
  return typeof value === "string" && /^[^\p{Cc}]{1,4096}$/u.test(value) ? value : undefined;
}

function decodeStatus(data: unknown): RouterStatus | undefined {
  if (!data || typeof data !== "object" || Array.isArray(data)) return;
  const body = data as { route?: unknown; pending?: unknown };
  let route: RouterStatus["route"];
  if (body.route === null) {
    route = null;
  } else if (body.route && typeof body.route === "object" && !Array.isArray(body.route)) {
    const entry = body.route as { id?: unknown; directory?: unknown; generation?: unknown };
    const id = identifier(entry.id);
    const directory = identifier(entry.directory);
    const generation = entry.generation;
    if (!id || !directory || typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 0) return;
    route = { id, directory, generation };
  } else {
    return;
  }
  if (!Array.isArray(body.pending)) return;
  const pending: RouterStatus["pending"] = [];
  for (const item of body.pending) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return;
    const entry = item as { id?: unknown; kind?: unknown; state?: unknown; operationState?: unknown; sessionId?: unknown; directory?: unknown };
    const id = identifier(entry.id);
    if (!id) return;
    if (entry.kind !== "permission" && entry.kind !== "question") return;
    if (typeof entry.state !== "string") return;
    if (entry.operationState !== null && typeof entry.operationState !== "string") return;
    // Newer routers also own requests raised by subagent (child) sessions and name
    // their session explicitly. Older routers omit both fields: the route session.
    const sessionId = entry.sessionId === undefined ? undefined : identifier(entry.sessionId);
    const directory = entry.directory === undefined ? undefined : identifier(entry.directory);
    if ((entry.sessionId !== undefined && !sessionId) || (entry.directory !== undefined && !directory)) return;
    pending.push({
      id, kind: entry.kind, state: entry.state, operationState: entry.operationState as string | null,
      ...(sessionId ? { sessionId } : {}), ...(directory ? { directory } : {}),
    });
  }
  return { route, pending };
}

/**
 * Read-only view of the conversation router's attention ownership. Any failure
 * means "unavailable", which the caller treats as nothing being owned: an
 * unreachable iMessage router cannot own in-chat attention.
 */
export function spectrumRouterStatus(socketPath: string, timeoutMs = 3_000): Promise<RouterStatus | undefined> {
  return new Promise(resolve => {
    if (!isAbsolute(socketPath) || socketPath.includes("\0")) {
      toolError("telegram", "tg.router.socket", undefined, { name: "SyntaxError" });
      return resolve(undefined);
    }
    const controller = new AbortController();
    let settled = false;
    const timer = setTimeout(() => {
      finish(undefined, "tg.router.timeout", { name: "TimeoutError" });
      controller.abort();
    }, timeoutMs);
    const finish = (value: RouterStatus | undefined, tag?: string, error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (tag) toolError("telegram", tag, undefined, error);
      resolve(value);
    };
    try {
      const req = request({
        socketPath, method: "GET", path: "/router", agent: false,
        signal: controller.signal, maxHeaderSize: 16 * 1024,
        headers: { Accept: "application/json" },
      }, res => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("error", error => finish(undefined, "tg.router.response", error));
        res.on("aborted", () => finish(undefined, "tg.router.incomplete", { name: "SyntaxError" }));
        res.on("close", () => { if (!res.complete) finish(undefined, "tg.router.incomplete", { name: "SyntaxError" }); });
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_STATUS_BYTES) {
            finish(undefined, "tg.router.tooLarge", { name: "SyntaxError" });
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          if ((res.statusCode ?? 0) !== 200) return finish(undefined, "tg.router.httpStatus", { status: res.statusCode });
          if (!res.complete) return finish(undefined, "tg.router.incomplete", { name: "SyntaxError" });
          try {
            const status = decodeStatus(JSON.parse(Buffer.concat(chunks, size).toString("utf8")));
            finish(status, status ? undefined : "tg.router.decode", { name: "SyntaxError" });
          } catch {
            finish(undefined, "tg.router.decode", { name: "SyntaxError" });
          }
        });
      });
      req.on("error", error => finish(undefined, "tg.router.request", error));
      req.end();
    } catch (error) {
      finish(undefined, "tg.router.request", error);
    }
  });
}
