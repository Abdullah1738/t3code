import { posix, win32 } from "node:path";
import {
  createGrpcClient,
  ErrorCode,
  IMessageError,
  MessageEffect,
  type AdvancedIMessage,
  type AttachmentInfo,
  type CatchUpEvent,
  type Message,
} from "@photon-ai/advanced-imessage/grpc";
import type { SharedTokenData, TokenData } from "@spectrum-ts/core";
import type { Format } from "./formatting.ts";
import { LINE_FAILURE_CODE } from "./line.ts";

export type { CatchUpEvent } from "@photon-ai/advanced-imessage/grpc";

const CLOUD_URL = "https://spectrum.photon.codes";
const GRPC_ADDRESS = "imessage.spectrum.photon.codes:443";
const ATTACHMENT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The owner's installed Spectrum iMessage extension renders tappable app cards.
const MINI_APP = {
  appName: "Spectrum", extensionBundleId: "codes.photon.Spectrum.MessagesExtension",
  teamId: "P8XT6232SL", appStoreId: 6777616651,
} as const;

export type EffectName = keyof typeof MessageEffect;
export const EFFECTS = Object.keys(MessageEffect) as EffectName[];
export const isEffect = (value: unknown): value is EffectName =>
  typeof value === "string" && Object.hasOwn(MessageEffect, value);

export class TransportError extends Error {
  constructor(
    public readonly code: string,
    public readonly retryable = false,
    public readonly ambiguous = false,
  ) {
    super(`Photon transport failed (${code})`);
    this.name = "TransportError";
  }
}

/** Unknown outcomes may only be retried with the original durable idempotency key. */
export function classifySendFailure(error: unknown): { retryable: boolean; uncertain: boolean; code: string } {
  if (error instanceof TransportError) {
    const knownCode = [
      "invalidCredentials", "endpointOverride", "closed", "tokenNetwork", "invalidTokenResponse",
      "sharedPlanRequired", "invalidTokenLifetime", "invalidOperationId", "invalidOwner", "invalidOwnerChat",
      "unauthorized", "invalidAttachmentLimit", "invalidAttachment", "attachmentTooLarge",
      "catchupTimeout", "catchupIncomplete", "attachmentTimeout", "invalidEffect", "invalidPoll", "invalidApp",
    ].includes(error.code) || (error.code.length === 12 && /^tokenHttp[1-5]\d{2}$/.test(error.code))
      // Sendblue line failures carry their own retry and uncertainty flags (sb-transport.ts).
      || LINE_FAILURE_CODE.test(error.code);
    if (knownCode) return { retryable: error.retryable, uncertain: error.ambiguous, code: error.code };
  }
  if (error instanceof IMessageError) {
    const code = Object.values(ErrorCode).includes(error.code) ? error.code : "unknownSendFailure";
    // SDK 2.1 defaults absent x-retryable metadata to false, even after a lost response.
    if ([1, 2, 4, 13, 14].includes(error.grpcCode)) return { retryable: true, uncertain: true, code };
    if ([3, 5, 6, 7, 9, 11, 12, 16].includes(error.grpcCode)) return { retryable: false, uncertain: false, code };
    if (error.grpcCode === 8) return { retryable: error.retryable, uncertain: false, code };
    return { retryable: true, uncertain: true, code };
  }
  return { retryable: true, uncertain: true, code: "unknownSendFailure" };
}

/** Downloads are read-only. A not-yet-available received file can be retried. */
export function classifyDownloadFailure(cause: unknown) {
  if (cause instanceof IMessageError && cause.grpcCode === 5) return { retryable: true, code: "attachmentNotReady" };
  if (cause instanceof TransportError && LINE_FAILURE_CODE.test(cause.code)) {
    // Sendblue download failures keep their earlier handling: a few tries, unless the file is too big.
    return cause.code === "too_large" ? { retryable: false, code: "attachmentTooLarge" } : { retryable: true, code: "attachmentUnavailable" };
  }
  const failure = classifySendFailure(cause);
  return { retryable: failure.retryable, code: failure.code === "unknownSendFailure" ? "attachmentUnavailable" : failure.code };
}

export type SendResult = {
  providerId?: string;
  duplicate?: boolean;
  /** A recovered copy that is the one a retryOf id named (e.g. the threaded original), not this id's own variant. */
  original?: boolean;
};
export type PollOptionInfo = { optionIdentifier: string; text: string };
export type PollResult = SendResult & { options?: PollOptionInfo[] };
export type ReactionKind = "like" | "love" | "dislike" | "laugh" | "emphasize" | "question";

export function ownerChatGuid(guid: string, owner: string): boolean {
  return owner.length > 0 && !/[;\s]/.test(owner)
    && (guid === `any;-;${owner}` || guid === `iMessage;-;${owner}`);
}

export function canonicalOwnerChat(guid: string, owner: string): string {
  if (!ownerChatGuid(guid, owner)) throw new TransportError("unauthorized");
  return `any;-;${owner}`;
}

// This validates RPC syntax only; main/router must bind the GUID to the configured owner.
function canonicalRpcChat(guid: string): string {
  const owner = /^(?:any|iMessage);-;(\+[1-9]\d{6,14})$/.exec(guid)?.[1];
  if (!owner) throw new TransportError("unauthorized");
  return canonicalOwnerChat(guid, owner);
}

export class Photon {
  #projectId: string;
  #secret: string;
  #client?: AdvancedIMessage;
  #token?: SharedTokenData;
  #refreshAt = 0;
  #refresh?: Promise<string>;
  #abort = new AbortController();
  #closing?: Promise<void>;
  #streams = new Set<{ close(): Promise<void> }>();

  constructor(projectId: string, secret: string) {
    if (!projectId.trim() || /[:/?#\s]/.test(projectId) || !secret.trim()) {
      throw new TransportError("invalidCredentials");
    }
    // Never import Spectrum's cloud runtime: it captures an env-controlled URL.
    for (const [key, expected] of [
      ["SPECTRUM_CLOUD_URL", CLOUD_URL],
      ["SPECTRUM_IMESSAGE_ADDRESS", GRPC_ADDRESS],
    ]) {
      if (process.env[key] !== undefined && process.env[key] !== expected) {
        throw new TransportError("endpointOverride");
      }
    }
    this.#projectId = projectId;
    this.#secret = secret;
  }

  #ensureOpen(): void {
    if (this.#abort.signal.aborted) throw new TransportError("closed");
  }

  #getClient(): AdvancedIMessage {
    this.#ensureOpen();
    return this.#client ??= createGrpcClient({
      address: GRPC_ADDRESS,
      tls: true,
      token: () => this.#getToken(),
      // The durable outbox owns retries; only its stable body key identifies a send.
      autoIdempotency: false,
      retry: false,
      timeout: 30_000,
      channelOptions: { "grpc.enable_http_proxy": 0 },
    });
  }

  async #getToken(): Promise<string> {
    this.#ensureOpen();
    if (this.#token && Date.now() < this.#refreshAt) return this.#token.token;
    return this.#refresh ??= this.#issueToken().finally(() => { this.#refresh = undefined; });
  }

  async #issueToken(): Promise<string> {
    const startedAt = Date.now();
    let response: Response;
    try {
      // Same API as cloud.issueImessageTokens, without tracing or endpoint overrides.
      response = await fetch(`${CLOUD_URL}/projects/${encodeURIComponent(this.#projectId)}/imessage/tokens`, {
        method: "POST",
        headers: { Authorization: `Basic ${Buffer.from(`${this.#projectId}:${this.#secret}`).toString("base64")}` },
        proxy: "",
        verbose: false,
        redirect: "error",
        signal: AbortSignal.any([this.#abort.signal, AbortSignal.timeout(15_000)]),
      });
    } catch {
      this.#ensureOpen();
      throw new TransportError("tokenNetwork", true);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new TransportError(`tokenHttp${response.status}`, response.status === 429 || response.status >= 500);
    }
    const json = await response.json().catch(() => { throw new TransportError("invalidTokenResponse"); }) as {
      succeed?: boolean; data?: TokenData;
    } | null;
    const data = json?.data;
    if (json?.succeed !== true || !data) throw new TransportError("invalidTokenResponse");
    if (data.type === "dedicated") throw new TransportError("sharedPlanRequired");
    if (data.type !== "shared" || typeof data.token !== "string" || !data.token.trim()
      || typeof data.expiresIn !== "number" || !Number.isFinite(data.expiresIn) || data.expiresIn <= 0) {
      throw new TransportError("invalidTokenResponse");
    }
    const refreshAt = startedAt + data.expiresIn * 800;
    if (!Number.isSafeInteger(Math.ceil(refreshAt)) || refreshAt <= Date.now()) {
      throw new TransportError("invalidTokenLifetime", true);
    }
    this.#ensureOpen();
    this.#token = { type: "shared", token: data.token, expiresIn: data.expiresIn };
    this.#refreshAt = refreshAt;
    return data.token;
  }

  /** Checks cloud credentials and the shared plan. Does not open gRPC or send anything. */
  async check(): Promise<void> {
    await this.#getToken();
  }

  async sendText(input: {
    id: string; chatGuid: string; text: string; replyTo?: string;
    effect?: EffectName; subject?: string; formatting?: readonly Format[]; enableLinkPreview?: boolean;
    /** Id of the send this variant replaces. Photon dedupes by clientMessageId alone and ignores it. */
    retryOf?: string;
  }): Promise<SendResult> {
    if (!input.id.trim()) throw new TransportError("invalidOperationId");
    const chatGuid = canonicalRpcChat(input.chatGuid);
    if (input.effect !== undefined && !isEffect(input.effect)) throw new TransportError("invalidEffect");
    try {
      const message = await this.#getClient().messages.sendText(chatGuid, input.text, {
        clientMessageId: input.id,
        ...(input.replyTo === undefined ? {} : { replyTo: input.replyTo }),
        ...(input.effect === undefined ? {} : { effect: MessageEffect[input.effect] }),
        ...(input.subject === undefined ? {} : { subject: input.subject }),
        ...(input.formatting?.length ? { formatting: input.formatting.map(({ type, start, length }) => ({ type, start, length })) } : {}),
        ...(input.enableLinkPreview ? { enableLinkPreview: true } : {}),
      });
      return { providerId: message.guid };
    } catch (error) {
      if (error instanceof IMessageError && error.code === ErrorCode.duplicateMessage) return { duplicate: true };
      throw error;
    }
  }

  /** A duplicate has no documented original poll; callers must keep any earlier checkpoint. */
  async sendPoll(input: { id: string; chatGuid: string; title: string; options: readonly string[] }): Promise<PollResult> {
    if (!input.id.trim()) throw new TransportError("invalidOperationId");
    const chatGuid = canonicalRpcChat(input.chatGuid);
    if (!input.title.trim() || input.options.length < 2 || input.options.some(option => !option.trim())) {
      throw new TransportError("invalidPoll");
    }
    try {
      const poll = await this.#getClient().polls.create(chatGuid, input.title, [...input.options], { clientMessageId: input.id });
      return {
        providerId: poll.pollMessageGuid,
        options: poll.options.map(option => ({ optionIdentifier: option.optionIdentifier, text: option.text })),
      };
    } catch (error) {
      if (error instanceof IMessageError && error.code === ErrorCode.duplicateMessage) return { duplicate: true };
      throw error;
    }
  }

  async sendApp(input: {
    id: string; chatGuid: string; url: string; caption: string;
    subcaption?: string; trailingCaption?: string; trailingSubcaption?: string; summary?: string;
  }): Promise<SendResult> {
    if (!input.id.trim()) throw new TransportError("invalidOperationId");
    const chatGuid = canonicalRpcChat(input.chatGuid);
    let url: URL;
    try { url = new URL(input.url); } catch { throw new TransportError("invalidApp"); }
    if (url.protocol !== "https:" || !input.caption.trim()) throw new TransportError("invalidApp");
    const layout = {
      caption: input.caption,
      ...(input.subcaption === undefined ? {} : { subcaption: input.subcaption }),
      ...(input.trailingCaption === undefined ? {} : { trailingCaption: input.trailingCaption }),
      ...(input.trailingSubcaption === undefined ? {} : { trailingSubcaption: input.trailingSubcaption }),
      ...(input.summary === undefined ? {} : { summary: input.summary }),
    };
    try {
      const message = await this.#getClient().messages.sendCustomizedMiniApp(chatGuid, { ...MINI_APP, url: input.url, layout }, {
        clientMessageId: input.id,
      });
      return { providerId: message.guid };
    } catch (error) {
      if (error instanceof IMessageError && error.code === ErrorCode.duplicateMessage) return { duplicate: true };
      throw error;
    }
  }

  /** SDK 2.1 has no public upload ID or MIME override; callers must persist the returned GUID. */
  async uploadAttachment(input: { id: string; data: Uint8Array; name: string; mimeType: string }): Promise<{ guid: string }> {
    if (!input.id.trim()) throw new TransportError("invalidOperationId");
    if (!(input.data instanceof Uint8Array) || !input.name.trim() || input.name === "." || input.name === ".."
      || posix.basename(input.name) !== input.name || win32.basename(input.name) !== input.name
      || /[\x00-\x1f\x7f]/.test(input.name) || !input.mimeType.trim() || /[\x00-\x1f\x7f]/.test(input.mimeType)) {
      throw new TransportError("invalidAttachment");
    }
    if (input.data.byteLength > 20 * 1024 * 1024) throw new TransportError("attachmentTooLarge");
    const result = await this.#getClient().attachments.upload({ data: input.data, fileName: input.name });
    // A duplicate error has no documented original GUID; never manufacture upload success.
    return { guid: result.attachment.guid };
  }

  async sendAttachment(input: { id: string; chatGuid: string; attachmentGuid: string; replyTo?: string }): Promise<SendResult> {
    if (!input.id.trim()) throw new TransportError("invalidOperationId");
    const chatGuid = canonicalRpcChat(input.chatGuid);
    if (!input.attachmentGuid.trim()) throw new TransportError("invalidAttachment");
    try {
      const message = await this.#getClient().messages.sendAttachment(chatGuid, input.attachmentGuid, {
        clientMessageId: input.id,
        ...(input.replyTo === undefined ? {} : { replyTo: input.replyTo }),
      });
      return { providerId: message.guid };
    } catch (error) {
      if (error instanceof IMessageError && error.code === ErrorCode.duplicateMessage) return { duplicate: true };
      throw error;
    }
  }

  async typing(chatGuid: string, isTyping: boolean): Promise<void> {
    const canonical = canonicalRpcChat(chatGuid);
    await this.#getClient().chats.setTyping(canonical, isTyping);
  }

  async read(chatGuid: string): Promise<void> {
    const canonical = canonicalRpcChat(chatGuid);
    await this.#getClient().chats.markRead(canonical);
  }

  /** Read-only resolution; never creates a chat or shares contact information. */
  async resolveChat(owner: string): Promise<{ guid: string }> {
    const requestedGuid = `any;-;${owner}`;
    if (!/^\+[1-9]\d{6,14}$/.test(owner) || !ownerChatGuid(requestedGuid, owner)) throw new TransportError("invalidOwner");
    const chat = await this.#getClient().chats.get(requestedGuid);
    if (!ownerChatGuid(chat.guid, owner) || chat.isGroup !== false) throw new TransportError("invalidOwnerChat");
    return { guid: canonicalOwnerChat(chat.guid, owner) };
  }

  async react(chatGuid: string, messageId: string, kind: ReactionKind, operationId: string): Promise<void> {
    if (!operationId.trim()) throw new TransportError("invalidOperationId");
    const canonical = canonicalRpcChat(chatGuid);
    try {
      await this.#getClient().messages.setReaction(canonical, messageId, { kind }, true, {
        clientMessageId: operationId,
      });
    } catch (error) {
      if (error instanceof IMessageError && error.code === ErrorCode.duplicateMessage) return;
      throw error;
    }
  }

  /** Raw lookup, not an authorization source. Authorize using the originating event. */
  async getMessage(guid: string): Promise<Message> {
    return this.#getClient().messages.get(guid);
  }

  async *catchUp(cursor?: number): AsyncGenerator<CatchUpEvent> {
    const stream = this.#getClient().events.catchUp(cursor);
    this.#streams.add(stream);
    let complete = false;
    let timedOut = false;
    let timeoutClose: Promise<void> | undefined;
    // The SDK's unary timeout does not bound streams, including time between events.
    const timer = setTimeout(() => {
      timedOut = true;
      // Cancellation failures must not replace the timeout reported by the generator.
      timeoutClose = stream.close().catch(() => undefined);
    }, 30_000);
    try {
      // Forward even ignored events and catchup.complete for the caller's checkpoint.
      for await (const event of stream) {
        if (timedOut) break;
        if (event.type === "catchup.complete") complete = true;
        yield event;
      }
      this.#ensureOpen();
      if (!complete) throw new TransportError("catchupIncomplete", true);
    } finally {
      clearTimeout(timer);
      this.#streams.delete(stream);
      try {
        await stream.close();
        await timeoutClose;
      } finally {
        if (timedOut) throw new TransportError("catchupTimeout", true);
      }
    }
  }

  /** Caller must take guid from metadata of an already-authorized inbound message. */
  async downloadAttachment(guid: string, maxBytes: number, timeoutMs = 30_000): Promise<{ data: Uint8Array; mimeType: string; name: string }> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new TransportError("invalidAttachmentLimit");
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new TransportError("invalidAttachmentLimit");
    const scopedGuid = guid.length === 44 && guid.startsWith("spc-att-") && ATTACHMENT_UUID.test(guid.slice(8));
    const stream = this.#getClient().attachments.downloadStream(guid);
    this.#streams.add(stream);
    let info: AttachmentInfo | undefined;
    const chunks: Uint8Array[] = [];
    let received = 0;
    let primaryBytes = 0;
    let hasCompanion = false;
    let timedOut = false;
    let timeoutClose: Promise<void> | undefined;
    // Closing the public stream aborts the SDK download, including a pending read.
    const timer = setTimeout(() => {
      timedOut = true;
      timeoutClose = stream.close().catch(() => undefined);
    }, timeoutMs);
    try {
      for await (const chunk of stream) {
        if (timedOut) break;
        if (chunk.type === "header") {
          // Spectrum forwards the native UUID in stream headers, unlike its scoped metadata GUIDs.
          // Authorization remains the caller's inbound event and the unchanged, authenticated RPC target.
          const nativeHeader = scopedGuid && chunk.info.guid.length === 36 && ATTACHMENT_UUID.test(chunk.info.guid);
          if (info || (chunk.info.guid !== guid && !nativeHeader)
            || !Number.isSafeInteger(chunk.info.totalBytes) || chunk.info.totalBytes < 0) {
            throw new TransportError("invalidAttachment");
          }
          info = chunk.info;
          const companionBytes = chunk.companionInfo?.totalBytes ?? 0;
          if (!Number.isSafeInteger(companionBytes) || companionBytes < 0) throw new TransportError("invalidAttachment");
          hasCompanion = chunk.companionInfo !== undefined;
          // Only the primary is submitted. A hidden Live Photo video must not
          // reject an otherwise in-budget still image or consume its deadline.
          if (info.totalBytes > maxBytes) throw new TransportError("attachmentTooLarge");
          if (hasCompanion && info.totalBytes === 0) break;
        } else {
          if (!info) throw new TransportError("invalidAttachment");
          received += chunk.data.byteLength;
          if (received > maxBytes) throw new TransportError("attachmentTooLarge");
          if (chunk.type === "primaryChunk") {
            primaryBytes += chunk.data.byteLength;
            chunks.push(chunk.data.slice());
            // The protocol puts every primary chunk before any companion. Once
            // the declared primary is complete, cancel the unused sidecar.
            if (hasCompanion && primaryBytes === info.totalBytes) break;
          }
        }
      }
      this.#ensureOpen();
      if (!info || primaryBytes !== info.totalBytes) throw new TransportError("invalidAttachment");
      const data = new Uint8Array(primaryBytes);
      let offset = 0;
      for (const chunk of chunks) {
        data.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return { data, mimeType: info.mimeType, name: info.fileName };
    } finally {
      clearTimeout(timer);
      this.#streams.delete(stream);
      try {
        await stream.close();
        await timeoutClose;
      } finally {
        if (timedOut) throw new TransportError("attachmentTimeout", true);
      }
    }
  }

  close(): Promise<void> {
    this.#abort.abort();
    this.#token = undefined;
    this.#secret = "";
    return this.#closing ??= (async () => {
      try {
        await Promise.all([...this.#streams].map(stream => stream.close()));
      } finally {
        this.#streams.clear();
        await this.#client?.close();
      }
    })();
  }
}

export type NormalizedInbound = {
  id: string;
  text: string;
  replyTo?: string;
  /** Sendblue mode: handle of the inline-reply thread's first message (thread_originator). */
  threadOrigin?: string;
  isAudioMessage: boolean;
  attachments: AttachmentInfo[];
  receivedAt?: number;
  batchIds?: string[];
  poll?: InboundPollVote;
  /**
   * "typed" only when `text` is the owner's message exactly as he sent it. Poll
   * votes, voice notes and rows the bridge writes itself (wakes, secrets, resets)
   * are not; Robob treats a row without "typed" as composed.
   */
  source?: "typed" | "composed";
  /** Sendblue mode: sender address (groups have several). */
  sender?: string;
  /** Sendblue mode: when the sender sent it. `receivedAt` is when the bridge got it. */
  sentAt?: number;
  /** Sendblue mode: a shared location (message_type "location"). */
  location?: { latitude: number; longitude: number; accuracy?: number; at?: number };
};

export type InboundPollVote = {
  guid: string;
  optionIdentifier: string;
  optionText: string;
  vote: "voted" | "unvoted";
  operationId: string;
};

/** SDK timestamps are Dates. Missing/invalid event time must not become "now". */
export function inboundOccurredAt(event: CatchUpEvent): number | undefined {
  if (event.type !== "message.received" || !(event.occurredAt instanceof Date)) return;
  const occurredAt = event.occurredAt.getTime();
  return Number.isFinite(occurredAt) ? occurredAt : undefined;
}

/** Pure projection of SDK events. No lookup, attachment download, or sender inference. */
export function normalizeInbound(event: CatchUpEvent, owner: string, chatGuid: string): NormalizedInbound | undefined {
  if (!ownerChatGuid(chatGuid, owner) || event.type !== "message.received"
    || !ownerChatGuid(event.chatGuid, owner) || event.isFromMe !== false) return;
  const message = event.message;
  if (message.isFromMe !== false || message.sender?.address !== owner
    || (event.actor !== undefined && event.actor.address !== owner)
    || message.chatGuids.some(guid => !ownerChatGuid(guid, owner))
    || !message.guid || message.itemType !== "normal" || message.isSystemMessage || message.isServiceMessage
    || message.isCorrupt || message.reaction !== undefined || message.reactionTargetGuid !== undefined
    || message.reactionSelected !== undefined) return;

  // Project scalars explicitly; never persist lazy functions or provider payloads.
  const attachments = message.content.attachments.filter(attachment =>
    !attachment.isHidden && !attachment.isOutgoing && !attachment.isSticker && attachment.guid.length > 0,
  ).map(attachment => ({
    guid: attachment.guid,
    fileName: attachment.fileName,
    mimeType: attachment.mimeType,
    totalBytes: attachment.totalBytes,
    transferState: attachment.transferState,
    uti: attachment.uti,
    isHidden: attachment.isHidden,
    isOutgoing: attachment.isOutgoing,
    isSticker: attachment.isSticker,
    ...(attachment.originalGuid === undefined ? {} : { originalGuid: attachment.originalGuid }),
    ...(attachment.companionKind === undefined ? {} : { companionKind: attachment.companionKind }),
  }));
  const text = (message.content.text ?? "").replace(/\uFFFC/g, "");
  if (!text.trim() && attachments.length === 0) return;
  const replyTo = [message.replyTargetGuid, message.threadOriginatorGuid].find(guid => guid && guid !== message.guid);
  return {
    id: message.guid,
    text,
    ...(replyTo ? { replyTo } : {}),
    isAudioMessage: message.isAudioMessage,
    attachments,
    source: message.isAudioMessage ? "composed" : "typed",
  };
}
