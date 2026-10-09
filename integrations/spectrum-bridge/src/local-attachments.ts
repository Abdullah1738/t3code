import { existsSync } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, sep } from "node:path";

/**
 * Fallback for attachments Photon could not download. The same message is
 * also in this Mac's Messages database (the owner's Apple ID is signed in
 * here), so the file is looked up with the imsg CLI and copied from
 * ~/Library/Messages/Attachments. When Messages has not fetched it from
 * iCloud yet, pressing the attachment bubble in the Messages window (a
 * background AXPress through cua-driver) starts that download.
 */

export type ExecResult = { code: number; stdout: string };
export type Exec = (argv: string[], timeoutMs: number) => Promise<ExecResult>;

export type RecoveryRequest = {
  fileName: string;
  totalBytes: number;
  mimeType: string;
  /** When the bridge received the message; bounds the history search. */
  receivedAt?: number;
  maxBytes: number;
};

/** What was found, for the agent's note when the file itself is not recovered. */
export type RecoveryDetail = {
  chatId?: number;
  messageGuid?: string;
  path?: string;
  missing?: boolean;
  reason: string;
};

export type RecoveryResult = {
  file?: { data: Uint8Array; mimeType: string; name: string };
  detail: RecoveryDetail;
};

export type Recover = (request: RecoveryRequest) => Promise<RecoveryResult>;

export type RecoveryDeps = {
  exec?: Exec;
  imsg?: string;
  cuaDriver?: string;
  attachmentsRoot?: string;
  /** The imsg chat id that last matched, kept across restarts. */
  rememberedChat?: { get(): number | undefined; set(id: number): void };
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** How long to wait for Messages to finish an iCloud download. */
  downloadWaitMs?: number;
  pollMs?: number;
};

type ImsgAttachment = {
  missing?: boolean;
  total_bytes?: number;
  transfer_name?: string;
  original_path?: string;
  mime_type?: string;
};
type ImsgMessage = { guid?: string; created_at?: string; attachments?: ImsgAttachment[] };
type ImsgChat = { id?: number; identifier?: string; is_group?: boolean; last_message_at?: string };
type Match = { chatId: number; identifier?: string; message: ImsgMessage; attachment: ImsgAttachment };

const HISTORY_BEFORE_MS = 30 * 60_000;
const HISTORY_AFTER_MS = 10 * 60_000;
const MESSAGES_BUNDLE = "com.apple.MobileSMS";

function firstExisting(candidates: string[]): string {
  return candidates.find(path => existsSync(path)) ?? candidates[0]!;
}

export function spawnExec(): Exec {
  return async (argv, timeoutMs) => {
    const child = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    try {
      const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
      return { code, stdout };
    } finally {
      clearTimeout(timer);
    }
  };
}

function jsonLines<T>(text: string): T[] {
  const out: T[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as T); } catch { /* Skip log noise. */ }
  }
  return out;
}

function parseJson(text: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch { return; }
}

export function createAttachmentRecovery(deps: RecoveryDeps = {}): Recover {
  const exec = deps.exec ?? spawnExec();
  const imsg = deps.imsg ?? firstExisting(["/opt/homebrew/bin/imsg", "/usr/local/bin/imsg"]);
  const cua = deps.cuaDriver ?? firstExisting([join(homedir(), ".local/bin/cua-driver"), "/Applications/CuaDriver.app/Contents/MacOS/cua-driver"]);
  const attachmentsRoot = deps.attachmentsRoot ?? join(homedir(), "Library/Messages/Attachments");
  const sleep = deps.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const now = deps.now ?? Date.now;
  const waitMs = deps.downloadWaitMs ?? 90_000;
  const pollMs = deps.pollMs ?? 3_000;
  let remembered: number | undefined;

  const imsgJson = async <T>(args: string[]): Promise<T[]> => {
    const result = await exec([imsg, ...args, "--json"], 30_000);
    if (result.code !== 0) throw new Error("imsg failed");
    return jsonLines<T>(result.stdout);
  };

  const cuaCall = async (tool: string, args: Record<string, unknown>, timeoutMs = 30_000) => {
    const result = await exec([cua, "call", tool, JSON.stringify(args)], timeoutMs);
    const value = parseJson(result.stdout);
    if (result.code !== 0 || !value || value.status === "refused") throw new Error(`cua-driver ${tool} failed`);
    return value;
  };

  const sameFile = (request: RecoveryRequest, attachment: ImsgAttachment) =>
    attachment.transfer_name === request.fileName
    && (!request.totalBytes || attachment.total_bytes === undefined || attachment.total_bytes === request.totalBytes);

  const findIn = async (chat: ImsgChat, request: RecoveryRequest): Promise<Match | undefined> => {
    if (typeof chat.id !== "number") return;
    const at = request.receivedAt ?? now();
    const messages = await imsgJson<ImsgMessage>([
      "history", "--chat-id", String(chat.id), "--attachments", "--limit", "200",
      "--start", new Date(at - HISTORY_BEFORE_MS).toISOString(), "--end", new Date(at + HISTORY_AFTER_MS).toISOString(),
    ]);
    // Newest first in imsg output; the first hit is the latest copy of that file.
    for (const message of messages) {
      const attachment = message.attachments?.find(item => sameFile(request, item));
      if (attachment) return { chatId: chat.id, identifier: chat.identifier, message, attachment };
    }
  };

  const locate = async (request: RecoveryRequest): Promise<Match | undefined> => {
    const chats = (await imsgJson<ImsgChat>(["chats", "--limit", "20"])).filter(chat => chat.is_group === false);
    const at = request.receivedAt ?? now();
    const known = remembered ?? deps.rememberedChat?.get();
    // The bridge chat had a message at receive time, so only chats active since then can hold it.
    const active = chats.filter(chat => !chat.last_message_at || Date.parse(chat.last_message_at) >= at - HISTORY_BEFORE_MS);
    const ordered = [
      ...chats.filter(chat => chat.id === known),
      ...active.filter(chat => chat.id !== known),
    ].slice(0, 6);
    for (const chat of ordered) {
      const match = await findIn(chat, request).catch(() => undefined);
      if (match) {
        remembered = match.chatId;
        if (match.chatId !== known) deps.rememberedChat?.set(match.chatId);
        return match;
      }
    }
  };

  /** Only files inside Messages' own attachment store are read. */
  const safePath = async (path: string | undefined): Promise<string | undefined> => {
    if (!path) return;
    const expanded = path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
    try {
      const [root, real] = await Promise.all([realpath(attachmentsRoot), realpath(expanded)]);
      return real.startsWith(root + sep) ? real : undefined;
    } catch { return; }
  };

  const ready = async (match: Match, request: RecoveryRequest): Promise<string | undefined> => {
    const path = await safePath(match.attachment.original_path);
    if (!path) return;
    const info = await stat(path).catch(() => undefined);
    if (!info?.isFile()) return;
    const expected = match.attachment.total_bytes || request.totalBytes;
    return !expected || info.size === expected ? path : undefined;
  };

  /** Open the chat in Messages without fronting it and press the attachment bubble. */
  const triggerDownload = async (match: Match, request: RecoveryRequest): Promise<string> => {
    const launch = await cuaCall("launch_app", {
      bundle_id: MESSAGES_BUNDLE,
      ...(match.identifier ? { urls: [`imessage:${match.identifier}`] } : {}),
    });
    const pid = launch.pid;
    if (typeof pid !== "number") return "messagesNotRunning";
    // Give the conversation a moment to render after the URL switch.
    await sleep(1_500);
    const listed = await cuaCall("list_windows", { pid });
    const windows = (Array.isArray(listed.windows) ? listed.windows : []) as {
      window_id?: number; title?: string; layer?: number; bounds?: { width?: number; height?: number };
    }[];
    const candidates = windows
      .filter(w => typeof w.window_id === "number" && w.layer === 0 && w.title)
      .sort((a, b) => (b.bounds?.width ?? 0) * (b.bounds?.height ?? 0) - (a.bounds?.width ?? 0) * (a.bounds?.height ?? 0));
    for (const window of candidates) {
      const state = await cuaCall("get_window_state", {
        pid, window_id: window.window_id, include_screenshot: false, query: request.fileName,
      }).catch(() => undefined);
      const elements = (Array.isArray(state?.elements) ? state.elements : []) as {
        role?: string; label?: string; element_token?: string; actions?: string[];
      }[];
      const bubble = elements.filter(e => e.role === "AXButton" && e.element_token
        && e.label?.includes(request.fileName) && (e.actions ?? []).includes("AXPress")).at(-1);
      if (!bubble) continue;
      await cuaCall("click", { pid, window_id: window.window_id, element_token: bubble.element_token, action: "press" });
      return "pressed";
    }
    return "bubbleNotFound";
  };

  return async request => {
    let match: Match | undefined;
    try { match = await locate(request); } catch { return { detail: { reason: "imsgUnavailable" } }; }
    if (!match) return { detail: { reason: "notFoundInMessages" } };
    const detail: RecoveryDetail = {
      chatId: match.chatId,
      ...(match.message.guid ? { messageGuid: match.message.guid } : {}),
      ...(match.attachment.original_path ? { path: match.attachment.original_path } : {}),
      missing: match.attachment.missing === true,
      reason: "",
    };
    let path = await ready(match, request);
    if (!path) {
      let triggered: string;
      try { triggered = await triggerDownload(match, request); } catch { triggered = "cuaDriverFailed"; }
      if (triggered !== "pressed") return { detail: { ...detail, reason: triggered } };
      const deadline = now() + waitMs;
      while (!path && now() < deadline) {
        await sleep(pollMs);
        path = await ready(match, request);
      }
      if (!path) return { detail: { ...detail, reason: "messagesDownloadTimedOut" } };
    }
    const info = await stat(path);
    if (info.size > request.maxBytes) return { detail: { ...detail, reason: "tooLarge" } };
    const data = new Uint8Array(await readFile(path));
    return {
      file: { data, mimeType: match.attachment.mime_type || request.mimeType, name: match.attachment.transfer_name || request.fileName },
      detail: { ...detail, missing: false, reason: "copied" },
    };
  };
}
