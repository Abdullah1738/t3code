import { createHash } from "node:crypto";
import { IMessageError } from "@photon-ai/advanced-imessage/grpc";
import { formatText, isSingleUrl, splitFormatted, stripInternalText } from "./formatting.ts";
import { classifySendFailure, isEffect, type Photon, type PollResult } from "./photon.ts";
import { rememberUnmatchedPoll } from "./poll-match.ts";
import type { OutboxRecord, PollRecord, Store } from "./store.ts";

export { classifySendFailure } from "./photon.ts";

type Options = {
  projectScope: string;
  chatGuid: () => string | undefined;
  enabled: () => boolean;
  beforeSend?: (item: OutboxRecord) => Promise<"send" | "wait" | "cancel">;
  log?: (event: string, code?: string) => void;
  sleep?: (ms: number) => Promise<void>;
};
type Checkpoint = { accepted: boolean; providerId?: string };
type UploadCheckpoint = { guid: string; sha256: string };
const RETRY_WINDOW = 24 * 60 * 60 * 1_000;
const MAX_ATTEMPTS = 5;
type App = NonNullable<OutboxRecord["app"]>;

/** Card text gets the same cleanup as messages; a caption left empty makes the card unsendable. */
function sanitizeApp(app: App): App | undefined {
  const caption = stripInternalText(app.caption);
  if (!caption) return undefined;
  const clean: App = { url: app.url, caption };
  for (const key of ["subcaption", "trailingCaption", "trailingSubcaption", "summary"] as const) {
    const value = app[key] === undefined ? "" : stripInternalText(app[key]);
    if (value) clean[key] = value;
  }
  return clean;
}

export class Delivery {
  private ticking?: Promise<void>;
  private lastError = "";
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly store: Store,
    private readonly photon: Pick<Photon, "sendText">
      & Partial<Pick<Photon, "uploadAttachment" | "sendAttachment" | "sendPoll" | "sendApp">>,
    private readonly options: Options,
  ) {
    this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  }

  status(): { lastError: string } {
    return { lastError: this.lastError };
  }

  tick(): Promise<void> {
    return this.ticking ??= Promise.resolve().then(() => this.run()).finally(() => { this.ticking = undefined; });
  }

  /** Call after Store's startup recovery, never on another process's live sends. */
  recover(): void {
    this.store.db.transaction(() => {
      const rows = this.store.db.query<{ id: string }, []>("SELECT id FROM outbox WHERE state = 'uncertain'").all();
      for (const { id } of rows) {
        const item = this.store.getOperation(id)!;
        if (item.attempts < MAX_ATTEMPTS && this.withinRetryWindow(id)) {
          this.store.outboxState(id, "pending");
        }
      }
    }).immediate();
  }

  /** Record acceptance, and when it happened: replies to a prompt only count once it reached the phone. */
  private markSent(id: string, providerId: string | undefined): void {
    this.store.db.transaction(() => {
      this.store.outboxState(id, "sent", providerId);
      if (this.store.get<number>(`sent-at:${id}`) === undefined) this.store.set(`sent-at:${id}`, Date.now());
    }).immediate();
  }

  private withinRetryWindow(id: string): boolean {
    const firstAttempt = this.store.get<number>(`firstAttempt:${id}`);
    const age = Date.now() - (firstAttempt ?? NaN);
    return typeof firstAttempt === "number" && Number.isFinite(firstAttempt) && age >= 0 && age < RETRY_WINDOW;
  }

  private current(item: OutboxRecord, state: string): boolean {
    if (this.store.getOperation(item.id)?.state !== state) return false;
    const route = this.store.get<{ id: string; generation: number } | null>("route");
    if (item.generation !== undefined && (route?.id !== item.sessionId || route?.generation !== item.generation)) {
      this.store.outboxState(item.id, "cancelled");
      return false;
    }
    return true;
  }

  private error(code: string): void {
    this.lastError = code;
    this.options.log?.("outbound-failed", code);
  }

  private failed(item: OutboxRecord, state: string, wasAmbiguous: boolean, failure: ReturnType<typeof classifySendFailure>): void {
    if (!this.current(item, state)) return;
    this.store.db.transaction(() => {
      const ambiguous = wasAmbiguous || failure.uncertain;
      this.store.set(`sendAmbiguous:${item.id}`, ambiguous);
      const attempts = this.store.getOperation(item.id)!.attempts;
      if (failure.retryable && attempts < MAX_ATTEMPTS && this.withinRetryWindow(item.id)) {
        this.store.set(`retry:${item.id}`, Date.now() + Math.min(300_000, 5_000 * 2 ** attempts));
        this.store.outboxState(item.id, "pending");
      } else {
        this.store.outboxState(item.id, ambiguous ? "uncertain" : "failed");
      }
    }).immediate();
    this.error(failure.code);
  }

  private async run(): Promise<void> {
    if (!this.options.enabled() || !this.options.chatGuid()) return;
    let dispatched = 0;
    operations: for (const queued of this.store.pendingOutbox()) {
      if (dispatched >= 10) break;
      if (!this.options.enabled() || !this.options.chatGuid()) break;
      const item = this.store.getOperation(queued.id);
      if (!item || !this.current(item, "pending")) continue;
      if (!item.text.trim() && !item.attachment && !item.poll && !item.app) {
        this.store.outboxState(item.id, "failed");
        this.error("emptyContent");
        continue;
      }
      if ([item.attachment, item.poll, item.app].filter(Boolean).length > 1
        || (item.effect !== undefined && !isEffect(item.effect))) {
        this.store.outboxState(item.id, "failed");
        this.error("invalidContent");
        continue;
      }
      if ((item.attachment && (!this.photon.uploadAttachment || !this.photon.sendAttachment))
        || (item.poll && !this.photon.sendPoll) || (item.app && !this.photon.sendApp)) {
        this.store.outboxState(item.id, "failed");
        this.error("unsupported");
        continue;
      }
      if ((this.store.get<number>(`retry:${item.id}`) ?? 0) > Date.now()) continue;

      // Split after stripping markup so every chunk carries its own native ranges.
      const chunks = splitFormatted(formatText(item.text.trim() ? item.text : ""), 3_500);
      const app = item.app && sanitizeApp(item.app);
      // Nothing but leaked metadata: never send an empty bubble or a blank card.
      if ((!chunks.length && !item.attachment && !item.poll && !item.app) || (item.app && !app)) {
        if (this.current(item, "pending")) this.store.outboxState(item.id, "cancelled");
        this.options.log?.("outbound-skipped", "emptyAfterSanitize");
        continue;
      }
      let state = "pending";
      let firstId = item.providerId;
      const steps = chunks.length + (item.attachment || item.poll || item.app ? 1 : 0);
      for (let index = 0; index < steps; index++) {
        if (!this.current(item, state)) continue operations;
        const chunkKey = `chunk:${item.id}:${index}`;
        const checkpoint = this.store.get<Checkpoint>(chunkKey);
        if (checkpoint?.accepted) {
          firstId ??= checkpoint.providerId;
          continue;
        }
        const availableChat = this.options.chatGuid();
        if (!this.options.enabled() || !availableChat) {
          if (state === "sending") this.store.outboxState(item.id, "pending");
          return;
        }
        const firstAttempt = this.store.get<unknown>(`firstAttempt:${item.id}`);
        if ((item.attempts > 0 || firstAttempt !== undefined) && !this.withinRetryWindow(item.id)) {
          this.store.outboxState(item.id, "uncertain");
          this.error("retryWindowExpired");
          continue operations;
        }
        const ambiguityKey = `sendAmbiguous:${item.id}`;
        const wasAmbiguous = this.store.get<boolean>(ambiguityKey) ?? item.attempts > 0;
        if (state === "pending" && item.attempts >= MAX_ATTEMPTS) {
          this.store.outboxState(item.id, wasAmbiguous ? "uncertain" : "failed");
          this.error("retryLimitReached");
          continue operations;
        }
        // Freeze the destination as well as the Store's immutable content and reply target.
        const destinationKey = `deliveryChat:${item.id}`;
        const chatGuid = this.store.get<string>(destinationKey) ?? availableChat;
        if (chatGuid !== availableChat) {
          this.store.outboxState(item.id, "uncertain");
          this.error("chatChanged");
          continue operations;
        }
        const id = `bridge-${createHash("sha256").update(`${this.options.projectScope}:${item.id}:${index}`).digest("hex")}`;
        const attachment = index === chunks.length ? item.attachment : undefined;
        const uploadKey = `upload:${item.id}`;
        const upload = attachment ? this.store.get<UploadCheckpoint>(uploadKey) : undefined;
        if (attachment && (upload !== undefined || wasAmbiguous)) {
          if (!upload || upload.sha256 !== attachment.sha256 || typeof upload.guid !== "string" || !upload.guid.trim()) {
            this.store.outboxState(item.id, wasAmbiguous ? "uncertain" : "failed");
            this.error("invalidAttachment");
            continue operations;
          }
        }
        if (attachment && !upload) {
          let data: Uint8Array;
          try {
            data = this.store.getBlob(attachment.sha256);
            if (data.byteLength !== attachment.size || createHash("sha256").update(data).digest("hex") !== attachment.sha256) {
              throw new Error("Invalid attachment blob");
            }
          } catch {
            this.store.outboxState(item.id, "failed");
            this.error("invalidAttachment");
            continue operations;
          }
          this.store.db.transaction(() => {
            if (firstAttempt === undefined) this.store.set(`firstAttempt:${item.id}`, Date.now());
            this.store.set(destinationKey, chatGuid);
            // Uploads cannot send a message, even when their response is lost.
            this.store.set(ambiguityKey, false);
            if (state === "pending") this.store.outboxState(item.id, "sending");
          }).immediate();
          if (state === "pending") dispatched++;
          state = "sending";
          let uploaded: { guid: string };
          try {
            uploaded = await this.photon.uploadAttachment!(Object.freeze({
              id, data, name: attachment.name, mimeType: attachment.mimeType,
            }));
          } catch (error) {
            this.failed(item, state, false, { ...classifySendFailure(error), uncertain: false });
            continue operations;
          }
          if (typeof uploaded.guid !== "string" || !uploaded.guid.trim()) {
            this.failed(item, state, false, { code: "invalidAttachment", retryable: false, uncertain: false });
            continue operations;
          }
          this.store.set(uploadKey, { guid: uploaded.guid, sha256: attachment.sha256 } satisfies UploadCheckpoint);
          // Re-enter every dispatch guard after the upload's async boundary, at the same final index.
          index--;
          continue;
        }
        const input = Object.freeze({
          id, chatGuid, ...(item.replyTo === undefined ? {} : { replyTo: item.replyTo }),
        });
        const decision = this.options.beforeSend ? await this.options.beforeSend(item) : "send";
        if (!this.current(item, state)) continue operations;
        if (decision !== "send") {
          if (decision === "cancel") this.store.outboxState(item.id, "cancelled");
          else if (state === "sending") this.store.outboxState(item.id, "pending");
          continue operations;
        }
        if (!this.options.enabled() || this.options.chatGuid() !== chatGuid) {
          if (state === "sending") this.store.outboxState(item.id, "pending");
          continue operations;
        }
        this.store.db.transaction(() => {
          if (firstAttempt === undefined) this.store.set(`firstAttempt:${item.id}`, Date.now());
          this.store.set(destinationKey, chatGuid);
          // A crash after dispatch but before checkpointing must remain ambiguous.
          this.store.set(ambiguityKey, true);
          if (state === "pending") this.store.outboxState(item.id, "sending");
        }).immediate();
        if (state === "pending") dispatched++;
        state = "sending";
        const final = index === chunks.length;
        let result: PollResult;
        try {
          if (attachment) {
            result = await this.photon.sendAttachment!(Object.freeze({ ...input, attachmentGuid: upload!.guid }));
          } else if (final && item.poll) {
            result = await this.photon.sendPoll!(Object.freeze({
              id, chatGuid, title: item.poll.title, options: Object.freeze([...item.poll.options]),
            }));
          } else if (final && item.app) {
            result = await this.photon.sendApp!(Object.freeze({ id, chatGuid, ...app! }));
          } else {
            const chunk = chunks[index]!;
            const rich = {
              ...(chunk.formatting.length ? { formatting: chunk.formatting } : {}),
              ...(isSingleUrl(chunk.text) ? { enableLinkPreview: true } : {}),
              ...(index === 0 && item.effect !== undefined && isEffect(item.effect) ? { effect: item.effect } : {}),
              ...(index === 0 && item.subject !== undefined ? { subject: item.subject } : {}),
            };
            const plain = `bridge-${createHash("sha256").update(`${this.options.projectScope}:${item.id}:${index}:plain`).digest("hex")}`;
            const fallbackKey = `plainFallback:${item.id}:${index}`;
            try {
              // Once rich options were rejected, replays go straight to the plain copy.
              result = this.store.get<boolean>(fallbackKey)
                ? await this.photon.sendText(Object.freeze({ ...input, id: plain, text: chunk.text }))
                : await this.photon.sendText(Object.freeze({ ...input, text: chunk.text, ...rich }));
            } catch (error) {
              if (this.store.get<boolean>(fallbackKey)) throw error;
              // A rejected rich option must never cost the owner the reply itself. An invalid
              // argument is a definite rejection, so nothing was delivered; the plain copy gets
              // its own stable id in case the provider reserved the first one.
              if (Object.keys(rich).length === 0 || !(error instanceof IMessageError) || error.grpcCode !== 3) throw error;
              if (!this.current(item, state) || !this.options.enabled() || this.options.chatGuid() !== chatGuid) throw error;
              this.options.log?.("outbound-plain-fallback", classifySendFailure(error).code);
              this.store.set(fallbackKey, true);
              result = await this.photon.sendText(Object.freeze({ ...input, id: plain, text: chunk.text }));
            }
          }
        } catch (error) {
          this.failed(item, state, wasAmbiguous, classifySendFailure(error));
          continue operations;
        }
        // Provider acceptance is durable even if cancellation raced with this RPC.
        // Keep every GUID alias and its checkpoint in the same SQLite transaction.
        this.store.db.transaction(() => {
          this.store.set(chunkKey, { accepted: true, providerId: result.providerId } satisfies Checkpoint);
          if (final && item.poll && !result.providerId) {
            rememberUnmatchedPoll(this.store, {
              operationId: item.id, title: item.poll.title, choices: [...item.poll.options],
              ...(item.sessionId === undefined ? {} : { sessionId: item.sessionId }),
              ...(item.generation === undefined ? {} : { generation: item.generation }),
              createdAt: Date.now(),
            });
          }
          if (result.providerId) {
            const key = `provider-operation:${result.providerId}`;
            const existing = this.store.get<string>(key) ?? this.store.byProviderId(result.providerId)?.id;
            if (existing !== undefined && existing !== item.id) throw new Error("Provider alias conflict");
            this.store.set(key, item.id);
            // Robob ties the owner's reply to the one decision this message asked for.
            if (item.notice) this.store.recordNotice(result.providerId, item.id, item.notice, Date.now());
            if (final && item.poll) {
              this.store.db.query("DELETE FROM kv WHERE key = ?").run(`poll-seen:${result.providerId}`);
              this.store.set(`poll:${result.providerId}`, {
                operationId: item.id, title: item.poll.title, options: result.options ?? [],
                ...(item.sessionId === undefined ? {} : { sessionId: item.sessionId }),
                ...(item.generation === undefined ? {} : { generation: item.generation }),
                createdAt: Date.now(),
              } satisfies PollRecord);
            }
          }
          this.store.set(ambiguityKey, false);
        }).immediate();
        firstId ??= result.providerId;
        const active = this.current(item, state);
        if (active && index === steps - 1) {
          this.markSent(item.id, firstId);
          this.options.log?.("outbound-accepted");
        }
        await this.sleep(800);
        if (!active || index === steps - 1) continue operations;
      }
      // All remaining chunks were already checkpointed; no RPC or attempt is needed.
      if (this.current(item, state)) {
        this.markSent(item.id, firstId);
        this.options.log?.("outbound-accepted");
      }
    }
  }
}
