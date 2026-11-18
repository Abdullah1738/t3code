import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  AnalyticsError,
  CommandId,
  LONG_TASK_HISTOGRAM_RATIO,
  AnalyticsEvent,
  AnalyticsReadResult,
  type AnalyticsReadInput,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as BoardsDatabase from "../persistence/BoardsDatabase.ts";

import * as ServerConfig from "../../config.ts";
import * as Analytics from "./Analytics.ts";
import type { AnalyticsRollup } from "./rollup.ts";

const decodeReadResult = Schema.decodeUnknownSync(AnalyticsReadResult);
const day = "2026-11-13";
const ts = `${day}T12:00:00.000Z`;
const event = (input: Partial<AnalyticsEvent> = {}): AnalyticsEvent => ({
  ts,
  kind: "client.click",
  surface: "web",
  route: "board",
  ...input,
});

const readSamples = Effect.fn("test.readAnalyticsSamples")(function* (
  analytics: Analytics.Analytics["Service"],
  input: AnalyticsReadInput,
) {
  let page = yield* analytics.read({ ...input, section: "samples", limit: 500 });
  const rows = [...page.rows!];
  while (page.hasMore) {
    page = yield* analytics.read({
      ...input,
      section: "samples",
      cursor: page.cursor!,
      limit: 500,
    });
    rows.push(...page.rows!);
  }
  return rows.map((row) => row.value as AnalyticsEvent);
});

const fixture = Effect.gen(function* () {
  yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe(ts)));
  const context = yield* Layer.build(
    ServerConfig.layerTest(".", { prefix: "t3-owner-analytics-" }),
  );
  const config = Context.get(context, ServerConfig.ServerConfig);
  const fs = yield* FileSystem.FileSystem;
  const directory = `${config.logsDir}/analytics`;
  yield* fs.makeDirectory(directory, { recursive: true });
  return { config, fs, directory };
});

function open(
  setup: Effect.Success<typeof fixture>,
  options: Partial<Analytics.AnalyticsOptions> = {},
  fs = setup.fs,
  boards?: BoardsDatabase.BoardsDatabase["Service"],
) {
  return Layer.build(
    Analytics.layerWith(options).pipe(
      Layer.provide(
        boards === undefined ? Layer.empty : Layer.succeed(BoardsDatabase.BoardsDatabase, boards),
      ),
      Layer.provide(Layer.succeed(ServerConfig.ServerConfig, setup.config)),
      Layer.provide(Layer.succeed(FileSystem.FileSystem, fs)),
    ),
  ).pipe(Effect.map((context) => Context.get(context, Analytics.Analytics)));
}

describe("Analytics", () => {
  it.effect(
    "reads Claude API failures by status, requested model and host without counting give-ups as attempts",
    () =>
      Effect.gen(function* () {
        const setup = yield* fixture;
        const analytics = yield* open(setup);
        const detail = {
          model: "claude-opus-5-5[1m]",
          host: "router.test",
          path: "/v1",
          status: 404,
          errorCode: "model_not_found",
          errorType: "not_found_error",
          errorText: "model unavailable",
          attempt: 1,
          resume: true,
        };
        for (const row of [
          event({
            kind: "provider.claude_api_error",
            surface: "server",
            route: "provider",
            phase: "attempt",
            claudeApiError: detail,
          }),
          event({
            kind: "provider.claude_api_error",
            surface: "server",
            route: "provider",
            phase: "give_up",
            claudeApiError: detail,
          }),
          event({
            kind: "provider.claude_api_error",
            surface: "server",
            route: "provider",
            phase: "attempt",
            claudeApiError: {
              ...detail,
              status: 503,
              model: "claude-sonnet-5-5",
              host: "api.anthropic.com",
            },
          }),
        ])
          yield* analytics.record(row);
        yield* analytics.flush;
        const result = yield* analytics.read({ day, kind: "provider.claude_api_error" });
        assert.deepEqual(result.rollup.claudeApiErrors, [
          {
            status: 404,
            model: "claude-opus-5-5[1m]",
            host: "router.test",
            attempts: 1,
            giveUps: 1,
          },
          {
            status: 503,
            model: "claude-sonnet-5-5",
            host: "api.anthropic.com",
            attempts: 1,
            giveUps: 0,
          },
        ]);
        assert.equal(
          (yield* readSamples(analytics, { day, kind: "provider.claude_api_error" })).length,
          3,
        );
        const section = yield* analytics.read({ day, section: "claudeApiErrors" });
        assert.equal(section.rows?.length, 2);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reads slot and claim decisions in defaults and by kind", () =>
    Effect.gen(function* () {
      const setup = yield* fixture;
      const analytics = yield* open(setup);
      const decisions = [
        event({
          kind: "kanban.slot",
          surface: "server",
          boardId: "a",
          cardId: "c",
          threadId: "t",
          props: { poolKey: "sol", slot: "take", why: "start", held: false },
        }),
        event({
          kind: "kanban.slot",
          surface: "server",
          boardId: "a",
          threadId: "t",
          props: { poolKey: "sol", slot: "release", why: "hold_end", held: false },
        }),
        event({
          kind: "kanban.claim_denied",
          surface: "server",
          boardId: "a",
          cardId: "c",
          threadId: "t",
          props: {
            poolKey: "sol",
            reason: "pool_full",
            holdsSlot: false,
            carried: 0,
            used: 1,
            slots: 1,
          },
        }),
        event({
          kind: "kanban.claim",
          surface: "server",
          boardId: "a",
          cardId: "c",
          threadId: "t",
          props: {
            poolKey: "sol",
            reason: "taken",
            holdsSlot: true,
            carried: 0,
            used: 1,
            slots: 1,
          },
        }),
        event({
          kind: "kanban.next",
          surface: "server",
          boardId: "a",
          threadId: "t",
          props: { holdsSlot: true, candidateCount: 1 },
        }),
      ];
      for (const row of decisions) yield* analytics.record(row);
      yield* analytics.flush;
      const cold = yield* open(setup);
      for (const reader of [analytics, cold]) {
        assert.sameDeepMembers([...(yield* reader.read({ day, boardId: "a" })).samples], decisions);
        for (const kind of new Set(decisions.map((row) => row.kind))) {
          assert.sameDeepMembers(
            [...(yield* reader.read({ day, kind })).samples],
            decisions.filter((row) => row.kind === kind),
          );
        }
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reads silent child stall decisions with their phase and recovery action", () =>
    Effect.gen(function* () {
      const setup = yield* fixture;
      const analytics = yield* open(setup);
      for (const [phase, action] of [
        ["post_tool", "resumed"],
        ["first_event", "restarted"],
        ["mid_turn", "failed"],
      ] as const) {
        yield* analytics.record(
          event({
            kind: "delegated_task.stall",
            surface: "server",
            route: "provider",
            threadId: "thread:delegated:child",
            taskId: "task:child",
            props: {
              runId: "run:child",
              provider: "codex",
              model: "gpt-6.1-sol",
              effort: "max",
              phase,
              action,
              lastProgressKind: "run_started",
              silentSeconds: 900,
            },
          }),
        );
      }
      const result = yield* analytics.read({ day, kind: "delegated_task.stall", limit: 10 });
      assert.lengthOf(result.samples, 3);
      assert.sameMembers(
        result.samples.map((row) => row.props?.action),
        ["resumed", "restarted", "failed"],
      );
      assert.sameMembers(
        result.samples.map((row) => row.props?.phase),
        ["post_tool", "first_event", "mid_turn"],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reads delegated notice delays and terminal status corrections by kind", () =>
    Effect.gen(function* () {
      const setup = yield* fixture;
      const analytics = yield* open(setup);
      const notice = event({
        ts,
        surface: "server",
        route: "delegated-tasks",
        kind: "delegated.notice",
        parentThreadId: "thread:parent",
        parentRunId: "run:parent",
        noticeMessageId: "message:notice",
        noticeKind: "mixed",
        children: [
          {
            childTaskId: "node:baseline",
            status: "completed",
            terminalAt: `${day}T11:59:48.000Z`,
            delayMs: 12000,
          },
          {
            childTaskId: "node:review",
            status: "failed",
            terminalAt: `${day}T11:59:50.000Z`,
            delayMs: 10000,
          },
        ],
      });
      const correction = event({
        ts,
        surface: "server",
        route: "delegated-tasks",
        kind: "delegated.terminal-status-changed",
        parentThreadId: "thread:parent",
        parentRunId: "run:parent",
        taskId: "node:review",
        oldStatus: "completed",
        newStatus: "failed",
        reason: "child_terminal_reconciled",
      });
      yield* analytics.record(notice);
      yield* analytics.record(correction);
      yield* analytics.flush;
      assert.deepEqual(yield* readSamples(analytics, { day, kind: "delegated.notice" }), [notice]);
      assert.deepEqual(
        yield* readSamples(analytics, { day, kind: "delegated.terminal-status-changed" }),
        [correction],
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it.effect("prioritises board kinds and ignores board long tasks in samples and rollup", () =>
    Effect.gen(function* () {
      const setup = yield* fixture;
      const analytics = yield* open(setup);
      const boardId = "board-crpko";
      for (const row of [
        event({
          boardId,
          kind: "kanban.card_move",
          props: { from: "todo", to: "working", msInPrevStage: 10 },
        }),
        ...Array.from({ length: 150 }, () => event({ boardId, kind: "performance.long-task" })),
        event({ boardId, kind: "toast.show" }),
        event({ boardId: "other", kind: "kanban.dispatch" }),
      ])
        yield* analytics.record(row);
      const result = yield* analytics.read({ day, boardId, limit: 2 });
      assert.deepEqual(
        result.samples.map((row) => row.kind),
        ["kanban.card_move", "toast.show"],
      );
      assert.equal(result.rollup.total, 2);
      assert.isUndefined(result.rollup.kindCounts["performance.long-task"]);
      assert.equal(result.rollup.boards[0]?.moves[0]?.count, 1);
      for (let index = 0; index < 150; index++) {
        yield* analytics.record(event({ boardId, kind: "kanban.queue_depth" }));
        yield* analytics.record(event({ boardId, kind: "performance.long-task" }));
      }
      yield* analytics.record(event({ boardId, kind: "kanban.review_verdict" }));
      const cached = yield* analytics.read({ day, boardId, limit: 100 });
      assert.sameMembers(
        cached.samples.slice(0, 3).map((row) => row.kind),
        ["kanban.card_move", "kanban.queue_depth", "kanban.review_verdict"],
      );
      assert.equal(cached.samples.filter((row) => row.kind === "kanban.queue_depth").length, 50);
      assert.isUndefined(cached.rollup.kindCounts["performance.long-task"]);
      assert.equal(cached.rollup.total, 153);
      const exact = yield* analytics.read({ day, boardId, kind: "kanban.queue_depth", limit: 75 });
      assert.lengthOf(exact.samples, 75);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
  it.effect.each([117, 118, 119])(
    "preserves cached kind admission with 10 board kinds and %s other kinds",
    (otherKinds) =>
      Effect.gen(function* () {
        const setup = yield* fixture;
        const analytics = yield* open(setup);
        const boardId = "board-a";
        for (let kind = 0; kind < 10; kind++)
          for (let row = 0; row < 50; row++)
            yield* analytics.record(event({ boardId, kind: `kanban.k${kind}` }));
        for (let kind = 0; kind < otherKinds; kind++)
          yield* analytics.record(event({ boardId, kind: `ui.k${kind}` }));
        yield* analytics.read({ day, boardId, limit: 500 });
        yield* analytics.record(event({ boardId, kind: "kanban.appended" }));
        const warm = yield* analytics.read({ day, boardId, limit: 500 });
        const warmSamples = yield* readSamples(analytics, { day, boardId });
        const coldAnalytics = yield* open(setup);
        const cold = yield* coldAnalytics.read({ day, boardId, limit: 500 });
        const coldSamples = yield* readSamples(coldAnalytics, { day, boardId });
        assert.deepEqual(warmSamples, coldSamples);
        assert.equal(
          warmSamples.some((row) => row.kind === "kanban.appended"),
          otherKinds === 117,
        );
        assert.equal(warm.rollup.total, 501 + otherKinds);
        assert.deepEqual(warm.rollup.kindCounts, cold.rollup.kindCounts);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "keeps equal-timestamp mixed samples ordered across cached appends and cold reads",
    () =>
      Effect.gen(function* () {
        const setup = yield* fixture;
        const analytics = yield* open(setup);
        const boardId = "board-a";
        for (const [kind, cardId] of [
          ["kanban.card_move", "a1"],
          ["kanban.queue_depth", "b1"],
          ["kanban.queue_depth", "b2"],
        ] as const)
          yield* analytics.record(event({ boardId, kind, cardId }));
        yield* analytics.read({ day, boardId });
        yield* analytics.record(event({ boardId, kind: "kanban.card_move", cardId: "a2" }));
        const warm = yield* analytics.read({ day, boardId });
        const cold = yield* (yield* open(setup)).read({ day, boardId });
        assert.deepEqual(
          warm.samples.map((row) => row.cardId),
          ["a2", "b2", "b1", "a1"],
        );
        assert.deepEqual(warm.samples, cold.samples);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "keeps repeatedly drained mixes equivalent to disk rebuilds for every cached filter",
    () =>
      Effect.gen(function* () {
        const setup = yield* fixture;
        let scans = 0;
        const tracked = FileSystem.FileSystem.of({
          ...setup.fs,
          stream: (file, options) => {
            if (file.endsWith(".ndjson")) scans++;
            return setup.fs.stream(file, options);
          },
        });
        const analytics = yield* open(setup, {}, tracked);
        const filters: AnalyticsReadInput[] = [
          { day },
          { day, boardId: "board-a" },
          { day, kind: "kanban.hot" },
          { day, boardId: "board-a", kind: "kanban.hot" },
          { day, cardId: "card-a" },
          { day, tool: "card_get" },
          { day, outcome: "error" },
          { day, responseDelivery: "finished" },
        ];
        for (const filter of filters) yield* readSamples(analytics, filter);
        const before = scans;
        for (let batch = 0; batch < 6; batch++) {
          const events = Array.from({ length: 320 }, (_, index) =>
            event({
              kind:
                index < 150
                  ? ["kanban.hot", "ask.created", "performance.long-task", `client.k${index}`][
                      index % 4
                    ]!
                  : "kanban.hot",
              // Equal and out-of-order timestamps exercise ties and eviction in full groups.
              ts: DateTime.formatIso(
                DateTime.subtract(DateTime.makeUnsafe(ts), {
                  milliseconds: (index * 17 + batch) % 7,
                }),
              ),
              boardId: index % 2 ? "board-a" : "board-b",
              cardId: index % 3 ? "card-a" : `batch-${batch}-${index}`,
              tool: index % 3 ? "card_get" : "card_move",
              outcome: index % 2 ? "error" : "ok",
              responseDelivery: "finished",
            }),
          );
          for (let start = 0; start < events.length; start += 100)
            yield* analytics.ingest({ events: events.slice(start, start + 100) });
          yield* analytics.flush;
          for (const filter of filters) yield* readSamples(analytics, filter);
        }
        assert.equal(scans, before);
        const rebuilt = yield* open(setup);
        for (const filter of filters) {
          const warm = yield* analytics.read({ ...filter, limit: 500 });
          const cold = yield* rebuilt.read({ ...filter, limit: 500 });
          assert.deepEqual(
            yield* readSamples(analytics, filter),
            yield* readSamples(rebuilt, filter),
          );
          assert.deepEqual(warm.rollup, cold.rollup);
        }
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reads tick phases and lifecycle rollups together and persists the complete day", () =>
    Effect.gen(function* () {
      const setup = yield* fixture;
      const analytics = yield* open(setup);
      for (const [boardId, durationMs] of [
        ["a", 10],
        ["a", 20],
        ["a", 90],
        ["b", 1_000],
      ] as const)
        yield* analytics.record(
          event({
            kind: "kanban.tick_phase",
            surface: "server",
            route: "kanban",
            boardId,
            durationMs,
            props: { tickId: "tick-1", phase: "thread_status", count: 1 },
          }),
        );
      yield* analytics.record(
        event({
          kind: "kanban.tick_overlap",
          surface: "server",
          route: "kanban",
          boardId: "a",
          props: { tickId: "tick-2", activeTickId: "tick-1", reason: "local_waits_only" },
        }),
      );
      yield* analytics.record(
        event({
          kind: "kanban.card_move",
          surface: "server",
          boardId: "a",
          cardId: "card-a",
          props: { from: "todo", to: "working", msInPrevStage: 60_000 },
        }),
      );
      const board = yield* analytics.read({ day, boardId: "a" });
      assert.deepEqual(board.rollup.boards[0]?.moves, [{ from: "todo", to: "working", count: 1 }]);
      assert.equal(board.rollup.tickPhases?.[0]?.p95Ms, 90);
      assert.equal(board.rollup.boards[0]?.timeInStage[0]?.p95Ms, 60_000);
      const result = yield* analytics.read({
        day,
        kind: "kanban.tick_phase",
        boardId: "a",
        limit: 1,
      });
      assert.equal(result.rollup.total, 3);
      assert.lengthOf(result.samples, 1);
      assert.deepEqual(result.rollup.tickPhases, [
        {
          boardId: "a",
          phase: "thread_status",
          count: 3,
          p50Ms: 20,
          p95Ms: 90,
          maxMs: 90,
          approximate: false,
        },
      ]);
      const full = JSON.parse(
        yield* setup.fs.readFileString(`${setup.directory}/rollup-${day}.json`),
      ) as AnalyticsRollup;
      assert.equal(full.total, 6);
      assert.equal(full.boards[0]?.moves[0]?.count, 1);
      assert.equal(full.tickPhases?.length, 2);
      assert.equal(full.kindCounts["kanban.tick_overlap"], 1);
      assert.isFalse(yield* setup.fs.exists(`${setup.directory}/rollup-${day}.json.tmp`));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("incremental summaries match cold rebuilds for main and error rollups", () =>
    Effect.gen(function* () {
      const setup = yield* fixture;
      let scans = 0;
      const tracked = FileSystem.FileSystem.of({
        ...setup.fs,
        stream: (file, options) => {
          if (file.endsWith(".ndjson")) scans++;
          return setup.fs.stream(file, options);
        },
      });
      const batch = (durationMs: number): AnalyticsEvent[] => [
        event({
          kind: "performance.long-task-summary",
          surface: "desktop",
          props: {
            count: 2,
            totalMs: durationMs * 2,
            maxMs: durationMs,
            wallTimeMs: 60_000,
            histogram: [[Math.ceil(Math.log(durationMs) / Math.log(LONG_TASK_HISTOGRAM_RATIO)), 2]],
          },
        }),
        event({
          kind: "kanban.tick_phase",
          surface: "server",
          boardId: "board-a",
          durationMs,
          props: { phase: "thread_status" },
        }),
        event({ kind: "ask.answered", surface: "server", durationMs }),
        event({ kind: "ask.answer_sent", durationMs: 999_999 }),
        event({
          kind: "mcp.call",
          surface: "server",
          route: "mcp",
          tool: "delegate_task",
          outcome: "interrupted_by_shutdown",
          committed: true,
          taskId: "task-committed",
          durationMs,
          props: { code: "unknown", cause: "shutdown" },
        }),
        event({
          kind: "server.http",
          surface: "server",
          route: "api.cards",
          durationMs,
          props: { method: "POST", status: 503, errorTag: "Http5xx" },
        }),
        event({
          kind: "db.slow",
          surface: "server",
          durationMs,
          props: { span: "Kanban.get", key: "reader", phase: "execute", waitMs: durationMs / 2 },
        }),
      ];
      const warm = yield* Effect.scoped(
        Effect.gen(function* () {
          const analytics = yield* open(setup, {}, tracked);
          for (const row of batch(100)) yield* analytics.record(row);
          yield* analytics.read({ day });
          yield* analytics.read({ day, boardId: "board-a" });
          const before = scans;
          for (const row of batch(500)) yield* analytics.record(row);
          const full = yield* analytics.read({ day });
          const filtered = yield* analytics.read({ day, boardId: "board-a" });
          assert.equal(scans, before);
          assert.deepInclude(full.rollup.longTasksByRoute[0], {
            count: 4,
            totalMs: 1200,
            maxMs: 500,
            p95Ms: 500,
            wallTimeMs: 120_000,
            wallTimeShare: 0.01,
          });
          assert.deepInclude(full.rollup.tickPhases?.[0], { count: 2, p95Ms: 500 });
          assert.deepInclude(full.rollup.askAnswerLatency, { count: 2, p95Ms: 500 });
          assert.deepInclude(full.rollup.mcpCalls[0], {
            count: 2,
            outcomes: { interrupted_by_shutdown: 2 },
          });
          assert.deepInclude(full.rollup.errorsByRoute[0], { count: 2, status: 503 });
          assert.deepInclude(full.rollup.mcpErrorsByCode[0], { count: 2, code: "unknown" });
          assert.deepInclude(full.rollup.dbSlowBySpan[0], { count: 2, totalWaitMs: 300 });
          assert.lengthOf(filtered.rollup.longTasksByRoute, 0);
          assert.equal(filtered.rollup.tickPhases?.[0]?.count, 2);
          const persisted = JSON.parse(
            yield* setup.fs.readFileString(`${setup.directory}/rollup-${day}.json`),
          ) as AnalyticsRollup;
          assert.deepEqual(persisted, full.rollup);
          return { full, filtered };
        }),
      );
      const cold = yield* open(setup);
      assert.deepEqual((yield* cold.read({ day })).rollup, warm.full.rollup);
      assert.deepEqual(
        (yield* cold.read({ day, boardId: "board-a" })).rollup,
        warm.filtered.rollup,
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps a minute summary delivered after midnight in the task's UTC day", () =>
    Effect.gen(function* () {
      const setup = yield* fixture;
      const analytics = yield* open(setup);
      yield* TestClock.setTime(
        DateTime.toEpochMillis(DateTime.makeUnsafe("2026-11-14T00:00:01.000Z")),
      );
      yield* analytics.ingest({
        events: [
          event({
            ts: "2026-11-13T23:59:00.000Z",
            kind: "performance.long-task-summary",
            surface: "desktop",
            route: "board",
            props: {
              count: 1,
              totalMs: 500,
              maxMs: 500,
              wallTimeMs: 60_000,
              histogram: [[Math.ceil(Math.log(500) / Math.log(LONG_TASK_HISTOGRAM_RATIO)), 1]],
            },
          }),
        ],
      });
      const previous = yield* analytics.read({ day });
      assert.deepInclude(previous.rollup.longTasksByRoute[0], {
        route: "board",
        count: 1,
        totalMs: 500,
        maxMs: 500,
        p95Ms: 500,
        wallTimeShare: 500 / 60_000,
      });
      assert.lengthOf((yield* analytics.read({ day: "2026-11-14" })).rollup.longTasksByRoute, 0);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
  it.effect("groups legacy stored asks by the same response kind as answer events", () =>
    Effect.gen(function* () {
      const setup = yield* fixture;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE ardud_kanban_cards (id TEXT, board_id TEXT, number INTEGER, json TEXT)`;
      const variants = [
        { kind: "draft", draft: { target: "private", format: "text", text: "private draft" } },
        { kind: "approve", respond: { verdict: {} } },
        { kind: "pick", options: [{ id: "o1", label: "private option" }] },
        { kind: "action", respond: { task: { steps: [] } } },
        { kind: "input" },
        { kind: "notice", respond: { ack: true } },
        { kind: "private label", options: [{ id: "o1", label: "private option" }] },
        { timing: { kind: "approve" } },
        {
          timing: { firstSeen: { web: `${day}T02:00:00.000Z` } },
          options: [{ id: "o1", label: "private option" }],
        },
        { kind: "private label", respond: { fields: [] } },
        { options: "unreadable private options" },
      ];
      const asks = variants.map((fields, index) => ({
        id: `q${index}`,
        text: "private question",
        at: `${day}T01:00:00.000Z`,
        blocking: false,
        closedAt: `${day}T03:00:00.000Z`,
        answer: {
          at: `${day}T03:00:00.000Z`,
          by: { _tag: "owner" },
          verdict: "approved",
          text: "private answer",
        },
        ...fields,
      }));
      yield* sql`INSERT INTO ardud_kanban_cards VALUES ('card', 'board', 4336, ${JSON.stringify({ asks })})`;
      const analytics = yield* open(setup, {}, setup.fs, {
        sql,
        ready: Effect.void,
        path: ":memory:",
      });
      const result = yield* analytics.read({ day });
      const split = result.rollup.askLatency;
      assert.equal(split.createdToAnswered.count, 11);
      assert.deepStrictEqual(
        Object.fromEntries(
          Object.entries(split.byKind).map(([kind, group]) => [
            kind,
            group.createdToAnswered.count,
          ]),
        ),
        { draft: 1, approve: 2, pick: 3, action: 1, input: 2, notice: 1, unknown: 1 },
      );
      assert.isFalse(JSON.stringify(result).includes("private"));
    }).pipe(Effect.provide(Layer.merge(NodeServices.layer, Sqlite.layerMemory))),
  );
  it.effect("reads the ask split by board/card while persisting the full day without text", () =>
    Effect.gen(function* () {
      const setup = yield* fixture;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE ardud_kanban_cards (id TEXT, board_id TEXT, number INTEGER, json TEXT)`;
      const ask = {
        id: "q1",
        text: "private question",
        at: `${day}T01:00:00.000Z`,
        blocking: true,
        closedAt: `${day}T03:00:00.000Z`,
        answer: {
          at: `${day}T03:00:00.000Z`,
          by: { _tag: "owner" },
          verdict: "approved",
          text: "private answer",
        },
        timing: {
          kind: "approve",
          notified: { telegram: `${day}T01:10:00.000Z` },
          firstSeen: { web: `${day}T02:00:00.000Z`, mobile: `${day}T02:30:00.000Z` },
        },
      };
      for (const [cardId, boardId, number] of [
        ["card-a", "board-a", 4336],
        ["card-b", "board-a", 4339],
        ["card-c", "board-b", 4336],
      ])
        yield* sql`INSERT INTO ardud_kanban_cards VALUES (${cardId}, ${boardId}, ${number}, ${JSON.stringify({ asks: [ask] })})`;
      const boards = { sql, ready: Effect.void, path: ":memory:" };
      let scans = 0;
      const tracked = FileSystem.FileSystem.of({
        ...setup.fs,
        stream: (file, options) => {
          if (file.endsWith(".ndjson")) scans++;
          return setup.fs.stream(file, options);
        },
      });
      const analytics = yield* open(setup, {}, tracked, boards);
      yield* analytics.record(event());
      yield* analytics.ingest({
        events: [event({ kind: "ask.answered" }), event({ kind: "ask.seen" })],
      });
      yield* analytics.record(event({ kind: "server.rpc", surface: "server", route: "rpc" }));
      const result = yield* analytics.read({ day, boardId: "board-a" });
      assert.equal(result.rollup.askLatency.createdToAnswered.count, 2);
      assert.equal(result.rollup.askLatency.sentToSeen.p50Ms, 50 * 60_000);
      assert.equal(result.rollup.askLatency.seenToAnswered.p50Ms, 60 * 60_000);
      assert.equal(result.rollup.askLatency.source, "stored-asks");
      assert.equal((yield* analytics.read({ day })).rollup.askLatency.createdToAnswered.count, 3);
      for (const [filter, count] of [
        [{ cardId: "card-a" }, 1],
        [{ boardId: "board-a", cardId: "card-a" }, 1],
        [{ boardId: "board-b", cardId: "card-a" }, 0],
        [{ cardId: "missing" }, 0],
        [{ cardNumber: 4336 }, 2],
        [{ cardNumber: 4339 }, 1],
        [{ cardNumber: 9999 }, 0],
        [{ boardId: "board-a", cardNumber: 4336 }, 1],
        [{ boardId: "board-b", cardNumber: 4339 }, 0],
        [{ cardId: "card-b", cardNumber: 4336 }, 0],
      ] as const) {
        const filtered = yield* analytics.read({ day, ...filter });
        assert.equal(filtered.rollup.askLatency.createdToAnswered.count, count);
        const section = yield* analytics.read({ day, ...filter, section: "askLatency" });
        assert.deepEqual(section.rows, [{ path: [], value: filtered.rollup.askLatency }]);
        const persisted = JSON.parse(
          yield* setup.fs.readFileString(`${setup.directory}/rollup-${day}.json`),
        ) as AnalyticsRollup;
        assert.equal(persisted.askLatency.createdToAnswered.count, 3);
      }
      assert.lengthOf(result.samples, 0);
      assert.isFalse(JSON.stringify(result).includes("private"));
      const before = scans;
      const updated = {
        ...ask,
        timing: {
          ...ask.timing,
          firstSeen: { web: `${day}T01:30:00.000Z` },
        },
      };
      yield* sql`UPDATE ardud_kanban_cards SET json = ${JSON.stringify({ asks: [updated] })} WHERE board_id = 'board-a'`;
      const warm = yield* analytics.read({ day, boardId: "board-a" });
      assert.equal(scans, before);
      assert.equal(warm.rollup.askLatency.sentToSeen.p50Ms, 20 * 60_000);
      assert.equal(warm.rollup.askLatency.seenToAnswered.p50Ms, 90 * 60_000);
      const cold = yield* open(setup, {}, setup.fs, boards);
      assert.deepEqual((yield* cold.read({ day, boardId: "board-a" })).rollup, warm.rollup);
      const persisted = JSON.parse(
        yield* setup.fs.readFileString(`${setup.directory}/rollup-${day}.json`),
      ) as AnalyticsRollup;
      assert.equal(persisted.askLatency.createdToAnswered.count, 3);
      assert.equal(persisted.askLatency.sentToSeen.p50Ms, 20 * 60_000);
      assert.isFalse(JSON.stringify(persisted).includes("private"));
    }).pipe(Effect.provide(Sqlite.layerMemory.pipe(Layer.provideMerge(NodeServices.layer)))),
  );
  it.effect("reads persisted deadline phases in MCP samples and rollup groups", () =>
    Effect.gen(function* () {
      const setup = yield* fixture;
      const analytics = yield* open(setup);
      const phases = ["parent_records", "receipt", "dispatch", "handler"] as const;
      for (const errorPhase of phases)
        yield* analytics.record(
          event({
            kind: "mcp.call",
            surface: "server",
            tool: "delegate_task",
            outcome: "timeout",
            errorTag: "delegation_timeout",
            errorPhase,
          }),
        );
      yield* analytics.flush;
      const cold = yield* open(setup);
      const result = yield* cold.read({ day, kind: "mcp.call", tool: "delegate_task" });
      assert.deepEqual(decodeReadResult(result), result);
      assert.sameMembers(
        result.samples.map((row) => row.errorPhase),
        [...phases],
      );
      assert.sameDeepMembers(
        [...result.rollup.mcpCalls[0]!.errors],
        phases.map((errorPhase) => ({ errorTag: "delegation_timeout", errorPhase, count: 1 })),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
  it.effect(
    "filters MCP samples and rollups by tool and outcome while persisting the full day",
    () =>
      Effect.gen(function* () {
        const setup = yield* fixture;
        const analytics = yield* open(setup);
        yield* analytics.record(
          event({
            kind: "mcp.call",
            surface: "server",
            tool: "card_update",
            outcome: "timeout",
            errorPhase: "caller",
            durationMs: 10,
          }),
        );
        yield* analytics.record(
          event({
            kind: "mcp.call",
            surface: "server",
            tool: "card_update",
            outcome: "ok",
            durationMs: 1,
            saved: true,
            responseDelivery: "closed",
            responseElapsedMs: 25,
            responseCloseReason: "peer_end",
          }),
        );
        yield* analytics.record(
          event({
            kind: "mcp.call",
            surface: "server",
            tool: "card_get",
            outcome: "timeout",
            durationMs: 20,
          }),
        );
        const result = yield* analytics.read({
          day,
          kind: "mcp.call",
          tool: "card_update",
          outcome: "timeout",
        });
        assert.equal(result.rollup.total, 1);
        assert.lengthOf(result.samples, 1);
        assert.deepInclude(result.rollup.mcpCalls[0], {
          tool: "card_update",
          failures: 1,
          failureRate: 1,
        });
        const full = JSON.parse(
          yield* setup.fs.readFileString(`${setup.directory}/rollup-${day}.json`),
        );
        assert.equal(full.total, 3);
        assert.lengthOf(full.mcpCalls, 2);
        const filter = { day, kind: "mcp.call", responseDelivery: "closed" as const };
        const dropped = yield* analytics.read(filter);
        assert.equal(dropped.rollup.total, 1);
        assert.deepInclude(dropped.samples[0], {
          saved: true,
          responseDelivery: "closed",
          responseCloseReason: "peer_end",
        });
        const cached = yield* analytics.read(filter);
        assert.deepEqual(cached.samples, dropped.samples);
        const cold = yield* open(setup);
        assert.deepEqual((yield* cold.read(filter)).samples, dropped.samples);
      }).pipe(Effect.provide(NodeServices.layer)),
  );
  it.effect("rolls up task lookup reasons and recovery paths through analytics_read", () =>
    Effect.gen(function* () {
      const setup = yield* fixture;
      const analytics = yield* open(setup);
      const lookups = [
        {
          foundBy: "none",
          notFoundReason: "non_canonical_id",
          idCanonical: false,
          saved: "unknown",
        },
        {
          foundBy: "none",
          notFoundReason: "non_canonical_id",
          idCanonical: false,
          saved: "unknown",
        },
        { foundBy: "none", notFoundReason: "never_saved", idCanonical: true, saved: false },
        { foundBy: "receipt", notFoundReason: "accepted", idCanonical: true, saved: true },
        { foundBy: "request_key_recovery", idCanonical: false, saved: true },
        { foundBy: "subagents", idCanonical: true, saved: true },
      ] as const;
      for (const { saved, ...props } of lookups)
        yield* analytics.record(
          event({
            kind: "mcp.call",
            surface: "server",
            tool: "task_status",
            saved,
            outcome: "notFoundReason" in props ? "error" : "ok",
            ...("notFoundReason" in props
              ? { errorTag: "task_not_found", reasonClass: "not_found", invalidField: "taskId" }
              : {}),
            props: { ...props, idShape: "task_id" },
          }),
        );
      // Older rows have no lookup metadata and must not acquire an invented reason.
      for (const idShape of ["thread_id", "child_thread_id", "empty", "other"] as const)
        yield* analytics.record(
          event({
            kind: "mcp.call",
            surface: "server",
            tool: "task_status",
            saved: "unknown",
            outcome: "error",
            errorTag: idShape === "empty" ? "invalid_request" : "task_not_found",
            props: {
              idShape,
              ...(idShape === "empty"
                ? {}
                : {
                    foundBy: "none",
                    notFoundReason: "not_a_delegation_id",
                    idCanonical: false,
                  }),
            },
          }),
        );
      yield* analytics.record(
        event({ kind: "mcp.call", surface: "server", tool: "task_status", outcome: "ok" }),
      );
      const input = { day, kind: "mcp.call", tool: "task_status" };
      const result = yield* analytics.read(input);
      assert.deepInclude(result.rollup.mcpCalls[0], {
        count: 11,
        savedCounts: { unknown: 6, false: 1, true: 3, "n/a": 1 },
        reasonClasses: { not_found: 4 },
        invalidFields: { taskId: 4 },
        notFoundReasons: {
          non_canonical_id: 2,
          never_saved: 1,
          accepted: 1,
          not_a_delegation_id: 3,
        },
        foundByCounts: { none: 6, receipt: 1, request_key_recovery: 1, subagents: 1 },
        idShapeCounts: { task_id: 6, thread_id: 1, child_thread_id: 1, empty: 1, other: 1 },
      });
      const filtered = yield* analytics.read({ ...input, outcome: "error" });
      assert.deepInclude(filtered.rollup.mcpCalls[0], {
        count: 8,
        notFoundReasons: {
          non_canonical_id: 2,
          never_saved: 1,
          accepted: 1,
          not_a_delegation_id: 3,
        },
        foundByCounts: { none: 6, receipt: 1 },
        idShapeCounts: { task_id: 4, thread_id: 1, child_thread_id: 1, empty: 1, other: 1 },
      });
      const section = yield* analytics.read({ ...input, section: "mcpCalls" });
      assert.include(JSON.stringify(section.rows), '"request_key_recovery":1');
      const cold = yield* open(setup);
      assert.deepEqual((yield* cold.read(input)).rollup.mcpCalls, result.rollup.mcpCalls);
      const persisted = JSON.parse(
        yield* setup.fs.readFileString(`${setup.directory}/rollup-${day}.json`),
      );
      assert.deepEqual(
        persisted.mcpCalls[0].notFoundReasons,
        result.rollup.mcpCalls[0]!.notFoundReasons,
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
  it.effect("flushes before reads, filters samples, and atomically saves the full rollup", () =>
    Effect.gen(function* () {
      const setup = yield* fixture;
      const analytics = yield* open(setup);
      yield* analytics.record(
        event({
          surface: "server",
          kind: "server.rpc",
          durationMs: 50,
          props: { method: "kanban.list" },
        }),
      );
      yield* analytics.ingest({
        events: [event({ boardId: "robob" }), event({ boardId: "orders" })],
      });
      const result = yield* analytics.read({ day, boardId: "robob", limit: 1 });
      assert.lengthOf(result.samples, 1);
      assert.equal(result.samples[0]!.boardId, "robob");
      assert.equal((result.rollup as AnalyticsRollup).total, 1);
      const persisted = JSON.parse(
        yield* setup.fs.readFileString(`${setup.directory}/rollup-${day}.json`),
      );
      assert.equal(persisted.total, 3);
      assert.equal(persisted.topSlowRpcs[0].method, "kanban.list");
      assert.isFalse(yield* setup.fs.exists(`${setup.directory}/rollup-${day}.json.tmp`));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("drains accepted events on scope closure and snapshots mutable caller objects", () =>
    Effect.gen(function* () {
      const setup = yield* fixture;
      yield* Effect.gen(function* () {
        const analytics = yield* open(setup);
        const mutable = { ...event(), props: { method: "before" } };
        yield* analytics.ingest({ events: [mutable] });
        mutable.props.method = "after";
        yield* analytics.record(
          event({ kind: "server.error", surface: "server", props: { errorTag: "StorageError" } }),
        );
      }).pipe(Effect.scoped);
      const rows = (yield* setup.fs.readFileString(`${setup.directory}/${day}.ndjson`))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.lengthOf(rows, 2);
      assert.equal(rows[0]!.props.method, "before");
      const rollup = JSON.parse(
        yield* setup.fs.readFileString(`${setup.directory}/rollup-${day}.json`),
      );
      assert.equal(rollup.total, 2);
      assert.deepStrictEqual(rollup.errorCounts, { StorageError: 1 });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rotates at the byte limit and keeps a finite number of newest segments", () =>
    Effect.gen(function* () {
      const setup = yield* fixture;
      const events = Array.from({ length: 7 }, (_, index) => event({ kind: `click.${index}` }));
      const lineBytes = new TextEncoder().encode(`${JSON.stringify(events[0])}\n`).byteLength;
      const analytics = yield* open(setup, { maxFileBytes: lineBytes * 2, maxSegmentsPerDay: 2 });
      yield* analytics.ingest({ events });
      const result = yield* analytics.read({ day });
      assert.deepStrictEqual(
        result.samples.map(({ kind }) => kind),
        ["click.6", "click.5", "click.4"],
      );
      assert.equal((result.rollup as AnalyticsRollup).total, 3);
      const logs = (yield* setup.fs.readDirectory(setup.directory)).filter((name) =>
        name.endsWith(".ndjson"),
      );
      assert.deepStrictEqual(logs.toSorted(), [`${day}.1.ndjson`, `${day}.ndjson`]);
      for (const file of logs)
        assert.isAtMost(
          Number((yield* setup.fs.stat(`${setup.directory}/${file}`)).size),
          lineBytes * 2,
        );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("retains exactly the configured UTC days and touches analytics files only", () =>
    Effect.gen(function* () {
      const setup = yield* fixture;
      for (const file of [
        "2026-11-10.ndjson",
        "2026-11-10.1.ndjson",
        "rollup-2026-11-10.json",
        "rollup-2026-11-10.json.tmp",
      ]) {
        yield* setup.fs.writeFileString(`${setup.directory}/${file}`, "{}");
      }
      yield* setup.fs.writeFileString(
        `${setup.directory}/2026-11-11.ndjson`,
        `${JSON.stringify(event({ ts: "2026-11-11T00:00:00.000Z" }))}\n`,
      );
      yield* setup.fs.writeFileString(`${setup.directory}/2026-11-10.txt`, "keep");
      yield* setup.fs.writeFileString(`${setup.config.logsDir}/2026-11-10.ndjson`, "keep");
      const analytics = yield* open(setup, { retentionDays: 3 });
      yield* analytics.read({ day });
      assert.deepStrictEqual((yield* setup.fs.readDirectory(setup.directory)).toSorted(), [
        "2026-11-10.txt",
        "2026-11-11.ndjson",
        "rollup-2026-11-11.json",
      ]);
      assert.equal(
        yield* setup.fs.readFileString(`${setup.config.logsDir}/2026-11-10.ndjson`),
        "keep",
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "rejects old, future, malformed and server-supplied client timestamps without accepting part of a batch",
    () =>
      Effect.gen(function* () {
        const setup = yield* fixture;
        const analytics = yield* open(setup);
        for (const invalid of [
          event({ ts: "2026-10-14T23:59:59.999Z" }),
          event({ ts: "2026-11-13T12:05:00.001Z" }),
          event({ ts: "2026-11-14T00:00:00.000Z" }),
          event({ ts: "yesterday" }),
          event({ surface: "server" }),
        ]) {
          const error = yield* analytics.ingest({ events: [event(), invalid] }).pipe(Effect.flip);
          assert.instanceOf(error, AnalyticsError);
          assert.equal(error.operation, "ingest");
        }
        yield* analytics.record(event({ ts: "invalid", surface: "server" }));
        assert.lengthOf((yield* analytics.read({ day })).samples, 0);
        yield* analytics.ingest({ events: [event({ ts: "2026-10-15T00:00:00.000Z" })] });
        assert.lengthOf((yield* analytics.read({ day: "2026-10-15" })).samples, 1);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("caps event bytes, total encoded batch bytes, and batch count", () =>
    Effect.gen(function* () {
      const setup = yield* fixture;
      const lineBytes = new TextEncoder().encode(`${JSON.stringify(event())}\n`).byteLength;
      const analytics = yield* open(setup, { maxEventBytes: 512, maxBatchBytes: lineBytes });
      for (const events of [
        [event(), event()],
        [event({ threadId: "x".repeat(512) })],
        Array.from({ length: 101 }, () => event()),
        [],
      ]) {
        assert.equal((yield* analytics.ingest({ events }).pipe(Effect.flip)).operation, "ingest");
      }
      assert.lengthOf((yield* analytics.read({ day })).samples, 0);
      yield* analytics.ingest({ events: [event()] });
      assert.lengthOf((yield* analytics.read({ day })).samples, 1);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects free-form payloads, query strings, and invalid measurements", () =>
    Effect.gen(function* () {
      const setup = yield* fixture;
      const analytics = yield* open(setup);
      const badInputs = [
        { ...event(), text: "private message" },
        { ...event(), props: { method: "read", payload: "private prompt" } },
        event({ route: "/board?token=private" }),
        event({ props: { reason: "free form contents" } }),
        event({ durationMs: Infinity }),
        event({ props: { bytes: -1 } }),
      ];
      for (const raw of badInputs) {
        const error = yield* analytics
          .ingest({ events: [raw as AnalyticsEvent] })
          .pipe(Effect.flip);
        assert.equal(error.operation, "ingest");
      }
      const result = yield* analytics.read({ day });
      assert.equal((result.rollup as AnalyticsRollup).total, 0);
      assert.isFalse(yield* setup.fs.exists(`${setup.directory}/${day}.ndjson`));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "records without backpressure while disk is blocked, and rejects a full ingest queue",
    () =>
      Effect.gen(function* () {
        const setup = yield* fixture;
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const blocked = FileSystem.FileSystem.of({
          ...setup.fs,
          writeFileString: (file, data, options) =>
            file.endsWith(".ndjson")
              ? Effect.gen(function* () {
                  yield* Deferred.succeed(entered, undefined);
                  yield* Deferred.await(release);
                  yield* setup.fs.writeFileString(file, data, options);
                })
              : setup.fs.writeFileString(file, data, options),
        });
        const analytics = yield* open(setup, { queueCapacity: 2 }, blocked);
        yield* Effect.gen(function* () {
          yield* analytics.record(event({ kind: "first" }));
          yield* Deferred.await(entered);
          yield* analytics.record(event({ kind: "second" }));
          yield* analytics.record(event({ kind: "dropped" }));
          assert.equal(
            (yield* analytics.ingest({ events: [event()] }).pipe(Effect.flip)).operation,
            "ingest",
          );
        }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
        assert.deepStrictEqual(
          (yield* analytics.read({ day })).samples.map(({ kind }) => kind),
          ["second", "first"],
        );
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "streams damaged logs in bounded chunks and continues after invalid or oversized lines",
    () =>
      Effect.gen(function* () {
        const setup = yield* fixture;
        yield* setup.fs.writeFileString(
          `${setup.directory}/${day}.ndjson`,
          [
            "not-json",
            "x".repeat(100_000),
            JSON.stringify(event({ kind: "one" })),
            JSON.stringify(event({ kind: "two" })),
            '{"truncated":',
          ].join("\n"),
        );
        let chunks = 0;
        const streaming = FileSystem.FileSystem.of({
          ...setup.fs,
          readFileString: (file, encoding) => {
            assert.isFalse(file.endsWith(".ndjson"));
            return setup.fs.readFileString(file, encoding);
          },
          stream: (file, options) =>
            setup.fs.stream(file, options).pipe(
              Stream.tap(() =>
                Effect.sync(() => {
                  chunks++;
                }),
              ),
            ),
        });
        const analytics = yield* open(setup, {}, streaming);
        const result = yield* analytics.read({ day, limit: 1 });
        assert.isAbove(chunks, 1);
        assert.equal((result.rollup as AnalyticsRollup).total, 2);
        assert.equal((result.rollup as AnalyticsRollup).invalidLines, 3);
        assert.deepStrictEqual(
          result.samples.map(({ kind }) => kind),
          ["two"],
        );
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("preserves the last rollup if replacement fails and reports typed read errors", () =>
    Effect.gen(function* () {
      const setup = yield* fixture;
      let failRename = false;
      const fs = FileSystem.FileSystem.of({
        ...setup.fs,
        rename: (source, target) =>
          failRename && target.endsWith(".json")
            ? Effect.fail(
                PlatformError.systemError({
                  _tag: "PermissionDenied",
                  module: "FileSystem",
                  method: "rename",
                  pathOrDescriptor: target,
                }),
              )
            : setup.fs.rename(source, target),
      });
      const analytics = yield* open(setup, {}, fs);
      yield* analytics.ingest({ events: [event()] });
      yield* analytics.read({ day });
      const original = yield* setup.fs.readFileString(`${setup.directory}/rollup-${day}.json`);
      yield* analytics.ingest({ events: [event()] });
      failRename = true;
      assert.equal((yield* analytics.read({ day }).pipe(Effect.flip)).operation, "read");
      assert.equal(
        yield* setup.fs.readFileString(`${setup.directory}/rollup-${day}.json`),
        original,
      );
      assert.equal(
        (yield* analytics.read({ day: "../../outside" }).pipe(Effect.flip)).operation,
        "read",
      );
      assert.equal(
        (yield* analytics.read({ day: "2026-02-30" }).pipe(Effect.flip)).operation,
        "read",
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("builds the previous day's rollup on the daily maintenance tick", () =>
    Effect.gen(function* () {
      const setup = yield* fixture;
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe(`${day}T23:30:00.000Z`)));
      const written = yield* Deferred.make<void>();
      const rolled = yield* Deferred.make<void>();
      const fs = FileSystem.FileSystem.of({
        ...setup.fs,
        writeFileString: (file, data, options) =>
          setup.fs
            .writeFileString(file, data, options)
            .pipe(
              Effect.tap(() =>
                file.endsWith(".ndjson") ? Deferred.succeed(written, undefined) : Effect.void,
              ),
            ),
        rename: (source, target) =>
          setup.fs
            .rename(source, target)
            .pipe(
              Effect.tap(() =>
                target.endsWith(`rollup-${day}.json`)
                  ? Deferred.succeed(rolled, undefined)
                  : Effect.void,
              ),
            ),
      });
      const analytics = yield* open(setup, {}, fs);
      yield* analytics.record(event());
      yield* Deferred.await(written);
      yield* TestClock.adjust("1 hour");
      yield* Deferred.await(rolled);
      assert.equal(
        JSON.parse(yield* setup.fs.readFileString(`${setup.directory}/rollup-${day}.json`)).total,
        1,
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

it.effect("reads run usage by card and kind with capped samples and persists the full rollup", () =>
  Effect.gen(function* () {
    const setup = yield* fixture;
    const analytics = yield* open(setup);
    for (let i = 0; i < 4; i++)
      yield* analytics.record({
        ts,
        kind: "run.usage",
        surface: "server",
        route: "provider",
        runId: `run:${i}`,
        threadId: "thread:one",
        boardId: "robob",
        cardId: i < 3 ? "card:one" : "card:two",
        role: "work",
        providerInstance: "codex",
        model: "Claude Opus 5[1m]",
        effort: null,
        inputTokens: null,
        outputTokens: null,
        cachedInputTokens: null,
        reasoningTokens: null,
        wallMs: 50,
        turnCount: 1,
        endReason: "interrupted",
        usageStatus: "unavailable",
        reviewRound: null,
      });
    yield* analytics.record(event({ cardId: "card:one" }));
    const result = yield* analytics.read({ day, kind: "run.usage", cardId: "card:one", limit: 2 });
    assert.lengthOf(result.samples, 2);
    assert.equal(result.rollup.usage.totals.runs, 3);
    assert.equal(result.rollup.usage.totals.inputTokens, null);
    assert.isTrue(
      result.samples.every((row) => row.kind === "run.usage" && row.cardId === "card:one"),
    );
    const persisted = JSON.parse(
      yield* setup.fs.readFileString(`${setup.directory}/rollup-${day}.json`),
    );
    assert.equal(persisted.usage.totals.runs, 4);
    const lines = (yield* setup.fs.readFileString(`${setup.directory}/${day}.ndjson`))
      .trim()
      .split("\n");
    assert.equal(lines.filter((line) => JSON.parse(line).kind === "run.usage").length, 4);
  }).pipe(Effect.provide(NodeServices.layer)),
);

const delegatedUsageKeys = [
  ["plain", "review-1338_v1.2"],
  ["parentheses", "review(1338)"],
  ["bang", "review!1338"],
  ["apostrophe", "review'1338"],
  ["star", "review*1338"],
  ["tilde", "review~1338"],
  ["separators", "review:/#@%+1338"],
  ["whitespace", "review 1338\tunit"],
  ["unicode", "مراجعة-1338"],
  ["maximum-key", "界".repeat(256)],
] as const;
const delegatedUsage = (key: string) => {
  const threadId = IdAllocator.derive.delegatedTaskThread({
    commandId: CommandId.make(`command:mcp:delegate-task:caller:${encodeURIComponent(key)}`),
  });
  const runId = IdAllocator.derive.run({ threadId, ordinal: 1 });
  return {
    ts,
    kind: "run.usage" as const,
    surface: "server" as const,
    route: "provider",
    runId,
    threadId,
    boardId: "robob",
    cardId: "card:1338",
    role: "delegated" as const,
    providerInstance: "codex",
    model: "gpt-6.1-sol",
    effort: null,
    inputTokens: 123,
    outputTokens: 45,
    cachedInputTokens: null,
    reasoningTokens: null,
    wallMs: 50,
    turnCount: 1,
    endReason: "completed" as const,
    usageStatus: "partial" as const,
    reviewRound: null,
  };
};
const delegatedUsageCases = delegatedUsageKeys.map(([name, key]) => ({ name, key }));
const decodeUsage = Schema.decodeUnknownSync(AnalyticsEvent, { onExcessProperty: "error" });
it.each(delegatedUsageCases)("accepts derived usage IDs with $name allocator keys", ({ key }) => {
  const row = delegatedUsage(key);
  assert.deepEqual(decodeUsage(row), row);
});
// The maximum key's two IDs exceed the 8 KiB row cap; its schema is checked above.
it.effect.each(delegatedUsageCases.filter(({ name }) => name !== "maximum-key"))(
  "persists delegated run usage and card/model totals with $name allocator keys",
  ({ key }) =>
    Effect.gen(function* () {
      const setup = yield* fixture;
      const analytics = yield* open(setup);
      const row = delegatedUsage(key);
      yield* analytics.record(row);
      const result = yield* analytics.read({ day, kind: "run.usage", cardId: row.cardId });
      assert.deepEqual(result.samples, [row]);
      assert.deepInclude(result.rollup.usage.cards[0], {
        cardId: row.cardId,
        runs: 1,
        inputTokens: 123,
        outputTokens: 45,
      });
      assert.deepInclude(result.rollup.usage.perModel[0], {
        model: row.model,
        runs: 1,
        inputTokens: 123,
        outputTokens: 45,
      });
      const lines = (yield* setup.fs.readFileString(`${setup.directory}/${day}.ndjson`))
        .trim()
        .split("\n");
      assert.deepEqual(
        lines.map((line) => JSON.parse(line)),
        [row],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "reads cached rollups for 250k retained events under one second and updates warm filtered views incrementally",
  () =>
    Effect.gen(function* () {
      const setup = yield* fixture;
      const row = event({
        kind: "server.http",
        surface: "server",
        route: "api.cards",
        durationMs: 15,
        props: { method: "POST", status: 503, errorTag: "Http5xx" },
      });
      yield* setup.fs.writeFileString(
        `${setup.directory}/${day}.ndjson`,
        `${JSON.stringify(row)}\n`.repeat(250_000),
      );
      let scans = 0;
      const tracked = FileSystem.FileSystem.of({
        ...setup.fs,
        stream: (file, options) => {
          if (file.endsWith(".ndjson")) scans++;
          return setup.fs.stream(file, options);
        },
      });
      const analytics = yield* open(setup, {}, tracked);
      // Recovery reads each retained segment once per cold view; repeated reads and writes must not do so.
      assert.equal((yield* analytics.read({ day })).rollup.total, 250_000);
      assert.equal((yield* analytics.read({ day, kind: "server.http" })).rollup.total, 250_000);
      const before = scans;
      const started = performance.now();
      const result = yield* analytics.read({ day, limit: 500 });
      assert.isBelow(performance.now() - started, 1000);
      assert.equal(result.rollup.errorsByRoute[0]!.count, 250_000);
      assert.lengthOf(result.samples, 50);
      assert.lengthOf(yield* readSamples(analytics, { day, kind: "server.http" }), 500);
      yield* analytics.record(row);
      assert.equal((yield* analytics.read({ day })).rollup.total, 250_001);
      assert.equal(
        (yield* analytics.read({ day, kind: "server.http", limit: 1 })).rollup.total,
        250_001,
      );
      assert.equal(scans, before);
    }).pipe(Effect.provide(NodeServices.layer)),
  { timeout: 120_000 },
);

it.effect("invalidates cached views after external replacement", () =>
  Effect.gen(function* () {
    const setup = yield* fixture;
    const analytics = yield* open(setup);
    yield* analytics.record(event());
    assert.equal((yield* analytics.read({ day })).rollup.total, 1);
    yield* setup.fs.writeFileString(
      `${setup.directory}/${day}.ndjson`,
      `${JSON.stringify(event({ kind: "replacement.event" }))}\n`.repeat(2),
    );
    const result = yield* analytics.read({ day });
    assert.equal(result.rollup.total, 2);
    assert.deepEqual(result.rollup.kindCounts, { "replacement.event": 2 });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("keeps card usage views distinct through repeated reads and appends", () =>
  Effect.gen(function* () {
    const setup = yield* fixture;
    const analytics = yield* open(setup);
    for (const row of [
      { ...delegatedUsage("cache-a1"), cardId: "card:a", inputTokens: 100 },
      { ...delegatedUsage("cache-b1"), cardId: "card:b", inputTokens: 200 },
    ])
      yield* analytics.record(row);
    for (const [filter, tokens] of [
      [{ cardId: "card:a" }, 100],
      [{ cardId: "card:b" }, 200],
      [{ kind: "run.usage", cardId: "card:a" }, 100],
      [{ kind: "run.usage", cardId: "card:b" }, 200],
    ] as const) {
      const result = yield* analytics.read({ day, ...filter });
      assert.equal(result.rollup.usage.totals.runs, 1);
      assert.equal(result.rollup.usage.totals.inputTokens, tokens);
    }
    yield* analytics.record({
      ...delegatedUsage("cache-a2"),
      cardId: "card:a",
      inputTokens: 50,
    });
    for (const [filter, runs, tokens] of [
      [{ cardId: "card:b" }, 1, 200],
      [{ cardId: "card:a" }, 2, 150],
      [{ kind: "run.usage", cardId: "card:b" }, 1, 200],
      [{ kind: "run.usage", cardId: "card:a" }, 2, 150],
    ] as const) {
      const result = yield* analytics.read({ day, ...filter });
      assert.equal(result.rollup.usage.totals.runs, runs);
      assert.equal(result.rollup.usage.totals.inputTokens, tokens);
      assert.isTrue(result.samples.every((row) => row.cardId === filter.cardId));
      const persisted = JSON.parse(
        yield* setup.fs.readFileString(`${setup.directory}/rollup-${day}.json`),
      ) as AnalyticsRollup;
      assert.equal(persisted.usage.totals.runs, 3);
      assert.equal(persisted.usage.totals.inputTokens, 350);
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("cardNumber filters target and caller cards and keys cached views separately", () =>
  Effect.gen(function* () {
    const setup = yield* fixture;
    const analytics = yield* open(setup);
    for (const row of [
      event({
        kind: "mcp.call",
        surface: "server",
        tool: "delegate_task",
        outcome: "timeout",
        cardNumber: 1,
        callerCardNumber: 4336,
      }),
      event({
        kind: "mcp.call",
        surface: "server",
        tool: "delegate_task",
        outcome: "ok",
        cardNumber: 4336,
      }),
      event({
        kind: "mcp.call",
        surface: "server",
        tool: "delegate_task",
        outcome: "ok",
        cardNumber: 4334,
      }),
    ])
      yield* analytics.record(row);
    assert.equal(
      (yield* analytics.read({ day, kind: "mcp.call", tool: "delegate_task", cardNumber: 4336 }))
        .rollup.total,
      2,
    );
    assert.equal(
      (yield* analytics.read({ day, kind: "mcp.call", tool: "delegate_task", cardNumber: 4334 }))
        .rollup.total,
      1,
    );
    const selection = {
      day,
      kind: "mcp.call",
      tool: "delegate_task",
      cardNumber: 4336,
      section: "samples",
      limit: 1,
    } as const;
    const first = yield* analytics.read(selection);
    assert.isTrue(first.hasMore);
    assert.equal(first.summary.events, 2);
    const second = yield* analytics.read({ ...selection, cursor: first.cursor! });
    assert.isFalse(second.hasMore);
    const selected = [...first.rows!, ...second.rows!];
    assert.lengthOf(selected, 2);
    assert.isTrue(
      selected.every(({ value }) => {
        const row = value as AnalyticsEvent;
        return row.cardNumber === 4336 || row.callerCardNumber === 4336;
      }),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("pages filtered samples from the existing view without hot-path reads", () =>
  Effect.gen(function* () {
    const setup = yield* fixture;
    let scans = 0;
    const tracked = FileSystem.FileSystem.of({
      ...setup.fs,
      stream: (file, options) => {
        if (file.endsWith(".ndjson")) scans++;
        return setup.fs.stream(file, options);
      },
    });
    const analytics = yield* open(setup, {}, tracked);
    for (let n = 0; n < 12; n++) {
      yield* analytics.record(
        event({
          kind: "mcp.call",
          boardId: "a",
          tool: "card_get",
          outcome: "error",
          cardId: `card-${n}`,
        }),
      );
      yield* analytics.record(
        event({ kind: "mcp.call", boardId: "b", tool: "other", outcome: "ok" }),
      );
      yield* analytics.record(event({ kind: "client.click", boardId: "a", tool: "card_get" }));
    }
    const input = {
      day,
      boardId: "a",
      kind: "mcp.call",
      tool: "card_get",
      outcome: "error" as const,
      section: "samples" as const,
      limit: 3,
    };
    let page = yield* analytics.read(input);
    const before = scans;
    const rows = [...page.rows!];
    yield* analytics.record(
      event({ kind: "mcp.call", boardId: "a", tool: "card_get", outcome: "error", cardId: "new" }),
    );
    while (page.hasMore) {
      page = yield* analytics.read({ ...input, cursor: page.cursor! });
      rows.push(...page.rows!);
    }
    assert.equal(scans, before);
    assert.lengthOf(rows, 12);
    assert.deepEqual(
      rows.map((row) => (row.value as AnalyticsEvent).cardId),
      Array.from({ length: 12 }, (_, n) => `card-${11 - n}`),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("#1490 reads persisted evaluator starts for one board and UTC day in one call", () =>
  Effect.gen(function* () {
    const setup = yield* fixture;
    const analytics = yield* open(setup);
    for (const [boardId, trigger, outcome] of [
      ["board-offbox", "report_bug", "started"],
      ["board-offbox", "discussion_post", "reused"],
      ["board-other", "report_bug", "started"],
    ] as const)
      yield* analytics.record(
        event({
          kind: "kanban.evaluator",
          surface: "server",
          boardId,
          trigger,
          outcome,
          purposeKind: "request",
        }),
      );
    yield* analytics.flush;
    const result = yield* (yield* open(setup)).read({
      day,
      boardId: "board-offbox",
      kind: "kanban.evaluator",
      outcome: "started",
    });
    assert.deepEqual(result.rollup.evaluatorStartsByTrigger, [
      { boardId: "board-offbox", trigger: "report_bug", count: 1 },
    ]);
    assert.equal(result.rollup.total, 1);
    assert.equal(result.samples[0]!.outcome, "started");
    const section = yield* analytics.read({
      day,
      boardId: "board-offbox",
      kind: "kanban.evaluator",
      outcome: "started",
      section: "evaluatorStartsByTrigger",
    });
    assert.equal(section.hasMore, false);
    assert.deepEqual(
      section.rows?.map((row) => row.value),
      [{ boardId: "board-offbox", trigger: "report_bug", count: 1 }],
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "correlates detached results in filtered cold and live views without widening samples",
  () =>
    Effect.gen(function* () {
      const setup = yield* fixture;
      const analytics = yield* open(setup);
      const call = event({
        surface: "server",
        route: "mcp",
        kind: "mcp.call",
        tool: "delegate_task",
        outcome: "timeout",
        errorPhase: "dispatch",
        clientRequestId: "a".repeat(64),
        durationMs: 10000,
        boardId: "robob",
        cardNumber: 1559,
      });
      yield* analytics.record(call);
      const input = {
        day,
        kind: "mcp.call",
        tool: "delegate_task",
        outcome: "timeout",
        boardId: "robob",
        cardNumber: 1559,
      } as const;
      const before = yield* analytics.read(input);
      assert.equal(before.rollup.mcpCalls[0]!.dispatchTimeouts!.noOutcome, 1);
      // Correlation follows the original selected call even if the result has no board attribution.
      yield* analytics.record(
        event({
          surface: "server",
          route: "mcp",
          kind: "mcp.detached",
          tool: "delegate_task",
          outcome: "committed",
          clientRequestId: "a".repeat(64),
          startedAt: ts,
          ts: `${day}T12:00:15.000Z`,
          lateMs: 5000,
        }),
      );
      const warm = yield* analytics.read(input);
      assert.deepEqual(warm.rollup.mcpCalls[0]!.dispatchTimeouts, {
        committed: 1,
        failed: 0,
        capped: 0,
        noOutcome: 0,
      });
      assert.deepEqual(warm.samples, [call]);
      assert.equal(warm.rollup.total, 1);
      assert.deepEqual(warm.rollup.kindCounts, { "mcp.call": 1 });
      const cold = yield* open(setup);
      assert.deepEqual((yield* cold.read(input)).rollup.mcpCalls, warm.rollup.mcpCalls);
      const section = yield* analytics.read({ ...input, section: "mcpCalls" });
      assert.include(JSON.stringify(section.rows), '"committed":1');
      assert.isBelow(JSON.stringify(section).length, 50000);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("reads a day of runtime samples by kind within the default response cap", () =>
  Effect.gen(function* () {
    const setup = yield* fixture;
    const analytics = yield* open(setup);
    const samples = Array.from({ length: 1440 }, (_, minute) =>
      event({
        ts: `${day}T${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}:00.000Z`,
        kind: "server.runtime_sample",
        surface: "server",
        route: "server",
        props: {
          runningTurns: { total: 3, byProvider: { codex: 3 }, byModel: { sol: 3, other: 0 } },
          runningByOrigin: {
            boardWork: 1,
            boardReview: 0,
            boardEvaluator: 0,
            delegatedChild: 1,
            scheduledTask: 0,
            other: 1,
          },
          providerSessions: { codex: 1 },
          host: { load1: 12, load5: 10, load15: 8, rssMiB: 900, heapUsedMiB: 500 },
          sampleMs: 0.25,
        },
      }),
    );
    yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe(`${day}T23:59:59.000Z`)));
    for (const sample of samples) yield* analytics.record(sample);
    yield* analytics.record(event({ kind: "unrelated.event" }));
    yield* analytics.flush;
    const reply = yield* analytics.read({ day, kind: "server.runtime_sample" });
    assert.equal(reply.rollup.total, 1440);
    assert.equal(reply.rollup.kindCounts["server.runtime_sample"], 1440);
    assert.isBelow(JSON.stringify(reply).length, 50_000);
    const rows = yield* readSamples(analytics, { day, kind: "server.runtime_sample" });
    // Existing analytics reads retain a bounded latest-500 sample window for each kind.
    assert.equal(rows.length, 500);
    assert.isTrue(rows.every((row) => row.kind === "server.runtime_sample"));
    assert.equal(rows[0]!.props!.runningTurns!.total, 3);
    const hourly = yield* analytics.read({
      day,
      kind: "server.runtime_sample",
      section: "runtimeSamples",
    });
    assert.equal(hourly.rows!.length, 24);
    assert.isBelow(JSON.stringify(hourly).length, 50_000);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("persists restart-admission facts and exposes their server-wide section", () =>
  Effect.gen(function* () {
    const setup = yield* fixture;
    const analytics = yield* open(setup);
    const restartAdmission = {
      sourceRunId: "run:source:ordinal:3",
      runId: "run:next:ordinal:4",
      classification: "continuation",
      queuedAtMs: Date.parse(ts) - 1000,
      waitedMs: 1000,
      positionAtEntry: 12,
      position: 1,
      total: 3,
      maxQueueDepth: 12,
      active: 1,
      maxActive: 4,
      loaded: false,
    };
    yield* analytics.record(
      event({
        kind: "restart.admission.admitted",
        surface: "server",
        route: "restart-pacing",
        threadId: "thread:admitted",
        bootId: "boot",
        restartAdmission,
      }),
    );
    yield* analytics.record(
      event({
        kind: "restart.admission.failed",
        surface: "server",
        route: "restart-pacing",
        threadId: "thread:failed",
        bootId: "boot",
        restartAdmission: {
          ...restartAdmission,
          sourceRunId: "run:failed:ordinal:3",
          rule: "no_progress",
        },
      }),
    );
    yield* analytics.flush;
    const result = yield* analytics.read({ day });
    assert.deepEqual(result.rollup.restartAdmission?.groups[0]?.wait, {
      count: 1,
      p50Ms: 1000,
      p90Ms: 1000,
      maxMs: 1000,
      approximate: false,
    });
    assert.deepEqual(result.rollup.restartAdmission?.groups[0]?.failuresByRule, { no_progress: 1 });
    const samples = yield* readSamples(analytics, { day, kind: "restart.admission.failed" });
    assert.deepEqual(samples[0]?.restartAdmission, {
      ...restartAdmission,
      sourceRunId: "run:failed:ordinal:3",
      rule: "no_progress",
    });
    const section = yield* analytics.read({ day, section: "restartAdmission" });
    assert.strictEqual(section.section, "restartAdmission");
    assert.isNotEmpty(section.rows);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
