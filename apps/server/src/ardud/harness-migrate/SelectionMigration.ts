import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
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
  ScheduledTaskId as ScheduledTaskIdSchema,
} from "@t3tools/contracts";

import * as KanbanService from "../kanban/engine/KanbanService.ts";
import * as KanbanStore from "../kanban/store/KanbanStore.ts";
import * as ServerSettingsService from "../../serverSettings.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ScheduledTaskService from "../../scheduledTasks/ScheduledTaskService.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import { planBoard, type BoardPlan, type BoardSnapshot } from "./boardPlan.ts";
import { planSettings, type SettingsPlan } from "./settingsPlan.ts";
import { planSelection } from "./selectionPlan.ts";

/** The version stamped on every ledger row this migration writes. */
export const SELECTION_MIGRATION_VERSION = 1;

export type MigrationScope = "settings" | "project" | "board" | "schedule" | "queued-run" | "thread";

const SCOPES: ReadonlyArray<MigrationScope> = [
  "settings",
  "project",
  "board",
  "schedule",
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
  readonly report: SelectionMigrationReport;
}

export interface SelectionMigrationRollbackResult {
  readonly reverted: number;
  readonly skipped: ReadonlyArray<{ readonly ref: string; readonly reason: string }>;
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

/**
 * Reads a settings ref: a top-level field (`favorites`) or a per-project override
 * (`projectSettingsOverrides.<projectId>.<field>`). Only the three selection fields are overrides.
 */
const readSettingsPath = (settingsValue: ServerSettings, ref: string): unknown => {
  const parts = ref.split(".");
  if (parts[0] === "projectSettingsOverrides" && parts.length === 3) {
    const overrides: Record<string, Record<string, unknown> | undefined> =
      settingsValue.projectSettingsOverrides;
    return overrides[parts[1] ?? ""]?.[parts[2] ?? ""];
  }
  return (settingsValue as unknown as Record<string, unknown>)[ref];
};

/** The settings patch that puts one ref back to `value`, read from the current settings. */
const settingsPatchFor = (
  settingsValue: ServerSettings,
  ref: string,
  value: unknown,
): ServerSettingsPatch => {
  const parts = ref.split(".");
  if (parts[0] === "projectSettingsOverrides" && parts.length === 3) {
    const projectId = parts[1] ?? "";
    const field = parts[2] ?? "";
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
  readonly scope: MigrationScope;
  readonly ref: string;
  readonly before_json: string;
  readonly after_json: string;
}

interface Plans {
  readonly settings: SettingsPlan;
  readonly projectDefaults: ReadonlyArray<{
    readonly projectId: ProjectId;
    readonly before: ModelSelection;
    readonly next: ModelSelection;
  }>;
  readonly boards: ReadonlyArray<{ readonly board: KanbanBoard; readonly pools: ReadonlyArray<KanbanPool>; readonly plan: BoardPlan }>;
  readonly schedules: ReadonlyArray<{
    readonly id: ScheduledTaskId;
    readonly before: ModelSelection;
    readonly next: ModelSelection;
  }>;
  readonly queued: ReadonlyArray<{
    readonly threadId: ThreadId;
    readonly runId: string;
    readonly before: ModelSelection;
    readonly next: ModelSelection;
  }>;
  readonly threads: ReadonlyArray<{
    readonly threadId: ThreadId;
    readonly before: ModelSelection;
    readonly next: ModelSelection | null;
    readonly widenTo: "full-access" | null;
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
  const sql = yield* SqlClient.SqlClient;
  const settings = yield* ServerSettingsService.ServerSettingsService;
  const projects = yield* ProjectService.ProjectService;
  const kanban = yield* KanbanService.KanbanService;
  const store = yield* KanbanStore.KanbanStore;
  const scheduled = yield* ScheduledTaskService.ScheduledTaskService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const crypto = yield* Crypto.Crypto;

  /** A fresh command id per owner write, so each dispatch is its own command. */
  const newCommandId = Effect.fn("SelectionMigration.newCommandId")(function* (label: string) {
    const uuid = yield* crypto
      .randomUUIDv4()
      .pipe(Effect.mapError((cause) => migrationError("command id", cause)));
    return CommandIdSchema.make(`harness-migrate:${label}:${uuid}`);
  });

  yield* sql.unsafe(LEDGER_DDL).pipe(Effect.mapError((cause) => migrationError("create ledger", cause)));
  yield* sql.unsafe(LEDGER_INDEX).pipe(Effect.mapError((cause) => migrationError("index ledger", cause)));

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
      const plan = planBoard({ board, pools, cards, openLinks } satisfies BoardSnapshot);
      for (const conflict of plan.conflicts) {
        conflicts.push({ scope: "board", ref: `${board.id}:${conflict.field}`, reason: conflict.reason });
      }
      for (const collision of plan.collisions) {
        collisions.push({ boardId: board.id, newKey: collision.newKey, oldKeys: collision.oldKeys });
      }
      boards.push({ board, pools, plan });
    }

    // Schedules: every stored task, disabled ones included.
    const listed = yield* scheduled.list().pipe(
      Effect.mapError((cause) => migrationError("read schedules", cause)),
    );
    const schedules: Array<Plans["schedules"][number]> = [];
    for (const task of listed.tasks) {
      const plan = planSelection(task.modelSelection);
      if (plan._tag === "conflict") {
        conflicts.push({ scope: "schedule", ref: task.id, reason: plan.reason });
      } else if (plan._tag === "mapped") {
        schedules.push({ id: task.id, before: task.modelSelection, next: plan.next });
      }
    }

    // Threads: live, non-dormant threads only. Archived or settled threads wait for E3's resolver.
    const threadPlans: Array<Plans["threads"][number]> = [];
    const threadIds: Array<ThreadId> = [];
    for (const project of snapshot.projects) {
      const listedThreads = yield* threads
        .listProjectThreads({ projectId: project.id, includeSubagents: false })
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
          (thread.runtimeMode === "approval-required" || thread.runtimeMode === "auto-accept-edits") &&
          thread.interactionMode !== "plan"
            ? ("full-access" as const)
            : null;
        if (next === null && widenTo === null) continue;
        threadPlans.push({ threadId: thread.id, before: thread.modelSelection, next, widenTo });
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
    for (const plan of plans.queued) {
      counts["queued-run"] += 1;
      changes.push({ scope: "queued-run", ref: plan.runId, before: plan.before, after: plan.next });
    }
    for (const plan of plans.threads) {
      counts.thread += 1;
      changes.push({
        scope: "thread",
        ref: plan.threadId,
        before: plan.before,
        after: plan.next ?? plan.before,
      });
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
    yield* store
      .migrateBoardSelections({
        board: next.board,
        pools: next.pools,
        oldPoolKeys,
        cards: next.cards,
        threadLinks: next.openLinks,
      })
      .pipe(Effect.mapError((cause) => migrationError(`write board ${entry.board.id}`, cause)));
    return entry.plan.changes.length;
  });

  const apply: SelectionMigrationShape["apply"] = Effect.gen(function* () {
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
    const record = Effect.fn("SelectionMigration.record")(function* (
      scope: MigrationScope,
      ref: string,
      before: unknown,
      after: unknown,
    ) {
      const beforeJson = yield* encodeLedgerValue(before).pipe(
        Effect.mapError((cause) => migrationError("encode ledger value", cause)),
      );
      const afterJson = yield* encodeLedgerValue(after).pipe(
        Effect.mapError((cause) => migrationError("encode ledger value", cause)),
      );
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* sql`
        INSERT INTO ardud_harness_selection_migration (version, scope, ref, before_json, after_json, applied_at, rolled_back_at)
        VALUES (${SELECTION_MIGRATION_VERSION}, ${scope}, ${ref}, ${beforeJson}, ${afterJson}, ${now}, NULL)
      `.pipe(Effect.mapError((cause) => migrationError("write ledger", cause)));
      counter.applied += 1;
    });

    // Settings: one patch, one ledger row per field it changes.
    if (plans.settings.patch !== null) {
      yield* settings.updateSettings(plans.settings.patch).pipe(
        Effect.mapError((cause) => migrationError("write settings", cause)),
      );
      for (const change of plans.settings.changes) {
        yield* record("settings", change.field, change.before, change.after);
      }
    }
    // Projects: the project owner's update, one command per project.
    for (const project of plans.projectDefaults) {
      const projectCommandId = yield* newCommandId(`project:${project.projectId}`);
      yield* projects
        .update({
          projectId: project.projectId,
          commandId: projectCommandId,
          defaultModelSelection: project.next,
        })
        .pipe(Effect.mapError((cause) => migrationError(`write project ${project.projectId}`, cause)));
      yield* record("project", project.projectId, project.before, project.next);
    }
    // Boards: one transaction each, and a failure leaves that board untouched.
    for (const entry of plans.boards) {
      const changes = yield* writeBoard(entry);
      if (changes > 0) {
        for (const change of entry.plan.changes) {
          yield* record("board", change.ref, change.before, change.after);
        }
      }
    }
    // Schedules: guarded per row, so a schedule edited since the dry run is skipped, not overwritten.
    for (const plan of plans.schedules) {
      const wrote = yield* scheduled
        .migrateModelSelection({ id: plan.id, expected: plan.before, next: plan.next })
        .pipe(Effect.mapError((cause) => migrationError(`write schedule ${plan.id}`, cause)));
      if (wrote) yield* record("schedule", plan.id, plan.before, plan.next);
    }
    // Queued runs: the orchestrator's rebind, which keeps order, attachments and the hold.
    for (const plan of plans.queued) {
      const queuedCommandId = yield* newCommandId(`queued:${plan.runId}`);
      yield* orchestrator
        .dispatch({
          type: "queued-run.rebind-selection",
          commandId: queuedCommandId,
          threadId: plan.threadId,
          runId: plan.runId as never,
          modelSelection: plan.next,
        })
        .pipe(Effect.mapError((cause) => migrationError(`write queued run ${plan.runId}`, cause)));
      yield* record("queued-run", plan.runId, plan.before, plan.next);
    }
    // Threads: the live model switch and the full-access widening, through the thread owner.
    for (const plan of plans.threads) {
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
          })
          .pipe(Effect.mapError((cause) => migrationError(`write thread ${plan.threadId}`, cause)));
        yield* record("thread", plan.threadId, plan.before, plan.next);
      }
      if (plan.widenTo !== null) {
        const runtimeCommandId = yield* newCommandId(`runtime:${plan.threadId}`);
        yield* orchestrator
          .dispatch({
            type: "thread.runtime-mode.set",
            commandId: runtimeCommandId,
            threadId: plan.threadId,
            runtimeMode: plan.widenTo,
          })
          .pipe(Effect.mapError((cause) => migrationError(`widen thread ${plan.threadId}`, cause)));
      }
    }
    return {
      applied: counter.applied,
      skipped: report.changes.length - counter.applied,
      report,
    };
  });

  /**
   * Puts one ledger row's `before` back through its owner, but only while the owner still holds the
   * `after` value apply wrote. Returns why it was skipped, or null when it was reverted.
   */
  const restoreRow = Effect.fn("SelectionMigration.restoreRow")(function* (row: LedgerRow) {
    const before = yield* decodeLedgerValue(row.before_json).pipe(
      Effect.mapError((cause) => migrationError("decode ledger", cause)),
    );
    const after = yield* decodeLedgerValue(row.after_json).pipe(
      Effect.mapError((cause) => migrationError("decode ledger", cause)),
    );
    const current = yield* currentValue(row.scope, row.ref);
    if (current === undefined) return "owner has no record for this row";
    if (!sameJson(current, after)) return "value changed after apply";
    return yield* writeValue(row.scope, row.ref, before, after);
  });

  /**
   * The owner's current value for one ledger row. `undefined` means the record is gone. Board and
   * card rows are not read here: a board is restored as a whole, by `restoreBoard`.
   */
  const currentValue = (
    scope: MigrationScope,
    ref: string,
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
        case "queued-run":
        case "thread":
        case "board":
          return undefined;
      }
    });

  /**
   * Puts one ledger row back through its owner. Returns null when written, or the reason it was not.
   * A board, queued-run or thread row is never restored alone: see `restoreBoard` and the skips.
   */
  const writeValue = (
    scope: MigrationScope,
    ref: string,
    before: unknown,
    after: unknown,
  ): Effect.Effect<string | null, SelectionMigrationError> =>
    Effect.gen(function* () {
      switch (scope) {
        case "settings": {
          const current = yield* readSettings;
          yield* settings
            .updateSettings(settingsPatchFor(current, ref, before))
            .pipe(Effect.mapError((cause) => migrationError("restore settings", cause)));
          return null;
        }
        case "project": {
          const commandId = yield* newCommandId(`rollback-project:${ref}`);
          yield* projects
            .update({
              projectId: ProjectIdSchema.make(ref),
              commandId,
              defaultModelSelection: before as ModelSelection,
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
        case "board":
        case "queued-run":
        case "thread":
          // Board rows are restored together by restoreBoards; a lone row is never written.
          return `${scope} rows restore with their board, not alone`;
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
    const boardRecord = boardRows.find((row) => row.ref === `board:${boardId}`);
    if (boardRecord === undefined) return "board row is missing from the ledger";

    // Read the board's current state and check every row against what apply wrote.
    const current = {
      board: (yield* kanban.boards.pipe(
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
      board: undefined as KanbanBoard | undefined,
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
    if (restored.board === undefined) return "board row is missing from the ledger";

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
        SELECT id, scope, ref, before_json, after_json
        FROM ardud_harness_selection_migration
        WHERE version = ${version} AND applied_at IS NOT NULL AND rolled_back_at IS NULL
        ORDER BY id DESC
      `.pipe(Effect.mapError((cause) => migrationError("read ledger", cause)));

      const skipped: Array<{ readonly ref: string; readonly reason: string }> = [];
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
        const reason = yield* restoreBoard(boardId, boardRows);
        if (reason === null) {
          yield* markRolledBack(boardRows.map((row) => row.id));
          reverted += boardRows.length;
        } else {
          skipped.push({ ref: `board:${boardId}`, reason });
        }
      }

      // Every other row is restored alone, through its owner, and stamped only when it was written.
      for (const row of rows) {
        if (row.scope === "board") continue;
        const reason = yield* restoreRow(row);
        if (reason === null) {
          yield* markRolledBack([row.id]);
          reverted += 1;
        } else {
          skipped.push({ ref: row.ref, reason });
        }
      }
      return { reverted, skipped };
    },
  );

  return SelectionMigration.of({ dryRun, apply, rollback });
});

export const layer = Layer.effect(SelectionMigration, make);
