import type { ResourceTelemetryProcess, ResourceTelemetrySnapshot } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProviderSessionManager from "../../orchestration-v2/ProviderSessionManager.ts";
import type {
  InventoryRuntimeSource,
  InventoryThreadSource,
  RetentionReason,
} from "./runtimeInventoryModel.ts";

const MAX_RUNTIMES = 128;
const MAX_THREADS = 256;
const MAX_CHILDREN = 1024;
const MAX_TAG_PROCESSES = 4096;

export interface ProcessTag {
  readonly pid: number;
  readonly startTimeMs: number;
  readonly threadId: string;
  readonly loadId: string;
  readonly nativeThreadId?: string;
}

// ps's environment output is consumed here only. No raw environment reaches telemetry or logs.
export function parseProcessTags(
  output: string,
  processes: ReadonlyArray<ResourceTelemetryProcess>,
): ProcessTag[] {
  const byPid = new Map(processes.map((row) => [row.identity.pid, row]));
  const tags: ProcessTag[] = [];
  for (const line of output.split("\n")) {
    const row = /^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.*)$/.exec(line);
    if (row === null) continue;
    const process = byPid.get(Number(row[1]));
    const startedAt = Date.parse(`${row[2]} UTC`);
    if (
      !Number.isFinite(startedAt) ||
      process === undefined ||
      Math.abs(startedAt - process.identity.startTimeMs) >= 1000
    )
      continue;
    const values = new Map<string, string[]>();
    for (const match of row[3]!.matchAll(
      /(?:^|\s)(ROBOB_THREAD_ID|ROBOB_THREAD_LOAD_ID|ROBOB_NATIVE_THREAD_ID)=([^\s]*)/g,
    )) {
      const valuesForKey = values.get(match[1]!) ?? [];
      valuesForKey.push(match[2]!);
      values.set(match[1]!, valuesForKey);
    }
    const one = (name: string) => {
      const entries = values.get(name);
      return entries?.length === 1 && /^[A-Za-z0-9:_.%/-]{1,512}$/.test(entries[0]!)
        ? entries[0]
        : undefined;
    };
    const threadId = one("ROBOB_THREAD_ID");
    const loadId = one("ROBOB_THREAD_LOAD_ID");
    const nativeThreadId = one("ROBOB_NATIVE_THREAD_ID");
    if (threadId !== undefined && loadId !== undefined)
      tags.push({
        ...process.identity,
        threadId,
        loadId,
        ...(nativeThreadId === undefined ? {} : { nativeThreadId }),
      });
  }
  return tags;
}

export class ProcessTags extends Context.Service<
  ProcessTags,
  {
    readonly read: (processes: ReadonlyArray<ResourceTelemetryProcess>) => Effect.Effect<{
      readonly tags: ReadonlyArray<ProcessTag>;
      readonly available: boolean;
      readonly truncated: number;
    }>;
  }
>()("t3/ardud/providers/ProviderRuntimeInventory/ProcessTags") {}

export const layerProcessTags = Layer.effect(
  ProcessTags,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const platform = yield* HostProcess.Platform;
    return ProcessTags.of({
      read: Effect.fn("ProviderRuntimeInventory.readTags")(function* (
        processes: ReadonlyArray<ResourceTelemetryProcess>,
      ) {
        const selected = processes.slice(0, MAX_TAG_PROCESSES);
        if (selected.length === 0) return { tags: [], available: true, truncated: 0 };
        if (platform === "win32")
          return { tags: [], available: false, truncated: processes.length };
        const output = yield* Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* spawner.spawn(
              ChildProcess.make(
                "ps",
                [
                  "eww",
                  "-o",
                  "pid=,lstart=,command=",
                  "-p",
                  selected.map((row) => row.identity.pid).join(","),
                ],
                { env: { LC_ALL: "C", TZ: "UTC" }, extendEnv: true },
              ),
            );
            let size = 0;
            const chunks: string[] = [];
            yield* handle.stdout.pipe(
              Stream.decodeText(),
              Stream.runForEach((chunk) =>
                Effect.suspend(() => {
                  size += chunk.length;
                  if (size > 8 * 1024 * 1024) return Effect.fail("output_limit");
                  chunks.push(chunk);
                  return Effect.void;
                }),
              ),
            );
            if (Number(yield* handle.exitCode) !== 0) return yield* Effect.fail("ps_failed");
            return chunks.join("");
          }),
        ).pipe(Effect.timeout("5 seconds"), Effect.option);
        return output._tag === "None"
          ? { tags: [], available: false, truncated: processes.length - selected.length }
          : {
              tags: parseProcessTags(output.value, selected),
              available: true,
              truncated: processes.length - selected.length,
            };
      }),
    });
  }),
);

interface Child {
  readonly pid: number;
  readonly startTime: number;
  readonly command: string;
  readonly rssBytes: number;
}
interface RuntimeInventory {
  readonly provider: string;
  readonly instanceId: string | null;
  readonly providerSessionId: string | null;
  readonly runtimePid: number | null;
  readonly startedAt: number | null;
  readonly runtimeSlot: number | null;
  readonly attribution:
    | "tagged"
    | "cli_descendants"
    | "runtime-shared"
    | "unsupported"
    | "unattributed";
  readonly rosterAvailable: boolean;
  readonly threads: ReadonlyArray<
    InventoryThreadSource & { readonly mcpChildren: ReadonlyArray<Child> }
  >;
  readonly unattributedChildren: ReadonlyArray<Child>;
  readonly sharedChildren: ReadonlyArray<Child>;
  readonly retentionCounts: Readonly<Record<RetentionReason | "unattributed", number>>;
  readonly truncated: { readonly threads: number; readonly children: number };
  readonly sampledAt: number;
}
export interface Snapshot {
  readonly sampledAt: number | null;
  readonly sampleAgeMs: number | null;
  readonly tagsAvailable: boolean;
  readonly runtimes: ReadonlyArray<RuntimeInventory>;
  readonly truncated: {
    readonly runtimes: number;
    readonly retiredRuntimes: number;
    readonly tagProcesses: number;
  };
}
export interface RuntimeSlot {
  readonly provider: string;
  readonly pid: number;
  readonly startTimeMs: number;
  readonly slot: number;
}

export function buildInventory(input: {
  readonly processes: ReadonlyArray<ResourceTelemetryProcess>;
  readonly runtimes: ReadonlyArray<InventoryRuntimeSource>;
  readonly tags: ReadonlyArray<ProcessTag>;
  readonly slots: ReadonlyArray<RuntimeSlot>;
  readonly sampledAt: number;
}): ReadonlyArray<RuntimeInventory> {
  const byPid = new Map(input.processes.map((row) => [row.identity.pid, row]));
  const claimed = new Set<number>();
  const result: RuntimeInventory[] = [];
  const descendants = (pid: number) =>
    input.processes.filter((row) => {
      let parent = row.ppid;
      for (let i = 0; i < input.processes.length; i++) {
        if (row.identity.pid === pid) return false;
        if (parent === pid) return true;
        const next = byPid.get(parent);
        if (next === undefined || next.identity.pid === next.ppid) break;
        parent = next.ppid;
      }
      return false;
    });
  const child = (row: ResourceTelemetryProcess): Child => ({
    pid: row.identity.pid,
    startTime: row.identity.startTimeMs,
    command: (row.name.split(/[\\/]/).at(-1) ?? "").slice(0, 128),
    rssBytes: row.residentBytes,
  });
  const append = (
    source: InventoryRuntimeSource | undefined,
    root: ResourceTelemetryProcess | undefined,
    provider: string,
    nativeThreadId?: string,
  ) => {
    if (root !== undefined) claimed.add(root.identity.pid);
    const children = root === undefined ? [] : descendants(root.identity.pid);
    const rootTeardown = source?.diagnostics.roots.find(
      (candidate) => candidate.pid === root?.identity.pid,
    )?.teardown;
    const threads = (source?.threads ?? [])
      .map((thread) =>
        rootTeardown === undefined ? thread : { ...thread, retention: rootTeardown },
      )
      .filter((thread) => nativeThreadId === undefined || thread.nativeThreadId === nativeThreadId);
    const attribution =
      source === undefined
        ? "unattributed"
        : provider === "codex"
          ? "tagged"
          : provider === "claudeAgent"
            ? "cli_descendants"
            : provider === "opencode"
              ? "runtime-shared"
              : "unsupported";
    const loads = source?.diagnostics.loads ?? [];
    // Native subagents can inherit a parent's config/token. Until every loaded native thread
    // has its own successful load binding, those tokens cannot prove per-thread ownership.
    const safeCodexRoster =
      source?.rosterAvailable === true &&
      threads.every((thread) =>
        loads.some((load) => load.nativeThreadId === thread.nativeThreadId),
      );
    const assigned = new Map<string, Child[]>();
    const unknown: Child[] = [];
    const shared: Child[] = [];
    for (const process of children) {
      let owner: string | undefined;
      if (attribution === "cli_descendants" && threads.length === 1)
        owner = threads[0]!.nativeThreadId;
      if (attribution === "tagged" && safeCodexRoster) {
        const tag = input.tags.find(
          (tag) =>
            tag.pid === process.identity.pid && tag.startTimeMs === process.identity.startTimeMs,
        );
        const matches =
          tag === undefined
            ? []
            : loads.filter(
                (load) =>
                  !source?.diagnostics.ambiguousLoadIds?.includes(load.loadId) &&
                  load.loadId === tag.loadId &&
                  load.threadId === tag.threadId &&
                  (tag.nativeThreadId === undefined ||
                    tag.nativeThreadId === load.nativeThreadId) &&
                  threads.some((thread) => thread.nativeThreadId === load.nativeThreadId),
              );
        if (matches.length === 1) owner = matches[0]!.nativeThreadId;
      }
      const output = child(process);
      if (attribution === "runtime-shared") shared.push(output);
      else if (owner === undefined) unknown.push(output);
      else {
        const list = assigned.get(owner) ?? [];
        list.push(output);
        assigned.set(owner, list);
      }
    }
    const counts: Record<RetentionReason | "unattributed", number> = {
      active_turn: 0,
      idle_grace: 0,
      pending_work: 0,
      teardown_failed: 0,
      teardown_sent: 0,
      not_tracked: 0,
      unattributed: unknown.length,
    };
    for (const thread of threads) counts[thread.retention.reason]++;
    let remaining = MAX_CHILDREN;
    const take = (rows: ReadonlyArray<Child>) => {
      const page = rows.slice(0, remaining);
      remaining -= page.length;
      return page;
    };
    const outputThreads = threads.slice(0, MAX_THREADS).map((thread) => ({
      ...thread,
      mcpChildren: take(assigned.get(thread.nativeThreadId) ?? []),
    }));
    const unattributedChildren = take(unknown);
    const sharedChildren = take(shared);
    const outputChildren = MAX_CHILDREN - remaining;
    result.push({
      provider,
      instanceId: source?.instanceId ?? null,
      providerSessionId:
        attribution === "runtime-shared" ? null : (source?.providerSessionId ?? null),
      runtimePid: root?.identity.pid ?? null,
      startedAt: root?.identity.startTimeMs ?? null,
      runtimeSlot:
        input.slots.find(
          (slot) =>
            slot.pid === root?.identity.pid && slot.startTimeMs === root?.identity.startTimeMs,
        )?.slot ?? null,
      attribution,
      rosterAvailable: source?.rosterAvailable ?? false,
      threads: outputThreads,
      unattributedChildren,
      sharedChildren,
      retentionCounts: counts,
      truncated: {
        threads: Math.max(0, threads.length - outputThreads.length),
        children: children.length - outputChildren,
      },
      sampledAt: input.sampledAt,
    });
  };
  for (const source of input.runtimes) {
    const roots = source.diagnostics.roots.filter((root) => {
      const process = byPid.get(root.pid);
      return (
        process !== undefined && Math.abs(process.identity.startTimeMs - root.spawnedAtMs) < 5000
      );
    });
    for (const root of roots) {
      if (claimed.has(root.pid)) continue;
      const peers =
        source.provider !== "opencode"
          ? [source]
          : input.runtimes.filter(
              (candidate) =>
                candidate.provider === source.provider &&
                candidate.instanceId === source.instanceId &&
                candidate.diagnostics.roots.some(
                  (other) => other.pid === root.pid && other.spawnedAtMs === root.spawnedAtMs,
                ),
            );
      const merged =
        peers.length === 1
          ? source
          : {
              ...source,
              threads: [
                ...new Map(
                  peers
                    .flatMap((peer) => peer.threads)
                    .map((thread) => [thread.nativeThreadId, thread]),
                ).values(),
              ],
            };
      append(merged, byPid.get(root.pid), source.provider, root.nativeThreadId);
    }
    if (roots.length === 0 && source.provider !== "claudeAgent")
      append(source, undefined, source.provider);
  }
  for (const slot of input.slots)
    if (!claimed.has(slot.pid)) append(undefined, byPid.get(slot.pid), slot.provider);
  return result;
}

export class ProviderRuntimeInventory extends Context.Service<
  ProviderRuntimeInventory,
  {
    readonly snapshot: Effect.Effect<Snapshot>;
    readonly refresh: (
      sample: ResourceTelemetrySnapshot,
      slots: ReadonlyArray<RuntimeSlot>,
    ) => Effect.Effect<void>;
  }
>()("t3/ardud/providers/ProviderRuntimeInventory") {}

const make = Effect.gen(function* () {
  const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const tags = yield* ProcessTags;
  const cache = yield* Ref.make<Snapshot>({
    sampledAt: null,
    sampleAgeMs: null,
    tagsAvailable: false,
    runtimes: [],
    truncated: { runtimes: 0, retiredRuntimes: 0, tagProcesses: 0 },
  });
  return ProviderRuntimeInventory.of({
    snapshot: Effect.gen(function* () {
      const value = yield* Ref.get(cache);
      const now = yield* Clock.currentTimeMillis;
      return {
        ...value,
        sampleAgeMs: value.sampledAt === null ? null : Math.max(0, now - value.sampledAt),
      };
    }),
    refresh: Effect.fn("ProviderRuntimeInventory.refresh")(function* (sample, slots) {
      const source =
        sessions.inventorySnapshot === undefined
          ? { runtimes: [], truncated: 0 }
          : yield* sessions.inventorySnapshot(sample.processes.map((process) => process.identity));
      const tagSample = yield* tags.read(
        sample.processes.filter((process) => process.category !== "server"),
      );
      const sampledAt = DateTime.toEpochMillis(sample.readAt);
      const runtimes = buildInventory({
        processes: sample.processes,
        runtimes: source.runtimes,
        tags: tagSample.tags,
        slots,
        sampledAt,
      });
      for (const runtime of runtimes)
        yield* Effect.logInfo("orchestration-v2.driver-session.retention-counts", {
          provider: runtime.provider,
          instanceId: runtime.instanceId,
          runtimePid: runtime.runtimePid,
          runtimeSlot: runtime.runtimeSlot,
          sampledAt,
          ...runtime.retentionCounts,
        });
      yield* Ref.set(cache, {
        sampledAt,
        sampleAgeMs: 0,
        tagsAvailable: tagSample.available,
        runtimes: runtimes.slice(0, MAX_RUNTIMES),
        truncated: {
          runtimes: Math.max(0, runtimes.length - MAX_RUNTIMES),
          retiredRuntimes: source.truncated,
          tagProcesses: tagSample.truncated,
        },
      });
    }),
  });
});
export const layer = Layer.effect(ProviderRuntimeInventory, make);
