import {
  ApprovalId,
  MissionError,
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
    const rooms = yield* RouterStore.RouterStore;
    return makeMasterFeed({ router, store, rooms, digest: () => Effect.succeed(digest) });
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

const editorPass = (summary: string) =>
  Effect.gen(function* () {
    const store = yield* MissionStore.MissionStore;
    return yield* store.appendEvent({
      missionId,
      kind: "editor.updated",
      actor: { _tag: "system", component: "editor" },
      provenance: editor,
      summary,
      subject: null,
    });
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

  it.effect("the owner's note on a decision reaches the master; a bare decision does not", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* seed;
      const store = yield* MissionStore.MissionStore;
      const feed = yield* feedOf(null);
      const decide = (record: Approval, provenance: MissionProvenance, note: string | null) =>
        Effect.gen(function* () {
          const decided: Approval = { ...record, status: "approved", decisionNote: note };
          const result = yield* store.commit({
            event: {
              missionId,
              kind: "approval.decided",
              actor: { _tag: "owner" },
              provenance,
              summary: `Approved: ${record.title}`,
              subject: { kind: "approval", id: record.id },
              payload: { action: "approve", approver: "owner", note },
            },
            upserts: [{ _tag: "approval", record: decided }],
          });
          return result.event;
        });
      const owner: MissionProvenance = { _tag: "owner-app", surface: "web", sessionId: "s-1" };
      const plain = approval("11", "owner");
      const noted = {
        ...approval("12", "owner"),
        links: [
          {
            kind: "pull-request" as const,
            label: "acme/api#12",
            url: "https://github.com/acme/api/pull/12",
            ref: null,
          },
        ],
      };
      yield* openApproval(plain);
      yield* openApproval(noted);
      yield* feed.handle(yield* decide(plain, owner, null));
      yield* feed.handle(yield* decide(plain, owner, "  "));
      yield* feed.handle(yield* decide(plain, agent(masterThread), "master's own note"));
      assert.strictEqual((yield* controlMessages).length, 0);

      yield* feed.handle(yield* decide(noted, owner, "Share what the PR does next time."));
      const messages = yield* controlMessages;
      assert.strictEqual(messages.length, 1);
      assert.strictEqual(messages[0]!.kind, "decision");
      assert.include(messages[0]!.summary, "acme/api#12");
      assert.deepStrictEqual(messages[0]!.to, [masterRole]);
      const rooms = yield* RouterStore.RouterStore;
      const body = (yield* rooms.messageBody(messages[0]!.id)) ?? "";
      assert.include(body, "Share what the PR does next time.");
      assert.include(body, "https://github.com/acme/api/pull/12");
      assert.deepStrictEqual(wakesFor(h.threads.sent), [masterThread]);

      // Decided while the server was down: the restart still carries the note.
      const missed = approval("13", "owner");
      yield* openApproval(missed);
      yield* decide(missed, owner, "Smaller PRs please.");
      yield* (yield* feedOf(null)).backfill;
      const after = yield* controlMessages;
      assert.strictEqual(after.length, 2);
      assert.include((yield* rooms.messageBody(after[1]!.id)) ?? "", "Smaller PRs please.");
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

  it.effect("after downtime the master gets what it missed, once, in one message", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* seed;
      // The feed's first run starts at the present: nothing before it replays.
      const first = yield* feedOf("Bottom line: Ship the API tonight.");
      yield* openApproval(approval("1", "master"));
      yield* first.backfill;
      assert.strictEqual((yield* controlMessages).length, 0);

      // Live delivery moves the cursor, so a restart does not repeat it.
      const live = yield* openApproval(approval("2", "master"));
      yield* first.handle(live);
      assert.strictEqual((yield* controlMessages).length, 1);

      // Down: these commits reach no feed.
      yield* openApproval(approval("3", "master"));
      yield* openApproval(approval("4", "owner"));
      yield* editorPass("Bottom line: Hold the API.");
      yield* editorPass("Bottom line: Ship the API tonight.");

      // Restart: one summary to the master, holding only what it missed.
      const restarted = yield* feedOf("Bottom line: Ship the API tonight.");
      yield* restarted.backfill;
      const messages = yield* controlMessages;
      assert.strictEqual(messages.length, 2);
      const missed = messages[1]!;
      assert.strictEqual(missed.kind, "request");
      assert.deepStrictEqual(missed.to, [masterRole]);
      assert.include(missed.summary, "2 item(s)");
      const rooms = yield* RouterStore.RouterStore;
      const body = (yield* rooms.messageBody(missed.id)) ?? "";
      assert.include(body, "acme/api#3");
      assert.include(body, "Bottom line: Ship the API tonight.");
      assert.notInclude(body, "acme/api#2");
      assert.notInclude(body, "acme/api#4");
      assert.deepStrictEqual(wakesFor(h.threads.sent), [masterThread, masterThread]);

      // Once: another restart with nothing new posts nothing.
      yield* (yield* feedOf(null)).backfill;
      assert.strictEqual((yield* controlMessages).length, 2);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("a long downtime still reaches the master: no missed event is too old", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* seed;
      const store = yield* MissionStore.MissionStore;
      yield* (yield* feedOf(null)).backfill;
      // Down: an approval for the master, then a long stretch of other events.
      yield* openApproval(approval("7", "master"));
      for (let index = 0; index < 2_100; index += 1) {
        yield* store.appendEvent({
          missionId,
          kind: "mission.updated",
          actor: { _tag: "system", component: "editor" },
          provenance: editor,
          summary: `noise ${index}`,
          subject: null,
        });
      }
      yield* (yield* feedOf(null)).backfill;
      const messages = yield* controlMessages;
      assert.strictEqual(messages.length, 1);
      const rooms = yield* RouterStore.RouterStore;
      const body = (yield* rooms.messageBody(messages[0]!.id)) ?? "";
      assert.include(body, "acme/api#7");
      assert.notInclude(body, "not scanned");
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("a cursor that cannot be written neither stops the feed nor repeats a delivery", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* seed;
      yield* (yield* feedOf(null)).backfill;
      const router = yield* MissionRouter;
      const store = yield* MissionStore.MissionStore;
      const rooms = yield* RouterStore.RouterStore;
      // The cursor table fails, as a crash right after each delivery would leave it.
      const broken = makeMasterFeed({
        router,
        store,
        rooms: { ...rooms, advanceFeedCursor: () => Effect.die("disk full") },
        digest: () => Effect.succeed(null),
      });
      yield* broken.handle(yield* openApproval(approval("1", "master")));
      yield* broken.handle(yield* openApproval(approval("2", "master")));
      assert.strictEqual((yield* controlMessages).length, 2);
      const wakes = wakesFor(h.threads.sent).length;

      // The restart finds both behind the cursor but already delivered.
      yield* (yield* feedOf(null)).backfill;
      assert.strictEqual((yield* controlMessages).length, 2);
      assert.strictEqual(wakesFor(h.threads.sent).length, wakes);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("a backfill that failed replays at the next start, even after live events", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* seed;
      yield* (yield* feedOf(null)).backfill;
      // Down: the master misses #3.
      yield* openApproval(approval("3", "master"));

      // This start's replay fails; a live event still reaches the master.
      const router = yield* MissionRouter;
      const store = yield* MissionStore.MissionStore;
      const rooms = yield* RouterStore.RouterStore;
      const flaky = makeMasterFeed({
        router: {
          ...router,
          relay: (request) =>
            request.input.key?.startsWith("master-inbox:backfill:") === true
              ? Effect.fail(new MissionError({ code: "conflict", detail: "store busy" }))
              : router.relay(request),
        },
        store,
        rooms,
        digest: () => Effect.succeed(null),
      });
      yield* flaky.backfill;
      assert.strictEqual((yield* controlMessages).length, 0);
      yield* flaky.handle(yield* openApproval(approval("5", "master")));
      assert.strictEqual((yield* controlMessages).length, 1);

      // The next start replays #3, and only #3.
      yield* (yield* feedOf(null)).backfill;
      const messages = yield* controlMessages;
      assert.strictEqual(messages.length, 2);
      const body = (yield* rooms.messageBody(messages[1]!.id)) ?? "";
      assert.include(body, "acme/api#3");
      assert.notInclude(body, "acme/api#5");
      yield* (yield* feedOf(null)).backfill;
      assert.strictEqual((yield* controlMessages).length, 2);
    }).pipe(Effect.provide(h.layer));
  });
});
