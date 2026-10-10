/**
 * Shows OpenCode 2 sessions as T3 threads. Each root session becomes a thread
 * bound to its native session, so a new message continues that same session.
 * Only metadata is copied up front; a thread's transcript is read from
 * OpenCode the first time the thread is opened, and topped up on later opens
 * until T3 itself runs a turn on it.
 */
import * as NodeOS from "node:os";

import {
  CommandId,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  EventId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
  type ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as KeyedLock from "@t3tools/shared/KeyedLock";

import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import { makeSubagentChildThread } from "@t3tools/provider-core/server/subagentProjection";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as OpenCodeHttp from "./OpenCodeHttp.ts";
import {
  IMPORT_PREFIX,
  OPENCODE_DRIVER,
  historyEvents,
  importedThreadId,
  millis,
  projectRootFor,
  sessionModelSelection,
  sessionOrigin,
  sessionTitle,
  subagentCalls,
  truncationNotice,
} from "./transcript.ts";

/** Newest messages read into a transcript the first time a thread opens. */
export const TRANSCRIPT_MESSAGE_LIMIT = 300;
const THREAD_BATCH_SIZE = 100;
const EVENT_BATCH_SIZE = 250;
/** Positions below every run's range (runs start at 1_000_000). */
const FIRST_HISTORY_ORDINAL = 10;
const RUN_ORDINAL_FLOOR = 1_000_000;
/** Sessions this young may still be getting bound by T3 itself. */
const MIN_SESSION_AGE_MS = 2 * 60 * 1000;
const SETTLE_AFTER_MS = 24 * 60 * 60 * 1000;
const OPENCODE_INSTANCE = ProviderInstanceId.make("opencode");

export class OpenCodeImportError extends Schema.TaggedError<OpenCodeImportError>()(
  "OpenCodeImportError",
  {
    operation: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const cause =
      this.cause instanceof Error
        ? this.cause.message
        : this.cause === undefined
          ? ""
          : String(this.cause);
    return `OpenCode import failed: ${this.operation}${cause ? ` (${cause})` : ""}.`;
  }
}

const isOpenCodeImportError = Schema.is(OpenCodeImportError);

export interface OpenCodeImportOptions {
  /** Only sessions updated within this many days. */
  readonly sinceDays?: number;
  readonly dryRun?: boolean;
  /** At most this many sessions, newest first. */
  readonly limit?: number;
}

export interface OpenCodeImportResult {
  readonly scanned: number;
  readonly created: number;
  readonly updated: number;
  readonly unchanged: number;
  readonly skipped: number;
  readonly projectsCreated: number;
  readonly failed: number;
  readonly durationMs: number;
  readonly dryRun: boolean;
}

export interface OpenCodeImporterShape {
  readonly run: (
    options?: OpenCodeImportOptions,
  ) => Effect.Effect<OpenCodeImportResult, OpenCodeImportError>;
  /** Pulls an imported thread's transcript from OpenCode. A no-op for other threads. */
  readonly ensureTranscript: (threadId: ThreadId) => Effect.Effect<void>;
}

export class OpenCodeImporter extends Context.Service<OpenCodeImporter, OpenCodeImporterShape>()(
  "t3/ardud/opencode-import/OpenCodeImporter",
) {}

interface ImportRow {
  readonly native_session_id: string;
  readonly thread_id: string;
  readonly session_updated_ms: number | null;
  readonly title: string | null;
  readonly archived: number | null;
}

const ensureTables = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    // Shared with the other fork workers; identical DDL (tmp/memory/shared-contracts.md).
    yield* sql`
      CREATE TABLE IF NOT EXISTS ardud_thread_origin (
        thread_id   TEXT PRIMARY KEY,
        origin      TEXT NOT NULL,
        created_at  TEXT NOT NULL
      )
    `;
    yield* sql`
      CREATE TABLE IF NOT EXISTS ardud_opencode_import (
        native_session_id TEXT PRIMARY KEY,
        thread_id         TEXT NOT NULL UNIQUE,
        imported_at       TEXT NOT NULL
      )
    `;
    // Importer-only state: what a thread last mirrored, and how far its
    // transcript was read.
    yield* sql`
      CREATE TABLE IF NOT EXISTS ardud_opencode_import_state (
        native_session_id   TEXT PRIMARY KEY,
        thread_id           TEXT NOT NULL,
        session_updated_ms  INTEGER,
        title               TEXT,
        archived            INTEGER,
        transcript_head     TEXT,
        transcript_at       TEXT
      )
    `;
  });

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const eventSink = yield* EventSink.EventSinkV2;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  // Optional so the hook can sit under layers built before projects exist.
  const projectService = yield* Effect.serviceOption(ProjectService.ProjectService);
  const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
  const settings = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
  const runLock = yield* Semaphore.make(1);
  const transcriptLocks = yield* KeyedLock.make<ThreadId>();
  // Threads whose transcript this process already brought up to date.
  const freshTranscripts = new Set<ThreadId>();
  // Thread id -> native session id, or null for threads this importer does not own.
  const sessionsByThread = new Map<ThreadId, string | null>();

  yield* ensureTables(sql).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("Could not create the OpenCode import tables", { cause }),
    ),
  );

  const fileSystem = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const connection = OpenCodeHttp.resolveConnection({ settings, homeDir: NodeOS.homedir() }).pipe(
    Effect.provideService(FileSystem.FileSystem, fileSystem),
    Effect.provideService(Path.Path, pathService),
  );

  /** The model a session with no recorded model gets. */
  const fallbackSelection = Effect.gen(function* () {
    const fallback: ModelSelection = {
      instanceId: OPENCODE_INSTANCE,
      model: DEFAULT_MODEL_BY_PROVIDER[OPENCODE_DRIVER] ?? "openai/gpt-5",
    };
    if (Option.isNone(settings)) return fallback;
    const current = yield* settings.value.getSettings.pipe(Effect.option);
    const selection = Option.isSome(current) ? current.value.defaultModelSelection : undefined;
    return selection?.instanceId === OPENCODE_INSTANCE ? selection : fallback;
  });

  const readImportRows = sql<ImportRow>`
    SELECT
      mapping.native_session_id,
      mapping.thread_id,
      state.session_updated_ms,
      state.title,
      state.archived
    FROM ardud_opencode_import AS mapping
    LEFT JOIN ardud_opencode_import_state AS state
      ON state.native_session_id = mapping.native_session_id
  `;

  // Sessions T3 already shows: bound to threads this importer did not create.
  const readBoundSessions = sql<{ readonly native_id: string }>`
    SELECT DISTINCT json_extract(payload_json, '$.nativeThreadRef.nativeId') AS native_id
    FROM orchestration_v2_projection_provider_threads
    WHERE driver = 'opencode'
      AND json_extract(payload_json, '$.nativeThreadRef.nativeId') IS NOT NULL
      AND (thread_id IS NULL OR thread_id NOT LIKE ${`${IMPORT_PREFIX}:%`})
  `;

  /** The T3 project for a project root: an existing one, else a new one. */
  const projectFor = (
    root: { readonly path: string; readonly title: string },
    cache: Map<string, ProjectId | null>,
    counters: { projectsCreated: number },
    dryRun: boolean,
  ) =>
    Effect.gen(function* () {
      const cached = cache.get(root.path);
      if (cached !== undefined) return cached;
      if (Option.isNone(projectService)) {
        return yield* new OpenCodeImportError({ operation: "projects are unavailable" });
      }
      const projects = projectService.value;
      const existing = yield* projects.getByWorkspaceRoot(root.path).pipe(Effect.option);
      if (Option.isSome(existing) && Option.isSome(existing.value)) {
        cache.set(root.path, existing.value.value.id);
        return existing.value.value.id;
      }
      if (dryRun) {
        counters.projectsCreated += 1;
        const placeholder = ProjectId.make(`${IMPORT_PREFIX}:dry-run:${root.path}`);
        cache.set(root.path, placeholder);
        return placeholder;
      }
      const created = yield* projects
        .bootstrap({
          commandId: CommandId.make(`${IMPORT_PREFIX}:project:${root.path}`),
          projectId: ProjectId.make(`${IMPORT_PREFIX}:project:${root.path}`),
          title: root.title,
          workspaceRoot: root.path,
        })
        .pipe(
          Effect.tapError((cause) =>
            Effect.logWarning("Could not create a project for imported OpenCode sessions", {
              root: root.path,
              cause,
            }),
          ),
          Effect.option,
        );
      if (Option.isNone(created)) {
        cache.set(root.path, null);
        return null;
      }
      if (created.value.created) counters.projectsCreated += 1;
      cache.set(root.path, created.value.project.id);
      return created.value.project.id;
    });

  const providerThreadFor = (input: {
    readonly sessionId: string;
    readonly threadId: ThreadId;
    readonly ownerNodeId: NodeId | null;
    readonly at: DateTime.Utc;
  }): OrchestrationV2ProviderThread => ({
    id: idAllocator.derive.providerThread({
      driver: OPENCODE_DRIVER,
      providerInstanceId: OPENCODE_INSTANCE,
      nativeThreadId: input.sessionId,
    }),
    driver: OPENCODE_DRIVER,
    providerInstanceId: OPENCODE_INSTANCE,
    providerSessionId: null,
    appThreadId: input.threadId,
    ownerNodeId: input.ownerNodeId,
    nativeThreadRef: { driver: OPENCODE_DRIVER, nativeId: input.sessionId, strength: "strong" },
    nativeConversationHeadRef: null,
    status: "not_loaded",
    firstRunOrdinal: null,
    lastRunOrdinal: null,
    handoffIds: [],
    forkedFrom: null,
    pendingBackgroundTasks: [],
    createdAt: input.at,
    updatedAt: input.at,
  });

  const recordMapping = (input: {
    readonly sessionId: string;
    readonly threadId: ThreadId;
    readonly origin: string | null;
    readonly sessionUpdatedMs: number | null;
    readonly title: string | null;
    readonly archived: number | null;
  }) =>
    Effect.gen(function* () {
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* sql`
        INSERT INTO ardud_opencode_import (native_session_id, thread_id, imported_at)
        VALUES (${input.sessionId}, ${input.threadId}, ${now})
        ON CONFLICT(native_session_id) DO NOTHING
      `;
      yield* sql`
        INSERT INTO ardud_opencode_import_state (
          native_session_id, thread_id, session_updated_ms, title, archived
        )
        VALUES (
          ${input.sessionId}, ${input.threadId}, ${input.sessionUpdatedMs},
          ${input.title}, ${input.archived}
        )
        ON CONFLICT(native_session_id) DO UPDATE SET
          session_updated_ms = excluded.session_updated_ms,
          title = excluded.title,
          archived = excluded.archived
      `;
      if (input.origin !== null) {
        yield* sql`
          INSERT INTO ardud_thread_origin (thread_id, origin, created_at)
          VALUES (${input.threadId}, ${input.origin}, ${now})
          ON CONFLICT(thread_id) DO NOTHING
        `;
      }
      sessionsByThread.set(input.threadId, input.sessionId);
    }).pipe(
      Effect.mapError((cause) => new OpenCodeImportError({ operation: "record mapping", cause })),
    );

  /** Drops events the store already has, so an interrupted write can be retried. */
  const unwritten = (threadId: ThreadId, events: ReadonlyArray<OrchestrationV2DomainEvent>) =>
    Effect.gen(function* () {
      if (events.length === 0) return events;
      const rows = yield* sql<{ readonly event_id: string }>`
        SELECT event_id FROM orchestration_events
        WHERE application_event_version = 2
          AND aggregate_kind = 'thread'
          AND stream_id = ${threadId}
          AND event_id LIKE ${`${IMPORT_PREFIX}:%`}
      `;
      const existing = new Set(rows.map((row) => row.event_id));
      return events.filter((event) => !existing.has(event.id));
    });

  const run: OpenCodeImporterShape["run"] = (options = {}) =>
    runLock
      .withPermit(
        Effect.gen(function* () {
          const started = yield* Clock.currentTimeMillis;
          const dryRun = options.dryRun === true;
          const conn = yield* connection;
          const updatedSince =
            options.sinceDays === undefined
              ? undefined
              : started - options.sinceDays * 24 * 60 * 60 * 1000;
          const [sessions, openCodeProjects] = yield* Effect.all(
            [
              OpenCodeHttp.listRootSessions(
                conn,
                updatedSince === undefined ? {} : { updatedSince },
              ),
              OpenCodeHttp.listProjects(conn).pipe(Effect.orElseSucceed(() => [])),
            ],
            { concurrency: 2 },
          );
          const availableModels = yield* OpenCodeHttp.listModelSlugs(conn, NodeOS.homedir()).pipe(
            Effect.tapError((cause) =>
              Effect.logWarning("Could not read OpenCode's models; keeping session models", {
                cause,
              }),
            ),
            Effect.orElseSucceed(() => new Set<string>()),
          );
          const canonicalByProject = new Map(
            openCodeProjects.map((project) => [project.id, project.canonical] as const),
          );
          const limited =
            options.limit === undefined ? sessions : sessions.slice(0, Math.max(0, options.limit));
          const fallback = yield* fallbackSelection;
          const imported = new Map(
            (yield* readImportRows).map((row) => [row.native_session_id, row] as const),
          );
          const bound = new Set((yield* readBoundSessions).map((row) => row.native_id));
          const projectCache = new Map<string, ProjectId | null>();
          const counters = {
            created: 0,
            updated: 0,
            unchanged: 0,
            skipped: 0,
            failed: 0,
            projectsCreated: 0,
          };

          const pending: Array<{
            readonly threadId: ThreadId;
            readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
            readonly after: Effect.Effect<void, OpenCodeImportError>;
          }> = [];

          const flush = Effect.gen(function* () {
            if (pending.length === 0) return;
            const batch = pending.splice(0, pending.length);
            const events = batch.flatMap((entry) => entry.events);
            const written = yield* Effect.result(
              events.length === 0 ? Effect.void : eventSink.write({ events }),
            );
            if (written._tag === "Success") {
              yield* Effect.forEach(batch, (entry) => entry.after, { discard: true });
              return;
            }
            // One bad thread fails the whole batch; retry its threads one by one.
            for (const entry of batch) {
              const single = yield* Effect.result(
                Effect.gen(function* () {
                  const remaining = yield* unwritten(entry.threadId, entry.events);
                  if (remaining.length > 0) yield* eventSink.write({ events: remaining });
                  yield* entry.after;
                }),
              );
              if (single._tag === "Failure") {
                counters.failed += 1;
                yield* Effect.logWarning("Could not import an OpenCode session", {
                  threadId: entry.threadId,
                  cause: single.failure,
                });
              }
            }
          });

          for (const session of limited) {
            const existing = imported.get(session.id);
            const title = sessionTitle(session);
            const archived = session.time.archived === undefined ? 0 : 1;
            if (existing === undefined) {
              if (bound.has(session.id) || started - session.time.created < MIN_SESSION_AGE_MS) {
                counters.skipped += 1;
                continue;
              }
              const root = projectRootFor(session, canonicalByProject.get(session.projectID ?? ""));
              // A deleted folder cannot be a project; use its nearest parent instead.
              let projectId = yield* projectFor(root, projectCache, counters, dryRun);
              for (
                let parent = pathService.dirname(root.path);
                projectId === null && parent !== pathService.dirname(parent);
                parent = pathService.dirname(parent)
              ) {
                projectId = yield* projectFor(
                  { path: parent, title: pathService.basename(parent) },
                  projectCache,
                  counters,
                  dryRun,
                );
              }
              if (projectId === null) {
                counters.skipped += 1;
                continue;
              }
              counters.created += 1;
              if (dryRun) continue;
              const threadId = importedThreadId(session.id);
              const createdAt = millis(session.time.created);
              const updatedAt = millis(session.time.updated);
              const providerThread = providerThreadFor({
                sessionId: session.id,
                threadId,
                ownerNodeId: null,
                at: updatedAt,
              });
              const settled = started - session.time.updated > SETTLE_AFTER_MS;
              const thread: OrchestrationV2AppThread = {
                createdBy: "user",
                creationSource: "server",
                id: threadId,
                projectId,
                title,
                providerInstanceId: OPENCODE_INSTANCE,
                modelSelection: sessionModelSelection(
                  session,
                  OPENCODE_INSTANCE,
                  fallback,
                  availableModels,
                ),
                runtimeMode: DEFAULT_RUNTIME_MODE,
                interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
                branch: null,
                // The thread runs in the session's own directory, so continuing it
                // never moves the native session.
                worktreePath:
                  root.path === session.location.directory ? null : session.location.directory,
                linkedPullRequest: null,
                branchPullRequest: null,
                activeProviderThreadId: providerThread.id,
                lineage: {
                  parentThreadId: null,
                  relationshipToParent: null,
                  rootThreadId: threadId,
                },
                forkedFrom: null,
                createdAt,
                updatedAt,
                archivedAt: archived === 1 ? millis(session.time.archived!) : null,
                settledOverride: settled ? "settled" : null,
                settledAt: settled ? updatedAt : null,
                unsettledAt: null,
                snoozedUntil: null,
                snoozedAt: null,
                pinnedAt: null,
                pinOrderKey: null,
                activeOrderKey: null,
                lastVisitedAt: updatedAt,
                deletedAt: null,
              };
              const after = recordMapping({
                sessionId: session.id,
                threadId,
                origin: sessionOrigin(session),
                sessionUpdatedMs: session.time.updated,
                title,
                archived,
              });
              // A run cut short after writing the thread only lacks its mapping.
              const alreadyWritten = yield* projectionStore.getThread(threadId).pipe(Effect.option);
              pending.push({
                threadId,
                events: Option.isSome(alreadyWritten)
                  ? []
                  : [
                      {
                        id: EventId.make(`${IMPORT_PREFIX}:thread:${threadId}:created`),
                        type: "thread.created",
                        threadId,
                        providerInstanceId: OPENCODE_INSTANCE,
                        occurredAt: createdAt,
                        payload: thread,
                      },
                      {
                        id: EventId.make(`${IMPORT_PREFIX}:provider-thread:${threadId}`),
                        type: "provider-thread.updated",
                        threadId,
                        driver: OPENCODE_DRIVER,
                        providerInstanceId: OPENCODE_INSTANCE,
                        occurredAt: updatedAt,
                        payload: providerThread,
                      },
                    ],
                after,
              });
            } else {
              if (
                existing.session_updated_ms === session.time.updated &&
                existing.title === title &&
                existing.archived === archived
              ) {
                counters.unchanged += 1;
                continue;
              }
              const threadId = existing.thread_id as ThreadId;
              const thread = yield* projectionStore.getThread(threadId).pipe(Effect.option);
              if (Option.isNone(thread) || thread.value.deletedAt !== null) {
                counters.skipped += 1;
                continue;
              }
              // Mirror only what T3 has not changed itself since the last import.
              const events: Array<OrchestrationV2DomainEvent> = [];
              let next = thread.value;
              if (existing.title !== title && (existing.title ?? next.title) === next.title) {
                next = { ...next, title };
                events.push({
                  id: EventId.make(`${IMPORT_PREFIX}:title:${threadId}:${session.time.updated}`),
                  type: "thread.metadata-updated",
                  threadId,
                  occurredAt: next.updatedAt,
                  payload: next,
                });
              }
              if (
                existing.archived !== null &&
                existing.archived !== archived &&
                (next.archivedAt === null) === (existing.archived === 0)
              ) {
                next = {
                  ...next,
                  archivedAt: archived === 1 ? millis(session.time.archived!) : null,
                };
                events.push({
                  id: EventId.make(
                    `${IMPORT_PREFIX}:${archived === 1 ? "archive" : "unarchive"}:${threadId}:${session.time.updated}`,
                  ),
                  type: archived === 1 ? "thread.archived" : "thread.unarchived",
                  threadId,
                  occurredAt: next.updatedAt,
                  payload: next,
                });
              }
              counters.updated += 1;
              if (dryRun) continue;
              // New messages since: read them on the next open.
              freshTranscripts.delete(threadId);
              pending.push({
                threadId,
                events,
                after: sql`
                UPDATE ardud_opencode_import_state
                SET session_updated_ms = ${session.time.updated},
                    title = ${title},
                    archived = ${archived}
                WHERE native_session_id = ${session.id}
              `.pipe(
                  Effect.asVoid,
                  Effect.mapError(
                    (cause) => new OpenCodeImportError({ operation: "record update", cause }),
                  ),
                ),
              });
            }
            if (pending.length >= THREAD_BATCH_SIZE) {
              yield* flush;
              yield* Effect.yieldNow;
            }
          }
          yield* flush;

          return {
            scanned: limited.length,
            ...counters,
            durationMs: (yield* Clock.currentTimeMillis) - started,
            dryRun,
          } satisfies OpenCodeImportResult;
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          isOpenCodeImportError(cause)
            ? cause
            : new OpenCodeImportError({ operation: "run", cause }),
        ),
      );

  const lookupSession = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const known = sessionsByThread.get(threadId);
      if (known !== undefined) return known;
      const rows = yield* sql<{ readonly native_session_id: string }>`
        SELECT native_session_id FROM ardud_opencode_import WHERE thread_id = ${threadId} LIMIT 1
      `;
      const sessionId = rows[0]?.native_session_id ?? null;
      sessionsByThread.set(threadId, sessionId);
      return sessionId;
    });

  /** Child threads for the subagent calls in a transcript, as read-only subagent threads. */
  const childThreadEvents = (
    parent: OrchestrationV2AppThread,
    calls: ReturnType<typeof subagentCalls>,
  ) =>
    Effect.gen(function* () {
      const events: Array<OrchestrationV2DomainEvent> = [];
      const mappings: Array<Effect.Effect<void, OpenCodeImportError>> = [];
      const origin = yield* sql<{ readonly origin: string }>`
        SELECT origin FROM ardud_thread_origin WHERE thread_id = ${parent.id} LIMIT 1
      `.pipe(Effect.map((rows) => rows[0]?.origin ?? null));
      for (const call of calls) {
        if ((yield* lookupSession(call.childThreadId)) !== null) continue;
        if (Option.isSome(yield* projectionStore.getThread(call.childThreadId).pipe(Effect.option)))
          continue;
        const providerThread = providerThreadFor({
          sessionId: call.sessionId,
          threadId: call.childThreadId,
          ownerNodeId: null,
          at: call.at,
        });
        const child: OrchestrationV2AppThread = {
          ...makeSubagentChildThread({
            parentThread: parent,
            childThreadId: call.childThreadId,
            parentNodeId: NodeId.make(`${IMPORT_PREFIX}:subagent:${call.sessionId}`),
            activeProviderThreadId: providerThread.id,
            providerInstanceId: OPENCODE_INSTANCE,
            modelSelection: parent.modelSelection,
            title: call.title,
            now: call.at,
            createdBy: "agent",
            creationSource: "provider",
          }),
          forkedFrom: null,
          lastVisitedAt: call.at,
        };
        events.push(
          {
            id: EventId.make(`${IMPORT_PREFIX}:thread:${call.childThreadId}:created`),
            type: "thread.created",
            threadId: call.childThreadId,
            providerInstanceId: OPENCODE_INSTANCE,
            occurredAt: call.at,
            payload: child,
          },
          {
            id: EventId.make(`${IMPORT_PREFIX}:provider-thread:${call.childThreadId}`),
            type: "provider-thread.updated",
            threadId: call.childThreadId,
            driver: OPENCODE_DRIVER,
            providerInstanceId: OPENCODE_INSTANCE,
            occurredAt: call.at,
            payload: providerThread,
          },
        );
        mappings.push(
          recordMapping({
            sessionId: call.sessionId,
            threadId: call.childThreadId,
            origin,
            sessionUpdatedMs: null,
            title: null,
            archived: null,
          }),
        );
      }
      return { events, mappings };
    });

  /**
   * Reads the session's newest messages into runless history. Later reads add
   * only messages that arrived after the last one read. Once T3 has run a turn
   * on the thread, the adapter records new messages itself.
   */
  const hydrate = (threadId: ThreadId, sessionId: string) =>
    Effect.gen(function* () {
      const state = yield* sql<{ readonly transcript_head: string | null }>`
        SELECT transcript_head FROM ardud_opencode_import_state
        WHERE native_session_id = ${sessionId} LIMIT 1
      `;
      const head = state[0]?.transcript_head ?? null;
      const runs = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM orchestration_v2_projection_runs WHERE thread_id = ${threadId}
      `;
      if (head !== null && (runs[0]?.count ?? 0) > 0) return;
      const parent = yield* projectionStore.getThread(threadId);
      const conn = yield* connection;
      const { messages, truncated } = yield* OpenCodeHttp.listRecentMessages(conn, sessionId, {
        limit: TRANSCRIPT_MESSAGE_LIMIT,
        ...(head === null ? {} : { afterId: head }),
      });
      if (messages.length > 0) {
        const lastOrdinal = yield* sql<{ readonly ordinal: number | null }>`
          SELECT MAX(ordinal) AS ordinal FROM orchestration_v2_turn_item_positions
          WHERE thread_id = ${threadId} AND ordinal < ${RUN_ORDINAL_FLOOR}
        `;
        const firstOrdinal = Math.max(FIRST_HISTORY_ORDINAL, (lastOrdinal[0]?.ordinal ?? 0) + 1);
        const context = {
          threadId,
          instanceId: OPENCODE_INSTANCE,
          childThreadId: (childSessionId: string) =>
            idAllocator.derive.threadFromProviderThread({
              driver: OPENCODE_DRIVER,
              providerInstanceId: OPENCODE_INSTANCE,
              nativeThreadId: childSessionId,
            }),
        };
        const history = historyEvents({ ...context, messages, firstOrdinal });
        const notice =
          head === null && truncated
            ? truncationNotice({
                threadId,
                sessionId,
                at: millis(messages[0]!.time.created),
                shown: messages.length,
              })
            : undefined;
        const children =
          parent.lineage.relationshipToParent === "subagent"
            ? { events: [], mappings: [] }
            : yield* childThreadEvents(parent, subagentCalls({ ...context, messages }));

        // Positions first: the sink keeps a supplied position for a known item.
        yield* sql.withTransaction(
          Effect.forEach(
            [
              ...(notice === undefined ? [] : [{ turnItemId: notice.turnItemId, ordinal: 1 }]),
              ...history.positions,
            ],
            (position) => sql`
              INSERT INTO orchestration_v2_turn_item_positions (thread_id, turn_item_id, ordinal)
              VALUES (${threadId}, ${position.turnItemId}, ${position.ordinal})
              ON CONFLICT(thread_id, turn_item_id) DO NOTHING
            `,
            { discard: true },
          ),
        );
        if (children.events.length > 0) {
          yield* eventSink.write({ events: children.events });
          yield* Effect.forEach(children.mappings, (mapping) => mapping, { discard: true });
        }
        const events = yield* unwritten(threadId, [
          ...(notice === undefined ? [] : [notice.event]),
          ...history.events,
        ]);
        for (let index = 0; index < events.length; index += EVENT_BATCH_SIZE) {
          yield* eventSink.write({ events: events.slice(index, index + EVENT_BATCH_SIZE) });
          yield* Effect.yieldNow;
        }
      }
      const newest = messages.at(-1)?.id ?? head;
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* sql`
        UPDATE ardud_opencode_import_state
        SET transcript_head = ${newest}, transcript_at = ${now}
        WHERE native_session_id = ${sessionId}
      `;
    });

  const ensureTranscript: OpenCodeImporterShape["ensureTranscript"] = (threadId) =>
    freshTranscripts.has(threadId)
      ? Effect.void
      : Effect.gen(function* () {
          const sessionId = yield* lookupSession(threadId);
          if (sessionId === null) {
            freshTranscripts.add(threadId);
            return;
          }
          yield* transcriptLocks.withLock(
            threadId,
            Effect.suspend(() =>
              freshTranscripts.has(threadId)
                ? Effect.void
                : hydrate(threadId, sessionId).pipe(
                    Effect.tap(() => Effect.sync(() => freshTranscripts.add(threadId))),
                  ),
            ),
          );
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not load an imported OpenCode transcript", {
              threadId,
              cause,
            }),
          ),
        );

  return OpenCodeImporter.of({ run, ensureTranscript });
});

export const layer = Layer.effect(OpenCodeImporter, make);
