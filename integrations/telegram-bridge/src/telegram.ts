import { redact } from "./redact.ts";
import { Bot, GrammyError, HttpError, InputFile } from "grammy";
import type { Chat } from "grammy/types";
import type { KeyboardSpec } from "./store.ts";
import { toolError } from "./toollog.ts";

export const MAX_TEXT = 4_096;

export class TransportError extends Error {
  constructor(
    public readonly code: string,
    public readonly retryable = false,
    public readonly ambiguous = false,
  ) {
    super(`Telegram transport failed (${code})`);
    this.name = "TransportError";
  }
}

export type SendFailure = { retryable: boolean; uncertain: boolean; code: string; retryAfterMs?: number };

/** Unknown outcomes may only be retried with the original durable operation id. */
export function classifySendFailure(error: unknown): SendFailure {
  if (error instanceof TransportError) {
    return { retryable: error.retryable, uncertain: error.ambiguous, code: error.code };
  }
  if (error instanceof GrammyError) {
    const code = Number.isSafeInteger(error.error_code) ? error.error_code : 0;
    if (code === 429) {
      const retryAfter = Number(error.parameters?.retry_after);
      const wait = Number.isSafeInteger(retryAfter) && retryAfter > 0 ? retryAfter : 1;
      return { retryable: true, uncertain: false, code: "floodWait", retryAfterMs: wait * 1_000 + 500 };
    }
    if (code === 409) return { retryable: true, uncertain: false, code: "telegramConflict" };
    if (code >= 500) return { retryable: true, uncertain: true, code: `telegramHttp${code}` };
    if (code >= 400) return { retryable: false, uncertain: false, code: `telegramHttp${code}` };
    return { retryable: true, uncertain: true, code: "unknownSendFailure" };
  }
  if (error instanceof HttpError) return { retryable: true, uncertain: true, code: "telegramNetwork" };
  return { retryable: true, uncertain: true, code: "unknownSendFailure" };
}

export type TelegramUpdate =
  | { type: "message"; messageId: number; chatId: number; fromUserId: number; text: string; replyToMessageId?: number }
  | { type: "callback"; callbackId: string; chatId: number; messageId: number; fromUserId: number; data: string };

export type SendResult = { providerId?: number };

export type StartOptions = {
  onMessage: (update: TelegramUpdate) => Promise<void>;
  onBound: (chatId: number) => void;
  log?: (event: string, code?: string) => void;
};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function replyMarkup(keyboard?: KeyboardSpec) {
  if (keyboard === undefined) return undefined;
  if ("remove" in keyboard) return { inline_keyboard: [] };
  return {
    inline_keyboard: keyboard.rows.map(row => row.map(button => ({ text: redact(button.text), callback_data: button.data }))),
  };
}

/** Telegram Bot API transport. The durable outbox owns retries and identities. */
export class Telegram {
  #token: string;
  readonly ownerId: string;
  #bot?: Bot;
  #stopping = false;

  constructor(token: string, ownerId: string) {
    if (!token.trim() || /[\r\n]/.test(token)) throw new TransportError("invalidCredentials");
    if (ownerId !== "" && !/^\d{1,16}$/.test(ownerId)) throw new TransportError("invalidOwner");
    this.#token = token;
    this.ownerId = ownerId;
  }

  #client(): Bot {
    if (this.#stopping) throw new TransportError("closed");
    return this.#bot ??= new Bot(this.#token);
  }

  /** Validates the token without sending anything. */
  async check(): Promise<{ username?: string }> {
    const me = await this.#client().api.getMe();
    if (me?.is_bot !== true || typeof me.id !== "number" || typeof me.username !== "string") {
      throw new TransportError("invalidToken");
    }
    return { username: me.username };
  }

  /** Cheap reachability probe for health reporting. */
  async ping(): Promise<boolean> {
    try {
      const me = await this.#client().api.getMe();
      return me?.is_bot === true && typeof me.id === "number";
    } catch (error) {
      toolError("telegram", "tg.transport.ping", undefined, error);
      return false;
    }
  }

  async sendMessage(input: { chatId: number; text: string; replyTo?: number; keyboard?: KeyboardSpec }): Promise<SendResult> {
    if (!Number.isSafeInteger(input.chatId)) throw new TransportError("invalidChat");
    if (typeof input.text !== "string" || !input.text.trim() || input.text.length > MAX_TEXT) {
      throw new TransportError("invalidText");
    }
    const message = await this.#client().api.sendMessage(input.chatId, redact(input.text), {
      link_preview_options: { is_disabled: true },
      ...(input.replyTo === undefined ? {} : { reply_parameters: { message_id: input.replyTo } }),
      ...(replyMarkup(input.keyboard) === undefined ? {} : { reply_markup: replyMarkup(input.keyboard)! }),
    });
    if (typeof message.message_id !== "number" || !Number.isSafeInteger(message.message_id)) {
      throw new TransportError("invalidSendResult");
    }
    return { providerId: message.message_id };
  }

  async sendDocument(input: {
    chatId: number; data: Uint8Array; name: string; mimeType: string; caption?: string; replyTo?: number;
  }): Promise<SendResult> {
    if (!Number.isSafeInteger(input.chatId)) throw new TransportError("invalidChat");
    if (!(input.data instanceof Uint8Array) || !input.name.trim() || input.name === "." || input.name === ".."
      || /[\x00-\x1f\x7f]/.test(input.name) || !input.mimeType.trim() || /[\x00-\x1f\x7f]/.test(input.mimeType)) {
      throw new TransportError("invalidAttachment");
    }
    if (input.data.byteLength > 20 * 1024 * 1024) throw new TransportError("attachmentTooLarge");
    if (input.caption !== undefined && (typeof input.caption !== "string" || input.caption.length > 1_024)) {
      throw new TransportError("invalidText");
    }
    const document = new InputFile(input.data, input.name);
    const message = await this.#client().api.sendDocument(input.chatId, document, {
      ...(input.caption?.trim() ? { caption: redact(input.caption).slice(0, 1_024) } : {}),
      ...(input.replyTo === undefined ? {} : { reply_parameters: { message_id: input.replyTo } }),
    });
    if (typeof message.message_id !== "number" || !Number.isSafeInteger(message.message_id)) {
      throw new TransportError("invalidSendResult");
    }
    return { providerId: message.message_id };
  }

  async editMessageText(chatId: number, messageId: number, text: string, keyboard?: KeyboardSpec): Promise<void> {
    if (!Number.isSafeInteger(chatId) || !Number.isSafeInteger(messageId)) throw new TransportError("invalidChat");
    if (typeof text !== "string" || !text.trim() || text.length > MAX_TEXT) throw new TransportError("invalidText");
    const markup = replyMarkup(keyboard);
    await this.#client().api.editMessageText(chatId, messageId, redact(text), {
      ...(markup === undefined ? {} : { reply_markup: markup! }),
    });
  }

  async answerCallback(callbackId: string, text?: string): Promise<void> {
    if (!callbackId.trim()) throw new TransportError("invalidCallback");
    await this.#client().api.answerCallbackQuery(callbackId, {
      ...(text === undefined ? {} : { text: redact(text).slice(0, 200) }),
    });
  }

  /** Long polling with reconnect. Resolves only after stop(). */
  async start(options: StartOptions): Promise<void> {
    const bot = this.#client();
    const log = options.log;
    bot.catch(error => { toolError("telegram", "tg.transport.polling", undefined, error.error); log?.("polling-error", classifySendFailure(error.error).code); });
    const accepted = (from: { id?: number } | undefined): number | undefined => {
      const id = from?.id;
      if (!Number.isSafeInteger(id)) return undefined;
      if (this.ownerId === "") return id;
      return String(id) === this.ownerId ? id : undefined;
    };
    bot.on("message", async (ctx, next) => {
      const chat: Chat | undefined = ctx.chat;
      const from = ctx.from;
      const message = ctx.message;
      if (chat?.type !== "private" || !message) return await next();
      const fromUserId = accepted(from);
      if (fromUserId === undefined) return;
      options.onBound(chat.id);
      const replyToMessageId = message.reply_to_message?.message_id;
      await options.onMessage({
        type: "message",
        messageId: message.message_id,
        chatId: chat.id,
        fromUserId,
        ...(typeof message.text === "string" ? { text: message.text } : { text: "" }),
        ...(Number.isSafeInteger(replyToMessageId) ? { replyToMessageId } : {}),
      });
    });
    bot.on("callback_query", async (ctx, next) => {
      const chat: Chat | undefined = ctx.chat;
      const from = ctx.from;
      const callback = ctx.callbackQuery;
      if (chat?.type !== "private" || !callback?.message) return await next();
      const fromUserId = accepted(from);
      if (fromUserId === undefined) return;
      options.onBound(chat.id);
      await options.onMessage({
        type: "callback",
        callbackId: callback.id,
        chatId: chat.id,
        messageId: callback.message.message_id,
        fromUserId,
        ...(typeof callback.data === "string" ? { data: callback.data } : { data: "" }),
      });
    });
    let backoff = 2_000;
    while (!this.#stopping) {
      try {
        await bot.start({ allowed_updates: ["message", "callback_query"] });
        backoff = 2_000;
      } catch (error) {
        toolError("telegram", "tg.transport.start", undefined, error);
        // grammY resolves or rejects; both mean polling ended without stop().
        if (!this.#stopping) backoff = Math.min(60_000, backoff * 2);
      }
      if (this.#stopping) break;
      try { await bot.stop(); } catch (error) { toolError("telegram", "tg.transport.reconnectStop", undefined, error); }
      await sleep(backoff);
    }
  }

  stop(): Promise<void> {
    this.#stopping = true;
    const bot = this.#bot;
    return (bot ? bot.stop() : Promise.resolve()).catch(error => { toolError("telegram", "tg.transport.stop", undefined, error); }) as Promise<void>;
  }
}
