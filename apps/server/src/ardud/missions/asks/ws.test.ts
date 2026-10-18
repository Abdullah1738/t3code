import { describe, expect, it } from "@effect/vitest";
import {
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
  harness,
  masterThread,
  missionId,
  ownerApp,
  seed,
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
      M.subscribeForks,
      M.subscribeDraftNotes,
      M.subscribeRouting,
      M.inboxHistory,
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
      const fork = yield* asks.startFork(
        {
          missionId,
          kind: "owner-question",
          origin: { kind: "draft", id: draft.id },
          question: "Why the retry?",
        },
        ownerApp,
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
      const forkFeed = yield* firstItem(cli[M.subscribeForks]({ missionId }));
      expect(snapshotIds(forkFeed)).toEqual([fork.fork.id]);
      const forkRecord = forkFeed?._tag === "snapshot" ? forkFeed.records[0] : undefined;
      expect(forkRecord?._tag === "fork" && forkRecord.record.question).toBe("Why the retry?");
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
});
