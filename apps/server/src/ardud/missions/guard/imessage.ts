/**
 * The iMessage bridge relays what the owner (or Moni) typed. It runs on its
 * own `spectrum-bridge` component credential, and a control send or answer
 * from it speaks for the owner only when it names an inbound iMessage that
 * verifies through asks' read-only lookup (a real message he typed, whose
 * exact text the write carries) and that iMessage is tied to this one place:
 *
 * - an answer to a runtime request is a swipe-reply to the notification the
 *   bridge delivered for that request, or a plain reply while that is the only
 *   open request notification in the chat;
 * - a message to a mission thread starts with that mission's slug. The title
 *   does not count: a master can rename its mission to anything.
 *
 * The tie comes from the bridge's own delivery ledger and the mission store,
 * never from the destination the caller picked. A request notification ties
 * a reply to that one decision only, never to a message. One iMessage is one owner
 * action: the first write records it with its command, and a retry of that
 * same action returns the recorded result instead of acting again. Anything
 * less, and every other credential (Telegram's included), stays a system
 * session that the send guard judges as such.
 */
import type {
  MissionError,
  MissionId,
  MissionProvenance,
  OrchestrationV2TurnItem,
  ProviderApprovalDecision,
} from "@t3tools/contracts";
import { ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as SqlClient from "effect/sql/SqlClient";

import * as Inbound from "../asks/inbound.ts";
import {
  consentCheck,
  verifyInbound,
  type InboundMessage,
  type ReplyCheck,
} from "../asks/provenance.ts";
import type { OriginSession } from "../core/provenance.ts";
import { checkSend } from "../router/guardHook.ts";
import type { SendSender } from "../router/model.ts";
import * as MissionStore from "../store/MissionStore.ts";
import * as Notices from "./notices.ts";

/** The component credential the iMessage bridge runs on. */
export const IMESSAGE_BRIDGE = "spectrum-bridge";

export type OwnerIMessage = Extract<MissionProvenance, { _tag: "owner-imessage" }>;

/** The notice kind the bridge records for a runtime request it asked the owner about. */
export const RUNTIME_REQUEST_NOTICE = "runtime-request";

/**
 * How long after the owner typed it a message may still be relayed as his.
 * The bridge holds messages while the thread is busy, so a turn may run a
 * while before it relays; later than this, it speaks as itself.
 */
const RELAY_WINDOW_MINUTES = 60;

/** How far back delivered request notifications count as possibly still open. */
const OPEN_NOTICE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

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
 * What an iMessage must be to answer a pending request: the short consent
 * grammar (only yes to approve once, only no to decline or dismiss, no
 * question mark or anything else), and for a question the one answer being
 * recorded. A broader grant ("always") is confirmed in the app.
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
  (reply) => {
    if (input.dismissed || input.decision === "decline" || input.decision === "cancel") {
      return consentCheck("no")(reply);
    }
    if (input.decision === "accept") return consentCheck("yes")(reply);
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
    return sameChoice(readChoice(reply.raw, question.options), wanted)
      ? null
      : "carry exactly the answer";
  };

/** Whether a control session is the iMessage bridge's own credential. */
export const isBridgeSession = (session: OriginSession) =>
  session.origin?._tag === "component" && session.origin.component === IMESSAGE_BRIDGE;

/**
 * The slug the text addresses: its first word, optionally `#`-prefixed and
 * followed by `:` or other punctuation (`m-1 ship it`, `#m-1: ship it`).
 * Null unless exactly one of the slugs matches.
 */
export const addressedSlug = (raw: string, slugs: ReadonlyArray<string>) => {
  const said = raw.normalize("NFKC").trimStart().replace(/^#/, "").toLowerCase();
  const matches = slugs.filter((slug) => {
    const key = slug.normalize("NFKC").trim().toLowerCase();
    return (
      key.length > 0 && said.startsWith(key) && /^(?:$|[\s:,;.!])/u.test(said.slice(key.length))
    );
  });
  return new Set(matches).size === 1 ? (matches[0] ?? null) : null;
};

/**
 * How the bridge's own ids look here. The control routes provide these from
 * the thread projections, so nothing the bridge sends names them.
 */
export interface BridgeSessions {
  /** The Robob thread for a bridge session id (a thread id, or a native `ses_` id); null when unknown. */
  readonly threadOf: (session: string) => Effect.Effect<string | null>;
  /**
   * Whether a runtime request was still pending at `at` (epoch ms): pending
   * now, or resolved after it. Unknown requests count as open.
   */
  readonly wasOpen: (threadId: string, requestId: string, at: number) => Effect.Effect<boolean>;
}

/** Who asks the router about a target's membership; only the target's mission matters. */
const MEMBERSHIP_PROBE: SendSender = {
  _tag: "session",
  sessionId: `component:${IMESSAGE_BRIDGE}`,
  subject: IMESSAGE_BRIDGE,
};

const ACTIONS_DDL = `CREATE TABLE IF NOT EXISTS ardud_mission_guard_inbound_actions (
  inbound_id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  action TEXT NOT NULL,
  command_id TEXT NOT NULL,
  chat TEXT NOT NULL,
  result_json TEXT,
  claimed_at TEXT NOT NULL
)`;

interface ActionRow {
  readonly subject: string;
  readonly action: string;
  readonly commandId: string;
  readonly chat: string;
  readonly resultJson: string | null;
}

/** An iMessage verified as one owner action, or the replay of the one it already was. */
export interface OwnerAction {
  readonly provenance: OwnerIMessage;
  /** The command the action runs as. A retry reuses the first attempt's. */
  readonly commandId: string;
  /** What the first attempt answered, once it finished; null until then. */
  readonly result: unknown;
  /** Records what the action answered, so a retry returns it. */
  readonly finish: (result: unknown) => Effect.Effect<void>;
}

interface Claim {
  readonly session: OriginSession;
  readonly inboundId: string | undefined;
  readonly threadId: string;
  /** The command id this attempt would run as. */
  readonly commandId: string;
  readonly sessions: BridgeSessions;
}

interface Attempt {
  /** The one place the iMessage speaks for: a thread, or a request on one. */
  readonly subject: string;
  /** What it does there, canonical, so a retry can be told from another use. */
  readonly action: string;
}

interface Proof {
  readonly notBefore: string;
  readonly skewMs?: number;
  readonly check: ReplyCheck;
  readonly what: string;
  /** Null when the iMessage is tied to this place; otherwise why not. */
  readonly bind: (inbound: InboundMessage) => Effect.Effect<string | null, MissionError>;
}

const parseResult = (json: string | null): unknown => {
  if (json === null) return null;
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return null;
  }
};

/**
 * The owner provenance a bridge write carries, or null when it speaks as
 * itself. Built once from the services present: asks' lookup and the
 * bridge's notice ledger when the server provides them (else the real
 * read-only sources on this Mac, opened on first use), the mission store, and
 * the app database for recorded actions (without one nothing verifies).
 */
export const optionalIMessageOwner = Effect.gen(function* () {
  const provided = yield* Effect.serviceOption(Inbound.InboundLookup);
  const providedLedger = yield* Effect.serviceOption(Notices.NoticeLedger);
  const missions = yield* Effect.serviceOption(MissionStore.MissionStore);
  const database = yield* Effect.serviceOption(SqlClient.SqlClient);
  let fallback: ReturnType<typeof Inbound.makeInboundLookup> | undefined;
  const lookup = () =>
    Option.getOrElse(
      provided,
      () => (fallback ??= Inbound.makeInboundLookup(Inbound.defaultInboundSources())),
    );
  let fallbackLedger: ReturnType<typeof Notices.makeNoticeLedger> | undefined;
  const ledger = () =>
    Option.getOrElse(
      providedLedger,
      () =>
        (fallbackLedger ??= Notices.makeNoticeLedger(
          Inbound.defaultInboundSources().bridgeDatabase,
        )),
    );

  const recorded = (sql: SqlClient.SqlClient, inboundId: string) =>
    sql<ActionRow>`
      SELECT subject, action, command_id AS "commandId", chat, result_json AS "resultJson"
      FROM ardud_mission_guard_inbound_actions WHERE inbound_id = ${inboundId}
    `.pipe(Effect.map((rows) => rows[0] ?? null));

  const toAction = (sql: SqlClient.SqlClient, inboundId: string, row: ActionRow): OwnerAction => ({
    provenance: {
      _tag: "owner-imessage",
      chat: row.chat === "moni" ? "moni" : "owner",
      inboundId,
    },
    commandId: row.commandId,
    result: parseResult(row.resultJson),
    finish: (result) =>
      sql`
        UPDATE ardud_mission_guard_inbound_actions SET result_json = ${JSON.stringify(result)}
        WHERE inbound_id = ${inboundId} AND result_json IS NULL
      `.pipe(
        Effect.asVoid,
        Effect.catchCause((cause) =>
          Effect.logWarning("missions guard: could not record an iMessage action's result", {
            inboundId,
            cause,
          }),
        ),
      ),
  });

  const act = (
    claim: Claim,
    attempt: Attempt,
    prove: () => Effect.Effect<Proof | null, MissionError>,
  ): Effect.Effect<OwnerAction | null> => {
    const inboundId = claim.inboundId;
    if (!isBridgeSession(claim.session) || inboundId === undefined || Option.isNone(database)) {
      return Effect.succeed(null);
    }
    const sql = database.value;
    const same = (row: ActionRow) =>
      row.subject === attempt.subject && row.action === attempt.action;
    return Effect.gen(function* () {
      yield* sql.unsafe(ACTIONS_DDL);
      const known = yield* recorded(sql, inboundId);
      if (known !== null) {
        if (same(known)) return toAction(sql, inboundId, known);
        yield* Effect.logInfo("missions guard: iMessage already spoke for another action", {
          inboundId,
        });
        return null;
      }
      const proof = yield* prove();
      if (proof === null) return null;
      const inbound = yield* lookup().find(inboundId, proof.notBefore);
      const verified = verifyInbound({
        inboundId,
        inbound,
        binding: { _tag: "tied" },
        notBefore: proof.notBefore,
        check: proof.check,
        what: proof.what,
        ...(proof.skewMs === undefined ? {} : { skewMs: proof.skewMs }),
      });
      if (Result.isFailure(verified) || inbound === null) {
        yield* Effect.logInfo(
          "missions guard: iMessage not verified, the bridge speaks as itself",
          {
            inboundId,
            detail: Result.isFailure(verified) ? verified.failure.detail : "not found",
          },
        );
        return null;
      }
      const unbound = yield* proof.bind(inbound);
      if (unbound !== null) {
        yield* Effect.logInfo(
          "missions guard: iMessage not addressed here, the bridge speaks as itself",
          { inboundId, detail: unbound },
        );
        return null;
      }
      const claimedAt = DateTime.formatIso(yield* DateTime.now);
      yield* sql`
        INSERT INTO ardud_mission_guard_inbound_actions
          (inbound_id, subject, action, command_id, chat, claimed_at)
        VALUES (${inboundId}, ${attempt.subject}, ${attempt.action}, ${claim.commandId},
          ${verified.success.chat}, ${claimedAt})
        ON CONFLICT (inbound_id) DO NOTHING
      `;
      const row = yield* recorded(sql, inboundId);
      if (row === null || !same(row)) {
        yield* Effect.logInfo("missions guard: iMessage already spoke for another action", {
          inboundId,
        });
        return null;
      }
      return toAction(sql, inboundId, row);
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("missions guard: could not verify an iMessage", {
          inboundId,
          cause,
        }).pipe(Effect.as(null)),
      ),
    );
  };

  /**
   * The missions a thread belongs to, as the router sees it (masters, lanes,
   * forks, added members and created children) plus the store's own records.
   * The router's check has no side effects; if it cannot answer, nothing binds.
   */
  const missionsOf = (store: MissionStore.MissionStore["Service"], threadId: string) =>
    Effect.gen(function* () {
      const target = ThreadId.make(threadId);
      const recorded = yield* store.missionsOfThread(target);
      const decision = yield* checkSend({
        path: "control-api",
        targetThreadId: target,
        from: MEMBERSHIP_PROBE,
      });
      const ids = new Set<MissionId>(recorded);
      if (decision._tag !== "not-member") ids.add(decision.missionId);
      return [...ids];
    });

  /**
   * A message to a mission thread is his there only when its first word is
   * that mission's slug. A thread outside every mission takes his exact words
   * as before. A swipe-reply to a request notification never counts here: it
   * answers that one decision.
   */
  const relayBinding =
    (store: MissionStore.MissionStore["Service"], claim: Claim) => (inbound: InboundMessage) =>
      Effect.gen(function* () {
        const targetMissions = yield* missionsOf(store, claim.threadId);
        if (targetMissions.length === 0) return null;
        const slugs: Array<string> = [];
        for (const missionId of targetMissions) {
          const mission = yield* store.get("mission", missionId);
          if (Option.isSome(mission)) slugs.push(mission.value.slug);
        }
        if (addressedSlug(inbound.text, slugs) !== null) return null;
        return `does not start with the mission's slug (${slugs.join(" or ") || "unknown"})`;
      });

  /**
   * An answer is tied to a request by the notification the bridge delivered
   * for it: a swipe-reply to that notification, or a plain reply while it is
   * the only request notification still open in the chat.
   */
  const requestBinding =
    (claim: Claim & { readonly requestId: string }) => (inbound: InboundMessage) =>
      Effect.gen(function* () {
        if (inbound.chat !== "owner")
          return "came from a chat the bridge sends no notifications to";
        const isTarget = (thread: string | null, recordId: string) =>
          thread === claim.threadId && recordId === claim.requestId;
        if (inbound.replyTo !== undefined) {
          const notice = yield* ledger().byGuid(inbound.replyTo);
          if (notice === null || notice.kind !== RUNTIME_REQUEST_NOTICE) {
            return "replies to something other than this request's notification";
          }
          const thread = yield* claim.sessions.threadOf(notice.session);
          return isTarget(thread, notice.recordId)
            ? null
            : "replies to another request's notification";
        }
        const sent = yield* ledger().sentBetween(
          inbound.receivedAt - OPEN_NOTICE_WINDOW_MS,
          inbound.receivedAt,
        );
        // Newest first, so the loop can stop once the answer is plain.
        const seen = new Set<string>();
        let open = 0;
        let targetOpen = false;
        for (const notice of [...sent].reverse()) {
          if (notice.kind !== RUNTIME_REQUEST_NOTICE) continue;
          const key = `${notice.session}\u0000${notice.recordId}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const thread = yield* claim.sessions.threadOf(notice.session);
          if (isTarget(thread, notice.recordId)) {
            targetOpen = true;
            open += 1;
          } else if (
            thread === null ||
            (yield* claim.sessions.wasOpen(thread, notice.recordId, inbound.receivedAt))
          ) {
            // Open when he typed, even if answered since.
            open += 1;
          }
          if (open > 1) break;
        }
        if (open > 1) {
          return "is a plain reply while more than one request notification is open; swipe-reply to the one it answers";
        }
        return targetOpen ? null : "answers no notification sent for this request";
      });

  return {
    /**
     * A message relayed into a thread: his text alone, with nothing attached
     * and no restart of the running turn, addressed to the thread's mission
     * when it has one.
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
        : act(
            claim,
            {
              subject: `thread:${claim.threadId}`,
              action: JSON.stringify({ text: asTyped(claim.text) }),
            },
            () =>
              Option.isNone(missions)
                ? Effect.succeed(null)
                : DateTime.now.pipe(
                    Effect.map((now): Proof => ({
                      notBefore: DateTime.formatIso(
                        DateTime.subtract(now, { minutes: RELAY_WINDOW_MINUTES }),
                      ),
                      check: relayCheck(claim.text),
                      what: "A relayed message",
                      bind: relayBinding(missions.value, claim),
                    })),
                  ),
          ),
    /**
     * An answer to a request. A new one verifies only while the request is
     * pending, after it opened (no slack) and within the relay window; a
     * request that already changed state only replays the recorded action.
     */
    answer: (
      claim: Claim & {
        readonly requestId: string;
        readonly open: boolean;
        readonly askedAt: DateTime.DateTime;
        readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
        readonly decision: ProviderApprovalDecision | undefined;
        readonly answers: Readonly<Record<string, unknown>> | undefined;
        readonly dismissed: boolean;
      },
    ) =>
      act(
        claim,
        {
          subject: `request:${claim.threadId}:${claim.requestId}`,
          action: JSON.stringify({
            decision: claim.decision ?? null,
            answers: claim.answers ?? null,
            dismissed: claim.dismissed,
          }),
        },
        () =>
          !claim.open
            ? Effect.succeed(null)
            : DateTime.now.pipe(
                Effect.map((now): Proof => {
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
                    bind: requestBinding(claim),
                  };
                }),
              ),
      ),
  };
});

export type IMessageOwner = Effect.Success<typeof optionalIMessageOwner>;
