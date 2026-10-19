// @effect-diagnostics nodeBuiltinImport:off - read-only lookups into the iMessage bridge's SQLite file.
/**
 * The owner notifications the iMessage bridge delivered, as its own send step
 * recorded them: one row per delivered message guid, naming the record it
 * asks about. The bridge writes the row in the same transaction that marks
 * the chunk delivered, so nothing a caller sends later can add or move one.
 * Read only here.
 */
import * as NodeFS from "node:fs";
import * as NodeSqlite from "node:sqlite";

import { MissionError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Inbound from "../asks/inbound.ts";

export interface OwnerNotice {
  /** The delivered iMessage guid a swipe-reply points at. */
  readonly guid: string;
  /** What the notice asks about. Only runtime requests are sent today. */
  readonly kind: string;
  /** The bridge's session for the record: a Robob thread id or a native `ses_` id. */
  readonly session: string;
  /** The record id, e.g. the runtime request id. */
  readonly recordId: string;
  /** Epoch milliseconds the bridge saw the send accepted. */
  readonly sentAt: number;
}

export class NoticeLedger extends Context.Service<
  NoticeLedger,
  {
    readonly byGuid: (guid: string) => Effect.Effect<OwnerNotice | null, MissionError>;
    /** Notices delivered in [from, to] epoch milliseconds. */
    readonly sentBetween: (
      from: number,
      to: number,
    ) => Effect.Effect<ReadonlyArray<OwnerNotice>, MissionError>;
  }
>()("t3/ardud/missions/guard/notices/NoticeLedger") {}

interface NoticeRow {
  readonly guid: string;
  readonly kind: string;
  readonly session: string;
  readonly record_id: string;
  readonly sent_at: number;
}

const toNotice = (row: NoticeRow): OwnerNotice => ({
  guid: row.guid,
  kind: row.kind,
  session: row.session,
  recordId: row.record_id,
  sentAt: row.sent_at,
});

/** Rows from the bridge store; none when it has no ledger yet (an older bridge). */
export const readNotices = (
  database: string,
  where: { readonly guid: string } | { readonly from: number; readonly to: number },
): ReadonlyArray<OwnerNotice> => {
  if (!NodeFS.existsSync(database)) return [];
  const db = new NodeSqlite.DatabaseSync(database, { readOnly: true });
  try {
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'notices'")
      .get();
    if (table === undefined) return [];
    const columns = "guid, kind, session, record_id, sent_at";
    const rows =
      "guid" in where
        ? db.prepare(`SELECT ${columns} FROM notices WHERE guid = ?`).all(where.guid)
        : db
            .prepare(
              `SELECT ${columns} FROM notices WHERE sent_at BETWEEN ? AND ? ORDER BY sent_at`,
            )
            .all(where.from, where.to);
    return (rows as unknown as ReadonlyArray<NoticeRow>).map(toNotice);
  } finally {
    db.close();
  }
};

const unreadable = (error: unknown) =>
  new MissionError({
    code: "provenance-invalid",
    detail: `Cannot read the bridge's notices: ${String(error)}`,
  });

export const makeNoticeLedger = (database: string) =>
  NoticeLedger.of({
    byGuid: (guid) =>
      Effect.try({
        try: () => readNotices(database, { guid })[0] ?? null,
        catch: unreadable,
      }),
    sentBetween: (from, to) =>
      Effect.try({ try: () => readNotices(database, { from, to }), catch: unreadable }),
  });

/** The real bridge store on this Mac (read only). */
export const layer = Layer.sync(NoticeLedger, () =>
  makeNoticeLedger(Inbound.defaultInboundSources().bridgeDatabase),
);
