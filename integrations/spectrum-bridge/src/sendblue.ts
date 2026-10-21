/**
 * Sendblue implementation of the provider-neutral Line interface. Wire shapes
 * are read defensively (unknown + narrowing) because Sendblue's responses carry
 * many optional, string-or-null fields and we only need a handful of them.
 */
import { cardSafeText } from "./card-text.ts";
import type { SendblueOptions } from "./chats.ts";
import { SPECTRUM_CARD_APP, type CardApp } from "./config.ts";
import { chatKey, LineError, type ChatKey, type Line, type LineAppCard, type LineEvent, type LineFile, type LineInbound, type LineLocation, type LineNoFix, type LineOutbound, type SendOptions, type TypingOptions } from "./line.ts";

const BASE = "https://api.sendblue.com";
const REQUEST_TIMEOUT_MS = 30_000;
const PAGE_SIZE = 100;
const EVENT_DEDUPE_LIMIT = 512;

// Used when a caption is nothing but a time or date; the page still has the details.
const BLANK_CAPTION = "Open card";

export type SendblueClientOptions = SendblueOptions & {
  /** Messages extension the cards open in; defaults to Photon's Spectrum app. */
  cardApp?: CardApp;
  /** Test seam: shrink the SSE reconnect backoff and stall watchdog. */
  timing?: { backoffMinMs?: number; backoffMaxMs?: number; stallMs?: number };
};

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);
const num = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
const timeMs = (value: unknown): number | undefined => {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};
const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function toLocation(value: Json): LineLocation | undefined {
  const latitude = num(value.latitude);
  const longitude = num(value.longitude);
  if (latitude === undefined || longitude === undefined) return undefined;
  return { latitude, longitude, accuracy: num(value.accuracy), altitude: num(value.altitude), at: timeMs(value.timestamp) };
}

function chatOf(message: Json, inbound: boolean): ChatKey {
  const group = str(message.group_id);
  if (group) return chatKey.group(group);
  const peer = inbound ? str(message.from_number) : (str(message.number) ?? str(message.to_number));
  return chatKey.dm(peer ?? "");
}

export function toInbound(message: Json): LineInbound {
  const type = str(message.message_type);
  const kind: LineInbound["kind"] = type === "location" ? "location" : type === "message" || type === "group" ? "message" : "other";
  const replyTo = isObject(message.reply_to) ? str(message.reply_to.message_handle) : undefined;
  const location = isObject(message.location) ? toLocation(message.location) : undefined;
  return {
    handle: str(message.message_handle) ?? str(message.message_id) ?? "",
    chat: chatOf(message, true),
    from: str(message.from_number) ?? "",
    text: str(message.content) ?? "",
    mediaUrl: str(message.media_url),
    replyTo,
    kind,
    location,
    service: str(message.service) ?? "",
    groupName: str(message.group_display_name),
    participants: Array.isArray(message.participants) ? message.participants.filter((p): p is string => typeof p === "string") : [],
    sentAt: timeMs(message.date_sent) ?? Date.now(),
  };
}

export function toOutbound(message: Json): LineOutbound {
  return {
    handle: str(message.message_handle) ?? "",
    chat: chatOf(message, false),
    text: str(message.content) ?? "",
    mediaUrl: str(message.media_url),
    sentAt: timeMs(message.date_sent) ?? Date.now(),
    status: str(message.status) ?? "",
  };
}

function handleOf(response: unknown): string {
  const direct = isObject(response) ? str(response.message_handle) : undefined;
  const nested = isObject(response) && isObject(response.data) ? str(response.data.message_handle) : undefined;
  const handle = direct ?? nested;
  if (!handle) throw new LineError("Sendblue accepted the send without a message handle", "no_handle", false, true);
  return handle;
}

function errorCodeOf(message: Json): string | undefined {
  const key = str(message.error_key);
  if (key) return key;
  const code = num(message.error_code);
  return code === undefined ? undefined : String(code);
}

type Frame = { id?: string; event?: string; data: string };

/** Minimal SSE parser: buffers across chunk boundaries, ignores comments (heartbeats), dispatches on blank lines. */
async function* sseFrames(body: ReadableStream<Uint8Array>, onChunk: () => void): AsyncGenerator<Frame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let id: string | undefined;
  let event: string | undefined;
  let dataLines: string[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    onChunk();
    buffer += decoder.decode(value, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (line === "") {
        if (dataLines.length > 0) yield { id, event, data: dataLines.join("\n") };
        id = undefined;
        event = undefined;
        dataLines = [];
        continue;
      }
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      let fieldValue = colon === -1 ? "" : line.slice(colon + 1);
      if (fieldValue.startsWith(" ")) fieldValue = fieldValue.slice(1);
      if (field === "data") dataLines.push(fieldValue);
      else if (field === "id") id = fieldValue;
      else if (field === "event") event = fieldValue;
    }
  }
}

class Seen {
  readonly #keys = new Set<string>();
  constructor(private readonly limit: number) {}
  has(key: string): boolean {
    return this.#keys.has(key);
  }
  add(key: string): void {
    this.#keys.add(key);
    if (this.#keys.size <= this.limit) return;
    const oldest = this.#keys.values().next().value;
    if (oldest !== undefined) this.#keys.delete(oldest);
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

export class Sendblue implements Line {
  readonly number: string;
  readonly #keyId: string;
  readonly #secret: string;
  readonly #fetch: typeof fetch;
  readonly #backoffMinMs: number;
  readonly #backoffMaxMs: number;
  readonly #stallMs: number;
  readonly #cardApp: CardApp;

  constructor(options: SendblueClientOptions) {
    this.number = options.number;
    this.#keyId = options.keyId;
    this.#secret = options.secret;
    this.#fetch = options.fetch ?? fetch;
    this.#backoffMinMs = options.timing?.backoffMinMs ?? 1_000;
    this.#backoffMaxMs = options.timing?.backoffMaxMs ?? 30_000;
    this.#stallMs = options.timing?.stallMs ?? 45_000;
    this.#cardApp = options.cardApp ?? SPECTRUM_CARD_APP;
  }

  #headers(): Record<string, string> {
    return { "sb-api-key-id": this.#keyId, "sb-api-secret-key": this.#secret };
  }

  /**
   * `send` marks requests that create a message: a network failure or a 5xx
   * after the request left may still have sent it (no idempotency key), so the
   * error is flagged uncertain for the caller's reconciliation.
   */
  async #call(method: "GET" | "POST" | "DELETE", path: string, options: { query?: Record<string, string>; json?: Json; form?: FormData; send?: boolean; allow404?: boolean } = {}): Promise<unknown> {
    const url = new URL(path, BASE);
    for (const [key, value] of Object.entries(options.query ?? {})) url.searchParams.set(key, value);
    const headers: Record<string, string> = this.#headers();
    let body: string | FormData | undefined;
    if (options.json) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(options.json);
    }
    if (options.form) body = options.form;
    const send = options.send === true;

    let response: Response;
    try {
      response = await this.#fetch(url, { method, headers, body, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (error) {
      throw new LineError(`Sendblue ${method} ${path} failed: ${describe(error)}`, "network", true, send);
    }

    const text = await response.text().catch(() => "");
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    if (response.status === 404 && options.allow404) return undefined;
    if (response.ok) return parsed;

    const status = response.status;
    const detail = isObject(parsed) ? (str(parsed.message) ?? str(parsed.error_reason) ?? str(parsed.error)) : undefined;
    const errorKey = isObject(parsed) ? (str(parsed.error_key) ?? str(parsed.error) ?? (num(parsed.error_code) === undefined ? undefined : String(parsed.error_code))) : undefined;
    const code = errorKey ? `http_${status}:${errorKey}` : `http_${status}`;
    const message = `Sendblue ${method} ${path} returned ${status}${detail ? `: ${detail.slice(0, 200)}` : ""}`;
    if (status === 429) throw new LineError(message, code, true, false);
    if (status >= 500) throw new LineError(message, code, true, send);
    throw new LineError(message, code, false, false);
  }

  async *events(signal: AbortSignal): AsyncIterable<LineEvent> {
    const seen = new Seen(EVENT_DEDUPE_LIMIT);
    let backoff = this.#backoffMinMs;
    while (!signal.aborted) {
      const connection = new AbortController();
      const abort = () => connection.abort();
      signal.addEventListener("abort", abort, { once: true });
      let stall: ReturnType<typeof setTimeout> | undefined;
      // The server heartbeats every 15 s; silence for longer means the connection is dead.
      const touch = () => {
        clearTimeout(stall);
        stall = setTimeout(() => connection.abort(), this.#stallMs);
      };
      try {
        const response = await this.#fetch(`${BASE}/api/v2/events`, {
          headers: { ...this.#headers(), accept: "text/event-stream" },
          signal: connection.signal,
        });
        if (!response.ok || !response.body) throw new LineError(`Sendblue events stream returned ${response.status}`, `http_${response.status}`, true, false);
        backoff = this.#backoffMinMs;
        touch();
        for await (const frame of sseFrames(response.body, touch)) {
          const event = this.#toEvent(frame, seen);
          if (event) yield event;
        }
      } catch {
        // Stream errors and stall aborts both end in a reconnect below; only the caller's signal stops the loop.
      } finally {
        clearTimeout(stall);
        signal.removeEventListener("abort", abort);
      }
      if (signal.aborted) return;
      await sleep(backoff, signal);
      backoff = Math.min(backoff * 2, this.#backoffMaxMs);
    }
  }

  #toEvent(frame: Frame, seen: Seen): LineEvent | undefined {
    let envelope: unknown;
    try {
      envelope = JSON.parse(frame.data);
    } catch {
      return undefined;
    }
    if (!isObject(envelope)) return undefined;
    const type = str(envelope.type) ?? frame.event;
    const id = str(envelope.id) ?? frame.id;
    if (!type || !id || seen.has(id)) return undefined;
    seen.add(id);
    const data = isObject(envelope.data) ? envelope.data : envelope;
    const at = timeMs(envelope.occurred_at) ?? Date.now();

    switch (type) {
      case "message.received":
        if (data.is_outbound === true) return undefined;
        return { type: "message", id, message: toInbound(data) };
      case "message.created":
      case "message.updated":
        if (data.is_outbound !== true) return undefined;
        return {
          type: "status",
          id,
          handle: str(data.message_handle) ?? str(data.message_id) ?? "",
          status: str(data.status) ?? "",
          errorCode: errorCodeOf(data),
          errorMessage: str(data.error_reason) ?? str(data.error_message),
          at: timeMs(data.date_updated) ?? at,
        };
      case "typing.changed": {
        const number = str(data.number);
        if (!number) return undefined;
        const group = str(data.group_id);
        return {
          type: "typing",
          id,
          chat: group ? chatKey.group(group) : chatKey.dm(number),
          from: number,
          typing: data.is_typing === true,
          at: timeMs(data.timestamp) ?? at,
        };
      }
      default:
        return undefined;
    }
  }

  /** Pages through /api/v2/messages; the caller applies per-direction and per-chat filters. */
  async #list(filters: Record<string, string>, sinceMs: number): Promise<Json[]> {
    const out: Json[] = [];
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const response = await this.#call("GET", "/api/v2/messages", {
        query: {
          ...filters,
          sendblue_number: this.number,
          updated_at_gte: new Date(sinceMs).toISOString(),
          order_by: "updated_at",
          order_direction: "asc",
          limit: String(PAGE_SIZE),
          offset: String(offset),
        },
      });
      const page = isObject(response) && Array.isArray(response.data) ? response.data.filter((row): row is Json => isObject(row)) : [];
      out.push(...page);
      if (page.length < PAGE_SIZE) return out;
    }
  }

  async backfill(sinceMs: number): Promise<LineInbound[]> {
    const rows = await this.#list({ is_outbound: "false" }, sinceMs);
    return rows.filter((row) => row.is_outbound !== true && (str(row.sendblue_number) ?? str(row.to_number)) === this.number).map(toInbound);
  }

  async outbound(chat: ChatKey, sinceMs: number): Promise<LineOutbound[]> {
    const group = chatKey.isGroup(chat);
    const target = chatKey.target(chat);
    const filters: Record<string, string> = group ? { is_outbound: "true", group_id: target } : { is_outbound: "true", number: target };
    const rows = await this.#list(filters, sinceMs);
    return rows.filter((row) => toOutbound(row).chat === chat).map(toOutbound);
  }

  async sendText(chat: ChatKey, text: string, options: SendOptions = {}): Promise<{ handle: string }> {
    const common: Json = { from_number: this.number, content: text };
    if (options.mediaUrl) common.media_url = options.mediaUrl;
    if (options.replyTo) common.reply_to = { message_handle: options.replyTo };
    if (options.sendStyle) common.send_style = options.sendStyle;
    const target = chatKey.target(chat);
    const response = chatKey.isGroup(chat)
      ? await this.#call("POST", "/api/send-group-message", { json: { group_id: target, ...common }, send: true })
      : await this.#call("POST", "/api/send-message", { json: { number: target, ...common }, send: true });
    return { handle: handleOf(response) };
  }

  async upload(file: LineFile): Promise<string> {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(file.data)], { type: file.mimeType }), file.name);
    const response = await this.#call("POST", "/api/upload-file", { form });
    const mediaUrl = isObject(response) ? str(response.media_url) : undefined;
    if (!mediaUrl) throw new LineError("Sendblue upload returned no media_url", "no_media_url", false, false);
    return mediaUrl;
  }

  async getMessage(handle: string): Promise<LineInbound | LineOutbound | undefined> {
    const response = await this.#call("GET", `/api/v2/messages/${encodeURIComponent(handle)}`, { allow404: true });
    if (response === undefined) return undefined;
    const wrapped = isObject(response) ? response.data : undefined;
    const message = isObject(wrapped) ? wrapped : isObject(response) ? response : undefined;
    if (!message) return undefined;
    return message.is_outbound === true ? toOutbound(message) : toInbound(message);
  }

  async sendApp(chat: ChatKey, card: LineAppCard): Promise<{ handle: string }> {
    // Sendblue's App Card docs define only one-to-one iMessage sends; no fallback to SMS.
    if (chatKey.isGroup(chat)) throw new LineError("App cards are one-to-one only", "unsupported", false, false);
    // Every text field can become the bubble's body, so each one is kept free of times and dates.
    const text: Array<[string, string | undefined]> = [
      ["caption", card.caption],
      ["subcaption", card.subcaption],
      ["trailingCaption", card.trailingCaption],
      ["trailingSubcaption", card.trailingSubcaption],
      ["summary", card.summary],
    ];
    const layout: Json = {};
    const given = text.some(([key, value]) => key !== "summary" && value?.trim());
    for (const [key, value] of text) {
      const clean = value ? cardSafeText(value) : "";
      if (clean) layout[key] = clean;
    }
    if (card.imageUrl) layout.imageUrl = card.imageUrl;
    const captioned = str(layout.caption) || str(layout.subcaption) || str(layout.trailingCaption) || str(layout.trailingSubcaption);
    if (!captioned) {
      if (!given) throw new LineError("App card needs at least one caption", "invalid_app_card", false, false);
      layout.caption = BLANK_CAPTION;
    }
    const appCard: Json = { ...this.#cardApp, url: card.url, layout };
    const fallbackText = card.fallbackText ? cardSafeText(card.fallbackText) : "";
    if (fallbackText) appCard.fallbackText = fallbackText;
    const response = await this.#call("POST", "/api/send-message", {
      json: { number: chatKey.target(chat), from_number: this.number, app_card: appCard },
      send: true,
    });
    return { handle: handleOf(response) };
  }

  async react(handle: string, reaction: string): Promise<void> {
    await this.#call("POST", "/api/send-reaction", { json: { from_number: this.number, message_handle: handle, reaction }, send: true });
  }

  async typing(chat: ChatKey, options: TypingOptions = {}): Promise<void> {
    if (chatKey.isGroup(chat)) return;
    const base = { number: chatKey.target(chat), from_number: this.number };
    const v2 = options.state !== undefined || options.maxDurationMs !== undefined;
    const json = {
      ...base,
      ...(options.state ? { state: options.state } : {}),
      ...(options.maxDurationMs === undefined ? {} : { max_duration_ms: options.maxDurationMs }),
    };
    try {
      await this.#call("POST", "/api/send-typing-indicator", { json });
    } catch (error) {
      // Workers without typing-v2 firmware 503 on state/duration; the legacy start always works.
      if (!v2 || options.state === "stop" || !(error instanceof LineError) || !error.code.startsWith("http_503")) throw error;
      await this.#call("POST", "/api/send-typing-indicator", { json: base });
    }
  }

  async read(chat: ChatKey): Promise<void> {
    if (chatKey.isGroup(chat)) return;
    await this.#call("POST", "/api/mark-read", { json: { number: chatKey.target(chat), from_number: this.number } });
  }

  async requestLocation(chat: ChatKey): Promise<void> {
    if (chatKey.isGroup(chat)) throw new LineError("Location requests are one-to-one only", "unsupported", false, false);
    await this.#call("POST", "/api/request-location", { json: { number: chatKey.target(chat), from_number: this.number }, send: true });
  }

  async location(address: string): Promise<LineLocation | LineNoFix | undefined> {
    const response = await this.#call("GET", `/api/location/${encodeURIComponent(address)}`, { query: { from_number: this.number }, allow404: true });
    if (!isObject(response)) return undefined;
    if (response.state === "not_shared") return { state: "not_shared" };
    if (response.state !== "shared_with_fix" && response.state !== "shared_no_fix_yet") return undefined;
    // A placeholder 0,0 fix arrives without coordinates; that is still "no fix yet".
    const fix = isObject(response.location) ? toLocation(response.location) : undefined;
    return fix ?? { state: "shared_no_fix_yet" };
  }

  async download(url: string, maxBytes: number, timeoutMs: number): Promise<LineFile> {
    // One deadline covers the headers and the body read, so a stalled CDN can't hang the router.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const tooLarge = () => new LineError(`download exceeds ${maxBytes} bytes`, "too_large", false, false);
    try {
      let response: Response;
      try {
        response = await this.#fetch(url, { signal: controller.signal });
      } catch (error) {
        throw new LineError(`download failed: ${describe(error)}`, "download_failed", true, false);
      }
      if (!response.ok) throw new LineError(`download returned ${response.status}`, `http_${response.status}`, response.status === 429 || response.status >= 500, false);
      const declared = Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > maxBytes) {
        await response.body?.cancel();
        throw tooLarge();
      }

      const chunks: Uint8Array[] = [];
      let total = 0;
      try {
        const reader = response.body?.getReader();
        while (reader) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > maxBytes) {
            await reader.cancel();
            throw tooLarge();
          }
          chunks.push(value);
        }
      } catch (error) {
        if (error instanceof LineError) throw error;
        throw new LineError(`download aborted: ${describe(error)}`, "download_failed", true, false);
      }
      const data = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        data.set(chunk, offset);
        offset += chunk.byteLength;
      }

      const disposition = response.headers.get("content-disposition") ?? "";
      const named = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition)?.[1];
      const fromPath = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
      const name = named ? safeDecode(named) : fromPath || "file";
      const mimeType = (response.headers.get("content-type") ?? "").split(";")[0]?.trim() || "application/octet-stream";
      return { data, name, mimeType };
    } finally {
      clearTimeout(timer);
    }
  }
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
