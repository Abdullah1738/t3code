import { constants } from "node:fs";
import { lstat, open, stat } from "node:fs/promises";
import { request } from "node:http";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, join, resolve, win32 } from "node:path";
import { parseArgs } from "node:util";

type Command = { method: "GET" | "POST"; path: string; body?: Record<string, string> };

class CliError extends Error {}

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const validFileName = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0 && Buffer.byteLength(value) <= 255
  && value !== "." && value !== ".." && basename(value) === value && win32.basename(value) === value
  && !/[\x00-\x1f\x7f-\x9f]/.test(value);
export const validMimeType = (value: unknown): value is string =>
  typeof value === "string" && value.length <= 100 && !/[^\x21-\x7e]/.test(value)
  && /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/.test(value);

/** Matches the bridge's /notify source rule: at most 40 chars of [A-Za-z0-9 ._-]. */
export function sanitizeSource(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9 ._-]+/g, "-").replace(/-{2,}/g, "-").trim().slice(0, 40).trim().replace(/^-+|-+$/g, "");
  return cleaned || "agent";
}

export function parseCommand(args: string[]): Command {
  const optionsByCommand: Record<string, string[]> = {
    health: [],
    notify: ["source", "severity", "text", "key"],
    "send-file": ["file", "key", "text", "mime"],
    remind: ["at", "text", "key", "timezone"],
    reminders: [],
    notifications: [],
    cancel: [],
    snooze: ["at"],
  };
  const command = args[0];
  if (!command || !Object.hasOwn(optionsByCommand, command)) {
    throw new CliError("Expected health, notify, send-file, remind, reminders, notifications, cancel, or snooze");
  }

  let parsed;
  try {
    parsed = parseArgs({
      args: args.slice(1),
      options: Object.fromEntries(optionsByCommand[command]!.map(name => [name, { type: "string" as const }])),
      strict: true,
      allowPositionals: true,
      tokens: true,
    });
  } catch {
    // parseArgs errors can quote arbitrary argument values.
    throw new CliError("Invalid command arguments");
  }
  const { values, positionals, tokens } = parsed;
  const seen = new Set<string>();
  for (const token of tokens) {
    if (token.kind !== "option") continue;
    if (seen.has(token.name)) throw new CliError("Duplicate command option");
    seen.add(token.name);
  }
  const needsId = command === "cancel" || command === "snooze";
  if (positionals.length !== (needsId ? 1 : 0)) {
    throw new CliError(needsId ? "Expected exactly one reminder ID" : "Unexpected positional arguments");
  }
  function required(value: string | undefined, label: string): string {
    if (!value?.trim()) throw new CliError(`${label} is required and must not be empty`);
    return value;
  }

  let at: string | undefined;
  if (command === "remind" || command === "snooze") {
    at = required(values.at, "--at");
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(at);
    const [year, month, day, hour, minute, second, offsetHour, offsetMinute] =
      [match?.[1], match?.[2], match?.[3], match?.[4], match?.[5], match?.[6] ?? "0", match?.[8] ?? "0", match?.[9] ?? "0"].map(Number);
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (!match || month < 1 || month > 12 || day < 1 || day > days[month - 1]!
      || hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59
      || !Number.isFinite(Date.parse(at))) {
      throw new CliError("--at must be a valid ISO date-time with an explicit offset (Z or +/-HH:MM)");
    }
  }

  switch (command) {
    case "health":
    case "reminders":
    case "notifications":
      return { method: "GET", path: `/${command}` };
    case "notify": {
      const severity = values.severity ?? "info";
      if (!["info", "attention", "error"].includes(severity)) {
        throw new CliError("--severity must be info, attention, or error");
      }
      return {
        method: "POST", path: "/notify",
        body: { source: sanitizeSource(required(values.source, "--source")), severity, text: required(values.text, "--text"), dedupeKey: required(values.key, "--key") },
      };
    }
    case "send-file": {
      const file = required(values.file, "--file");
      if (!isAbsolute(file) || /[\x00-\x1f\x7f-\x9f]/.test(file) || !validFileName(basename(file))) {
        throw new CliError("--file must be an absolute path with a valid filename");
      }
      const dedupeKey = required(values.key, "--key");
      if (dedupeKey.length > 200) throw new CliError("--key must be at most 200 characters");
      const text = values.text ?? "";
      if (text.length > 12_000) throw new CliError("--text must be at most 12000 characters");
      const body: Record<string, string> = { file, dedupeKey, text };
      if (values.mime !== undefined) {
        if (!validMimeType(values.mime)) throw new CliError("Invalid --mime");
        body.mimeType = values.mime;
      }
      return { method: "POST", path: "/files", body };
    }
    case "remind": {
      const body = { text: required(values.text, "--text"), at: at!, idempotencyKey: required(values.key, "--key") } as Record<string, string>;
      if (values.timezone !== undefined) {
        const timezone = required(values.timezone, "--timezone");
        try {
          if (/^[+-]/.test(timezone)) throw new Error();
          new Intl.DateTimeFormat("en-US", { timeZone: timezone });
        } catch {
          throw new CliError("--timezone must be a valid IANA timezone");
        }
        body.timezone = timezone;
      }
      return { method: "POST", path: "/reminders", body };
    }
    case "cancel":
    case "snooze": {
      const id = required(positionals[0], "Reminder ID");
      return { method: "POST", path: `/reminders/${encodeURIComponent(id)}/${command}`, body: command === "cancel" ? {} : { at: at! } };
    }
    default:
      throw new CliError("Invalid command");
  }
}

/** Resolve local files only in the CLI. The API receives bytes, never a filesystem path. */
export async function loadCommandPayload(command: Command): Promise<Record<string, string> | undefined> {
  if (command.path !== "/files") return command.body;
  const { file, dedupeKey, text = "", mimeType } = command.body ?? {};
  if (typeof file !== "string" || !isAbsolute(file) || /[\x00-\x1f\x7f-\x9f]/.test(file) || !validFileName(basename(file))) {
    throw new CliError("--file must be an absolute path with a valid filename");
  }
  const name = basename(file);
  const mimeTypes: Record<string, string> = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
    ".webp": "image/webp", ".heic": "image/heic", ".heif": "image/heif", ".svg": "image/svg+xml",
    ".pdf": "application/pdf", ".txt": "text/plain", ".md": "text/markdown", ".json": "application/json",
    ".csv": "text/csv", ".zip": "application/zip", ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".mp4": "video/mp4", ".mov": "video/quicktime",
  };
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const protectedPaths = ["credentials.env", "state.sqlite", "state.sqlite-wal", "state.sqlite-shm", "state.sqlite-journal", "bridge.sock"]
      .map(item => join(homedir(), ".config", "telegram-bridge", item));
    if (protectedPaths.includes(resolve(file))) throw new CliError("Bridge credentials and state cannot be attached");
    const before = await lstat(file, { bigint: true });
    if (!before.isFile()) throw new CliError("Attachment must be a regular file, not a symlink");
    if (before.size === 0n || before.size > BigInt(MAX_FILE_BYTES)) throw new CliError("Attachment must contain 1 byte to 20 MiB");
    // Check identities too: a hard link, case alias, or parent symlink must not bypass the fixed exclusions.
    for (const path of protectedPaths) {
      const secret = await stat(path, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
      if (secret && secret.dev === before.dev && secret.ino === before.ino) throw new CliError("Bridge credentials and state cannot be attached");
    }
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const unchanged = (current: typeof before) => current.isFile() && current.dev === before.dev && current.ino === before.ino
      && current.size === before.size && current.mtimeNs === before.mtimeNs && current.ctimeNs === before.ctimeNs;
    if (!unchanged(await handle.stat({ bigint: true }))) throw new CliError("Attachment changed while reading");
    // One sentinel byte detects growth without allowing an expanding file to drive unbounded reads.
    const data = Buffer.alloc(Number(before.size) + 1);
    let size = 0;
    while (size < data.length) {
      const { bytesRead } = await handle.read(data, size, Math.min(64 * 1024, data.length - size), size);
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    if (size !== Number(before.size) || !unchanged(await handle.stat({ bigint: true }))
      || !unchanged(await lstat(file, { bigint: true }))) throw new CliError("Attachment changed while reading");
    return { base64: data.subarray(0, size).toString("base64"), name,
      mimeType: mimeType ?? mimeTypes[extname(name).toLowerCase()] ?? "application/octet-stream",
      text, dedupeKey };
  } catch (error) {
    throw error instanceof CliError ? error : new CliError("Attachment could not be read safely");
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function sendCommand(command: Command): Promise<unknown> {
  const socketPath = process.env.TELEGRAM_BRIDGE_SOCKET ?? join(homedir(), ".config/telegram-bridge", "bridge.sock");
  let socket;
  try {
    if (!isAbsolute(socketPath) || socketPath.includes("\0")) throw new Error();
    socket = await lstat(socketPath);
  } catch {
    throw new CliError("Bridge socket is unavailable");
  }
  // The daemon owns the private parent directory; never follow a socket symlink.
  if (!socket.isSocket()) throw new CliError("Bridge socket must be a Unix socket, not a file or symlink");

  const body = await loadCommandPayload(command);
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    return await new Promise<unknown>((resolve, reject) => {
      const fail = () => reject(new CliError(controller.signal.aborted ? "Bridge request timed out" : "Bridge request failed"));
      const req = request({
        socketPath, method: command.method, path: command.path, agent: false,
        signal: controller.signal, maxHeaderSize: 16 * 1024,
        headers: {
          Accept: "application/json",
          ...(payload === undefined ? {} : { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }),
        },
      }, res => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("error", fail);
        res.on("aborted", fail);
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 128 * 1024) {
            reject(new CliError("Bridge response exceeds 128 KB"));
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          if (!res.complete || size > 128 * 1024) { fail(); return; }
          const status = res.statusCode ?? 0;
          const ok = status >= 200 && status < 300;
          let data: unknown;
          try {
            data = JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
          } catch {
            reject(new CliError(ok ? "Bridge returned invalid JSON" : `Bridge request failed (HTTP ${status})`));
            return;
          }
          if (!ok) {
            // Only the daemon's sanitized error field may be surfaced, never the raw body.
            const detail = command.path !== "/files" && data && typeof data === "object" && !Array.isArray(data) && "error" in data && typeof data.error === "string"
              ? data.error.replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, 512) : "";
            reject(new CliError(`Bridge request failed (HTTP ${status})${detail ? `: ${detail}` : ""}`));
            return;
          }
          if (command.path === "/files") {
            if (!data || typeof data !== "object" || Array.isArray(data) || !("id" in data) || typeof data.id !== "string"
              || data.id.length !== 69 || !/^file:[a-f0-9]{64}$/.test(data.id) || !("created" in data) || typeof data.created !== "boolean") {
              reject(new CliError("Bridge returned an invalid file acknowledgement"));
              return;
            }
            // Queue acknowledgement only, not proof of upload or delivery. Never print echoed file contents.
            resolve({ id: data.id, created: data.created });
            return;
          }
          resolve(data);
        });
      });
      req.on("error", fail);
      req.end(payload);
    });
  } finally {
    clearTimeout(timer);
  }
}

if (import.meta.main) {
  try {
    console.log(JSON.stringify(await sendCommand(parseCommand(process.argv.slice(2)))));
  } catch (error) {
    console.error(JSON.stringify({ error: error instanceof CliError ? error.message : "Bridge request failed" }));
    process.exitCode = 1;
  }
}
