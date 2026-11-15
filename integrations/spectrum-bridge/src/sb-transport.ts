import { toolError } from "./toollog.ts";
/**
 * Photon-shaped transport over one chat of the shared Line, so Router and Delivery run unchanged.
 * Initial sends have no provider idempotency key; an uncertain send is checked against the line's outbound
 * history before it is sent again.
 */
import type { ChatKey, Line, LineFile, LineAppCard, LineOutbound } from "./line.ts";
import { LineError, chatKey, safeLineFailureCode } from "./line.ts";
import { TransportError, type NormalizedInbound, type SendResult } from "./photon.ts";
import type { Store } from "./store.ts";
import { createHash } from "node:crypto";
import { CARD_TEXT_FIELDS, cardLayout, type CardText } from "./card-text.ts";

const RESEND_LOOKBACK_MS = 60_000;
/**
 * How long after an uncertain attempt its copy may still turn up. Sendblue has delivered sends
 * 37-42 s after they started, past the request timeout, so a retry inside this only looks.
 */
const SETTLE_MS = 2 * 60_000;
/** Statuses of a send that never went out. */
const UNSENT = /^(error|declined|failed)$/i;
/** A start outlives a crashed bridge by at most this long; the router refreshes well inside it. */
export const TYPING_MAX_MS = 60_000;

export function classifyLineFailure(error: unknown): TransportError {
  if (!(error instanceof LineError)) return new TransportError("operationFailed", false, false);
  const code = safeLineFailureCode(error.code);
  return new TransportError(code, error.retryable, error.uncertain);
}

/** Sendblue stores what Messages shows, so smart quotes and spacing can differ from what was sent. */
const sameText = (text: string) => text.normalize("NFKC")
  .replace(/[\u2018\u2019\u201a\u201b]/g, "'").replace(/[\u201c\u201d\u201e\u201f]/g, "\"")
  .replace(/\s+/g, " ").trim();

/** First and latest start of the attempts at one send. Older rows kept a bare number. */
type Attempts = { first: number; last: number };

export type SbTransport = ReturnType<typeof sbTransport>;

/**
 * Static cards skip the live transcript view: Messages draws the captions and preview image
 * itself, and a tap still opens the installed extension. Used where a live view has rendered
 * as an empty bubble.
 */
export type CardOptions = { static?: boolean; previewImage?: (pageUrl: string) => Promise<string | undefined> };

export function sbTransport(line: Line, chat: ChatKey, store: Store, now = () => Date.now(), cards: CardOptions = {}) {
  const wrap = async <T>(work: () => Promise<T>): Promise<T> => {
    try { return await work(); } catch (error) { toolError("sb-transport", "sb-transport.catch1", error); throw classifyLineFailure(error); }
  };
  const sendAtLine = async (send: () => Promise<{ handle: string }>) => {
    const revision = store.get<number>("optInRevision") ?? 0;
    const optOutAtDispatch = {
      since: store.get<{ since: number }>("optedOut")?.since,
      awaiting: (store.get<{ since: number }[]>("optOutAwaitingSend") ?? []).map(episode => episode.since),
    };
    try { return { ...await send(), optOutAtDispatch }; } catch (error) {
      toolError("sb-transport", "sb-transport.catch1", error);
      const failure = classifyLineFailure(error);
      failure.optInRevision = revision;
      throw failure;
    }
  };
  const sentKey = (id: string) => `sent:${id}`;
  const attemptKey = (id: string) => `sent-attempt:${id}`;
  const attempts = (id: string): Attempts | undefined => {
    const kept = store.get<Attempts | number>(attemptKey(id));
    return typeof kept === "number" ? { first: kept, last: kept } : kept ?? undefined;
  };
  /**
   * Sends once per id. After an uncertain attempt (at this id, or at `retryOf`, the id a variant
   * such as an unthreaded copy replaces) it first looks for that copy among the chat's outbound
   * messages no other row has claimed. Until SETTLE_MS have passed since the latest attempt a miss
   * only fails again as `sendUnconfirmed`; after that the send goes out again.
   */
  type Receipt = SendResult;
  const recover = (id: string, retryOf: string | undefined, landed: (message: LineOutbound) => boolean): Receipt | Promise<Receipt | undefined> | undefined => {
    const saved = store.get<{ handle: string; original?: boolean }>(sentKey(id));
    if (saved) return { providerId: saved.handle, duplicate: true, ...(saved.original ? { original: true } : {}) };
    const own = attempts(id);
    const earlier = [own, retryOf === undefined ? undefined : attempts(retryOf)].filter(value => value !== undefined);
    if (!earlier.length) return undefined;
    return (async () => {
      const first = Math.min(...earlier.map(value => value.first));
      const last = Math.max(...earlier.map(value => value.last));
      const sent = await wrap(() => line.outbound(chat, first - RESEND_LOOKBACK_MS));
      // Only copies sent since this send's first attempt: an older one is another row's, whose
      // response may have been lost so nothing claims it. Sendblue stamps a send ~1 s after it starts.
      const match = sent.find(message => message.handle && message.sentAt >= first && !UNSENT.test(message.status)
        && store.byProviderId(message.handle) === undefined && landed(message));
      if (match) {
        const original = retryOf !== undefined && (own === undefined || match.sentAt < own.first);
        store.set(sentKey(id), { handle: match.handle, ...(original ? { original } : {}) });
        return { providerId: match.handle, duplicate: true, ...(original ? { original } : {}) };
      }
      if (now() < last + SETTLE_MS) throw new TransportError("sendUnconfirmed", true, true);
    })();
  };
  const dispatch = async (id: string, send: () => ReturnType<typeof sendAtLine>): Promise<Receipt> => {
    const own = attempts(id);
    const start = now();
    store.set(attemptKey(id), { first: own?.first ?? start, last: start } satisfies Attempts);
    let sent: Awaited<ReturnType<typeof sendAtLine>>;
    try {
      sent = await send();
    } catch (error) { toolError("sb-transport", "sb-transport.catch2", error);
      const failure = error instanceof TransportError ? error : classifyLineFailure(error);
      // Nothing went out, so the next try need not wait for a copy that will never show up.
      if (!failure.ambiguous) {
        if (own) store.set(attemptKey(id), own);
        else store.db.query("DELETE FROM kv WHERE key = ?").run(attemptKey(id));
      }
      throw failure;
    }
    store.set(sentKey(id), { handle: sent.handle });
    rearm();
    return { providerId: sent.handle, optOutAtDispatch: sent.optOutAtDispatch };
  };
  const once = async (id: string, retryOf: string | undefined, landed: (message: LineOutbound) => boolean,
    send: () => ReturnType<typeof sendAtLine>): Promise<Receipt> => {
    const recovery = recover(id, retryOf, landed);
    const receipt = recovery instanceof Promise ? await recovery : recovery;
    if (receipt) return receipt;
    // A fresh text/file send must reserve its id and dispatch without yielding after Delivery's guards.
    return dispatch(id, send);
  };
  // One queue keeps a re-arm after a send from landing after the turn's stop.
  let typingOn = false;
  let typingQueue: Promise<unknown> = Promise.resolve();
  const typingCall = (active: boolean): Promise<void> => {
    const run = typingQueue.then(() => line.typing(chat, active
      ? { state: "start", maxDurationMs: TYPING_MAX_MS }
      : { state: "stop" }));
    typingQueue = run.catch((caughtError) => { toolError("sb-transport", "sb-transport.catch3", caughtError);});
    return wrap(() => run);
  };
  // Our own message clears the bubble on the recipient's phone, so put it back while the turn runs.
  const rearm = () => { if (typingOn) void typingCall(true).catch((caughtError) => { toolError("sb-transport", "sb-transport.catch4", caughtError);}); };

  return {
    async typing(_chatGuid: string, active: boolean): Promise<void> {
      typingOn = active;
      await typingCall(active);
    },
    async read(_chatGuid: string): Promise<void> {
      await wrap(() => line.read(chat));
    },
    /** Sendblue's current status of each outbound message in this chat updated since sinceMs, by handle. */
    async outboundStatuses(sinceMs: number): Promise<Map<string, string>> {
      const sent = await wrap(() => line.outbound(chat, sinceMs));
      return new Map(sent.filter(message => message.handle).map(message => [message.handle, message.status]));
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
    async sendText(input: { id: string; chatGuid: string; text: string; replyTo?: string; effect?: string; subject?: string; retryOf?: string }):
      Promise<Receipt> {
      const text = sameText(input.text);
      return once(input.id, input.retryOf, message => !message.mediaUrl && !message.card && sameText(message.text) === text,
        () => sendAtLine(() => line.sendText(chat, input.text, input.replyTo ? { replyTo: input.replyTo } : undefined)));
    },
    async uploadAttachment(input: { id: string; data: Uint8Array; name: string; mimeType: string }): Promise<{ guid: string }> {
      return { guid: await wrap(() => line.upload({ data: input.data, name: input.name, mimeType: input.mimeType })) };
    },
    async sendAttachment(input: { id: string; chatGuid: string; attachmentGuid: string; replyTo?: string }): Promise<Receipt> {
      // Sendblue keeps the uploaded file's URL as the message's media_url.
      return once(input.id, undefined, message => message.mediaUrl === input.attachmentGuid,
        () => sendAtLine(() => line.sendText(chat, "", { mediaUrl: input.attachmentGuid, ...(input.replyTo ? { replyTo: input.replyTo } : {}) })));
    },
    /** All reads/uploads finish before Delivery's final guards; the returned function only sends. */
    async prepareApp(input: { id: string; chatGuid: string; updateOf?: string; previewPage?: string } & LineAppCard): Promise<() => Promise<Receipt>> {
      const { id, chatGuid: _chat, updateOf, previewPage, ...given } = input;
      let originalHandle: string | undefined;
      if (updateOf) {
        const saved = store.get<{ handle: string }>(sentKey(id));
        if (saved) return async () => ({ providerId: saved.handle, duplicate: true });
        if (!line.updateApp) throw new TransportError("unsupported", false, false);
        const original = store.getOperation(updateOf);
        if (!original?.app || original.app.updateOf || original.app.url !== given.url) throw new TransportError("invalid_app_card", false, false);
        if (original.state !== "sent" || !original.providerId) throw new TransportError("sendUnconfirmed", true, false);
        const message = await wrap(() => line.getMessage(original.providerId!));
        if (!message || !("status" in message) || message.chat !== chat || message.card?.url !== given.url
          || !message.card.sessionIdentifier || message.card.updateMessageHandle) throw new TransportError("invalid_app_card", false, false);
        if (!/^(SENT|DELIVERED|READ)$/i.test(message.status)) throw new TransportError("sendUnconfirmed", true, false);
        originalHandle = original.providerId;
        store.set(`app-session:${updateOf}`, { handle: originalHandle, sessionIdentifier: message.card.sessionIdentifier });
      }
      const layout = cardLayout(given);
      const sameLayout = (stored: CardText) => layout !== undefined
        && CARD_TEXT_FIELDS.every(key => sameText(stored[key] ?? "") === sameText(layout[key] ?? ""));
      // Update retries use the provider's idempotency key; URL/layout matching could claim the placement itself.
      const receipt = updateOf ? undefined : await recover(id, undefined, message => message.card?.url === given.url && sameLayout(message.card.layout));
      if (receipt) return async () => receipt;
      let card = given;
      if (cards.static || updateOf) {
        const key = `prepared-app:${id}`;
        const saved = store.get<LineAppCard>(key);
        if (saved) card = saved;
        else {
          const imageUrl = card.imageUrl ?? await wrap(() => cards.previewImage?.(previewPage ?? card.url) ?? Promise.resolve(undefined));
          if (updateOf && !imageUrl) throw new TransportError("card_preview_unavailable", true, false);
          card = { ...card, interactive: false, ...(imageUrl ? { imageUrl } : {}) };
          store.set(key, card);
        }
      }
      const updateKey = createHash("sha256").update(id).digest("hex");
      return () => dispatch(id, () => sendAtLine(() => originalHandle ? line.updateApp!(originalHandle, card, updateKey) : line.sendApp(chat, card)));
    },
    async sendApp(input: { id: string; chatGuid: string; updateOf?: string; previewPage?: string } & LineAppCard): Promise<Receipt> {
      return (await this.prepareApp(input))();
    },
    /** Polls are unsupported on Sendblue; the title and numbered options go out as plain text. */
    async sendPoll(input: { id: string; chatGuid: string; title: string; options: readonly string[] }): Promise<Receipt> {
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
export function inboundFromLine(message: { handle: string; text: string; from: string; mediaUrl?: string; replyTo?: string; threadOrigin?: string;
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
    ...(message.threadOrigin ? { threadOrigin: message.threadOrigin } : {}),
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
