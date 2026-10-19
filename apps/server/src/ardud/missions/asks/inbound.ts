// @effect-diagnostics nodeBuiltinImport:off - read-only lookups into the iMessage bridge's SQLite file and the imsg CLI.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { MissionError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { InboundMessage } from "./provenance.ts";
import { isSyntheticInboundId } from "./provenance.ts";

/**
 * Finds an iMessage the owner or Moni sent, by id. Read only: it never marks,
 * moves or answers anything in either store.
 */
export class InboundLookup extends Context.Service<
  InboundLookup,
  {
    /** `since` (ISO) bounds the search; messages before it cannot be answers. */
    readonly find: (
      id: string,
      since: string,
    ) => Effect.Effect<InboundMessage | null, MissionError>;
  }
>()("t3/ardud/missions/asks/inbound/InboundLookup") {}

/** Moni's chat rowid in Messages (see app-api-cli moni_go.py). */
export const MONI_CHAT_ID = 45;

export interface InboundSources {
  /** The iMessage bridge's state database (owner chat only; rows keyed by message id). */
  readonly bridgeDatabase: string;
  /** Runs `imsg` with args and returns stdout; null when imsg is unavailable. */
  readonly runImsg: ((args: ReadonlyArray<string>) => Promise<string>) | null;
  readonly moniChatId: number;
}

const unavailable = (detail: string) =>
  new MissionError({ code: "provenance-invalid", detail: `Cannot verify the iMessage: ${detail}` });

/**
 * Owner chat: the bridge only ingests the owner's own chat. A row is his typed
 * words only when the bridge marked it `source: "typed"` (it stored the
 * message verbatim); poll votes, wakes, nudges and unmarked rows are composed.
 */
export const findInBridge = (database: string, id: string): InboundMessage | null => {
  if (!NodeFS.existsSync(database)) return null;
  const db = new NodeSqlite.DatabaseSync(database, { readOnly: true });
  try {
    const row = db.prepare("SELECT id, payload FROM inbound WHERE id = ?").get(id) as
      | { id: string; payload: string }
      | undefined;
    if (row === undefined) return null;
    const payload = JSON.parse(row.payload) as {
      text?: unknown;
      receivedAt?: unknown;
      source?: unknown;
      replyTo?: unknown;
    };
    return {
      id: row.id,
      chat: "owner",
      text: typeof payload.text === "string" ? payload.text : "",
      receivedAt: typeof payload.receivedAt === "number" ? payload.receivedAt : 0,
      typed: payload.source === "typed",
      ...(typeof payload.replyTo === "string" && payload.replyTo.length > 0
        ? { replyTo: payload.replyTo }
        : {}),
    };
  } finally {
    db.close();
  }
};

interface ImsgRow {
  readonly guid?: unknown;
  readonly chat_id?: unknown;
  readonly is_from_me?: unknown;
  readonly text?: unknown;
  readonly created_at?: unknown;
}

/** Moni's chat: only messages she sent (never ones the Mac sent) in chat 45. */
export const findInImsgHistory = (
  output: string,
  id: string,
  moniChatId: number,
): InboundMessage | null => {
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let row: ImsgRow;
    try {
      row = JSON.parse(trimmed) as ImsgRow;
    } catch {
      continue;
    }
    if (row.guid !== id) continue;
    if (row.is_from_me !== false) return null;
    if (Number(row.chat_id) !== moniChatId) return null;
    const receivedAt = typeof row.created_at === "string" ? Date.parse(row.created_at) : Number.NaN;
    // imsg history lists messages as sent; the bridge composes nothing here.
    return {
      id,
      chat: "moni",
      text: typeof row.text === "string" ? row.text : "",
      receivedAt: Number.isFinite(receivedAt) ? receivedAt : 0,
      typed: true,
    };
  }
  return null;
};

const SINCE_SLACK_MS = 5 * 60_000;

/** `imsg history` window: from a little before the record opened. */
export const imsgHistoryArgs = (moniChatId: number, since: string): ReadonlyArray<string> => {
  const start = Date.parse(since);
  return [
    "history",
    "--chat-id",
    String(moniChatId),
    "--limit",
    "1000",
    "--json",
    ...(Number.isFinite(start)
      ? ["--start", DateTime.formatIso(DateTime.makeUnsafe(start - SINCE_SLACK_MS))]
      : []),
  ];
};

export const makeInboundLookup = (sources: InboundSources) =>
  InboundLookup.of({
    find: (id, since) =>
      Effect.gen(function* () {
        if (isSyntheticInboundId(id)) return null;
        const owner = yield* Effect.try({
          try: () => findInBridge(sources.bridgeDatabase, id),
          catch: (error) => unavailable(`bridge store unreadable (${String(error)})`),
        });
        if (owner !== null) return owner;
        const runImsg = sources.runImsg;
        if (runImsg === null) return null;
        const args = imsgHistoryArgs(sources.moniChatId, since);
        const output = yield* Effect.tryPromise({
          try: () => runImsg(args),
          catch: (error) => unavailable(`imsg history failed (${String(error)})`),
        });
        return findInImsgHistory(output, id, sources.moniChatId);
      }),
  });

const IMSG_CANDIDATES = ["/opt/homebrew/bin/imsg", "/usr/local/bin/imsg"];

const runImsgAt =
  (binary: string) =>
  (args: ReadonlyArray<string>): Promise<string> =>
    new Promise((resolve, reject) => {
      NodeChildProcess.execFile(
        binary,
        [...args],
        { timeout: 15_000, maxBuffer: 16 * 1024 * 1024 },
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      );
    });

/** The real sources on this Mac (read only). */
export const defaultInboundSources = (): InboundSources => {
  const imsg = IMSG_CANDIDATES.find((path) => NodeFS.existsSync(path));
  return {
    bridgeDatabase: NodePath.join(NodeOS.homedir(), ".config", "spectrum-bridge", "state.sqlite"),
    runImsg: imsg === undefined ? null : runImsgAt(imsg),
    moniChatId: MONI_CHAT_ID,
  };
};

export const layer = Layer.sync(InboundLookup, () => makeInboundLookup(defaultInboundSources()));

export const layerFrom = (sources: InboundSources) =>
  Layer.succeed(InboundLookup, makeInboundLookup(sources));
