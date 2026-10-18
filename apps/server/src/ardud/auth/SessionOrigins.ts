/**
 * Where an auth session came from, written once when the session is minted
 * and never changed.
 *
 * The session subject is not proof of anything: anyone holding `access:write`
 * can mint a pairing link, and `t3 auth session issue --subject` picks any
 * subject. So the owner is not "a session with a paired-looking subject" but
 * "a session minted from one of the owner's roots":
 *
 * - `desktop`: the desktop app pairing its own renderer.
 * - `dev-token`: dev mode's reusable credential from the owner's `.env`. In
 *   dev mode the startup URL carries this credential itself, so a browser
 *   opened from it is the owner; that is the `.env` secret, not a Mac link.
 *   If that credential no longer verifies, the startup URL falls back to an
 *   ordinary Mac link, which is not an owner link.
 * - `paired-client`: a pairing link created from a session that is itself an
 *   owner session (Settings > Connections on the owner's paired client).
 *
 * Links made on the Mac (`t3 pair`, `t3 auth pairing create`, the startup
 * URL outside dev mode) are never owner links, not even for the first device:
 * anything that can run commands as the owner's user can make one, agent
 * shells included.
 *
 * Pairing links minted by anyone else (a control token, an MCP client, T3
 * Connect) carry no owner mark, so the sessions they turn into are not owner
 * sessions, whatever their subject or cookie/bearer method.
 *
 * Components are named server-side the same way: a component credential's
 * session is recorded as that component when it is issued.
 *
 * Rows are written before the credential or token is handed out, so a lookup
 * can never race the write, and are never updated or deleted.
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no sync sha256 helper.
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

/** The owner roots: the only sources a grant or claim can be written with. */
export type MintedOwnerSource = "desktop" | "dev-token" | "paired-client";

/**
 * `startup` and `cli` are never minted or read back as the owner. They stay in
 * this decoded type only so older test fixtures still compile.
 */
export type OwnerSource = "startup" | "cli" | MintedOwnerSource;

/** What `t3 pair` / `t3 auth pairing create` print to stderr with every link. */
export const MAC_LINK_NOT_OWNER =
  "Note: a link made on the Mac pairs a device that is not the owner. To pair an owner device, make the link in the desktop app or on another owner device (Settings > Connections).";

const OWNER_SOURCES: ReadonlySet<string> = new Set<MintedOwnerSource>([
  "desktop",
  "dev-token",
  "paired-client",
]);

export type SessionOrigin =
  | { readonly _tag: "owner"; readonly source: OwnerSource }
  | { readonly _tag: "component"; readonly component: string };

/** An origin that can be written or read back: owner origins only from owner roots. */
export type MintedOrigin =
  | { readonly _tag: "owner"; readonly source: MintedOwnerSource }
  | { readonly _tag: "component"; readonly component: string };

export class SessionOriginsError extends Schema.TaggedError<SessionOriginsError>()(
  "SessionOriginsError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

export interface SessionOriginsShape {
  /** Marks a pairing credential as owner-issued, before it is handed out. */
  readonly markOwnerGrant: (
    credential: string,
    source: MintedOwnerSource,
  ) => Effect.Effect<void, SessionOriginsError>;
  /** The owner source a pairing credential was marked with, if any. */
  readonly ownerGrant: (
    credential: string,
  ) => Effect.Effect<MintedOwnerSource | null, SessionOriginsError>;
  /** Records a session's origin. A second record for the same session is ignored. */
  readonly record: (
    sessionId: string,
    origin: MintedOrigin,
  ) => Effect.Effect<void, SessionOriginsError>;
  readonly originOf: (sessionId: string) => Effect.Effect<MintedOrigin | null, SessionOriginsError>;
  /**
   * Notes that the server has an owner. True only for the first caller ever.
   * A record, not a gate: owner roots make owners whether or not it is set.
   */
  readonly claimOwner: (source: MintedOwnerSource) => Effect.Effect<boolean, SessionOriginsError>;
  /** Whether the server has ever had an owner session, live or not. For tests and recovery checks. */
  readonly ownerClaimed: () => Effect.Effect<boolean, SessionOriginsError>;
  readonly componentSessions: () => Effect.Effect<
    ReadonlyArray<{
      readonly sessionId: string;
      readonly component: string;
      readonly createdAt: string;
    }>,
    SessionOriginsError
  >;
}

export class SessionOrigins extends Context.Service<SessionOrigins, SessionOriginsShape>()(
  "t3/ardud/auth/SessionOrigins",
) {}

const hashCredential = (credential: string) =>
  NodeCrypto.createHash("sha256").update(credential).digest("hex");

const decodeOrigin = (row: {
  readonly origin: string;
  readonly detail: string;
}): MintedOrigin | null => {
  if (row.origin === "owner" && OWNER_SOURCES.has(row.detail)) {
    return { _tag: "owner", source: row.detail as MintedOwnerSource };
  }
  if (row.origin === "component" && row.detail.length > 0) {
    return { _tag: "component", component: row.detail };
  }
  return null;
};

const CACHE_LIMIT = 5_000;

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fail = (operation: string) => (cause: unknown) =>
    new SessionOriginsError({ operation, cause });

  yield* sql`
    CREATE TABLE IF NOT EXISTS ardud_mission_session_origins (
      session_id TEXT PRIMARY KEY,
      origin TEXT NOT NULL,
      detail TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `.pipe(Effect.mapError(fail("ensure-session-origins")));
  yield* sql`
    CREATE TABLE IF NOT EXISTS ardud_mission_owner_grants (
      credential_hash TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `.pipe(Effect.mapError(fail("ensure-owner-grants")));
  yield* sql`
    CREATE TABLE IF NOT EXISTS ardud_mission_owner_claim (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      source TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `.pipe(Effect.mapError(fail("ensure-owner-claim")));

  // Origins never change, so a cached answer (including "none") stays right.
  // The row is written before its token exists, so "none" is never premature.
  const cache = new Map<string, MintedOrigin | null>();
  const remember = (sessionId: string, origin: MintedOrigin | null) => {
    if (cache.size >= CACHE_LIMIT) cache.clear();
    cache.set(sessionId, origin);
  };

  const now = Effect.map(DateTime.now, DateTime.formatIso);

  const markOwnerGrant: SessionOriginsShape["markOwnerGrant"] = (credential, source) =>
    Effect.gen(function* () {
      const createdAt = yield* now;
      yield* sql`
        INSERT OR IGNORE INTO ardud_mission_owner_grants (credential_hash, source, created_at)
        VALUES (${hashCredential(credential)}, ${source}, ${createdAt})
      `;
    }).pipe(Effect.mapError(fail("mark-owner-grant")));

  const ownerGrant: SessionOriginsShape["ownerGrant"] = (credential) =>
    sql<{ readonly source: string }>`
      SELECT source FROM ardud_mission_owner_grants
      WHERE credential_hash = ${hashCredential(credential)}
    `.pipe(
      Effect.map((rows) => {
        const source = rows[0]?.source;
        return source !== undefined && OWNER_SOURCES.has(source)
          ? (source as MintedOwnerSource)
          : null;
      }),
      Effect.mapError(fail("read-owner-grant")),
    );

  const record: SessionOriginsShape["record"] = (sessionId, origin) =>
    Effect.gen(function* () {
      const createdAt = yield* now;
      const detail = origin._tag === "owner" ? origin.source : origin.component;
      yield* sql`
        INSERT OR IGNORE INTO ardud_mission_session_origins (session_id, origin, detail, created_at)
        VALUES (${sessionId}, ${origin._tag}, ${detail}, ${createdAt})
      `;
      cache.delete(sessionId);
    }).pipe(Effect.mapError(fail("record-session-origin")));

  const originOf: SessionOriginsShape["originOf"] = (sessionId) =>
    cache.has(sessionId)
      ? Effect.succeed(cache.get(sessionId) ?? null)
      : sql<{ readonly origin: string; readonly detail: string }>`
          SELECT origin, detail FROM ardud_mission_session_origins WHERE session_id = ${sessionId}
        `.pipe(
          Effect.map((rows) => {
            const origin = rows[0] ? decodeOrigin(rows[0]) : null;
            remember(sessionId, origin);
            return origin;
          }),
          Effect.mapError(fail("read-session-origin")),
        );

  // One row, written by the first owner session ever. The insert is atomic,
  // so exactly one caller sees `true`. Not cached: pairing is rare.
  const claimOwner: SessionOriginsShape["claimOwner"] = (source) =>
    Effect.gen(function* () {
      const createdAt = yield* now;
      const rows = yield* sql<{ readonly id: number }>`
        INSERT OR IGNORE INTO ardud_mission_owner_claim (id, source, created_at)
        VALUES (1, ${source}, ${createdAt})
        RETURNING id
      `;
      return rows.length > 0;
    }).pipe(Effect.mapError(fail("claim-owner")));

  const ownerClaimed: SessionOriginsShape["ownerClaimed"] = () =>
    sql<{ readonly id: number }>`SELECT id FROM ardud_mission_owner_claim`.pipe(
      Effect.map((rows) => rows.length > 0),
      Effect.mapError(fail("read-owner-claim")),
    );

  const componentSessions: SessionOriginsShape["componentSessions"] = () =>
    sql<{ readonly session_id: string; readonly detail: string; readonly created_at: string }>`
      SELECT session_id, detail, created_at FROM ardud_mission_session_origins
      WHERE origin = 'component'
      ORDER BY created_at DESC
    `.pipe(
      Effect.map((rows) =>
        rows.map((row) => ({
          sessionId: row.session_id,
          component: row.detail,
          createdAt: row.created_at,
        })),
      ),
      Effect.mapError(fail("list-component-sessions")),
    );

  return SessionOrigins.of({
    markOwnerGrant,
    ownerGrant,
    record,
    originOf,
    claimOwner,
    ownerClaimed,
    componentSessions,
  });
});

export const layer = Layer.effect(SessionOrigins, make);

/**
 * Subjects the server gives its own sessions. `t3 auth session issue` refuses
 * them so a hand-issued token never looks like one of these.
 */
const RESERVED_SUBJECTS: ReadonlySet<string> = new Set([
  "one-time-token",
  "administrative-bootstrap",
  "desktop-bootstrap",
  "cloud-connect",
  "cloud-cli",
  "reusable-dev-token",
  "reusable-dev-token-child",
  "mcp-client",
  "browser",
]);

export const COMPONENT_SUBJECT_PREFIX = "component:";

export const isReservedSessionSubject = (subject: string) =>
  RESERVED_SUBJECTS.has(subject.trim()) || subject.trim().startsWith(COMPONENT_SUBJECT_PREFIX);

export class ReservedSessionSubjectError extends Schema.TaggedError<ReservedSessionSubjectError>()(
  "ReservedSessionSubjectError",
  { subject: Schema.String },
) {
  override get message(): string {
    return `Subject "${this.subject}" is reserved for sessions the server mints itself.`;
  }
}
