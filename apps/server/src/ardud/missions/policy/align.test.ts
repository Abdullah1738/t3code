/**
 * Boot alignment after an import. Imported holders keep their model, and the
 * sweep says so once per mission instead of once per holder.
 */
import { MissionId, RoleId, ThreadId, type MissionEvent } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { binding, mission, role } from "../asks/AsksService.testkit.ts";
import * as MissionStore from "../store/MissionStore.ts";
import { modelKey, SOL_XHIGH } from "./models.ts";
import * as PolicyService from "./PolicyService.ts";
import { OWNER, makePorts, testLayer } from "./testing.ts";

const ports = makePorts();
const IMPORTED = [MissionId.make("imp-a"), MissionId.make("imp-b")];
const HOLDERS = 4;

const importEvent = {
  kind: "mission.created",
  actor: { _tag: "system", component: "test" },
  provenance: { _tag: "import", source: "test" },
  summary: "imported",
  subject: null,
} as const;

/** What the importer writes: roles whose holders have no observed model yet. */
const importMissions = Effect.gen(function* () {
  const store = yield* MissionStore.MissionStore;
  for (const missionId of IMPORTED) {
    yield* store.commit({
      event: { ...importEvent, missionId },
      upserts: [
        { _tag: "mission" as const, record: { ...mission, id: missionId, slug: missionId } },
        ...Array.from({ length: HOLDERS }, (_, index) => {
          const roleId = `${missionId}:writer-${index}`;
          return [
            { _tag: "role" as const, record: { ...role(roleId, "writer"), missionId } },
            {
              _tag: "role-binding" as const,
              record: {
                ...binding(`${roleId}@t`, roleId, ThreadId.make(`${missionId}-t${index}`)),
                reason: "import" as const,
              },
            },
          ];
        }).flat(),
      ],
    });
  }
});

const modelChanges = Effect.gen(function* () {
  const store = yield* MissionStore.MissionStore;
  const all: Array<MissionEvent> = [];
  for (const missionId of IMPORTED) {
    all.push(...(yield* store.eventsSince(missionId, 0, 500)));
  }
  return all.filter((event) => event.kind === "role.model-changed");
});

it.layer(testLayer(ports.layer))("policy boot alignment", (it) => {
  it.effect("writes one event per mission for imported holders, and nothing on the next boot", () =>
    Effect.gen(function* () {
      const policy = yield* PolicyService.PolicyService;
      const store = yield* MissionStore.MissionStore;
      yield* importMissions;

      yield* policy.sweep;
      const first = yield* modelChanges;
      assert.deepStrictEqual(
        first.map((event) => event.missionId),
        IMPORTED,
      );
      assert.include(first[0]!.summary, `${HOLDERS} imported holder(s) keep their model`);
      const holder = yield* store.get("role-binding", `${IMPORTED[0]}:writer-0@t`);
      assert.strictEqual(
        holder._tag === "Some" ? holder.value.observedModel : null,
        modelKey(role("x", "writer").modelSelection),
      );

      // A second boot with nothing changed writes nothing.
      yield* policy.sweep;
      assert.strictEqual((yield* modelChanges).length, first.length);

      // A real model change on an imported role still goes through the holder.
      ports.threads.set(`${IMPORTED[1]}-t0`, {
        exists: true,
        idle: true,
        modelSelection: role("x", "writer").modelSelection,
      });
      yield* policy.setRoleModel(OWNER, {
        roleId: RoleId.make(`${IMPORTED[1]}:writer-0`),
        modelSelection: SOL_XHIGH,
        reason: "upgrade",
      });
      assert.isTrue(ports.setModelCalls.some((call) => call.threadId === `${IMPORTED[1]}-t0`));
    }),
  );

  it.effect("names accepted holders the same way whether a role was imported or applied", () =>
    Effect.gen(function* () {
      const policy = yield* PolicyService.PolicyService;
      const store = yield* MissionStore.MissionStore;
      const missionId = MissionId.make("imp-mixed");
      const roleId = `${missionId}:writer`;
      const writer = { ...role(roleId, "writer"), missionId };
      ports.threads.set(`${missionId}-new`, {
        exists: true,
        idle: true,
        modelSelection: SOL_XHIGH,
      });
      yield* store.commit({
        event: { ...importEvent, missionId },
        upserts: [
          { _tag: "mission", record: { ...mission, id: missionId, slug: missionId } },
          { _tag: "role", record: writer },
          {
            _tag: "role-binding",
            record: {
              ...binding(`${roleId}@old`, roleId, ThreadId.make(`${missionId}-old`)),
              reason: "import",
            },
          },
          {
            _tag: "role-binding",
            record: binding(`${roleId}@new`, roleId, ThreadId.make(`${missionId}-new`)),
          },
        ],
      });
      yield* policy.sweep;
      const events = (yield* store.eventsSince(missionId, 0, 500)).filter(
        (event) => event.kind === "role.model-changed",
      );
      assert.strictEqual(events.length, 1);
      assert.deepInclude(events[0]!.payload, {
        phase: "applied",
        accepted: [
          {
            roleId,
            threadId: `${missionId}-old`,
            model: modelKey(writer.modelSelection),
          },
        ],
      });
    }),
  );
});
