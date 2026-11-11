/**
 * Every call a Needs-you screen makes to the server, in one place: the ask
 * routes under `/api/ardud/kanban` over HTTP with the client's own session
 * (cookie, or the connection's bearer token), and the one socket call that
 * carries a secret. The web page and the phone share it; each passes in how it
 * reaches its server, so a call that moves changes here only.
 */
import {
  KanbanAskDetail,
  KanbanAskFeedItem,
  KanbanMessage,
  readingUnknownKanbanBlocks,
  type KanbanAskFeed,
  type KanbanAskSecretAnswerInput,
  type KanbanBlock,
  type KanbanOwnerAsk,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import type { AskAnswerBody } from "./askAnswer.ts";
import {
  askSecretFailure,
  type AskSecretAnswerInput,
  type AskSecretFailure,
} from "./askSecrets.ts";

const PREFIX = "/api/ardud/kanban";

/** A refused or failed call. `status` 0 means the request never got an answer. */
export class AskApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** The ask's revision now, when the refusal carried it. */
  readonly revision: number | null;
  /** Why it was denied, when the server said (`not_owner_device`). */
  readonly reason: string | null;
  constructor(
    status: number,
    code: string,
    message: string,
    revision: number | null = null,
    reason: string | null = null,
  ) {
    super(message);
    this.name = "AskApiError";
    this.status = status;
    this.code = code;
    this.revision = revision;
    this.reason = reason;
  }
  /** The ask changed or closed since it was read: read it again and keep what he typed. */
  get stale(): boolean {
    return this.status === 409 || this.revision !== null;
  }
  /**
   * Only the owner's own session answers, hands over, snoozes or replies on an
   * ask, and this session is not one. Sending again from here can't work, so
   * it is never retried and never held for Undo.
   */
  get denied(): boolean {
    return this.status === 403 || this.code === "denied";
  }
  /** A paired device that was not paired as his: it has to be paired again from an owner device. */
  get notOwnerDevice(): boolean {
    return this.denied && this.reason === "not_owner_device";
  }
  /** The request never got an answer: the server was not reached, or was not connected. */
  get unreached(): boolean {
    return this.status === 0;
  }
}

/** A failed call in the server's own words. */
export const askFailureText = (error: unknown): string =>
  error instanceof Error && error.message !== "" ? error.message : "Robob did not confirm it.";

/** The revision a refusal says the ask is at now: its `revision` field. */
const revisionIn = (error: unknown): number | null => {
  if (typeof error !== "object" || error === null) return null;
  const { revision } = error as { revision?: unknown };
  return typeof revision === "number" && Number.isInteger(revision) && revision >= 0
    ? revision
    : null;
};

/** Where the ask routes are and how this client proves who it is. */
export interface AskApiTarget {
  readonly base: string;
  readonly headers: Readonly<Record<string, string>>;
  /** The session rides in a cookie (the web app on its own server). */
  readonly cookies: boolean;
}

/** What a secret send came to, before it is put in words. */
export type AskSecretSendResult =
  | { readonly _tag: "sent" }
  /** Another send of the same ask replaced this one. */
  | { readonly _tag: "interrupted" }
  /** Not connected: nothing was sent. */
  | { readonly _tag: "offline" }
  /** The server's failure value, as the socket gave it. */
  | { readonly _tag: "failed"; readonly failure: unknown };

export interface AskApiHost {
  /** The connection to call. Throws `AskApiError(0, "offline", …)` when there is none. */
  readonly target: () => AskApiTarget;
  /**
   * Sends an answer with its secret values over the socket method made for it
   * (`secrets.answerAsk`). The host must not log, report or keep the input.
   */
  readonly answerSecrets: (input: KanbanAskSecretAnswerInput) => Promise<AskSecretSendResult>;
  /** The fetch to use; the global one when unset. */
  readonly fetch?: typeof fetch;
}

interface CallOptions {
  readonly body?: unknown;
  /** The page is going away: let the request outlive it. */
  readonly keepalive?: boolean;
  readonly signal?: AbortSignal;
}

const isAbort = (cause: unknown): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  (cause as { name?: unknown }).name === "AbortError";

/**
 * The route on the server `base` names: its origin plus the absolute path, as
 * `new URL(path, base)` would give, without leaning on a URL class that is
 * thin on some runtimes.
 */
export const askRouteUrl = (base: string, path: string): string => {
  const origin = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]+/i.exec(base)?.[0] ?? base.replace(/\/+$/, "");
  return `${origin}${PREFIX}${path}`;
};

export interface AskDetail {
  readonly boardId: string;
  readonly cardId: string;
  readonly cardNumber: number;
  readonly discussionId: string | null;
  readonly ask: KanbanOwnerAsk;
}

export interface AskAnswered {
  readonly card: { readonly id: string; readonly number: number; readonly stage: string };
  readonly ask: KanbanOwnerAsk | null;
}

export interface AskBatchItem {
  readonly card: string;
  readonly askId: string;
  /** The revision he read. Every answer carries one. */
  readonly revision: number;
}

export type AskSecretOutcome =
  | { readonly _tag: "sent" }
  /** Another send of the same ask replaced this one. */
  | { readonly _tag: "interrupted" }
  | { readonly _tag: "refused"; readonly failure: AskSecretFailure };

export interface AskBatchResult {
  readonly answered: number;
  readonly results: ReadonlyArray<
    | { readonly card: string; readonly askId: string; readonly ok: true; readonly stage: string }
    | {
        readonly card: string;
        readonly askId: string;
        readonly ok: false;
        readonly error: {
          readonly code: string;
          readonly message: string;
          readonly reason?: string;
          /** The revision the ask is at now, on a refusal of an older one. */
          readonly revision?: number;
        };
      }
  >;
}

export interface AskEvaluatorStart {
  readonly started: boolean;
  readonly threadId: string | null;
  readonly error: string | null;
}

/** Several asks handed over in one request. With `always`: one evaluator thread per board. */
export interface AskHandBatchResult {
  readonly handed: number;
  readonly results: AskBatchResult["results"];
  readonly evaluators?: ReadonlyArray<
    AskEvaluatorStart & {
      readonly board: string;
      readonly asks: ReadonlyArray<{ readonly card: string; readonly askId: string }>;
    }
  >;
}

export interface AskHanded extends AskAnswered {
  readonly evaluator?: AskEvaluatorStart;
}

export interface AskApi {
  /** Open asks, plus the ones closed in the window given (`24h`, `7d`, an ISO time). */
  readonly feed: (input?: {
    readonly closed?: string;
    readonly signal?: AbortSignal;
  }) => Promise<KanbanAskFeed>;
  /** One ask with its big blocks whole. */
  readonly detail: (cardRef: string, askId: string) => Promise<AskDetail>;
  /** One answer. `revision` is the ask as he read it; the server refuses an answer to another one. */
  readonly answer: (
    cardRef: string,
    askId: string,
    body: AskAnswerBody,
    revision: number,
    keepalive?: boolean,
  ) => Promise<AskAnswered>;
  /**
   * An answer that carries secret values, whole, over the socket method made
   * for it. The values are only ever arguments here: nothing is kept, logged
   * or reported, and a failure is described without the request.
   */
  readonly answerSecrets: (
    input: AskSecretAnswerInput,
    revision: number,
  ) => Promise<AskSecretOutcome>;
  readonly answerBatch: (
    body: Omit<AskAnswerBody, "revision" | "values" | "finalDraft">,
    items: ReadonlyArray<AskBatchItem>,
    keepalive?: boolean,
  ) => Promise<AskBatchResult>;
  /** A reply in the ask's discussion. It does not answer the ask: the ask then waits on its agent. */
  readonly reply: (
    cardRef: string,
    askId: string,
    blocks: ReadonlyArray<KanbanBlock>,
  ) => Promise<KanbanMessage>;
  readonly hand: (
    cardRef: string,
    askId: string,
    input: {
      readonly action?: "hand" | "take_back";
      readonly always?: boolean;
      readonly text?: string;
    },
    keepalive?: boolean,
  ) => Promise<AskHanded>;
  /**
   * Hands several asks over at once. An ask that can't be handed does not stop
   * the rest; `always` with words that are too long is refused whole.
   */
  readonly handBatch: (
    items: ReadonlyArray<AskBatchItem>,
    input: { readonly always?: boolean; readonly text?: string },
    keepalive?: boolean,
  ) => Promise<AskHandBatchResult>;
  /** Puts an ask away until a time; `null` brings it back. */
  readonly snooze: (cardRef: string, askId: string, until: string | null) => Promise<AskAnswered>;
  readonly snoozeBatch: (
    items: ReadonlyArray<AskBatchItem>,
    until: string | null,
  ) => Promise<{ readonly snoozed: number; readonly results: AskBatchResult["results"] }>;
  /** One discussion message with its big blocks whole. */
  readonly message: (discussionId: string, seq: number) => Promise<KanbanMessage>;
}

/** Said when a read came back as JSON this build can't take in. */
export const ASK_UNREADABLE_TEXT =
  "Robob sent asks this app can't read. The app may be older than Robob: update it and try again.";

/**
 * What the server sent, read through the schema the apps read cards with. A
 * block of a kind this build doesn't know becomes its one-line stand-in and
 * nothing of it is kept; anything else that doesn't fit is refused whole, as
 * an error the page shows with Retry, never as an empty or half-read answer.
 */
const reader =
  <A>(decode: (json: unknown) => A) =>
  (json: unknown): A => {
    try {
      return readingUnknownKanbanBlocks(() => decode(json));
    } catch {
      // Answered, but not with something to show: not a lost connection, so nothing is retried by itself.
      throw new AskApiError(200, "unreadable", ASK_UNREADABLE_TEXT);
    }
  };

const readFeedShape = reader(
  Schema.decodeUnknownSync(
    Schema.Struct({
      at: Schema.String,
      open: Schema.Array(Schema.Unknown),
      closed: Schema.Array(Schema.Unknown),
    }),
  ),
);
const readFeedItem = reader(Schema.decodeUnknownSync(KanbanAskFeedItem));
const readDetail = reader(Schema.decodeUnknownSync(KanbanAskDetail));
const readMessage = reader(Schema.decodeUnknownSync(KanbanMessage));

const cardPath = (cardRef: string, askId: string) =>
  `/cards/${encodeURIComponent(cardRef)}/asks/${encodeURIComponent(askId)}`;

export function createAskApi(host: AskApiHost): AskApi {
  async function call<T>(
    method: "GET" | "POST",
    path: string,
    options: CallOptions = {},
  ): Promise<T> {
    const { base, headers, cookies } = host.target();
    const send = host.fetch ?? fetch;
    let response: Response;
    try {
      response = await send(askRouteUrl(base, path), {
        method,
        cache: "no-store",
        credentials: cookies ? "include" : "omit",
        headers: {
          ...headers,
          ...(options.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        ...(options.keepalive ? { keepalive: true } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (cause) {
      if (isAbort(cause)) throw cause;
      throw new AskApiError(0, "network", "Robob did not answer.");
    }
    const text = await response.text();
    let json: unknown = null;
    try {
      json = text === "" ? null : JSON.parse(text);
    } catch {
      // A removed route answers with the app's index.html and 200: not data.
      throw new AskApiError(
        response.status,
        "failed",
        "Robob sent something that is not an answer.",
      );
    }
    if (!response.ok) {
      const error = (
        json as { error?: { code?: unknown; message?: unknown; reason?: unknown } } | null
      )?.error;
      throw new AskApiError(
        response.status,
        typeof error?.code === "string" ? error.code : "failed",
        typeof error?.message === "string" ? error.message : `Robob answered ${response.status}.`,
        revisionIn(error),
        typeof error?.reason === "string" ? error.reason : null,
      );
    }
    return json as T;
  }

  // The asks of the last feed, by the text each came as. The feed is read
  // every few seconds and most asks come again unchanged: those are not read
  // through the schema again, and stay the same object for whoever holds them.
  let lastItems = new Map<string, KanbanAskFeedItem>();
  const readFeed = (json: unknown): KanbanAskFeed => {
    const shape = readFeedShape(json);
    const items = new Map<string, KanbanAskFeedItem>();
    const item = (raw: unknown): KanbanAskFeedItem => {
      const text = JSON.stringify(raw);
      const read = lastItems.get(text) ?? items.get(text) ?? readFeedItem(raw);
      items.set(text, read);
      return read;
    };
    const feed = { at: shape.at, open: shape.open.map(item), closed: shape.closed.map(item) };
    // Only once the whole feed was read: a feed that is refused leaves the last one's asks known.
    lastItems = items;
    return feed;
  };

  return {
    feed: async (input = {}) =>
      readFeed(
        await call<unknown>(
          "GET",
          `/asks${input.closed ? `?closed=${encodeURIComponent(input.closed)}` : ""}`,
          input.signal ? { signal: input.signal } : {},
        ),
      ),
    detail: async (cardRef, askId) =>
      readDetail(await call<unknown>("GET", cardPath(cardRef, askId))),
    answer: (cardRef, askId, body, revision, keepalive = false) =>
      call<AskAnswered>("POST", `${cardPath(cardRef, askId)}/answer`, {
        body: { ...body, revision },
        keepalive,
      }),
    answerSecrets: async (input, revision) => {
      const result = await host.answerSecrets({
        ...input,
        answer: { ...input.answer, revision },
      } as KanbanAskSecretAnswerInput);
      if (result._tag === "sent" || result._tag === "interrupted") return result;
      if (result._tag === "offline") {
        return {
          _tag: "refused",
          failure: { message: "Not connected to Robob.", stale: false, field: null },
        };
      }
      return { _tag: "refused", failure: askSecretFailure(result.failure) };
    },
    answerBatch: (body, items, keepalive = false) =>
      call<AskBatchResult>("POST", "/asks/answer", { body: { ...body, items }, keepalive }),
    reply: (cardRef, askId, blocks) =>
      call<KanbanMessage>("POST", `${cardPath(cardRef, askId)}/reply`, { body: { blocks } }),
    hand: (cardRef, askId, input, keepalive = false) =>
      call<AskHanded>("POST", `${cardPath(cardRef, askId)}/hand`, { body: input, keepalive }),
    handBatch: (items, input, keepalive = false) =>
      call<AskHandBatchResult>("POST", "/asks/hand", {
        body: { ...input, items: items.map(({ card, askId }) => ({ card, askId })) },
        keepalive,
      }),
    snooze: (cardRef, askId, until) =>
      call<AskAnswered>("POST", `${cardPath(cardRef, askId)}/snooze`, { body: { until } }),
    snoozeBatch: (items, until) =>
      call<{ readonly snoozed: number; readonly results: AskBatchResult["results"] }>(
        "POST",
        "/asks/snooze",
        { body: { until, items: items.map(({ card, askId }) => ({ card, askId })) } },
      ),
    message: async (discussionId, seq) =>
      readMessage(
        await call<unknown>(
          "GET",
          `/discussions/${encodeURIComponent(discussionId)}/messages/${seq}`,
        ),
      ),
  };
}
