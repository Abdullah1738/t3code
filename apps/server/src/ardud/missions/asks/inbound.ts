// @effect-diagnostics nodeBuiltinImport:off - read-only lookups into the iMessage bridge's SQLite files, its config and the imsg CLI.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { MissionError, type TrustedChat } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { InboundMessage } from "./provenance.ts";
import { isSyntheticInboundId } from "./provenance.ts";

/**
 * Finds an iMessage the owner or Moni sent, by id. Read only: it never marks,
 * moves or answers anything in any store.
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

/** Who may speak on the bridge's line, by address. Empty lists match nobody. */
export interface InboundIdentities {
  readonly owner: ReadonlyArray<string>;
  readonly moni: ReadonlyArray<string>;
}

export interface InboundSources {
  /** The iMessage bridge's state database for his direct chat (rows keyed by message id). */
  readonly bridgeDatabase: string;
  /** Holds one folder per other bridge chat (`group-sb_gro`, `moni`), each with a `state.sqlite`. */
  readonly chatsDirectory: string;
  /** His and Moni's addresses, read on every lookup so edits apply at once. */
  readonly identities: () => InboundIdentities;
  /** Runs `imsg` with args and returns stdout; null when imsg is unavailable. */
  readonly runImsg: ((args: ReadonlyArray<string>) => Promise<string>) | null;
  readonly moniChatId: number;
}

const unavailable = (detail: string) =>
  new MissionError({ code: "provenance-invalid", detail: `Cannot verify the iMessage: ${detail}` });

/** Same comparison the bridge uses (`integrations/spectrum-bridge/src/access.ts`). */
const normalizeAddress = (address: string) => address.trim().toLowerCase();

interface BridgeRow {
  readonly id: string;
  readonly payload: {
    readonly text?: unknown;
    readonly receivedAt?: unknown;
    readonly source?: unknown;
    readonly replyTo?: unknown;
    readonly sender?: unknown;
  };
}

const readBridgeRow = (database: string, id: string): BridgeRow | null => {
  if (!NodeFS.existsSync(database)) return null;
  const db = new NodeSqlite.DatabaseSync(database, { readOnly: true });
  try {
    const row = db.prepare("SELECT id, payload FROM inbound WHERE id = ?").get(id) as
      | { id: string; payload: string }
      | undefined;
    if (row === undefined) return null;
    return { id: row.id, payload: JSON.parse(row.payload) as BridgeRow["payload"] };
  } finally {
    db.close();
  }
};

const messageOf = (row: BridgeRow, chat: TrustedChat): InboundMessage => ({
  id: row.id,
  chat,
  text: typeof row.payload.text === "string" ? row.payload.text : "",
  receivedAt: typeof row.payload.receivedAt === "number" ? row.payload.receivedAt : 0,
  typed: row.payload.source === "typed",
  ...(typeof row.payload.replyTo === "string" && row.payload.replyTo.length > 0
    ? { replyTo: row.payload.replyTo }
    : {}),
});

/**
 * His direct chat: everything in that store came from him. A row is his typed
 * words only when the bridge marked it `source: "typed"` (it stored the
 * message verbatim); poll votes, wakes, nudges and unmarked rows are composed.
 */
export const findInBridge = (database: string, id: string): InboundMessage | null => {
  const row = readBridgeRow(database, id);
  return row === null ? null : messageOf(row, "owner");
};

/**
 * Another bridge chat (a group, Moni's): many people type there, so a row
 * counts only when the bridge marked it typed and its sender is him or Moni.
 * Anything else reads as not found.
 */
export const findInBridgeChat = (
  database: string,
  bridgeChat: string,
  id: string,
  identities: InboundIdentities,
): InboundMessage | null => {
  const row = readBridgeRow(database, id);
  if (row === null || row.payload.source !== "typed") return null;
  const sender = typeof row.payload.sender === "string" ? normalizeAddress(row.payload.sender) : "";
  if (sender.length === 0) return null;
  const speaks = (addresses: ReadonlyArray<string>) =>
    addresses.some((address) => normalizeAddress(address) === sender);
  const chat: TrustedChat | null = speaks(identities.owner)
    ? "owner"
    : speaks(identities.moni)
      ? "moni"
      : null;
  return chat === null ? null : { ...messageOf(row, chat), bridgeChat };
};

const chatStores = (directory: string): ReadonlyArray<{ chat: string; database: string }> => {
  if (!NodeFS.existsSync(directory)) return [];
  return NodeFS.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted()
    .map((chat) => ({ chat, database: NodePath.join(directory, chat, "state.sqlite") }));
};

const readJson = (file: string): unknown => {
  try {
    return JSON.parse(NodeFS.readFileSync(file, "utf8")) as unknown;
  } catch {
    return null;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * His address from the bridge's `config.json` (`owner`), Moni's from
 * `access.json` (the `people` entry named Moni). A missing or unreadable file
 * leaves that list empty, so nobody matches.
 */
export const readBridgeIdentities = (configFile: string, accessFile: string): InboundIdentities => {
  const config = readJson(configFile);
  const owner = isRecord(config) && typeof config.owner === "string" ? [config.owner] : [];
  const access = readJson(accessFile);
  const people = isRecord(access) && Array.isArray(access.people) ? access.people : [];
  const moni = people.flatMap((person: unknown) =>
    isRecord(person) &&
    typeof person.name === "string" &&
    person.name.trim().toLowerCase() === "moni" &&
    Array.isArray(person.addresses)
      ? person.addresses.filter((address): address is string => typeof address === "string")
      : [],
  );
  return {
    owner: owner.filter((address) => normalizeAddress(address).length > 0),
    moni: moni.filter((address) => normalizeAddress(address).length > 0),
  };
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

const NOBODY: InboundIdentities = { owner: [], moni: [] };

/** Who may speak; if that can't be read, nobody does. */
const identitiesOrNobody = (sources: InboundSources): InboundIdentities => {
  try {
    return sources.identities();
  } catch {
    return NOBODY;
  }
};

/**
 * His direct chat first, then every other bridge chat (ids are Sendblue
 * handles, unique across chats), then Moni's Messages history.
 */
export const makeInboundLookup = (sources: InboundSources) =>
  InboundLookup.of({
    find: Effect.fn("InboundLookup.find")(function* (id: string, since: string) {
      if (isSyntheticInboundId(id)) return null;
      const owner = yield* Effect.try({
        try: () => findInBridge(sources.bridgeDatabase, id),
        catch: (error) => unavailable(`bridge store unreadable (${String(error)})`),
      });
      if (owner !== null) return owner;
      const stores = yield* Effect.try({
        try: () => chatStores(sources.chatsDirectory),
        catch: (error) => unavailable(`bridge chats unreadable (${String(error)})`),
      });
      if (stores.length > 0) {
        const identities = identitiesOrNobody(sources);
        for (const store of stores) {
          const found = yield* Effect.try({
            try: () => findInBridgeChat(store.database, store.chat, id, identities),
            catch: (error) =>
              unavailable(`bridge chat ${store.chat} unreadable (${String(error)})`),
          });
          if (found !== null) return found;
        }
      }
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
  const bridgeHome = NodePath.join(NodeOS.homedir(), ".config", "spectrum-bridge");
  return {
    bridgeDatabase: NodePath.join(bridgeHome, "state.sqlite"),
    chatsDirectory: NodePath.join(bridgeHome, "chats"),
    identities: () =>
      readBridgeIdentities(
        NodePath.join(bridgeHome, "config.json"),
        NodePath.join(bridgeHome, "access.json"),
      ),
    runImsg: imsg === undefined ? null : runImsgAt(imsg),
    moniChatId: MONI_CHAT_ID,
  };
};

export const layer = Layer.sync(InboundLookup, () => makeInboundLookup(defaultInboundSources()));

export const layerFrom = (sources: InboundSources) =>
  Layer.succeed(InboundLookup, makeInboundLookup(sources));
