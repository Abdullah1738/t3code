import { describe, expect, it } from "@effect/vitest";

import {
  bindsTarget,
  confirmTransition,
  fallbackAllowed,
  LEDGER_DDL,
  rollbackTransition,
  type LedgerRow,
} from "./MigrationLedger.ts";

const row = (overrides: Partial<LedgerRow> = {}): LedgerRow => ({
  threadId: "thread-1",
  state: "committed",
  firstResumeConfirmedAt: null,
  ...overrides,
});

describe("MigrationLedger rules", () => {
  it("creates the ledger table with IF NOT EXISTS and the required columns", () => {
    expect(LEDGER_DDL).toContain("CREATE TABLE IF NOT EXISTS ardud_harness_migration");
    for (const column of [
      "thread_id",
      "source_digest",
      "target_native_id",
      "state",
      "first_resume_confirmed_at",
      "original_selection_json",
    ]) {
      expect(LEDGER_DDL).toContain(column);
    }
  });

  it("refuses the lossy fallback for a committed thread that has not confirmed", () => {
    expect(fallbackAllowed(row({ state: "committed" }))).toBe(false);
    expect(fallbackAllowed(row({ state: "staged" }))).toBe(false);
  });

  it("allows the fallback only when no migration binds the thread", () => {
    expect(fallbackAllowed(null)).toBe(true);
    expect(fallbackAllowed(row({ state: "rolled_back" }))).toBe(true);
  });

  it("treats committed and confirmed as bound to the target", () => {
    expect(bindsTarget("committed")).toBe(true);
    expect(bindsTarget("confirmed")).toBe(true);
    expect(bindsTarget("staged")).toBe(false);
  });

  it("rolls back before the first target turn", () => {
    expect(rollbackTransition(row(), { force: false })).toEqual({ kind: "allowed", to: "rolled_back" });
  });

  it("refuses a rollback after the target confirmed, unless forced", () => {
    const confirmed = row({ state: "confirmed", firstResumeConfirmedAt: "2026-11-02T04:00:00Z" });
    const refused = rollbackTransition(confirmed, { force: false });
    expect(refused.kind).toBe("refused");
    if (refused.kind === "refused") expect(refused.reason).toContain("not lossless");
  });

  it("refuses to roll back twice", () => {
    expect(rollbackTransition(row({ state: "rolled_back" }), { force: false }).kind).toBe("refused");
  });

  it("confirms a committed migration once and only once", () => {
    expect(confirmTransition(row())).toEqual({ kind: "allowed", to: "confirmed" });
    expect(confirmTransition(row({ state: "confirmed" })).kind).toBe("refused");
    expect(confirmTransition(row({ state: "rolled_back" })).kind).toBe("refused");
  });
});
