/**
 * Maps a native id a hook or tool sees (OpenCode `ses_`, Claude session id plus
 * agent id, Codex thread id) to the exact Robob execution it belongs to.
 *
 * Claude in-process children share their parent's session id and are only
 * told apart by agent id, so a session id alone never names a child. Codex
 * children own a provider thread. Two app threads claiming the same native id
 * is `ambiguous`, never resolved to the newest.
 */
import type { ModelSelection } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as BoardsDatabase from "../persistence/BoardsDatabase.ts";

export class ExecutionIdentityError extends Schema.TaggedError<ExecutionIdentityError>()(
  "ExecutionIdentityError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

export type ExecutionKind = "top-level" | "app-managed-child" | "provider-native-child";
export type IdentityResolution = "resolved" | "pending" | "ambiguous" | "unavailable";

export interface NativeBinding {
  readonly driver: string;
  readonly providerInstanceId: string;
  readonly nativeId: string;
}

export interface ResolveInput {
  readonly nativeId: string;
  readonly driver?: string;
  readonly providerInstanceId?: string;
  readonly agentId?: string;
}

export interface ExecutionIdentityResult {
  readonly resolution: IdentityResolution;
  /** Null unless resolved. */
  readonly robobThreadId: string | null;
  readonly parentThreadId: string | null;
  readonly rootThreadId: string | null;
  readonly executionKind: ExecutionKind | null;
  readonly driver: string | null;
  readonly providerInstanceId: string | null;
  /** The native session that owns the execution (the parent's, for Claude children). */
  readonly nativeSessionId: string | null;
  readonly nativeAgentId: string | null;
  /** Native Claude owner for the next proven in-session ancestry hop. */
  readonly parentNativeAgentId: string | null;
  /** Claude provider session's app thread; not necessarily the global root. */
  readonly nativeOwnerThreadId: string | null;
  readonly model: ModelSelection | null;
  readonly acceptsMessages: boolean;
  /** Thread ids that matched when resolution is ambiguous; empty otherwise. */
  readonly candidates: ReadonlyArray<string>;
}

export interface ExecutionIdentityShape {
  readonly resolve: (
    input: ResolveInput,
  ) => Effect.Effect<ExecutionIdentityResult, ExecutionIdentityError>;
  /** Current native binding per thread, from its active provider thread. */
  readonly currentNative: (
    threadIds: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyMap<string, NativeBinding>, ExecutionIdentityError>;
  /** Every native binding a thread has had, current or historical. */
  readonly aliases: (
    threadId: string,
  ) => Effect.Effect<ReadonlyArray<NativeBinding>, ExecutionIdentityError>;
}

export class ExecutionIdentity extends Context.Service<ExecutionIdentity, ExecutionIdentityShape>()(
  "t3/ardud/identity/ExecutionIdentity",
) {}

// A provider thread with no native id yet is "pending" for this long after its
// last write; the projection keeps no other creation timestamp for it.
const PENDING_WINDOW_DURATION = Duration.seconds(120);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHUNK = 400;

interface ProviderRow {
  readonly provider_thread_id: string;
  readonly thread_id: string | null;
  readonly driver: string | null;
  readonly provider_instance_id: string | null;
  readonly native_id: string | null;
  readonly updated_at: string;
  readonly active: number;
}

interface ThreadRow {
  readonly parent_thread_id: string | null;
  readonly root_thread_id: string | null;
  readonly model_json: string | null;
}

interface SubagentRow {
  readonly thread_id: string;
  readonly child_thread_id: string | null;
  readonly model_json: string | null;
  readonly parent_node_id?: string | null;
}

const parseModel = (json: string | null): ModelSelection | null => {
  if (json === null) return null;
  try {
    return JSON.parse(json) as ModelSelection;
  } catch {
    return null;
  }
};

const chunks = <A>(values: ReadonlyArray<A>): ReadonlyArray<ReadonlyArray<A>> => {
  const out: Array<ReadonlyArray<A>> = [];
  for (let index = 0; index < values.length; index += CHUNK) {
    out.push(values.slice(index, index + CHUNK));
  }
  return out;
};

const unresolved = (
  resolution: Exclude<IdentityResolution, "resolved">,
  candidates: ReadonlyArray<string> = [],
): ExecutionIdentityResult => ({
  resolution,
  robobThreadId: null,
  parentThreadId: null,
  rootThreadId: null,
  executionKind: null,
  driver: null,
  providerInstanceId: null,
  nativeSessionId: null,
  nativeAgentId: null,
  parentNativeAgentId: null,
  nativeOwnerThreadId: null,
  model: null,
  acceptsMessages: false,
  candidates,
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const controlSql = yield* BoardsDatabase.client;
  const fail = (operation: string) => (cause: unknown) =>
    new ExecutionIdentityError({ operation, cause });

  // Same DDL as ControlStore (the shared fork contract), created idempotently.
  yield* BoardsDatabase.initialize(
    controlSql`
    CREATE TABLE IF NOT EXISTS ardud_opencode_import (
      native_session_id TEXT PRIMARY KEY,
      thread_id         TEXT NOT NULL UNIQUE,
      imported_at       TEXT NOT NULL
    )
  `.pipe(Effect.mapError(fail("ensure-opencode-import"))),
  );

  // Sqlite setup runs migrations first; index failures must not prevent startup.
  for (const ensureIndex of [
    sql`
      CREATE INDEX IF NOT EXISTS ardud_idx_provider_threads_native_id
      ON orchestration_v2_projection_provider_threads (json_extract(payload_json, '$.nativeThreadRef.nativeId'))
    `,
    sql`
      CREATE INDEX IF NOT EXISTS ardud_idx_provider_threads_created_at
      ON orchestration_v2_projection_provider_threads (json_extract(payload_json, '$.createdAt'))
    `,
  ]) {
    yield* ensureIndex.pipe(
      Effect.mapError(fail("ensure-identity-indexes")),
      Effect.catch((error) =>
        Effect.logWarning("Failed to ensure execution identity indexes", error),
      ),
    );
  }

  // Driver and instance columns are newer than some rows; fall back to payload.
  const providerRowsFor = (nativeId: string) =>
    sql<ProviderRow>`
      SELECT pt.provider_thread_id, pt.thread_id,
        COALESCE(pt.driver, json_extract(pt.payload_json, '$.driver')) AS driver,
        COALESCE(pt.provider_instance_id, json_extract(pt.payload_json, '$.providerInstanceId')) AS provider_instance_id,
        json_extract(pt.payload_json, '$.nativeThreadRef.nativeId') AS native_id,
        pt.updated_at,
        CASE WHEN t.active_provider_thread_id = pt.provider_thread_id THEN 1 ELSE 0 END AS active
      FROM orchestration_v2_projection_provider_threads pt
      LEFT JOIN orchestration_v2_projection_threads t ON t.thread_id = pt.thread_id
      WHERE json_extract(pt.payload_json, '$.nativeThreadRef.nativeId') = ${nativeId}
    `.pipe(Effect.mapError(fail("read-provider-rows")));

  const providerRowsForThread = (threadId: string) =>
    sql<ProviderRow>`
      SELECT pt.provider_thread_id, pt.thread_id,
        COALESCE(pt.driver, json_extract(pt.payload_json, '$.driver')) AS driver,
        COALESCE(pt.provider_instance_id, json_extract(pt.payload_json, '$.providerInstanceId')) AS provider_instance_id,
        json_extract(pt.payload_json, '$.nativeThreadRef.nativeId') AS native_id,
        pt.updated_at,
        CASE WHEN t.active_provider_thread_id = pt.provider_thread_id THEN 1 ELSE 0 END AS active
      FROM orchestration_v2_projection_provider_threads pt
      LEFT JOIN orchestration_v2_projection_threads t ON t.thread_id = pt.thread_id
      WHERE pt.thread_id = ${threadId}
      ORDER BY pt.updated_at ASC
    `.pipe(Effect.mapError(fail("read-thread-provider-rows")));

  const importedThreadsFor = (nativeId: string) =>
    controlSql<{ readonly thread_id: string }>`
      SELECT thread_id FROM ardud_opencode_import WHERE native_session_id = ${nativeId}
    `.pipe(
      Effect.map((rows) => rows.map((row) => row.thread_id)),
      Effect.mapError(fail("read-import")),
    );

  const importedNativesFor = (threadId: string) =>
    controlSql<{ readonly native_session_id: string }>`
      SELECT native_session_id FROM ardud_opencode_import WHERE thread_id = ${threadId}
    `.pipe(
      Effect.map((rows) => rows.map((row) => row.native_session_id)),
      Effect.mapError(fail("read-import-natives")),
    );

  const threadRow = (threadId: string) =>
    sql<ThreadRow>`
      SELECT json_extract(payload_json, '$.lineage.parentThreadId') AS parent_thread_id,
        json_extract(payload_json, '$.lineage.rootThreadId') AS root_thread_id,
        json_extract(payload_json, '$.modelSelection') AS model_json
      FROM orchestration_v2_projection_threads
      WHERE thread_id = ${threadId}
    `.pipe(
      Effect.map((rows) => rows[0] ?? null),
      Effect.mapError(fail("read-thread")),
    );

  // Claude children have no provider thread of their own. The subagent row is
  // the link, and it must belong to the parent app thread AND to the driver +
  // instance the caller resolved. The agent id alone is not unique across
  // sessions, so the match is only trusted when exactly one row qualifies.
  // Ownership is proven by the child's node: the adapter writes it with the
  // parent's provider thread id (ClaudeAdapterV2.ts ~5482) and the task id as
  // its native item ref. A replacement session in the same instance has a
  // different provider thread, so it can never match an old child's node.
  const subagentsByAgent = (
    threadId: string,
    agentId: string,
    driver: string,
    providerInstanceId: string,
    parentProviderThreadId: string,
  ) =>
    sql<SubagentRow>`
      SELECT s.thread_id, s.child_thread_id, s.parent_node_id,
        json_extract(s.payload_json, '$.modelSelection') AS model_json
      FROM orchestration_v2_projection_subagents AS s
      JOIN orchestration_v2_projection_nodes AS n ON n.node_id = s.subagent_id
      WHERE s.thread_id = ${threadId}
        AND COALESCE(s.driver, json_extract(s.payload_json, '$.driver')) = ${driver}
        AND COALESCE(s.provider_instance_id, json_extract(s.payload_json, '$.providerInstanceId')) = ${providerInstanceId}
        AND json_extract(s.payload_json, '$.nativeTaskRef.nativeId') = ${agentId}
        AND s.origin = 'provider_native'
        AND s.child_thread_id IS NOT NULL
        AND n.kind = 'subagent'
        AND n.provider_thread_id = ${parentProviderThreadId}
    `.pipe(Effect.mapError(fail("read-subagent-by-agent")));

  // Claude's in-process tasks share the root provider thread. Resolve just the
  // immediate owner here; hook policy handles any further ancestry separately.
  const ownerChildThread = (threadId: string, parentNodeId: string) =>
    sql<{
      readonly child_thread_id: string;
      readonly provider_thread_id: string | null;
      readonly native_agent_id: string | null;
    }>`
      SELECT s.child_thread_id, n.provider_thread_id,
        json_extract(s.payload_json, '$.nativeTaskRef.nativeId') AS native_agent_id
      FROM orchestration_v2_projection_subagents AS s
      JOIN orchestration_v2_projection_nodes AS n ON n.node_id = s.subagent_id
      WHERE s.subagent_id = ${parentNodeId}
        AND s.thread_id = ${threadId}
        AND s.origin = 'provider_native'
        AND s.child_thread_id IS NOT NULL
        AND n.kind = 'subagent'
    `.pipe(
      Effect.map((rows) => rows[0] ?? null),
      Effect.mapError(fail("read-owner-child-thread")),
    );

  // Codex children: the subagent row points at the child's own provider thread.
  // Only provider-native children qualify; app-owned delegation also records a
  // provider thread, so `origin` is what separates the two.
  const subagentByProviderThread = (providerThreadId: string) =>
    sql<SubagentRow>`
      SELECT thread_id, child_thread_id, json_extract(payload_json, '$.modelSelection') AS model_json
      FROM orchestration_v2_projection_subagents
      WHERE provider_thread_id = ${providerThreadId}
        AND origin = 'provider_native'
        AND child_thread_id IS NOT NULL
      ORDER BY updated_at DESC
    `.pipe(
      Effect.map((rows) => rows[0] ?? null),
      Effect.mapError(fail("read-subagent-by-provider-thread")),
    );

  // Walks parentThreadId up to the root. The visited set stops cycles; there is
  // no depth cap, so a long chain still ends at its real root.
  const rootOf = Effect.fn("ExecutionIdentity.rootOf")(function* (threadId: string) {
    const start = yield* threadRow(threadId);
    if (start?.root_thread_id) return start.root_thread_id;
    const visited = new Set<string>([threadId]);
    let top = threadId;
    let parent = start?.parent_thread_id ?? null;
    while (parent !== null && !visited.has(parent)) {
      visited.add(parent);
      top = parent;
      parent = (yield* threadRow(parent))?.parent_thread_id ?? null;
    }
    return top;
  });

  // Is there a fresh provider thread still waiting for its native id? That
  // means "not yet", not "unknown".
  const hasPendingProvider = Effect.fn("ExecutionIdentity.hasPendingProvider")(
    function* (driver: string | undefined, instance: string | undefined) {
      const cutoff = DateTime.formatIso(
        DateTime.subtractDuration(yield* DateTime.now, PENDING_WINDOW_DURATION),
      );
      // Measured from the provider's createdAt, not updated_at: a lifecycle
      // write to an old unnamed thread must not restart its pending window.
      const rows = yield* sql<{
        readonly driver: string | null;
        readonly provider_instance_id: string | null;
        readonly native_id: string | null;
      }>`
        SELECT COALESCE(driver, json_extract(payload_json, '$.driver')) AS driver,
          COALESCE(provider_instance_id, json_extract(payload_json, '$.providerInstanceId')) AS provider_instance_id,
          json_extract(payload_json, '$.nativeThreadRef.nativeId') AS native_id
        FROM orchestration_v2_projection_provider_threads
        WHERE json_extract(payload_json, '$.createdAt') >= ${cutoff}
      `;
      return rows.some(
        (row) =>
          (row.native_id === null || row.native_id.startsWith("pending")) &&
          (driver === undefined || row.driver === driver) &&
          (instance === undefined || row.provider_instance_id === instance),
      );
    },
    Effect.mapError(fail("read-pending-providers")),
  );

  const resolve: ExecutionIdentityShape["resolve"] = Effect.fn("ExecutionIdentity.resolve")(
    function* (
      input: ResolveInput,
    ): Effect.fn.Return<ExecutionIdentityResult, ExecutionIdentityError> {
      const providers = (yield* providerRowsFor(input.nativeId)).filter(
        (row) =>
          row.thread_id !== null &&
          (input.driver === undefined || row.driver === input.driver) &&
          (input.providerInstanceId === undefined ||
            row.provider_instance_id === input.providerInstanceId),
      );

      // Sessions the importer adopted are aliases of their thread (OpenCode only).
      const importAllowed =
        (input.driver === undefined || input.driver === "opencode") &&
        (input.providerInstanceId === undefined || input.providerInstanceId === "opencode");
      const imported = importAllowed ? yield* importedThreadsFor(input.nativeId) : [];

      const threadIds = [...new Set([...providers.map((row) => row.thread_id!), ...imported])];
      if (threadIds.length === 0) {
        if (!UUID.test(input.nativeId)) return unresolved("unavailable");
        return (yield* hasPendingProvider(input.driver, input.providerInstanceId))
          ? unresolved("pending")
          : unresolved("unavailable");
      }
      if (threadIds.length > 1) return unresolved("ambiguous", threadIds);

      const threadId = threadIds[0]!;
      const row = providers
        .filter((candidate) => candidate.thread_id === threadId)
        .toSorted((a, b) => b.active - a.active || b.updated_at.localeCompare(a.updated_at))[0];
      const driver = row?.driver ?? "opencode";
      const providerInstanceId = row?.provider_instance_id ?? "opencode";

      if (input.agentId !== undefined) {
        if (row === undefined) return unresolved("unavailable");
        const matches = yield* subagentsByAgent(
          threadId,
          input.agentId,
          driver,
          providerInstanceId,
          row.provider_thread_id,
        );
        const childIds = [...new Set(matches.map((row) => row.child_thread_id!))];
        if (childIds.length > 1) return unresolved("ambiguous", childIds);
        const subagent = matches[0];
        if (subagent === undefined) {
          return (yield* hasPendingProvider(driver, providerInstanceId))
            ? unresolved("pending")
            : unresolved("unavailable");
        }
        const owner = subagent.parent_node_id
          ? yield* ownerChildThread(threadId, subagent.parent_node_id)
          : null;
        if (
          owner !== null &&
          (owner.provider_thread_id !== row.provider_thread_id || !owner.native_agent_id)
        ) {
          return unresolved("unavailable");
        }
        return {
          resolution: "resolved",
          robobThreadId: subagent.child_thread_id,
          parentThreadId: owner?.child_thread_id ?? subagent.thread_id,
          rootThreadId: yield* rootOf(subagent.thread_id),
          executionKind: "provider-native-child",
          driver,
          providerInstanceId,
          nativeSessionId: input.nativeId,
          nativeAgentId: input.agentId,
          parentNativeAgentId: owner?.native_agent_id ?? null,
          nativeOwnerThreadId: threadId,
          model: parseModel(subagent.model_json),
          acceptsMessages: false,
          candidates: [],
        };
      }

      if (row !== undefined) {
        const child = yield* subagentByProviderThread(row.provider_thread_id);
        if (child !== null) {
          return {
            resolution: "resolved",
            robobThreadId: child.child_thread_id,
            parentThreadId: child.thread_id,
            rootThreadId: yield* rootOf(child.thread_id),
            executionKind: "provider-native-child",
            driver,
            providerInstanceId,
            nativeSessionId: input.nativeId,
            nativeAgentId: null,
            parentNativeAgentId: null,
            nativeOwnerThreadId: null,
            model: parseModel(child.model_json),
            acceptsMessages: true,
            candidates: [],
          };
        }
      }

      const thread = yield* threadRow(threadId);
      const parentThreadId = thread?.parent_thread_id ?? null;
      return {
        resolution: "resolved",
        robobThreadId: threadId,
        parentThreadId,
        rootThreadId: yield* rootOf(threadId),
        executionKind: parentThreadId === null ? "top-level" : "app-managed-child",
        driver,
        providerInstanceId,
        nativeSessionId: input.nativeId,
        nativeAgentId: null,
        parentNativeAgentId: null,
        nativeOwnerThreadId: null,
        model: parseModel(thread?.model_json ?? null),
        acceptsMessages: true,
        candidates: [],
      };
    },
    // Both writes and large shell snapshots can outlast offbox's lookup timeout.
    NodeSqliteClient.identityReadOnly,
  );

  const currentNative: ExecutionIdentityShape["currentNative"] = (threadIds) =>
    Effect.forEach(
      chunks([...new Set(threadIds)]),
      (ids) =>
        sql<{
          readonly thread_id: string;
          readonly driver: string | null;
          readonly provider_instance_id: string | null;
          readonly native_id: string | null;
        }>`
          SELECT t.thread_id,
            COALESCE(pt.driver, json_extract(pt.payload_json, '$.driver')) AS driver,
            COALESCE(pt.provider_instance_id, json_extract(pt.payload_json, '$.providerInstanceId')) AS provider_instance_id,
            json_extract(pt.payload_json, '$.nativeThreadRef.nativeId') AS native_id
          FROM orchestration_v2_projection_threads t
          JOIN orchestration_v2_projection_provider_threads pt
            ON pt.provider_thread_id = t.active_provider_thread_id
          WHERE t.thread_id IN ${sql.in(ids)}
        `,
      { concurrency: 1 },
    ).pipe(
      Effect.map((pages) => {
        const out = new Map<string, NativeBinding>();
        for (const row of pages.flat()) {
          if (row.driver !== null && row.provider_instance_id !== null && row.native_id !== null) {
            out.set(row.thread_id, {
              driver: row.driver,
              providerInstanceId: row.provider_instance_id,
              nativeId: row.native_id,
            });
          }
        }
        return out;
      }),
      Effect.mapError(fail("current-native")),
    );

  const aliases: ExecutionIdentityShape["aliases"] = Effect.fn("ExecutionIdentity.aliases")(
    function* (threadId) {
      const providers = yield* providerRowsForThread(threadId);
      const imported = yield* importedNativesFor(threadId);
      const seen = new Map<string, NativeBinding>();
      for (const row of providers) {
        if (row.driver !== null && row.provider_instance_id !== null && row.native_id !== null) {
          seen.set(`${row.driver}|${row.provider_instance_id}|${row.native_id}`, {
            driver: row.driver,
            providerInstanceId: row.provider_instance_id,
            nativeId: row.native_id,
          });
        }
      }
      for (const nativeId of imported) {
        seen.set(`opencode|opencode|${nativeId}`, {
          driver: "opencode",
          providerInstanceId: "opencode",
          nativeId,
        });
      }
      return [...seen.values()];
    },
  );

  return ExecutionIdentity.of({ resolve, currentNative, aliases });
});

export const layer = Layer.effect(ExecutionIdentity, make);
