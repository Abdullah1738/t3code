/**
 * An ask with secret fields. The values never enter a form, a store or an undo
 * queue: the page holds them in one component and hands them here only to build
 * the one call that carries them (WS `secrets.answerAsk`). Pure.
 */
import {
  KANBAN_ASK_SECRET_PROVIDED,
  kanbanAskResponse,
  type KanbanOwnerAsk,
} from "@t3tools/contracts";

import { askFieldKind, type AskAnswerBody, type AskForm } from "./askAnswer.ts";

/** Secret values as typed, by field id. Component state only. */
export type AskSecrets = Readonly<Record<string, string>>;

export const askSecretFieldIds = (ask: KanbanOwnerAsk): ReadonlyArray<string> =>
  kanbanAskResponse(ask)
    .fields.filter((field) => askFieldKind(field) === "secret")
    .map((field) => field.id);

const typed = (secrets: AskSecrets, id: string): boolean => (secrets[id] ?? "").trim() !== "";

/**
 * The form as the answer builder should see it: a secret field reads "provided"
 * when he has typed one, so a required secret is checked like any other field
 * while its value stays out of the form.
 */
export function askFormWithSecrets(
  ask: KanbanOwnerAsk,
  form: AskForm,
  secrets: AskSecrets,
): AskForm {
  const ids = askSecretFieldIds(ask);
  if (ids.length === 0) return form;
  const values: Record<string, unknown> = { ...form.values };
  for (const id of ids) values[id] = typed(secrets, id) ? KANBAN_ASK_SECRET_PROVIDED : undefined;
  return { ...form, values };
}

export interface AskSecretAnswerInput {
  readonly cardId: string;
  readonly askId: string;
  readonly answer: AskAnswerBody;
  readonly secrets: Record<string, string>;
}

/**
 * The one call for an answer that carries secrets: the answer without its
 * secret fields, and the values beside it. Null when no secret was typed (a
 * refusal, or an optional secret left empty): that answer goes the usual way.
 */
export function askSecretAnswerInput(
  cardId: string,
  ask: KanbanOwnerAsk,
  body: AskAnswerBody,
  secrets: AskSecrets,
): AskSecretAnswerInput | null {
  const ids = askSecretFieldIds(ask).filter((id) => typed(secrets, id));
  if (ids.length === 0) return null;
  const { values, ...rest } = askBodyWithoutSecrets(ask, body);
  return {
    cardId,
    askId: ask.id,
    answer: { ...rest, ...(values === undefined ? {} : { values }) },
    secrets: Object.fromEntries(ids.map((id) => [id, secrets[id]!])),
  };
}

/** The answer body with every secret field taken out of `values`. */
export function askBodyWithoutSecrets(ask: KanbanOwnerAsk, body: AskAnswerBody): AskAnswerBody {
  if (body.values === undefined) return body;
  const secret = new Set(askSecretFieldIds(ask));
  const kept = Object.entries(body.values).filter(([id]) => !secret.has(id));
  const { values: _values, ...rest } = body;
  return kept.length === 0 ? rest : { ...rest, values: Object.fromEntries(kept) };
}

export interface AskSecretFailure {
  /** What to show. Never built from the request, so a typed value can't surface. */
  readonly message: string;
  /** The ask changed or closed since he read it. */
  readonly stale: boolean;
  /** The field the server named, when it named one. */
  readonly field: string | null;
  /**
   * This session is not the owner's own, so sending again from here can't
   * work. `device`: it is a paired device that has to be paired again.
   */
  readonly notOwner?: { readonly device: boolean };
}

const tagOf = (failure: unknown): string | null =>
  typeof failure === "object" &&
  failure !== null &&
  "_tag" in failure &&
  typeof failure._tag === "string"
    ? failure._tag
    : null;

/**
 * What the server tells a paired device that is not the owner's. The page
 * shows the same sentence up front when the session says it is not his.
 */
export const ASK_NOT_OWNER_DEVICE_TEXT =
  "This device isn't paired as yours. Pair it again from Settings > Connections in the Robob desktop app.";

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

/** A refused secret answer, in the server's words where it gave any. */
export function askSecretFailure(failure: unknown): AskSecretFailure {
  const tag = tagOf(failure);
  if (tag === "EnvironmentAuthorizationError") {
    // A component's or a hand-issued token: not his session, and not a device to pair again.
    return {
      message: text((failure as { message?: unknown }).message) || "Only the owner answers this.",
      stale: false,
      field: null,
      notOwner: { device: false },
    };
  }
  if (tag === "KanbanError") {
    const { code, detail, reason, revision } = failure as {
      code?: unknown;
      detail?: unknown;
      reason?: unknown;
      revision?: unknown;
    };
    const said = text(detail);
    if (code === "denied") {
      return {
        message: said || "Only the owner answers this.",
        stale: false,
        field: null,
        notOwner: { device: reason === "not_owner_device" },
      };
    }
    // A refusal that carries the revision the ask is at means the one he read is gone.
    if (code === "conflict" || code === "not-found" || typeof revision === "number") {
      return {
        message: "It changed while you were answering. Type the secret again.",
        stale: true,
        field: null,
      };
    }
    return {
      message:
        said === ""
          ? "The answer was refused."
          : `${said.charAt(0).toUpperCase()}${said.slice(1)}.`,
      stale: false,
      field: /field "([^"]+)"/.exec(said)?.[1] ?? null,
    };
  }
  if (tag === "SecretRequestError") {
    const message = (failure as { message?: unknown }).message;
    return {
      message:
        typeof message === "string" && message.trim() !== ""
          ? message
          : "The secret could not be kept. Type it again.",
      stale: false,
      field: null,
    };
  }
  return { message: "Not sent. Type the secret again.", stale: false, field: null };
}
