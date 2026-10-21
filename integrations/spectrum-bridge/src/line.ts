/**
 * Provider-neutral shape of one iMessage line (today: a dedicated Sendblue
 * number). sendblue.ts implements it; the per-chat runtime and the Photon-shaped
 * transport shim consume it, so neither depends on Sendblue's wire format.
 */

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
};

export type LineOutbound = { handle: string; chat: ChatKey; text: string; mediaUrl?: string; sentAt: number; status: string };

export type SendOptions = { replyTo?: string; sendStyle?: string };

export interface Line {
  /** The dedicated line's own number. */
  readonly number: string;
  /** Live events (messages, typing, delivery status). Reconnects by itself until the signal aborts. Not durable. */
  events(signal: AbortSignal): AsyncIterable<LineEvent>;
  /** Inbound messages updated at or after sinceMs, oldest first. Repairs gaps after a reconnect or restart. */
  backfill(sinceMs: number): Promise<LineInbound[]>;
  /** Outbound messages to a chat since sinceMs, used to tell whether an uncertain send actually went out. */
  outbound(chat: ChatKey, sinceMs: number): Promise<LineOutbound[]>;
  sendText(chat: ChatKey, text: string, options?: SendOptions): Promise<{ handle: string }>;
  sendFile(chat: ChatKey, file: LineFile, options?: SendOptions & { text?: string }): Promise<{ handle: string }>;
  sendApp(chat: ChatKey, card: LineAppCard): Promise<{ handle: string }>;
  /** Tapback name (love, like, dislike, laugh, emphasize, question) or a single emoji. Inbound messages only. */
  react(handle: string, reaction: string): Promise<void>;
  /** Shows our typing bubble. 1:1 only; a no-op for groups. */
  typing(chat: ChatKey): Promise<void>;
  /** Marks the chat read. 1:1 only; a no-op for groups. */
  read(chat: ChatKey): Promise<void>;
  /** Sends a Find My location request card. */
  requestLocation(chat: ChatKey): Promise<void>;
  /** Latest shared location for a person, if they share it with the line. */
  location(address: string): Promise<LineLocation | undefined>;
  download(url: string, maxBytes: number, timeoutMs: number): Promise<LineFile>;
}

/** Every Line failure. retryable: safe to try again. uncertain: the request may have gone through. */
export class LineError extends Error {
  constructor(message: string, readonly code: string, readonly retryable: boolean, readonly uncertain: boolean) {
    super(message);
    this.name = "LineError";
  }
}

export const chatKey = {
  dm: (address: string): ChatKey => `dm:${address}`,
  group: (groupId: string): ChatKey => `group:${groupId}`,
  isGroup: (key: ChatKey) => key.startsWith("group:"),
  target: (key: ChatKey) => key.slice(key.indexOf(":") + 1),
};
