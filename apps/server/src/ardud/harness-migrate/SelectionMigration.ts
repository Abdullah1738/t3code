import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as BoardsDatabase from "../persistence/BoardsDatabase.ts";
import type {
  CommandId,
  KanbanBoard,
  KanbanCard,
  KanbanPool,
  KanbanThreadLink,
  ModelSelection,
  ProjectId,
  ScheduledTaskId,
  ServerSettings,
  ServerSettingsPatch,
  ThreadId,
} from "@t3tools/contracts";
import {
  CommandId as CommandIdSchema,
  KanbanBoardId as KanbanBoardIdSchema,
  ProjectId as ProjectIdSchema,
  RunId as RunIdSchema,
  ScheduledTaskId as ScheduledTaskIdSchema,
  ThreadId as ThreadIdSchema,
} from "@t3tools/contracts";

import * as KanbanService from "../kanban/engine/KanbanService.ts";
import * as KanbanStore from "../kanban/store/KanbanStore.ts";
import * as ServerSettingsService from "../../serverSettings.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ScheduledTaskService from "../../scheduledTasks/ScheduledTaskService.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import { planBoard, type BoardPlan, type BoardSnapshot } from "./boardPlan.ts";
import { parseProjectOverrideRef, planSettings, type SettingsPlan } from "./settingsPlan.ts";
import { planFallbacks, type FallbackPlan } from "./fallbackPlan.ts";
import { readBlockRetry, writeBlockRetry, type BlockRetry } from "../schedules/runFollow.ts";
import { planSelection, sameValue } from "./selectionPlan.ts";

/** The version stamped on every ledger row this migration writes. */
export const SELECTION_MIGRATION_VERSION = 1;

export type MigrationScope =
  | "settings"
  | "project"
  | "board"
  | "schedule"
  | "schedule-fallbacks"
  | "queued-run"
  | "thread";

type LedgerScope = MigrationScope | "thread-runtime";

const SCOPES: ReadonlyArray<MigrationScope> = [
  "settings",
  "project",
  "board",
  "schedule",
  "schedule-fallbacks",
  "queued-run",
  "thread",
];

/** One value the migration would change. `ref` names the owner's record, so a write can find it. */
export interface MigrationChange {
  readonly scope: MigrationScope;
  readonly ref: string;
  readonly before: unknown;
  readonly after: unknown;
}

export interface MigrationConflict {
  readonly scope: MigrationScope;
  readonly ref: string;
  readonly reason: string;
}

export interface MigrationCollision {
  readonly boardId: string;
  readonly newKey: string;
  readonly oldKeys: ReadonlyArray<string>;
}

/** What dryRun reports: counts per scope, every conflict and collision. Nothing is written. */
export interface SelectionMigrationReport {
  readonly version: number;
  readonly counts: Record<MigrationScope, number>;
  readonly conflicts: ReadonlyArray<MigrationConflict>;
  readonly collisions: ReadonlyArray<MigrationCollision>;
  readonly changes: ReadonlyArray<MigrationChange>;
}

export interface SelectionMigrationApplyResult {
  readonly applied: number;
  readonly skipped: number;
  readonly retired: ReadonlyArray<{ readonly scope: string; readonly ref: string; readonly reason: string }>;
  readonly report: SelectionMigrationReport;
}

export interface SelectionMigrationRollbackResult {
  readonly reverted: number;
  readonly skipped: ReadonlyArray<{ readonly ref: string; readonly reason: string }>;
  readonly retired: ReadonlyArray<{ readonly ref: string; readonly reason: string }>;
}

export class SelectionMigrationError extends Error {
  readonly _tag = "SelectionMigrationError";
}

export interface SelectionMigrationShape {
  /** Reads every stored future-work selection and reports what apply would change. Writes nothing. */
  readonly dryRun: Effect.Effect<SelectionMigrationReport, SelectionMigrationError>;
  /**
   * Writes the planned changes through each owner, with one ledger row per write. Refuses when the
   * dry run has conflicts or collisions, unless `ardudHarnessMigration.allowConflicts` is true. A second
   * run finds every value already migrated and writes nothing.
   */
  readonly apply: Effect.Effect<SelectionMigrationApplyResult, SelectionMigrationError>;
  /**
   * Reverses the applied rows of one version. A row is reverted only while its value still equals what
   * apply wrote; a value changed since is skipped and reported.
   */
  readonly rollback: (
    version: number,
  ) => Effect.Effect<SelectionMigrationRollbackResult, SelectionMigrationError>;
}

export class SelectionMigration extends Context.Service<
  SelectionMigration,
  SelectionMigrationShape
>()("t3/ardud/harness-migrate/SelectionMigration") {}

const LEDGER_DDL = `CREATE TABLE IF NOT EXISTS ardud_harness_selection_migration (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version INTEGER NOT NULL,
  scope TEXT NOT NULL,
  ref TEXT NOT NULL,
  before_json TEXT NOT NULL,
  after_json TEXT NOT NULL,
  applied_at TEXT,
  rolled_back_at TEXT
)`;

const LEDGER_INDEX = `CREATE INDEX IF NOT EXISTS ardud_harness_selection_migration_version
  ON ardud_harness_selection_migration (version, scope, ref)`;

const emptyCounts = (): Record<MigrationScope, number> =>
  Object.fromEntries(SCOPES.map((scope) => [scope, 0])) as Record<MigrationScope, number>;

const migrationError = (message: string, cause?: unknown) =>
  new SelectionMigrationError(cause === undefined ? message : `${message}: ${String(cause)}`);

/** Equality by the ledger's own encoding, so a value compares the same way it was stored. */
const sameJson = (left: unknown, right: unknown): boolean => {
  const encode = (value: unknown) => Schema.encodeSync(LedgerValueJson)(value);
  return encode(left) === encode(right);
};

/** Records are kept as JSON text; the codec both encodes and decodes, so a bad value cannot slip through. */
const LedgerValueJson = Schema.fromJsonString(Schema.Unknown);
const encodeLedgerValue = Schema.encodeEffect(LedgerValueJson);
const decodeLedgerValue = Schema.decodeUnknownEffect(LedgerValueJson);

/** Reads a top-level settings field or one per-project override. */
const readSettingsPath = (settingsValue: ServerSettings, ref: string): unknown => {
  const path = parseProjectOverrideRef(ref);
  if (path !== null) {
    const overrides: Record<string, Record<string, unknown> | undefined> =
      settingsValue.projectSettingsOverrides;
    return overrides[path.projectId]?.[path.field];
  }
  return (settingsValue as unknown as Record<string, unknown>)[ref];
};

const fallbackRef = (id: string, createdAt: string): string =>
  `v1:${encodeURIComponent(id)}:${encodeURIComponent(createdAt)}`;

const readFallbackRef = (ref: string): { id: string; createdAt?: string } => {
  if (!ref.startsWith("v1:")) return { id: ref };
  const [, id, createdAt] = ref.split(":");
  return { id: decodeURIComponent(id ?? ""), createdAt: decodeURIComponent(createdAt ?? "") };
};

/** The settings patch that puts one ref back to `value`, read from the current settings. */
const settingsPatchFor = (
  settingsValue: ServerSettings,
  ref: string,
  value: unknown,
): ServerSettingsPatch => {
  const path = parseProjectOverrideRef(ref);
  if (path !== null) {
    const { projectId, field } = path;
    const overrides: Record<string, Record<string, unknown> | undefined> =
      settingsValue.projectSettingsOverrides;
    const current = overrides[projectId] ?? {};
    return {
      projectSettingsOverrides: {
        ...settingsValue.projectSettingsOverrides,
        [projectId]: { ...current, [field]: value },
      },
    } as ServerSettingsPatch;
  }
  return { [ref]: value } as ServerSettingsPatch;
};

/** One ledger row as the rollback reads it. */
interface LedgerRow {
  readonly id: number;
  readonly scope: LedgerScope;
  readonly ref: string;
  readonly before_json: string;
  readonly after_json: string;
  readonly applied_at: string | null;
}

interface Plans {
  readonly settings: SettingsPlan;
  readonly projectDefaults: ReadonlyArray<{
    readonly projectId: ProjectId;
    readonly before: ModelSelection;
    readonly next: ModelSelection;
  }>;
  readonly boards: ReadonlyArray<{ readonly board: KanbanBoard; readonly pools: ReadonlyArray<KanbanPool>; readonly snapshot: BoardSnapshot; readonly plan: BoardPlan }>;
  readonly schedules: ReadonlyArray<{
    readonly id: ScheduledTaskId;
    readonly before: ModelSelection;
    readonly next: ModelSelection;
  }>;
  readonly fallbacks: ReadonlyArray<{
    readonly task: { readonly id: ScheduledTaskId; readonly createdAt: string };
    readonly stored: BlockRetry;
    readonly plan: FallbackPlan;
  }>;
  readonly queued: ReadonlyArray<{
    readonly threadId: ThreadId;
    readonly runId: typeof RunIdSchema.Type;
    readonly before: ModelSelection;
    readonly next: ModelSelection;
  }>;
  readonly threads: ReadonlyArray<{
    readonly threadId: ThreadId;
    readonly before: ModelSelection;
    readonly next: ModelSelection | null;
    readonly widenTo: "full-access" | null;
    readonly runtimeBefore: "approval-required" | "auto" | "auto-accept-edits" | "full-access";
    readonly interactionBefore: typeof import("@t3tools/contracts").ProviderInteractionMode.Type;
  }>;
  readonly conflicts: ReadonlyArray<MigrationConflict>;
  readonly collisions: ReadonlyArray<MigrationCollision>;
}

/**
 * The migration service. Every scope reads and writes through its owner: ServerSettingsService,
 * ProjectService, KanbanStore (one transaction per board), ScheduledTaskService (guarded per row) and
 * the orchestrator's own commands for queued runs and threads. The only SQL here is the ledger, which
 * has no other owner.
 */
export const make = Effect.gen(function* () {
  const sql = yield* BoardsDatabase.client;
  const settings = yield* ServerSettingsService.ServerSettingsService;
  const projects = yield* ProjectService.ProjectService;
  const kanban = yield* KanbanService.KanbanService;
  const store = yield* KanbanStore.KanbanStore;
  const scheduled = yield* ScheduledTaskService.ScheduledTaskService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const crypto = yield* Crypto.Crypto;
  const migrationLock = yield* Semaphore.make(1);

  /** A fresh command id per owner write, so each dispatch is its own command. */
  const newCommandId = Effect.fn("SelectionMigration.newCommandId")(function* (label: string) {
    const uuid = yield* crypto
      .randomUUIDv4()
      .pipe(Effect.mapError((cause) => migrationError("command id", cause)));
    return CommandIdSchema.make(`harness-migrate:${label}:${uuid}`);
  });

  yield* BoardsDatabase.initialize(Effect.gen(function* () {
    yield* sql.unsafe(LEDGER_DDL).pipe(Effect.mapError((cause) => migrationError("create ledger", cause)));
    yield* sql.unsafe(LEDGER_INDEX).pipe(Effect.mapError((cause) => migrationError("index ledger", cause)));
  }));

  const readSettings: Effect.Effect<ServerSettings, SelectionMigrationError> = settings.getSettings.pipe(
    Effect.mapError((cause) => migrationError("read settings", cause)),
  );

  const readPlans = Effect.fn("SelectionMigration.readPlans")(function* (): Effect.fn.Return<
    Plans,
    SelectionMigrationError
  > {
    const current = yield* readSettings;
    const settingsPlan = planSettings(current);
    const conflicts: Array<MigrationConflict> = settingsPlan.conflicts.map((conflict) => ({
      scope: "settings",
      ref: conflict.field,
      reason: conflict.reason,
    }));
    const collisions: Array<MigrationCollision> = [];

    // Projects: each project default is a selection the project owner stores.
    const snapshot = yield* projects.snapshot.pipe(
      Effect.mapError((cause) => migrationError("read projects", cause)),
    );
    const projectDefaults: Array<Plans["projectDefaults"][number]> = [];
    for (const project of snapshot.projects) {
      const selection = project.defaultModelSelection;
      if (selection === null || selection === undefined) continue;
      const plan = planSelection(selection);
      if (plan._tag === "conflict") {
        conflicts.push({ scope: "project", ref: project.id, reason: plan.reason });
      } else if (plan._tag === "mapped") {
        projectDefaults.push({ projectId: project.id, before: selection, next: plan.next });
      }
    }

    // Boards: one snapshot each, planned as a whole.
    const boardList = yield* kanban.boards.pipe(
      Effect.mapError((cause) => migrationError("read boards", cause)),
    );
    const boards: Array<Plans["boards"][number]> = [];
    for (const board of boardList) {
      const pools = yield* store
        .pools(board.id)
        .pipe(Effect.mapError((cause) => migrationError("read pools", cause)));
      const cards = yield* store
        .cards(board.id)
        .pipe(Effect.mapError((cause) => migrationError("read cards", cause)));
      const openLinks = yield* store
        .threadLinks({ boardId: board.id, open: true })
        .pipe(Effect.mapError((cause) => migrationError("read thread links", cause)));
      const boardSnapshot = { board, pools, cards, openLinks } satisfies BoardSnapshot;
      const plan = planBoard(boardSnapshot);
      for (const conflict of plan.conflicts) {
        conflicts.push({ scope: "board", ref: `${board.id}:${conflict.field}`, reason: conflict.reason });
      }
      for (const collision of plan.collisions) {
        collisions.push({ boardId: board.id, newKey: collision.newKey, oldKeys: collision.oldKeys });
      }
      boards.push({ board, pools, snapshot: boardSnapshot, plan });
    }

    // Schedules: every stored task, disabled ones included.
    const listed = yield* scheduled.list().pipe(
      Effect.mapError((cause) => migrationError("read schedules", cause)),
    );
    const schedules: Array<Plans["schedules"][number]> = [];
    const fallbacks: Array<Plans["fallbacks"][number]> = [];
    for (const task of listed.tasks) {
      const plan = planSelection(task.modelSelection);
      if (plan._tag === "conflict") {
        conflicts.push({ scope: "schedule", ref: task.id, reason: plan.reason });
      } else if (plan._tag === "mapped") {
        schedules.push({ id: task.id, before: task.modelSelection, next: plan.next });
      }

      // The provider-block fallbacks: read through the table's own reader, planned, and written back
      // through its own writer, so the task's creation-time guard and limits stay as they are.
      const stored = yield* readBlockRetry(sql, task).pipe(
        Effect.mapError((cause) => migrationError(`read fallbacks ${task.id}`, cause)),
      );
      if (stored === null || stored.fallbacks.length === 0) continue;
      const fallbackPlan = planFallbacks({ taskId: task.id, fallbacks: stored.fallbacks });
      for (const conflict of fallbackPlan.conflicts) {
        conflicts.push({
          scope: "schedule",
          ref: `${task.id}:fallbacks[${conflict.index}]`,
          reason: conflict.reason,
        });
      }
      if (fallbackPlan.changed) {
        fallbacks.push({ task, stored, plan: fallbackPlan });
      }
    }

    // Threads: live, non-dormant threads only. Archived or settled threads wait for E3's resolver.
    const threadPlans: Array<Plans["threads"][number]> = [];
    const threadIds: Array<ThreadId> = [];
    for (const project of snapshot.projects) {
      const listedThreads = yield* threads
        .listProjectThreads({ projectId: project.id, includeSubagents: true })
        .pipe(Effect.mapError((cause) => migrationError("read threads", cause)));
      for (const thread of listedThreads) {
        if (thread.archivedAt !== null || thread.settledAt !== null) continue;
        const plan = planSelection(thread.modelSelection);
        if (plan._tag === "conflict") {
          conflicts.push({ scope: "thread", ref: thread.id, reason: plan.reason });
          continue;
        }
        const next = plan._tag === "mapped" ? plan.next : null;
        // DECISIONS 3: migrated threads run full access, except plan mode (validation-core 4.1).
        const widenTo =
          next !== null &&
          (thread.runtimeMode === "approval-required" || thread.runtimeMode === "auto-accept-edits") &&
          thread.interactionMode !== "plan"
            ? ("full-access" as const)
            : null;
        if (next === null && widenTo === null) continue;
        threadPlans.push({ threadId: thread.id, before: thread.modelSelection, next, widenTo, runtimeBefore: thread.runtimeMode, interactionBefore: thread.interactionMode });
        threadIds.push(thread.id);
      }
    }

    // Queued runs: every queued run, held or not. A rebind never reaches a run that already started.
    const queued: Array<Plans["queued"][number]> = [];
    const queuedThreadIds = new Set<ThreadId>(threadIds);
    for (const project of snapshot.projects) {
      const listedThreads = yield* threads
        .listProjectThreads({ projectId: project.id, includeSubagents: true })
        .pipe(Effect.mapError((cause) => migrationError("read queued threads", cause)));
      for (const thread of listedThreads) queuedThreadIds.add(thread.id);
    }
    for (const threadId of queuedThreadIds) {
      const projection = yield* orchestrator.getThreadProjection(threadId).pipe(
        Effect.mapError((cause) => migrationError("read queued runs", cause)),
      );
      for (const run of projection.runs) {
        if (run.status !== "queued") continue;
        const plan = planSelection(run.modelSelection);
        if (plan._tag === "conflict") {
          conflicts.push({ scope: "queued-run", ref: run.id, reason: plan.reason });
        } else if (plan._tag === "mapped") {
          queued.push({ threadId, runId: run.id, before: run.modelSelection, next: plan.next });
        }
      }
    }

    return {
      settings: settingsPlan,
      projectDefaults,
      boards,
      schedules,
      fallbacks,
      queued,
      threads: threadPlans,
      conflicts,
      collisions,
    } satisfies Plans;
  });

  const reportOf = (plans: Plans): SelectionMigrationReport => {
    const counts = emptyCounts();
    const changes: Array<MigrationChange> = [];
    for (const change of plans.settings.changes) {
      counts.settings += 1;
      changes.push({ scope: "settings", ref: change.field, before: change.before, after: change.after });
    }
    for (const project of plans.projectDefaults) {
      counts.project += 1;
      changes.push({ scope: "project", ref: project.projectId, before: project.before, after: project.next });
    }
    for (const { board, plan } of plans.boards) {
      for (const change of plan.changes) {
        counts.board += 1;
        changes.push({ scope: "board", ref: change.ref, before: change.before, after: change.after });
      }
      void board;
    }
    for (const plan of plans.schedules) {
      counts.schedule += 1;
      changes.push({ scope: "schedule", ref: plan.id, before: plan.before, after: plan.next });
    }
    for (const entry of plans.fallbacks) {
      counts["schedule-fallbacks"] += 1;
      changes.push({
        scope: "schedule-fallbacks",
        ref: entry.task.id,
        before: entry.plan.before,
        after: entry.plan.after,
      });
    }
    for (const plan of plans.queued) {
      counts["queued-run"] += 1;
      changes.push({ scope: "queued-run", ref: plan.runId, before: plan.before, after: plan.next });
    }
    for (const plan of plans.threads) {
      counts.thread += 1;
      changes.push({ scope: "thread", ref: plan.threadId, before: plan.before, after: plan.next ?? plan.before });
    }
    return {
      version: SELECTION_MIGRATION_VERSION,
      counts,
      conflicts: plans.conflicts,
      collisions: plans.collisions,
      changes,
    };
  };

  const dryRun: SelectionMigrationShape["dryRun"] = readPlans().pipe(Effect.map(reportOf));

  /** Writes one board through the store's single transaction. */
  const writeBoard = Effect.fn("SelectionMigration.writeBoard")(function* (
    entry: Plans["boards"][number],
  ) {
    const next = entry.plan.next;
    if (next === null || !entry.plan.changed) return 0;
    const oldPoolKeys = entry.pools.map((pool) => pool.key);
    yield* kanban.withSelectionMigrationLock(sql.withTransaction(Effect.gen(function* () {
      const currentBoard = (yield* store.boards).find((board) => board.id === entry.board.id);
      const current = {
        board: currentBoard,
        pools: yield* store.pools(entry.board.id),
        cards: yield* store.cards(entry.board.id),
        openLinks: yield* store.threadLinks({ boardId: entry.board.id, open: true }),
      };
      if (!sameValue(current, entry.snapshot)) {
        return yield* Effect.fail(migrationError(`board ${entry.board.id} changed after planning`));
      }
      yield* store.migrateBoardSelections({
        board: next.board,
        pools: next.pools,
        oldPoolKeys,
        cards: next.cards,
        threadLinks: next.openLinks,
      });
      const now = DateTime.formatIso(yield* DateTime.now);
      for (const change of entry.plan.changes) {
        const before = yield* encodeLedgerValue(change.before);
        const after = yield* encodeLedgerValue(change.after);
        yield* sql`INSERT INTO ardud_harness_selection_migration
          (version, scope, ref, before_json, after_json, applied_at, rolled_back_at)
          VALUES (${SELECTION_MIGRATION_VERSION}, ${"board"}, ${change.ref}, ${before}, ${after}, ${now}, NULL)`;
      }
    }))).pipe(Effect.mapError((cause) => migrationError(`write board ${entry.board.id}`, cause)));
    return entry.plan.changes.length;
  });

  // Persist the intended transition before calling an owner whose data and ledger do not share a
  // transaction. A pending intent is checked against the owner on retry and rollback.
  const beginIntent = Effect.fn("SelectionMigration.beginIntent")(function* (
    scope: LedgerScope, ref: string, before: unknown, after: unknown,
  ) {
    const beforeJson = yield* encodeLedgerValue(before).pipe(Effect.mapError((cause) => migrationError("encode intent", cause)));
    const afterJson = yield* encodeLedgerValue(after).pipe(Effect.mapError((cause) => migrationError("encode intent", cause)));
    const existing = yield* sql<{ id: number; before_json: string; after_json: string; applied_at: string | null; rolled_back_at: string | null }>`
      SELECT id, before_json, after_json, applied_at, rolled_back_at FROM ardud_harness_selection_migration
      WHERE version = ${SELECTION_MIGRATION_VERSION} AND scope = ${scope} AND ref = ${ref}
      ORDER BY id DESC LIMIT 1`
      .pipe(Effect.mapError((cause) => migrationError("read intent", cause)));
    if (existing[0] !== undefined && existing[0].rolled_back_at === null) {
      if (existing[0].applied_at === null && existing[0].before_json === beforeJson && existing[0].after_json === afterJson) return existing[0].id;
      if (existing[0].applied_at === null) return yield* Effect.fail(migrationError(`unreverted intent for ${scope}:${ref}`));
    }
    const rows = yield* sql<{ id: number }>`INSERT INTO ardud_harness_selection_migration
      (version, scope, ref, before_json, after_json, applied_at, rolled_back_at)
      VALUES (${SELECTION_MIGRATION_VERSION}, ${scope}, ${ref}, ${beforeJson}, ${afterJson}, NULL, NULL)
      RETURNING id`.pipe(Effect.mapError((cause) => migrationError("write intent", cause)));
    if (rows[0] === undefined) return yield* Effect.fail(migrationError("intent insert returned no id"));
    return rows[0].id;
  });
  const finishIntent = Effect.fn("SelectionMigration.finishIntent")(function* (id: number) {
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* sql`UPDATE ardud_harness_selection_migration SET applied_at = ${now} WHERE id = ${id}`
      .pipe(Effect.mapError((cause) => migrationError("confirm intent", cause)));
  });
  const retireIntent = Effect.fn("SelectionMigration.retireIntent")(function* (id: number) {
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* sql`UPDATE ardud_harness_selection_migration SET rolled_back_at = ${now} WHERE id = ${id} AND applied_at IS NULL`
      .pipe(Effect.mapError((cause) => migrationError("retire intent", cause)));
  });

  const apply: SelectionMigrationShape["apply"] = Effect.gen(function* () {
    // Confirm a completed write; retire an ineligible owner's remaining intent.
    // Divergence on a still-eligible owner remains a conflict.
    const pending = yield* sql<LedgerRow>`SELECT id, scope, ref, before_json, after_json, applied_at
      FROM ardud_harness_selection_migration WHERE version = ${SELECTION_MIGRATION_VERSION}
      AND applied_at IS NULL AND rolled_back_at IS NULL ORDER BY id`
      .pipe(Effect.mapError((cause) => migrationError("read pending intents", cause)));
    const retired: Array<{ scope: string; ref: string; reason: string }> = [];
    for (const row of pending) {
      const before = yield* decodeLedgerValue(row.before_json).pipe(Effect.mapError((cause) => migrationError("decode intent", cause)));
      const after = yield* decodeLedgerValue(row.after_json).pipe(Effect.mapError((cause) => migrationError("decode intent", cause)));
      const current = yield* currentValue(row.scope, row.ref, true);
      const ownerIneligible = (row.scope === "queued-run" || row.scope === "thread" || row.scope === "thread-runtime") &&
        (yield* currentValue(row.scope, row.ref)) === undefined;
      if (ownerIneligible) {
        if (sameValue(current, after)) yield* finishIntent(row.id);
        else {
          yield* retireIntent(row.id);
          retired.push({ scope: row.scope, ref: row.ref, reason: "owner is no longer eligible" });
        }
        continue;
      }
      if (sameValue(current, after)) yield* finishIntent(row.id);
      else if (!sameValue(current, before)) {
        return yield* Effect.fail(migrationError(`pending intent ${row.scope}:${row.ref} diverged`));
      } else if (row.scope === "thread-runtime") {
        const related = yield* sql<{ after_json: string }>`SELECT after_json FROM ardud_harness_selection_migration
          WHERE version = ${SELECTION_MIGRATION_VERSION} AND scope = ${"thread"} AND ref = ${row.ref}
          AND rolled_back_at IS NULL ORDER BY id DESC LIMIT 1`
          .pipe(Effect.mapError((cause) => migrationError("read thread intent", cause)));
        if (related[0] !== undefined) {
          const selection = yield* decodeLedgerValue(related[0].after_json).pipe(Effect.mapError((cause) => migrationError("decode thread intent", cause)));
          const projection = yield* orchestrator.getThreadProjection(ThreadIdSchema.make(row.ref))
            .pipe(Effect.mapError((cause) => migrationError("read thread intent owner", cause)));
          if (projection.thread.archivedAt !== null || projection.thread.deletedAt !== null || projection.thread.settledAt !== null) {
            yield* retireIntent(row.id);
            retired.push({ scope: row.scope, ref: row.ref, reason: "thread is dormant" });
            continue;
          }
          if (sameValue(projection.thread.modelSelection, selection)) {
            if (projection.thread.interactionMode === "plan") return yield* Effect.fail(migrationError(`pending runtime intent ${row.ref} is now in plan mode`));
            yield* orchestrator.dispatch({
              type: "thread.runtime-mode.set", commandId: yield* newCommandId(`recover-runtime:${row.ref}`),
              threadId: ThreadIdSchema.make(row.ref),
              runtimeMode: after as "full-access",
              expectedRuntimeMode: before as "approval-required" | "auto" | "auto-accept-edits" | "full-access",
              expectedInteractionMode: projection.thread.interactionMode,
              expectedModelSelection: selection as ModelSelection,
            }).pipe(Effect.mapError((cause) => migrationError("recover runtime intent", cause)));
            yield* finishIntent(row.id);
          }
        }
      }
    }
    const plans = yield* readPlans();
    const current = yield* readSettings;
    const allowConflicts = current.ardudHarnessMigration?.allowConflicts === true;
    if (!allowConflicts && (plans.conflicts.length > 0 || plans.collisions.length > 0)) {
      return yield* Effect.fail(
        new SelectionMigrationError(
          `apply refused: ${plans.conflicts.length} conflict(s), ${plans.collisions.length} pool collision(s); set ardudHarnessMigration.allowConflicts to proceed`,
        ),
      );
    }
    const report = reportOf(plans);
    const counter = { applied: 0 };
    // Settings: one patch, one ledger row per field it changes.
    if (plans.settings.patch !== null) {
      const intents = yield* Effect.forEach(plans.settings.changes, (change) =>
        beginIntent("settings", change.field, change.before, change.after));
      const wrote = yield* settings.updateSettingsIf((current) => {
        const fresh = planSettings(current);
        return sameValue(fresh.changes, plans.settings.changes) ? fresh.patch : null;
      }).pipe(
        Effect.mapError((cause) => migrationError("write settings", cause)),
      );
      if (!wrote) return yield* Effect.fail(migrationError("settings changed after planning"));
      for (const id of intents) yield* finishIntent(id);
      counter.applied += intents.length;
    }
    // Projects: the project owner's update, one command per project.
    for (const project of plans.projectDefaults) {
      const intent = yield* beginIntent("project", project.projectId, project.before, project.next);
      const projectCommandId = yield* newCommandId(`project:${project.projectId}`);
      yield* projects
        .update({
          projectId: project.projectId,
          commandId: projectCommandId,
          defaultModelSelection: project.next,
          expectedDefaultModelSelection: project.before,
        })
        .pipe(Effect.mapError((cause) => migrationError(`write project ${project.projectId}`, cause)));
      yield* finishIntent(intent);
      counter.applied++;
    }
    // Boards: one transaction each, and a failure leaves that board untouched.
    for (const entry of plans.boards) {
      const changes = yield* writeBoard(entry);
      if (changes > 0) {
        counter.applied += changes;
      }
    }
    // Schedules: guarded per row, so a schedule edited since the dry run is skipped, not overwritten.
    for (const plan of plans.schedules) {
      const intent = yield* beginIntent("schedule", plan.id, plan.before, plan.next);
      const wrote = yield* scheduled
        .migrateModelSelection({ id: plan.id, expected: plan.before, next: plan.next })
        .pipe(Effect.mapError((cause) => migrationError(`write schedule ${plan.id}`, cause)));
      if (!wrote) return yield* Effect.fail(migrationError(`schedule ${plan.id} changed after planning`));
      yield* finishIntent(intent);
      counter.applied++;
    }
    // Provider-block fallbacks: written through the table's own writer, keeping its creation-time guard
    // and limits. Each list is re-read first, and only written while it still equals what was planned.
    for (const entry of plans.fallbacks) {
      const wrote = yield* sql.withTransaction(Effect.gen(function* () {
        const current = yield* readBlockRetry(sql, entry.task);
        if (current === null || !sameValue(current.fallbacks, entry.plan.before)) return false;
        const ref = fallbackRef(entry.task.id, entry.task.createdAt);
        const intent = yield* beginIntent("schedule-fallbacks", ref, entry.plan.before, entry.plan.after);
        yield* writeBlockRetry(sql, entry.task, { ...current, fallbacks: entry.plan.after });
        yield* finishIntent(intent);
        return true;
      })).pipe(Effect.mapError((cause) => migrationError(`write fallbacks ${entry.task.id}`, cause)));
      if (!wrote) return yield* Effect.fail(migrationError(`fallbacks ${entry.task.id} changed after planning`));
      counter.applied++;
    }
    // Queued runs: the orchestrator's rebind, which keeps order, attachments and the hold.
    for (const plan of plans.queued) {
      const ref = `${encodeURIComponent(plan.threadId)}:${encodeURIComponent(plan.runId)}`;
      const intent = yield* beginIntent("queued-run", ref, plan.before, plan.next);
      const queuedCommandId = yield* newCommandId(`queued:${plan.runId}`);
      yield* orchestrator
        .dispatch({
          type: "queued-run.rebind-selection",
          commandId: queuedCommandId,
          threadId: plan.threadId,
          runId: plan.runId,
          modelSelection: plan.next,
          expectedModelSelection: plan.before,
        })
        .pipe(Effect.mapError((cause) => migrationError(`write queued run ${plan.runId}`, cause)));
      yield* finishIntent(intent);
      counter.applied++;
    }
    // Threads: the live model switch and the full-access widening, through the thread owner.
    for (const plan of plans.threads) {
      // Both intents must exist before either owner write: after a crash the mapped
      // selection alone no longer tells the planner that runtime widening was due.
      const selectionIntent = plan.next === null ? null :
        yield* beginIntent("thread", plan.threadId, plan.before, plan.next);
      const runtimeIntent = plan.widenTo === null ? null :
        yield* beginIntent("thread-runtime", plan.threadId, plan.runtimeBefore, plan.widenTo);
      if (plan.next !== null) {
        const type =
          plan.next.instanceId === plan.before.instanceId
            ? ("thread.model-selection.set" as const)
            : ("provider.switch" as const);
        const threadCommandId = yield* newCommandId(`thread:${plan.threadId}`);
        yield* orchestrator
          .dispatch({
            type,
            commandId: threadCommandId,
            threadId: plan.threadId,
            modelSelection: plan.next,
            expectedModelSelection: plan.before,
          })
          .pipe(Effect.mapError((cause) => migrationError(`write thread ${plan.threadId}`, cause)));
        yield* finishIntent(selectionIntent!);
      }
      if (plan.widenTo !== null) {
        const runtimeCommandId = yield* newCommandId(`runtime:${plan.threadId}`);
        yield* orchestrator
          .dispatch({
            type: "thread.runtime-mode.set",
            commandId: runtimeCommandId,
            threadId: plan.threadId,
            runtimeMode: plan.widenTo,
            expectedRuntimeMode: plan.runtimeBefore,
            expectedInteractionMode: plan.interactionBefore,
            expectedModelSelection: plan.next ?? plan.before,
          })
          .pipe(Effect.mapError((cause) => migrationError(`widen thread ${plan.threadId}`, cause)));
        yield* finishIntent(runtimeIntent!);
      }
      counter.applied++;
    }
    return {
      applied: counter.applied,
      skipped: report.changes.length - counter.applied,
      retired,
      report,
    };
  });

  /**
   * Puts one ledger row's `before` back through its owner, but only while the owner still holds the
   * `after` value apply wrote. Returns why it was skipped, or null when it was reverted.
   */
  const restoreRow = Effect.fn("SelectionMigration.restoreRow")(function* (
    row: LedgerRow,
    retired: Array<{ readonly ref: string; readonly reason: string }>,
  ) {
    const before = yield* decodeLedgerValue(row.before_json).pipe(
      Effect.mapError((cause) => migrationError("decode ledger", cause)),
    );
    const after = yield* decodeLedgerValue(row.after_json).pipe(
      Effect.mapError((cause) => migrationError("decode ledger", cause)),
    );
    const current = yield* currentValue(row.scope, row.ref);
    if (row.applied_at === null && current === undefined && (row.scope === "queued-run" || row.scope === "thread" || row.scope === "thread-runtime")) {
      yield* retireIntent(row.id);
      retired.push({ ref: row.ref, reason: "owner is no longer eligible" });
      return "owner is no longer eligible for rollback";
    }
    if (current === undefined) return "owner has no record for this row";
    // An unfinished apply intent that never reached the owner is not an applied row.
    if (row.applied_at === null && sameValue(current, before)) {
      retired.push({ ref: row.ref, reason: "intent was not applied" });
      return null;
    }
    if (!sameJson(current, after)) return "value changed after apply";
    // A pending runtime intent is only ours if the corresponding selection switch
    // committed; the same permission value alone could have been set by a user.
    if (row.scope === "thread-runtime" && row.applied_at === null) {
      const selectionRows = yield* sql<{ after_json: string }>`SELECT after_json FROM ardud_harness_selection_migration
        WHERE version = ${SELECTION_MIGRATION_VERSION} AND scope = ${"thread"} AND ref = ${row.ref}
        AND rolled_back_at IS NULL ORDER BY id DESC LIMIT 1`
        .pipe(Effect.mapError((cause) => migrationError("read runtime's selection intent", cause)));
      const selection = selectionRows[0] === undefined ? undefined : yield* decodeLedgerValue(selectionRows[0].after_json)
        .pipe(Effect.mapError((cause) => migrationError("decode runtime's selection intent", cause)));
      if (selection === undefined || !sameValue(yield* currentValue("thread", row.ref), selection)) {
        return "thread selection changed before runtime intent was confirmed";
      }
    }
    return yield* writeValue(row.scope, row.ref, before, after);
  });

  const readOwnerProjection = (threadId: ThreadId) => orchestrator.getThreadProjection(threadId).pipe(
    Effect.map((projection) => projection ?? null),
    Effect.catch((error) => Schema.is(ProjectionStore.ProjectionStoreThreadNotFoundError)(error.cause)
      ? Effect.succeed(null)
      : Effect.fail(migrationError("read thread", error))),
  );

  /**
   * The owner's current value for one ledger row. `undefined` means the record is gone. Board and
   * card rows are not read here: a board is restored as a whole, by `restoreBoard`.
   */
  const currentValue = (
    scope: LedgerScope,
    ref: string,
    includeDormant = false,
  ): Effect.Effect<unknown, SelectionMigrationError> =>
    Effect.gen(function* () {
      switch (scope) {
        case "settings": {
          const current = yield* readSettings;
          return readSettingsPath(current, ref);
        }
        case "project": {
          const project = yield* projects
            .getById(ProjectIdSchema.make(ref))
            .pipe(Effect.mapError((cause) => migrationError("read project", cause)));
          return project._tag === "Some" ? project.value.defaultModelSelection : undefined;
        }
        case "schedule": {
          const listed = yield* scheduled
            .list()
            .pipe(Effect.mapError((cause) => migrationError("read schedule", cause)));
          return listed.tasks.find((task) => task.id === ref)?.modelSelection;
        }
        case "schedule-fallbacks": {
          const listed = yield* scheduled.list().pipe(Effect.mapError((cause) => migrationError("read schedule", cause)));
          const { id, createdAt } = readFallbackRef(ref);
          const task = listed.tasks.find((item) => item.id === id && (createdAt === undefined || item.createdAt === createdAt));
          if (task === undefined) return undefined;
          return (yield* readBlockRetry(sql, task).pipe(Effect.mapError((cause) => migrationError("read fallbacks", cause))))?.fallbacks;
        }
        case "queued-run": {
          const [encodedThread, encodedRun] = ref.split(":");
          if (!encodedThread || !encodedRun) return undefined;
          const projection = yield* readOwnerProjection(ThreadIdSchema.make(decodeURIComponent(encodedThread)));
          if (projection === null) return undefined;
          const run = projection.runs.find((item) => item.id === decodeURIComponent(encodedRun));
          const liveThread = projection.thread.archivedAt === null && projection.thread.deletedAt === null && projection.thread.settledAt === null;
          return run !== undefined && (includeDormant || (liveThread && run.status === "queued")) ? run.modelSelection : undefined;
        }
        case "thread":
        case "thread-runtime": {
          const projection = yield* readOwnerProjection(ThreadIdSchema.make(ref));
          if (projection === null) return undefined;
          if (!includeDormant && (projection.thread.archivedAt !== null || projection.thread.deletedAt !== null || projection.thread.settledAt !== null)) return undefined;
          return scope === "thread" ? projection.thread.modelSelection : projection.thread.runtimeMode;
        }
        case "board":
          return undefined;
      }
    });

  /** Puts one ledger row back through its owner, or returns the reason it was not restored. */
  const writeValue = (
    scope: LedgerScope,
    ref: string,
    before: unknown,
    after: unknown,
  ): Effect.Effect<string | null, SelectionMigrationError> =>
    Effect.gen(function* () {
      switch (scope) {
        case "settings": {
          const wrote = yield* settings
            .updateSettingsIf((current) => sameValue(readSettingsPath(current, ref), after)
              ? settingsPatchFor(current, ref, before)
              : null)
            .pipe(Effect.mapError((cause) => migrationError("restore settings", cause)));
          return wrote ? null : "settings changed after apply";
        }
        case "project": {
          const commandId = yield* newCommandId(`rollback-project:${ref}`);
          yield* projects
            .update({
              projectId: ProjectIdSchema.make(ref),
              commandId,
              defaultModelSelection: before as ModelSelection,
              expectedDefaultModelSelection: after as ModelSelection,
            })
            .pipe(Effect.mapError((cause) => migrationError("restore project", cause)));
          return null;
        }
        case "schedule": {
          const wrote = yield* scheduled
            .migrateModelSelection({
              id: ScheduledTaskIdSchema.make(ref),
              expected: after as ModelSelection,
              next: before as ModelSelection,
            })
            .pipe(Effect.mapError((cause) => migrationError("restore schedule", cause)));
          return wrote ? null : "schedule changed after apply";
        }
        case "schedule-fallbacks": {
          const listed = yield* scheduled.list().pipe(Effect.mapError((cause) => migrationError("read schedule", cause)));
          const { id, createdAt } = readFallbackRef(ref);
          const task = listed.tasks.find((item) => item.id === id && (createdAt === undefined || item.createdAt === createdAt));
          if (task === undefined) return "schedule is gone";
          return yield* sql.withTransaction(Effect.gen(function* () {
            const value = yield* readBlockRetry(sql, task);
            if (value === null || !sameValue(value.fallbacks, after)) return "fallbacks changed after apply";
            yield* writeBlockRetry(sql, task, { ...value, fallbacks: before as ReadonlyArray<ModelSelection> });
            return null;
          })).pipe(Effect.mapError((cause) => migrationError("restore fallbacks", cause)));
        }
        case "queued-run": {
          const [encodedThread, encodedRun] = ref.split(":");
          if (!encodedThread || !encodedRun) return "queued run ref is missing its thread";
          yield* orchestrator.dispatch({ type: "queued-run.rebind-selection", commandId: yield* newCommandId(`rollback-queued:${ref}`), threadId: ThreadIdSchema.make(decodeURIComponent(encodedThread)), runId: RunIdSchema.make(decodeURIComponent(encodedRun)), modelSelection: before as ModelSelection, expectedModelSelection: after as ModelSelection })
            .pipe(Effect.mapError((cause) => migrationError("restore queued run", cause)));
          return null;
        }
        case "thread": {
          const from = after as ModelSelection;
          const to = before as ModelSelection;
          yield* orchestrator.dispatch({ type: from.instanceId === to.instanceId ? "thread.model-selection.set" : "provider.switch", commandId: yield* newCommandId(`rollback-thread:${ref}`), threadId: ThreadIdSchema.make(ref), modelSelection: to, expectedModelSelection: from })
            .pipe(Effect.mapError((cause) => migrationError("restore thread", cause)));
          return null;
        }
        case "thread-runtime": {
          const related = yield* sql<{ after_json: string }>`SELECT after_json FROM ardud_harness_selection_migration
            WHERE version = ${SELECTION_MIGRATION_VERSION} AND scope = ${"thread"} AND ref = ${ref}
            AND rolled_back_at IS NULL ORDER BY id DESC LIMIT 1`
            .pipe(Effect.mapError((cause) => migrationError("read runtime selection", cause)));
          if (related[0] === undefined) return "runtime selection intent is missing";
          const expectedModelSelection = yield* decodeLedgerValue(related[0].after_json)
            .pipe(Effect.mapError((cause) => migrationError("decode runtime selection", cause)));
          const current = yield* currentValue("thread", ref);
          if (!sameValue(current, expectedModelSelection)) return "thread selection changed after apply";
          yield* orchestrator.dispatch({ type: "thread.runtime-mode.set", commandId: yield* newCommandId(`rollback-runtime:${ref}`), threadId: ThreadIdSchema.make(ref), runtimeMode: before as "approval-required" | "auto" | "auto-accept-edits" | "full-access", expectedRuntimeMode: after as "approval-required" | "auto" | "auto-accept-edits" | "full-access", expectedModelSelection: expectedModelSelection as ModelSelection })
            .pipe(Effect.mapError((cause) => migrationError("restore runtime mode", cause)));
          return null;
        }
        case "board":
          return "board rows restore together";
      }
    });

  /** Board ids this migration wrote, read from the ledger's board rows for one version. */
  /** The record id in a board-scoped ref: the segment after the board, or the whole id for a board. */
  const refIdOf = (ref: string): string => {
    const match = /^(board|card|thread|pool):(.+)$/.exec(ref);
    const rest = match?.[2] ?? ref;
    if (match?.[1] === "board") return rest;
    const at = rest.indexOf(":");
    return at === -1 ? rest : rest.slice(at + 1);
  };

  const boardIdOf = (ref: string): string | null => {
    // board:<id> | card:<boardId>:<cardId> | thread:<boardId>:<threadId> | pool:<boardId>:<key>
    // Board ids are `board-<slug>` and never contain a colon, so the first segment is the board.
    const match = /^(board|card|thread|pool):(.+)$/.exec(ref);
    if (match === null) return null;
    const kind = match[1];
    const rest = match[2] ?? "";
    if (kind === "board") return rest;
    return rest.split(":")[0] ?? null;
  };

  /**
   * Restores one board from its ledger rows, all or nothing. Every row must still hold the value
   * apply wrote; if any has changed, the board is left as it is and the reason is returned.
   */
  const restoreBoard = Effect.fn("SelectionMigration.restoreBoard")(function* (
    boardId: string,
    rows: ReadonlyArray<LedgerRow>,
  ) {
    const boardRows = rows.filter((row) => row.scope === "board");

    // Read the board's current state and check every row against what apply wrote.
    const current = {
      board: (yield* store.boards.pipe(
        Effect.mapError((cause) => migrationError("read board", cause)),
      )).find((board) => board.id === boardId),
      pools: yield* store
        .pools(KanbanBoardIdSchema.make(boardId))
        .pipe(Effect.mapError((cause) => migrationError("read pools", cause))),
      cards: yield* store
        .cards(KanbanBoardIdSchema.make(boardId))
        .pipe(Effect.mapError((cause) => migrationError("read cards", cause))),
      links: yield* store
        .threadLinks({ boardId: KanbanBoardIdSchema.make(boardId), open: true })
        .pipe(Effect.mapError((cause) => migrationError("read thread links", cause))),
    };
    if (current.board === undefined) return "board is gone";

    const restored = {
      board: current.board,
      pools: new Map<string, KanbanPool>(),
      cards: new Map<string, KanbanCard>(),
      links: new Map<string, KanbanThreadLink>(),
      oldPoolKeys: [] as Array<string>,
    };
    for (const row of boardRows) {
      const before = yield* decodeLedgerValue(row.before_json).pipe(
        Effect.mapError((cause) => migrationError("decode board ledger", cause)),
      );
      const after = yield* decodeLedgerValue(row.after_json).pipe(
        Effect.mapError((cause) => migrationError("decode board ledger", cause)),
      );
      if (row.ref === `board:${boardId}`) {
        if (!sameJson(current.board, after)) return "board changed after apply";
        restored.board = before as KanbanBoard;
      }
    }
    for (const row of rows) {
      if (row.scope !== "board" || row.ref === `board:${boardId}`) continue;
      const before = yield* decodeLedgerValue(row.before_json).pipe(
        Effect.mapError((cause) => migrationError("decode board ledger", cause)),
      );
      const after = yield* decodeLedgerValue(row.after_json).pipe(
        Effect.mapError((cause) => migrationError("decode board ledger", cause)),
      );
      const id = refIdOf(row.ref);
      if (row.ref.startsWith("card:")) {
        const live = current.cards.find((card) => card.id === id);
        if (live === undefined || !sameJson(live, after)) return `card ${id} changed after apply`;
        restored.cards.set(id, before as KanbanCard);
      } else if (row.ref.startsWith("thread:")) {
        const live = current.links.find((link) => link.threadId === id);
        if (live === undefined || !sameJson(live, after)) return `thread link ${id} changed after apply`;
        restored.links.set(id, before as KanbanThreadLink);
      } else if (row.ref.startsWith("pool:")) {
        const key = id;
        const afterPool = after as KanbanPool;
        const live = current.pools.find((pool) => pool.key === afterPool.key);
        if (live === undefined || !sameJson(live, afterPool)) return `pool ${key} changed after apply`;
        restored.pools.set(key, before as KanbanPool);
        restored.oldPoolKeys.push(afterPool.key);
      }
    }
    // A rekey must not strand a card that acquired a slot after apply. All
    // affected cards must be among the unchanged ledger rows restored below.
    const removedKeys = new Set(restored.oldPoolKeys);
    for (const card of current.cards) {
      if (card.activePool !== null && removedKeys.has(card.activePool) && !restored.cards.has(card.id)) {
        return `card ${card.id} acquired migrated pool ${card.activePool} after apply`;
      }
    }
    const retainedKeys = new Set(current.pools.filter((pool) => !removedKeys.has(pool.key)).map((pool) => pool.key));
    for (const pool of restored.pools.values()) {
      if (retainedKeys.has(pool.key)) return `pool ${pool.key} was created after apply`;
      retainedKeys.add(pool.key);
    }
    // The rows restored in full. Old keys are the after keys, so the store removes them first.
    yield* store
      .migrateBoardSelections({
        board: restored.board,
        pools: [...restored.pools.values()],
        oldPoolKeys: restored.oldPoolKeys,
        cards: [...restored.cards.values()],
        threadLinks: [...restored.links.values()],
      })
      .pipe(Effect.mapError((cause) => migrationError(`restore board ${boardId}`, cause)));
    return null;
  });

  /** Stamps the ledger rows of one restored unit as rolled back. */
  const markRolledBack = Effect.fn("SelectionMigration.markRolledBack")(function* (
    ids: ReadonlyArray<number>,
  ) {
    if (ids.length === 0) return;
    const now = DateTime.formatIso(yield* DateTime.now);
    for (const id of ids) {
      yield* sql`
        UPDATE ardud_harness_selection_migration SET rolled_back_at = ${now} WHERE id = ${id}
      `.pipe(Effect.mapError((cause) => migrationError("mark rollback", cause)));
    }
  });

  const rollback: SelectionMigrationShape["rollback"] = Effect.fn("SelectionMigration.rollback")(
    function* (version) {
      const rows = yield* sql<LedgerRow>`
        SELECT id, scope, ref, before_json, after_json, applied_at
        FROM ardud_harness_selection_migration
         WHERE version = ${version} AND rolled_back_at IS NULL
        ORDER BY id DESC
      `.pipe(Effect.mapError((cause) => migrationError("read ledger", cause)));

      const skipped: Array<{ readonly ref: string; readonly reason: string }> = [];
      const retired: Array<{ readonly ref: string; readonly reason: string }> = [];
      let reverted = 0;

      // Boards first, one unit each: a board's rows are restored together or not at all.
      const boardIds = [
        ...new Set(
          rows
            .filter((row) => row.scope === "board")
            .map((row) => boardIdOf(row.ref))
            .filter((id): id is string => id !== null),
        ),
      ];
      for (const boardId of boardIds) {
        const boardRows = rows.filter(
          (row) => row.scope === "board" && boardIdOf(row.ref) === boardId,
        );
        const reason = yield* kanban.withSelectionMigrationLock(
          sql.withTransaction(Effect.gen(function* () {
            const reason = yield* restoreBoard(boardId, boardRows);
            if (reason === null) yield* markRolledBack(boardRows.map((row) => row.id));
            return reason;
          })).pipe(
            Effect.mapError((cause) => migrationError(`restore board ${boardId}`, cause)),
          ),
        );
        if (reason === null) {
          reverted += boardRows.length;
        } else {
          skipped.push({ ref: `board:${boardId}`, reason });
        }
      }

      // Every other row is restored alone, through its owner, and stamped only when it was written.
      for (const row of rows) {
        if (row.scope === "board") continue;
        const reason = yield* restoreRow(row, retired);
        if (reason === null) {
          yield* markRolledBack([row.id]);
          reverted += 1;
        } else {
          skipped.push({ ref: row.ref, reason });
        }
      }
      return { reverted, skipped, retired };
    },
  );

  return SelectionMigration.of({
    dryRun,
    apply: migrationLock.withPermits(1)(apply),
    rollback: (version) => migrationLock.withPermits(1)(rollback(version)),
  });
});

export const layer = Layer.effect(SelectionMigration, make);
