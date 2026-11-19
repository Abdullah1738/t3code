import type { OrchestrationV2ProviderThread } from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

export type RetentionReason =
  | "active_turn"
  | "idle_grace"
  | "pending_work"
  | "teardown_failed"
  | "teardown_sent"
  | "not_tracked";
export interface Retention {
  readonly reason: RetentionReason;
  readonly since: number | null;
  readonly detail: string | null;
  readonly idleSince?: number;
  readonly unloadAt?: number;
  readonly sentAt?: number;
}

export interface InventoryThreadSource {
  readonly threadId: string | null;
  readonly nativeThreadId: string;
  readonly retention: Retention;
  readonly settled: boolean | null;
  readonly archived: boolean | null;
  readonly lastTurnEndedAt: number | null;
}

export interface InventoryRuntimeSource {
  readonly provider: string;
  readonly instanceId: string;
  readonly providerSessionId: string;
  readonly diagnostics: EffectInventory;
  readonly rosterAvailable: boolean;
  readonly threads: ReadonlyArray<InventoryThreadSource>;
}
type EffectInventory =
  NonNullable<
    ProviderAdapter.ProviderAdapterV2SessionRuntime["runtimeInventory"]
  > extends import("effect/Effect").Effect<infer A>
    ? A
    : never;

// Shared with the orphan sweep: accept one directly attached row, never historical ownership.
export function nativeThreadOwners(input: {
  readonly runtime: Pick<
    ProviderAdapter.ProviderAdapterV2SessionRuntime,
    "instanceId" | "driver" | "providerSessionId"
  >;
  readonly attachedThreadIds: ReadonlySet<string>;
  readonly loaded: ReadonlySet<string>;
  readonly records: ReadonlyArray<OrchestrationV2ProviderThread>;
}) {
  const owners = new Map<string, OrchestrationV2ProviderThread[]>();
  for (const row of input.records) {
    const ref = row.nativeThreadRef;
    if (
      row.appThreadId === null ||
      !input.attachedThreadIds.has(row.appThreadId) ||
      row.providerInstanceId !== input.runtime.instanceId ||
      row.providerSessionId !== input.runtime.providerSessionId ||
      ref?.driver !== input.runtime.driver ||
      ref.nativeId === null ||
      !input.loaded.has(ref.nativeId)
    )
      continue;
    const candidates = owners.get(ref.nativeId) ?? [];
    candidates.push(row);
    owners.set(ref.nativeId, candidates);
  }
  return new Map(
    [...owners].flatMap(([nativeId, rows]) =>
      rows.length === 1 ? [[nativeId, rows[0]!] as const] : [],
    ),
  );
}

export function retentionFor(input: {
  readonly tracked: boolean;
  readonly busy: boolean;
  readonly since: number;
  readonly idleTimeoutMs: number;
  readonly pending?: string;
  readonly held?: boolean | undefined;
  readonly teardown?: Retention | undefined;
}): Retention {
  if (input.teardown?.reason === "teardown_sent" || input.teardown?.reason === "teardown_failed")
    return input.teardown;
  if (!input.tracked) return { reason: "not_tracked", since: null, detail: null };
  if (input.busy) return { reason: "active_turn", since: input.since, detail: null };
  if (input.pending !== undefined || input.held === true)
    return { reason: "pending_work", since: input.since, detail: input.pending ?? "held_work" };
  return {
    reason: "idle_grace",
    since: input.since,
    detail: null,
    idleSince: input.since,
    unloadAt: input.since + input.idleTimeoutMs,
  };
}
