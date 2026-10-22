import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Sqlite from "../../../persistence/Sqlite.ts";
import * as ControlStore from "../../control/ControlStore.ts";
import { AttachTargets, AttachTargetsLive } from "./attachTargets.ts";

const crwRoot = ThreadId.make("t-crw-root");
const crwChild = ThreadId.make("t-crw-child");
const typed = ThreadId.make("t-typed");
const deleted = ThreadId.make("t-deleted");

const shells = new Map([
  [crwRoot, { deletedAt: null, lineage: { rootThreadId: crwRoot } }],
  [crwChild, { deletedAt: null, lineage: { rootThreadId: crwRoot } }],
  [typed, { deletedAt: null, lineage: { rootThreadId: typed } }],
  [deleted, { deletedAt: "2026-10-22T08:00:00.000Z", lineage: { rootThreadId: deleted } }],
]);

const threads = Layer.mock(ThreadManagementService.ThreadManagementService)({
  getThreadShell: (threadId) => Effect.succeed((shells.get(threadId) ?? null) as never),
});

const layer = AttachTargetsLive.pipe(
  Layer.provideMerge(ControlStore.layer),
  Layer.provideMerge(threads),
  Layer.provideMerge(Sqlite.layerMemory),
);

it.effect("a thread's origin is its own or its root's, and missing threads are null", () =>
  Effect.gen(function* () {
    const origins = yield* ControlStore.ControlStore;
    yield* origins.setOrigin(crwRoot, "crw");
    yield* origins.setOrigin(deleted, "crw");
    const targets = yield* AttachTargets;

    assert.deepStrictEqual(yield* targets.lookup(crwRoot), { origin: "crw" });
    assert.deepStrictEqual(yield* targets.lookup(crwChild), { origin: "crw" });
    assert.deepStrictEqual(yield* targets.lookup(typed), { origin: null });
    assert.isNull(yield* targets.lookup(deleted));
    assert.isNull(yield* targets.lookup(ThreadId.make("t-nowhere")));

    // A child's own origin wins over the root's.
    yield* origins.setOrigin(crwChild, "imessage");
    assert.deepStrictEqual(yield* targets.lookup(crwChild), { origin: "imessage" });
  }).pipe(Effect.provide(layer)),
);
