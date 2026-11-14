import { toolError } from "./toollog.ts";
import { request } from "node:http";
import { isAbsolute } from "node:path";

export type TelegramReference = { id: string; kind: "notification"; text: string };

const MAX_LOOKUP_BYTES = 64 * 1024;

/**
 * Read-only lookup of an alert stored by the telegram bridge. Any failure means
 * "not found": the conversation router reports an unknown reference instead of
 * blocking its turn on another service.
 */
export function telegramNotificationLookup(socketPath: string, id: string, timeoutMs = 3_000): Promise<TelegramReference | undefined> {
  return new Promise(resolve => {
    if (!isAbsolute(socketPath) || socketPath.includes("\0")) return resolve(undefined);
    if (!/^[^\p{Cc}\s]{1,200}$/u.test(id)) return resolve(undefined);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const finish = (value: TelegramReference | undefined) => {
      clearTimeout(timer);
      resolve(value);
    };
    try {
      const req = request({
        socketPath, method: "GET", path: `/notifications/${encodeURIComponent(id)}`, agent: false,
        signal: controller.signal, maxHeaderSize: 16 * 1024,
        headers: { Accept: "application/json" },
      }, res => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("error", () => finish(undefined));
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_LOOKUP_BYTES) {
            finish(undefined);
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          if ((res.statusCode ?? 0) !== 200 || !res.complete) return finish(undefined);
          try {
            const body = JSON.parse(Buffer.concat(chunks, size).toString("utf8")) as { id?: unknown; text?: unknown };
            if (typeof body.id !== "string" || body.id !== id || typeof body.text !== "string") return finish(undefined);
            finish({ id: body.id, kind: "notification", text: body.text.slice(0, 12_000) });
          } catch (caughtError) { toolError("telegram-lookup", "telegram-lookup.catch1", caughtError);
            finish(undefined);
          }
        });
      });
      req.on("error", () => finish(undefined));
      req.end();
    } catch (caughtError) { toolError("telegram-lookup", "telegram-lookup.catch2", caughtError);
      finish(undefined);
    }
  });
}
