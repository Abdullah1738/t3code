/**
 * One ledger for every write an iMessage of the owner's drives, whichever
 * route carries it: the bridge's control sends and answers, and the desk
 * routes the mission CLI calls (ask answers, draft decisions, approvals, call
 * reactions, owner requests).
 *
 * A write names the inbound, the record it acts on (`subject`) and what it
 * does there (`action`). The first one claims that key before it runs and
 * records its result when it finishes; a retry with the same payload gets
 * that result back instead of acting again, and a different payload under
 * the same key is refused. One iMessage may still drive actions on different
 * records ("approve both"). A failed run gives the claim back, and a claim
 * left by a run that died is taken over after a minute.
 *
 * Only the iMessage bridge and the mission CLI may redeem an inbound at all;
 * every other caller is refused before anything is looked up or claimed.
 */
import { MissionError, type MissionProvenance } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as Inbound from "../asks/inbound.ts";
import {
  redeemerRefusal,
  verifyInbound,
  type InboundMessage,
  type OwnerIMessage,
} from "../asks/provenance.ts";

const ACTIONS_DDL = `CREATE TABLE IF NOT EXISTS ardud_mission_guard_inbound_actions (
  inbound_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  action TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  command_id TEXT,
  chat TEXT NOT NULL,
  quote TEXT,
  result_json TEXT,
  claimed_at TEXT NOT NULL,
  bridge_chat TEXT,
  PRIMARY KEY (inbound_id, subject, action)
)`;

/**
 * Tables made before `bridge_chat` existed get it added in place; the table is
 * created on use, outside the numbered migrations.
 */
const ensureActionsTable = Effect.fn("InboundLedger.ensureActionsTable")(function* (
  sql: SqlClient.SqlClient,
) {
  yield* sql.unsafe(ACTIONS_DDL);
  const hasBridgeChat = sql<{ readonly name: string }>`
    SELECT name FROM pragma_table_info('ardud_mission_guard_inbound_actions')
  `.pipe(Effect.map((columns) => columns.some((column) => column.name === "bridge_chat")));
  if (yield* hasBridgeChat) return;
  yield* sql
    .unsafe("ALTER TABLE ardud_mission_guard_inbound_actions ADD COLUMN bridge_chat TEXT")
    .pipe(
      // Another redeem may have added it between the check and here.
      Effect.catchTags({
        SqlError: (error) =>
          hasBridgeChat.pipe(Effect.flatMap((added) => (added ? Effect.void : Effect.fail(error)))),
      }),
    );
});

/** How long an unfinished claim holds before another attempt may take it over. */
export const STALE_CLAIM_MS = 60_000;

interface ActionRow {
  readonly payloadJson: string;
  readonly commandId: string | null;
  readonly chat: string;
  readonly quote: string | null;
  readonly bridgeChat: string | null;
  readonly resultJson: string | null;
  readonly claimedAt: string;
}

export interface InboundAttempt {
  /** Who redeems the inbound: the session's component, or the control token. */
  readonly caller: MissionProvenance;
  readonly inboundId: string;
  /** The record acted on, e.g. `ask:ask-1` or `thread:t-1`. */
  readonly subject: string;
  /** What is done there, e.g. `answer` or `relay`. */
  readonly action: string;
  /** What exactly is done; a retry must repeat it. */
  readonly payload: unknown;
  /** The command a fresh run uses; a replay gets the first run's. */
  readonly commandId?: string | undefined;
  readonly what: string;
  /** When the record (or its revision) opened, and the skew allowed before it. */
  readonly notBefore: () => Effect.Effect<
    { readonly at: string; readonly skewMs?: number | undefined },
    MissionError
  >;
  /** Null when the message fits this write; otherwise why not. Runs before the claim. */
  readonly fits?: (inbound: InboundMessage) => string | null;
  /** Only return what an earlier attempt recorded; never verify or claim anew. */
  readonly replayOnly?: boolean;
}

export type Redeemed =
  | {
      readonly _tag: "replay";
      readonly provenance: OwnerIMessage;
      readonly commandId: string | null;
      readonly result: unknown;
    }
  | {
      /** `fresh`: this attempt claimed it. `running`: an earlier attempt holds it, unfinished. */
      readonly _tag: "fresh" | "running";
      readonly provenance: OwnerIMessage;
      readonly commandId: string | null;
      /** Records what the run answered, so a retry returns it. */
      readonly finish: (result: unknown) => Effect.Effect<void>;
      /** Gives the claim back after a failed run. */
      readonly release: Effect.Effect<void>;
    };

const refused = (code: MissionError["code"], detail: string) => new MissionError({ code, detail });

const parse = (json: string | null): unknown => {
  if (json === null) return null;
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return null;
  }
};

const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, inner: unknown) =>
    inner !== null && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(
          Object.entries(inner as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
        )
      : inner,
  ) ?? "null";

const provenanceOf = (inboundId: string, row: ActionRow): OwnerIMessage => ({
  _tag: "owner-imessage",
  chat: row.chat === "moni" ? "moni" : "owner",
  inboundId,
  ...(row.quote === null ? {} : { quote: row.quote }),
  ...(row.bridgeChat === null ? {} : { bridgeChat: row.bridgeChat }),
});

/**
 * The ledger over the app database and asks' read-only lookup (else the real
 * sources on this Mac, opened on first use). Without a database nothing
 * redeems.
 */
export const inboundLedger = Effect.gen(function* () {
  const provided = yield* Effect.serviceOption(Inbound.InboundLookup);
  const database = yield* Effect.serviceOption(SqlClient.SqlClient);
  let fallback: ReturnType<typeof Inbound.makeInboundLookup> | undefined;
  const lookup = () =>
    Option.getOrElse(
      provided,
      () => (fallback ??= Inbound.makeInboundLookup(Inbound.defaultInboundSources())),
    );

  const redeem = (attempt: InboundAttempt): Effect.Effect<Redeemed, MissionError> =>
    Effect.gen(function* () {
      const notRedeemer = redeemerRefusal<never>(attempt.caller, attempt.what);
      if (notRedeemer !== null) return yield* Effect.fromResult(notRedeemer);
      if (Option.isNone(database)) {
        return yield* refused("forbidden", `${attempt.what} by iMessage needs the app database.`);
      }
      const sql = database.value;
      const { inboundId, subject, action } = attempt;
      const payloadJson = canonical(attempt.payload);
      const row = () =>
        sql<ActionRow>`
          SELECT payload_json AS "payloadJson", command_id AS "commandId", chat, quote,
            bridge_chat AS "bridgeChat", result_json AS "resultJson", claimed_at AS "claimedAt"
          FROM ardud_mission_guard_inbound_actions
          WHERE inbound_id = ${inboundId} AND subject = ${subject} AND action = ${action}
        `.pipe(Effect.map((rows) => rows[0] ?? null));
      const fresh = (claimed: ActionRow, tag: "fresh" | "running" = "fresh"): Redeemed => ({
        _tag: tag,
        provenance: provenanceOf(inboundId, claimed),
        commandId: claimed.commandId,
        finish: (result) =>
          sql`
            UPDATE ardud_mission_guard_inbound_actions SET result_json = ${canonical(result)}
            WHERE inbound_id = ${inboundId} AND subject = ${subject} AND action = ${action}
              AND result_json IS NULL
          `.pipe(
            Effect.asVoid,
            Effect.catchCause((cause) =>
              Effect.logWarning("missions guard: could not record an iMessage action's result", {
                inboundId,
                subject,
                cause,
              }),
            ),
          ),
        release: sql`
          DELETE FROM ardud_mission_guard_inbound_actions
          WHERE inbound_id = ${inboundId} AND subject = ${subject} AND action = ${action}
            AND result_json IS NULL
        `.pipe(
          Effect.asVoid,
          Effect.catchCause((cause) =>
            Effect.logWarning("missions guard: could not release an iMessage claim", {
              inboundId,
              subject,
              cause,
            }),
          ),
        ),
      });

      yield* ensureActionsTable(sql);
      const now = yield* DateTime.now;
      const nowIso = DateTime.formatIso(now);
      const known = yield* row();
      if (known !== null) {
        if (known.payloadJson !== payloadJson) {
          return yield* refused(
            "conflict",
            `iMessage ${inboundId} already did something else here (${subject}); it does not act again.`,
          );
        }
        if (known.resultJson !== null) {
          const replay: Redeemed = {
            _tag: "replay",
            provenance: provenanceOf(inboundId, known),
            commandId: known.commandId,
            result: parse(known.resultJson),
          };
          return replay;
        }
        const age = DateTime.toEpochMillis(now) - Date.parse(known.claimedAt);
        if (!(age > STALE_CLAIM_MS)) return fresh(known, "running");
        const taken = yield* sql<{ readonly inboundId: string }>`
          UPDATE ardud_mission_guard_inbound_actions SET claimed_at = ${nowIso}
          WHERE inbound_id = ${inboundId} AND subject = ${subject} AND action = ${action}
            AND result_json IS NULL AND claimed_at = ${known.claimedAt}
          RETURNING inbound_id AS "inboundId"
        `;
        if (taken.length === 0) {
          return yield* refused(
            "conflict",
            `iMessage ${inboundId} is already being acted on here (${subject}); retry shortly.`,
          );
        }
        return fresh({ ...known, claimedAt: nowIso });
      }

      if (attempt.replayOnly === true) {
        return yield* refused(
          "conflict",
          `iMessage ${inboundId} recorded nothing here (${subject}).`,
        );
      }
      const window = yield* attempt.notBefore();
      const inbound = yield* lookup().find(inboundId, window.at);
      const verified = yield* Effect.fromResult(
        verifyInbound({
          caller: attempt.caller,
          inboundId,
          inbound,
          notBefore: window.at,
          what: attempt.what,
          ...(window.skewMs === undefined ? {} : { skewMs: window.skewMs }),
        }),
      );
      const misfit = inbound === null ? null : (attempt.fits?.(inbound) ?? null);
      if (misfit !== null) {
        return yield* refused("provenance-invalid", `iMessage ${inboundId} does not ${misfit}.`);
      }
      const claimed = yield* sql<{ readonly inboundId: string }>`
        INSERT INTO ardud_mission_guard_inbound_actions
          (inbound_id, subject, action, payload_json, command_id, chat, quote, bridge_chat,
            claimed_at)
        VALUES (${inboundId}, ${subject}, ${action}, ${payloadJson}, ${attempt.commandId ?? null},
          ${verified.chat}, ${verified.quote ?? null}, ${verified.bridgeChat ?? null}, ${nowIso})
        ON CONFLICT (inbound_id, subject, action) DO NOTHING
        RETURNING inbound_id AS "inboundId"
      `;
      if (claimed.length === 0) {
        return yield* refused(
          "conflict",
          `iMessage ${inboundId} is already being acted on here (${subject}); retry shortly.`,
        );
      }
      return fresh({
        payloadJson,
        commandId: attempt.commandId ?? null,
        chat: verified.chat,
        quote: verified.quote ?? null,
        bridgeChat: verified.bridgeChat ?? null,
        resultJson: null,
        claimedAt: nowIso,
      });
    }).pipe(
      Effect.catchTags({
        SqlError: (cause) =>
          Effect.logWarning("missions guard: iMessage ledger failed", { cause }).pipe(
            Effect.andThen(
              Effect.fail(
                refused("conflict", `${attempt.what} by iMessage could not be recorded.`),
              ),
            ),
          ),
      }),
    );

  /**
   * Runs one owner write for an iMessage at most once: the first run's
   * result, recorded, is what every retry of the same write returns.
   */
  const once = <A, E, R>(
    attempt: InboundAttempt,
    run: (owner: OwnerIMessage) => Effect.Effect<A, E, R>,
  ): Effect.Effect<unknown, E | MissionError, R> =>
    Effect.gen(function* () {
      const redeemed = yield* redeem(attempt);
      if (redeemed._tag === "replay") return redeemed.result;
      if (redeemed._tag === "running") {
        return yield* refused(
          "conflict",
          `iMessage ${attempt.inboundId} is already being acted on here (${attempt.subject}); retry shortly.`,
        );
      }
      return yield* run(redeemed.provenance).pipe(
        Effect.onExit((exit) =>
          Exit.isSuccess(exit) ? redeemed.finish(exit.value) : redeemed.release,
        ),
      );
    });

  return { redeem, once };
});

export type InboundLedger = Effect.Success<typeof inboundLedger>;
