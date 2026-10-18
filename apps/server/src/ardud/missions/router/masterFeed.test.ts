import {
  ApprovalId,
  RoleId,
  type Approval,
  type MissionEvent,
  type MissionProvenance,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Sqlite from "../../../persistence/Sqlite.ts";
import { agent, at, masterThread, missionId, seed } from "../asks/AsksService.testkit.ts";
import * as MissionStore from "../store/MissionStore.ts";
import { digestText, makeMasterFeed } from "./masterFeed.ts";
import { controlRoomId, MissionRouter } from "./MissionRouter.ts";
import { fakeRouterThreads, routerOverFakes } from "./MissionRouter.testkit.ts";
import * as RouterStore from "./RouterStore.ts";

const editor: MissionProvenance = { _tag: "system", component: "editor" };
const crw: MissionProvenance = { _tag: "system", component: "crw" };
const masterRole = { _tag: "role", roleId: RoleId.make("role-master") } as const;

const harness = () => {
  const threads = fakeRouterThreads();
  const layer = routerOverFakes(threads).pipe(
    Layer.provideMerge(MissionStore.layer),
    Layer.provideMerge(Sqlite.layerMemory),
  );
  return { threads, layer };
};

const feedOf = (digest: string | null) =>
  Effect.gen(function* () {
    const router = yield* MissionRouter;
    const store = yield* MissionStore.MissionStore;
    return makeMasterFeed({ router, store, digest: () => Effect.succeed(digest) });
  });

const controlMessages = Effect.gen(function* () {
  const rooms = yield* RouterStore.RouterStore;
  return (yield* rooms.roomMessages(controlRoomId(missionId), null, 20)).messages;
});

const approval = (id: string, approver: "owner" | "master" | null): Approval => ({
  ...(approver === null ? {} : { approver }),
  id: ApprovalId.make(id),
  missionId,
  kind: "merge",
  title: `Good to merge: acme/api#${id}`,
  detail: "Decide in the review thread.",
  requestedBy: "crw",
  links: [],
  status: "pending",
  staleReason: null,
  decidedBy: null,
  decidedAt: null,
  createdAt: at,
});

const openApproval = (record: Approval, provenance: MissionProvenance = crw) =>
  Effect.gen(function* () {
    const store = yield* MissionStore.MissionStore;
    const result = yield* store.commit({
      event: {
        missionId,
        kind: "approval.opened",
        actor: { _tag: "system", component: "crw" },
        provenance,
        summary: `crw asks the ${record.approver ?? "owner"}: ${record.title}`,
        subject: { kind: "approval", id: record.id },
      },
      upserts: [{ _tag: "approval", record }],
    });
    return result.event;
  });

const wakesFor = (sent: ReadonlyArray<{ threadId: string; key: string }>) =>
  sent.filter((entry) => entry.key.startsWith("mission-wake:")).map((entry) => entry.threadId);

describe("master inbox feed", () => {
  it("formats the editor's view as the digest body", () => {
    assert.strictEqual(digestText(null), null);
    assert.strictEqual(
      digestText({
        bottomLine: "Ship the API tonight.",
        bottomLineAt: at,
        fyiOrder: [],
        feed: [{ kind: "blocked", summary: "CRP-9 waits on review", ref: null, at }],
      }),
      "Bottom line: Ship the API tonight.\n- blocked: CRP-9 waits on review",
    );
  });

  it.effect("each editor pass reaches the master once, through the doorbell", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* seed;
      const store = yield* MissionStore.MissionStore;
      const feed = yield* feedOf("Bottom line: Ship the API tonight.");
      const pass: MissionEvent = yield* store.appendEvent({
        missionId,
        kind: "editor.updated",
        actor: { _tag: "system", component: "editor" },
        provenance: editor,
        summary: "Bottom line: Ship the API tonight.",
        subject: null,
      });
      yield* feed.handle(pass);
      // The same pass seen twice (a replayed stream) is the same message.
      yield* feed.handle(pass);

      const messages = yield* controlMessages;
      assert.strictEqual(messages.length, 1);
      assert.strictEqual(messages[0]!.kind, "evidence");
      assert.deepStrictEqual(messages[0]!.to, [masterRole]);
      assert.deepStrictEqual(wakesFor(h.threads.sent), [masterThread]);
      // Nothing else in the mission hears about it.
      assert.strictEqual(h.threads.sent.length, 1);

      const next = yield* store.appendEvent({
        missionId,
        kind: "editor.updated",
        actor: { _tag: "system", component: "editor" },
        provenance: editor,
        summary: "Bottom line: Hold the API until the fix lands.",
        subject: null,
      });
      yield* feed.handle(next);
      assert.strictEqual((yield* controlMessages).length, 2);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("approvals routed to the master reach it; the owner's stay his", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* seed;
      const feed = yield* feedOf(null);
      yield* feed.handle(yield* openApproval(approval("7", "owner")));
      yield* feed.handle(yield* openApproval(approval("8", null)));
      assert.strictEqual((yield* controlMessages).length, 0);

      yield* feed.handle(yield* openApproval(approval("9", "master")));
      const messages = yield* controlMessages;
      assert.strictEqual(messages.length, 1);
      assert.strictEqual(messages[0]!.kind, "request");
      assert.include(messages[0]!.summary, "acme/api#9");
      assert.deepStrictEqual(messages[0]!.to, [masterRole]);
      assert.deepStrictEqual(wakesFor(h.threads.sent), [masterThread]);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("the master routing an approval to itself is filed, not a wake", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* seed;
      const feed = yield* feedOf(null);
      yield* feed.handle(yield* openApproval(approval("10", "master"), agent(masterThread)));
      assert.strictEqual((yield* controlMessages).length, 1);
      assert.deepStrictEqual(wakesFor(h.threads.sent), []);
    }).pipe(Effect.provide(h.layer));
  });
});
