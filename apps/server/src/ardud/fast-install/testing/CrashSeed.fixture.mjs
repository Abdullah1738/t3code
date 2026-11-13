// Synthetic homes only; invoked by the subprocess crash test, never by the CLI.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const root = process.cwd();
const require = createRequire(path.join(root, "apps/server/package.json"));
const load = (n) => import(pathToFileURL(require.resolve(n)));
const app = (n) => import(pathToFileURL(path.join(root, "apps/server/src", n + ".ts")));
const [Effect, Layer, DateTime, NodeServices, Sqlite, Projection, Projects] = await Promise.all([
  load("effect/Effect"),
  load("effect/Layer"),
  load("effect/DateTime"),
  load("@effect/platform-node/NodeServices"),
  app("persistence/Sqlite"),
  app("orchestration-v2/ProjectionStore"),
  app("orchestration-v2/ProjectStore"),
]);
const [home, countArg, activeArg] = process.argv.slice(2);
if (!home || !fs.existsSync(path.join(home, ".crash-sandbox")))
  throw Error("Expected marked synthetic home");
const count = Number(countArg ?? 38),
  active = Number(activeArg ?? 35);
const now = DateTime.makeUnsafe("2026-11-08T00:00:00Z");
const iso = DateTime.formatIso(now);
const modelSelection = {
  instanceId: "codex",
  model: "gpt-6.1-sol",
  options: [{ id: "serviceTier", value: "default" }],
};
await Effect.runPromise(
  Effect.gen(function* () {
    const p = yield* Projection.ProjectionStoreV2;
    const projects = yield* Projects.ProjectStoreV2;
    yield* projects.apply({
      type: "project.created",
      payload: {
        projectId: "crash-project",
        title: "Crash sandbox",
        workspaceRoot: home,
        defaultModelSelection: modelSelection,
        scripts: [],
        createdAt: iso,
        updatedAt: iso,
      },
    });
    for (let i = 0; i < count; i++) {
      const threadId = `crash-thread-${i}`,
        runId = `crash-run-${i}`;
      yield* p.apply({
        id: `create-${i}`,
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          id: threadId,
          projectId: "crash-project",
          title: threadId,
          providerInstanceId: "codex",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
          forkedFrom: null,
          createdBy: "user",
          creationSource: "web",
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });
      if (i >= active) continue;
      yield* p.apply({
        id: `message-${i}`,
        type: "message.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: `user-${i}`,
          threadId,
          runId: null,
          nodeId: null,
          role: "user",
          text: `Synthetic request ${i}`,
          createdBy: "user",
          creationSource: "web",
          attachments: [],
          streaming: false,
          createdAt: now,
          updatedAt: now,
          completedAt: now,
        },
      });
      yield* p.apply({
        id: `run-${i}`,
        type: "run.created",
        threadId,
        runId,
        occurredAt: now,
        payload: {
          id: runId,
          threadId,
          ordinal: 1,
          providerInstanceId: "codex",
          modelSelection,
          providerThreadId: null,
          userMessageId: `user-${i}`,
          rootNodeId: null,
          activeAttemptId: null,
          status: "preparing",
          requestedAt: now,
          startedAt: null,
          completedAt: null,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
    }
  }).pipe(
    Effect.provide(
      Layer.mergeAll(Projection.layer, Projects.layer).pipe(
        Layer.provideMerge(Sqlite.layerFromPath(path.join(home, "userdata", "statev2.sqlite"))),
        Layer.provide(NodeServices.layer),
      ),
    ),
    Effect.scoped,
  ),
);
fs.writeFileSync(
  path.join(home, "userdata", "settings.json"),
  JSON.stringify({
    continueThreadsAfterServerUpdate: true,
    providerInstances: {
      codex: {
        driver: "codex",
        enabled: true,
        config: {
          binaryPath: path.join(
            root,
            "apps/server/src/ardud/fast-install/testing/codex-stub.fixture.mjs",
          ),
          homePath: home,
        },
      },
    },
  }),
);
console.log(JSON.stringify({ seed: 1, threads: count, active }));
