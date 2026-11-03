/**
 * The ledger of per-thread harness migrations, and the state rules that decide
 * what a migration may still do. Pure: the store runs the DDL and writes rows,
 * these rules say which transitions are allowed.
 *
 * States, in order: `staged` (native history written, not bound) -> `committed`
 * (the thread points at the target) -> `confirmed` (the first native turn on the
 * target started). A migration in `committed` but not `confirmed` must never fall
 * back to the lossy handoff, and rollback is only allowed before confirmation.
 */

export const LEDGER_VERSION = 1;

export const LEDGER_DDL = `CREATE TABLE IF NOT EXISTS ardud_harness_migration (
  thread_id                 TEXT PRIMARY KEY,
  version                   INTEGER NOT NULL,
  source_session            TEXT NOT NULL,
  source_digest             TEXT NOT NULL,
  target_driver             TEXT NOT NULL,
  target_instance           TEXT NOT NULL,
  target_native_id          TEXT NOT NULL,
  home                      TEXT,
  cli_version               TEXT,
  state                     TEXT NOT NULL,
  error                     TEXT,
  first_resume_confirmed_at TEXT,
  created_at                TEXT NOT NULL,
  updated_at                TEXT NOT NULL,
  original_selection_json   TEXT NOT NULL
)`;

export type MigrationState = "staged" | "committed" | "confirmed" | "rolled_back" | "failed";

export interface LedgerRow {
  readonly threadId: string;
  readonly state: MigrationState;
  readonly firstResumeConfirmedAt: string | null;
}

export type LedgerTransition =
  | { readonly kind: "allowed"; readonly to: MigrationState }
  | { readonly kind: "refused"; readonly reason: string };

/** Whether the thread's history is bound to the target, so the lossy fallback is off. */
export const bindsTarget = (state: MigrationState): boolean =>
  state === "committed" || state === "confirmed";

/**
 * The fallback guard: a thread bound to a target that hasn't confirmed its first
 * native start must fail loudly, never start fresh with the capped handoff.
 */
export const fallbackAllowed = (row: LedgerRow | null): boolean =>
  row === null || (row.state !== "committed" && row.state !== "staged");

/** Rollback is allowed only before the first target turn confirmed. */
export const rollbackTransition = (
  row: LedgerRow,
  options: { readonly force: boolean },
): LedgerTransition => {
  if (row.state === "rolled_back") return { kind: "refused", reason: "already rolled back" };
  // A confirmed migration has target turns behind it, so the rule for it is the
  // lossless one: refuse unless forced, and say why.
  if ((row.state === "confirmed" || row.firstResumeConfirmedAt !== null) && !options.force) {
    return {
      kind: "refused",
      reason:
        "the target has already run a turn; this is not lossless. Pass force to roll back anyway.",
    };
  }
  if (row.state !== "committed" && row.state !== "staged" && row.state !== "confirmed") {
    return { kind: "refused", reason: `cannot roll back a ${row.state} migration` };
  }
  return { kind: "allowed", to: "rolled_back" };
};

/** Confirmation is the only way out of `committed`, and it can't happen twice. */
export const confirmTransition = (row: LedgerRow): LedgerTransition => {
  if (row.state !== "committed") {
    return { kind: "refused", reason: `cannot confirm a ${row.state} migration` };
  }
  return { kind: "allowed", to: "confirmed" };
};
