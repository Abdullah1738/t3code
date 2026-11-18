import { assert, describe, it } from "@effect/vitest";
import type { ResourceTelemetryProcess, ResourceTelemetrySnapshot } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { TestClock } from "effect/testing";

import * as ProviderSessionManager from "../../orchestration-v2/ProviderSessionManager.ts";
import * as Inventory from "./ProviderRuntimeInventory.ts";
import {
  retentionFor,
  type InventoryRuntimeSource,
  type InventoryThreadSource,
} from "./runtimeInventoryModel.ts";

const processRow = (pid: number, ppid: number, name = "node", startTimeMs = 1000) =>
  ({
    identity: { pid, startTimeMs },
    ppid,
    name,
    command: `${name} --secret=do-not-return`,
    residentBytes: 1024,
    category: "server-child",
  }) as ResourceTelemetryProcess;
const thread = (nativeThreadId: string, threadId = "robob-one"): InventoryThreadSource => ({
  threadId,
  nativeThreadId,
  retention: retentionFor({ tracked: true, busy: false, since: 1000, idleTimeoutMs: 3000 }),
  settled: false,
  archived: false,
  lastTurnEndedAt: 1000,
});
const runtime = (provider = "codex"): InventoryRuntimeSource => ({
  provider,
  instanceId: provider,
  providerSessionId: "session-one",
  rosterAvailable: true,
  diagnostics: {
    roots: [{ pid: 20, spawnedAtMs: 1000 }],
    loads: [{ nativeThreadId: "native-one", threadId: "robob-one", loadId: "load-one" }],
  },
  threads: [thread("native-one")],
});
const build = (
  runtimes: ReadonlyArray<InventoryRuntimeSource>,
  processes = [processRow(20, 10, "codex"), processRow(21, 20), processRow(22, 21, "helper")],
  tags: ReadonlyArray<Inventory.ProcessTag> = [],
) =>
  Inventory.buildInventory({
    runtimes,
    processes,
    tags,
    slots: [{ provider: "codex", pid: 20, startTimeMs: 1000, slot: 0 }],
    sampledAt: 2000,
  });

describe("provider runtime inventory", () => {
  it.effect("reports tags unavailable on Windows without spawning ps", () =>
    Effect.gen(function* () {
      const tags = yield* Inventory.ProcessTags;
      assert.deepEqual(yield* tags.read([processRow(21, 20)]), {
        tags: [],
        available: false,
        truncated: 1,
      });
    }).pipe(
      Effect.provide(
        Inventory.layerProcessTags.pipe(
          Layer.provide(Layer.mock(ChildProcessSpawner.ChildProcessSpawner)({})),
        ),
      ),
      Effect.provideService(HostProcess.Platform, "win32"),
    ),
  );

  it.each([
    { tracked: true, busy: true, reason: "active_turn" },
    { tracked: true, busy: false, reason: "idle_grace" },
    { tracked: true, busy: false, held: true, reason: "pending_work" },
    { tracked: true, busy: false, pending: "background_work", reason: "pending_work" },
    {
      tracked: true,
      busy: false,
      teardown: {
        reason: "teardown_sent" as const,
        since: 1000,
        detail: "unsubscribe_sent",
        sentAt: 1000,
      },
      reason: "teardown_sent",
    },
    {
      tracked: true,
      busy: false,
      teardown: { reason: "teardown_failed" as const, since: 1000, detail: "unsubscribe_failed" },
      reason: "teardown_failed",
    },
    { tracked: false, busy: false, reason: "not_tracked" },
  ])("maps retention to $reason", ({ reason, ...input }) => {
    const retention = retentionFor({ ...input, since: 1000, idleTimeoutMs: 3000 });
    assert.strictEqual(retention.reason, reason);
    if (reason === "idle_grace")
      assert.deepEqual(retention, {
        reason,
        since: 1000,
        detail: null,
        idleSince: 1000,
        unloadAt: 4000,
      });
  });

  it("binds Codex children by load token and birth, including two native histories with the same Robob id", () => {
    const source = runtime();
    const result = build(
      [
        {
          ...source,
          threads: [...source.threads, thread("native-two")],
          diagnostics: {
            ...source.diagnostics,
            loads: [
              ...source.diagnostics.loads,
              { nativeThreadId: "native-two", threadId: "robob-one", loadId: "load-two" },
            ],
          },
        },
      ],
      undefined,
      [
        { pid: 21, startTimeMs: 1000, threadId: "robob-one", loadId: "load-two" },
        { pid: 22, startTimeMs: 999, threadId: "robob-one", loadId: "load-one" },
      ],
    );
    assert.deepEqual(
      result[0]!.threads.map((row) => row.mcpChildren.map((child) => child.pid)),
      [[], [21]],
    );
    assert.deepEqual(
      result[0]!.unattributedChildren.map((child) => child.pid),
      [22],
    );
    assert.notInclude(JSON.stringify(result), "do-not-return");
  });

  it("clears a previous deferred observation when work is no longer pending", () => {
    assert.equal(
      retentionFor({
        tracked: true,
        busy: false,
        since: 1000,
        idleTimeoutMs: 3000,
        teardown: { reason: "pending_work", since: 0, detail: "background_work" },
      }).reason,
      "idle_grace",
    );
  });

  it.each(["unbound", "unavailable"])("does not guess when the Codex roster is %s", (condition) => {
    const source = runtime();
    const result = build(
      [
        {
          ...source,
          rosterAvailable: condition !== "unavailable",
          threads: [...source.threads, thread("unbound-child")],
        },
      ],
      undefined,
      [{ pid: 21, startTimeMs: 1000, threadId: "robob-one", loadId: "load-one" }],
    );
    assert.deepEqual(
      result[0]!.threads.flatMap((thread) => thread.mcpChildren),
      [],
    );
    assert.strictEqual(result[0]!.retentionCounts.unattributed, 2);
  });

  it("keeps an inherited token ambiguous after the native subagent closes", () => {
    const source = runtime();
    const result = build(
      [{ ...source, diagnostics: { ...source.diagnostics, ambiguousLoadIds: ["load-one"] } }],
      undefined,
      [{ pid: 21, startTimeMs: 1000, threadId: "robob-one", loadId: "load-one" }],
    )[0]!;
    assert.deepEqual(result.threads[0]!.mcpChildren, []);
    assert.strictEqual(result.unattributedChildren.length, 2);
  });

  it("reports a retiring Claude CLI independently of a replacement's active turn", () => {
    const source = runtime("claudeAgent");
    const result = build([
      {
        ...source,
        threads: [
          {
            ...thread("native-one"),
            retention: { reason: "active_turn", since: 1000, detail: null },
          },
        ],
        diagnostics: {
          ...source.diagnostics,
          roots: [
            {
              pid: 20,
              spawnedAtMs: 1000,
              nativeThreadId: "native-one",
              teardown: { reason: "teardown_failed", since: 2000, detail: "stop_failed" },
            },
          ],
        },
      },
    ])[0]!;
    assert.strictEqual(result.threads[0]!.retention.reason, "teardown_failed");
  });

  it("attributes Claude grandchildren to its CLI and isolates sibling CLI processes", () => {
    const source = runtime("claudeAgent");
    const result = build(
      [
        {
          ...source,
          diagnostics: {
            ...source.diagnostics,
            roots: [{ pid: 20, spawnedAtMs: 1000, nativeThreadId: "native-one" }],
          },
        },
      ],
      [processRow(20, 10, "claude"), processRow(21, 20), processRow(22, 21), processRow(31, 30)],
    );
    assert.deepEqual(
      result[0]!.threads[0]!.mcpChildren.map((child) => child.pid),
      [21, 22],
    );
    assert.strictEqual(result[0]!.attribution, "cli_descendants");
  });

  it("rejects a recycled runtime pid and lists an unknown runtime's descendants", () => {
    const result = build([runtime()], [processRow(20, 10, "codex", 9000), processRow(21, 20)]);
    assert.strictEqual(result[0]!.runtimePid, null);
    assert.strictEqual(result[0]!.threads[0]!.mcpChildren.length, 0);
    assert.deepEqual(
      result[1]!.unattributedChildren.map((child) => child.pid),
      [21],
    );
  });

  it.each(["opencode", "cursor"])("reports %s support explicitly", (provider) => {
    const result = build([runtime(provider)])[0]!;
    assert.strictEqual(
      result.attribution,
      provider === "opencode" ? "runtime-shared" : "unsupported",
    );
    assert.strictEqual(result.threads[0]!.mcpChildren.length, 0);
    assert.strictEqual(
      provider === "opencode" ? result.sharedChildren.length : result.unattributedChildren.length,
      2,
    );
  });

  it("caps threads and total child rows while counting the complete sample", () => {
    const result = build(
      [
        {
          ...runtime("claudeAgent"),
          threads: Array.from({ length: 300 }, (_, i) => thread(`native-${i}`)),
        },
      ],
      [processRow(20, 10), ...Array.from({ length: 1100 }, (_, i) => processRow(i + 100, 20))],
    )[0]!;
    assert.strictEqual(result.threads.length, 256);
    assert.strictEqual(result.unattributedChildren.length, 1024);
    assert.deepEqual(result.truncated, { threads: 44, children: 76 });
    assert.strictEqual(result.retentionCounts.idle_grace, 300);
    assert.strictEqual(result.retentionCounts.unattributed, 1100);
  });

  it("extracts only unique allowlisted tags from the matching process birth", () => {
    const born = DateTime.makeUnsafe("2026-11-17T06:00:00Z");
    const psDate = "Tue Nov 17 06:00:00 2026";
    const output = `21 ${psDate} /bin/node TOKEN=secret ROBOB_THREAD_ID=robob-one ROBOB_THREAD_LOAD_ID=load-one\n22 ${psDate} node ROBOB_THREAD_ID=robob-one ROBOB_THREAD_LOAD_ID=first ROBOB_THREAD_LOAD_ID=second`;
    const processes = [
      processRow(21, 20, "node", DateTime.toEpochMillis(born)),
      processRow(22, 20, "node", DateTime.toEpochMillis(born)),
    ];
    assert.deepEqual(Inventory.parseProcessTags(output, processes), [
      {
        pid: 21,
        startTimeMs: DateTime.toEpochMillis(born),
        threadId: "robob-one",
        loadId: "load-one",
      },
    ]);
    assert.deepEqual(
      Inventory.parseProcessTags(
        output,
        processes.map((row) => ({ ...row, identity: { ...row.identity, startTimeMs: 0 } })),
      ),
      [],
    );
    assert.deepEqual(Inventory.parseProcessTags(output.replaceAll("Nov", "Bad"), processes), []);
  });

  it.effect("snapshot only reads the cache, reports age and bounds the runtime list", () => {
    let probes = 0;
    return Effect.gen(function* () {
      const inventory = yield* Inventory.ProviderRuntimeInventory;
      assert.isNull((yield* inventory.snapshot).sampledAt);
      const sample = {
        readAt: DateTime.makeUnsafe(0),
        processes: [],
      } as unknown as ResourceTelemetrySnapshot;
      yield* inventory.refresh(sample, []);
      yield* TestClock.adjust(1000);
      const first = yield* inventory.snapshot;
      const second = yield* inventory.snapshot;
      assert.strictEqual(first.sampleAgeMs, 1000);
      assert.deepEqual(second, first);
      assert.strictEqual(first.runtimes.length, 128);
      assert.strictEqual(first.truncated.runtimes, 12);
      assert.strictEqual(probes, 1);
    }).pipe(
      Effect.provide(
        Inventory.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(Inventory.ProcessTags, {
                read: () => Effect.succeed({ tags: [], available: true, truncated: 0 }),
              }),
              Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
                inventorySnapshot: () =>
                  Effect.sync(() => {
                    probes++;
                    return { runtimes: Array.from({ length: 140 }, () => runtime()), truncated: 0 };
                  }),
              }),
            ),
          ),
        ),
      ),
    );
  });
});
