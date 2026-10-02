import { classifySendFailure, type SendFailure, type Telegram } from "./telegram.ts";
import type { OutboxRecord, Store } from "./store.ts";

export { classifySendFailure } from "./telegram.ts";

type Options = {
  chatId: () => number | undefined;
  enabled: () => boolean;
  beforeSend?: (item: OutboxRecord) => Promise<"send" | "wait" | "cancel">;
  log?: (event: string, code?: string) => void;
  sleep?: (ms: number) => Promise<void>;
};
type Checkpoint = { accepted: boolean; providerId?: number };
const RETRY_WINDOW = 24 * 60 * 60 * 1_000;
const MAX_ATTEMPTS = 5;
const CHUNK = 3_900;

export class Delivery {
  private ticking?: Promise<void>;
  private lastError = "";
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly store: Store,
    private readonly transport: Pick<Telegram, "sendMessage" | "sendDocument">,
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

  private withinRetryWindow(id: string): boolean {
    const firstAttempt = this.store.get<number>(`firstAttempt:${id}`);
    const age = Date.now() - (firstAttempt ?? NaN);
    return typeof firstAttempt === "number" && Number.isFinite(firstAttempt) && age >= 0 && age < RETRY_WINDOW;
  }

  private current(item: OutboxRecord, state: string): boolean {
    return this.store.getOperation(item.id)?.state === state;
  }

  private error(code: string): void {
    this.lastError = code;
    this.options.log?.("outbound-failed", code);
  }

  private failed(item: OutboxRecord, state: string, wasAmbiguous: boolean, failure: SendFailure): void {
    if (!this.current(item, state)) return;
    this.store.db.transaction(() => {
      const ambiguous = wasAmbiguous || failure.uncertain;
      this.store.set(`sendAmbiguous:${item.id}`, ambiguous);
      const attempts = this.store.getOperation(item.id)!.attempts;
      if (failure.retryable && attempts < MAX_ATTEMPTS && this.withinRetryWindow(item.id)) {
        const wait = failure.retryAfterMs ?? Math.min(300_000, 5_000 * 2 ** attempts);
        this.store.set(`retry:${item.id}`, Date.now() + wait);
        this.store.outboxState(item.id, "pending");
      } else {
        this.store.outboxState(item.id, ambiguous ? "uncertain" : "failed");
      }
    }).immediate();
    this.error(failure.code);
  }

  private async run(): Promise<void> {
    if (!this.options.enabled()) return;
    const boundChat = this.options.chatId();
    if (boundChat === undefined) return;
    let dispatched = 0;
    operations: for (const queued of this.store.pendingOutbox()) {
      if (dispatched >= 10) break;
      if (!this.options.enabled() || this.options.chatId() === undefined) break;
      const item = this.store.getOperation(queued.id);
      if (!item || !this.current(item, "pending")) continue;
      if (!item.text.trim() && !item.attachment) {
        this.store.outboxState(item.id, "failed");
        this.error("emptyContent");
        continue;
      }
      if ((this.store.get<number>(`retry:${item.id}`) ?? 0) > Date.now()) continue;

      const characters = Array.from(item.text.trim() ? item.text : "");
      const chunks: string[] = [];
      for (let offset = 0; offset < characters.length; offset += CHUNK) {
        chunks.push(characters.slice(offset, offset + CHUNK).join(""));
      }
      let state = "pending";
      let firstId = item.providerId;
      const steps = chunks.length + (item.attachment ? 1 : 0);
      for (let index = 0; index < steps; index++) {
        if (!this.current(item, state)) continue operations;
        const chunkKey = `chunk:${item.id}:${index}`;
        const checkpoint = this.store.get<Checkpoint>(chunkKey);
        if (checkpoint?.accepted) {
          firstId ??= checkpoint.providerId;
          continue;
        }
        const chatId = this.options.chatId();
        if (!this.options.enabled() || chatId === undefined) {
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
        const destination = this.store.get<number>(destinationKey) ?? chatId;
        if (destination !== chatId) {
          this.store.outboxState(item.id, "uncertain");
          this.error("chatChanged");
          continue operations;
        }
        const decision = this.options.beforeSend ? await this.options.beforeSend(item) : "send";
        if (!this.current(item, state)) continue operations;
        if (decision !== "send") {
          if (decision === "cancel") this.store.outboxState(item.id, "cancelled");
          else if (state === "sending") this.store.outboxState(item.id, "pending");
          continue operations;
        }
        if (!this.options.enabled() || this.options.chatId() !== chatId) {
          if (state === "sending") this.store.outboxState(item.id, "pending");
          continue operations;
        }
        this.store.db.transaction(() => {
          if (firstAttempt === undefined) this.store.set(`firstAttempt:${item.id}`, Date.now());
          this.store.set(destinationKey, chatId);
          // A crash after dispatch but before checkpointing must remain ambiguous.
          this.store.set(ambiguityKey, true);
          if (state === "pending") this.store.outboxState(item.id, "sending");
        }).immediate();
        if (state === "pending") dispatched++;
        state = "sending";
        let result: { providerId?: number };
        try {
          if (item.attachment && index === chunks.length) {
            const previous = index > 0 ? this.store.get<Checkpoint>(`chunk:${item.id}:${index - 1}`) : undefined;
            result = await this.transport.sendDocument({
              chatId, data: this.store.getBlob(item.attachment.sha256),
              name: item.attachment.name, mimeType: item.attachment.mimeType,
              ...(previous?.providerId !== undefined ? { replyTo: previous.providerId } : {}),
            });
          } else if (item.attachment && index > chunks.length) {
            throw new Error("unreachable");
          } else {
            const previous = index > 0 ? this.store.get<Checkpoint>(`chunk:${item.id}:${index - 1}`) : undefined;
            const keyboard = !item.attachment && index === chunks.length - 1 ? item.keyboard : undefined;
            result = await this.transport.sendMessage({
              chatId, text: chunks[index]!,
              ...(item.replyTo === undefined && previous?.providerId === undefined ? {}
                : { replyTo: previous?.providerId ?? item.replyTo }),
              ...(keyboard === undefined ? {} : { keyboard }),
            });
          }
        } catch (error) {
          this.failed(item, state, wasAmbiguous, classifySendFailure(error));
          continue operations;
        }
        // Provider acceptance is durable even if cancellation raced with this call.
        // Keep every message alias and its checkpoint in the same SQLite transaction.
        this.store.db.transaction(() => {
          this.store.set(chunkKey, { accepted: true, providerId: result.providerId } satisfies Checkpoint);
          if (result.providerId !== undefined) {
            const key = `provider-operation:${result.providerId}`;
            const existing = this.store.get<string>(key) ?? this.store.byProviderId(result.providerId)?.id;
            if (existing !== undefined && existing !== item.id) throw new Error("Provider alias conflict");
            this.store.set(key, item.id);
          }
          this.store.set(ambiguityKey, false);
        }).immediate();
        firstId ??= result.providerId;
        const active = this.current(item, state);
        if (active && index === steps - 1) {
          this.store.outboxState(item.id, "sent", firstId);
          this.options.log?.("outbound-accepted");
        }
        await this.sleep(800);
        if (!active || index === steps - 1) continue operations;
      }
      // All remaining chunks were already checkpointed; no RPC or attempt is needed.
      if (this.current(item, state)) {
        this.store.outboxState(item.id, "sent", firstId);
        this.options.log?.("outbound-accepted");
      }
    }
  }
}
