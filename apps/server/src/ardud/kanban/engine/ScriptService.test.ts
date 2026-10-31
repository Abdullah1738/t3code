// @effect-diagnostics nodeBuiltinImport:off - board scripts are real files the test writes.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import {
  ProjectId,
  ThreadId,
  type KanbanActor,
  type KanbanBoard,
  type KanbanCard,
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
import { layer as providerRegistryLayer } from "../../../provider/testUtils/providerRegistryMock.ts";
import { opencodeTestProvider } from "./testProviders.ts";
import { KanbanThreads } from "./threads.ts";

// Threads only matter here as somewhere for script posts to go.
const threads = Layer.succeed(
  KanbanThreads,
  KanbanThreads.of({
    view: () => Effect.succeed(null),
    find: () => Effect.succeed(null),
    lastFailure: () => Effect.succeed(null),
    launch: () => Effect.succeed(ThreadId.make("thread-1")),
    send: () => Effect.succeed({ runId: null }),
    model: () => Effect.succeed(null),
    setModel: () => Effect.void,
    interrupt: () => Effect.void,
  }),
);

const boardFilesLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-kanban-scripts-test-",
}).pipe(Layer.provideMerge(NodeServices.layer), Layer.provideMerge(ServerSettings.layerTest()));

const makeTestLayer = (threadsLayer: Layer.Layer<KanbanThreads>) =>
  ScriptService.layer.pipe(
    Layer.provideMerge(KanbanService.layer),
    Layer.provideMerge(KanbanModels.layerTest(null)),
    Layer.provideMerge(threadsLayer),
    Layer.provideMerge(KanbanStore.layer),
    Layer.provideMerge(Sqlite.layerMemory),
    Layer.provideMerge(Layer.mock(TextGeneration.TextGeneration)({})),
    Layer.provideMerge(Layer.mock(ProjectService.ProjectService)({})),
    Layer.provideMerge(providerRegistryLayer([opencodeTestProvider()])),
    Layer.provideMerge(boardFilesLayer),
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

it.effect("sets the evaluator pool from a script, and refuses 0", () =>
  Effect.gen(function* () {
    const kanban = yield* KanbanService.KanbanService;
    const scripts = yield* ScriptService.KanbanScripts;
    const board = yield* toyBoard;
    const script = yield* register(
      board,
      scriptFile(
        [
          `echo '{"kanban":"evaluators","slots":4}'`,
          `echo '{"kanban":"evaluators","slots":null}'`,
          `echo '{"kanban":"evaluators","slots":0}'`,
          "",
        ].join("\n"),
      ),
    );

    yield* scripts.run(script.id, "manual");
    yield* scripts.idle;

    const [done] = yield* scripts.runs(script.id, 1);
    assert.include(done?.output, "Set the evaluator pool to 4 slots.");
    assert.include(done?.output, "Set the evaluator pool to no limit.");
    // A bad line (0 slots) is dropped by the parser, so no note and the pool is untouched.
    assert.notInclude(done?.output, "evaluator pool to 0");
    assert.strictEqual((yield* kanban.snapshot(board.id)).board.evaluatorSlots, null);
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

it.effect("a script ticks its subtasks, hands one back and moves cards, waking the evaluator only for the hand-back", () => {
  const sent: Array<string> = [];
  const recording = Layer.succeed(
    KanbanThreads,
    KanbanThreads.of({
      view: () => Effect.succeed(null),
      find: () => Effect.succeed(null),
      lastFailure: () => Effect.succeed(null),
      launch: (input) => {
        sent.push(input.text ?? "");
        return Effect.succeed(ThreadId.make("thread-1"));
      },
      send: (input) => {
        sent.push(input.text ?? "");
        return Effect.succeed({ runId: null });
      },
      model: () => Effect.succeed(null),
      setModel: () => Effect.void,
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
        { prompt: "Oops", title: "Oops", subtasks: [{ text: "Merge", owner: "script", script: "nope" }] },
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
    assert.include(landOut, `Couldn't move card #${card.number}: card #${card.number} still has s2, s3 open`);
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
      `{"kanban":"handback","card":${card.number},"subtask":"s2","note":"again"}`,
    ]);
    assert.include(againOut, `Couldn't hand s2 on card #${card.number} back: subtask s2 isn't a script's`);
    assert.strictEqual(sent.filter((text) => text.includes('"again"')).length, 0);
  }).pipe(Effect.provide(makeTestLayer(recording)));
});

it.effect("a subtask a script ticks, which moves a deployed card back to todo, wakes no card.moved script", () =>
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

    const stored = (yield* kanban.snapshot(board.id)).cards.find((entry) => entry.number === card.number)!;
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
