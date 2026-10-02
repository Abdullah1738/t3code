import type { ArdudBoardImportResult } from "@t3tools/contracts";

import type { BoardRow, CompletedFrom } from "./BoardModel.ts";

/** One record of OpenChamber's ~/.config/openchamber/session-board.json (version 1). */
export interface OpenChamberRecord {
  readonly sessionId: string;
  readonly title?: string;
  readonly prompt?: { readonly id: string; readonly createdAt: number } | null;
  readonly pending?: boolean;
  readonly reviewed?: boolean;
  readonly backlog?: boolean;
  readonly scheduled?: boolean;
  readonly completedFrom?: string;
  readonly deleted?: boolean;
  readonly parentId?: string;
  readonly projectId?: string;
  readonly origin?: string;
  readonly workRevision?: number;
  readonly updatedAt?: number;
}

export interface OpenChamberLedger {
  readonly version: number;
  readonly activatedAt?: number;
  readonly records: ReadonlyArray<OpenChamberRecord>;
}

export function parseOpenChamberLedger(value: unknown): OpenChamberLedger {
  if (
    typeof value !== "object" ||
    value === null ||
    (value as { version?: unknown }).version !== 1 ||
    !Array.isArray((value as { records?: unknown }).records)
  ) {
    throw new Error("Not an OpenChamber session board ledger (version 1).");
  }
  const ledger = value as { activatedAt?: unknown; records: ReadonlyArray<unknown> };
  const records = ledger.records.filter(
    (record): record is OpenChamberRecord =>
      typeof record === "object" &&
      record !== null &&
      typeof (record as { sessionId?: unknown }).sessionId === "string",
  );
  return {
    version: 1,
    ...(typeof ledger.activatedAt === "number" ? { activatedAt: ledger.activatedAt } : {}),
    records,
  };
}

const completedFromOf = (value: string | undefined): CompletedFrom | null =>
  value === "waiting" || value === "backlog" || value === "scheduled" ? value : null;

export interface ImportPlan {
  readonly rows: ReadonlyArray<BoardRow>;
  readonly origins: ReadonlyArray<{ readonly threadId: string; readonly origin: string }>;
  readonly summary: Omit<
    ArdudBoardImportResult,
    "dryRun" | "source" | "imported" | "keptNewer" | "missingThreads"
  >;
}

/**
 * Maps OpenChamber rows onto t3 threads. Subagent rows are skipped: t3 never
 * gives subagents their own card. Reviewed, backlog, scheduled, deleted and
 * undo (`completedFrom`) state carry over as they were.
 */
export function planOpenChamberImport(
  ledger: OpenChamberLedger,
  threadIdBySession: ReadonlyMap<string, string>,
): ImportPlan {
  const rows: BoardRow[] = [];
  const origins: Array<{ threadId: string; origin: string }> = [];
  let unmapped = 0;
  let children = 0;
  const lanes = { waiting: 0, backlog: 0, scheduled: 0, reviewed: 0 };
  for (const record of ledger.records) {
    const threadId = threadIdBySession.get(record.sessionId);
    if (threadId === undefined) {
      unmapped += 1;
      continue;
    }
    if (typeof record.origin === "string" && record.origin.length > 0) {
      origins.push({ threadId, origin: record.origin });
    }
    if (typeof record.parentId === "string" && record.parentId.length > 0) {
      children += 1;
      continue;
    }
    const reviewed = record.reviewed === true;
    const pending = record.pending === true && !reviewed;
    const backlog = record.backlog === true && reviewed;
    const scheduled = record.scheduled === true;
    const row: BoardRow = {
      threadId,
      projectId: null,
      title: typeof record.title === "string" && record.title ? record.title : threadId,
      promptAt:
        record.prompt && Number.isFinite(record.prompt.createdAt) ? record.prompt.createdAt : null,
      pending,
      reviewed,
      backlog,
      scheduled,
      completedFrom: reviewed ? completedFromOf(record.completedFrom) : null,
      deleted: record.deleted === true,
      workRevision:
        Number.isSafeInteger(record.workRevision) && (record.workRevision ?? 0) >= 0
          ? (record.workRevision as number)
          : 0,
      updatedAt: Number.isFinite(record.updatedAt) ? (record.updatedAt as number) : 0,
    };
    rows.push(row);
    if (scheduled && !reviewed) lanes.scheduled += 1;
    else if (backlog) lanes.backlog += 1;
    else if (pending) lanes.waiting += 1;
    else lanes.reviewed += 1;
  }
  return {
    rows,
    origins,
    summary: {
      total: ledger.records.length,
      unmapped,
      children,
      origins: origins.length,
      lanes,
    },
  };
}
