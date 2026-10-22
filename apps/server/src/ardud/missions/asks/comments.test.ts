import { describe, expect, it } from "@effect/vitest";
import {
  ApprovalId,
  DraftId,
  type Knock,
  KnockId,
  type MissionLink,
  type MissionProvenance,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Scheduler from "effect/Scheduler";
import * as TestClock from "effect/testing/TestClock";

import * as MissionService from "../MissionService.ts";
import * as MissionStore from "../store/MissionStore.ts";
import * as AsksService from "./AsksService.ts";
import {
  agent,
  askInput,
  at,
  failureCode,
  governor,
  harness,
  laneThread,
  masterThread,
  missionId,
  ownerApp,
  seed,
  strayThread,
  writerThread,
} from "./AsksService.testkit.ts";
import { askResolvedLine } from "./ports.ts";

const master = agent(masterThread);
const writer = agent(writerThread);
const crw: MissionProvenance = { _tag: "system", component: "crw" };
const ticket: MissionLink = { kind: "ticket", label: "CRP-1", url: null, ref: "CRP-1" };
const pullRequest = (number: number): MissionLink => ({
  kind: "pull-request",
  label: `acme/api#${number}`,
  url: `https://github.com/acme/api/pull/${number}`,
  ref: null,
});
const toMaster = { _tag: "role", roleId: "role-master" };
const toWriter = { _tag: "role", roleId: "role-writer" };

describe("owner comments travel with his decisions", () => {
  it.effect("an approved draft with comments tells the writer to apply them", () => {
    const { posts, layer } = harness();
    return Effect.gen(function* () {
      yield* seed;
      const asks = yield* AsksService.AsksService;
      const draft = yield* asks.submitDraft(
        {
          missionId,
          audience: "Pavan",
          channel: "linear",
          target: ticket,
          text: "Hi Pavan. Quick one. Order: ship the retry first.",
        },
        writer,
      );

      // A comment before the decision reaches the writer and the master.
      yield* asks.commentInboxItem(
        {
          subject: { kind: "draft", id: draft.id },
          body: "Remove the first sentence when you send",
        },
        ownerApp,
      );
      expect(posts).toHaveLength(1);
      expect(posts[0]?.input).toMatchObject({ kind: "request", to: [toWriter, toMaster] });

      // He approves without editing and leaves a second note with the decision.
      const decided = yield* asks.decideDraft(
        {
          draftId: draft.id,
          action: "approve",
          revision: 0,
          note: "And the second sentence, it should just start with Order:",
        },
        ownerApp,
      );
      expect(decided.draft.status).toBe("approved");
      const mark = (yield* asks.desk(missionId)).marks.find(
        (each) => each.id === `draft:${draft.id}`,
      );
      expect(mark?.comments.map((comment) => comment.body)).toEqual([
        "Remove the first sentence when you send",
        "And the second sentence, it should just start with Order:",
      ]);

      // The writer's notice: apply the comments, then record the text that went out.
      const notice = posts[1];
      expect(notice?.input).toMatchObject({
        kind: "decision",
        to: [toWriter],
        key: `draft:${draft.id}:approved:0`,
      });
      const body = notice?.input.body ?? "";
      expect(body).toContain("Apply every comment");
      expect(body).not.toContain("Post exactly this text");
      expect(body).toContain("- Remove the first sentence when you send");
      expect(body).toContain("- And the second sentence, it should just start with Order:");
      // The master hears the same comments in its own notice.
      expect(posts[2]?.input).toMatchObject({ to: [toMaster] });
      expect(posts[2]?.input.body).toContain("- Remove the first sentence when you send");
      expect(posts).toHaveLength(3);

      // The send must say what went out.
      expect(yield* failureCode(asks.recordDraftSent({ draftId: draft.id }, writer))).toBe(
        "invalid",
      );
      const sent = yield* asks.recordDraftSent(
        { draftId: draft.id, text: "Order: ship the retry first." },
        writer,
      );
      expect(sent).toMatchObject({ status: "sent", sentText: "Order: ship the retry first." });

      // A comment after it went out still reaches the writer and the master.
      yield* asks.commentInboxItem(
        { subject: { kind: "draft", id: draft.id }, body: "Good, keep it that short." },
        ownerApp,
      );
      expect(posts[3]?.input).toMatchObject({ kind: "request", to: [toWriter, toMaster] });
      expect(posts[3]?.input.body).toContain("already went out");
      expect(posts[3]?.input.body).toContain("- Good, keep it that short.");

      // The reads carry the comments; an item nobody commented on carries none.
      const plain = yield* asks.submitDraft(
        { missionId, audience: "Sami", channel: "linear", target: ticket, text: "Merged." },
        writer,
      );
      const read = yield* asks.withComments("draft", yield* asks.drafts({ missionId }));
      expect(read.find((each) => each.id === draft.id)?.comments).toHaveLength(3);
      expect(read.find((each) => each.id === plain.id)?.comments).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.effect("a plain approval keeps the old notice", () => {
    const { posts, layer } = harness();
    return Effect.gen(function* () {
      yield* seed;
      const asks = yield* AsksService.AsksService;
      const draft = yield* asks.submitDraft(
        { missionId, audience: "Sami", channel: "linear", target: ticket, text: "Merged." },
        writer,
      );
      yield* asks.decideDraft({ draftId: draft.id, action: "approve", revision: 0 }, ownerApp);
      expect(posts).toHaveLength(1);
      expect(posts[0]?.input.body).toContain("Post exactly this text once");
      expect(posts[0]?.input.body).not.toContain("comments");
      expect(yield* asks.recordDraftSent({ draftId: draft.id }, writer)).toMatchObject({
        status: "sent",
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("only the owner leaves a note with a decision", () => {
    const { layer } = harness();
    return Effect.gen(function* () {
      yield* seed;
      const asks = yield* AsksService.AsksService;
      const missions = yield* MissionService.MissionService;
      yield* missions.setApprovalRouting(master, {
        missionId,
        routes: [{ id: "email", match: { _tag: "draft", channel: "email" }, approver: "master" }],
      });
      const draft = yield* asks.submitDraft(
        { missionId, audience: "Sami", channel: "email", target: ticket, text: "Merged." },
        writer,
      );
      expect(
        yield* failureCode(
          asks.decideDraft(
            { draftId: draft.id, action: "approve", revision: 0, note: "Shorter." },
            master,
          ),
        ),
      ).toBe("forbidden");
      // A blank note is no note.
      const decided = yield* asks.decideDraft(
        { draftId: draft.id, action: "approve", revision: 0, note: "  " },
        master,
      );
      expect(decided.draft.status).toBe("approved");
      expect((yield* asks.desk(missionId)).marks).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("crw never reads a commented draft as post-as-is", () => {
    const { layer } = harness();
    return Effect.gen(function* () {
      yield* seed;
      const asks = yield* AsksService.AsksService;
      const head = "a".repeat(40);
      const open = (draftId: string, number: number) =>
        asks.openSystemDraft(
          {
            missionId,
            draftId: DraftId.make(draftId),
            requestedBy: "crw",
            audience: `acme/api#${number}`,
            channel: "github",
            target: pullRequest(number),
            head,
            text: "Feedback required: fix the retry. Also the log line.",
          },
          crw,
        );
      const decision = (draftId: string) =>
        asks.systemDraftDecision({ draftId: DraftId.make(draftId), head, requestedBy: "crw" }, crw);

      // Approved with a note and no edit: crw gets the existing rewrite path with the comments.
      const noted = yield* open("d-1", 8);
      yield* asks.decideDraft(
        { draftId: noted.id, action: "approve", revision: 0, note: "Drop the log line." },
        ownerApp,
      );
      const first = yield* decision("d-1");
      expect(first.state).toBe("rewrite-requested");
      expect(first.text).toBeNull();
      expect(first.rewriteNote).toContain("- Drop the log line.");
      expect(first.comments?.map((comment) => comment.body)).toEqual(["Drop the log line."]);

      // Approved as written, then a comment before crw posts it: sent back the same way.
      const plain = yield* open("d-2", 9);
      yield* asks.decideDraft({ draftId: plain.id, action: "approve", revision: 0 }, ownerApp);
      expect((yield* decision("d-2")).state).toBe("approved");
      yield* asks.commentInboxItem(
        { subject: { kind: "draft", id: plain.id }, body: "Say please." },
        ownerApp,
      );
      const second = yield* decision("d-2");
      expect(second.state).toBe("rewrite-requested");
      expect(second.rewriteNote).toContain("- Say please.");

      // A later comment while it is back with crw joins the note crw reads.
      yield* asks.commentInboxItem(
        { subject: { kind: "draft", id: plain.id }, body: "And thank them." },
        ownerApp,
      );
      const third = yield* decision("d-2");
      expect(third.rewriteNote).toContain("- Say please.\n- And thank them.");
      // crw already forwarded the first rewrite: the changed revision tells it to forward again.
      expect(second.commentsRevision).toBeDefined();
      expect(third.commentsRevision).not.toBe(second.commentsRevision);
      expect(yield* decision("d-2")).toEqual(third);

      // His own rewrite note carries the comments too.
      const rewritten = yield* open("d-3", 10);
      yield* asks.commentInboxItem(
        { subject: { kind: "draft", id: rewritten.id }, body: "Mention the flaky test." },
        ownerApp,
      );
      yield* asks.decideDraft(
        { draftId: rewritten.id, action: "rewrite", rewriteNote: "Shorter." },
        ownerApp,
      );
      const fourth = yield* decision("d-3");
      expect(fourth.rewriteNote).toContain("Shorter.");
      expect(fourth.rewriteNote).toContain("- Mention the flaky test.");

      // An edit with a note: crw would post the edit without the note, so it is refused.
      const edited = yield* open("d-4", 11);
      expect(
        yield* failureCode(
          asks.decideDraft(
            {
              draftId: edited.id,
              action: "approve",
              revision: 0,
              editedText: "Fix the retry.",
              note: "Tag Pavan.",
            },
            ownerApp,
          ),
        ),
      ).toBe("invalid");
    }).pipe(Effect.provide(layer));
  });

  it.effect("comments on text a revision replaced are history, not changes to make", () => {
    const { posts, layer } = harness();
    return Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(at));
      yield* seed;
      const asks = yield* AsksService.AsksService;
      const draft = yield* asks.submitDraft(
        {
          missionId,
          audience: "Pavan",
          channel: "linear",
          target: ticket,
          text: "Hi. Order: ship.",
        },
        writer,
      );
      yield* asks.commentInboxItem(
        { subject: { kind: "draft", id: draft.id }, body: "Remove the first sentence." },
        ownerApp,
      );
      yield* asks.decideDraft(
        { draftId: draft.id, action: "rewrite", rewriteNote: "Apply my comment." },
        ownerApp,
      );
      yield* TestClock.adjust("1 minute");
      const revised = yield* asks.reviseDraft({ draftId: draft.id, text: "Order: ship." }, writer);
      yield* asks.decideDraft(
        { draftId: draft.id, action: "approve", revision: revised.revision ?? 0 },
        ownerApp,
      );
      const notice = posts.at(-1)?.input;
      expect(notice?.to).toEqual([toWriter]);
      expect(notice?.body).toContain("Post exactly this text once");
      expect(notice?.body).not.toContain("Remove the first sentence.");
      const sent = yield* asks.recordDraftSent({ draftId: draft.id }, writer);
      expect(sent.status).toBe("sent");
    }).pipe(Effect.provide(layer));
  });

  it.effect("an ask answer, a suggestion, a call and an approval carry the note", () => {
    const { posts, signals, layer } = harness();
    return Effect.gen(function* () {
      yield* seed;
      const asks = yield* AsksService.AsksService;
      const missions = yield* MissionService.MissionService;

      // Ask: the asker hears the comments with the answer; the master in its own notice.
      const ask = yield* asks.openAsk(askInput("Online or offline?"), agent(laneThread));
      const answered = yield* asks.answerAsk(
        { askId: ask.id, optionId: "a", text: "", note: "Tell Sami before you start." },
        ownerApp,
      );
      expect(signals[0]?.comments?.map((comment) => comment.body)).toEqual([
        "Tell Sami before you start.",
      ]);
      expect(askResolvedLine(answered.ask, answered.released, signals[0]?.comments)).toContain(
        "- Tell Sami before you start.",
      );
      expect(posts.at(-1)?.input).toMatchObject({ kind: "decision", to: [toMaster] });
      expect(posts.at(-1)?.input.body).toContain("- Tell Sami before you start.");
      const [readAsk] = yield* asks.withComments("ask", [yield* asks.ask(ask.id)]);
      expect(readAsk?.comments?.map((comment) => comment.body)).toEqual([
        "Tell Sami before you start.",
      ]);

      // Suggestion: the master hears why.
      const suggestion = yield* asks.proposeSuggestion(
        {
          missionId,
          targetKind: "pool",
          title: "Raise pool",
          after: { size: 3 },
          diffText: "size -> 3",
          why: "Lanes queue.",
          evidence: [{ kind: "lane", id: "lane-api" }],
        },
        governor,
      );
      const before = posts.length;
      yield* asks.decideSuggestion(
        {
          suggestionId: suggestion.id,
          action: "dismiss",
          dismissReason: "no",
          note: "Ask again when the queue is over ten.",
        },
        ownerApp,
      );
      expect(posts.length).toBe(before + 1);
      expect(posts.at(-1)?.input.body).toContain("- Ask again when the queue is over ten.");

      // Call reaction note: whoever made the call and the master hear it.
      const call = yield* asks.makeCall(
        { missionId, title: "Postgres", decision: "Use Postgres.", reason: "Writers." },
        master,
      );
      yield* asks.reactToCall(
        { callId: call.id, reaction: "ok", note: "Fine, watch the cost." },
        ownerApp,
      );
      expect(posts.at(-1)?.input).toMatchObject({ to: [toMaster] });
      expect(posts.at(-1)?.input.body).toContain("- Fine, watch the cost.");
      const laneCall = yield* asks.makeCall(
        { missionId, title: "Retry", decision: "Retry twice.", reason: "Flaky." },
        agent(laneThread),
      );
      yield* asks.reactToCall(
        { callId: laneCall.id, reaction: "ok", note: "Three times is fine too." },
        ownerApp,
      );
      expect(posts.at(-1)?.input.to).toContainEqual(laneCall.decidedBy);
      expect(posts.at(-1)?.input.to).toContainEqual(toMaster);

      // Approval: the note is saved as a comment and is what crw reads as the decision note.
      const approvalId = ApprovalId.make("m-1:approval:crw:acme/api#8@bbbbbbbbbbbb");
      yield* missions.openApproval(crw, {
        missionId,
        approvalId,
        kind: "merge",
        title: "Good to merge: acme/api#8",
        detail: "Decide in the review thread.",
        requestedBy: "crw",
        links: [pullRequest(8)],
      });
      yield* asks.commentInboxItem(
        { subject: { kind: "approval", id: approvalId }, body: "Squash it." },
        ownerApp,
      );
      yield* missions.decideApproval(ownerApp, {
        approvalId,
        action: "approve",
        note: "Delete the branch after.",
      });
      const [approval] = yield* asks.withComments(
        "approval",
        yield* missions.approvals({ missionId, ids: [approvalId] }),
      );
      expect(approval?.decisionNote).toBe("Squash it.\nDelete the branch after.");
      expect(approval?.comments?.map((comment) => comment.body)).toEqual([
        "Squash it.",
        "Delete the branch after.",
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("a comment after an approval is decided reaches its requester", () => {
    const { posts, layer } = harness();
    return Effect.gen(function* () {
      yield* seed;
      const asks = yield* AsksService.AsksService;
      const missions = yield* MissionService.MissionService;
      const approvalId = ApprovalId.make("m-1:approval:crw:acme/api#9@cccccccccccc");
      yield* missions.openApproval(crw, {
        missionId,
        approvalId,
        kind: "merge",
        title: "Good to merge: acme/api#9",
        detail: "Decide in the review thread.",
        requestedBy: "crw",
        links: [pullRequest(9)],
      });
      yield* missions.decideApproval(ownerApp, {
        approvalId,
        action: "approve",
        note: "Squash it.",
      });
      const before = posts.length;
      yield* asks.commentInboxItem(
        { subject: { kind: "approval", id: approvalId }, body: "Wait for the deploy window." },
        ownerApp,
      );

      // crw reads the decision note from /approvals, so the late comment is on it.
      const [approval] = yield* missions.approvals({ missionId, ids: [approvalId] });
      expect(approval?.status).toBe("approved");
      expect(approval?.decisionNote).toBe("Squash it.\nWait for the deploy window.");
      expect(posts.length).toBe(before + 1);
      expect(posts.at(-1)?.input.to).toEqual([toMaster]);
      expect(posts.at(-1)?.input.body).toContain("crw reads the comment in the decision note");
      expect(posts.at(-1)?.input.body).toContain("- Wait for the deploy window.");

      // A pending approval's note is written when he decides, not by a comment.
      const pendingId = ApprovalId.make("m-1:approval:crw:acme/api#10@dddddddddddd");
      yield* missions.openApproval(crw, {
        missionId,
        approvalId: pendingId,
        kind: "merge",
        title: "Good to merge: acme/api#10",
        detail: "Decide in the review thread.",
        requestedBy: "crw",
        links: [pullRequest(10)],
      });
      yield* asks.commentInboxItem(
        { subject: { kind: "approval", id: pendingId }, body: "Not yet." },
        ownerApp,
      );
      const [pending] = yield* missions.approvals({ missionId, ids: [pendingId] });
      expect(pending?.decisionNote ?? null).toBeNull();
    }).pipe(Effect.provide(layer));
  });

  it.effect("a comment racing a decision note on the same item keeps both", () => {
    const { layer } = harness();
    return Effect.gen(function* () {
      yield* seed;
      const asks = yield* AsksService.AsksService;
      const missions = yield* MissionService.MissionService;
      const store = yield* MissionStore.MissionStore;
      const approvalId = ApprovalId.make("m-1:approval:crw:acme/api#11@eeeeeeeeeeee");
      yield* missions.openApproval(crw, {
        missionId,
        approvalId,
        kind: "merge",
        title: "Good to merge: acme/api#11",
        detail: "Decide in the review thread.",
        requestedBy: "crw",
        links: [pullRequest(11)],
      });
      // Yield on every op so the two writes interleave between read and commit.
      yield* Effect.all(
        [
          asks.commentInboxItem(
            { subject: { kind: "approval", id: approvalId }, body: "Check the migration." },
            ownerApp,
          ),
          missions.decideApproval(ownerApp, { approvalId, action: "approve", note: "Ship it." }),
        ],
        { concurrency: "unbounded", discard: true },
      ).pipe(Effect.provideService(Scheduler.MaxOpsBeforeYield, 8));

      const mark = yield* store.get("inbox-mark", `approval:${approvalId}`);
      const bodies = mark._tag === "Some" ? mark.value.comments.map((each) => each.body) : [];
      expect([...bodies].toSorted()).toEqual(["Check the migration.", "Ship it."]);
      const [approval] = yield* missions.approvals({ missionId, ids: [approvalId] });
      expect(approval?.decisionNote?.split("\n").toSorted()).toEqual([
        "Check the migration.",
        "Ship it.",
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("a comment on a pending knock to the master stays with the owner", () => {
    const { posts, layer } = harness();
    return Effect.gen(function* () {
      yield* seed;
      const asks = yield* AsksService.AsksService;
      const store = yield* MissionStore.MissionStore;
      const knock = (id: string, targetThreadId: ThreadId): Knock => ({
        id: KnockId.make(id),
        missionId,
        fromThreadId: strayThread,
        fromTitle: "Stray",
        path: "thread-send",
        summary: "Wants a look at its PR",
        body: "please look at my PR",
        status: "pending",
        forwardedText: null,
        forwardedTo: null,
        decidedAt: null,
        createdAt: at,
        targetThreadId,
      });
      yield* store.commit({
        event: {
          missionId,
          kind: "knock.received",
          actor: { _tag: "system", component: "test" },
          provenance: { _tag: "system", component: "test" },
          summary: "knocks",
          subject: null,
        },
        upserts: [
          { _tag: "knock", record: knock("knock-master", masterThread) },
          { _tag: "knock", record: knock("knock-lane", laneThread) },
        ],
      });

      yield* asks.commentInboxItem(
        { subject: { kind: "knock", id: KnockId.make("knock-master") }, body: "Ignore it." },
        ownerApp,
      );
      expect(posts).toHaveLength(0);

      // A knock to anyone else is the master's to see, so it hears the comment.
      yield* asks.commentInboxItem(
        { subject: { kind: "knock", id: KnockId.make("knock-lane") }, body: "Not now." },
        ownerApp,
      );
      expect(posts).toHaveLength(1);
      expect(posts[0]?.input.to).toEqual([toMaster]);
    }).pipe(Effect.provide(layer));
  });
});
