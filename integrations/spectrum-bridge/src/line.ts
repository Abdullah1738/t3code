/**
 * Provider-neutral shape of one iMessage line (today: a dedicated Sendblue
 * number). sendblue.ts implements it; the per-chat runtime and the Photon-shaped
 * transport shim consume it, so neither depends on Sendblue's wire format.
 */

import type { CardText } from "./card-text.ts";

/** "dm:<E.164 or Apple ID email>" for a 1:1 chat, "group:<Sendblue group_id>" for a group. */
export type ChatKey = `dm:${string}` | `group:${string}`;

export type LineLocation = {
  latitude: number;
  longitude: number;
  accuracy?: number;
  altitude?: number;
  /** ms since epoch of the fix. */
  at?: number;
};

/** The person is not sharing with the line, or shares but has no fix yet. */
export type LineNoFix = { state: "not_shared" | "shared_no_fix_yet" };

/** maxDurationMs: how long a start lasts unless refreshed or stopped (Sendblue: 1..300000). */
export type TypingOptions = { state?: "start" | "stop"; maxDurationMs?: number };

export type LineInbound = {
  /** Sendblue message_handle. */
  handle: string;
  chat: ChatKey;
  /** Sender address as Sendblue reports it (E.164 or Apple ID email). */
  from: string;
  text: string;
  /** CDN URL of the attached media, if any (expires after 30 days). */
  mediaUrl?: string;
  /** message_handle this message replies to. */
  replyTo?: string;
  /** message_handle of the first message of the inline-reply thread this joined (Sendblue thread_originator). */
  threadOrigin?: string;
  kind: "message" | "location" | "other";
  location?: LineLocation;
  service: string;
  groupName?: string;
  /** Group participants (addresses), empty for 1:1. */
  participants: string[];
  /** ms since epoch. */
  sentAt: number;
};

export type LineEvent =
  | { type: "message"; id: string; message: LineInbound }
  | { type: "typing"; id: string; chat: ChatKey; from: string; typing: boolean; at: number }
  | { type: "status"; id: string; handle: string; status: string; errorCode?: string; errorMessage?: string; at: number };

export type LineFile = { data: Uint8Array; name: string; mimeType: string };

export type LineAppCard = {
  url: string;
  caption: string;
  subcaption?: string;
  trailingCaption?: string;
  trailingSubcaption?: string;
  summary?: string;
  imageUrl?: string;
  /** Shown where the card can't render. */
  fallbackText?: string;
  /** false: Messages draws the static template bubble instead of asking the extension for a live view. */
  interactive?: boolean;
};

export type LineOutbound = {
  handle: string; chat: ChatKey; text: string; mediaUrl?: string;
  /** An app card: its page and the text its bubble shows, as sendApp cleaned it. */
  card?: { url: string; layout: CardText; sessionIdentifier?: string; updateMessageHandle?: string };
  sentAt: number; status: string;
};

// Provider strings can be message text, even when they look like machine keys.
const SENDBLUE_ERROR_KEYS = new Set(["invalid_number", "worker_unavailable", "stop_opt_out", "opted_out", "5504", "provider_error"]);
export function sendblueErrorKey(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 40) return;
  const key = value.toLowerCase();
  if (key === "stop") return "stop_opt_out";
  return SENDBLUE_ERROR_KEYS.has(key) ? key : undefined;
}

export function sendblueFailureCode(status: number, key?: string): string {
  return `http_${status}${key ? `:${sendblueErrorKey(key) ?? "provider_error"}` : ""}`;
}

/** Keep HTTP status and known provider codes; never promote arbitrary response fields into tags. */
export function safeLineFailureCode(code: string): string {
  const http = /^http_([1-5]\d{2})([\s\S]*)$/.exec(code);
  if (http) return sendblueFailureCode(Number(http[1]), http[2]!.replace(/^:/, ""));
  return LINE_FAILURE_CODE.test(code) ? code : "lineFailure";
}

export const LINE_FAILURE_CODE = /^(network|bad_response|no_handle|no_media_url|unsupported|invalid_app_card|card_preview_unavailable|too_large|download_failed|lineFailure|sendUnconfirmed|http_[1-5]\d{2}(?::(?:invalid_number|worker_unavailable|stop_opt_out|opted_out|5504|provider_error))?)$/;
export const isOptedOut = (code: string): boolean => /^http_4\d\d:opted_out$/.test(code);

export type SendOptions = { replyTo?: string; sendStyle?: string; /** From upload(). */ mediaUrl?: string };

export interface Line {
  /** The dedicated line's own number. */
  readonly number: string;
  /** Live events (messages, typing, delivery status). Reconnects by itself until the signal aborts. Not durable. */
  events(signal: AbortSignal): AsyncIterable<LineEvent>;
  /** Inbound messages updated at or after sinceMs, oldest first. Repairs gaps after a reconnect or restart. */
  backfill(sinceMs: number): Promise<LineInbound[]>;
  /** Outbound messages to a chat since sinceMs, used to tell whether an uncertain send actually went out. */
  outbound(chat: ChatKey, sinceMs: number): Promise<LineOutbound[]>;
  /** Text and/or media. Empty text is allowed when options.mediaUrl is set. */
  sendText(chat: ChatKey, text: string, options?: SendOptions): Promise<{ handle: string }>;
  /** Uploads a file and returns the media_url to pass to sendText. */
  upload(file: LineFile): Promise<string>;
  /** One message by handle (inbound or outbound), for reply context. */
  getMessage(handle: string): Promise<LineInbound | LineOutbound | undefined>;
  sendApp(chat: ChatKey, card: LineAppCard): Promise<{ handle: string }>;
  updateApp?(originalHandle: string, card: LineAppCard, key: string): Promise<{ handle: string }>;
  /** Tapback name (love, like, dislike, laugh, emphasize, question) or a single emoji. Inbound messages only. */
  react(handle: string, reaction: string): Promise<void>;
  /** Shows (default) or clears our typing bubble. 1:1 only; a no-op for groups. */
  typing(chat: ChatKey, options?: TypingOptions): Promise<void>;
  /** Marks the chat read. 1:1 only; a no-op for groups. */
  read(chat: ChatKey): Promise<void>;
  /** Sends a Find My location request card. */
  requestLocation(chat: ChatKey): Promise<void>;
  /** Latest shared location for a person; a LineNoFix says why there is none, undefined if unknown. */
  location(address: string): Promise<LineLocation | LineNoFix | undefined>;
  setOptOut(address: string, optedOut: boolean): Promise<void>;
  download(url: string, maxBytes: number, timeoutMs: number): Promise<LineFile>;
}

/** Every Line failure. retryable: safe to try again. uncertain: the request may have gone through. */
export class LineError extends Error {
  constructor(message: string, readonly code: string, readonly retryable: boolean, readonly uncertain: boolean) {
    super(message);
    this.name = "LineError";
  }
}

// Sendblue sends app cards one-to-one only; refusing at queue time keeps a group from getting a silent delivery failure.
export const GROUP_APP_REFUSAL = "App cards don't work in group chats; send the link as text instead";

export const chatKey = {
  dm: (address: string): ChatKey => `dm:${address}`,
  group: (groupId: string): ChatKey => `group:${groupId}`,
  isGroup: (key: ChatKey) => key.startsWith("group:"),
  target: (key: ChatKey) => key.slice(key.indexOf(":") + 1),
};
