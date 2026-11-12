// @effect-diagnostics nodeBuiltinImport:off - board scripts are real files the test writes.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import {
  KanbanBoardId,
  KanbanScriptId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type KanbanActor,
  type KanbanBoard,
  type KanbanCard,
  type KanbanScript,
  type KanbanScriptTrigger,
} from "@t3tools/contracts";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ServerConfig from "../../../config.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as Sqlite from "../../../persistence/Sqlite.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as TextGeneration from "../../../textGeneration/TextGeneration.ts";
import * as KanbanStore from "../store/KanbanStore.ts";
import * as KanbanService from "./KanbanService.ts";
import * as KanbanModels from "./models.ts";
import * as Rules from "./rules.ts";
import * as ScriptService from "./ScriptService.ts";
import * as Scripts from "./scripts.ts";
import { modelSelectionOf, modelSelectionResult } from "./defaults.ts";
import { selectionRoutingEnabled } from "./selectionSettings.ts";
import { layer as providerRegistryLayer } from "../../../provider/testUtils/providerRegistryMock.ts";
import { opencodeTestProvider } from "./testProviders.ts";
import { KanbanThreads } from "./threads.ts";
import { KanbanWaitPrs } from "./waitPrs.ts";
import type * as Waits from "./waits.ts";

// Threads only matter here as somewhere for script posts to go.
const threads = Layer.succeed(
  KanbanThreads,
  KanbanThreads.of({
    view: () => Effect.succeed(null),
    find: () => Effect.succeed(null),
    lastFailure: () => Effect.succeed(null),
    findLastFailure: () => Effect.succeed(null),
    latestRun: () => Effect.succeed(null),
    compactRun: () => Effect.succeed(null),
    launch: () => Effect.succeed(ThreadId.make("thread-1")),
    send: () => Effect.void,
    model: () => Effect.succeed(null),
    setModel: () => Effect.void,
    cancelQueued: () => Effect.succeed(false),
    interrupt: () => Effect.void,
  }),
);

const boardFilesLayer = (apply = false) =>
  ServerConfig.layerTest(process.cwd(), {
    prefix: "t3-kanban-scripts-test-",
  }).pipe(
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(
      ServerSettings.layerTest(apply ? { ardudHarnessMigration: { selections: "apply" } } : {}),
    ),
  );

const makeTestLayer = (threadsLayer: Layer.Layer<KanbanThreads>, apply = false) =>
  ScriptService.layer.pipe(
    Layer.provideMerge(KanbanService.layer),
    Layer.provideMerge(KanbanModels.layerTest(null)),
    Layer.provideMerge(threadsLayer),
    Layer.provideMerge(KanbanStore.layer),
    Layer.provideMerge(Sqlite.layerMemory),
    Layer.provideMerge(Layer.mock(TextGeneration.TextGeneration)({})),
    Layer.provideMerge(Layer.mock(ProjectService.ProjectService)({})),
    Layer.provideMerge(providerRegistryLayer([opencodeTestProvider()])),
    Layer.provideMerge(boardFilesLayer(apply)),
  );

const testLayer = makeTestLayer(threads);

const owner: KanbanActor = { _tag: "owner" };
const manual: KanbanScriptTrigger = { _tag: "manual" };

const scriptFile = (body: string, name = "script.sh") => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-board-script-"));
  const path = NodePath.join(dir, name);
  NodeFS.writeFileSync(path, body);
  return path;
};

const toyBoard = Effect.gen(function* () {
  const kanban = yield* KanbanService.KanbanService;
  return yield* kanban.ensureBoard({
    slug: "toy",
    name: "Toy",
    defaultProjectId: ProjectId.make("project-1"),
  });
});

// Main's review gate (card #63) holds a non-owner's move to completed or deployed
// until the card's review passed; these cards stand for reviewed work.
const markReviewed = (board: KanbanBoard, cardId: KanbanCard["id"]) =>
  Effect.gen(function* () {
    const store = yield* KanbanStore.KanbanStore;
    const stored = (yield* store.card(cardId))!;
    yield* store.putCard({
      ...stored,
      reviewStep: Rules.chainFor(board, stored)?.steps.length ?? 1,
    });
  });

// Event runs start from a background fiber; give it a turn, then wait for the runs.
const settle = Effect.gen(function* () {
  const scripts = yield* ScriptService.KanbanScripts;
  for (let turn = 0; turn < 20; turn += 1) yield* Effect.yieldNow;
  yield* scripts.idle;
});

const register = (
  board: KanbanBoard,
  path: string,
  trigger: KanbanScriptTrigger = manual,
  name = "Watcher",
) =>
  Effect.gen(function* () {
    const scripts = yield* ScriptService.KanbanScripts;
    return yield* scripts.register({ boardId: board.id, name, path, trigger }, owner);
  });

const scriptWriteFixture = () => {
  const first: KanbanScript = {
    id: KanbanScriptId.make("script-first"),
    boardId: KanbanBoardId.make("board-first"),
    name: "First",
    path: "/unused.sh",
    trigger: manual,
    enabled: true,
    createdBy: owner,
    createdAt: "1970-01-01T00:00:00.000Z",
    lastRun: null,
  };
  const second: KanbanScript = {
    ...first,
    id: KanbanScriptId.make("script-second"),
    boardId: KanbanBoardId.make("board-second"),
    name: "Second",
  };
  const records = new Map([
    [first.id, first],
    [second.id, second],
  ]);
  const store = {
    script: (id: KanbanScript["id"]) => Effect.sync(() => records.get(id) ?? null),
    putScript: (script: KanbanScript) =>
      Effect.sync(() => {
        records.set(script.id, script);
      }),
    allScripts: Effect.sync(() => [...records.values()]),
    scriptRuns: () => Effect.succeed([]),
  };
  return { first, second, records, store };
};

const scriptWriteLayer = (
  store: Partial<KanbanStore.KanbanStore["Service"]>,
  announce: KanbanService.KanbanService["Service"]["announce"] = () => Effect.void,
) =>
  ScriptService.layer.pipe(
    Layer.provide(Layer.mock(KanbanStore.KanbanStore)(store)),
    Layer.provide(
      Layer.mock(KanbanService.KanbanService)({ announce, attachmentPath: () => null }),
    ),
    Layer.provide(ServerSettings.layerTest()),
  );

it.effect("script writes serialize per board without blocking another board", () =>
  Effect.gen(function* () {
    const { first, second, records, store } = scriptWriteFixture();
    const neighbor = { ...first, id: KanbanScriptId.make("script-neighbor") };
    records.set(neighbor.id, neighbor);
    const held = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const neighborRead = yield* Deferred.make<void>();
    yield* Effect.gen(function* () {
      const scripts = yield* ScriptService.KanbanScripts;
      const writing = yield* Effect.forkChild(scripts.setEnabled(first.id, false));
      yield* Deferred.await(held);
      const queued = yield* Effect.forkChild(scripts.setEnabled(neighbor.id, false));
      yield* Deferred.await(neighborRead);
      yield* Effect.gen(function* () {
        const other = yield* scripts.setEnabled(second.id, false);
        assert.isFalse(other.enabled);
        assert.isTrue(records.get(first.id)?.enabled);
        assert.isTrue(records.get(neighbor.id)?.enabled);
      }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
      yield* Fiber.join(writing);
      yield* Fiber.join(queued);
      assert.isFalse(records.get(first.id)?.enabled);
      assert.isFalse(records.get(neighbor.id)?.enabled);
    }).pipe(
      Effect.provide(
        scriptWriteLayer({
          ...store,
          script: (id) =>
            store
              .script(id)
              .pipe(
                Effect.tap(() =>
                  id === neighbor.id ? Deferred.succeed(neighborRead, undefined) : Effect.void,
                ),
              ),
          putScript: (script) =>
            (script.id === first.id
              ? Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release)))
              : Effect.void
            ).pipe(Effect.andThen(store.putScript(script))),
        }),
      ),
    );
  }),
);

it.effect("a queued toggle rereads the last run after a same-board write", () =>
  Effect.gen(function* () {
    const { first, records, store } = scriptWriteFixture();
    records.set(first.id, {
      ...first,
      lastRun: { startedAt: first.createdAt, endedAt: null, exitCode: null },
    });
    const held = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const toggleRead = yield* Deferred.make<void>();
    let recovering = false;
    yield* TestClock.adjust("1 minute");
    yield* Effect.gen(function* () {
      const scripts = yield* ScriptService.KanbanScripts;
      const recovery = yield* Effect.forkChild(scripts.recover);
      yield* Deferred.await(held);
      const toggle = yield* Effect.forkChild(scripts.setEnabled(first.id, false));
      yield* Deferred.await(toggleRead).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
      yield* Fiber.join(recovery);
      const after = yield* Fiber.join(toggle);
      assert.isFalse(after.enabled);
      assert.strictEqual(after.lastRun?.endedAt, "1970-01-01T00:01:00.000Z");
      assert.deepStrictEqual(records.get(first.id), after);
    }).pipe(
      Effect.provide(
        scriptWriteLayer({
          ...store,
          script: (id) =>
            store
              .script(id)
              .pipe(
                Effect.tap(() =>
                  recovering && id === first.id
                    ? Deferred.succeed(toggleRead, undefined)
                    : Effect.void,
                ),
              ),
          putScript: (script) =>
            (script.id === first.id && script.lastRun?.endedAt !== null && script.enabled
              ? Effect.sync(() => {
                  recovering = true;
                }).pipe(
                  Effect.andThen(Deferred.succeed(held, undefined)),
                  Effect.andThen(Deferred.await(release)),
                )
              : Effect.void
            ).pipe(Effect.andThen(store.putScript(script))),
        }),
      ),
    );
  }),
);

it.effect("an unchanged toggle is checked after the preceding toggle commits", () =>
  Effect.gen(function* () {
    const { first, records, store } = scriptWriteFixture();
    const held = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const enableRead = yield* Deferred.make<void>();
    let disabling = false;
    yield* Effect.gen(function* () {
      const scripts = yield* ScriptService.KanbanScripts;
      const disable = yield* Effect.forkChild(scripts.setEnabled(first.id, false));
      yield* Deferred.await(held);
      const enable = yield* Effect.forkChild(scripts.setEnabled(first.id, true));
      yield* Deferred.await(enableRead).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
      yield* Fiber.join(disable);
      assert.isTrue((yield* Fiber.join(enable)).enabled);
      assert.isTrue(records.get(first.id)?.enabled);
    }).pipe(
      Effect.provide(
        scriptWriteLayer({
          ...store,
          script: (id) =>
            store
              .script(id)
              .pipe(
                Effect.tap(() =>
                  disabling && id === first.id
                    ? Deferred.succeed(enableRead, undefined)
                    : Effect.void,
                ),
              ),
          putScript: (script) =>
            (!script.enabled
              ? Effect.sync(() => {
                  disabling = true;
                }).pipe(
                  Effect.andThen(Deferred.succeed(held, undefined)),
                  Effect.andThen(Deferred.await(release)),
                )
              : Effect.void
            ).pipe(Effect.andThen(store.putScript(script))),
        }),
      ),
    );
  }),
);

it.effect("a delayed script announcement does not hold the board write lock", () =>
  Effect.gen(function* () {
    const { first, records, store } = scriptWriteFixture();
    const held = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    yield* Effect.gen(function* () {
      const scripts = yield* ScriptService.KanbanScripts;
      const disable = yield* Effect.forkChild(scripts.setEnabled(first.id, false));
      yield* Deferred.await(held);
      yield* Effect.gen(function* () {
        assert.isTrue((yield* scripts.setEnabled(first.id, true)).enabled);
        assert.isTrue(records.get(first.id)?.enabled);
      }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
      yield* Fiber.join(disable);
    }).pipe(
      Effect.provide(
        scriptWriteLayer(store, (_boardId, change) =>
          change._tag === "script" && !change.script.enabled
            ? Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release)))
            : Effect.void,
        ),
      ),
    );
  }),
);

it.effect("refuses scripts it couldn't run", () =>
  Effect.gen(function* () {
    const board = yield* toyBoard;
    const path = scriptFile("echo hi\n");
    const problem = (input: { path?: string; trigger?: KanbanScriptTrigger }) =>
      register(board, input.path ?? path, input.trigger ?? manual).pipe(
        Effect.flip,
        Effect.map((error) => error.detail),
      );

    assert.include(yield* problem({ path: "script.sh" }), "full path");
    assert.include(yield* problem({ path: scriptFile("x", "script.rb") }), ".ts, .js");
    assert.include(yield* problem({ path: `${path}.missing.sh` }), "no file");
    assert.include(
      yield* problem({ trigger: { _tag: "schedule", everyMs: 1_000, cron: null } }),
      "once a minute",
    );
    assert.include(
      yield* problem({ trigger: { _tag: "schedule", everyMs: null, cron: "nope" } }),
      "five fields",
    );
    assert.include(
      yield* problem({ trigger: { _tag: "schedule", everyMs: null, cron: "0 0 30 2 *" } }),
      "never comes round",
    );

    const script = yield* register(board, path);
    assert.strictEqual(script.enabled, true);
    assert.strictEqual(script.lastRun, null);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("adds cards and posts from what a run prints, once", () =>
  Effect.gen(function* () {
    const kanban = yield* KanbanService.KanbanService;
    const scripts = yield* ScriptService.KanbanScripts;
    const board = yield* toyBoard;
    const script = yield* register(
      board,
      scriptFile(
        [
          `echo '{"kanban":"card","prompt":"Look at the failed deploy","title":"Deploy failed","links":[{"url":"https://ci.example/run/1"}]}'`,
          `echo '{"kanban":"post","text":"Deploy 1 failed."}'`,
          `echo '{"kanban":"card"}'`,
          `echo "checked $KANBAN_TRIGGER"`,
          `echo "warning" >&2`,
          "",
        ].join("\n"),
      ),
    );

    const run = yield* scripts.run(script.id, "manual");
    assert.strictEqual(run.endedAt, null);
    yield* scripts.idle;

    const [done] = yield* scripts.runs(script.id, 10);
    assert.strictEqual(done?.exitCode, 0);
    assert.isNotNull(done?.endedAt);
    assert.include(done?.output, "Added card #1.");
    assert.include(done?.output, 'Posted in "Script: Watcher".');
    assert.include(done?.output, "checked manual");
    assert.include(done?.output, "warning");
    assert.include(done?.output, "Line 3");

    const snapshot = yield* kanban.snapshot(board.id);
    assert.strictEqual(snapshot.cards.length, 1);
    assert.deepStrictEqual(snapshot.cards[0]?.createdBy, { _tag: "script", scriptId: script.id });
    const discussion = (yield* kanban.discussions(board.id)).find(
      (entry) => entry.title === "Script: Watcher",
    );
    assert.isDefined(discussion);
    const messages = yield* kanban.messages(discussion!.id, {});
    assert.strictEqual(messages[0]?.authorName, "Watcher");

    // The same output again finds the card and the discussion it made before.
    yield* scripts.run(script.id, "manual");
    yield* scripts.idle;
    const [again] = yield* scripts.runs(script.id, 1);
    assert.include(again?.output, "Card #1 is already on the board.");
    assert.strictEqual((yield* kanban.snapshot(board.id)).cards.length, 1);
    assert.strictEqual(
      (yield* kanban.discussions(board.id)).filter((entry) => entry.title === "Script: Watcher")
        .length,
      1,
    );
    const latest = (yield* scripts.scripts(board.id))[0];
    assert.strictEqual(latest?.lastRun?.exitCode, 0);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("resizes a pool the board has, and only that", () =>
  Effect.gen(function* () {
    const kanban = yield* KanbanService.KanbanService;
    const scripts = yield* ScriptService.KanbanScripts;
    const board = yield* toyBoard;
    yield* kanban.setPool(board.id, board.defaultCardModel, 3);
    const before = (yield* kanban.snapshot(board.id)).pools;
    const script = yield* register(
      board,
      scriptFile(
        [
          `echo '{"kanban":"pool","model":"${board.defaultCardModel.model}","slots":1}'`,
          `echo '{"kanban":"pool","model":"someone/else","slots":4}'`,
          "",
        ].join("\n"),
      ),
    );

    yield* scripts.run(script.id, "manual");
    yield* scripts.idle;

    const [done] = yield* scripts.runs(script.id, 1);
    assert.include(done?.output, `Set the ${board.defaultCardModel.model} pool to 1 slot.`);
    assert.include(done?.output, "There's no someone/else pool on this board.");
    const { pools } = yield* kanban.snapshot(board.id);
    const resized = (pool: (typeof pools)[number]) =>
      pool.model.model === board.defaultCardModel.model ? { ...pool, slots: 1 } : pool;
    assert.deepStrictEqual(
      pools.map((pool) => [pool.model, pool.slots]),
      before.map(resized).map((pool) => [pool.model, pool.slots]),
    );
  }).pipe(Effect.provide(testLayer)),
);

it.effect("a pool command names the level when the model runs at several", () =>
  Effect.gen(function* () {
    const kanban = yield* KanbanService.KanbanService;
    const scripts = yield* ScriptService.KanbanScripts;
    const board = yield* toyBoard;
    const opus = board.defaultCardModel.model;
    yield* kanban.setPool(
      board.id,
      { ...board.defaultCardModel, options: [{ id: "variant", value: "xhigh" }] },
      1,
    );
    const script = yield* register(
      board,
      scriptFile(
        [
          `echo '{"kanban":"pool","model":"${opus}","slots":2}'`,
          `echo '{"kanban":"pool","model":"${opus}","variant":"xhigh","slots":4}'`,
          `echo '{"kanban":"pool","model":"${opus}","variant":"low","slots":4}'`,
          "",
        ].join("\n"),
      ),
    );
    yield* scripts.run(script.id, "manual");
    yield* scripts.idle;
    const [done] = yield* scripts.runs(script.id, 1);
    assert.include(done?.output, `The ${opus} pools run at high, xhigh; name the variant.`);
    assert.include(done?.output, `Set the ${opus} pool to 4 slots.`);
    assert.include(done?.output, `There's no ${opus} low pool on this board.`);
    const levels = (yield* kanban.snapshot(board.id)).pools
      .filter((pool) => pool.model.model === opus)
      .map((pool) => [Rules.modelLevel(pool.model), pool.slots]);
    assert.deepStrictEqual(levels, [
      ["high", 0],
      ["xhigh", 4],
    ]);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("a legacy script resolves only when enabled and exact pool keys stay usable", () =>
  Effect.gen(function* () {
    const kanban = yield* KanbanService.KanbanService;
    const scripts = yield* ScriptService.KanbanScripts;
    const board = yield* toyBoard;
    const native = modelSelectionOf({
      instanceId: "claudeAgent",
      model: "claude-opus-5-5",
      effort: "high",
      options: [{ id: "thinking", value: true }],
    });
    // The mapped default is another level of this model; add an explicit pool so
    // this test also checks the script keeps the selected pool's secondary options.
    const store = yield* KanbanStore.KanbanStore;
    yield* store.putPool(board.id, { key: Rules.poolKey(native), model: native, slots: 1 });
    const script = yield* register(
      board,
      scriptFile(
        [
          `echo '{"kanban":"pool","instanceId":"opencode","model":"opus/claude-opus-5-5#high","slots":2}'`,
          `echo '{"kanban":"pool","instanceId":"opencode","model":"opus/claude-opus-5-5#high","variant":"xhigh","slots":3}'`,
          `echo '{"kanban":"pool","model":"claudeAgent/claude-opus-5-5#high","slots":4}'`,
          `echo '{"kanban":"pool","model":"claudeAgent/claude-opus-5-5#high","variant":"xhigh","slots":5}'`,
          `echo '{"kanban":"pool","model":"claudeAgent/claude-opus-5-5#high","instanceId":"codex","slots":6}'`,
          `echo '{"kanban":"pool","model":"claudeAgent/claude-unknown#high","slots":7}'`,
          "",
        ].join("\n"),
      ),
    );
    yield* scripts.run(script.id, "manual");
    yield* scripts.idle;
    const [done] = yield* scripts.runs(script.id, 1);
    assert.include(done?.output, "pool to 2 slots");
    assert.include(done?.output, "conflicting efforts");
    assert.include(done?.output, "pool to 4 slots");
    assert.include(done?.output, "conflicts with its instance or effort");
    assert.include(done?.output, "No verified native harness mapping");
    const pool = (yield* kanban.snapshot(board.id)).pools.find(
      (entry) => entry.key === Rules.poolKey(native),
    );
    assert.strictEqual(pool?.slots, 4);
    assert.deepStrictEqual(pool?.model, native);
  }).pipe(Effect.provide(makeTestLayer(threads, true))),
);

it.effect("legacy pool commands do not map while routing is off", () =>
  Effect.gen(function* () {
    const kanban = yield* KanbanService.KanbanService;
    const scripts = yield* ScriptService.KanbanScripts;
    const board = yield* toyBoard;
    const native = modelSelectionOf({
      instanceId: "claudeAgent",
      model: "claude-opus-5-5",
      effort: "high",
    });
    yield* kanban.setPool(board.id, native, 1);
    const script = yield* register(
      board,
      scriptFile(
        `echo '{"kanban":"pool","instanceId":"opencode","model":"opus/claude-opus-5-5#high","slots":2}'\n`,
      ),
    );
    yield* scripts.run(script.id, "manual");
    yield* scripts.idle;
    const [done] = yield* scripts.runs(script.id, 1);
    assert.include(done?.output, "There's no opus/claude-opus-5-5#high pool");
    assert.strictEqual(
      (yield* kanban.snapshot(board.id)).pools.find((pool) => pool.key === Rules.poolKey(native))
        ?.slots,
      1,
    );
  }).pipe(Effect.provide(testLayer)),
);

it.effect("selection input preserves native options and fails closed on conflicting efforts", () =>
  Effect.sync(() => {
    const parsed = Scripts.parseOutput(
      JSON.stringify({
        kanban: "pool",
        model: "gpt-6.1-sol",
        instanceId: "codex",
        effort: "xhigh",
        options: [{ id: "serviceTier", value: "priority" }],
        slots: 2,
      }),
    );
    assert.lengthOf(parsed.errors, 0);
    assert.deepStrictEqual(parsed.commands[0], {
      kanban: "pool",
      model: "gpt-6.1-sol",
      instanceId: "codex",
      effort: "xhigh",
      options: [{ id: "serviceTier", value: "priority" }],
      slots: 2,
    });
    assert.deepStrictEqual(
      modelSelectionOf({
        instanceId: "codex",
        model: "gpt-6.1-sol",
        effort: "xhigh",
        options: [{ id: "serviceTier", value: "priority" }],
      }),
      {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-6.1-sol",
        options: [
          { id: "serviceTier", value: "priority" },
          { id: "reasoningEffort", value: "xhigh" },
        ],
      },
    );
    assert.strictEqual(
      modelSelectionResult({
        instanceId: "claudeAgent",
        model: "claude-opus-5-5",
        effort: "high",
        options: [{ id: "effort", value: "max" }],
      }).kind,
      "conflict",
    );
    assert.strictEqual(
      modelSelectionResult(
        {
          model: "opus/gpt-6-astra#high",
          variant: "xhigh",
        },
        true,
      ).kind,
      "conflict",
    );
    assert.strictEqual(
      modelSelectionResult(
        {
          model: "opus/gpt-6-astra",
          effort: "high",
          options: [{ id: "reasoningEffort", value: "xhigh" }],
        },
        true,
      ).kind,
      "conflict",
    );
    assert.strictEqual(
      modelSelectionOf({ model: "opus/gpt-6-astra#high" }).model,
      "opus/gpt-6-astra#high",
    );
    assert.deepStrictEqual(
      modelSelectionOf({ model: "opus/cx/gpt-6.1-terra", variant: "xhigh" }, true),
      {
        instanceId: ProviderInstanceId.make("codex-cu"),
        model: "gpt-6.1-terra",
        options: [{ id: "reasoningEffort", value: "xhigh" }],
      },
    );
  }),
);

it.effect("selection routing follows the live migration setting", () =>
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    assert.isFalse(yield* selectionRoutingEnabled);
    yield* settings.updateSettings({ ardudHarnessMigration: { selections: "dryrun" } });
    assert.isFalse(yield* selectionRoutingEnabled);
    yield* settings.updateSettings({ ardudHarnessMigration: { selections: "apply" } });
    assert.isTrue(yield* selectionRoutingEnabled);
    yield* settings.updateSettings({ ardudHarnessMigration: { selections: "off" } });
    assert.isFalse(yield* selectionRoutingEnabled);
  }).pipe(Effect.provide(ServerSettings.layerTest())),
);

it.effect("runs one at a time and says why a run went wrong", () =>
  Effect.gen(function* () {
    const scripts = yield* ScriptService.KanbanScripts;
    const board = yield* toyBoard;
    const path = scriptFile("sleep 0.3\nexit 3\n");
    const script = yield* register(board, path);

    yield* scripts.run(script.id, "manual");
    const busy = yield* scripts.run(script.id, "manual").pipe(Effect.flip);
    assert.strictEqual(busy.code, "conflict");
    yield* scripts.idle;
    assert.strictEqual((yield* scripts.runs(script.id, 1))[0]?.exitCode, 3);

    NodeFS.rmSync(path);
    yield* scripts.run(script.id, "manual");
    yield* scripts.idle;
    const [missing] = yield* scripts.runs(script.id, 1);
    assert.include(missing?.output, "There is no script at");
    assert.strictEqual(missing?.exitCode, null);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("supplies the current migration setting and bundled resolver to actual scripts", () =>
  Effect.gen(function* () {
    const scripts = yield* ScriptService.KanbanScripts;
    const settings = yield* ServerSettings.ServerSettingsService;
    const board = yield* toyBoard;
    const path = scriptFile(
      `import json, os, subprocess\nmode = json.loads(os.environ['KANBAN_HARNESS_MIGRATION']).get('selections', 'off')\ncmd = json.loads(os.environ['KANBAN_HARNESS_ROUTING_COMMAND'])\nenv = dict(os.environ, ELECTRON_RUN_AS_NODE='1')\nrequest = [{'instanceId':'opencode','model':'opus/cx/gpt-6.1-sol#xhigh'}]\np = subprocess.run(cmd, input=json.dumps(request), text=True, capture_output=True, env=env, check=True)\nprint(mode + ':' + p.stdout.strip())\n`,
      "resolver.py",
    );
    const script = yield* register(board, path);
    for (const mode of [undefined, "off", "apply"] as const) {
      if (mode !== undefined)
        yield* settings.updateSettings({ ardudHarnessMigration: { selections: mode } });
      yield* scripts.run(script.id, "manual");
      yield* scripts.idle;
      const [run] = yield* scripts.runs(script.id, 1);
      assert.strictEqual(run?.exitCode, 0, run?.output);
      assert.include(run!.output, `${mode ?? "off"}:`);
      assert.include(run!.output, '"instanceId":"codex"');
      assert.include(run!.output, '"reasoningEffort"');
    }
  }).pipe(Effect.provide(testLayer)),
);

it.effect("lets a webhook start a script only while it is on", () =>
  Effect.gen(function* () {
    const scripts = yield* ScriptService.KanbanScripts;
    const board = yield* toyBoard;
    const script = yield* register(board, scriptFile("sleep 0.2\n"));

    yield* scripts.run(script.id, "webhook");
    // Turned off while it runs: it stays off, and the run still ends on the record.
    yield* scripts.setEnabled(script.id, false);
    yield* scripts.idle;
    const [after] = yield* scripts.scripts(board.id);
    assert.strictEqual(after?.enabled, false);
    assert.isNotNull(after?.lastRun?.endedAt);

    const refused = yield* scripts.run(script.id, "webhook").pipe(Effect.flip);
    assert.include(refused.detail, "turned off");
    yield* scripts.run(script.id, "manual");
    yield* scripts.idle;
    assert.strictEqual((yield* scripts.runs(script.id, 10)).length, 2);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("starts scheduled scripts when they are due and not when off", () =>
  Effect.gen(function* () {
    const scripts = yield* ScriptService.KanbanScripts;
    const board = yield* toyBoard;
    const script = yield* register(board, scriptFile("echo tick\n"), {
      _tag: "schedule",
      everyMs: 60_000,
      cron: null,
    });

    yield* scripts.tick;
    yield* scripts.idle;
    assert.strictEqual((yield* scripts.runs(script.id, 10)).length, 0);

    yield* TestClock.adjust("1 minute");
    yield* scripts.tick;
    yield* scripts.idle;
    const runs = yield* scripts.runs(script.id, 10);
    assert.strictEqual(runs.length, 1);
    assert.strictEqual(runs[0]?.trigger, "schedule");

    yield* scripts.setEnabled(script.id, false);
    yield* TestClock.adjust("5 minutes");
    yield* scripts.tick;
    yield* scripts.idle;
    assert.strictEqual((yield* scripts.runs(script.id, 10)).length, 1);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("runs event scripts on board changes, but not on their own", () =>
  Effect.gen(function* () {
    const kanban = yield* KanbanService.KanbanService;
    const scripts = yield* ScriptService.KanbanScripts;
    const board = yield* toyBoard;
    const script = yield* register(
      board,
      scriptFile(
        [
          `echo "$KANBAN_EVENT"`,
          `echo '{"kanban":"card","prompt":"Follow up","title":"Follow-up"}'`,
          "",
        ].join("\n"),
      ),
      { _tag: "event", event: "card.created" },
    );
    yield* scripts.listen;

    yield* kanban.createCard(board.id, { prompt: "Ship it", title: "Ship" }, owner);
    yield* settle;
    yield* settle;

    const runs = yield* scripts.runs(script.id, 10);
    assert.strictEqual(runs.length, 1);
    assert.include(runs[0]?.output, '"event":"card.created"');
    assert.include(runs[0]?.output, '"title":"Ship"');
    assert.strictEqual(runs[0]?.trigger, "event");
    // Its own Follow-up card didn't start it again.
    assert.strictEqual((yield* kanban.snapshot(board.id)).cards.length, 2);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("runs a busy event script once more, with the newest event", () =>
  Effect.gen(function* () {
    const kanban = yield* KanbanService.KanbanService;
    const scripts = yield* ScriptService.KanbanScripts;
    const board = yield* toyBoard;
    const script = yield* register(board, scriptFile(`sleep 0.3\necho "$KANBAN_EVENT"\n`), {
      _tag: "event",
      event: "card.created",
    });
    yield* scripts.listen;

    for (const title of ["One", "Two", "Three"]) {
      yield* kanban.createCard(board.id, { prompt: title, title }, owner);
    }
    yield* settle;

    const runs = yield* scripts.runs(script.id, 10);
    assert.strictEqual(runs.length, 2);
    assert.include(runs[1]?.output, '"title":"One"');
    assert.include(runs[0]?.output, '"title":"Three"');
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("doesn't wake on agents answering in a discussion a script posts in", () =>
  Effect.gen(function* () {
    const kanban = yield* KanbanService.KanbanService;
    const scripts = yield* ScriptService.KanbanScripts;
    const board = yield* toyBoard;
    const script = yield* register(
      board,
      scriptFile(`echo '{"kanban":"post","text":"Seen it."}'\n`),
      { _tag: "event", event: "message.posted" },
    );
    yield* scripts.listen;
    const md = (text: string) => [{ _tag: "md" as const, text }];

    const chat = yield* kanban.createDiscussion(board.id, "Chat", owner);
    yield* kanban.post(chat.id, owner, md("Anything new?"));
    yield* settle;
    assert.strictEqual((yield* scripts.runs(script.id, 10)).length, 1);

    const own = (yield* kanban.discussions(board.id)).find(
      (entry) => entry.title === "Script: Watcher",
    );
    assert.isDefined(own);
    const agent: KanbanActor = { _tag: "evaluator", threadId: ThreadId.make("thread-1") };
    yield* kanban.post(own!.id, agent, md("Thanks, looking."));
    yield* settle;
    assert.strictEqual((yield* scripts.runs(script.id, 10)).length, 1);

    // The owner still reaches it there.
    yield* kanban.post(own!.id, owner, md("Run again?"));
    yield* settle;
    assert.strictEqual((yield* scripts.runs(script.id, 10)).length, 2);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("closes runs a stopped server left open", () =>
  Effect.gen(function* () {
    const store = yield* KanbanStore.KanbanStore;
    const scripts = yield* ScriptService.KanbanScripts;
    const board = yield* toyBoard;
    const script = yield* register(board, scriptFile("echo hi\n"));
    const startedAt = "1970-01-01T00:00:00.000Z";
    yield* store.addScriptRun({
      scriptId: script.id,
      startedAt,
      endedAt: null,
      exitCode: null,
      output: "",
      trigger: "manual",
    });
    yield* store.putScript({ ...script, lastRun: { startedAt, endedAt: null, exitCode: null } });
    // Stopped after the run row went in but before the record said so.
    const other = yield* register(board, scriptFile("echo hi\n"), manual, "Other");
    yield* store.addScriptRun({
      scriptId: other.id,
      startedAt,
      endedAt: null,
      exitCode: null,
      output: "",
      trigger: "manual",
    });

    // The test clock starts at those runs' start; the restart comes later.
    yield* TestClock.adjust("1 minute");
    yield* scripts.recover;
    const [run] = yield* scripts.runs(script.id, 1);
    assert.isNotNull(run?.endedAt);
    assert.include(run?.output, "Robob stopped during this run.");
    const records = yield* scripts.scripts(board.id);
    assert.isNotNull(records.find((entry) => entry.id === script.id)?.lastRun?.endedAt);
    assert.isNotNull((yield* scripts.runs(other.id, 1))[0]?.endedAt);
  }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "a script ticks its subtasks, hands one back and moves cards, waking the evaluator only for the hand-back",
  () => {
    const sent: Array<string> = [];
    const recording = Layer.succeed(
      KanbanThreads,
      KanbanThreads.of({
        view: () => Effect.succeed(null),
        find: () => Effect.succeed(null),
        lastFailure: () => Effect.succeed(null),
        findLastFailure: () => Effect.succeed(null),
        latestRun: () => Effect.succeed(null),
        compactRun: () => Effect.succeed(null),
        launch: (input) => {
          sent.push(input.text);
          return Effect.succeed(ThreadId.make("thread-1"));
        },
        send: (input) => {
          sent.push(input.text);
          return Effect.void;
        },
        model: () => Effect.succeed(null),
        setModel: () => Effect.void,
        cancelQueued: () => Effect.succeed(false),
        interrupt: () => Effect.void,
      }),
    );
    return Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const scripts = yield* ScriptService.KanbanScripts;
      const board = yield* toyBoard;
      yield* kanban.setPool(board.id, board.defaultCardModel, 3);
      // A subtask names a script on the board, so the scripts exist before the card does.
      yield* register(board, scriptFile("exit 0\n"), manual, "land");
      yield* register(board, scriptFile("exit 0\n"), manual, "other");
      yield* register(board, scriptFile("exit 0\n"), manual, "again");

      const card = yield* kanban.createCard(
        board.id,
        {
          prompt: "Ship the change",
          title: "Land it",
          subtasks: [
            { text: "Merge the PR", owner: "script", script: "land" },
            { text: "Deploy", owner: "script", script: "land", step: 2 },
            { text: "Tell the reporter", owner: "evaluator", step: 3 },
          ],
        },
        owner,
      );
      yield* markReviewed(board, card.id);
      yield* kanban.dispatchNow;
      assert.strictEqual(sent.length, 0);

      const bad = yield* kanban
        .createCard(
          board.id,
          {
            prompt: "Oops",
            title: "Oops",
            subtasks: [{ text: "Merge", owner: "script", script: "nope" }],
          },
          owner,
        )
        .pipe(Effect.flip);
      assert.include(bad.detail, 'no script named "nope" on this board');

      // Each run registers its own script under the given name, then runs it once.
      const runScript = (name: string, lines: ReadonlyArray<string>) =>
        Effect.gen(function* () {
          const path = scriptFile(`${lines.map((line) => `echo '${line}'`).join("\n")}\n`);
          const script = yield* register(board, path, manual, name);
          yield* scripts.run(script.id, "manual");
          yield* scripts.idle;
          const [done] = yield* scripts.runs(script.id, 1);
          return done?.output ?? "";
        });

      const otherOut = yield* runScript("other", [
        `{"kanban":"subtask","card":${card.number},"subtask":"s1","state":"done"}`,
      ]);
      assert.include(
        otherOut,
        `Couldn't mark s1 on card #${card.number}: subtask s1 is for the script "land"`,
      );

      const landOut = yield* runScript("land", [
        `{"kanban":"subtask","card":${card.number},"subtask":"s1","state":"done","note":"merged abc1234"}`,
        `{"kanban":"handback","card":${card.number},"subtask":"s2","note":"deploy failed: exit 1"}`,
        `{"kanban":"move","card":${card.number},"to":"deployed","note":"landed"}`,
        `{"kanban":"move","card":${card.number},"to":"verified"}`,
        `{"kanban":"move","card":${card.number},"to":"working"}`,
      ]);
      assert.include(landOut, `Marked s1 done on card #${card.number}.`);
      assert.include(landOut, `Handed s2 on card #${card.number} back to the evaluator.`);
      assert.include(landOut, `Moved card #${card.number} to deployed.`);
      assert.include(
        landOut,
        `Couldn't move card #${card.number}: card #${card.number} still has s2, s3 open`,
      );
      // The fifth line is `move to working`: no schema allows it, so it's reported, not applied.
      assert.include(landOut, "Line 5:");

      const after = yield* kanban.snapshot(board.id);
      const stored = after.cards.find((entry) => entry.number === card.number)!;
      const s1 = stored.subtasks.find((subtask) => subtask.id === "s1")!;
      assert.strictEqual(s1.state, "done");
      assert.strictEqual(s1.note, "merged abc1234");
      assert.strictEqual(s1.doneBy?._tag, "script");
      const s2 = stored.subtasks.find((subtask) => subtask.id === "s2")!;
      assert.strictEqual(s2.owner, "evaluator");
      assert.strictEqual(s2.state, "open");
      assert.strictEqual(s2.note, "deploy failed: exit 1");
      assert.strictEqual(stored.stage, "deployed");

      const wakes = sent.filter((text) => text.includes("deploy failed: exit 1"));
      assert.strictEqual(wakes.length, 1);
      assert.notInclude(sent.join("\n"), "waiting on your subtasks");

      const againOut = yield* runScript("again", [
        `{"kanban":"handback","card":${card.number},"subtask":"s2","note":"second-handback-note"}`,
      ]);
      assert.include(
        againOut,
        `Couldn't hand s2 on card #${card.number} back: subtask s2 isn't a script's`,
      );
      assert.strictEqual(sent.filter((text) => text.includes("second-handback-note")).length, 0);
    }).pipe(Effect.provide(makeTestLayer(recording)));
  },
);

it.effect(
  "a subtask a script ticks, which moves a deployed card back to todo, wakes no card.moved script",
  () =>
    Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const scripts = yield* ScriptService.KanbanScripts;
      const board = yield* toyBoard;
      yield* kanban.setPool(board.id, board.defaultCardModel, 3);
      // Both listeners react to every card.moved; a rerun shows up as a run.
      const mover = yield* register(
        board,
        scriptFile(`echo "$KANBAN_EVENT"\n`),
        { _tag: "event", event: "card.moved" },
        "mover",
      );
      const watcher = yield* register(
        board,
        scriptFile(`echo "$KANBAN_EVENT"\n`),
        { _tag: "event", event: "card.moved" },
        "watcher",
      );
      // The land script has to exist before a card names it.
      const ticker = yield* register(
        board,
        scriptFile(
          [
            `echo '{"kanban":"move","card":1,"to":"deployed","note":"landed"}'`,
            `echo '{"kanban":"subtask","card":1,"subtask":"s1","state":"done","note":"merged"}'`,
            "",
          ].join("\n"),
        ),
        manual,
        "ticker",
      );
      // Step 1: the script's merge. Step 2: the worker's follow-up.
      const card = yield* kanban.createCard(
        board.id,
        {
          prompt: "Land the change",
          title: "Land",
          subtasks: [
            { text: "Merge the PR", owner: "script", script: "ticker" },
            { text: "Write the follow-up", owner: "work", step: 2 },
          ],
        },
        owner,
      );
      assert.strictEqual(card.number, 1);
      yield* markReviewed(board, card.id);
      yield* scripts.listen;
      yield* scripts.run(ticker.id, "manual");
      yield* scripts.idle;
      yield* settle;

      const stored = (yield* kanban.snapshot(board.id)).cards.find(
        (entry) => entry.number === card.number,
      )!;
      // The tick opened the worker's step, so the deployed card went back to todo.
      assert.strictEqual(stored.stage, "todo");
      const moves = (yield* kanban.card(card.id)).events.filter((event) => event.kind === "moved");
      assert.deepStrictEqual(
        moves.map((event) => [event.toStage, event.actor._tag]),
        [
          ["deployed", "script"],
          ["todo", "script"],
        ],
      );
      // The move and the auto-move both came from the land script: neither listener reruns.
      assert.strictEqual((yield* scripts.runs(mover.id, 10)).length, 0);
      assert.strictEqual((yield* scripts.runs(watcher.id, 10)).length, 0);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

// Wait checks: cards parked on a board script, checked by ScriptService.checkWaits.
const waitTestLayer = testLayer;

/** A card as a review leaves it (in review, no thread), parked on `script`. */
const parkedOn = (
  board: KanbanBoard,
  script: string,
  title: string,
  args: Record<string, unknown>,
) =>
  Effect.gen(function* () {
    const kanban = yield* KanbanService.KanbanService;
    const store = yield* KanbanStore.KanbanStore;
    const created = yield* kanban.createCard(
      board.id,
      { prompt: title, title, description: "Explicit" },
      owner,
    );
    yield* store.putCard({ ...created, stage: "in_review", reviewStep: 1 });
    return yield* kanban.waitCard(
      created.id,
      { on: "script", script, args, note: `${title}: waiting on the check` },
      owner,
    );
  });

const waitOf = (cardId: KanbanCard["id"]) =>
  Effect.gen(function* () {
    const kanban = yield* KanbanService.KanbanService;
    return (yield* kanban.card(cardId)).card;
  });

// Answers each card by what its args ask for, and keeps what it was given.
const answering = (dump: string) =>
  [
    "import json, sys",
    "batch = json.load(sys.stdin)",
    `open(${JSON.stringify(dump)}, "a").write(json.dumps(batch) + "\\n")`,
    "for item in batch:",
    "    card = item['card']['number']",
    "    say = item['args'].get('say')",
    "    if say == 'wake':",
    "        print(json.dumps({'kanban': {'wait': {'card': f'#{card}', 'result': 'wake', 'to': 'work', 'note': 'ENG-1 is Done'}}}))",
    "    elif say == 'status':",
    "        print(json.dumps({'kanban': {'wait': {'card': card, 'result': 'hold', 'status': 'In Review'}}}))",
    "    elif say == 'garbage':",
    "        print(json.dumps({'kanban': {'wait': {'card': card, 'result': 'maybe'}}}))",
    "print(f'checked {len(batch)} cards')",
    "",
  ].join("\n");

it.effect(
  "checks every card waiting on a script in one run: the batch on stdin, a line per card it changes",
  () =>
    Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const scripts = yield* ScriptService.KanbanScripts;
      const board = yield* toyBoard;
      const dump = NodePath.join(
        NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-wait-check-")),
        "stdin.jsonl",
      );
      const script = yield* register(
        board,
        scriptFile(answering(dump), "check.py"),
        manual,
        "linear-state",
      );
      const woken = yield* parkedOn(board, "linear-state", "Woken", {
        say: "wake",
        issue: "ENG-1",
      });
      const noted = yield* parkedOn(board, "linear-state", "Noted", { say: "status" });
      const quiet = yield* parkedOn(board, "linear-state", "Quiet", {});
      const garbled = yield* parkedOn(board, "linear-state", "Garbled", { say: "garbage" });
      // Not this script's: a built-in wait and a card with no wait are not in the batch.
      const other = yield* kanban.createCard(
        board.id,
        { prompt: "Other", title: "Other", description: "Explicit" },
        owner,
      );

      yield* scripts.checkWaits;
      yield* scripts.idle;

      const runs = yield* scripts.runs(script.id, 10);
      assert.strictEqual(runs.length, 1);
      assert.strictEqual(runs[0]?.trigger, ScriptService.WAIT_CHECK_TRIGGER);
      assert.strictEqual(runs[0]?.exitCode, 0);
      assert.include(
        runs[0]?.output,
        `Ended the wait on card #${woken.number} and woke its worker.`,
      );
      assert.include(runs[0]?.output, `card #${noted.number} still waits.`);
      assert.include(runs[0]?.output, "checked 4 cards");

      // What the script read: one array, one input per waiting card, in the contract's shape.
      const batch = JSON.parse(NodeFS.readFileSync(dump, "utf8").trim()) as Array<{
        wait: { on: string; script: string; note: string };
        card: { id: string; number: number; title: string; stage: string; next: string };
        facts: { now: string; prs: Array<unknown>; cards: Array<unknown>; asks: Array<unknown> };
        args: Record<string, unknown>;
      }>;
      assert.deepStrictEqual(
        batch.map((item) => item.card.number).toSorted(),
        [woken.number, noted.number, quiet.number, garbled.number].toSorted(),
      );
      const first = batch.find((item) => item.card.id === woken.id)!;
      assert.deepStrictEqual(first.args, { say: "wake", issue: "ENG-1" });
      assert.deepInclude(first.wait, { on: "script", script: "linear-state" });
      assert.deepInclude(first.card, { title: "Woken", stage: "in_review", next: "evaluator" });
      assert.deepStrictEqual(Object.keys(first.facts).toSorted(), ["asks", "cards", "now", "prs"]);

      const after = yield* waitOf(woken.id);
      assert.isUndefined(after.wait);
      assert.strictEqual(after.stage, "todo");
      assert.include(
        after.wakeNote ?? "",
        "ENG-1 is Done. It was waiting for the linear-state script's check",
      );
      assert.deepInclude((yield* waitOf(noted.id)).wait, { status: "In Review", failures: 0 });
      // No line is a hold: still waiting, nothing wrong, and nothing new to show,
      // so its row was not written.
      const held = yield* waitOf(quiet.id);
      assert.deepInclude(held.wait, { status: null, failures: 0, problem: null });
      assert.isNull(held.wait?.lastCheckedAt);
      assert.strictEqual(held.updatedAt, quiet.updatedAt);
      // An answer nobody can read holds too, and shows as a problem.
      assert.deepInclude((yield* waitOf(garbled.id)).wait, {
        failures: 1,
        problem: "The check's answer could not be read",
      });
      assert.strictEqual((yield* waitOf(garbled.id)).stage, "in_review");
      assert.isUndefined((yield* waitOf(other.id)).wait);

      // Inside its rest the script is not run again, however often the pass comes round.
      yield* TestClock.adjust(30_000);
      yield* scripts.checkWaits;
      yield* scripts.idle;
      assert.strictEqual((yield* scripts.runs(script.id, 10)).length, 1);
      // After it, one more run, with only the cards still waiting.
      yield* TestClock.adjust(5 * 60_000);
      yield* scripts.checkWaits;
      yield* scripts.idle;
      assert.strictEqual((yield* scripts.runs(script.id, 10)).length, 2);
      const second = JSON.parse(NodeFS.readFileSync(dump, "utf8").trim().split("\n")[1]!) as Array<{
        card: { number: number };
      }>;
      assert.deepStrictEqual(
        second.map((item) => item.card.number).toSorted(),
        [noted.number, quiet.number, garbled.number].toSorted(),
      );
      assert.strictEqual((yield* waitOf(garbled.id)).wait?.failures, 2);
    }).pipe(Effect.provide(waitTestLayer)),
);

it.effect(
  "a check run that fails holds its waits, and the third failure in a row shows as check failing",
  () =>
    Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const scripts = yield* ScriptService.KanbanScripts;
      const board = yield* toyBoard;
      const script = yield* register(
        board,
        scriptFile(["echo 'Linear said 401' >&2", "exit 3", ""].join("\n")),
        manual,
        "linear-state",
      );
      const card = yield* parkedOn(board, "linear-state", "Held", { everyMs: 60_000 });
      const pass = Effect.gen(function* () {
        yield* scripts.checkWaits;
        yield* scripts.idle;
        yield* TestClock.adjust(60_000);
      });

      yield* pass;
      const once = yield* waitOf(card.id);
      assert.deepInclude(once.wait, {
        failures: 1,
        problem: "The linear-state script exited with code 3",
      });
      assert.strictEqual(once.stage, "in_review");
      yield* pass;
      yield* pass;
      const failing = yield* kanban.card(card.id);
      assert.strictEqual(failing.card.wait?.failures, 3);
      assert.strictEqual(
        failing.events.at(-1)?.body,
        "Wait check failing: 3 failures in a row while waiting for the linear-state script's check: The linear-state script exited with code 3",
      );
      assert.strictEqual((yield* scripts.runs(script.id, 10)).length, 3);

      // A script that is turned off, or gone, fails its waits the same way, without a run.
      yield* scripts.setEnabled(script.id, false);
      yield* pass;
      assert.deepInclude((yield* waitOf(card.id)).wait, {
        failures: 4,
        problem: "The linear-state script is turned off",
      });
      assert.strictEqual((yield* scripts.runs(script.id, 10)).length, 3);
    }).pipe(Effect.provide(waitTestLayer)),
);

it.effect(
  "a script's own run can push a wake or park a card, with the same guards as card_wait",
  () =>
    Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const store = yield* KanbanStore.KanbanStore;
      const scripts = yield* ScriptService.KanbanScripts;
      const board = yield* toyBoard;
      yield* register(board, scriptFile("exit 0\n", "noop.sh"), manual, "linear-state");
      const waiting = yield* parkedOn(board, "linear-state", "Waiting", {});
      const plain = yield* kanban.createCard(
        board.id,
        { prompt: "Plain", title: "Plain", description: "Explicit" },
        owner,
      );
      yield* store.putCard({ ...plain, stage: "in_review", reviewStep: 1 });
      const busy = yield* parkedOn(board, "linear-state", "Busy", {});
      // A thread picked this one up after its wait was set.
      yield* store.putCard({
        ...busy,
        activeThreadId: ThreadId.make("thread-busy"),
        activeRole: "work",
      });
      const todo = yield* kanban.createCard(
        board.id,
        { prompt: "Todo", title: "Todo", description: "Explicit" },
        owner,
      );

      const line = (value: unknown) => `echo '${JSON.stringify({ kanban: value })}'`;
      const hook = yield* register(
        board,
        scriptFile(
          [
            line({
              wake: { card: `#${waiting.number}`, to: "review", note: "v2.4.1 is live in prod" },
            }),
            line({ wake: { card: `#${plain.number}`, note: "v2.4.1 is live in prod" } }),
            line({ wake: { card: `#${busy.number}`, note: "v2.4.1 is live in prod" } }),
            line({ wake: { card: "#999", note: "nobody home" } }),
            // Only the check a card waits on can answer for it; this script is not it.
            line({ wait: { card: `#${busy.number}`, result: "hold", status: "not mine" } }),
            line({
              wait: {
                card: `#${plain.number}`,
                on: "time",
                until: "1970-01-02T00:00:00.000Z",
                note: "recheck after the release",
              },
            }),
            line({
              wait: {
                card: `#${todo.number}`,
                on: "time",
                until: "1970-01-02T00:00:00.000Z",
                note: "later",
              },
            }),
            line({
              wait: { card: `#${plain.number}`, on: "script", script: "no-such-check", note: "x" },
            }),
            "",
          ].join("\n"),
          "deploy-hook.sh",
        ),
        { _tag: "webhook" },
        "deploy-hook",
      );
      yield* scripts.run(hook.id, "webhook");
      yield* scripts.idle;

      const [run] = yield* scripts.runs(hook.id, 1);
      const output = run?.output ?? "";
      assert.include(output, `Ended the wait on card #${waiting.number} and woke its reviewer.`);
      assert.include(
        output,
        `Refused for card #${plain.number}: card #${plain.number} is not waiting`,
      );
      assert.include(
        output,
        `Refused for card #${busy.number}: card #${busy.number} has a running thread`,
      );
      assert.include(output, "Refused for card #999: No card #999 on this board.");
      assert.include(output, `Card #${plain.number} now waits (time).`);
      assert.include(output, `Card #${todo.number} now waits (time).`);
      assert.include(
        output,
        `Couldn't park card #${plain.number}: this board has no script named no-such-check`,
      );

      const woken = yield* waitOf(waiting.id);
      assert.isUndefined(woken.wait);
      assert.strictEqual(woken.stage, "needs_review");
      assert.include(woken.wakeNote ?? "", "v2.4.1 is live in prod");
      const parked = yield* waitOf(plain.id);
      assert.deepInclude(parked.wait, { on: "time", until: "1970-01-02T00:00:00.000Z" });
      assert.deepStrictEqual(parked.wait?.by, { _tag: "script", scriptId: hook.id });
      // Refused means untouched.
      assert.deepInclude((yield* waitOf(busy.id)).wait, {
        on: "script",
        status: null,
        failures: 0,
      });
      // A To-Do card can be parked too: the dispatcher leaves it until the wait ends.
      assert.deepInclude((yield* waitOf(todo.id)).wait, { on: "time" });
    }).pipe(Effect.provide(waitTestLayer)),
);

it.effect("the script scheduler runs the wait checks, once per rest", () =>
  Effect.gen(function* () {
    const scripts = yield* ScriptService.KanbanScripts;
    const board = yield* toyBoard;
    const script = yield* register(
      board,
      scriptFile("exit 0\n", "noop.sh"),
      manual,
      "linear-state",
    );
    const card = yield* parkedOn(board, "linear-state", "Parked", {});
    // The board's 30-second loop calls scripts.tick after its own tick.
    yield* scripts.tick;
    yield* scripts.idle;
    const runs = yield* scripts.runs(script.id, 10);
    assert.strictEqual(runs.length, 1);
    assert.strictEqual(runs[0]?.trigger, ScriptService.WAIT_CHECK_TRIGGER);
    // The check ran and held: the card says nothing new, so it was not written.
    const held = yield* waitOf(card.id);
    assert.isNull(held.wait?.lastCheckedAt);
    assert.strictEqual(held.updatedAt, card.updatedAt);
    yield* TestClock.adjust(30_000);
    yield* scripts.tick;
    yield* scripts.idle;
    assert.strictEqual((yield* scripts.runs(script.id, 10)).length, 1);
  }).pipe(Effect.provide(waitTestLayer)),
);

it.effect(
  "the reference check for a PR leaving draft holds on a draft and wakes the reviewer when it is ready",
  () =>
    Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const store = yield* KanbanStore.KanbanStore;
      const scripts = yield* ScriptService.KanbanScripts;
      const board = yield* toyBoard;
      const example = NodePath.resolve(
        import.meta.dirname,
        "../../../../../../docs/user/board-wait-checks/pr-ready.py",
      );
      yield* register(board, example, manual, "pr-ready");
      const pr = "https://github.com/acme/app/pull/12";
      const created = yield* kanban.createCard(
        board.id,
        {
          prompt: "Review PR 12",
          title: "Review PR 12",
          description: "Explicit",
          links: [{ url: pr }],
        },
        owner,
      );
      const link = (state: "draft" | "open") =>
        created.links.map((entry) => ({
          ...entry,
          state,
          checkedAt: "1970-01-01T00:00:00.000Z" as never,
        }));
      yield* store.putCard({ ...created, stage: "in_review", reviewStep: 1, links: link("draft") });
      yield* kanban.waitCard(
        created.id,
        {
          on: "script",
          script: "pr-ready",
          args: { everyMs: 60_000 },
          note: "author to mark it ready",
        },
        owner,
      );

      yield* scripts.checkWaits;
      yield* scripts.idle;
      const held = yield* waitOf(created.id);
      assert.deepInclude(held.wait, { status: "PR #12 is still a draft", failures: 0 });

      // The author marks it ready; the board's PR sync updates the link.
      yield* store.putCard({ ...held, links: link("open") });
      yield* TestClock.adjust(60_000);
      yield* scripts.checkWaits;
      yield* scripts.idle;
      const woken = yield* waitOf(created.id);
      assert.isUndefined(woken.wait);
      assert.strictEqual(woken.stage, "needs_review");
      assert.strictEqual(woken.reviewStep, 0);
      assert.include(woken.wakeNote ?? "", "PR #12 was marked ready for review");
    }).pipe(Effect.provide(waitTestLayer)),
);

it.effect(
  "gives a script check a host reading of the PRs its card links, when the wait PR reader is provided from outside",
  () => {
    const asked: Array<ReadonlyArray<Waits.WaitPrRequest>> = [];
    const pr = "https://github.com/acme/app/pull/12";
    // Provided around the board's own layers, the way server.ts does it.
    const withReader = waitTestLayer.pipe(
      Layer.provide(
        Layer.succeed(
          KanbanWaitPrs,
          KanbanWaitPrs.of({
            read: (requests) =>
              Effect.sync(() => {
                asked.push(requests);
                return {
                  readings: [
                    {
                      url: pr,
                      state: "open" as const,
                      head: "ffee0011",
                      at: "1970-01-01T00:00:00.000Z",
                    },
                  ],
                  read: [pr],
                  failed: [],
                  carried: [],
                };
              }),
          }),
        ),
      ),
    );
    return Effect.gen(function* () {
      const kanban = yield* KanbanService.KanbanService;
      const store = yield* KanbanStore.KanbanStore;
      const scripts = yield* ScriptService.KanbanScripts;
      const board = yield* toyBoard;
      const example = NodePath.resolve(
        import.meta.dirname,
        "../../../../../../docs/user/board-wait-checks/pr-ready.py",
      );
      yield* register(board, example, manual, "pr-ready");
      // An outside author's PR: attached as context, so the card's link has no state of its own.
      const created = yield* kanban.createCard(
        board.id,
        {
          prompt: "Review PR 12",
          title: "Review PR 12",
          description: "Explicit",
          links: [{ url: pr }],
        },
        owner,
      );
      yield* store.putCard({ ...created, stage: "in_review", reviewStep: 1 });
      yield* kanban.waitCard(
        created.id,
        { on: "script", script: "pr-ready", note: "author to mark it ready" },
        owner,
      );
      yield* scripts.checkWaits;
      yield* scripts.idle;
      assert.deepStrictEqual(asked, [
        [{ url: pr, projectId: board.defaultProjectId, needsHead: true, live: null }],
      ]);
      const woken = yield* waitOf(created.id);
      assert.isUndefined(woken.wait);
      assert.strictEqual(woken.stage, "needs_review");
    }).pipe(Effect.provide(withReader));
  },
);
