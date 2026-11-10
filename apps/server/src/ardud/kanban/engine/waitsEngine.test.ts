// @effect-diagnostics nodeBuiltinImport:off - board scripts are real files the test writes.
/**
 * Waits with the board's tick actually running: the real service, store and
 * script service, a fake thread host and a fake host PR reader. The pure rules
 * are in waits.test.ts; this file is about what the board does with them.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import {
  KanbanCard,
  KanbanCardDetail,
  KanbanCardEvent,
  kanbanWaitCheckFailing,
  kanbanWaiting,
  ProjectId,
  ThreadId,
  type KanbanActor,
  type KanbanBoard,
  type KanbanLink,
  type ModelSelection,
} from "@t3tools/contracts";

import * as ServerConfig from "../../../config.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as Sqlite from "../../../persistence/Sqlite.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as TextGeneration from "../../../textGeneration/TextGeneration.ts";
import { layer as providerRegistryLayer } from "../../../provider/testUtils/providerRegistryMock.ts";
import * as KanbanStore from "../store/KanbanStore.ts";
import { compactBoard } from "./boardReplies.ts";
import * as KanbanService from "./KanbanService.ts";
import * as KanbanModels from "./models.ts";
import * as ScriptService from "./ScriptService.ts";
import { opencodeTestProvider } from "./testProviders.ts";
import { KanbanThreads, type KanbanThreadPr, type KanbanThreadView } from "./threads.ts";
import { KanbanWaitPrs } from "./waitPrs.ts";
import * as Waits from "./waits.ts";

const T0 = Date.parse("2026-11-10T08:00:00.000Z");
const PR = "https://github.com/acme/app/pull/12";
const OTHER_PR = "https://github.com/acme/app/pull/13";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const owner: KanbanActor = { _tag: "owner" };

interface FakeThread {
  readonly title: string;
  readonly model: ModelSelection;
  readonly messages: Array<string>;
  running: boolean;
}

/** One test's outside world: its threads, the PRs they track and what the host says about PRs. */
const makeWorld = (options: { readonly reader?: boolean } = {}) => {
  const threads = new Map<string, FakeThread>();
  /** The PRs a work thread tracks, as its view reports them. */
  const prs = new Map<string, ReadonlyArray<KanbanThreadPr>>();
  /** What the host answers when the wait PR reader asks. A PR not listed could not be read. */
  const host: { readings: Array<Waits.WaitPrFacts>; asked: Array<ReadonlyArray<string>> } = {
    readings: [],
    asked: [],
  };
  let next = 0;
  const view = (threadId: ThreadId) =>
    Effect.map(Clock.currentTimeMillis, (nowMs): KanbanThreadView | null => {
      const thread = threads.get(threadId);
      if (!thread) return null;
      return {
        threadId,
        projectId: ProjectId.make("project-1"),
        title: thread.title,
        state: thread.running ? "running" : "idle",
        updatedAt: iso(nowMs),
        quietSince: iso(T0),
        runStartedAt: null,
        backgroundWork: 0,
        prs: prs.get(threadId) ?? [],
        archived: false,
      };
    });
  const threadsLayer = Layer.succeed(
    KanbanThreads,
    KanbanThreads.of({
      view,
      find: view,
      lastFailure: () => Effect.succeed(null),
      findLastFailure: () => Effect.succeed(null),
      latestRun: () => Effect.succeed(null),
      compactRun: () => Effect.succeed(null),
      launch: (input) =>
        Effect.sync(() => {
          next += 1;
          const threadId = ThreadId.make(`thread-${next}`);
          threads.set(threadId, {
            title: input.title,
            model: input.model,
            messages: [input.text],
            running: false,
          });
          return threadId;
        }),
      send: (input) =>
        Effect.sync(() => void threads.get(input.threadId)?.messages.push(input.text)),
      model: () => Effect.succeed(null),
      setModel: () => Effect.void,
      interrupt: () => Effect.void,
    }),
  );
  // Like the real reader: one reading per PR asked about, the thread's own merged in.
  const readerLayer = Layer.succeed(
    KanbanWaitPrs,
    KanbanWaitPrs.of({
      read: (requests) =>
        Effect.sync(() => {
          host.asked.push(requests.map((request) => request.url));
          const wanted = new Set(requests.map((request) => Waits.prKey(request.url)));
          const read = host.readings.filter((reading) => wanted.has(Waits.prKey(reading.url)));
          return {
            readings: Waits.mergePrReadings(
              requests.flatMap((request) => (request.live === null ? [] : [request.live])),
              read,
            ),
            read: read.map((reading) => reading.url),
            failed: requests
              .filter((request) => !read.some((reading) => reading.url === request.url))
              .map((request) => request.url),
            carried: [],
          };
        }),
    }),
  );
  const layer = ScriptService.layer.pipe(
    Layer.provideMerge(KanbanService.layer),
    Layer.provideMerge(KanbanModels.layerTest(null)),
    Layer.provideMerge(threadsLayer),
    // The reader is provided around the board's layers, the way server.ts does it.
    Layer.provideMerge(options.reader === false ? Layer.empty : readerLayer),
    Layer.provideMerge(KanbanStore.layer),
    Layer.provideMerge(Sqlite.layerMemory),
    Layer.provideMerge(Layer.mock(TextGeneration.TextGeneration)({})),
    Layer.provideMerge(Layer.mock(ProjectService.ProjectService)({})),
    Layer.provideMerge(providerRegistryLayer([opencodeTestProvider()])),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-kanban-waits-engine-test-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
        Layer.provideMerge(ServerSettings.layerTest()),
      ),
    ),
  );
  const said = (text: string, where: (thread: FakeThread) => boolean = () => true) =>
    [...threads.values()]
      .filter(where)
      .flatMap((thread) => thread.messages)
      .filter((message) => message.includes(text)).length;
  return {
    threads,
    prs,
    host,
    layer,
    /** Messages anywhere that include `text`. */
    said,
    /** Messages to evaluator threads that include `text`. */
    toldEvaluator: (text: string) => said(text, (thread) => thread.title.startsWith("Evaluator")),
    /** Threads that are not evaluators: workers and reviewers the dispatcher started. */
    cardThreads: () =>
      [...threads.values()].filter((thread) => !thread.title.startsWith("Evaluator")).length,
  };
};
type World = ReturnType<typeof makeWorld>;

const setup = Effect.gen(function* () {
  yield* TestClock.setTime(T0);
  const kanban = yield* KanbanService.KanbanService;
  const store = yield* KanbanStore.KanbanStore;
  const made = yield* kanban.ensureBoard({
    slug: "waits",
    name: "Waits",
    defaultProjectId: ProjectId.make("project-1"),
  });
  const board = yield* kanban.updateBoard(made.id, {
    reviewChains: [{ name: "Standard", steps: [made.evaluatorModel] }],
    defaultReviewChain: "Standard",
  });
  yield* kanban.setPool(board.id, board.defaultCardModel, 4);
  return { kanban, store, board };
});

/** A tracked PR link: the board watches its state (a link attached as context has none). */
const tracked = (url: string, state: KanbanLink["state"] = "open"): KanbanLink => ({
  kind: "pr",
  url: url as KanbanLink["url"],
  label: null,
  state,
  checkedAt: iso(T0) as KanbanLink["checkedAt"],
});

/** A card with no thread, placed where a test needs it. */
const placed = (
  board: KanbanBoard,
  title: string,
  patch: Partial<Pick<KanbanCard, "stage" | "reviewStep" | "links">> = {},
) =>
  Effect.gen(function* () {
    const kanban = yield* KanbanService.KanbanService;
    const store = yield* KanbanStore.KanbanStore;
    const created = yield* kanban.createCard(
      board.id,
      { prompt: title, title, description: "Explicit" },
      owner,
    );
    yield* store.putCard({ ...created, ...patch });
    return (yield* kanban.card(created.id)).card;
  });

const cardOf = (cardId: KanbanCard["id"]) =>
  Effect.gen(function* () {
    const kanban = yield* KanbanService.KanbanService;
    return (yield* kanban.card(cardId)).card;
  });

const eventsOf = (cardId: KanbanCard["id"]) =>
  Effect.gen(function* () {
    const kanban = yield* KanbanService.KanbanService;
    return (yield* kanban.card(cardId)).events;
  });

/** The first message of the thread now running the card: its brief. */
const briefOf = (world: World, card: KanbanCard) =>
  world.threads.get(card.activeThreadId ?? "")?.messages[0] ?? "";

const scriptFile = (body: string, name: string) => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-waits-engine-"));
  const path = NodePath.join(dir, name);
  NodeFS.writeFileSync(path, body);
  return path;
};

/** One turn of the server's 30-second loop: the board's tick, then the scripts'. */
const loop = Effect.gen(function* () {
  const kanban = yield* KanbanService.KanbanService;
  const scripts = yield* ScriptService.KanbanScripts;
  yield* kanban.tick;
  yield* scripts.tick;
  yield* scripts.idle;
});

const inWorld = <A, E>(
  body: (world: World) => Effect.Effect<A, E, Layer.Success<World["layer"]>>,
  options: { readonly reader?: boolean } = {},
) =>
  Effect.suspend(() => {
    const world = makeWorld(options);
    return body(world).pipe(Effect.provide(world.layer));
  });

it.effect("push: a new head after the wait was set sends the card back to its reviewer", () =>
  inWorld((world) =>
    Effect.gen(function* () {
      const { kanban, board } = yield* setup;
      // The reviewer found problems on an outside author's PR and handed the card on.
      const card = yield* placed(board, "Review PR 12", {
        stage: "in_review",
        reviewStep: 1,
        links: [tracked(PR)],
      });
      yield* kanban.waitCard(
        card.id,
        { on: "push", pr: "#12", head: "aaa1111", note: "author to fix the rounding" },
        owner,
      );
      world.host.readings = [{ url: PR, state: "open", head: "aaa1111ffff", at: iso(T0) }];
      yield* kanban.tick;
      // Same commit: nothing moved, nobody started.
      assert.deepInclude((yield* cardOf(card.id)).wait, { on: "push", sinceHead: "aaa1111" });
      assert.strictEqual(world.cardThreads(), 0);
      assert.deepStrictEqual(world.host.asked.at(-1), [PR]);

      yield* TestClock.adjust(10 * MINUTE);
      world.host.readings = [
        { url: PR, state: "open", head: "bbb2222ffff", at: iso(T0 + 10 * MINUTE) },
      ];
      yield* kanban.tick;
      const woken = yield* cardOf(card.id);
      assert.isUndefined(woken.wait);
      // The same tick's dispatch started the review again, from the first step.
      assert.strictEqual(woken.stage, "in_review");
      assert.strictEqual(woken.activeRole, "review");
      assert.strictEqual(woken.reviewStep, 0);
      assert.include(
        briefOf(world, woken),
        "The author pushed to app#12: its head moved from aaa1111 to bbb2222",
      );
      assert.include(briefOf(world, woken), "author to fix the rounding");
      assert.strictEqual(world.toldEvaluator("no longer waiting"), 0);
    }),
  ),
);

it.effect("merge: the worker of a To-Do card is started when the PR it waited on merges", () =>
  inWorld((world) =>
    Effect.gen(function* () {
      const { kanban, board } = yield* setup;
      const card = yield* placed(board, "Build on the parent", { links: [tracked(PR)] });
      yield* kanban.waitCard(
        card.id,
        { on: "merge", pr: PR, note: "parent PR lands first" },
        owner,
      );
      world.host.readings = [{ url: PR, state: "open", at: iso(T0) }];
      yield* kanban.tick;
      assert.strictEqual((yield* cardOf(card.id)).stage, "todo");
      assert.strictEqual(world.cardThreads(), 0);

      yield* TestClock.adjust(5 * MINUTE);
      world.host.readings = [{ url: PR, state: "merged", at: iso(T0 + 5 * MINUTE) }];
      yield* kanban.tick;
      const woken = yield* cardOf(card.id);
      assert.isUndefined(woken.wait);
      assert.strictEqual(woken.stage, "working");
      assert.strictEqual(woken.activeRole, "work");
      assert.include(briefOf(world, woken), "app#12 merged");
      assert.include(briefOf(world, woken), "parent PR lands first");
      // The host's merge reached the card's own link.
      assert.strictEqual(woken.links[0]?.state, "merged");
    }),
  ),
);

it.effect(
  "merge: a reviewed card whose last PR merges is completed by the same tick, with nobody woken",
  () =>
    inWorld((world) =>
      Effect.gen(function* () {
        const { kanban, board } = yield* setup;
        // No work thread watches this PR: only the host reader knows it merged.
        const card = yield* placed(board, "Review PR 12", {
          stage: "in_review",
          reviewStep: 1,
          links: [tracked(PR)],
        });
        yield* kanban.waitCard(card.id, { on: "merge", pr: PR, note: "author to merge" }, owner);
        world.host.readings = [{ url: PR, state: "open", at: iso(T0) }];
        yield* kanban.tick;
        assert.strictEqual((yield* cardOf(card.id)).stage, "in_review");

        yield* TestClock.adjust(5 * MINUTE);
        world.host.readings = [{ url: PR, state: "merged", at: iso(T0 + 5 * MINUTE) }];
        yield* kanban.tick;
        const done = yield* cardOf(card.id);
        assert.isUndefined(done.wait);
        assert.strictEqual(done.stage, "completed");
        assert.strictEqual(done.links[0]?.state, "merged");
        assert.include(
          (yield* eventsOf(card.id)).map((event) => event.body),
          "Wait ended: app#12 merged",
        );
        assert.strictEqual(world.cardThreads(), 0);
        assert.strictEqual(world.toldEvaluator("no longer waiting"), 0);
      }),
    ),
);

it.effect("ci: green starts the reviewer of a card awaiting review; red starts the worker", () =>
  inWorld((world) =>
    Effect.gen(function* () {
      const { kanban, board } = yield* setup;
      const review = yield* placed(board, "Review when green", {
        stage: "needs_review",
        links: [tracked(PR)],
      });
      const fix = yield* placed(board, "Fix when red", { links: [tracked(OTHER_PR)] });
      yield* kanban.waitCard(review.id, { on: "ci", pr: PR, note: "CI first" }, owner);
      yield* kanban.waitCard(fix.id, { on: "ci", pr: OTHER_PR, note: "see what CI says" }, owner);
      const reading = (checks: "pending" | "passing" | "failing", url: string, at: number) =>
        ({ url, state: "open", head: "abc1234ffff", checks, at: iso(at) }) as const;
      world.host.readings = [reading("pending", PR, T0), reading("pending", OTHER_PR, T0)];
      yield* kanban.tick;
      assert.strictEqual(world.cardThreads(), 0);
      assert.strictEqual((yield* cardOf(review.id)).stage, "needs_review");

      yield* TestClock.adjust(5 * MINUTE);
      world.host.readings = [
        reading("passing", PR, T0 + 5 * MINUTE),
        reading("failing", OTHER_PR, T0 + 5 * MINUTE),
      ];
      yield* kanban.tick;
      const reviewing = yield* cardOf(review.id);
      assert.isUndefined(reviewing.wait);
      assert.strictEqual(reviewing.activeRole, "review");
      assert.include(briefOf(world, reviewing), "CI passed on app#12 at abc1234");
      const fixing = yield* cardOf(fix.id);
      assert.isUndefined(fixing.wait);
      assert.strictEqual(fixing.activeRole, "work");
      assert.include(briefOf(world, fixing), "CI failed on app#13 at abc1234");
    }),
  ),
);

it.effect("card: the worker starts when the card it waited on is done", () =>
  inWorld((world) =>
    Effect.gen(function* () {
      const { kanban, store, board } = yield* setup;
      // Kept away from the dispatcher so this test ends it by hand.
      const first = yield* placed(board, "First", { stage: "in_review", reviewStep: 1 });
      const second = yield* placed(board, "Second");
      yield* kanban.waitCard(
        second.id,
        { on: "card", card: first.id, note: "needs the first one's schema" },
        owner,
      );
      yield* kanban.tick;
      assert.strictEqual((yield* cardOf(second.id)).stage, "todo");
      assert.strictEqual(world.cardThreads(), 0);

      yield* TestClock.adjust(5 * MINUTE);
      yield* store.putCard({ ...(yield* cardOf(first.id)), stage: "completed" });
      yield* kanban.tick;
      const woken = yield* cardOf(second.id);
      assert.isUndefined(woken.wait);
      assert.strictEqual(woken.activeRole, "work");
      assert.include(briefOf(world, woken), `Card #${first.number} is done`);
    }),
  ),
);

it.effect("time: the card is held until the time set, then its worker starts", () =>
  inWorld((world) =>
    Effect.gen(function* () {
      const { kanban, board } = yield* setup;
      const card = yield* placed(board, "Recheck the deploy");
      yield* kanban.waitCard(
        card.id,
        { on: "time", until: iso(T0 + HOUR), note: "recheck after the release window" },
        owner,
      );
      yield* kanban.tick;
      yield* TestClock.adjust(59 * MINUTE);
      yield* kanban.tick;
      assert.isDefined((yield* cardOf(card.id)).wait);
      assert.strictEqual(world.cardThreads(), 0);

      yield* TestClock.adjust(2 * MINUTE);
      yield* kanban.tick;
      const woken = yield* cardOf(card.id);
      assert.isUndefined(woken.wait);
      assert.strictEqual(woken.activeRole, "work");
      assert.include(briefOf(world, woken), "The time you set has passed");
      assert.include(briefOf(world, woken), "recheck after the release window");
    }),
  ),
);

it.effect("owner_go: the wait ends when the owner answers the question it points at", () =>
  inWorld((world) =>
    Effect.gen(function* () {
      const { kanban, board } = yield* setup;
      const card = yield* placed(board, "Review the hotfix", { stage: "needs_review" });
      const asked = yield* kanban.askOwner(
        card.id,
        { question: "Review this before the freeze?", blocking: false },
        owner,
        "owner",
      );
      assert.strictEqual(asked.asks[0]?.id, "q1");
      yield* kanban.waitCard(
        card.id,
        { on: "owner_go", ask: "q1", wakeRole: "review", note: "his go on the review" },
        owner,
      );
      yield* kanban.tick;
      yield* TestClock.adjust(20 * MINUTE);
      yield* kanban.tick;
      // Open question: no reviewer.
      assert.strictEqual((yield* cardOf(card.id)).stage, "needs_review");
      assert.strictEqual(world.cardThreads(), 0);

      const talk = yield* kanban.cardDiscussion(card.id);
      yield* kanban.post(talk.id, owner, [{ _tag: "md", text: "Yes, go" }]);
      assert.isNotNull((yield* cardOf(card.id)).asks[0]?.closedAt);
      yield* kanban.tick;
      const woken = yield* cardOf(card.id);
      assert.isUndefined(woken.wait);
      assert.strictEqual(woken.activeRole, "review");
      assert.include(briefOf(world, woken), "Question q1 was answered or dropped");
    }),
  ),
);

it.effect(
  "a waiting card is not dispatched, cannot be claimed, is not nudged and shows as waiting, not stalled",
  () =>
    inWorld((world) =>
      Effect.gen(function* () {
        const { kanban, board } = yield* setup;
        const evaluator: KanbanActor = { _tag: "evaluator", threadId: ThreadId.make("eval-1") };
        const packet = (title: string) =>
          kanban.createCard(
            board.id,
            {
              prompt: title,
              title,
              priority: 1,
              subtasks: [
                { step: 1, owner: "evaluator", text: "Packet" },
                { step: 2, owner: "work", text: "Build" },
              ],
            },
            evaluator,
          );
        const free = yield* placed(board, "Free");
        const parked = yield* placed(board, "Parked");
        // Two cards whose step is the evaluator's: one parked, one not.
        const parkedStep = yield* packet("Parked packet");
        const openStep = yield* packet("Open packet");
        const until = iso(T0 + 5 * 24 * HOUR);
        yield* kanban.waitCard(parked.id, { on: "time", until, note: "after the audit" }, owner);
        yield* kanban.waitCard(
          parkedStep.id,
          { on: "time", until, note: "packet after the audit" },
          evaluator,
        );

        yield* kanban.tick;
        // The dispatcher runs: the free card got its worker, the parked one did not.
        const working = yield* cardOf(free.id);
        assert.strictEqual(working.stage, "working");
        assert.strictEqual(world.cardThreads(), 1);
        assert.strictEqual((yield* cardOf(parked.id)).stage, "todo");
        world.threads.get(working.activeThreadId!)!.running = true;

        // A work thread can't take it either.
        const refused = yield* kanban
          .claimCard(working.activeThreadId!, parked.id)
          .pipe(Effect.flip);
        assert.strictEqual(refused.code, "denied");
        assert.include(refused.detail, `card #${parked.number} is waiting (after the audit)`);

        // Three hours of ticks: past every reminder the board has for a quiet card.
        for (let turn = 0; turn < 9; turn += 1) {
          yield* TestClock.adjust(20 * MINUTE);
          yield* kanban.tick;
        }
        const still = yield* cardOf(parked.id);
        assert.strictEqual(still.stage, "todo");
        assert.isNull(still.activeThreadId);
        assert.isNull(still.stalled);
        assert.isTrue(kanbanWaiting(still));
        assert.isNull((yield* cardOf(parkedStep.id)).stalled);
        assert.strictEqual(world.cardThreads(), 1);
        // The evaluator was reminded of the open packet once, and never of the parked one.
        assert.strictEqual(world.said(`#${openStep.number}`), 1);
        assert.strictEqual(world.said("has waited"), 1);
        assert.strictEqual(world.said(`#${parkedStep.number}`), 0);
        assert.strictEqual(world.said(`#${parked.number}`), 0);
        // The board reads it as waiting, with what for.
        const compact = compactBoard(yield* kanban.snapshot(board.id));
        const line = compact.cards.find((entry) => entry.id === parked.id);
        assert.strictEqual(line?.status, `Waiting until ${until}: after the audit`);
        assert.isNull(line?.stalled);
        assert.deepInclude(line?.wait, { on: "time", failures: 0 });

        // Cleared by hand: the card can be taken again.
        yield* kanban.waitCard(parked.id, null, owner);
        const taken = yield* kanban.claimCard(working.activeThreadId!, parked.id);
        assert.strictEqual(taken.card.stage, "working");
      }),
    ),
);

it.effect(
  "expiry: at the limit the evaluator is told once and no worker is started; the wait still ends normally",
  () =>
    inWorld((world) =>
      Effect.gen(function* () {
        const { kanban, board } = yield* setup;
        const card = yield* placed(board, "Fix when CI answers", { links: [tracked(PR)] });
        yield* kanban.waitCard(card.id, { on: "ci", pr: PR, note: "nightly CI" }, owner);
        const pending = (at: number) =>
          ({ url: PR, state: "open", head: "abc1234", checks: "pending", at: iso(at) }) as const;
        world.host.readings = [pending(T0)];
        yield* kanban.tick;
        yield* TestClock.adjust(2 * HOUR + 59 * MINUTE);
        world.host.readings = [pending(T0 + 2 * HOUR + 59 * MINUTE)];
        yield* kanban.tick;
        assert.strictEqual(world.toldEvaluator("is stuck"), 0);

        yield* TestClock.adjust(2 * MINUTE);
        yield* kanban.tick;
        assert.strictEqual(world.toldEvaluator(`Card #${card.number}`), 1);
        assert.strictEqual(world.toldEvaluator("is stuck: waited 3h"), 1);
        const expired = yield* cardOf(card.id);
        assert.isNotNull(expired.wait?.expiredAt);
        assert.strictEqual(expired.stage, "todo");
        assert.isNull(expired.activeThreadId);
        assert.strictEqual(world.cardThreads(), 0);

        // Told once, however long it goes on.
        for (let turn = 0; turn < 4; turn += 1) {
          yield* TestClock.adjust(30 * MINUTE);
          yield* kanban.tick;
        }
        assert.strictEqual(world.toldEvaluator("is stuck"), 1);
        assert.strictEqual(world.cardThreads(), 0);
        assert.strictEqual(
          (yield* eventsOf(card.id)).filter((event) => event.body?.startsWith("Wait expired:"))
            .length,
          1,
        );

        // An expired wait is still a wait: CI going green ends it.
        world.host.readings = [
          { url: PR, state: "open", head: "abc1234", checks: "passing", at: iso(T0 + 6 * HOUR) },
        ];
        yield* kanban.tick;
        const woken = yield* cardOf(card.id);
        assert.isUndefined(woken.wait);
        assert.strictEqual(woken.activeRole, "work");
      }),
    ),
);

it.effect(
  "a reviewed card parked on a wait stays in review, though it has no PR left to land",
  () =>
    inWorld((world) =>
      Effect.gen(function* () {
        const { kanban, store, board } = yield* setup;
        // Review passed on an outside author's PR, attached as context: nothing for the board to land.
        const created = yield* kanban.createCard(
          board.id,
          { prompt: "Review PR 12", title: "Review PR 12", links: [{ url: PR }] },
          owner,
        );
        yield* store.putCard({ ...created, stage: "in_review", reviewStep: 1 });
        yield* kanban.waitCard(
          created.id,
          { on: "time", until: iso(T0 + HOUR), note: "see if the author replied" },
          owner,
        );
        for (let turn = 0; turn < 3; turn += 1) {
          yield* kanban.tick;
          yield* TestClock.adjust(15 * MINUTE);
        }
        const held = yield* cardOf(created.id);
        assert.strictEqual(held.stage, "in_review");
        assert.isDefined(held.wait);
        assert.strictEqual(world.toldEvaluator("no longer waiting"), 0);

        // The time comes: the evaluator, who is next on a reviewed card, is told once.
        yield* TestClock.adjust(20 * MINUTE);
        yield* kanban.tick;
        yield* kanban.tick;
        assert.isUndefined((yield* cardOf(created.id)).wait);
        assert.strictEqual(
          world.toldEvaluator("is no longer waiting: The time you set has passed"),
          1,
        );
        assert.strictEqual(world.cardThreads(), 0);
      }),
    ),
);

it.effect("a card with a running thread is left alone, whatever its wait says", () =>
  inWorld((world) =>
    Effect.gen(function* () {
      const { kanban, store, board } = yield* setup;
      const card = yield* placed(board, "Busy");
      yield* kanban.tick;
      const working = yield* cardOf(card.id);
      assert.strictEqual(working.stage, "working");
      world.threads.get(working.activeThreadId!)!.running = true;
      // A wait left on a card a thread then picked up: the thread is the truth.
      const wait = Waits.newWait(
        { on: "time", until: iso(T0 + 10 * MINUTE), note: "left behind" },
        owner,
        iso(T0),
      );
      yield* store.putCard({ ...working, wait });
      const before = (yield* eventsOf(card.id)).length;

      yield* TestClock.adjust(30 * MINUTE);
      yield* kanban.tick;
      yield* kanban.tick;
      const after = yield* cardOf(card.id);
      assert.strictEqual(after.stage, "working");
      assert.strictEqual(after.activeThreadId, working.activeThreadId);
      assert.deepStrictEqual(after.wait, wait);
      assert.strictEqual((yield* eventsOf(card.id)).length, before);
      assert.strictEqual(world.said("The time you set has passed"), 0);
    }),
  ),
);

it.effect("a PR nobody could read holds the wait: unknown is not done", () =>
  inWorld((world) =>
    Effect.gen(function* () {
      const { kanban, board } = yield* setup;
      // Attached as context: the card's own link has no state to fall back on.
      const created = yield* kanban.createCard(
        board.id,
        { prompt: "Build on PR 12", title: "Build on PR 12", links: [{ url: PR }] },
        owner,
      );
      yield* kanban.waitCard(created.id, { on: "merge", pr: PR, note: "parent first" }, owner);
      // The host answers nothing: rate limited, down, or the PR is not visible to this account.
      world.host.readings = [];
      for (let turn = 0; turn < 3; turn += 1) {
        yield* kanban.tick;
        yield* TestClock.adjust(5 * MINUTE);
      }
      const held = yield* cardOf(created.id);
      assert.deepInclude(held.wait, { on: "merge", expiredAt: null });
      assert.strictEqual(held.stage, "todo");
      assert.strictEqual(world.cardThreads(), 0);
      assert.isAtLeast(world.host.asked.length, 3);
      // One event: the wait being set.
      assert.strictEqual(
        (yield* eventsOf(created.id)).filter((event) => event.body?.startsWith("Wait")).length,
        1,
      );
    }),
  ),
);

it.effect("a reading older than the wait holds; the first one taken after it ends the wait", () =>
  inWorld((world) =>
    Effect.gen(function* () {
      const { kanban, board } = yield* setup;
      const card = yield* placed(board, "Review when green", {
        stage: "needs_review",
        links: [tracked(PR)],
      });
      yield* TestClock.adjust(10 * MINUTE);
      yield* kanban.waitCard(card.id, { on: "ci", pr: PR, note: "the re-run" }, owner);
      // Green, but read a minute before the wait was set: that was the run before the re-run.
      world.host.readings = [
        { url: PR, state: "open", head: "abc1234", checks: "passing", at: iso(T0 + 9 * MINUTE) },
      ];
      yield* kanban.tick;
      yield* TestClock.adjust(MINUTE);
      yield* kanban.tick;
      assert.isDefined((yield* cardOf(card.id)).wait);
      assert.strictEqual(world.cardThreads(), 0);

      world.host.readings = [
        { url: PR, state: "open", head: "abc1234", checks: "passing", at: iso(T0 + 11 * MINUTE) },
      ];
      yield* kanban.tick;
      const woken = yield* cardOf(card.id);
      assert.isUndefined(woken.wait);
      assert.strictEqual(woken.activeRole, "review");
    }),
  ),
);

it.effect("without a host reader the work thread's own reading of its PR still ends the wait", () =>
  inWorld(
    (world) =>
      Effect.gen(function* () {
        const { kanban, store, board } = yield* setup;
        const card = yield* placed(board, "Ship it");
        yield* kanban.tick;
        const working = yield* cardOf(card.id);
        const thread = working.activeThreadId!;
        world.prs.set(thread, [{ url: PR, title: "Ship it", state: "open", at: iso(T0) }]);
        // Reviewed and handed on: the thread is done, its PR is open.
        yield* store.putCard({
          ...working,
          stage: "in_review",
          reviewStep: 1,
          activeThreadId: null,
          activeRole: null,
          links: [tracked(PR)],
        });
        yield* kanban.waitCard(card.id, { on: "merge", pr: PR, note: "owner merges" }, owner);
        yield* kanban.tick;
        assert.strictEqual((yield* cardOf(card.id)).stage, "in_review");

        yield* TestClock.adjust(5 * MINUTE);
        world.prs.set(thread, [
          { url: PR, title: "Ship it", state: "merged", at: iso(T0 + 5 * MINUTE) },
        ]);
        yield* kanban.tick;
        const done = yield* cardOf(card.id);
        assert.isUndefined(done.wait);
        assert.strictEqual(done.stage, "completed");
        assert.deepStrictEqual(world.host.asked, []);
      }),
    { reader: false },
  ),
);

const prReady = NodePath.resolve(
  import.meta.dirname,
  "../../../../../../docs/user/board-wait-checks/pr-ready.py",
);

it.effect(
  "a script wait runs end to end: the loop gives pr-ready.py the host's reading and its answer wakes the reviewer",
  () =>
    inWorld((world) =>
      Effect.gen(function* () {
        const { kanban, board } = yield* setup;
        const scripts = yield* ScriptService.KanbanScripts;
        const script = yield* scripts.register(
          { boardId: board.id, name: "pr-ready", path: prReady, trigger: { _tag: "manual" } },
          owner,
        );
        // An outside author's draft PR, attached as context.
        const created = yield* kanban.createCard(
          board.id,
          { prompt: "Review PR 12", title: "Review PR 12", links: [{ url: PR }] },
          owner,
        );
        const store = yield* KanbanStore.KanbanStore;
        yield* store.putCard({ ...created, stage: "in_review", reviewStep: 1 });
        yield* kanban.waitCard(
          created.id,
          {
            on: "script",
            script: "pr-ready",
            args: { everyMs: MINUTE },
            note: "author to mark it ready",
          },
          owner,
        );

        world.host.readings = [{ url: PR, state: "draft", head: "abc1234", at: iso(T0) }];
        yield* loop;
        const held = yield* cardOf(created.id);
        assert.deepInclude(held.wait, { status: "PR #12 is still a draft", failures: 0 });
        assert.isNotNull(held.wait?.lastCheckedAt);
        assert.strictEqual(world.cardThreads(), 0);
        // Inside the script's rest the loop does not run it again.
        yield* TestClock.adjust(30_000);
        yield* loop;
        assert.strictEqual((yield* scripts.runs(script.id, 10)).length, 1);

        // The author marks it ready.
        yield* TestClock.adjust(MINUTE);
        world.host.readings = [
          { url: PR, state: "open", head: "abc1234", at: iso(T0 + MINUTE + 30_000) },
        ];
        yield* loop;
        const runs = yield* scripts.runs(script.id, 10);
        assert.strictEqual(runs.length, 2);
        assert.isTrue(runs.every((run) => run.trigger === ScriptService.WAIT_CHECK_TRIGGER));
        const woken = yield* cardOf(created.id);
        assert.isUndefined(woken.wait);
        assert.strictEqual(woken.stage, "needs_review");
        assert.strictEqual(woken.reviewStep, 0);
        assert.include(woken.wakeNote ?? "", "PR #12 was marked ready for review");

        // The next turn of the loop starts the review, with the note.
        yield* loop;
        const reviewing = yield* cardOf(created.id);
        assert.strictEqual(reviewing.activeRole, "review");
        assert.include(briefOf(world, reviewing), "PR #12 was marked ready for review");
        assert.include(briefOf(world, reviewing), "author to mark it ready");
      }),
    ),
);

it.effect(
  "a script check that fails three times in a row marks the wait as check failing and tells the evaluator once",
  () =>
    inWorld((world) =>
      Effect.gen(function* () {
        const { kanban, board } = yield* setup;
        const scripts = yield* ScriptService.KanbanScripts;
        yield* scripts.register(
          {
            boardId: board.id,
            name: "linear-state",
            path: scriptFile("#!/bin/sh\necho 'no token' >&2\nexit 3\n", "linear-state.sh"),
            trigger: { _tag: "manual" },
          },
          owner,
        );
        const card = yield* placed(board, "Blocked on ENG-1", {
          stage: "in_review",
          reviewStep: 1,
        });
        yield* kanban.waitCard(
          card.id,
          {
            on: "script",
            script: "linear-state",
            args: { issue: "ENG-1", everyMs: MINUTE },
            note: "ENG-1 to be Done",
          },
          owner,
        );
        for (const expected of [1, 2]) {
          yield* loop;
          const held = yield* cardOf(card.id);
          assert.strictEqual(held.wait?.failures, expected);
          assert.isFalse(kanbanWaitCheckFailing(held.wait!));
          yield* TestClock.adjust(2 * MINUTE);
        }
        assert.strictEqual(world.toldEvaluator("has failed"), 0);

        yield* loop;
        const failing = yield* cardOf(card.id);
        assert.strictEqual(failing.wait?.failures, 3);
        assert.isTrue(kanbanWaitCheckFailing(failing.wait!));
        assert.include(failing.wait?.problem ?? "", "exited with code 3");
        // Still parked: nothing can end the wait, so nobody is started on it.
        assert.strictEqual(failing.stage, "in_review");
        assert.strictEqual(world.cardThreads(), 0);
        assert.strictEqual(world.toldEvaluator("its check has failed 3 times in a row"), 1);
        const marks = (yield* eventsOf(card.id)).filter((event) =>
          event.body?.startsWith("Wait check failing: 3 failures in a row"),
        );
        assert.strictEqual(marks.length, 1);
        assert.strictEqual(marks[0]?.kind, "edited");

        // A fourth failure adds nothing new.
        yield* TestClock.adjust(2 * MINUTE);
        yield* loop;
        assert.strictEqual((yield* cardOf(card.id)).wait?.failures, 4);
        assert.strictEqual(world.toldEvaluator("has failed"), 1);
      }),
    ),
);

// The event kinds a client built before the tolerant decoder knows: a closed list.
const OldEventKind = Schema.Literals([
  "created",
  "moved",
  "edited",
  "linked",
  "flagged",
  "comment",
  "thread",
  "review",
  "subtask",
]);
const { wait: _wait, ...oldCardFields } = KanbanCard.fields;
/** A card detail as such a client decodes it: no wait field, and any other event kind fails the read. */
const OldCardDetail = Schema.Struct({
  card: Schema.Struct(oldCardFields),
  events: Schema.Array(Schema.Struct({ ...KanbanCardEvent.fields, kind: OldEventKind })),
  threads: KanbanCardDetail.fields.threads,
});
const oldClientReads = Schema.decodeUnknownResult(OldCardDetail);
const thisClientReads = Schema.decodeUnknownResult(KanbanCardDetail);
const encodeDetail = Schema.encodeUnknownSync(KanbanCardDetail);
const onTheWire = (detail: KanbanCardDetail): unknown =>
  JSON.parse(JSON.stringify(encodeDetail(detail)));

it.effect(
  "while the event-kind switch is off a wait's whole history is `edited` events an old client can read",
  () =>
    inWorld((world) =>
      Effect.gen(function* () {
        assert.isFalse(Waits.WAIT_EVENT_KINDS_LIVE);
        const { kanban, board } = yield* setup;
        const card = yield* placed(board, "Fix when CI answers", { links: [tracked(PR)] });
        // Set, replaced, cleared by hand, set again, expired, ended: every wait event there is.
        yield* kanban.waitCard(
          card.id,
          { on: "time", until: iso(T0 + HOUR), note: "first" },
          owner,
        );
        yield* kanban.waitCard(card.id, { on: "merge", pr: PR, note: "second" }, owner);
        yield* kanban.waitCard(card.id, null, owner);
        yield* kanban.waitCard(card.id, { on: "ci", pr: PR, note: "nightly CI" }, owner);
        const waiting = yield* kanban.card(card.id);
        world.host.readings = [
          { url: PR, state: "open", head: "abc1234", checks: "pending", at: iso(T0) },
        ];
        yield* kanban.tick;
        yield* TestClock.adjust(3 * HOUR + MINUTE);
        yield* kanban.tick;
        const expired = yield* kanban.card(card.id);
        world.host.readings = [
          { url: PR, state: "open", head: "abc1234", checks: "passing", at: iso(T0 + 4 * HOUR) },
        ];
        yield* kanban.tick;
        const ended = yield* kanban.card(card.id);

        const history = ended.events.filter((event) => event.body?.startsWith("Wait"));
        assert.deepStrictEqual(
          history.map((event) => [event.kind, event.body]),
          [
            ["edited", `Waiting until ${iso(T0 + HOUR)}: first`],
            ["edited", "Waiting for app#12 to merge: second"],
            ["edited", "Wait ended: cleared by hand (was waiting for app#12 to merge)"],
            ["edited", "Waiting for CI on app#12: nightly CI"],
            ["edited", 'Wait expired: waited 3h for CI on app#12 with no change ("nightly CI")'],
            ["edited", "Wait ended: CI passed on app#12 at abc1234"],
          ],
        );
        assert.isFalse(ended.events.some((event) => event.kind.startsWith("wait_")));

        // A client from before the tolerant decoder reads the card at every point.
        for (const detail of [waiting, expired, ended]) {
          const decoded = Result.getOrThrow(oldClientReads(onTheWire(detail)));
          assert.strictEqual(decoded.events.length, detail.events.length);
          assert.strictEqual(decoded.card.id, card.id);
        }
        // What the switch guards against: the same history under its own kinds fails that client's read.
        const live = {
          ...ended,
          events: ended.events.map((event) =>
            event.body?.startsWith("Waiting") ? { ...event, kind: "wait_set" as const } : event,
          ),
        };
        assert.isTrue(Result.isFailure(oldClientReads(onTheWire(live))));
        // The current client reads both.
        assert.strictEqual(
          Result.getOrThrow(thisClientReads(onTheWire(live))).events.length,
          live.events.length,
        );
      }),
    ),
);
