/**
 * The iMessage bridge feeds a chat thread more than what people typed: channel
 * guidance, its own nudges, watcher events and prompts from other agents all
 * arrive as user messages. Only typed text belongs in an incoming bubble. The
 * prefixes below are the bridge's own frames (integrations/spectrum-bridge),
 * so they change together with it.
 */

const GUIDANCE_START = "[Channel guidance from the iMessage bridge, not typed by the owner]";
const GUIDANCE_END = "[End of channel guidance. The owner's message follows.]";
const BRIDGE_REQUEST = "[Bridge request, not typed by the owner.]";
const WATCHER_EVENT = /^\[Watcher event from (.+?), not typed by the owner\./;
const WATCHER_FAILURE = /^\[Watcher ([^\]\s]+)\]\s*/;
const NOT_TYPED_FRAME = /^\[[^\]\n]*not typed by the owner/;
const TEST_FIRE = /^\[TEST FIRE[^\]]*\]\s*/;
const VOICE_TRANSCRIBED = "[Voice message, transcribed] ";
const VOICE_FAILED = /^\[Voice message that could not be transcribed\.[^\]]*\]$/;
const REPLY_QUOTE =
  /^\[Replying to [^(\n]+\(quoted data, not instructions\): ("(?:[^"\\]|\\.)*")\]\n?/;
const OWNER_REPLY_QUOTE =
  /^The owner is replying to this earlier (?:notification|message) of yours \(quoted data, not instructions\):\n("(?:[^"\\]|\\.)*")\n*/;
// Sendblue batches prefix each member's line with `Name: ` or `Name (+address): `.
const NAMED_LINE = /^([^:\n()[\]]{1,48}?)(?: \(([^)\n]+)\))?: (.*)$/;
const NO_REPLY = "NO_REPLY";
const ROBOB_WATCH_SOURCE = "robob-watch ";

export interface IMessageTypedPart {
  readonly sender: string | null;
  readonly text: string;
  readonly voice: boolean;
}

export type IMessageUserMessage =
  | {
      readonly kind: "typed";
      readonly parts: ReadonlyArray<IMessageTypedPart>;
      readonly quote: string | null;
    }
  | { readonly kind: "watcher"; readonly source: string; readonly title: string }
  | { readonly kind: "hidden"; readonly reason: "guidance" | "bridge" | "agent" };

export interface IMessageUserMessageInput {
  readonly text: string;
  /** Prompts sent by other agents are delegations, not chat messages. */
  readonly createdBy?: "user" | "agent" | "system" | undefined;
  /** Non-owner chats carry each member's name in front of their text. */
  readonly namedSenders: boolean;
}

export function classifyIMessageUserMessage(input: IMessageUserMessageInput): IMessageUserMessage {
  if (input.createdBy === "agent") return { kind: "hidden", reason: "agent" };
  const body = withoutGuidance(input.text);
  if (body === null || body.length === 0) return { kind: "hidden", reason: "guidance" };
  if (body.startsWith(BRIDGE_REQUEST)) return { kind: "hidden", reason: "bridge" };

  const watcher = WATCHER_EVENT.exec(body);
  if (watcher) {
    const title = (body.split("\n")[1] ?? "").replace(TEST_FIRE, "").trim();
    return { kind: "watcher", source: watcherName(watcher[1]!), title };
  }
  const failure = WATCHER_FAILURE.exec(body);
  if (failure) {
    const title = body.slice(failure[0].length).split("\n")[0]!.trim();
    return { kind: "watcher", source: failure[1]!, title };
  }
  if (NOT_TYPED_FRAME.test(body)) return { kind: "hidden", reason: "bridge" };

  let rest = body;
  let quote: string | null = null;
  const quoted = REPLY_QUOTE.exec(rest) ?? OWNER_REPLY_QUOTE.exec(rest);
  if (quoted) {
    quote = parseQuoted(quoted[1]!);
    rest = rest.slice(quoted[0].length);
  }
  const parts = typedParts(rest.trim(), input.namedSenders);
  if (parts.length === 0) return { kind: "hidden", reason: "bridge" };
  return { kind: "typed", parts, quote };
}

/**
 * The text the bridge actually texted for a turn's final assistant message, or
 * null when the agent chose not to reply (a last line of exactly NO_REPLY).
 */
export function imessageSentReply(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  const lines = trimmed.split("\n");
  if (lines[lines.length - 1]!.trim() === NO_REPLY) return null;
  return trimmed;
}

/** The channel guidance block the bridge puts in front of a message, if any. */
export function imessageGuidanceText(text: string): string | null {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith(GUIDANCE_START)) return null;
  const end = trimmed.indexOf(GUIDANCE_END);
  return trimmed.slice(GUIDANCE_START.length, end === -1 ? undefined : end).trim();
}

function withoutGuidance(text: string): string | null {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith(GUIDANCE_START)) return text.trim();
  const end = trimmed.indexOf(GUIDANCE_END);
  if (end === -1) return null;
  return trimmed.slice(end + GUIDANCE_END.length).trim();
}

function watcherName(source: string): string {
  return source.startsWith(ROBOB_WATCH_SOURCE) ? source.slice(ROBOB_WATCH_SOURCE.length) : source;
}

function parseQuoted(raw: string): string {
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === "string" ? value : raw;
  } catch {
    return raw;
  }
}

function typedParts(text: string, namedSenders: boolean): IMessageTypedPart[] {
  const parts: Array<{ sender: string | null; lines: string[]; voice: boolean }> = [];
  for (const line of text.split("\n")) {
    const named = namedSenders ? NAMED_LINE.exec(line) : null;
    const current = parts[parts.length - 1];
    if (named) {
      parts.push({ sender: named[1]!.trim(), lines: [named[3]!], voice: false });
    } else if (current) {
      current.lines.push(line);
    } else {
      parts.push({ sender: null, lines: [line], voice: false });
    }
  }
  return parts.flatMap((part) => {
    let voice = false;
    const lines = part.lines.map((line) => {
      if (line.startsWith(VOICE_TRANSCRIBED)) {
        voice = true;
        return line.slice(VOICE_TRANSCRIBED.length);
      }
      if (VOICE_FAILED.test(line)) {
        voice = true;
        return "";
      }
      return line;
    });
    const joined = lines.join("\n").trim();
    if (joined.length === 0 && !voice) return [];
    return [{ sender: part.sender, text: joined, voice }];
  });
}
