import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as Sqlite from "../../persistence/Sqlite.ts";
import * as ExecutionIdentity from "./ExecutionIdentity.ts";

const provider = (
  providerThreadId: string,
  threadId: string,
  driver: string,
  nativeId: string | null,
  updatedAt: string,
  instance = driver === "opencode" ? "opencode" : driver,
) => ({
  provider_thread_id: providerThreadId,
  thread_id: threadId,
  owner_node_id: null,
  provider: driver,
  provider_session_id: null,
  status: "idle",
  first_run_ordinal: 1,
  last_run_ordinal: 1,
  updated_at: updatedAt,
  driver,
  provider_instance_id: instance,
  payload_json: JSON.stringify({
    id: providerThreadId,
    driver,
    providerInstanceId: instance,
    appThreadId: threadId,
    nativeThreadRef: nativeId === null ? null : { driver, nativeId, strength: "strong" },
  }),
});

const thread = (
  threadId: string,
  activeProviderThreadId: string | null,
  lineage: { parentThreadId: string | null; rootThreadId: string; relationshipToParent?: string | null },
  model = { instanceId: "opencode", model: "opus/claude-opus-5-5" },
) => ({
  thread_id: threadId,
  project_id: "project",
  title: threadId,
  default_provider: "opencode",
  runtime_mode: "full-access",
  interaction_mode: "default",
  active_provider_thread_id: activeProviderThreadId,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  archived_at: null,
  deleted_at: null,
  provider_instance_id: "opencode",
  payload_json: JSON.stringify({
    lineage: { relationshipToParent: null, ...lineage },
    activeProviderThreadId,
    modelSelection: model,
  }),
});

const subagent = (
  subagentId: string,
  threadId: string,
  childThreadId: string,
  providerThreadId: string | null,
  driver: string,
  nativeTaskId: string | null,
  model = { instanceId: "claude", model: "claude-haiku-5-5" },
) => ({
  subagent_id: subagentId,
  thread_id: threadId,
  run_id: null,
  parent_node_id: "node",
  provider: driver,
  provider_thread_id: providerThreadId,
  child_thread_id: childThreadId,
  origin: "provider_native",
  status: "running",
  started_at: "2026-01-01T00:00:00.000Z",
  completed_at: null,
  updated_at: "2026-01-01T00:00:00.000Z",
  driver,
  provider_instance_id: driver,
  payload_json: JSON.stringify({
    id: subagentId,
    threadId,
    childThreadId,
    providerThreadId,
    nativeTaskRef:
      nativeTaskId === null ? null : { driver, nativeId: nativeTaskId, strength: "strong" },
    modelSelection: model,
  }),
});

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const insertThread = (row: ReturnType<typeof thread>) =>
    sql`INSERT INTO orchestration_v2_projection_threads ${sql.insert(row)}`;
  const insertProvider = (row: ReturnType<typeof provider>) =>
    sql`INSERT INTO orchestration_v2_projection_provider_threads ${sql.insert(row)}`;
  const insertSubagent = (row: ReturnType<typeof subagent>) =>
    sql`INSERT INTO orchestration_v2_projection_subagents ${sql.insert(row)}`;
  const insertImport = (nativeId: string, threadId: string) =>
    sql`INSERT INTO ardud_opencode_import ${sql.insert({
      native_session_id: nativeId,
      thread_id: threadId,
      imported_at: "2026-01-01T00:00:00.000Z",
    })}`;

  // Top-level OpenCode thread.
  yield* insertThread(thread("t-oc", "pt-oc", { parentThreadId: null, rootThreadId: "t-oc" }));
  yield* insertProvider(provider("pt-oc", "t-oc", "opencode", "ses_top", "2026-01-01T00:00:00.000Z"));

  // Migrated thread: the old OpenCode row was updated later than the Claude row,
  // so newest-wins would return the stale ses_ id.
  yield* insertThread(thread("t-moved", "pt-claude", { parentThreadId: null, rootThreadId: "t-moved" }));
  yield* insertProvider(provider("pt-old-oc", "t-moved", "opencode", "ses_old", "2026-01-02T00:00:00.000Z"));
  yield* insertProvider(
    provider("pt-claude", "t-moved", "claudeAgent", "claude-session-uuid", "2026-01-01T00:00:00.000Z"),
  );
  yield* insertImport("ses_imported", "t-moved");

  // Claude parent session with a native child found only by agent id.
  yield* insertThread(thread("t-claude-parent", "pt-claude-parent", { parentThreadId: null, rootThreadId: "t-claude-parent" }));
  yield* insertProvider(
    provider("pt-claude-parent", "t-claude-parent", "claudeAgent", "parent-uuid", "2026-01-01T00:00:00.000Z"),
  );
  yield* insertThread(thread("t-claude-child", null, { parentThreadId: "t-claude-parent", rootThreadId: "t-claude-parent", relationshipToParent: "subagent" }));
  yield* insertSubagent(
    subagent("s-claude", "t-claude-parent", "t-claude-child", null, "claudeAgent", "agent-abc"),
  );

  // Codex child owns its own provider thread.
  yield* insertThread(thread("t-codex-parent", "pt-codex-parent", { parentThreadId: null, rootThreadId: "t-codex-parent" }));
  yield* insertProvider(provider("pt-codex-parent", "t-codex-parent", "codex", "codex-parent", "2026-01-01T00:00:00.000Z"));
  yield* insertThread(thread("t-codex-child", "pt-codex-child", { parentThreadId: "t-codex-parent", rootThreadId: "t-codex-parent", relationshipToParent: "subagent" }));
  yield* insertProvider(provider("pt-codex-child", "t-codex-child", "codex", "codex-child-uuid", "2026-01-01T00:00:00.000Z"));
  yield* insertSubagent(
    subagent("s-codex", "t-codex-parent", "t-codex-child", "pt-codex-child", "codex", null, { instanceId: "codex", model: "gpt-6.1-sol" }),
  );

  // The same UUID under two drivers, in two different threads.
  yield* insertThread(thread("t-dup-a", "pt-dup-a", { parentThreadId: null, rootThreadId: "t-dup-a" }));
  yield* insertProvider(provider("pt-dup-a", "t-dup-a", "claudeAgent", "dup-uuid", "2026-01-01T00:00:00.000Z"));
  yield* insertThread(thread("t-dup-b", "pt-dup-b", { parentThreadId: null, rootThreadId: "t-dup-b" }));
  yield* insertProvider(provider("pt-dup-b", "t-dup-b", "codex", "dup-uuid", "2026-01-01T00:00:00.000Z"));

  // Lineage cycle: a points at b and b at a.
  yield* insertThread(thread("t-cyc-a", null, { parentThreadId: "t-cyc-b", rootThreadId: "t-cyc-b" }));
  yield* insertThread(thread("t-cyc-b", "pt-cyc-b", { parentThreadId: "t-cyc-a", rootThreadId: "t-cyc-a" }));
  yield* insertProvider(provider("pt-cyc-b", "t-cyc-b", "opencode", "ses_cycle", "2026-01-01T00:00:00.000Z"));

  // Deep parent chain: 150 hops to a root with no rootThreadId set.
  for (let index = 0; index <= 150; index++) {
    const parent = index === 150 ? null : `t-deep-${index + 1}`;
    yield* insertThread(
      thread(`t-deep-${index}`, index === 0 ? "pt-deep-0" : null, {
        parentThreadId: parent,
        rootThreadId: `t-deep-${index}`,
      }),
    );
  }
  yield* insertThread(thread("t-deep-root", null, { parentThreadId: null, rootThreadId: "t-deep-root" }));
  yield* insertProvider(provider("pt-deep-0", "t-deep-0", "opencode", "ses_deep", "2026-01-01T00:00:00.000Z"));

  // A Codex thread created just now whose native id has not arrived yet.
  yield* insertThread(thread("t-fresh", "pt-fresh", { parentThreadId: null, rootThreadId: "t-fresh" }));
  const now = DateTime.formatIso(yield* DateTime.now);
  yield* insertProvider(provider("pt-fresh", "t-fresh", "codex", null, now));
});

const run = <A, E>(body: Effect.Effect<A, E, ExecutionIdentity.ExecutionIdentity>) =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* seed;
      return yield* body;
    }).pipe(Effect.provide(ExecutionIdentity.layer)),
  ).pipe(Effect.provide(Sqlite.layerMemory));

describe("ExecutionIdentity", () => {
  it.effect("resolves a top-level OpenCode session to its thread", () =>
    run(
      Effect.gen(function* () {
        const identity = yield* ExecutionIdentity.ExecutionIdentity;
        const result = yield* identity.resolve({ nativeId: "ses_top" });
        assert.strictEqual(result.resolution, "resolved");
        assert.strictEqual(result.robobThreadId, "t-oc");
        assert.strictEqual(result.executionKind, "top-level");
        assert.strictEqual(result.driver, "opencode");
        assert.strictEqual(result.acceptsMessages, true);
        assert.strictEqual(result.model?.model, "opus/claude-opus-5-5");
      }),
    ),
  );

  it.effect("returns the migrated Claude id as current and keeps the OpenCode alias", () =>
    run(
      Effect.gen(function* () {
        const identity = yield* ExecutionIdentity.ExecutionIdentity;
        const current = yield* identity.currentNative(["t-moved"]);
        assert.deepStrictEqual(current.get("t-moved"), {
          driver: "claudeAgent",
          providerInstanceId: "claudeAgent",
          nativeId: "claude-session-uuid",
        });
        const aliases = yield* identity.aliases("t-moved");
        const ids = aliases.map((alias) => alias.nativeId).toSorted();
        assert.deepStrictEqual(ids, ["claude-session-uuid", "ses_imported", "ses_old"]);
      }),
    ),
  );

  it.effect("resolves a Claude child by parent session and agent id, not by session alone", () =>
    run(
      Effect.gen(function* () {
        const identity = yield* ExecutionIdentity.ExecutionIdentity;
        const child = yield* identity.resolve({
          nativeId: "parent-uuid",
          driver: "claudeAgent",
          agentId: "agent-abc",
        });
        assert.strictEqual(child.resolution, "resolved");
        assert.strictEqual(child.robobThreadId, "t-claude-child");
        assert.strictEqual(child.parentThreadId, "t-claude-parent");
        assert.strictEqual(child.executionKind, "provider-native-child");
        assert.strictEqual(child.acceptsMessages, false);
        assert.strictEqual(child.nativeAgentId, "agent-abc");
        assert.strictEqual(child.model?.model, "claude-haiku-5-5");

        const parent = yield* identity.resolve({ nativeId: "parent-uuid", driver: "claudeAgent" });
        assert.strictEqual(parent.robobThreadId, "t-claude-parent");
        assert.strictEqual(parent.executionKind, "top-level");
      }),
    ),
  );

  it.effect("resolves a Codex child through its own provider thread", () =>
    run(
      Effect.gen(function* () {
        const identity = yield* ExecutionIdentity.ExecutionIdentity;
        const result = yield* identity.resolve({ nativeId: "codex-child-uuid", driver: "codex" });
        assert.strictEqual(result.resolution, "resolved");
        assert.strictEqual(result.robobThreadId, "t-codex-child");
        assert.strictEqual(result.parentThreadId, "t-codex-parent");
        assert.strictEqual(result.executionKind, "provider-native-child");
        assert.strictEqual(result.acceptsMessages, true);
        assert.strictEqual(result.model?.model, "gpt-6.1-sol");
      }),
    ),
  );

  it.effect("refuses a UUID shared by two drivers without a driver, and resolves with one", () =>
    run(
      Effect.gen(function* () {
        const identity = yield* ExecutionIdentity.ExecutionIdentity;
        const ambiguous = yield* identity.resolve({ nativeId: "dup-uuid" });
        assert.strictEqual(ambiguous.resolution, "ambiguous");
        assert.deepStrictEqual([...ambiguous.candidates].toSorted(), ["t-dup-a", "t-dup-b"]);
        assert.strictEqual(ambiguous.robobThreadId, null);

        const claude = yield* identity.resolve({ nativeId: "dup-uuid", driver: "claudeAgent" });
        assert.strictEqual(claude.resolution, "resolved");
        assert.strictEqual(claude.robobThreadId, "t-dup-a");
        const codex = yield* identity.resolve({ nativeId: "dup-uuid", driver: "codex" });
        assert.strictEqual(codex.robobThreadId, "t-dup-b");
      }),
    ),
  );

  it.effect("terminates on a lineage cycle", () =>
    run(
      Effect.gen(function* () {
        const identity = yield* ExecutionIdentity.ExecutionIdentity;
        const result = yield* identity.resolve({ nativeId: "ses_cycle" });
        assert.strictEqual(result.resolution, "resolved");
        assert.strictEqual(result.robobThreadId, "t-cyc-b");
        assert.ok(result.rootThreadId === "t-cyc-a" || result.rootThreadId === "t-cyc-b");
      }),
    ),
  );

  it.effect("finds the real root of a 150-deep parent chain", () =>
    run(
      Effect.gen(function* () {
        const identity = yield* ExecutionIdentity.ExecutionIdentity;
        const result = yield* identity.resolve({ nativeId: "ses_deep" });
        assert.strictEqual(result.robobThreadId, "t-deep-0");
        assert.strictEqual(result.rootThreadId, "t-deep-0");
      }),
    ),
  );

  it.effect("reports a UUID with a fresh unnamed provider thread as pending", () =>
    run(
      Effect.gen(function* () {
        const identity = yield* ExecutionIdentity.ExecutionIdentity;
        const pending = yield* identity.resolve({
          nativeId: "11111111-2222-3333-4444-555555555555",
          driver: "codex",
        });
        assert.strictEqual(pending.resolution, "pending");
        assert.strictEqual(pending.robobThreadId, null);
      }),
    ),
  );

  it.effect("reports an unknown UUID with no fresh provider thread as unavailable", () =>
    run(
      Effect.gen(function* () {
        const identity = yield* ExecutionIdentity.ExecutionIdentity;
        const unknown = yield* identity.resolve({
          nativeId: "11111111-2222-3333-4444-555555555555",
          driver: "claudeAgent",
        });
        assert.strictEqual(unknown.resolution, "unavailable");
        const old = yield* identity.resolve({ nativeId: "ses_never_seen" });
        assert.strictEqual(old.resolution, "unavailable");
      }),
    ),
  );
});
