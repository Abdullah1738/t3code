/**
 * What an iMessage chat thread actually texted. Since the bridge's tool mode, a
 * turn's final message is the agent's own note and never leaves the Mac: texts
 * go out through the `imessage_send` T3 MCP tool, or the bridge CLI's `send` and
 * `send-file` commands run from a shell. Both are read from the turn's items.
 */

/** The bridge says this in every guidance block once replies go out by tool. */
export const IMESSAGE_TOOL_MODE_MARKER = "Your final message is not sent to the chat.";

export type IMessageSendState = "sent" | "sending" | "failed";

export interface IMessageSend {
  readonly id: string;
  /** The text, or a file's caption; empty for a bare file. */
  readonly text: string;
  /** The file's name, when one went with it. */
  readonly file: string | null;
  /** Another chat's slug when the owner's chat texted it; null for this chat. */
  readonly to: string | null;
  readonly state: IMessageSendState;
  /** How it left: the MCP tool, the bridge CLI, or (before tool mode) the turn's final message. */
  readonly via: "tool" | "cli" | "final";
  readonly createdAt: string;
}

export interface IMessageSendSource {
  readonly id: string;
  readonly createdAt: string;
  readonly tone: "thinking" | "tool" | "info" | "error";
  readonly command?: string | undefined;
  readonly payload?: unknown;
}

// A send that was cancelled or interrupted may never have reached the bridge.
const FAILED: ReadonlySet<string> = new Set(["failed", "cancelled", "interrupted", "declined"]);
const PENDING: ReadonlySet<string> = new Set(["idle", "pending", "running", "waiting"]);
const SEND_TOOL = /(?:^|[^a-z0-9])imessage_send$/i;
const BRIDGE_CLI = /spectrum-bridge\/src\/cli\.ts$/;

/** Whether a tool name is the T3 `imessage_send` tool under any harness's prefix. */
export function isIMessageSendTool(name: string | null | undefined): boolean {
  return typeof name === "string" && SEND_TOOL.test(name.trim());
}

/** The send a work step made, or null when the step sent nothing. */
export function imessageSendOf(source: IMessageSendSource): IMessageSend | null {
  return toolSend(source) ?? cliSend(source);
}

function toolSend(source: IMessageSendSource): IMessageSend | null {
  const payload = record(source.payload);
  if (payload === null || payload.type !== "dynamic_tool") return null;
  if (!isIMessageSendTool(typeof payload.toolName === "string" ? payload.toolName : null)) {
    return null;
  }
  const input = record(payload.input) ?? {};
  const text = typeof input.text === "string" ? input.text : "";
  const file = typeof input.file === "string" && input.file.length > 0 ? input.file : null;
  if (text.trim().length === 0 && file === null) return null;
  return {
    id: source.id,
    text: text.trim(),
    file: file === null ? null : baseName(file),
    to: typeof input.to === "string" && input.to.length > 0 ? input.to : null,
    state: sendState(source.tone, payload.status, payload.output),
    via: "tool",
    createdAt: source.createdAt,
  };
}

function cliSend(source: IMessageSendSource): IMessageSend | null {
  if (source.command === undefined || !source.command.includes("spectrum-bridge")) return null;
  for (const words of shellCommands(source.command)) {
    const cli = words.findIndex((word) => BRIDGE_CLI.test(word));
    const verb = cli < 0 ? undefined : words[cli + 1];
    if (verb !== "send" && verb !== "send-file") continue;
    const flags = parseFlags(words.slice(cli + 2));
    const text = flags.get("text") ?? "";
    const file = verb === "send-file" ? (flags.get("file") ?? null) : null;
    if (text.trim().length === 0 && file === null) continue;
    const payload = record(source.payload);
    return {
      id: source.id,
      text: text.trim(),
      file: file === null ? null : baseName(file),
      to: flags.get("to") ?? null,
      state: sendState(source.tone, payload?.status, undefined),
      via: "cli",
      createdAt: source.createdAt,
    };
  }
  return null;
}

function sendState(tone: IMessageSendSource["tone"], status: unknown, output: unknown) {
  if (tone === "error" || FAILED.has(String(status))) return "failed";
  const result = record(output);
  if (result !== null && result.isError === true) return "failed";
  if (PENDING.has(String(status))) return "sending";
  return "sent";
}

function parseFlags(words: ReadonlyArray<string>): Map<string, string> {
  const flags = new Map<string, string>();
  for (let index = 0; index < words.length; index++) {
    const word = words[index]!;
    if (!word.startsWith("--")) continue;
    const equals = word.indexOf("=");
    if (equals > 0) {
      flags.set(word.slice(2, equals), word.slice(equals + 1));
    } else if (index + 1 < words.length && !words[index + 1]!.startsWith("--")) {
      flags.set(word.slice(2), words[index + 1]!);
      index++;
    }
  }
  return flags;
}

/**
 * Splits a shell line into simple commands of words. Quotes, backslashes and
 * `$'...'` are honoured; `$(...)` and variables stay as written. Good enough to
 * read the flags of one CLI call, not a shell.
 */
export function shellCommands(line: string): string[][] {
  const commands: string[][] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  const endWord = () => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length > 0) commands.push(words);
    words = [];
  };
  for (let index = 0; index < line.length; index++) {
    const char = line[index]!;
    if (char === "'") {
      const close = line.indexOf("'", index + 1);
      word += line.slice(index + 1, close < 0 ? undefined : close);
      inWord = true;
      index = close < 0 ? line.length : close;
    } else if (char === "$" && line[index + 1] === "'") {
      const [value, end] = ansiQuoted(line, index + 2);
      word += value;
      inWord = true;
      index = end;
    } else if (char === '"') {
      let index2 = index + 1;
      while (index2 < line.length && line[index2] !== '"') {
        if (line[index2] === "\\" && /["\\$`]/.test(line[index2 + 1] ?? "")) index2++;
        word += line[index2];
        index2++;
      }
      inWord = true;
      index = index2;
    } else if (char === "\\") {
      if (line[index + 1] === "\n") {
        index++;
        continue;
      }
      word += line[index + 1] ?? "";
      inWord = true;
      index++;
    } else if (char === "\n" || char === ";" || char === "|" || char === "&") {
      endCommand();
    } else if (char === " " || char === "\t") {
      endWord();
    } else {
      word += char;
      inWord = true;
    }
  }
  endCommand();
  return commands;
}

const ANSI_ESCAPES: Record<string, string> = { n: "\n", t: "\t", "'": "'", "\\": "\\", '"': '"' };

function ansiQuoted(line: string, start: number): [string, number] {
  let value = "";
  let index = start;
  while (index < line.length && line[index] !== "'") {
    if (line[index] === "\\" && index + 1 < line.length) {
      const next = line[index + 1]!;
      value += ANSI_ESCAPES[next] ?? `\\${next}`;
      index += 2;
      continue;
    }
    value += line[index];
    index++;
  }
  return [value, index];
}

function baseName(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
