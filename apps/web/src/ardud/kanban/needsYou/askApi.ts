/**
 * Every call the Needs-you page makes to the server, in one place: the ask
 * routes under `/api/ardud/kanban` over HTTP with the web session (cookie, or
 * the connection's bearer token), and the one socket call that carries a
 * secret. Nothing else in the page talks to the server, so a call that moves
 * (a stricter owner check, HTTP to a socket method) changes here only.
 */
import {
  askSecretFailure,
  type AskAnswerBody,
  type AskSecretAnswerInput,
  type AskSecretFailure,
} from "@t3tools/client-runtime/ardud/kanban";
import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  KanbanAskFeed,
  KanbanAskSecretAnswerInput,
  KanbanBlock,
  KanbanMessage,
  KanbanOwnerAsk,
} from "@t3tools/contracts";

import { appAtomRegistry } from "../../../rpc/atomRegistry";
import { primaryEnvironmentIdAtom } from "../../../state/primaryEnvironment";
import { serverEnvironment } from "../../../state/server";
import { readPreparedConnection } from "../../../state/session";

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

interface CallOptions {
  readonly body?: unknown;
  /** The page is going away: let the request outlive it. */
  readonly keepalive?: boolean;
  readonly signal?: AbortSignal;
}

function target(): {
  readonly base: string;
  readonly headers: Record<string, string>;
  readonly cookies: boolean;
} {
  const environmentId = appAtomRegistry.get(primaryEnvironmentIdAtom);
  const connection = environmentId === null ? null : readPreparedConnection(environmentId);
  if (connection === null) throw new AskApiError(0, "offline", "Not connected to Robob.");
  const authorization = connection.httpAuthorization;
  if (authorization === null) return { base: connection.httpBaseUrl, headers: {}, cookies: true };
  if (authorization._tag === "Bearer") {
    return {
      base: connection.httpBaseUrl,
      headers: { authorization: `Bearer ${authorization.token}` },
      cookies: false,
    };
  }
  throw new AskApiError(0, "unsupported", "This connection can't reach the ask routes.");
}

async function call<T>(
  method: "GET" | "POST",
  path: string,
  options: CallOptions = {},
): Promise<T> {
  const { base, headers, cookies } = target();
  let response: Response;
  try {
    response = await fetch(new URL(`${PREFIX}${path}`, base), {
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
    if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
    throw new AskApiError(0, "network", "Robob did not answer.");
  }
  const text = await response.text();
  let json: unknown = null;
  try {
    json = text === "" ? null : JSON.parse(text);
  } catch {
    // A removed route answers with the app's index.html and 200: not data.
    throw new AskApiError(response.status, "failed", "Robob sent something that is not an answer.");
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

const cardPath = (cardRef: string, askId: string) =>
  `/cards/${encodeURIComponent(cardRef)}/asks/${encodeURIComponent(askId)}`;

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

export const askApi = {
  /** Open asks, plus the ones closed in the window given (`24h`, `7d`, an ISO time). */
  feed: (input: { readonly closed?: string; readonly signal?: AbortSignal } = {}) =>
    call<KanbanAskFeed>(
      "GET",
      `/asks${input.closed ? `?closed=${encodeURIComponent(input.closed)}` : ""}`,
      input.signal ? { signal: input.signal } : {},
    ),
  /** One ask with its big blocks whole. */
  detail: (cardRef: string, askId: string) => call<AskDetail>("GET", cardPath(cardRef, askId)),
  /** One answer. `revision` is the ask as he read it; the server refuses an answer to another one. */
  answer: (
    cardRef: string,
    askId: string,
    body: AskAnswerBody,
    revision: number,
    keepalive = false,
  ) =>
    call<AskAnswered>("POST", `${cardPath(cardRef, askId)}/answer`, {
      body: { ...body, revision },
      keepalive,
    }),
  /**
   * An answer that carries secret values, whole, over the socket method made
   * for it. The values are only ever arguments here: nothing is kept, logged
   * or reported, and a failure is described without the request.
   */
  answerSecrets: async (
    input: AskSecretAnswerInput,
    revision: number,
  ): Promise<AskSecretOutcome> => {
    const environmentId = appAtomRegistry.get(primaryEnvironmentIdAtom);
    if (environmentId === null) {
      return {
        _tag: "refused",
        failure: { message: "Not connected to Robob.", stale: false, field: null },
      };
    }
    const result = await runAtomCommand(
      appAtomRegistry,
      serverEnvironment.answerAskSecrets,
      {
        environmentId,
        input: {
          ...input,
          answer: { ...input.answer, revision },
        } as KanbanAskSecretAnswerInput,
      },
      // The failure cause holds the request; keep it out of the console and reports.
      { label: "answer ask secrets", reportFailure: false, reportDefect: false },
    );
    if (result._tag === "Success") return { _tag: "sent" };
    if (isAtomCommandInterrupted(result)) return { _tag: "interrupted" };
    return { _tag: "refused", failure: askSecretFailure(squashAtomCommandFailure(result)) };
  },
  answerBatch: (
    body: Omit<AskAnswerBody, "revision" | "values" | "finalDraft">,
    items: ReadonlyArray<AskBatchItem>,
    keepalive = false,
  ) => call<AskBatchResult>("POST", "/asks/answer", { body: { ...body, items }, keepalive }),
  /** A reply in the ask's discussion. It does not answer the ask: the ask then waits on its agent. */
  reply: (cardRef: string, askId: string, blocks: ReadonlyArray<KanbanBlock>) =>
    call<KanbanMessage>("POST", `${cardPath(cardRef, askId)}/reply`, { body: { blocks } }),
  hand: (
    cardRef: string,
    askId: string,
    input: {
      readonly action?: "hand" | "take_back";
      readonly always?: boolean;
      readonly text?: string;
    },
    keepalive = false,
  ) => call<AskHanded>("POST", `${cardPath(cardRef, askId)}/hand`, { body: input, keepalive }),
  /**
   * Hands several asks over at once. An ask that can't be handed does not stop
   * the rest; `always` with words that are too long is refused whole.
   */
  handBatch: (
    items: ReadonlyArray<AskBatchItem>,
    input: { readonly always?: boolean; readonly text?: string },
    keepalive = false,
  ) =>
    call<AskHandBatchResult>("POST", "/asks/hand", {
      body: { ...input, items: items.map(({ card, askId }) => ({ card, askId })) },
      keepalive,
    }),
  /** Puts an ask away until a time; `null` brings it back. */
  snooze: (cardRef: string, askId: string, until: string | null) =>
    call<AskAnswered>("POST", `${cardPath(cardRef, askId)}/snooze`, { body: { until } }),
  snoozeBatch: (items: ReadonlyArray<AskBatchItem>, until: string | null) =>
    call<{ readonly snoozed: number; readonly results: AskBatchResult["results"] }>(
      "POST",
      "/asks/snooze",
      { body: { until, items: items.map(({ card, askId }) => ({ card, askId })) } },
    ),
  /** One discussion message with its big blocks whole. */
  message: (discussionId: string, seq: number) =>
    call<KanbanMessage>("GET", `/discussions/${encodeURIComponent(discussionId)}/messages/${seq}`),
};
