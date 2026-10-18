/**
 * The iMessage bridge relays what the owner (or Moni) typed. It runs on its
 * own `spectrum-bridge` component credential, and a control send or answer
 * from it speaks for the owner only when it names an inbound iMessage that
 * verifies through asks' read-only lookup: a real message from the owner's or
 * Moni's chat, whose exact text the write carries, claimed by this one place.
 * Anything less, and every other credential (Telegram's included), stays a
 * system session that the send guard judges as such.
 */
import type {
  MissionProvenance,
  OrchestrationV2TurnItem,
  ProviderApprovalDecision,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as SqlClient from "effect/sql/SqlClient";

import * as Inbound from "../asks/inbound.ts";
import { verifyInbound, type ReplyCheck } from "../asks/provenance.ts";
import type { OriginSession } from "../core/provenance.ts";

/** The component credential the iMessage bridge runs on. */
export const IMESSAGE_BRIDGE = "spectrum-bridge";

export type OwnerIMessage = Extract<MissionProvenance, { _tag: "owner-imessage" }>;

/**
 * How long after the owner typed it a message may still be relayed as his.
 * The bridge holds messages while the thread is busy, so a turn may run a
 * while before it relays; later than this, it speaks as itself.
 */
const RELAY_WINDOW_MINUTES = 60;

/** Inbound rows whose text the bridge composed (a poll vote names agent-written options). */
const BRIDGE_COMPOSED = ["poll-vote:"];

const asTyped = (text: string) => text.normalize("NFC").replace(/\s+/g, " ").trim();

/**
 * A relayed message is exactly what he typed. Channel guidance, a quoted
 * message, a batch of several messages or a rewritten `/context` reply are
 * not his words, so the bridge sends those as itself.
 */
export const relayCheck =
  (text: string): ReplyCheck =>
  ({ raw }) =>
    asTyped(text) === asTyped(raw) ? null : "match the relayed text exactly";

// The bridge's own yes/no reading of a short reply (see its router `decide`).
const YES = new Set([
  "y",
  "yes",
  "yeah",
  "yea",
  "ya",
  "yep",
  "yup",
  "sure",
  "ok",
  "okay",
  "k",
  "go",
  "do",
  "approve",
  "approved",
  "once",
  "allow",
  "allowed",
  "fine",
  "alright",
  "good",
]);
const NO = new Set([
  "n",
  "no",
  "nope",
  "nah",
  "dont",
  "stop",
  "reject",
  "rejected",
  "deny",
  "denied",
  "cancel",
  "never",
]);
const FILLER = new Set([
  "please",
  "pls",
  "thanks",
  "thank",
  "you",
  "ahead",
  "it",
  "for",
  "that",
  "thats",
  "is",
  "sounds",
  "go",
  "just",
]);

const saysOnly = (words: ReadonlyArray<string>, core: ReadonlySet<string>) =>
  words.length <= 6 &&
  words.some((word) => core.has(word)) &&
  words.every((word) => core.has(word) || FILLER.has(word));

/** The choice a reply names, read the way the bridge reads it: a label, a 1-based number, several of them, or free text. */
const readChoice = (raw: string, options: ReadonlyArray<string>): ReadonlyArray<string> => {
  const text = asTyped(raw);
  const byLabel = (part: string) =>
    options.find((option) => option.toLowerCase() === part.toLowerCase());
  const byNumber = (part: string) => {
    const match = /^(\d+)[.)]?$/.exec(part);
    return match === null ? undefined : options[Number(match[1]) - 1];
  };
  const whole = byLabel(text) ?? byNumber(text);
  if (whole !== undefined) return [whole];
  const parts = text.split(/\s*(?:,|\band\b|&|\s)\s*/i).filter((part) => part.length > 0);
  if (parts.length > 1) {
    const picked = parts.map((part) => byNumber(part) ?? byLabel(part));
    if (picked.every((label) => label !== undefined)) return [...new Set(picked)];
  }
  return [text];
};

const sameChoice = (left: ReadonlyArray<string>, right: ReadonlyArray<string>) => {
  const a = new Set(left.map(asTyped));
  const b = new Set(right.map(asTyped));
  return a.size === b.size && [...a].every((value) => b.has(value));
};

/**
 * What an iMessage must be to answer a pending request: only yes words to
 * approve once, only no words to decline or dismiss, and for a question the
 * one answer being recorded. A broader grant ("always") is confirmed in the
 * app.
 */
export const answerReplyCheck =
  (input: {
    readonly decision: ProviderApprovalDecision | undefined;
    readonly answers: Readonly<Record<string, unknown>> | undefined;
    readonly dismissed: boolean;
    /** The request's questions, by id, with their option labels. */
    readonly questions: ReadonlyArray<{
      readonly id: string;
      readonly options: ReadonlyArray<string>;
    }>;
  }): ReplyCheck =>
  ({ raw, words }) => {
    if (input.dismissed || input.decision === "decline" || input.decision === "cancel") {
      return saysOnly(words, NO) ? null : "say only no";
    }
    if (input.decision === "accept") return saysOnly(words, YES) ? null : "say only yes";
    if (input.decision !== undefined) return "approve only once";
    // One iMessage answers one question, and the request must have only that one.
    const [question, ...otherQuestions] = input.questions;
    const entries = Object.entries(input.answers ?? {});
    const [entry, ...otherEntries] = entries;
    if (
      question === undefined ||
      otherQuestions.length > 0 ||
      entry === undefined ||
      otherEntries.length > 0 ||
      entry[0] !== question.id
    ) {
      return "answer a request's only question";
    }
    const value = entry[1];
    const wanted =
      typeof value === "string"
        ? [value]
        : Array.isArray(value) && value.every((item) => typeof item === "string")
          ? (value as ReadonlyArray<string>)
          : [];
    if (wanted.length === 0) return "carry an answer";
    return sameChoice(readChoice(raw, question.options), wanted)
      ? null
      : "carry exactly the answer";
  };

const CLAIMS_DDL = `CREATE TABLE IF NOT EXISTS ardud_mission_guard_inbound_claims (
  inbound_id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  claimed_at TEXT NOT NULL
)`;

/**
 * One inbound speaks for the owner in one place: the first thread (or
 * request) it is used for. The bridge resending it there still counts; using
 * it anywhere else does not.
 */
const claimInbound = (sql: SqlClient.SqlClient, inboundId: string, subject: string) =>
  Effect.gen(function* () {
    yield* sql.unsafe(CLAIMS_DDL);
    const claimedAt = DateTime.formatIso(yield* DateTime.now);
    yield* sql`
      INSERT INTO ardud_mission_guard_inbound_claims (inbound_id, subject, claimed_at)
      VALUES (${inboundId}, ${subject}, ${claimedAt})
      ON CONFLICT (inbound_id) DO NOTHING
    `;
    const rows = yield* sql<{ readonly subject: string }>`
      SELECT subject FROM ardud_mission_guard_inbound_claims WHERE inbound_id = ${inboundId}
    `;
    return rows[0]?.subject === subject;
  });

interface Claim {
  readonly session: OriginSession;
  readonly inboundId: string | undefined;
  readonly threadId: string;
}

/**
 * The owner provenance a bridge write carries, or null when it speaks as
 * itself. Built once from the services present: asks' lookup when the server
 * provides one (else the real read-only sources on this Mac, opened on first
 * use) and the app database for claims (without one nothing verifies).
 */
export const optionalIMessageOwner = Effect.gen(function* () {
  const provided = yield* Effect.serviceOption(Inbound.InboundLookup);
  const database = yield* Effect.serviceOption(SqlClient.SqlClient);
  let fallback: ReturnType<typeof Inbound.makeInboundLookup> | undefined;
  const lookup = () =>
    Option.getOrElse(
      provided,
      () => (fallback ??= Inbound.makeInboundLookup(Inbound.defaultInboundSources())),
    );

  const verify = (
    claim: Claim & { readonly subject: string },
    command: () => {
      readonly notBefore: string;
      readonly skewMs: number | undefined;
      readonly check: ReplyCheck;
      readonly what: string;
    },
  ): Effect.Effect<OwnerIMessage | null> => {
    const origin = claim.session.origin;
    const inboundId = claim.inboundId;
    if (
      origin?._tag !== "component" ||
      origin.component !== IMESSAGE_BRIDGE ||
      inboundId === undefined ||
      BRIDGE_COMPOSED.some((prefix) => inboundId.startsWith(prefix)) ||
      Option.isNone(database)
    ) {
      return Effect.succeed(null);
    }
    return Effect.gen(function* () {
      const { notBefore, skewMs, check, what } = command();
      const inbound = yield* lookup().find(inboundId, notBefore);
      const verified = verifyInbound({
        inboundId,
        inbound,
        notBefore,
        check,
        what,
        ...(skewMs === undefined ? {} : { skewMs }),
      });
      if (Result.isFailure(verified)) {
        yield* Effect.logInfo(
          "missions guard: iMessage not verified, the bridge speaks as itself",
          {
            inboundId,
            detail: verified.failure.detail,
          },
        );
        return null;
      }
      if (!(yield* claimInbound(database.value, inboundId, claim.subject))) {
        yield* Effect.logInfo("missions guard: iMessage already spoke for another write", {
          inboundId,
        });
        return null;
      }
      return verified.success;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("missions guard: could not verify an iMessage", {
          inboundId,
          cause,
        }).pipe(Effect.as(null)),
      ),
    );
  };

  return {
    /**
     * A message relayed into a thread: his text alone, with nothing attached
     * and no restart of the running turn.
     */
    relay: (
      claim: Claim & {
        readonly text: string;
        readonly attachments: number;
        readonly mode: string | undefined;
      },
    ) =>
      claim.attachments > 0 || (claim.mode !== undefined && claim.mode !== "auto")
        ? Effect.succeed(null)
        : DateTime.now.pipe(
            Effect.flatMap((now) =>
              verify({ ...claim, subject: `thread:${claim.threadId}` }, () => ({
                notBefore: DateTime.formatIso(
                  DateTime.subtract(now, { minutes: RELAY_WINDOW_MINUTES }),
                ),
                skewMs: undefined,
                check: relayCheck(claim.text),
                what: "A relayed message",
              })),
            ),
          ),
    /**
     * An answer to a pending request. The reply must come after the request
     * opened, with no slack, and within the relay window. Nothing ties it to
     * this request beyond that and its claim (see the guard notes).
     */
    answer: (
      claim: Claim & {
        readonly requestId: string;
        readonly askedAt: DateTime.DateTime;
        readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
        readonly decision: ProviderApprovalDecision | undefined;
        readonly answers: Readonly<Record<string, unknown>> | undefined;
        readonly dismissed: boolean;
      },
    ) =>
      DateTime.now.pipe(
        Effect.flatMap((now) =>
          verify({ ...claim, subject: `request:${claim.threadId}:${claim.requestId}` }, () => {
            const questions = claim.turnItems.flatMap((item) =>
              item.type === "user_input_request" && item.requestId === claim.requestId
                ? item.questions
                : [],
            );
            return {
              notBefore: DateTime.formatIso(
                DateTime.max(
                  claim.askedAt,
                  DateTime.subtract(now, { minutes: RELAY_WINDOW_MINUTES }),
                ),
              ),
              skewMs: 0,
              check: answerReplyCheck({
                decision: claim.decision,
                answers: claim.answers,
                dismissed: claim.dismissed,
                questions: questions.map((question) => ({
                  id: question.id,
                  options: question.options.map((option) => option.label),
                })),
              }),
              what: "An answer",
            };
          }),
        ),
      ),
  };
});

export type IMessageOwner = Effect.Success<typeof optionalIMessageOwner>;
