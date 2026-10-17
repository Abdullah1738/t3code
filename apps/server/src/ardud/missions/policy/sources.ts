import { MissionError, type PoolBackend } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/**
 * Where an observed pool reads its usage. Fork-local config, stored next to
 * the holds (`ardud_mission_pool_sources`), so nothing samples until someone
 * configures a source. Every source is read-only: it never writes coord, crw
 * config or 9router.
 */
export const PoolSource = Schema.Union([
  Schema.TaggedStruct("coord-claims", {
    /** coord binary; `coord` on PATH by default. */
    command: Schema.String,
    /** Claims whose resource starts with this prefix count, e.g. `env:dev` or `svc:`. */
    resourcePrefix: Schema.String,
    /** Only claims in this env, or every env when null. */
    env: Schema.NullOr(Schema.String),
  }),
  Schema.TaggedStruct("crw-reviews", {
    /** crw `config.json`; `max_reviews_per_day` becomes the capacity. */
    configPath: Schema.String,
    /** crw sqlite db, read with `sqlite3 -readonly`. */
    dbPath: Schema.String,
  }),
  Schema.TaggedStruct("quota", {
    /** quota.py from the coordinated-project-delivery skill. */
    script: Schema.String,
    provider: Schema.Literals(["claude", "codex"]),
  }),
  Schema.TaggedStruct("offbox-spend", {
    command: Schema.String,
  }),
]);
export type PoolSource = typeof PoolSource.Type;

/** The backend each source belongs to; a source only attaches to a matching pool. */
export const sourceBackend = (source: PoolSource): PoolBackend => {
  switch (source._tag) {
    case "coord-claims":
      return "coord-claim";
    case "crw-reviews":
      return "crw-config";
    case "quota":
      return "9router";
    case "offbox-spend":
      return "offbox";
  }
};

/** One reading. `capacity` is set when the outside system owns the limit. */
export interface UsageSample {
  readonly used: number;
  readonly capacity: number | null;
  readonly window: string | null;
  readonly resetsAt: string | null;
  readonly runOutAt: string | null;
}

const invalid = (detail: string): never => {
  throw new MissionError({ code: "invalid", detail });
};

const parseJson = (text: string, what: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return invalid(`${what} did not print JSON.`);
  }
};

const CoordClaims = Schema.Struct({
  ok: Schema.Boolean,
  claims: Schema.Array(
    Schema.Struct({
      resource: Schema.String,
      state: Schema.String,
      env: Schema.NullOr(Schema.String),
    }),
  ),
});
const decodeCoordClaims = Schema.decodeUnknownOption(CoordClaims);

/**
 * `coord claims` JSON. Active and reconcile-required claims both hold the
 * resource (an expired claim blocks until reconciled), so both count.
 */
export const parseCoordClaims = (
  stdout: string,
  source: Extract<PoolSource, { _tag: "coord-claims" }>,
): UsageSample => {
  const decoded = decodeCoordClaims(parseJson(stdout, "coord claims"));
  if (decoded._tag === "None" || !decoded.value.ok)
    return invalid("coord claims output was not understood.");
  const used = decoded.value.claims.filter(
    (claim) =>
      (claim.state === "active" || claim.state === "reconcile_required") &&
      claim.resource.startsWith(source.resourcePrefix) &&
      (source.env === null || claim.env === source.env),
  ).length;
  return { used, capacity: null, window: null, resetsAt: null, runOutAt: null };
};

const CrwConfig = Schema.Struct({
  max_reviews_per_day: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  review_budget_since: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
const decodeCrwConfig = Schema.decodeUnknownOption(CrwConfig);

export interface CrwBudgetWindow {
  readonly capacity: number | null;
  /** Unix seconds; reviews requested after this count. */
  readonly since: number;
}

/** Same window as crw's own `reviewBudget()`: rolling 24h, never before `review_budget_since`. */
export const crwBudgetWindow = (configText: string, nowMs: number): CrwBudgetWindow => {
  const decoded = decodeCrwConfig(parseJson(configText, "crw config.json"));
  if (decoded._tag === "None") return invalid("crw config.json was not understood.");
  const dayAgo = Math.floor(nowMs / 1000) - 86_400;
  const floor = decoded.value.review_budget_since
    ? Math.floor(Date.parse(decoded.value.review_budget_since) / 1000)
    : Number.NaN;
  return {
    capacity: decoded.value.max_reviews_per_day ?? null,
    since: Number.isFinite(floor) ? Math.max(dayAgo, floor) : dayAgo,
  };
};

export const crwReviewsQuery = (since: number) =>
  `SELECT COUNT(*) AS sent FROM reviews WHERE requested_at > ${Math.floor(since)}`;

/** `sqlite3 -readonly -json` output of `crwReviewsQuery`. */
export const parseCrwReviews = (stdout: string, window: CrwBudgetWindow): UsageSample => {
  const rows = stdout.trim() === "" ? [] : parseJson(stdout, "sqlite3");
  const sent = Array.isArray(rows)
    ? Number((rows[0] as { sent?: unknown } | undefined)?.sent ?? 0)
    : NaN;
  if (!Number.isFinite(sent)) return invalid("crw review count was not understood.");
  return { used: sent, capacity: window.capacity, window: "day", resetsAt: null, runOutAt: null };
};

const POOL_LINE = /^POOL (claude|codex): (\d+)\/(\d+) usable now/;

/**
 * quota.py's pool line. Capacity is the number of accounts, used the ones
 * not usable now (either window at 90% or more). Unknown accounts are not counted.
 */
export const parseQuota = (
  stdout: string,
  source: Extract<PoolSource, { _tag: "quota" }>,
): UsageSample => {
  for (const line of stdout.split("\n")) {
    const match = POOL_LINE.exec(line);
    if (match && match[1] === source.provider) {
      const usable = Number(match[2]);
      const total = Number(match[3]);
      return {
        used: total - usable,
        capacity: total,
        window: "5h",
        resetsAt: null,
        runOutAt: null,
      };
    }
  }
  return invalid(`quota.py printed no ${source.provider} pool line.`);
};

const OffboxSpend = Schema.Struct({
  spend: Schema.Number,
  cap: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  period_end: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
const decodeOffboxSpend = Schema.decodeUnknownOption(OffboxSpend);

/** `offbox spend --json`: dollars spent this billing period against the monthly cap. */
export const parseOffboxSpend = (stdout: string): UsageSample => {
  const decoded = decodeOffboxSpend(parseJson(stdout, "offbox spend"));
  if (decoded._tag === "None") return invalid("offbox spend output was not understood.");
  return {
    used: decoded.value.spend,
    capacity: decoded.value.cap ?? null,
    window: "month",
    resetsAt: decoded.value.period_end ?? null,
    runOutAt: null,
  };
};
