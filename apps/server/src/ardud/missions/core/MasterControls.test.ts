import { assert, it } from "@effect/vitest";
import {
  LaneId,
  ProjectId,
  RoleId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ServerCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerSecretStore from "../../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../../config.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as SecretRequests from "../../../secrets/SecretRequests.ts";
import {
  agent,
  failureCode,
  harness,
  lane,
  laneThread,
  masterThread,
  missionId,
  otherMasterThread,
  otherMissionId,
  ownerApp,
  seed,
  seedOther,
  strayThread,
  writerThread,
} from "../asks/AsksService.testkit.ts";
import * as MissionStore from "../store/MissionStore.ts";
import { crowdBindings } from "./crowd.testkit.ts";
import * as MasterControls from "./MasterControls.ts";
import { MasterSecretClose, SECRET_VALUE_OWNER_ONLY, grantMasterSecretClose } from "./secrets.ts";

const card = (n: number) => TurnItemId.make(`turn-item:secret-request:${n}`);

/** Pending secret cards on the members' threads, behind the real SecretRequests. */
const fixture = () => {
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  const status = new Map<string, string>();
  const cards = new Map<string, ThreadId>();
  const open = (threadId: ThreadId, turnItemId: TurnItemId) => {
    cards.set(turnItemId, threadId);
    status.set(turnItemId, "pending");
  };
  // Cards the owner saves between the service's pending check and its record:
  // the later record changes nothing, as in the orchestrator.
  const ownerWinsRace = new Set<string>();
  // Thread reads that fail once a close went through (a crash after the close).
  const unreadableAfterClose = { on: false };
  const threads = Layer.mock(ThreadManagementService.ThreadManagementService)({
    getThreadRecords: (threadId) =>
      unreadableAfterClose.on && dispatched.length > 0
        ? Effect.fail(new Error("thread store unavailable") as never)
        : Effect.succeed({
            thread: { projectId: ProjectId.make("project-1") },
            runs: [{ id: "run-1", status: "running" }],
            turnItems: [...cards]
              .filter(([, owner]) => owner === threadId)
              .map(([id]) => ({
                id,
                threadId,
                runId: "run-1",
                nodeId: "node-root",
                type: "secret_request",
                label: "GitHub token",
                reason: "Used as GH_TOKEN.",
                secretStatus: status.get(id),
              })),
          } as never),
    dispatch: (command) =>
      Effect.sync(() => {
        dispatched.push(command);
        if (command.type === "secret_request.record") {
          status.set(
            command.turnItemId,
            ownerWinsRace.has(command.turnItemId) ? "saved" : command.secretStatus,
          );
        }
        return {} as never;
      }),
  });
  const secrets = SecretRequests.layer.pipe(
    Layer.provide(threads),
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-master-secrets-" })),
  );
  const layer = MasterControls.layer.pipe(
    Layer.provideMerge(secrets),
    Layer.provideMerge(threads),
    Layer.provideMerge(harness().layer),
  );
  return { dispatched, status, open, ownerWinsRace, unreadableAfterClose, layer };
};

const master = agent(masterThread);

it.effect("the master declines or withdraws its members' secret cards, on the timeline", () => {
  const { dispatched, status, open, layer } = fixture();
  return Effect.gen(function* () {
    yield* seed;
    const controls = yield* MasterControls.MasterControls;
    const secrets = yield* SecretRequests.SecretRequests;
    const store = yield* MissionStore.MissionStore;
    open(writerThread, card(1));
    open(laneThread, card(2));
    const start = yield* store.latestSeq(missionId);

    const declined = yield* controls.closeSecretRequest(master, {
      missionId,
      threadId: writerThread,
      turnItemId: card(1),
      closeAs: "decline",
    });
    assert.strictEqual(declined.status, "declined");
    const withdrawn = yield* controls.closeSecretRequest(master, {
      missionId,
      threadId: laneThread,
      turnItemId: card(2),
      closeAs: "withdraw",
    });
    assert.strictEqual(withdrawn.status, "cancelled");

    // The same record the owner's decline makes; nothing stored for either card.
    assert.deepStrictEqual(
      dispatched.map((command) =>
        command.type === "secret_request.record"
          ? [command.commandId, command.secretStatus]
          : [command.type],
      ),
      [
        [`secret-request:${card(1)}:declined`, "declined"],
        [`secret-request:${card(2)}:cancelled`, "cancelled"],
      ],
    );
    assert.isTrue(
      Option.isNone(yield* secrets.savedRef({ threadId: writerThread, turnItemId: card(1) })),
    );

    // Each close is on the mission timeline as the master role, with no value.
    const events = (yield* store.eventsSince(missionId, start)).filter(
      (event) => event.kind === "secret-request.closed",
    );
    assert.deepStrictEqual(
      events.map((event) => [event.seq, event.actor, event.provenance, event.payload]),
      [
        [
          declined.seq,
          { _tag: "role", roleId: "role-master" },
          { _tag: "agent", threadId: masterThread, roleId: "role-master" },
          { threadId: writerThread, turnItemId: card(1), closedAs: "declined" },
        ],
        [
          withdrawn.seq,
          { _tag: "role", roleId: "role-master" },
          { _tag: "agent", threadId: masterThread, roleId: "role-master" },
          { threadId: laneThread, turnItemId: card(2), closedAs: "cancelled" },
        ],
      ],
    );

    // A closed card stays closed: the owner's later answer is a conflict, not a save.
    assert.strictEqual(
      yield* failureCode(
        controls.closeSecretRequest(master, {
          missionId,
          threadId: writerThread,
          turnItemId: card(1),
          closeAs: "withdraw",
        }),
      ),
      "conflict",
    );
    const late = yield* secrets
      .answer(
        { threadId: writerThread, turnItemId: card(1), answer: { type: "save", secret: "x" } },
        ownerApp,
      )
      .pipe(Effect.flip);
    assert.strictEqual(late._tag, "SecretRequestError");
    assert.strictEqual(status.get(card(1)), "declined");
  }).pipe(Effect.provide(layer));
});

it.effect("only the member's own master closes its card, and never with a value", () => {
  const { dispatched, status, open, layer } = fixture();
  return Effect.gen(function* () {
    yield* seed;
    yield* seedOther;
    const controls = yield* MasterControls.MasterControls;
    const secrets = yield* SecretRequests.SecretRequests;
    open(writerThread, card(1));
    open(strayThread, card(2));
    const close = (
      provenance: Parameters<typeof controls.closeSecretRequest>[0],
      input: Partial<MasterControls.CloseSecretRequestInput> = {},
    ) =>
      failureCode(
        controls.closeSecretRequest(provenance, {
          missionId,
          threadId: writerThread,
          turnItemId: card(1),
          closeAs: "decline",
          ...input,
        }),
      );

    // A member that isn't the master, and the owner (who answers in Robob).
    assert.strictEqual(yield* close(agent(laneThread)), "forbidden");
    assert.strictEqual(yield* close(ownerApp), "forbidden");
    // Another mission's master, through either mission.
    assert.strictEqual(yield* close(agent(otherMasterThread)), "forbidden");
    assert.strictEqual(
      yield* close(agent(otherMasterThread), { missionId: otherMissionId }),
      "forbidden",
    );
    // A thread outside the mission is not the master's to close.
    assert.strictEqual(
      yield* close(master, { threadId: strayThread, turnItemId: card(2) }),
      "forbidden",
    );
    assert.strictEqual(yield* close(master, { missionId: "m-none" as never }), "not-found");
    assert.deepStrictEqual(dispatched, []);

    // The grant reaches only its own card and never a value.
    const grant = grantMasterSecretClose({
      threadId: writerThread,
      turnItemId: card(1),
      missionId,
      master,
    });
    const save = yield* secrets
      .answer(
        { threadId: writerThread, turnItemId: card(1), answer: { type: "save", secret: "x" } },
        grant,
      )
      .pipe(Effect.flip);
    assert.strictEqual(save.message, SECRET_VALUE_OWNER_ONLY);
    const elsewhere = yield* secrets
      .answer({ threadId: strayThread, turnItemId: card(2), answer: { type: "decline" } }, grant)
      .pipe(Effect.flip);
    assert.strictEqual(elsewhere.message, SECRET_VALUE_OWNER_ONLY);
    // A look-alike built without minting is no grant.
    const forged = Object.assign(Object.create(MasterSecretClose.prototype), {
      threadId: writerThread,
      turnItemId: card(1),
      missionId,
      master,
    }) as MasterSecretClose;
    const refused = yield* secrets
      .answer({ threadId: writerThread, turnItemId: card(1), answer: { type: "decline" } }, forged)
      .pipe(Effect.flip);
    assert.strictEqual(refused._tag, "EnvironmentAuthorizationError");
    assert.deepStrictEqual(dispatched, []);
    assert.strictEqual(status.get(card(1)), "pending");

    // The owner still answers the card with a value.
    yield* secrets.answer(
      { threadId: writerThread, turnItemId: card(1), answer: { type: "save", secret: "ghp" } },
      ownerApp,
    );
    assert.strictEqual(status.get(card(1)), "saved");
  }).pipe(Effect.provide(layer));
});

it.effect("N10: the master closes a member's card past the first page of bindings", () => {
  const { open, status, layer } = fixture();
  return Effect.gen(function* () {
    yield* seed;
    yield* crowdBindings;
    const controls = yield* MasterControls.MasterControls;
    open(writerThread, card(1));
    const closed = yield* controls.closeSecretRequest(master, {
      missionId,
      threadId: writerThread,
      turnItemId: card(1),
      closeAs: "withdraw",
    });
    assert.strictEqual(closed.status, "cancelled");
    assert.strictEqual(status.get(card(1)), "cancelled");
  }).pipe(Effect.provide(layer));
});

it.effect("a thread that also works in a mission the caller doesn't master keeps its cards", () => {
  const { dispatched, open, layer } = fixture();
  return Effect.gen(function* () {
    yield* seed;
    yield* seedOther;
    const controls = yield* MasterControls.MasterControls;
    const store = yield* MissionStore.MissionStore;
    // m-1's master enlists m-2's master thread on one of its lanes.
    yield* store.upsert(
      {
        _tag: "lane",
        record: { ...lane, id: LaneId.make("lane-enlisted"), threadId: otherMasterThread },
      },
      {
        missionId,
        kind: "lane.created",
        actor: { _tag: "role", roleId: RoleId.make("role-master") },
        provenance: { _tag: "agent", threadId: masterThread, roleId: RoleId.make("role-master") },
        summary: "enlist",
        subject: null,
      },
    );
    open(otherMasterThread, card(1));
    assert.strictEqual(
      yield* failureCode(
        controls.closeSecretRequest(master, {
          missionId,
          threadId: otherMasterThread,
          turnItemId: card(1),
          closeAs: "decline",
        }),
      ),
      "forbidden",
    );
    assert.deepStrictEqual(dispatched, []);
  }).pipe(Effect.provide(layer));
});

it.effect(
  "a close that loses the race to the owner's save is a conflict, and the timeline says so",
  () => {
    const { open, ownerWinsRace, status, layer } = fixture();
    return Effect.gen(function* () {
      yield* seed;
      const controls = yield* MasterControls.MasterControls;
      const store = yield* MissionStore.MissionStore;
      open(writerThread, card(1));
      ownerWinsRace.add(card(1));
      const start = yield* store.latestSeq(missionId);
      assert.strictEqual(
        yield* failureCode(
          controls.closeSecretRequest(master, {
            missionId,
            threadId: writerThread,
            turnItemId: card(1),
            closeAs: "decline",
          }),
        ),
        "conflict",
      );
      assert.strictEqual(status.get(card(1)), "saved");
      const [closed, undone] = yield* store.eventsSince(missionId, start);
      assert.strictEqual(closed?.kind, "secret-request.closed");
      assert.strictEqual(undone?.kind, "secret-request.close-failed");
      assert.strictEqual(undone?.causedBy, closed?.id);
      assert.deepStrictEqual(undone?.payload, {
        threadId: writerThread,
        turnItemId: card(1),
        closedAs: "declined",
      });
    }).pipe(Effect.provide(layer));
  },
);

it.effect("the close is on the timeline before the card closes, so it is never lost", () => {
  const { open, status, unreadableAfterClose, layer } = fixture();
  return Effect.gen(function* () {
    yield* seed;
    const controls = yield* MasterControls.MasterControls;
    const store = yield* MissionStore.MissionStore;
    open(writerThread, card(1));
    open(writerThread, card(2));
    const start = yield* store.latestSeq(missionId);

    // A card that is already closed or missing writes nothing.
    status.set(card(2), "declined");
    const close = (turnItemId: TurnItemId) =>
      controls.closeSecretRequest(master, {
        missionId,
        threadId: writerThread,
        turnItemId,
        closeAs: "decline",
      });
    assert.strictEqual(yield* failureCode(close(card(2))), "conflict");
    assert.strictEqual(yield* failureCode(close(card(9))), "not-found");
    assert.strictEqual(yield* store.latestSeq(missionId), start);

    // The card closes, then the thread store goes away before the read back.
    unreadableAfterClose.on = true;
    assert.strictEqual(yield* failureCode(close(card(1))), "invalid");
    assert.strictEqual(status.get(card(1)), "declined");
    assert.deepStrictEqual(
      (yield* store.eventsSince(missionId, start)).map((event) => event.kind),
      ["secret-request.closed"],
    );
  }).pipe(Effect.provide(layer));
});
