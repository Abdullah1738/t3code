import {
  CommandId,
  MessageId,
  ProjectId,
  RunId,
  ThreadId,
  type ModelSelection,
  type ServerSettings,
  type ServerSettingsPatch,
  type KanbanBoard,
  type KanbanCard,
  type KanbanPool,
  type KanbanThreadLink,
  isProviderNativeSubagentThread,
} from "@t3tools/contracts";
import { derive } from "@t3tools/provider-core/server/IdAllocator";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ServerConfig from "../../config.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as Threads from "../../orchestration-v2/ThreadManagementService.ts";
import * as Projects from "../../project/ProjectService.ts";
import * as Settings from "../../serverSettings.ts";
import * as Schedules from "../../scheduledTasks/ScheduledTaskService.ts";
import * as ProviderSessions from "../../orchestration-v2/ProviderSessionManager.ts";
import * as Projections from "../../orchestration-v2/ProjectionStore.ts";
import { sessionHoldsWork } from "../archive-if-idle/idle.ts";
import * as Kanban from "../kanban/engine/KanbanService.ts";
import * as BoardStore from "../kanban/store/KanbanStore.ts";
import * as BoardsDatabase from "../persistence/BoardsDatabase.ts";
import { runningBackgroundWork } from "../context-reset/backgroundWork.ts";
import { planBoard, type BoardSnapshot } from "./boardPlan.ts";
import { planSettings, parseProjectOverrideRef } from "./settingsPlan.ts";
import { planSelection, sameValue } from "./selectionPlan.ts";
import { planFallbacks } from "./fallbackPlan.ts";
import { readBlockRetry, writeBlockRetry, type BlockRetry } from "../schedules/runFollow.ts";
import * as Input from "./CutoverInput.ts";
import * as Readiness from "./CutoverReadiness.ts";
import { releaseCutoverThread } from "./cutoverClaim.ts";
import { checkBoardScripts } from "./BoardScriptReadiness.ts";
import {
  CutoverActions,
  CutoverError,
  CutoverDeferred,
  type CutoverItem,
  type CutoverPlan,
} from "./CutoverEngine.ts";

const SelectionPayload = Schema.Struct({
  scope: Schema.Literals(["project", "schedule", "thread", "queued"]),
  before: Schema.Unknown,
  after: Schema.Unknown,
  projectId: Schema.optionalKey(ProjectId),
  runId: Schema.optionalKey(RunId),
  sourceRunId: Schema.optionalKey(Schema.String),
  queuedBefore: Schema.optionalKey(
    Schema.Array(Schema.Struct({ id: RunId, selection: Schema.Unknown })),
  ),
});
const decodeSelection = Schema.decodeUnknownEffect(SelectionPayload);
const settingsValue = (settings: ServerSettings, ref: string): unknown => {
  const override = parseProjectOverrideRef(ref);
  return override === null
    ? (settings as unknown as Record<string, unknown>)[ref]
    : settings.projectSettingsOverrides[ProjectId.make(override.projectId)]?.[override.field];
};
const settingsPatch = (
  settings: ServerSettings,
  ref: string,
  value: unknown,
): ServerSettingsPatch => {
  const override = parseProjectOverrideRef(ref);
  return override === null
    ? ({ [ref]: value } as ServerSettingsPatch)
    : ({
        projectSettingsOverrides: {
          ...settings.projectSettingsOverrides,
          [override.projectId]: {
            ...settings.projectSettingsOverrides[ProjectId.make(override.projectId)],
            [override.field]: value,
          },
        },
      } as ServerSettingsPatch);
};

export const layer = Layer.effect(
  CutoverActions,
  Effect.gen(function* () {
    const settings = yield* Settings.ServerSettingsService;
    const projects = yield* Projects.ProjectService;
    const schedules = yield* Schedules.ScheduledTaskService;
    const engine = yield* Orchestrator.OrchestratorV2;
    const threads = yield* Threads.ThreadManagementService;
    const boards = yield* Kanban.KanbanService;
    const store = yield* BoardStore.KanbanStore;
    const boardSql = yield* BoardsDatabase.client;
    const inputSource = yield* Input.CutoverInputSource;
    const readiness = yield* Readiness.CutoverReadiness;
    const providerSessions = yield* ProviderSessions.ProviderSessionManagerV2;
    const projections = yield* Projections.ProjectionStoreV2;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const fail = (operation: string) => (cause: unknown) => new CutoverError({ operation, cause });
    const command = (item: CutoverItem, suffix: string) =>
      CommandId.make(`harness-cutover:v1:${item.key}:${suffix}`);

    const plan = Effect.fn("CutoverActions.plan")(function* () {
      const items: CutoverItem[] = [];
      const refusals: { ref: string; reason: string }[] = [];
      const targets: ModelSelection[] = [];
      const deferredBoardThreads = new Set<string>();
      const queueThreads = new Set<ThreadId>();
      const releaseBoardIds = new Set<string>();
      const current = yield* settings.getSettings.pipe(Effect.mapError(fail("settings")));
      const input = yield* inputSource.read.pipe(Effect.result);
      if (input._tag === "Failure") refusals.push({ ref: "input", reason: input.failure.message });
      const stopped = input._tag === "Success" ? input.success.stoppedCards : [];
      const interrupted = new Map(
        input._tag === "Success"
          ? input.success.interruptedThreads.map((row) => [row.threadId, row.runId])
          : [],
      );
      const addSelection = (
        scope: "project" | "schedule" | "thread" | "queued",
        ref: string,
        before: ModelSelection,
        extra: Record<string, unknown> = {},
        wake = false,
      ) => {
        const mapped = planSelection(before);
        if (mapped._tag === "conflict") refusals.push({ ref, reason: mapped.reason });
        if (mapped._tag !== "mapped") return;
        targets.push(mapped.next);
        items.push({
          key: `${scope}:${ref}`,
          kind: scope === "thread" ? "thread" : "selection",
          ref,
          wake,
          payload: { scope, before, after: mapped.next, ...extra },
        });
      };
      const settingsPlan = planSettings(current);
      refusals.push(
        ...settingsPlan.conflicts.map((entry) => ({ ref: entry.field, reason: entry.reason })),
      );
      for (const change of settingsPlan.changes)
        items.push({
          key: `settings:${change.field}`,
          kind: "selection",
          ref: change.field,
          wake: false,
          payload: { scope: "settings", ...change },
        });
      const collectTargets = (value: unknown): void => {
        if (Array.isArray(value)) {
          for (const entry of value) collectTargets(entry);
          return;
        }
        if (value === null || typeof value !== "object") return;
        if (
          "instanceId" in value &&
          "model" in value &&
          typeof value.instanceId === "string" &&
          typeof value.model === "string"
        ) {
          targets.push(value as ModelSelection);
          return;
        }
        for (const entry of Object.values(value)) collectTargets(entry);
      };
      for (const change of settingsPlan.changes) collectTargets(change.after);
      const projectList = yield* projects.listShells().pipe(Effect.mapError(fail("projects")));
      for (const project of projectList)
        if (project.defaultModelSelection !== null)
          addSelection("project", project.id, project.defaultModelSelection);
      const boardList = yield* boards.boards.pipe(Effect.mapError(fail("boards")));
      for (const board of boardList) {
        refusals.push(
          ...(yield* checkBoardScripts(
            yield* store.scripts(board.id).pipe(Effect.mapError(fail("board-scripts"))),
          ).pipe(Effect.provideService(FileSystem.FileSystem, fs))),
        );
        const snapshot: BoardSnapshot = {
          board,
          cards: yield* store.cards(board.id).pipe(Effect.mapError(fail("cards"))),
          pools: yield* store.pools(board.id).pipe(Effect.mapError(fail("pools"))),
          openLinks: yield* store
            .threadLinks({ boardId: board.id, open: false })
            .pipe(Effect.mapError(fail("links"))),
        };
        const planned = planBoard(snapshot);
        for (const link of snapshot.openLinks)
          if (link.role === "evaluator" || link.discussionId !== null)
            deferredBoardThreads.add(link.threadId);
        for (const conflict of planned.conflicts)
          refusals.push({ ref: `${board.id}:${conflict.field}`, reason: conflict.reason });
        for (const collision of planned.collisions)
          refusals.push({
            ref: board.id,
            reason: `Pool collision: ${collision.oldKeys.join(", ")}`,
          });
        if (planned.changed && planned.next !== null) {
          if (board.pause === null)
            refusals.push({
              ref: board.id,
              reason: "Pause the board before changing its selections.",
            });
          const after = {
            ...planned.next,
            cards: planned.next.cards.map((card, index) =>
              card.activeThreadId === null ? snapshot.cards[index]! : card,
            ),
          };
          items.push({
            key: `board:${board.id}`,
            kind: "selection",
            ref: board.id,
            wake: false,
            payload: { scope: "board", before: snapshot, after, changes: planned.changes },
          });
          for (const [index, card] of planned.next.cards.entries())
            if (card.activeThreadId === null && !sameValue(card, snapshot.cards[index])) {
              items.push({
                key: `pinned:${card.id}`,
                kind: "selection",
                ref: card.id,
                wake: false,
                payload: { before: snapshot.cards[index], after: card },
              });
            }
          targets.push(
            planned.next.board.managerModel,
            planned.next.board.evaluatorModel,
            planned.next.board.defaultCardModel,
            ...planned.next.pools.map((pool) => pool.model),
            ...planned.next.cards.flatMap((card) => [
              card.model,
              ...card.models.map((entry) => entry.model),
            ]),
            ...planned.next.board.reviewChains.flatMap((chain) => chain.steps),
          );
        }
      }
      const scheduled = yield* schedules.list().pipe(Effect.mapError(fail("schedules")));
      for (const task of scheduled.tasks) {
        addSelection("schedule", task.id, task.modelSelection);
        const retry = yield* readBlockRetry(boardSql, task, { readOnly: true }).pipe(
          Effect.mapError(fail("fallbacks")),
        );
        if (retry !== null) {
          const fallback = planFallbacks({ taskId: task.id, fallbacks: retry.fallbacks });
          refusals.push(
            ...fallback.conflicts.map((entry) => ({
              ref: `${task.id}:fallback:${entry.index}`,
              reason: entry.reason,
            })),
          );
          if (fallback.changed) {
            items.push({
              key: `fallback:${task.id}`,
              kind: "selection",
              ref: task.id,
              wake: false,
              payload: {
                task: { id: task.id, createdAt: task.createdAt },
                before: retry,
                after: { ...retry, fallbacks: fallback.after },
              },
            });
            targets.push(...fallback.after);
          }
        }
      }
      const seenThreads = new Set<string>();
      let afterThreadId: ThreadId | undefined;
      do {
        const page = yield* projections
          .listCutoverCandidates({
            ...(afterThreadId === undefined ? {} : { afterThreadId }),
            limit: 100,
          })
          .pipe(Effect.mapError(fail("threads")));
        for (const thread of page.threads) {
          seenThreads.add(thread.id);
          if (thread.archivedAt !== null || thread.deletedAt !== null) continue;
          const mapped = planSelection(thread.modelSelection);
          if (mapped._tag === "conflict") {
            refusals.push({ ref: thread.id, reason: mapped.reason });
            continue;
          }
          if (mapped._tag !== "mapped") {
            // A queued turn can override an otherwise unrelated thread's selection.
            const queued = yield* engine
              .getThreadRecords(thread.id, ["runs"])
              .pipe(Effect.mapError(fail("queued")));
            if (queued.runs.some((run) => run.status === "queued" && run.queueHeld !== true))
              queueThreads.add(thread.id);
            for (const run of queued.runs)
              if (run.status === "queued")
                addSelection("queued", run.id, run.modelSelection, {
                  threadId: thread.id,
                  runId: run.id,
                });
            continue;
          }
          queueThreads.add(thread.id);
          const records = yield* engine
            .getThreadRecords(thread.id, [
              "runs",
              "providerThreads",
              "runtimeRequests",
              "subagents",
            ])
            .pipe(Effect.mapError(fail("thread-records")));
          if (records.runs.some((run) => run.status === "queued" && run.queueHeld !== true))
            queueThreads.add(thread.id);
          const sourceRunId =
            interrupted.get(thread.id) ?? records.runs.find(Threads.isActiveRun)?.id;
          const wake =
            !isProviderNativeSubagentThread(thread) &&
            (stopped.some((card) => card.thread === thread.id) ||
              (!deferredBoardThreads.has(thread.id) &&
                sourceRunId !== null &&
                sourceRunId !== undefined));
          addSelection(
            "thread",
            thread.id,
            thread.modelSelection,
            {
              projectId: thread.projectId,
              ...(sourceRunId == null ? {} : { sourceRunId }),
              queuedBefore: records.runs
                .filter((run) => run.status === "queued")
                .map((run) => ({ id: run.id, selection: run.modelSelection })),
            },
            wake,
          );
          for (const run of records.runs)
            if (run.status === "queued")
              addSelection("queued", run.id, run.modelSelection, {
                threadId: thread.id,
                runId: run.id,
              });
        }
        afterThreadId = page.nextThreadId ?? undefined;
      } while (afterThreadId !== undefined);
      for (const card of stopped) {
        const currentCard = yield* store.card(card.id).pipe(Effect.mapError(fail("stopped-card")));
        if (currentCard === null || !seenThreads.has(card.thread)) {
          refusals.push({
            ref: card.id,
            reason: "Stopped card or its exact existing thread is missing/archived.",
          });
          continue;
        }
        releaseBoardIds.add(currentCard.boardId);
        items.push({
          key: `card:${card.id}`,
          kind: "card",
          ref: card.id,
          payload: card,
          wake: false,
        });
      }
      items.sort(
        (a, b) => Number(b.kind === "thread" && b.wake) - Number(a.kind === "thread" && a.wake),
      );
      items.push({
        key: "finalize",
        kind: "finalize",
        ref: "cutover",
        wake: false,
        payload: {
          boards: boardList
            .filter((board) => board.pause !== null && releaseBoardIds.has(board.id))
            .map((board) => ({ id: board.id, pause: board.pause })),
          queueThreads: [...queueThreads],
        },
      });
      return { items, refusals, readiness: yield* readiness.check(targets) } satisfies CutoverPlan;
    });

    const apply = Effect.fn("CutoverActions.apply")(function* (
      item: CutoverItem,
      phase: "switch" | "brief" | "rollback",
    ) {
      if (phase === "brief" && item.kind !== "thread") return;
      if (
        item.kind === "thread" ||
        item.key.startsWith("project:") ||
        item.key.startsWith("schedule:") ||
        item.key.startsWith("queued:")
      ) {
        if (phase !== "rollback" && item.kind === "thread") {
          yield* settings
            .updateSettingsIf((current) =>
              current.ardudHarnessMigration?.transcript?.enabled === true
                ? {
                    ardudHarnessMigration: {
                      ...current.ardudHarnessMigration,
                      transcript: { enabled: false },
                    },
                  }
                : null,
            )
            .pipe(Effect.mapError(fail("disable-lite-transcript")));
        }
        const payload = yield* decodeSelection(item.payload).pipe(
          Effect.mapError(fail("decode-selection")),
        );
        const before = (
          phase === "rollback" && payload.scope !== "thread" ? payload.after : payload.before
        ) as ModelSelection;
        const after = (
          phase === "rollback" && payload.scope !== "thread" ? payload.before : payload.after
        ) as ModelSelection;
        const writePhase = phase === "rollback" ? "rollback" : "switch";
        if (payload.scope === "thread") {
          const id = ThreadId.make(item.ref);
          const records = yield* engine
            .getThreadRecords(id, [
              "runs",
              "attempts",
              "providerTurns",
              "providerThreads",
              "runtimeRequests",
              "subagents",
              "turnItems",
            ])
            .pipe(Effect.mapError(fail("read-thread")));
          if (phase === "brief") {
            if (!item.wake) return;
            if (records.runtimeRequests.some((request) => request.status === "pending"))
              return yield* new CutoverDeferred({
                reason: "Waiting for the existing owner question to be answered.",
              });
            let trial = 0;
            const accepted = (current: typeof records, runId: RunId) => {
              const attempts = current.attempts.filter((attempt) => attempt.runId === runId);
              return current.providerTurns.some(
                (turn) =>
                  attempts.some(
                    (attempt) =>
                      attempt.id === turn.runAttemptId &&
                      attempt.providerInstanceId === after.instanceId,
                  ) &&
                  turn.nativeTurnRef?.nativeId != null &&
                  turn.promptAcceptedAt !== undefined,
              );
            };
            while (trial < 3) {
              const messageId = MessageId.make(`harness-cutover:v1:${item.key}:resume:${trial}`);
              const previous = records.runs.find((run) => run.userMessageId === messageId);
              if (previous === undefined) break;
              if (accepted(records, previous.id)) return;
              if (!["failed", "cancelled", "interrupted"].includes(previous.status))
                return yield* new CutoverDeferred({
                  reason: "Carry-on turn dispatched; waiting for native prompt acceptance.",
                });
              const attempts = records.attempts.filter((attempt) => attempt.runId === previous.id);
              // Running timestamps precede handoff delivery. Every started
              // attempt needs its own runtime failure proof before resending.
              const provenUnsent =
                attempts.some((attempt) => attempt.startedAt !== null) &&
                attempts.every((attempt) => {
                  if (attempt.startedAt === null) return true;
                  const providerThread = records.providerThreads.find(
                    (thread) => thread.id === attempt.providerThreadId,
                  );
                  if (providerThread === undefined) return false;
                  const providerTurnId =
                    attempt.providerTurnId ??
                    derive.providerTurn({
                      driver: providerThread.driver,
                      nativeTurnId: `failed:${attempt.id}`,
                    });
                  return records.turnItems.some(
                    (item) =>
                      item.runId === previous.id &&
                      item.nodeId === attempt.rootNodeId &&
                      item.providerThreadId === attempt.providerThreadId &&
                      item.providerTurnId === providerTurnId &&
                      item.type === "error" &&
                      item.failure.code === "provider_prompt_not_sent",
                  );
                });
              if (
                !provenUnsent &&
                (previous.startedAt !== null ||
                  records.attempts.some(
                    (attempt) => attempt.runId === previous.id && attempt.startedAt !== null,
                  ))
              )
                return yield* new CutoverDeferred({
                  reason:
                    "Native carry-on delivery is ambiguous; reconcile the prompt before retrying.",
                });
              trial++;
            }
            if (trial === 3)
              return yield* new CutoverError({ operation: "native-start-three-failures" });
            const resumeCommand = command(item, `resume:${trial}`);
            const shell = yield* engine
              .getShellSnapshot({ location: "active" })
              .pipe(Effect.mapError(fail("native-cap")));
            if (
              shell.threads.filter(
                (row) =>
                  ["claudeAgent", "codex", "codex-cu"].includes(row.modelSelection.instanceId) &&
                  row.activeRunId !== null,
              ).length >= 3 &&
              !(yield* threads.hasReceipt(resumeCommand))
            )
              return yield* new CutoverDeferred({
                reason: "Three native sessions are active; the next batch waits for capacity.",
              });
            yield* threads
              .sendToThread({
                projectId: records.thread.projectId,
                threadId: id,
                commandId: resumeCommand,
                messageId: MessageId.make(`harness-cutover:v1:${item.key}:resume:${trial}`),
                text: `Robob upgrade moved this thread to ${after.instanceId === "claudeAgent" ? "Claude Code" : "Codex"}. Carry on where you left off; do not redo finished work or resend messages.`,
                attachments: [],
                modelSelection: after,
                mode: "queue",
                createdBy: "system",
                creationSource: "server",
              })
              .pipe(Effect.mapError(fail("resume")));
            const delivered = yield* engine
              .getThreadRecords(id, [
                "runs",
                "attempts",
                "providerTurns",
                "providerThreads",
                "runtimeRequests",
                "subagents",
                "turnItems",
              ])
              .pipe(Effect.mapError(fail("native-acceptance")));
            const sentRun = delivered.runs.find(
              (run) =>
                run.userMessageId ===
                MessageId.make(`harness-cutover:v1:${item.key}:resume:${trial}`),
            );
            if (sentRun === undefined || !accepted(delivered, sentRun.id))
              return yield* new CutoverDeferred({
                reason: "Carry-on turn dispatched; waiting for native prompt acceptance.",
              });
            return;
          }
          if (phase === "rollback") {
            if (
              records.runs.some(Threads.isActiveRun) ||
              records.runtimeRequests.some((request) => request.status === "pending") ||
              runningBackgroundWork(records).length > 0
            )
              return yield* new CutoverDeferred({
                reason: "Cannot roll back a thread while native work or a question is live.",
              });
            if (sameValue(records.thread.modelSelection, after))
              yield* engine
                .dispatch({
                  type: "provider.switch",
                  commandId: command(item, "rollback"),
                  threadId: id,
                  modelSelection: before,
                })
                .pipe(Effect.mapError(fail("rollback")));
            for (const queued of payload.queuedBefore ?? []) {
              const selection = queued.selection as ModelSelection;
              const mapped = planSelection(selection);
              const run = records.runs.find((row) => row.id === queued.id);
              if (
                run?.status === "queued" &&
                mapped._tag === "mapped" &&
                sameValue(run.modelSelection, mapped.next)
              )
                yield* engine
                  .dispatch({
                    type: "queued-run.rebind-selection",
                    commandId: command(item, `rollback-queue:${queued.id}`),
                    threadId: id,
                    runId: queued.id,
                    expectedModelSelection: mapped.next,
                    modelSelection: selection,
                  })
                  .pipe(Effect.mapError(fail("rollback-queue")));
            }
            yield* releaseCutoverThread(id).pipe(
              Effect.provideService(FileSystem.FileSystem, fs),
              Effect.provideService(Path.Path, path),
              Effect.provideService(ServerConfig.ServerConfig, config),
              Effect.mapError(fail("release-thread")),
            );
            return;
          }
          if (sameValue(records.thread.modelSelection, after)) {
            if (
              records.thread.interactionMode !== "plan" &&
              records.thread.runtimeMode !== "full-access"
            )
              yield* engine
                .dispatch({
                  type: "thread.runtime-mode.set",
                  commandId: command(item, "full-access"),
                  threadId: id,
                  runtimeMode: "full-access",
                })
                .pipe(Effect.mapError(fail("runtime")));
            return;
          }
          if (records.thread.archivedAt !== null && !item.wake) return;
          let switchFrom = before;
          let switchTo = after;
          if (!item.wake && !sameValue(records.thread.modelSelection, before)) {
            // Moved since planning (the owner re-picked, or a bridge already went native): map
            // what the thread has now. A native or unmapped selection needs nothing.
            const mapped = planSelection(records.thread.modelSelection);
            if (mapped._tag === "conflict")
              return yield* new CutoverError({ operation: "thread-unmappable" });
            if (mapped._tag === "same") return;
            switchFrom = records.thread.modelSelection;
            switchTo = mapped.next;
          }
          if (
            !sameValue(records.thread.modelSelection, switchFrom) ||
            records.thread.archivedAt !== null
          )
            return yield* new CutoverError({ operation: "thread-changed" });
          if (
            records.runtimeRequests.some((request) => request.status === "pending") ||
            runningBackgroundWork(records).length > 0
          )
            return yield* new CutoverDeferred({
              reason: "Existing owner question or background work must settle before switching.",
            });
          const active = records.runs.find(Threads.isActiveRun);
          if (active !== undefined) {
            yield* threads
              .interruptThread({
                projectId: records.thread.projectId,
                threadId: id,
                runId: active.id,
                commandId: command(item, `interrupt:${active.id}`),
                reason: "Harness cutover",
              })
              .pipe(Effect.mapError(fail("interrupt")));
            return yield* new CutoverDeferred({
              reason: "Waiting for the interrupted source run to drain.",
            });
          }
          for (const row of records.providerThreads)
            if (row.providerSessionId !== null) {
              if (providerSessions.peek === undefined)
                return yield* new CutoverDeferred({
                  reason: "The source runtime cannot be inspected safely.",
                });
              const runtime = yield* providerSessions
                .peek(row.providerSessionId)
                .pipe(Effect.mapError(fail("source-runtime")));
              if (Option.isSome(runtime) && (yield* sessionHoldsWork(runtime.value, row)))
                return yield* new CutoverDeferred({
                  reason: "The source provider still holds work or a buffered wake.",
                });
            }
          // The admission barrier prevents queued turns from starting during selection migration.
          for (const run of records.runs)
            if (run.status === "queued") {
              const mapped = planSelection(run.modelSelection);
              if (mapped._tag === "conflict")
                return yield* new CutoverError({ operation: "queued-unmappable" });
              if (mapped._tag === "mapped")
                yield* engine
                  .dispatch({
                    type: "queued-run.rebind-selection",
                    commandId: command(item, `queued:${run.id}`),
                    threadId: id,
                    runId: run.id,
                    modelSelection: mapped.next,
                    expectedModelSelection: run.modelSelection,
                  })
                  .pipe(Effect.mapError(fail("rebind-queue")));
            }
          yield* engine
            .dispatch({
              type: "provider.switch",
              commandId: command(item, "switch"),
              threadId: id,
              modelSelection: switchTo,
              ...(records.thread.settledAt === null ? { expectedModelSelection: switchFrom } : {}),
            })
            .pipe(Effect.mapError(fail("switch")));
          if (
            records.thread.interactionMode !== "plan" &&
            records.thread.runtimeMode !== "full-access"
          )
            yield* engine
              .dispatch({
                type: "thread.runtime-mode.set",
                commandId: command(item, "full-access"),
                threadId: id,
                runtimeMode: "full-access",
              })
              .pipe(Effect.mapError(fail("runtime")));
          return;
        }
        if (phase === "brief") return;
        if (payload.scope === "project") {
          const id = ProjectId.make(item.ref);
          const project = yield* projects.getById(id).pipe(Effect.mapError(fail("read-project")));
          if (Option.isSome(project) && sameValue(project.value.defaultModelSelection, after))
            return;
          yield* projects
            .update({
              projectId: id,
              commandId: command(item, writePhase),
              defaultModelSelection: after,
              expectedDefaultModelSelection: before,
            })
            .pipe(Effect.mapError(fail("project")));
        } else if (payload.scope === "schedule") {
          const tasks = yield* schedules.list().pipe(Effect.mapError(fail("read-schedule")));
          const task = tasks.tasks.find((entry) => entry.id === item.ref);
          if (task !== undefined && sameValue(task.modelSelection, after)) return;
          if (
            task === undefined ||
            !(yield* schedules
              .migrateModelSelection({ id: task.id, expected: before, next: after })
              .pipe(Effect.mapError(fail("schedule"))))
          )
            return yield* new CutoverError({ operation: "schedule-changed" });
        } else {
          const raw = item.payload as { threadId: string };
          const current = yield* engine
            .getThreadRecords(ThreadId.make(raw.threadId), ["runs"])
            .pipe(Effect.mapError(fail("queued-current")));
          const queuedRun = current.runs.find((run) => run.id === item.ref);
          if (queuedRun === undefined || sameValue(queuedRun.modelSelection, after)) return;
          // A run that left the queue (started, cancelled) since planning has nothing to rebind.
          if (queuedRun.status !== "queued") return;
          let expected = before;
          let next = after;
          if (phase !== "rollback" && !sameValue(queuedRun.modelSelection, before)) {
            // Edited since planning: map what is queued now, never what was planned.
            const mapped = planSelection(queuedRun.modelSelection);
            if (mapped._tag === "conflict")
              return yield* new CutoverError({ operation: "queued-unmappable" });
            if (mapped._tag === "same") return;
            expected = queuedRun.modelSelection;
            next = mapped.next;
          }
          yield* engine
            .dispatch({
              type: "queued-run.rebind-selection",
              commandId: command(item, writePhase),
              threadId: ThreadId.make(raw.threadId),
              runId: RunId.make(item.ref),
              expectedModelSelection: expected,
              modelSelection: next,
            })
            .pipe(Effect.mapError(fail("queued")));
        }
        return;
      }
      if (item.key.startsWith("fallback:")) {
        const source = item.payload as {
          task: Parameters<typeof readBlockRetry>[1];
          before: BlockRetry;
          after: BlockRetry;
        };
        const value =
          phase === "rollback" ? { ...source, before: source.after, after: source.before } : source;
        const current = yield* readBlockRetry(boardSql, value.task).pipe(
          Effect.mapError(fail("fallback-read")),
        );
        if (sameValue(current, value.after)) return;
        if (!sameValue(current, value.before))
          return yield* new CutoverError({ operation: "fallback-changed" });
        yield* writeBlockRetry(boardSql, value.task, value.after).pipe(
          Effect.mapError(fail("fallback-write")),
        );
      } else if (item.key.startsWith("pinned:")) {
        const source = item.payload as { before: KanbanCard; after: KanbanCard };
        const value =
          phase === "rollback" ? { before: source.after, after: source.before } : source;
        yield* boards
          .withSelectionMigrationLock(
            boardSql.withTransaction(
              Effect.gen(function* () {
                const current = yield* store.card(value.before.id);
                if (sameValue(current, value.after)) return;
                if (phase !== "rollback") {
                  // Paused boards still get edited (titles, stages, new asks). Map the card as it
                  // is now; only its model selections change, and a conflict is never guessed.
                  if (current === null) return;
                  const board = (yield* store.boards).find((entry) => entry.id === current.boardId);
                  if (board === undefined) return;
                  const planned = planBoard({
                    board,
                    pools: yield* store.pools(board.id),
                    cards: [current],
                    openLinks: [],
                  });
                  if (planned.conflicts.length > 0 || planned.collisions.length > 0)
                    return yield* new CutoverError({ operation: "pinned-card-conflict" });
                  const next = planned.next?.cards[0];
                  if (next === undefined || sameValue(next, current)) return;
                  yield* store.putCard(next);
                  return;
                }
                if (!sameValue(current, value.before))
                  return yield* new CutoverError({ operation: "pinned-card-changed" });
                yield* store.putCard(value.after);
              }),
            ),
          )
          .pipe(Effect.mapError(fail("pinned-card")));
      } else if (item.key.startsWith("settings:")) {
        const source = item.payload as { field: string; before: unknown; after: unknown };
        const value =
          phase === "rollback" ? { ...source, before: source.after, after: source.before } : source;
        const current = yield* settings.getSettings.pipe(Effect.mapError(fail("settings")));
        if (sameValue(settingsValue(current, value.field), value.after)) return;
        const wrote = yield* settings
          .updateSettingsIf((now) =>
            sameValue(settingsValue(now, value.field), value.before)
              ? settingsPatch(now, value.field, value.after)
              : null,
          )
          .pipe(Effect.mapError(fail("settings-write")));
        if (!wrote) return yield* new CutoverError({ operation: "settings-changed" });
      } else if (item.key.startsWith("board:")) {
        const source = item.payload as {
          before: BoardSnapshot;
          after: {
            board: KanbanBoard;
            pools: readonly KanbanPool[];
            cards: readonly KanbanCard[];
            openLinks: readonly KanbanThreadLink[];
          };
        };
        const payload =
          phase === "rollback" ? { before: source.after, after: source.before } : source;
        yield* boards
          .withSelectionMigrationLock(
            boardSql.withTransaction(
              Effect.gen(function* () {
                const board = (yield* store.boards).find(
                  (entry) => entry.id === payload.before.board.id,
                );
                const current = {
                  board,
                  pools: yield* store.pools(payload.before.board.id),
                  cards: yield* store.cards(payload.before.board.id),
                  openLinks: yield* store.threadLinks({
                    boardId: payload.before.board.id,
                    open: false,
                  }),
                };
                if (sameValue(current, payload.after)) return;
                if (phase !== "rollback") {
                  // Paused boards still get edited and gain cards after planning. Re-plan the live
                  // board and write only its selection changes; conflicts are never guessed.
                  if (current.board === undefined) return;
                  const live = { ...current, board: current.board };
                  const planned = planBoard(live);
                  if (planned.conflicts.length > 0 || planned.collisions.length > 0)
                    return yield* new CutoverError({ operation: "board-conflict" });
                  if (!planned.changed || planned.next === null) return;
                  // Planned inactive cards keep their own retryable pinned rows; cards created
                  // after planning have none, so the board row maps them.
                  const pinnedIds = new Set(
                    payload.before.cards
                      .filter((card) => card.activeThreadId === null)
                      .map((card) => card.id),
                  );
                  const next = {
                    ...planned.next,
                    cards: planned.next.cards.map((card, index) =>
                      card.activeThreadId === null && pinnedIds.has(card.id)
                        ? live.cards[index]!
                        : card,
                    ),
                  };
                  yield* store.migrateBoardSelections({
                    ...next,
                    oldPoolKeys: live.pools.map((pool) => pool.key),
                    threadLinks: next.openLinks.filter(
                      (link, index) => !sameValue(link, live.openLinks[index]),
                    ),
                    cards: next.cards.filter((card, index) => !sameValue(card, live.cards[index])),
                  });
                  return;
                }
                if (!sameValue(current, payload.before))
                  return yield* new CutoverError({ operation: "board-changed" });
                yield* store.migrateBoardSelections({
                  ...payload.after,
                  oldPoolKeys: payload.before.pools.map((pool) => pool.key),
                  threadLinks: payload.after.openLinks.filter(
                    (link, index) => !sameValue(link, payload.before.openLinks[index]),
                  ),
                  cards: payload.after.cards.filter(
                    (card, index) => !sameValue(card, payload.before.cards[index]),
                  ),
                });
              }),
            ),
          )
          .pipe(Effect.mapError(fail("board")));
      } else if (item.kind === "card") {
        const row = item.payload as Input.CutoverInput["stoppedCards"][number];
        yield* boards
          .restoreCutoverCard({ cardId: row.id, threadId: row.thread, stage: row.stage })
          .pipe(Effect.mapError(fail("restore-card")));
      } else if (item.kind === "finalize") {
        const currentSettings = yield* settings.getSettings.pipe(
          Effect.mapError(fail("finalize-settings")),
        );
        yield* settings
          .updateSettings({
            ardudHarnessMigration: {
              ...currentSettings.ardudHarnessMigration,
              selections: "apply",
              cutoverComplete: true,
              transcript: { enabled: false },
            },
          })
          .pipe(Effect.mapError(fail("finalize-settings")));
        yield* fs
          .writeFileString(
            path.join(config.stateDir, "harness-cutover-released.json"),
            '{"version":1}',
            { mode: 0o600 },
          )
          .pipe(Effect.mapError(fail("release-admission")));
        const payload = item.payload as {
          boards: readonly { id: KanbanBoard["id"]; pause: KanbanBoard["pause"] }[];
          queueThreads: readonly ThreadId[];
        };
        for (const threadId of payload.queueThreads) {
          const records = yield* engine
            .getThreadRecords(threadId, ["runs"])
            .pipe(Effect.mapError(fail("release-read")));
          const queued = records.runs.filter((run) => run.status === "queued");
          // Releasing an empty queue starts nothing; skip the command.
          if (queued.length === 0) continue;
          // A lazy (idle, unswitched) thread may have taken a held message during the cutover.
          // Move it and its queued turns to the native harness before the queue starts.
          for (const run of queued) {
            const mapped = planSelection(run.modelSelection);
            if (mapped._tag === "conflict")
              return yield* new CutoverError({ operation: "release-queued-unmappable" });
            if (mapped._tag === "mapped")
              yield* engine
                .dispatch({
                  type: "queued-run.rebind-selection",
                  commandId: command(item, `release-rebind:${run.id}`),
                  threadId,
                  runId: run.id,
                  expectedModelSelection: run.modelSelection,
                  modelSelection: mapped.next,
                })
                .pipe(Effect.mapError(fail("release-rebind")));
          }
          const own = planSelection(records.thread.modelSelection);
          if (own._tag === "mapped" && !records.runs.some(Threads.isActiveRun))
            yield* engine
              .dispatch({
                type: "provider.switch",
                commandId: command(item, `release-switch:${threadId}`),
                threadId,
                modelSelection: own.next,
                ...(records.thread.settledAt === null
                  ? { expectedModelSelection: records.thread.modelSelection }
                  : {}),
              })
              .pipe(Effect.mapError(fail("release-switch")));
          yield* engine
            .dispatch({
              type: "queue.cutover-release",
              threadId,
              commandId: command(item, `queue-release:${threadId}`),
            })
            .pipe(Effect.mapError(fail("release-queue")));
        }
        for (const entry of payload.boards) {
          const board = (yield* store.boards.pipe(Effect.mapError(fail("finalize-board")))).find(
            (row) => row.id === entry.id,
          );
          if (board?.pause === null) continue;
          if (board === undefined || !sameValue(board.pause, entry.pause))
            return yield* new CutoverError({ operation: "pause-changed" });
          yield* boards
            .pauseBoard(entry.id, null, { _tag: "owner" })
            .pipe(Effect.mapError(fail("unpause")));
        }
      }
    });
    const check = Effect.fn("CutoverActions.check")(function* (items: readonly CutoverItem[]) {
      const targets: ModelSelection[] = [];
      const visit = (value: unknown): void => {
        if (Array.isArray(value)) {
          for (const item of value) visit(item);
          return;
        }
        if (value === null || typeof value !== "object") return;
        if (
          "instanceId" in value &&
          "model" in value &&
          typeof value.instanceId === "string" &&
          typeof value.model === "string"
        ) {
          if (["claudeAgent", "codex", "codex-cu"].includes(value.instanceId))
            targets.push(value as ModelSelection);
          return;
        }
        for (const item of Object.values(value)) visit(item);
      };
      for (const item of items) visit(item.payload);
      const checks = yield* readiness.check(targets);
      const scriptChecks = [];
      for (const board of yield* boards.boards.pipe(Effect.mapError(fail("boards")))) {
        const refusals = yield* checkBoardScripts(
          yield* store.scripts(board.id).pipe(Effect.mapError(fail("board-scripts"))),
        ).pipe(Effect.provideService(FileSystem.FileSystem, fs));
        scriptChecks.push(
          ...refusals.map((row) => ({ id: row.ref, ready: false, reason: row.reason })),
        );
      }
      const input = yield* inputSource.read.pipe(Effect.result);
      return input._tag === "Failure"
        ? [...checks, ...scriptChecks, { id: "input", ready: false, reason: input.failure.message }]
        : [...checks, ...scriptChecks];
    });
    // An idle thread needs no switch now: once the cutover completes, its next turn (composer,
    // control API, board, schedule or a server wake) moves it through the selection migration.
    // Threads with a live run wait for it; queued work, owner questions and background work keep
    // the normal switch, which rebinds and defers them safely.
    const lazy = Effect.fn("CutoverActions.lazy")(function* (item: CutoverItem) {
      if (item.kind !== "thread" || item.wake) return "switch" as const;
      const records = yield* engine
        .getThreadRecords(ThreadId.make(item.ref), [
          "runs",
          "runtimeRequests",
          "providerThreads",
          "subagents",
        ])
        .pipe(Effect.mapError(fail("lazy-read")));
      if (records.thread.archivedAt !== null || records.thread.deletedAt !== null)
        return "lazy" as const;
      if (records.runs.some(Threads.isActiveRun)) return "busy" as const;
      if (
        records.runs.some((run) => run.status === "queued") ||
        records.runtimeRequests.some((request) => request.status === "pending") ||
        runningBackgroundWork(records).length > 0
      )
        return "switch" as const;
      return "lazy" as const;
    });
    return CutoverActions.of({ plan: plan(), apply, check, lazy });
  }),
);
