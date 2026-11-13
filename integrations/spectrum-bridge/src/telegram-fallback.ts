import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { request } from "node:http";
import { basename, dirname, isAbsolute } from "node:path";
import { contentType, resolveAppFile, SECRET_PREFIX } from "./apps.ts";
import { MAX_FILE_BYTES, validFileName, validMimeType } from "./cli.ts";
import { stripInternalText } from "./formatting.ts";
import type { OutboxRecord } from "./store.ts";

/** Status code of a telegram bridge socket call, or undefined when it never answered. */
export type Post = (path: "/notify" | "/files", body: Record<string, string>) => Promise<number | undefined>;

const SOURCE = "iMessage bridge";
const NOTE = "iMessage couldn't deliver this, so it's here instead.";
const MAX_TEXT = 12_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

/** Bounded JSON POST to the telegram bridge's local socket; any transport failure is undefined. */
export function socketPost(socketPath: string, timeoutMs = 20_000): Post {
  return (path, body) => new Promise(resolve => {
    if (!isAbsolute(socketPath) || socketPath.includes("\0")) return resolve(undefined);
    const payload = Buffer.from(JSON.stringify(body));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const finish = (value: number | undefined) => {
      clearTimeout(timer);
      resolve(value);
    };
    try {
      const req = request({
        socketPath, method: "POST", path, agent: false, signal: controller.signal, maxHeaderSize: 16 * 1024,
        headers: { "Content-Type": "application/json", "Content-Length": payload.byteLength, Accept: "application/json" },
      }, res => {
        let size = 0;
        res.on("error", () => finish(undefined));
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            finish(undefined);
            req.destroy();
          }
        });
        res.on("end", () => finish(res.complete ? res.statusCode : undefined));
      });
      req.on("error", () => finish(undefined));
      req.end(payload);
    } catch {
      finish(undefined);
    }
  });
}

type Outlet = {
  post: Post;
  /** Directory the apps server publishes, and its public origin when it is up. */
  appsRoot: string;
  appsUrl: () => string | undefined;
  blob: (sha256: string) => Uint8Array;
};

const outcome = (status: number | undefined): "sent" | "skip" | "retry" =>
  // 409 means this key was already used, so an earlier attempt got through.
  status === 200 || status === 202 || status === 409 ? "sent" : status === 400 || status === 413 ? "skip" : "retry";

const text = (...parts: Array<string | undefined>) =>
  parts.map(part => part === undefined ? "" : stripInternalText(part).trim()).filter(Boolean).join("\n").slice(0, MAX_TEXT);

export const firstTurnAlert = (post: Post) => async (threadId: string, message: string): Promise<boolean> =>
  [200, 202].includes(await post("/notify", { source: SOURCE, severity: "attention", text: message,
    dedupeKey: `${threadId}:first-turn-failed` }) ?? 0);

/** Owner alerts and the Telegram copy of images and cards iMessage would not take. */
export function telegramOutlet(outlet: Outlet) {
  const notify = async (severity: "attention" | "info", message: string, key: string): Promise<boolean> =>
    outcome(await outlet.post("/notify", { source: SOURCE, severity, text: message, dedupeKey: key })) === "sent";

  const appFile = async (url: URL): Promise<{ data: Buffer; name: string; mimeType: string } | undefined> => {
    const published = outlet.appsUrl();
    if (!published || new URL(published).origin !== url.origin) return;
    const path = await resolveAppFile(outlet.appsRoot, url.pathname);
    if (!path || (await stat(path)).size > MAX_FILE_BYTES) return;
    const file = basename(path);
    const name = file === "index.html" ? `${basename(dirname(path))}.html` : file;
    const mimeType = contentType(path).split(";", 1)[0]!.trim();
    return { data: await readFile(path), name: validFileName(name) ? name : "card.html", mimeType };
  };

  const fallback = async (item: OutboxRecord): Promise<"sent" | "skip" | "retry"> => {
    const key = `spectrum-fallback:${createHash("sha256").update(item.id).digest("hex").slice(0, 32)}`;
    if (item.attachment) {
      const { attachment } = item;
      if (attachment.size > MAX_FILE_BYTES) return "skip";
      let data: Uint8Array;
      try {
        data = outlet.blob(attachment.sha256);
      } catch {
        return "skip";
      }
      if (data.byteLength !== attachment.size || createHash("sha256").update(data).digest("hex") !== attachment.sha256) return "skip";
      return outcome(await outlet.post("/files", {
        base64: Buffer.from(data).toString("base64"),
        name: validFileName(attachment.name) ? attachment.name : "attachment",
        mimeType: validMimeType(attachment.mimeType) ? attachment.mimeType : "application/octet-stream",
        text: text(item.text, NOTE), dedupeKey: key,
      }));
    }
    if (!item.app) return "skip";
    let url: URL;
    try {
      url = new URL(item.app.url);
    } catch {
      return "skip";
    }
    // Secure forms carry a one-time secret link; they stay on iMessage only.
    if (item.id.startsWith("secret-form:") || url.pathname === "/_secret" || url.pathname.startsWith(SECRET_PREFIX)) return "skip";
    const caption = text(item.app.caption, item.app.subcaption, item.app.url, NOTE);
    let file: Awaited<ReturnType<typeof appFile>>;
    try {
      file = await appFile(url);
    } catch {
      file = undefined;
    }
    if (!file) return outcome(await outlet.post("/notify", { source: SOURCE, severity: "info", text: caption, dedupeKey: key }));
    return outcome(await outlet.post("/files", {
      base64: file.data.toString("base64"), name: file.name, mimeType: file.mimeType, text: caption, dedupeKey: key,
    }));
  };

  return { notify, fallback };
}
