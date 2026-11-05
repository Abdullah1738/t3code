import * as NodeBuffer from "node:buffer";
import { ModelSelection } from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

const MAX_WINDOW_MS = 72 * 60 * 60 * 1000;
const decodeSelection = Schema.decodeUnknownOption(Schema.fromJsonString(ModelSelection));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export class UsageInputError extends Schema.TaggedError<UsageInputError>()("UsageInputError", {
  message: Schema.String,
}) {}

export class UsageReadError extends Schema.TaggedError<UsageReadError>()("UsageReadError", {
  cause: Schema.Defect(),
}) {}

export interface UsageQuery {
  readonly since: string | null;
  readonly until?: string | null;
  readonly cursor?: string | null;
  readonly limit?: string | null;
  readonly boardId?: string | null;
}

interface Cursor {
  readonly since: string;
  readonly until: string;
  readonly boardId: string | null;
  readonly time: string;
  readonly id: string;
}

const bad = (message: string) => new UsageInputError({ message });

const timestamp = (value: string | null | undefined): string | null => {
  if (!value) return null;
  const ms = /^\d+$/.test(value) ? Number(value) : Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  const date = DateTime.make(ms);
  return Option.isSome(date) ? DateTime.formatIso(date.value) : null;
};

const decodeCursor = (raw: string): Cursor | null => {
  try {
    const parsed: unknown = JSON.parse(NodeBuffer.Buffer.from(raw, "base64url").toString("utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const c = parsed as Record<string, unknown>;
    if (
      typeof c.since !== "string" ||
      timestamp(c.since) !== c.since ||
      typeof c.until !== "string" ||
      timestamp(c.until) !== c.until ||
      (c.boardId !== null && typeof c.boardId !== "string") ||
      typeof c.time !== "string" ||
      timestamp(c.time) !== c.time ||
      typeof c.id !== "string" ||
      !c.id
    )
      return null;
    return c as unknown as Cursor;
  } catch {
    return null;
  }
};

interface Row {
  readonly provider_turn_id: string;
  readonly thread_id: string;
  readonly sort_at: string;
  readonly started_at: string | null;
  readonly completed_at: string | null;
  readonly status: string;
  readonly turn_json: string;
  readonly parent_thread_id: string | null;
  readonly root_thread_id: string;
  readonly board_id: string | null;
  readonly card_id: string | null;
  readonly workspace: string | null;
  readonly provider_instance_id: string | null;
  readonly driver: string | null;
  readonly selection_json: string | null;
}

const itemFromRow = (row: Row) => {
  const parsed: unknown = JSON.parse(row.turn_json);
  const turn = parsed as {
    turnTokenUsage?: {
      usageStatus?: string;
      inputTokens?: number;
      cachedInputTokens?: number;
      cacheCreationTokens?: number;
      outputTokens?: number;
      reasoningTokens?: number;
      hasSubagents?: boolean;
    };
  };
  const usage = turn.turnTokenUsage;
  const selection =
    row.selection_json === null ? Option.none() : decodeSelection(row.selection_json);
  const model =
    Option.isSome(selection) && selection.value.instanceId === row.provider_instance_id
      ? selection.value
      : null;
  return {
    threadId: row.thread_id,
    rootThreadId: row.root_thread_id,
    parentThreadId: row.parent_thread_id,
    boardId: row.board_id,
    cardId: row.card_id,
    workspace: row.workspace,
    providerInstanceId: row.provider_instance_id,
    driver: row.driver,
    model: model?.model ?? null,
    effort:
      model === null
        ? null
        : (getModelSelectionStringOptionValue(model, "reasoningEffort") ??
          getModelSelectionStringOptionValue(model, "effort") ??
          null),
    startedAt: row.started_at,
    completedAt: row.completed_at,
    status: row.status,
    usageStatus: usage?.usageStatus ?? "unavailable",
    inputTokens: usage?.inputTokens ?? null,
    cachedInputTokens: usage?.cachedInputTokens ?? null,
    cacheCreationTokens: usage?.cacheCreationTokens ?? null,
    outputTokens: usage?.outputTokens ?? null,
    reasoningTokens: usage?.reasoningTokens ?? null,
    hasSubagents: usage?.hasSubagents ?? null,
  };
};

export class Usage extends Context.Service<
  Usage,
  {
    readonly list: (query: UsageQuery) => Effect.Effect<
      {
        readonly items: ReadonlyArray<ReturnType<typeof itemFromRow>>;
        readonly nextCursor: string | null;
      },
      UsageInputError | UsageReadError
    >;
  }
>()("t3/ardud/control/usage") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Same fork-owned schema as KanbanStore; control can start without the board service.
  yield* sql`
    CREATE TABLE IF NOT EXISTS ardud_kanban_threads (
      thread_id TEXT PRIMARY KEY, board_id TEXT NOT NULL, card_id TEXT,
      ended INTEGER NOT NULL DEFAULT 0, json TEXT NOT NULL
    )
  `;

  const list = Effect.fn("Usage.list")(function* (query: UsageQuery) {
    const since = timestamp(query.since);
    if (since === null) return yield* bad("since must be an ISO timestamp or epoch milliseconds.");
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;
    if (query.cursor && cursor === null) return yield* bad("Invalid cursor.");
    const until = query.until
      ? timestamp(query.until)
      : (cursor?.until ?? DateTime.formatIso(yield* DateTime.now));
    if (until === null) return yield* bad("until must be an ISO timestamp or epoch milliseconds.");
    if (until <= since || Date.parse(until) - Date.parse(since) > MAX_WINDOW_MS) {
      return yield* bad("Window must be positive and at most 72 hours.");
    }
    const boardId = query.boardId || null;
    if (
      cursor &&
      (cursor.since !== since || cursor.until !== until || cursor.boardId !== boardId)
    ) {
      return yield* bad("Cursor does not match the requested window or board.");
    }
    const requestedLimit = query.limit == null ? 1000 : Number(query.limit);
    if (!Number.isInteger(requestedLimit) || requestedLimit < 1) {
      return yield* bad("limit must be a positive integer.");
    }
    const limit = Math.min(requestedLimit, 5000);
    const afterTime = cursor?.time ?? "";
    const afterId = cursor?.id ?? "";

    // Separate indexed ranges avoid scanning all historical NULL completions.
    const rows = yield* sql<Row>`
      WITH candidates AS (
        SELECT provider_turn_id, thread_id, provider_thread_id, run_attempt_id,
          started_at, completed_at, status, payload_json, completed_at AS sort_at
        FROM orchestration_v2_projection_provider_turns INDEXED BY ardud_provider_turns_completed_idx
        WHERE completed_at >= ${since} AND completed_at < ${until}
          AND (completed_at > ${afterTime} OR (completed_at = ${afterTime} AND provider_turn_id > ${afterId}))
        UNION ALL
        SELECT provider_turn_id, thread_id, provider_thread_id, run_attempt_id,
          started_at, completed_at, status, payload_json, started_at AS sort_at
        FROM orchestration_v2_projection_provider_turns INDEXED BY ardud_provider_turns_running_started_idx
        WHERE completed_at IS NULL AND status = 'running' AND started_at >= ${since} AND started_at < ${until}
          AND (started_at > ${afterTime} OR (started_at = ${afterTime} AND provider_turn_id > ${afterId}))
      )
      SELECT c.provider_turn_id, c.thread_id, c.sort_at, c.started_at, c.completed_at, c.status,
        c.payload_json AS turn_json,
        json_extract(t.payload_json, '$.lineage.parentThreadId') AS parent_thread_id,
        COALESCE(json_extract(t.payload_json, '$.lineage.rootThreadId'), c.thread_id) AS root_thread_id,
        k.board_id, k.card_id,
        COALESCE(json_extract(t.payload_json, '$.worktreePath'), p.workspace_root) AS workspace,
        COALESCE(a.provider_instance_id, pt.provider_instance_id,
          CASE WHEN c.run_attempt_id IS NULL THEN json_extract(t.payload_json, '$.providerInstanceId') END) AS provider_instance_id,
        COALESCE(pt.driver, pt.provider, r.provider) AS driver,
        CASE WHEN c.run_attempt_id IS NULL
          THEN json_extract(t.payload_json, '$.modelSelection')
          ELSE (
            SELECT json_extract(event.payload_json, '$.modelSelection')
            FROM ardud_history_events AS event
            WHERE event.aggregate_kind = 'thread'
              AND event.application_event_version = 2
              AND event.stream_id = a.thread_id
              AND event.event_type = 'run.updated'
              AND json_extract(event.payload_json, '$.id') = a.run_id
              AND json_extract(event.payload_json, '$.activeAttemptId') = a.attempt_id
              AND json_extract(event.payload_json, '$.status') = 'running'
            ORDER BY event.sequence LIMIT 1
          ) END AS selection_json
      FROM candidates c
      LEFT JOIN orchestration_v2_projection_threads t ON t.thread_id = c.thread_id
      LEFT JOIN projection_projects p ON p.project_id = t.project_id
      LEFT JOIN ardud_kanban_threads k ON k.thread_id = COALESCE(json_extract(t.payload_json, '$.lineage.rootThreadId'), c.thread_id)
      LEFT JOIN orchestration_v2_projection_run_attempts a ON a.attempt_id = c.run_attempt_id
        AND a.thread_id = c.thread_id AND a.provider_thread_id = c.provider_thread_id
      LEFT JOIN orchestration_v2_projection_runs r ON r.run_id = a.run_id AND r.thread_id = c.thread_id
      LEFT JOIN orchestration_v2_projection_provider_threads pt ON pt.provider_thread_id = c.provider_thread_id
      WHERE (${boardId} IS NULL OR k.board_id = ${boardId})
      ORDER BY c.sort_at, c.provider_turn_id
      LIMIT ${limit + 1}
    `.pipe(
      NodeSqliteClient.readOnly,
      Effect.mapError((cause) => new UsageReadError({ cause })),
    );

    const page = rows.slice(0, limit);
    const last = page.at(-1);
    const nextCursor =
      rows.length > limit && last
        ? NodeBuffer.Buffer.from(
            encodeJson({ since, until, boardId, time: last.sort_at, id: last.provider_turn_id }),
          ).toString("base64url")
        : null;
    return { items: page.map(itemFromRow), nextCursor };
  });
  return Usage.of({ list });
});

export const layer = Layer.effect(Usage, make);
