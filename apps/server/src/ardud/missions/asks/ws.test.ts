import { describe, expect, it } from "@effect/vitest";
import {
  ApprovalId,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  CLIENT_GUARDED_RPC_SCOPES,
  MISSIONS_ASKS_WS_METHODS,
  type MissionFeedItem,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { RPC_REQUIRED_SCOPES } from "../../../auth/RpcAuthorization.ts";
import * as RuleService from "../core/RuleService.ts";
import * as MissionService from "../MissionService.ts";
import * as AsksService from "./AsksService.ts";
import {
  agent,
  failureCode,
  governor,
  harness,
  masterThread,
  missionId,
  otherMissionId,
  ownerApp,
  seed,
  seedOther,
  writerThread,
} from "./AsksService.testkit.ts";
import { asksWsHandlers } from "./ws.ts";

const M = MISSIONS_ASKS_WS_METHODS;
const paired = {
  sessionId: "session-app",
  subject: "one-time-token",
  origin: { _tag: "owner" as const, source: "cli" as const },
};
const cliIssued = { sessionId: "session-cli", subject: "cli-issued-session" };
const ticket = { kind: "ticket" as const, label: "CRP-1", url: null, ref: "CRP-1" };

const firstItem = <A, E>(stream: Stream.Stream<A, E>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const pull = yield* Stream.toPull(stream);
      const [first] = yield* pull;
      return first;
    }),
  );

const snapshotIds = (item: MissionFeedItem | undefined) =>
  item?._tag === "snapshot"
    ? item.records.map((record) => ("id" in record.record ? record.record.id : null))
    : [];

describe("asks WS RPCs", () => {
  it("reads need read scope; writes need operate scope", () => {
    const reads = [
      M.subscribeRules,
      M.subscribeDraftNotes,
      M.subscribeRouting,
      M.inboxHistory,
      M.subscribeSuggestionStats,
      M.subscribeMasterInbox,
    ];
    const writes = [M.routeDraft, M.setDraftNoteActive, M.annotateDraft, M.annotateApproval];
    for (const method of reads) {
      expect(RPC_REQUIRED_SCOPES[method]).toBe(AuthOrchestrationReadScope);
    }
    for (const method of writes) {
      expect(CLIENT_GUARDED_RPC_SCOPES[method]).toBe(AuthOrchestrationOperateScope);
      expect(RPC_REQUIRED_SCOPES[method]).toBe(AuthOrchestrationOperateScope);
    }
  });

  it.effect("any client reads; only a paired session writes as the owner", () => {
    const { layer } = harness();
    return Effect.gen(function* () {
      yield* seed;
      const asks = yield* AsksService.AsksService;
      const rules = yield* RuleService.RuleService;
      const missions = yield* MissionService.MissionService;

      yield* rules.upsertRule(ownerApp, {
        missionId,
        title: "Small PRs",
        quote: "Keep PRs under 400 lines.",
      });
      const note = yield* asks.saveDraftNote(
        { missionId, scope: { _tag: "all" }, text: "Lead with the outcome." },
        ownerApp,
      );
      const draft = yield* asks.submitDraft(
        { missionId, audience: "Sami", channel: "linear", target: ticket, text: "Merged." },
        agent(writerThread),
      );
      yield* missions.setApprovalRouting(agent(masterThread), {
        missionId,
        routes: [{ id: "email", match: { _tag: "draft", channel: "email" }, approver: "master" }],
      });
      yield* asks.decideDraft({ draftId: draft.id, action: "approve", revision: 0 }, ownerApp);

      const cli = yield* asksWsHandlers({ surface: "cli", session: cliIssued });
      const app = yield* asksWsHandlers({ surface: "web", session: paired });

      // Reads work for a client that is not the owner.
      const ruleFeed = yield* firstItem(cli[M.subscribeRules]({ missionId }));
      expect(ruleFeed?._tag).toBe("snapshot");
      expect(ruleFeed?._tag === "snapshot" && ruleFeed.records[0]?._tag).toBe("rule");
      const noteFeed = yield* firstItem(cli[M.subscribeDraftNotes]({ missionId }));
      expect(snapshotIds(noteFeed)).toEqual([note.id]);
      const routing = yield* firstItem(cli[M.subscribeRouting]({ missionId }));
      expect(routing?.routes.map((route) => route.id)).toEqual(["email"]);
      const history = yield* cli[M.inboxHistory]({ missionId });
      expect(history.drafts.map((record) => record.id)).toEqual([draft.id]);
      expect(history.asks).toEqual([]);

      // Writes from it are refused; nothing changed.
      expect(
        yield* failureCode(cli[M.setDraftNoteActive]({ draftNoteId: note.id, active: false })),
      ).toBe("provenance-required");
      expect(yield* failureCode(cli[M.annotateDraft]({ draftId: draft.id, summary: "x" }))).toBe(
        "provenance-required",
      );
      expect((yield* asks.draftNotes(missionId)).find((n) => n.id === note.id)?.active).toBe(true);

      // The paired session writes as the owner.
      const off = yield* app[M.setDraftNoteActive]({ draftNoteId: note.id, active: false });
      expect(off.active).toBe(false);
      expect(off.writtenBy).toEqual({ _tag: "owner" });
    }).pipe(Effect.provide(RuleService.layer.pipe(Layer.provideMerge(layer))));
  });

  it.effect("the master's queue and suggestion record are real feeds", () => {
    const { layer } = harness();
    return Effect.gen(function* () {
      yield* seed;
      yield* seedOther;
      const asks = yield* AsksService.AsksService;
      const missions = yield* MissionService.MissionService;
      const master = agent(masterThread);
      yield* missions.setApprovalRouting(master, {
        missionId,
        routes: [
          { id: "email", match: { _tag: "draft", channel: "email" }, approver: "master" },
          { id: "merges", match: { _tag: "approval", kind: "merge" }, approver: "master" },
        ],
      });
      const approvalId = ApprovalId.make("m-1:approval:crw:acme/api#8");
      yield* missions.openApproval(
        { _tag: "system", component: "crw" },
        {
          missionId,
          approvalId,
          kind: "merge",
          title: "Good to merge: acme/api#8",
          detail: "Decide in the review thread.",
          requestedBy: "crw",
          links: [],
        },
      );
      const draft = (channel: "email" | "linear", text: string) =>
        asks.submitDraft(
          { missionId, audience: "Sami", channel, target: ticket, text },
          agent(writerThread),
        );
      const email = yield* draft("email", "The fix is merged.");
      yield* draft("linear", "Merged, see CRP-1.");
      const pool = yield* asks.proposeSuggestion(
        {
          missionId,
          targetKind: "pool",
          title: "Raise the pool",
          after: { size: 3 },
          diffText: "size -> 3",
          why: "Lanes queue.",
          evidence: [{ kind: "lane", id: "lane-api" }],
        },
        governor,
      );
      expect(pool.acceptor).toBe("master");
      const cli = yield* asksWsHandlers({ surface: "cli", session: cliIssued });

      const elsewhere = yield* firstItem(
        cli[M.subscribeMasterInbox]({ missionId: otherMissionId }),
      );
      expect(elsewhere?.counts).toEqual({ approve: 0, suggestions: 0 });

      const row = {
        missionId,
        author: "governor",
        targetKind: "pool",
        shown: 1,
        accepted: 0,
        dismissed: 0,
        applied: 0,
        bar: "normal",
      };
      // The record follows decisions: one update per change.
      yield* Effect.scoped(
        Effect.gen(function* () {
          const pull = yield* Stream.toPull(cli[M.subscribeSuggestionStats]({ missionId }));
          const [first] = yield* pull;
          expect(first).toEqual([row]);
          yield* asks.decideSuggestion(
            { suggestionId: pool.id, action: "dismiss", dismissReason: "Not now" },
            master,
          );
          const [next] = yield* pull;
          expect(next).toEqual([{ ...row, dismissed: 1 }]);
        }),
      );

      // The master's queue holds what is routed to it, and follows decisions.
      yield* asks.proposeSuggestion(
        {
          missionId,
          targetKind: "pool",
          title: "Raise the pool again",
          after: { size: 4 },
          diffText: "size -> 4",
          why: "Lanes still queue.",
          evidence: [{ kind: "lane", id: "lane-api" }],
        },
        governor,
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const pull = yield* Stream.toPull(cli[M.subscribeMasterInbox]({ missionId: null }));
          const [first] = yield* pull;
          expect(first?.counts).toEqual({ approve: 2, suggestions: 1 });
          expect(first?.drafts.map((record) => record.id)).toEqual([email.id]);
          expect(first?.approvals.map((record) => record.id)).toEqual([approvalId]);
          yield* asks.decideDraft({ draftId: email.id, action: "approve", revision: 0 }, master);
          const [next] = yield* pull;
          expect(next?.counts).toEqual({ approve: 1, suggestions: 1 });
          expect(next?.drafts).toEqual([]);
        }),
      );
    }).pipe(Effect.provide(RuleService.layer.pipe(Layer.provideMerge(layer))));
  });
});
