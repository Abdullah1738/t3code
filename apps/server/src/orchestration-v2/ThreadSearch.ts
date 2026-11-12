import * as NodeBuffer from "node:buffer";

import {
  IsoDateTime,
  OrchestrationThreadSearchSource,
  type OrchestrationSearchThreadsInput,
  type OrchestrationSearchThreadsResult,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

export class ThreadSearchError extends Schema.TaggedError<ThreadSearchError>()(
  "ThreadSearchError",
  {
    operation: Schema.Literals(["query", "decode"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Thread search ${this.operation} failed.`;
  }
}

const SEARCH_BUDGET_MS = 5_000;
// 512 rows took 11–102 ms on first-pass ranges of the isolated 11 Nov backup.
const SEARCH_SLICE_SIZE = 512;

const SearchRequest = Schema.Struct({
  pattern: Schema.String,
  first: Schema.Int,
  last: Schema.Int,
  projectId: Schema.UndefinedOr(ProjectId),
});
const SearchRow = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  source: OrchestrationThreadSearchSource,
  matchText: Schema.String,
  messageCreatedAt: IsoDateTime,
  messageId: Schema.String,
  threadUpdatedAt: IsoDateTime,
});

function escapeLikePattern(value: string): string {
  return value.replaceAll("!", "!!").replaceAll("%", "!%").replaceAll("_", "!_");
}

function foldAsciiCase(value: string): string {
  return value.replace(/[A-Z]/g, (character) => character.toLowerCase());
}

function buildSearchSnippet(text: string, query: string): string {
  const normalizedText = text.replace(/\s+/g, " ").trim();
  if (normalizedText.length <= 240) {
    return normalizedText;
  }
  const normalizedQuery = foldAsciiCase(query.replace(/\s+/g, " ").trim());
  const matchIndex = foldAsciiCase(normalizedText).indexOf(normalizedQuery);
  const bodyLength = 236;
  const idealStart = Math.max(0, matchIndex - 72);
  const start = Math.min(idealStart, normalizedText.length - bodyLength);
  const end = Math.min(normalizedText.length, start + bodyLength);
  return `${start > 0 ? "…" : ""}${normalizedText.slice(start, end)}${
    end < normalizedText.length ? "…" : ""
  }`;
}

export class ThreadSearch extends Context.Service<
  ThreadSearch,
  {
    readonly search: (
      input: OrchestrationSearchThreadsInput,
    ) => Effect.Effect<OrchestrationSearchThreadsResult, ThreadSearchError>;
  }
>()("t3/orchestration-v2/ThreadSearch") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.fn("ThreadSearch.make")(function* (
  options: { readonly sliceSize?: number; readonly budgetMs?: number } = {},
) {
  const sql = yield* SqlClient.SqlClient;
  const sliceSize = Math.max(1, Math.floor(options.sliceSize ?? SEARCH_SLICE_SIZE));
  const budgetNanos = BigInt(options.budgetMs ?? SEARCH_BUDGET_MS) * 1_000_000n;
  const searchRows = SqlSchema.findAll({
    Request: SearchRequest,
    Result: SearchRow,
    // CROSS JOIN keeps the bounded rowid range outermost even with project filters.
    execute: ({ pattern, first, last, projectId }) => sql`
        SELECT
          threads.thread_id AS "threadId",
          threads.project_id AS "projectId",
          messages.role AS source,
          json_extract(messages.payload_json, '$.text') AS "matchText",
          messages.created_at AS "messageCreatedAt",
          messages.message_id AS "messageId",
          threads.updated_at AS "threadUpdatedAt"
        FROM orchestration_v2_projection_messages AS messages NOT INDEXED
        CROSS JOIN orchestration_v2_projection_threads AS threads
          ON threads.thread_id = messages.thread_id
        CROSS JOIN projection_projects AS projects
          ON projects.project_id = threads.project_id
        WHERE messages.rowid BETWEEN ${last} AND ${first}
          AND threads.deleted_at IS NULL
          AND threads.archived_at IS NULL
          AND projects.deleted_at IS NULL
          AND ${projectId === undefined ? sql`1` : sql`threads.project_id = ${projectId}`}
          AND messages.streaming = 0
          AND messages.role IN ('user', 'assistant')
          AND json_extract(messages.payload_json, '$.text') LIKE ${pattern} ESCAPE '!'
      `,
  });

  const search: ThreadSearch["Service"]["search"] = Effect.fn("ThreadSearch.search")(
    function* (input) {
      const started = yield* Clock.monotonicTimeNanos;
      const matches = new Map<ThreadId, typeof SearchRow.Type>();
      let cursor: number | undefined;
      let searchedBackTo: typeof IsoDateTime.Type | undefined;
      let complete = false;
      do {
        const slice = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              // Bound the rows before applying LIKE or project/thread filters. LIMIT on
              // matching rows alone can still scan the entire table without yielding.
              const scanned = yield* sql<{ rowid: number; createdAt: typeof IsoDateTime.Type }>`
              SELECT rowid, created_at AS "createdAt"
              FROM orchestration_v2_projection_messages
              WHERE ${cursor === undefined ? sql`1` : sql`rowid < ${cursor}`}
              ORDER BY rowid DESC LIMIT ${sliceSize}
            `;
              const first = scanned[0];
              const last = scanned[scanned.length - 1];
              const rows =
                first === undefined || last === undefined
                  ? []
                  : yield* searchRows({
                      pattern: `%${escapeLikePattern(input.query)}%`,
                      first: first.rowid,
                      last: last.rowid,
                      projectId: input.projectId,
                    });
              return { scanned, rows };
            }),
          )
          .pipe(
            NodeSqliteClient.readOnly,
            NodeSqliteClient.backgroundReads,
            Effect.mapError(
              (cause) =>
                new ThreadSearchError({
                  operation: Schema.isSchemaError(cause) ? "decode" : "query",
                  cause,
                }),
            ),
          );
        for (const row of slice.scanned) {
          if (searchedBackTo === undefined || row.createdAt < searchedBackTo)
            searchedBackTo = row.createdAt;
        }
        for (const row of slice.rows) {
          const previous = matches.get(row.threadId);
          if (
            previous === undefined ||
            (row.source === "user" && previous.source !== "user") ||
            (row.source === previous.source &&
              (row.messageCreatedAt > previous.messageCreatedAt ||
                (row.messageCreatedAt === previous.messageCreatedAt &&
                  compareText(row.messageId, previous.messageId) < 0)))
          ) {
            matches.set(row.threadId, row);
          }
        }
        cursor = slice.scanned[slice.scanned.length - 1]?.rowid;
        complete = slice.scanned.length < sliceSize;
        if (complete) break;
        // A recent matching message does not settle the global order: another
        // thread can have an older user match but a newer thread updated_at.
        if ((yield* Clock.monotonicTimeNanos) - started >= budgetNanos) break;
        yield* Effect.yieldNow;
      } while (cursor !== undefined);
      const rows = [...matches.values()]
        .sort(
          (a, b) =>
            (a.source === b.source ? 0 : a.source === "user" ? -1 : 1) ||
            compareText(b.threadUpdatedAt, a.threadUpdatedAt) ||
            compareText(a.threadId, b.threadId),
        )
        .slice(0, input.limit ?? 50);
      return {
        matches: rows.map((row) => ({
          threadId: row.threadId,
          projectId: row.projectId,
          source: row.source,
          snippet: buildSearchSnippet(row.matchText, input.query),
          messageCreatedAt: row.messageCreatedAt,
        })),
        complete,
        ...(!complete && searchedBackTo !== undefined ? { searchedBackTo } : {}),
      };
    },
  );
  return ThreadSearch.of({ search });
});

function compareText(a: string, b: string): number {
  // Match SQLite BINARY ordering, including IDs outside the BMP.
  return NodeBuffer.Buffer.compare(NodeBuffer.Buffer.from(a), NodeBuffer.Buffer.from(b));
}

export const layer = Layer.effect(ThreadSearch, make());
