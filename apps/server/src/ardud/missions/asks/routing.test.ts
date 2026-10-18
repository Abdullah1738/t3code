import { describe, expect, it } from "@effect/vitest";
import {
  ApprovalId,
  DraftId,
  RoleId,
  type MissionLink,
  type MissionProvenance,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as MissionService from "../MissionService.ts";
import * as MissionStore from "../store/MissionStore.ts";
import * as AsksService from "./AsksService.ts";
import {
  agent,
  failureCode,
  harness,
  laneThread,
  masterThread,
  missionId,
  ownerApp,
  role,
  seed,
  writerThread,
} from "./AsksService.testkit.ts";

const master = agent(masterThread);
const writer = agent(writerThread);
const laneAgent = agent(laneThread);
const crw: MissionProvenance = { _tag: "system", component: "crw" };
const ticket: MissionLink = { kind: "ticket", label: "CRP-1", url: null, ref: "CRP-1" };
const pullRequest: MissionLink = {
  kind: "pull-request",
  label: "acme/api#8",
  url: "https://github.com/acme/api/pull/8",
  ref: null,
};

const draftFor = (channel: "email" | "linear", text: string) => ({
  missionId,
  audience: "Sami",
  channel,
  target: ticket,
  text,
});

describe("draft routing", () => {
  it.effect(
    "routes drafts by the mission table; the approver decides and the owner always can",
    () => {
      const { layer } = harness();
      return Effect.gen(function* () {
        yield* seed;
        const asks = yield* AsksService.AsksService;
        const missions = yield* MissionService.MissionService;
        const store = yield* MissionStore.MissionStore;

        yield* missions.setApprovalRouting(master, {
          missionId,
          routes: [{ id: "email", match: { _tag: "draft", channel: "email" }, approver: "master" }],
          reason: "Email updates are routine",
        });

        const email = yield* asks.submitDraft(draftFor("email", "The fix is merged."), writer);
        const linear = yield* asks.submitDraft(draftFor("linear", "Merged, see CRP-1."), writer);
        expect(email.approver).toBe("master");
        expect(linear.approver).toBe("owner");
        expect(email.writtenBy).toEqual({ roleId: RoleId.make("role-writer"), model: null });

        // The owner's inbox only holds what is routed to him.
        const inbox = yield* missions.inbox(missionId);
        expect(inbox.drafts.map((draft) => draft.id)).toEqual([linear.id]);

        // Master-routed: the master decides without the owner's voice; nobody else does.
        expect(
          yield* failureCode(asks.decideDraft({ draftId: email.id, action: "approve" }, laneAgent)),
        ).toBe("forbidden");
        const byMaster = yield* asks.decideDraft(
          { draftId: email.id, action: "approve", revision: 0 },
          master,
        );
        expect(byMaster.draft.status).toBe("approved");
        // Recorded under the master's role, never as the owner.
        expect(byMaster.draft.decidedBy).toEqual({ ...master, roleId: RoleId.make("role-master") });

        // Owner-routed: the master waits for the owner.
        expect(
          yield* failureCode(asks.decideDraft({ draftId: linear.id, action: "approve" }, master)),
        ).toBe("provenance-required");

        // The owner can always decide, including a master-routed draft.
        const second = yield* asks.submitDraft(draftFor("email", "Deployed to dev."), writer);
        expect(second.approver).toBe("master");
        const byOwner = yield* asks.decideDraft({ draftId: second.id, action: "drop" }, ownerApp);
        expect(byOwner.draft.status).toBe("dropped");

        // The master re-routes one pending draft with a reason; the lane cannot.
        expect(
          yield* failureCode(
            asks.routeDraft(
              { draftId: linear.id, approver: "master", reason: "Routine" },
              laneAgent,
            ),
          ),
        ).toBe("forbidden");
        const rerouted = yield* asks.routeDraft(
          { draftId: linear.id, approver: "master", reason: "Sami's updates are routine" },
          master,
        );
        expect(rerouted.approver).toBe("master");
        expect(rerouted.routeNote).toBe("Sami's updates are routine");
        const routed = (yield* store.recentEvents(missionId, 50)).find(
          (event) => event.kind === "draft.routed",
        );
        expect(routed?.payload).toEqual({
          approver: "master",
          from: "owner",
          reason: "Sami's updates are routine",
        });
        expect((yield* missions.inbox(missionId)).drafts).toEqual([]);
        const decided = yield* asks.decideDraft(
          { draftId: linear.id, action: "approve", editedText: "Merged.", revision: 0 },
          master,
        );
        expect(decided.draft.approvedText).toBe("Merged.");
        // Only the owner's own edits teach draft notes.
        expect(decided.suggestions).toEqual([]);

        // Decided drafts are no longer routable; the master reopens what he decided.
        expect(
          yield* failureCode(
            asks.routeDraft({ draftId: linear.id, approver: "owner", reason: "Back" }, master),
          ),
        ).toBe("conflict");
        const reopened = yield* asks.reopenDraft({ draftId: linear.id }, master);
        expect(reopened.status).toBe("pending");
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("annotates waiting drafts and refuses roles that do not write public text", () => {
    const { layer } = harness();
    return Effect.gen(function* () {
      yield* seed;
      const asks = yield* AsksService.AsksService;
      const store = yield* MissionStore.MissionStore;

      const draft = yield* asks.submitDraft(draftFor("linear", "Merged."), writer);
      expect(
        yield* failureCode(
          asks.annotateDraft({ draftId: draft.id, summary: "Short update" }, laneAgent),
        ),
      ).toBe("forbidden");
      const annotated = yield* asks.annotateDraft(
        { draftId: draft.id, summary: " Short update ", flags: ["padding", "Padding", " "] },
        master,
      );
      expect(annotated.summary).toBe("Short update");
      expect(annotated.flags).toEqual(["padding"]);
      const kept = yield* asks.annotateDraft({ draftId: draft.id, flags: [] }, ownerApp);
      expect(kept.summary).toBe("Short update");
      expect(kept.flags).toEqual([]);

      // The master's switch: a role without public text hands it to a writer.
      yield* store.commit({
        event: {
          missionId,
          kind: "role.updated",
          actor: { _tag: "system", component: "test" },
          provenance: { _tag: "system", component: "test" },
          summary: "writer off",
          subject: null,
        },
        upserts: [
          { _tag: "role", record: { ...role("role-writer", "writer"), writesPublicText: false } },
        ],
      });
      expect(yield* failureCode(asks.submitDraft(draftFor("linear", "Hi."), writer))).toBe(
        "forbidden",
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("system drafts count only for their exact head; stale never counts", () => {
    const { layer } = harness();
    return Effect.gen(function* () {
      yield* seed;
      const asks = yield* AsksService.AsksService;
      const missions = yield* MissionService.MissionService;
      const head1 = "a".repeat(40);
      const head2 = "b".repeat(40);
      const open = (draftId: string, head: string, text: string) =>
        asks.openSystemDraft(
          {
            missionId,
            draftId: DraftId.make(draftId),
            requestedBy: "crw",
            audience: "acme/api#8",
            channel: "github",
            target: pullRequest,
            head,
            text,
            summary: "Two real findings",
            flags: ["core change"],
          },
          crw,
        );
      const decision = (draftId: string, head: string, by: MissionProvenance = crw) =>
        asks.systemDraftDecision({ draftId: DraftId.make(draftId), head, requestedBy: "crw" }, by);

      // Only the named system opens its drafts.
      expect(
        yield* failureCode(
          asks.openSystemDraft(
            {
              missionId,
              draftId: DraftId.make("d-x"),
              requestedBy: "crw",
              audience: "acme/api#8",
              channel: "github",
              target: pullRequest,
              head: head1,
              text: "x",
            },
            { _tag: "system", component: "governor" },
          ),
        ),
      ).toBe("forbidden");

      const first = yield* open("d-1", head1, "Feedback required: fix the retry.");
      expect(first.approver).toBe("owner");
      expect(first.head).toBe(head1);
      expect(first.flags).toEqual(["core change"]);
      expect((yield* open("d-1", head1, "Feedback required: fix the retry.")).id).toBe(first.id);
      expect(yield* failureCode(open("d-1", head2, "again"))).toBe("conflict");
      expect((yield* decision("d-1", head1)).state).toBe("pending");
      expect((yield* decision("d-1", head2)).state).toBe("stale");
      expect(
        yield* failureCode(decision("d-1", head1, { _tag: "system", component: "governor" })),
      ).toBe("forbidden");

      // A new head stale-closes the waiting draft for the old one.
      const second = yield* open("d-2", head2, "Feedback required: fix the retry and the log.");
      const stale = yield* decision("d-1", head1);
      expect(stale.state).toBe("stale");
      expect(
        yield* failureCode(asks.decideDraft({ draftId: first.id, action: "approve" }, ownerApp)),
      ).toBe("conflict");
      expect(yield* failureCode(asks.reopenDraft({ draftId: first.id }, ownerApp))).toBe(
        "conflict",
      );
      const [closed] = yield* asks.drafts({ missionId, status: ["dropped"] });
      expect(closed?.staleReason).toContain("head moved");

      // The owner edits and approves; crw reads the edited text for that head only.
      yield* asks.decideDraft(
        {
          draftId: second.id,
          action: "approve",
          editedText: "Fix the retry, please.",
          revision: 0,
        },
        ownerApp,
      );
      const approved = yield* decision("d-2", head2);
      expect(approved).toMatchObject({
        state: "approved",
        text: "Fix the retry, please.",
        edited: true,
      });
      expect((yield* decision("d-2", head1)).state).toBe("stale");
      expect(
        yield* failureCode(
          asks.closeStaleDraft(
            { draftId: second.id, requestedBy: "crw", reason: "head moved" },
            crw,
          ),
        ),
      ).toBe("conflict");

      // Approvals take the same chips, through core.
      const approvalId = ApprovalId.make("m-1:approval:crw:acme/api#8@bbbbbbbbbbbb");
      yield* missions.openApproval(crw, {
        missionId,
        approvalId,
        kind: "merge",
        title: "Good to merge: acme/api#8",
        detail: "Decide in the review thread.",
        requestedBy: "crw",
        links: [pullRequest],
        flags: ["authorization risk"],
      });
      expect(
        yield* failureCode(missions.annotateApproval(laneAgent, { approvalId, summary: "x" })),
      ).toBe("forbidden");
      yield* missions.annotateApproval(master, { approvalId, summary: "Adds a retry" });
      const [approval] = yield* missions.approvals({ missionId, ids: [approvalId] });
      expect(approval?.summary).toBe("Adds a retry");
      expect(approval?.flags).toEqual(["authorization risk"]);
    }).pipe(Effect.provide(layer));
  });
});
