// @effect-diagnostics nodeBuiltinImport:off - the import reads coord.db and crw.db copies read-only.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import {
  parseDeferred,
  parseLanePulse,
  parseLaneRoster,
  parseStandingRules,
  type LanePulse,
  type ParsedDeferredRegister,
  type ParsedRoster,
  type ParsedRules,
} from "./sources.ts";

/** Rows of coord.db the import reads (see integrations/coord/lib/db.mjs). */
export interface CoordActorRow {
  readonly id: string;
  readonly kind: string;
  readonly thread_id: string | null;
  readonly updated_at: number;
}

export interface CoordChannelRow {
  readonly id: string;
  readonly purpose: string | null;
  readonly owner: string;
  readonly status: string;
  readonly created_at: number;
}

export interface CoordMemberRow {
  readonly channel_id: string;
  readonly actor_id: string;
  readonly wake: number;
}

export interface CoordEventRow {
  readonly seq: number;
  readonly event_key: string;
  readonly body_hash: string | null;
  readonly channel_id: string;
  readonly kind: string;
  readonly sender: string;
  readonly work_id: string | null;
  readonly environment: string | null;
  readonly expected_revision: string | null;
  readonly authority_ref: string | null;
  readonly summary: string;
  readonly body_json: string | null;
  readonly reply_to: number | null;
  readonly created_at: number;
}

export interface CoordDeliveryRow {
  readonly event_seq: number;
  readonly recipient: string;
  readonly status: string;
  readonly acked_at: number | null;
}

export interface CoordSnapshot {
  readonly actors: ReadonlyArray<CoordActorRow>;
  readonly channels: ReadonlyArray<CoordChannelRow>;
  readonly members: ReadonlyArray<CoordMemberRow>;
  readonly events: ReadonlyArray<CoordEventRow>;
  readonly deliveries: ReadonlyArray<CoordDeliveryRow>;
}

/** crw review threads waiting on the owner and manual holds (crw.db). */
export interface CrwAwaiting {
  readonly prKey: string;
  readonly awaitingSince: number | null;
  readonly title: string;
  readonly url: string | null;
  readonly state: string;
  readonly author: string | null;
  readonly headSha: string | null;
  readonly tickets: ReadonlyArray<{ readonly id: string; readonly state: string }>;
}

export interface CrwHold {
  readonly prKey: string;
  readonly reason: string;
  readonly createdAt: number;
  readonly title: string | null;
  readonly url: string | null;
  readonly state: string | null;
}

export interface CrwConfig {
  readonly excludedRepos: ReadonlyArray<string>;
  readonly activeStates: ReadonlyArray<string>;
  /** crw's own review caps today; the import sizes the mission's review pool from them. */
  readonly maxReviewsPerTick: number | null;
  readonly maxReviewsPerDay: number | null;
}

export interface CrwSnapshot {
  readonly awaiting: ReadonlyArray<CrwAwaiting>;
  readonly holds: ReadonlyArray<CrwHold>;
  readonly config: CrwConfig;
  /** Last GitHub/Linear sync in crw.db (unix seconds): the snapshot's "now". */
  readonly syncedAt: number;
}

export interface ImportSources {
  readonly coord: CoordSnapshot;
  readonly crw: CrwSnapshot | null;
  readonly rules: ParsedRules;
  readonly deferred: ParsedDeferredRegister;
  readonly pulse: LanePulse;
  readonly roster: ParsedRoster;
}

const openReadOnly = (path: string) => {
  if (!NodeFS.existsSync(path)) throw new Error(`missing ${path}`);
  return new NodeSqlite.DatabaseSync(path, { readOnly: true });
};

const rows = <T>(db: NodeSqlite.DatabaseSync, query: string, ...params: Array<string | number>) =>
  db.prepare(query).all(...params) as unknown as Array<T>;

export const readCoordDb = (path: string): CoordSnapshot => {
  const db = openReadOnly(path);
  try {
    return {
      actors: rows<CoordActorRow>(
        db,
        "SELECT id, kind, thread_id, updated_at FROM actors ORDER BY id",
      ),
      channels: rows<CoordChannelRow>(
        db,
        "SELECT id, purpose, owner, status, created_at FROM channels ORDER BY id",
      ),
      members: rows<CoordMemberRow>(
        db,
        "SELECT channel_id, actor_id, wake FROM members ORDER BY channel_id, actor_id",
      ),
      events: rows<CoordEventRow>(
        db,
        `SELECT seq, event_key, body_hash, channel_id, kind, sender, work_id, environment, expected_revision,
          authority_ref, summary, body_json, reply_to, created_at FROM events ORDER BY seq`,
      ),
      deliveries: rows<CoordDeliveryRow>(
        db,
        "SELECT event_seq, recipient, status, acked_at FROM deliveries ORDER BY event_seq, recipient",
      ),
    };
  } finally {
    db.close();
  }
};

const DEFAULT_ACTIVE_STATES = ["In Review", "Code OK - Pending"];

export const readCrwConfig = (path: string | null): CrwConfig => {
  if (path === null || !NodeFS.existsSync(path))
    return {
      excludedRepos: [],
      activeStates: DEFAULT_ACTIVE_STATES,
      maxReviewsPerTick: null,
      maxReviewsPerDay: null,
    };
  const raw = JSON.parse(NodeFS.readFileSync(path, "utf8")) as Record<string, unknown>;
  const strings = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  const cap = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
  const active = strings(raw.active_states);
  return {
    excludedRepos: strings(raw.excluded_repos),
    activeStates: active.length > 0 ? active : DEFAULT_ACTIVE_STATES,
    maxReviewsPerTick: cap(raw.max_reviews_per_tick),
    maxReviewsPerDay: cap(raw.max_reviews_per_day),
  };
};

export const readCrwDb = (path: string, configPath: string | null): CrwSnapshot => {
  const db = openReadOnly(path);
  try {
    const awaiting = rows<{
      pr_key: string;
      awaiting_since: number | null;
      title: string | null;
      url: string | null;
      state: string | null;
      author: string | null;
      head_sha: string | null;
    }>(
      db,
      `SELECT t.pr_key, t.awaiting_since, p.title, p.url, p.state, p.author, p.head_sha
         FROM threads t LEFT JOIN prs p ON p.key = t.pr_key
        WHERE t.title = 'Awaiting Decision' ORDER BY t.pr_key`,
    );
    const tickets = (prKey: string) =>
      rows<{ id: string; state: string | null }>(
        db,
        `SELECT pi.issue AS id, i.state FROM pr_issues pi LEFT JOIN issues i ON i.identifier = pi.issue
          WHERE pi.pr_key = ? ORDER BY pi.issue`,
        prKey,
      ).map((t) => ({ id: t.id, state: t.state ?? "unknown" }));
    const holds = rows<{
      pr_key: string;
      reason: string;
      created_at: number;
      title: string | null;
      url: string | null;
      state: string | null;
    }>(
      db,
      `SELECT h.pr_key, h.reason, h.created_at, p.title, p.url, p.state
         FROM holds h LEFT JOIN prs p ON p.key = h.pr_key ORDER BY h.pr_key`,
    );
    return {
      awaiting: awaiting.map((a) => ({
        prKey: a.pr_key,
        awaitingSince: a.awaiting_since,
        title: a.title ?? a.pr_key,
        url: a.url,
        state: a.state ?? "UNKNOWN",
        author: a.author,
        headSha: a.head_sha,
        tickets: tickets(a.pr_key),
      })),
      holds: holds.map((h) => ({
        prKey: h.pr_key,
        reason: h.reason,
        createdAt: h.created_at,
        title: h.title,
        url: h.url,
        state: h.state,
      })),
      config: readCrwConfig(configPath),
      syncedAt: rows<{ at: number | null }>(db, "SELECT MAX(synced_at) AS at FROM prs")[0]?.at ?? 0,
    };
  } finally {
    db.close();
  }
};

export interface SourcePaths {
  readonly coordDb: string;
  /** Directory with STANDING-RULES.md, DEFERRED.md, LANE-ROSTER.md, lane-pulse.json. */
  readonly statusDir: string;
  readonly crwDb: string | null;
  readonly crwConfig: string | null;
}

const readText = (dir: string, name: string) =>
  NodeFS.readFileSync(NodePath.join(dir, name), "utf8");

const readOptional = (dir: string, name: string) => {
  const path = NodePath.join(dir, name);
  return NodeFS.existsSync(path) ? NodeFS.readFileSync(path, "utf8") : undefined;
};

export const readSources = (paths: SourcePaths): ImportSources => ({
  coord: readCoordDb(paths.coordDb),
  crw: paths.crwDb === null ? null : readCrwDb(paths.crwDb, paths.crwConfig),
  rules: parseStandingRules(
    readText(paths.statusDir, "STANDING-RULES.md"),
    readOptional(paths.statusDir, "STANDING-RULES-ARCHIVE.md"),
  ),
  deferred: parseDeferred(readText(paths.statusDir, "DEFERRED.md")),
  pulse: parseLanePulse(readText(paths.statusDir, "lane-pulse.json")),
  roster: parseLaneRoster(readText(paths.statusDir, "LANE-ROSTER.md")),
});
