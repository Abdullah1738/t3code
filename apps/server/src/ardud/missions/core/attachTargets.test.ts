import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Sqlite from "../../../persistence/Sqlite.ts";
import * as ControlStore from "../../control/ControlStore.ts";
import { authorityStore } from "../guard/authority.ts";
import { AttachTargets, AttachTargetsLive } from "./attachTargets.ts";

const crwRoot = ThreadId.make("t-crw-root");
const crwChild = ThreadId.make("t-crw-child");
const relabeled = ThreadId.make("t-relabeled");
const bridge = ThreadId.make("t-bridge");
const typed = ThreadId.make("t-typed");
const garbled = ThreadId.make("t-garbled");
const deleted = ThreadId.make("t-deleted");

const shell = (
  threadId: ThreadId,
  rootThreadId: ThreadId = threadId,
  deletedAt: string | null = null,
): [ThreadId, { deletedAt: string | null; lineage: { rootThreadId: ThreadId } }] => [
  threadId,
  { deletedAt, lineage: { rootThreadId } },
];
const shells = new Map([
  shell(crwRoot),
  shell(crwChild, crwRoot),
  shell(relabeled),
  shell(bridge),
  shell(typed),
  shell(garbled),
  shell(deleted, deleted, "2026-10-22T08:00:00.000Z"),
]);

const threads = Layer.mock(ThreadManagementService.ThreadManagementService)({
  getThreadShell: (threadId) => Effect.succeed((shells.get(threadId) ?? null) as never),
});

const layer = AttachTargetsLive.pipe(
  Layer.provideMerge(ControlStore.layer),
  Layer.provideMerge(threads),
  Layer.provideMerge(Sqlite.layerMemory),
);

const component = (name: string, relay = false) => ({
  _tag: "session" as const,
  sessionId: `session-${name}`,
  subject: `component:${name}`,
  label: name,
  ...(relay ? {} : { component: name }),
});

it.effect("the creator is the component whose credential launched that exact thread", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const authority = authorityStore(sql);
    yield* authority.record("thread", crwRoot, component("crw"));
    yield* authority.record("thread", deleted, component("crw"));
    yield* authority.record("thread", bridge, component("spectrum-bridge", true));
    yield* authority.record("thread", typed, {
      _tag: "session",
      sessionId: "session-cli",
      subject: "cli-device",
      label: "t3ctl",
    });
    // Any operator session can relabel an origin; the label proves nothing.
    yield* (yield* ControlStore.ControlStore).setOrigin(relabeled, "crw");
    const targets = yield* AttachTargets;

    assert.deepStrictEqual(yield* targets.lookup(crwRoot), { createdBy: "crw" });
    assert.deepStrictEqual(yield* targets.lookup(bridge), { createdBy: "spectrum-bridge" });
    // A child or fork of a crw thread was not launched by crw.
    assert.deepStrictEqual(yield* targets.lookup(crwChild), { createdBy: null });
    assert.deepStrictEqual(yield* targets.lookup(relabeled), { createdBy: null });
    assert.deepStrictEqual(yield* targets.lookup(typed), { createdBy: null });
    assert.isNull(yield* targets.lookup(deleted));
    assert.isNull(yield* targets.lookup(ThreadId.make("t-nowhere")));

    // A record that does not decode refuses rather than reading as no creator.
    yield* sql`
      INSERT INTO ardud_mission_guard_authority (kind, subject_id, principal_json, recorded_at)
      VALUES ('thread', ${garbled}, '{"_tag":"nobody"}', '2026-10-22T08:00:00.000Z')
    `;
    const exit = yield* Effect.exit(targets.lookup(garbled));
    assert.isTrue(Exit.isFailure(exit));
  }).pipe(Effect.provide(layer)),
);
