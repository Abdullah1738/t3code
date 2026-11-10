/**
 * The ask routes under `/api/ardud/kanban`, called over HTTP with the web
 * session (cookie, or the connection's bearer token). The rest of the board UI
 * talks over the socket; asks have these routes instead.
 */
import type { AskAnswerBody } from "@t3tools/client-runtime/ardud/kanban";
import type { KanbanAskFeed, KanbanBlock, KanbanMessage, KanbanOwnerAsk } from "@t3tools/contracts";

import { appAtomRegistry } from "../../../rpc/atomRegistry";
import { primaryEnvironmentIdAtom } from "../../../state/primaryEnvironment";
import { readPreparedConnection } from "../../../state/session";

const PREFIX = "/api/ardud/kanban";

/** A refused or failed call. `status` 0 means the request never got an answer. */
export class AskApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "AskApiError";
    this.status = status;
    this.code = code;
  }
  /** The ask changed or closed since it was read. */
  get stale(): boolean {
    return this.status === 409;
  }
}

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
    const error = (json as { error?: { code?: unknown; message?: unknown } } | null)?.error;
    throw new AskApiError(
      response.status,
      typeof error?.code === "string" ? error.code : "failed",
      typeof error?.message === "string" ? error.message : `Robob answered ${response.status}.`,
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
  readonly revision?: number;
}

export interface AskBatchResult {
  readonly answered: number;
  readonly results: ReadonlyArray<
    | { readonly card: string; readonly askId: string; readonly ok: true; readonly stage: string }
    | {
        readonly card: string;
        readonly askId: string;
        readonly ok: false;
        readonly error: { readonly code: string; readonly message: string };
      }
  >;
}

export interface AskHanded extends AskAnswered {
  readonly evaluator?: {
    readonly started: boolean;
    readonly threadId: string | null;
    readonly error: string | null;
  };
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
  answer: (cardRef: string, askId: string, body: AskAnswerBody, keepalive = false) =>
    call<AskAnswered>("POST", `${cardPath(cardRef, askId)}/answer`, { body, keepalive }),
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
