/**
 * Photon-shaped transport over one chat of the shared Line, so Router and Delivery run unchanged.
 * Sendblue has no idempotency key; an uncertain send is checked against the line's outbound
 * history before it is sent again.
 */
import type { ChatKey, Line, LineFile, LineAppCard } from "./line.ts";
import { LineError, chatKey } from "./line.ts";
import { TransportError, type NormalizedInbound } from "./photon.ts";
import type { Store } from "./store.ts";

const RESEND_LOOKBACK_MS = 60_000;
/** A start outlives a crashed bridge by at most this long; the router refreshes well inside it. */
export const TYPING_MAX_MS = 60_000;

export function classifyLineFailure(error: unknown): TransportError {
  if (error instanceof LineError) return new TransportError(error.code, error.retryable, error.uncertain);
  return new TransportError("operationFailed", false, false);
}

export type SbTransport = ReturnType<typeof sbTransport>;

/**
 * Static cards skip the live transcript view: Messages draws the captions and preview image
 * itself, and a tap still opens the installed extension. Used where a live view has rendered
 * as an empty bubble.
 */
export type CardOptions = { static?: boolean; previewImage?: (pageUrl: string) => Promise<string | undefined> };

export function sbTransport(line: Line, chat: ChatKey, store: Store, now = () => Date.now(), cards: CardOptions = {}) {
  const wrap = async <T>(work: () => Promise<T>): Promise<T> => {
    try { return await work(); } catch (error) { throw classifyLineFailure(error); }
  };
  const sentKey = (id: string) => `sent:${id}`;
  const attemptKey = (id: string) => `sent-attempt:${id}`;
  // One queue keeps a re-arm after a send from landing after the turn's stop.
  let typingOn = false;
  let typingQueue: Promise<unknown> = Promise.resolve();
  const typingCall = (active: boolean): Promise<void> => {
    const run = typingQueue.then(() => line.typing(chat, active
      ? { state: "start", maxDurationMs: TYPING_MAX_MS }
      : { state: "stop" }));
    typingQueue = run.catch(() => {});
    return wrap(() => run);
  };
  // Our own message clears the bubble on the recipient's phone, so put it back while the turn runs.
  const rearm = () => { if (typingOn) void typingCall(true).catch(() => {}); };

  return {
    async typing(_chatGuid: string, active: boolean): Promise<void> {
      typingOn = active;
      await typingCall(active);
    },
    async read(_chatGuid: string): Promise<void> {
      await wrap(() => line.read(chat));
    },
    async downloadAttachment(guid: string, maxBytes: number, timeoutMs = 30_000): Promise<{ data: Uint8Array; mimeType: string; name: string }> {
      const file: LineFile = await wrap(() => line.download(guid, maxBytes, timeoutMs));
      return { data: file.data, mimeType: file.mimeType, name: file.name };
    },
    /** Photon-shaped lookup for reply context: the chat key stands in for the chat guid. */
    async getMessage(handle: string): Promise<{ chatGuids: string[]; content: { text: string }; isFromMe: boolean } | undefined> {
      const message = await wrap(() => line.getMessage(handle));
      if (!message) return undefined;
      const outbound = "status" in message;
      return { chatGuids: [chat], content: { text: message.text }, isFromMe: outbound };
    },
    async sendText(input: { id: string; chatGuid: string; text: string; replyTo?: string; effect?: string; subject?: string }):
      Promise<{ providerId?: string; duplicate?: boolean }> {
      const saved = store.get<{ handle: string }>(sentKey(input.id));
      if (saved) return { providerId: saved.handle, duplicate: true };
      const attemptStart = now();
      const earlier = store.get<number>(attemptKey(input.id));
      if (earlier !== undefined) {
        // An earlier attempt for this id was uncertain: it may already be out, so look before resending.
        const sent = await wrap(() => line.outbound(chat, earlier - RESEND_LOOKBACK_MS));
        const match = sent.find(message => message.text === input.text);
        if (match) {
          store.set(sentKey(input.id), { handle: match.handle });
          return { providerId: match.handle, duplicate: true };
        }
      }
      store.set(attemptKey(input.id), attemptStart);
      const sent = await wrap(() => line.sendText(chat, input.text, input.replyTo ? { replyTo: input.replyTo } : undefined));
      store.set(sentKey(input.id), { handle: sent.handle });
      rearm();
      return { providerId: sent.handle };
    },
    async uploadAttachment(input: { id: string; data: Uint8Array; name: string; mimeType: string }): Promise<{ guid: string }> {
      return { guid: await wrap(() => line.upload({ data: input.data, name: input.name, mimeType: input.mimeType })) };
    },
    async sendAttachment(input: { id: string; chatGuid: string; attachmentGuid: string; replyTo?: string }): Promise<{ providerId?: string; duplicate?: boolean }> {
      const saved = store.get<{ handle: string }>(sentKey(input.id));
      if (saved) return { providerId: saved.handle, duplicate: true };
      const sent = await wrap(() => line.sendText(chat, "", {
        mediaUrl: input.attachmentGuid, ...(input.replyTo ? { replyTo: input.replyTo } : {}),
      }));
      store.set(sentKey(input.id), { handle: sent.handle });
      rearm();
      return { providerId: sent.handle };
    },
    async sendApp(input: { id: string; chatGuid: string } & LineAppCard): Promise<{ providerId?: string; duplicate?: boolean }> {
      const saved = store.get<{ handle: string }>(sentKey(input.id));
      if (saved) return { providerId: saved.handle, duplicate: true };
      const { id: _id, chatGuid: _chat, ...given } = input;
      let card: LineAppCard = given;
      if (cards.static) {
        const imageUrl = card.imageUrl ?? await cards.previewImage?.(card.url).catch(() => undefined);
        card = { ...card, interactive: false, ...(imageUrl ? { imageUrl } : {}) };
      }
      const sent = await wrap(() => line.sendApp(chat, card));
      store.set(sentKey(input.id), { handle: sent.handle });
      rearm();
      return { providerId: sent.handle };
    },
    /** Polls are unsupported on Sendblue; the title and numbered options go out as plain text. */
    async sendPoll(input: { id: string; chatGuid: string; title: string; options: readonly string[] }): Promise<{ providerId?: string; duplicate?: boolean }> {
      const body = [input.title, ...input.options.map((option, index) => `${index + 1}. ${option}`)].join("\n");
      return this.sendText({ id: input.id, chatGuid: input.chatGuid, text: body });
    },
    async react(_chatGuid: string, messageId: string, kind: string): Promise<void> {
      await wrap(() => line.react(messageId, kind));
    },
    /** Chat key of this transport, used by the router in place of a Photon chat guid. */
    chatKey: () => chat,
    describe: () => chatKey.target(chat),
  };
}

/** Maps a Line message to the router's inbound row. Attachments keep the media URL as their guid. */
export function inboundFromLine(message: { handle: string; text: string; from: string; mediaUrl?: string; replyTo?: string;
  kind: string; location?: { latitude: number; longitude: number; accuracy?: number; at?: number }; service: string;
  sentAt: number }): NormalizedInbound {
  const mediaUrl = message.mediaUrl;
  const attachments = mediaUrl ? [{
    guid: mediaUrl, fileName: fileNameFrom(mediaUrl), mimeType: mimeFrom(mediaUrl), totalBytes: 0,
  }] : [];
  const isAudio = mediaUrl ? /\.(caf|m4a)(\?|$)|audio/i.test(mediaUrl) : false;
  const location = message.location;
  const text = location
    ? `[Shared location] ${location.latitude},${location.longitude} (±${location.accuracy ?? 0} m)`
    : message.text;
  return {
    id: message.handle,
    text,
    ...(message.replyTo ? { replyTo: message.replyTo } : {}),
    isAudioMessage: isAudio,
    attachments: attachments as NormalizedInbound["attachments"],
    receivedAt: message.sentAt,
    source: "typed",
    sender: message.from,
    sentAt: message.sentAt,
    ...(location ? { location: { latitude: location.latitude, longitude: location.longitude,
      ...(location.accuracy === undefined ? {} : { accuracy: location.accuracy }),
      ...(location.at === undefined ? {} : { at: location.at }) } } : {}),
  };
}

function fileNameFrom(url: string): string {
  const last = url.split("?", 1)[0]!.split("/").pop() ?? "";
  return last || "attachment";
}

function mimeFrom(url: string): string {
  const lower = url.split("?", 1)[0]!.toLowerCase();
  if (/\.jpe?g$/.test(lower)) return "image/jpeg";
  if (/\.png$/.test(lower)) return "image/png";
  if (/\.gif$/.test(lower)) return "image/gif";
  if (/\.heic$/.test(lower)) return "image/heic";
  if (/\.mov$/.test(lower)) return "video/quicktime";
  if (/\.mp4$/.test(lower)) return "video/mp4";
  if (/\.caf$/.test(lower)) return "audio/x-caf";
  if (/\.m4a$/.test(lower)) return "audio/mp4";
  return "application/octet-stream";
}
