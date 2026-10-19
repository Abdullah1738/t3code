import { describe, expect, it } from "@effect/vitest";
import {
  ApprovalId,
  AskId,
  EnvironmentId,
  MissionError,
  OwnerRequestId,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
  WorkItemId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { McpSchema, McpServer } from "effect/ai";

import * as McpHttpServer from "../../../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../../../mcp/McpInvocationContext.ts";
import { liveThreadsLayer } from "../../../mcp/McpToolAccess.testkit.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as SecretRequests from "../../../secrets/SecretRequests.ts";
import * as AsksService from "../asks/AsksService.ts";
import {
  askInput,
  at,
  harness,
  laneThread,
  masterThread,
  missionId,
  ownerApp,
  seed,
  strayThread,
  typedInbound,
  writerThread,
} from "../asks/AsksService.testkit.ts";
import { crowdMissions } from "../core/crowd.testkit.ts";
import * as MasterControls from "../core/MasterControls.ts";
import { MasterSecretClose } from "../core/secrets.ts";
import type { InboundMessage } from "../asks/provenance.ts";
import * as RuleService from "../core/RuleService.ts";
import * as MissionService from "../MissionService.ts";
import * as MissionStore from "../store/MissionStore.ts";
import { OwnerConditions } from "../discuss/OwnerConditions.ts";
import * as MissionsHandlers from "./handlers.ts";
import { MissionsToolkit } from "./tools.ts";

const threadCaller = (threadId: ThreadId): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment"),
  requestNamespace: `provider:${threadId}`,
  thread: {
    threadId,
    providerSessionId: `provider:${threadId}`,
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
});

const clientCaller: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment"),
  requestNamespace: "client:session",
  thread: undefined,
  client: { sessionId: "session", label: "Claude Code", access: "full-access" },
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
};

const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "mcp-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const toolsLayer = (inbound: Parameters<typeof harness>[0] = []) => {
  const { layer } = harness(inbound);
  // What the tools hand the secret service: the card and who answers it.
  const answered: Array<Parameters<SecretRequests.SecretRequests["Service"]["answer"]>> = [];
  const secrets = Layer.mock(SecretRequests.SecretRequests)({
    answer: (...args) => Effect.sync(() => void answered.push(args)),
  });
  // The card as the close left it, for the service's read-back.
  const cards = Layer.mock(ThreadManagementService.ThreadManagementService)({
    getThreadRecords: (threadId) =>
      Effect.succeed({
        turnItems: answered
          .filter(([input]) => input.threadId === threadId)
          .map(([input]) => ({
            id: input.turnItemId,
            type: "secret_request",
            secretStatus: input.answer.type === "decline" ? "declined" : "cancelled",
          })),
      } as never),
  });
  return {
    answered,
    layer: McpHttpServer.toolkitRegistration(MissionsToolkit, MissionsHandlers.layer).pipe(
      Layer.provideMerge(McpServer.McpServer.layer),
      Layer.provideMerge(liveThreadsLayer),
      Layer.provideMerge(RuleService.layer),
      Layer.provideMerge(MasterControls.layer.pipe(Layer.provide([secrets, cards]))),
      Layer.provideMerge(layer),
    ),
  };
};

interface ToolOutcome {
  readonly isError: boolean;
  readonly text: string;
  readonly structured: Record<string, unknown>;
}

const call = (
  name: string,
  scope: McpInvocationContext.McpInvocationScope,
  args: Record<string, unknown>,
) =>
  McpServer.McpServer.pipe(
    Effect.flatMap((server) => server.callTool({ name, arguments: args })),
    Effect.map((result): ToolOutcome => ({
      isError: result.isError === true,
      text: result.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
      structured: (result.structuredContent as Record<string, unknown> | undefined) ?? {},
    })),
    Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
    Effect.provideService(McpSchema.McpServerClient, mcpClient),
  );

describe("mission MCP tools", () => {
  it.effect("asks as the calling thread and refuses identity or defaults in parameters", () => {
    const { layer } = toolsLayer();
    return Effect.gen(function* () {
      yield* seed;
      const master = threadCaller(masterThread);

      const opened = yield* call("mission_ask", master, askInput("Online or offline?"));
      expect(opened.isError).toBe(false);
      const ask = opened.structured.ask as { id: string; askedBy: unknown; status: string };
      // The asker is the role the calling thread holds, not anything it sent.
      expect(ask.askedBy).toEqual({ _tag: "role", roleId: "role-master" });
      expect(ask.status).toBe("open");

      // Strict parameters: identity and default-on-silence keys are refused outright.
      for (const extra of [
        { askedBy: { _tag: "owner" } },
        { default: "a" },
        { provenance: { _tag: "owner-app", surface: "web", sessionId: null } },
      ]) {
        const refused = yield* Effect.exit(call("mission_ask", master, askInput("Again?", extra)));
        const outcome = refused._tag === "Success" ? refused.value : null;
        // Either the MCP layer rejects the params or the tool returns an error; never an ask.
        expect(outcome === null || outcome.isError).toBe(true);
      }

      // A thread with no role or lane in the mission cannot ask.
      const stray = yield* call("mission_ask", threadCaller(strayThread), askInput("Stray?"));
      expect(stray.isError).toBe(true);
      expect(stray.text).toContain("forbidden");

      // A signed-in MCP client is not a T3 thread: writes need one.
      const client = yield* call("mission_ask", clientCaller, askInput("Client?"));
      expect(client.isError).toBe(true);

      // Reads work for any caller.
      const listed = yield* call("mission_asks", clientCaller, { missionId, status: ["open"] });
      expect(listed.isError).toBe(false);
      expect((listed.structured.asks as ReadonlyArray<unknown>).length).toBe(1);
    }).pipe(Effect.provide(layer));
  });

  it.effect("never lets an agent redeem the owner's iMessage to answer an ask", () => {
    const inbox: Array<InboundMessage> = [];
    const { layer } = toolsLayer(inbox);
    return Effect.gen(function* () {
      yield* seed;
      const master = threadCaller(masterThread);
      const opened = yield* call("mission_ask", master, askInput("Online or offline?"));
      const askId = (opened.structured.ask as { id: string }).id;
      inbox.push(typedInbound("spc-msg-9", "offline window please", Date.parse(at) + 60_000));

      // Even a genuine typed iMessage id does nothing here: the tool has no inbound
      // parameter, and the master has no owner condition, so the answer is refused.
      const missing = yield* Effect.exit(call("mission_ask_answer", master, { askId, text: "b" }));
      expect(missing._tag === "Failure" || missing.value.isError).toBe(true);
      const smuggled = yield* Effect.exit(
        call("mission_ask_answer", master, {
          askId,
          optionId: "b",
          text: "",
          inboundId: "spc-msg-9",
        }),
      );
      expect(smuggled._tag === "Failure" || smuggled.value.isError).toBe(true);
      const asks = yield* AsksService.AsksService;
      const ask = yield* asks.ask(AskId.make(askId));
      expect(ask.status).toBe("open");
    }).pipe(Effect.provide(layer));
  });

  it.effect("drafts carry the owner's notes and agents cannot approve his drafts by tool", () => {
    const inbox: Array<InboundMessage> = [];
    const { layer } = toolsLayer(inbox);
    return Effect.gen(function* () {
      yield* seed;
      const asks = yield* AsksService.AsksService;
      yield* asks.saveDraftNote(
        { missionId: null, scope: { _tag: "channel", channel: "cliq" }, text: "No opener." },
        ownerApp,
      );
      const writer = threadCaller(writerThread);
      const guide = yield* call("mission_drafts", writer, {
        missionId,
        guideFor: { channel: "cliq", audience: "Sam" },
      });
      expect((guide.structured.guide as { notes: ReadonlyArray<unknown> }).notes.length).toBe(1);

      const submitted = yield* call("mission_draft", writer, {
        missionId,
        audience: "Sam",
        channel: "cliq",
        target: { kind: "url", label: "Cliq DM", url: null, ref: "sam" },
        text: "Deploy is done.",
      });
      expect(submitted.isError).toBe(false);
      const draft = submitted.structured.draft as { id: string; appliedNoteIds: string[] };
      expect(draft.appliedNoteIds.length).toBe(1);
      inbox.push(typedInbound("spc-msg-2", "ok send it", Date.parse(at) + 60_000));

      // A lane or writer thread naming the owner's iMessage is refused either way.
      for (const caller of [threadCaller(laneThread), writer]) {
        const refused = yield* Effect.exit(
          call("mission_draft_approve", caller, {
            draftId: draft.id,
            action: "approve",
            revision: 0,
            inboundId: "spc-msg-2",
          }),
        );
        expect(refused._tag === "Failure" || refused.value.isError).toBe(true);
      }
      const still = yield* asks.drafts({ missionId });
      expect(still.find((row) => row.id === draft.id)?.status).toBe("pending");
    }).pipe(Effect.provide(layer));
  });

  it.effect("lets the master route, annotate and decide drafts and keep draft notes", () => {
    const { layer } = toolsLayer();
    return Effect.gen(function* () {
      yield* seed;
      const master = threadCaller(masterThread);
      const writer = threadCaller(writerThread);
      const submitted = yield* call("mission_draft", writer, {
        missionId,
        audience: "Sam",
        channel: "cliq",
        target: { kind: "url", label: "Cliq DM", url: null, ref: "sam" },
        text: "Deploy is done.",
      });
      const draftId = (submitted.structured.draft as { id: string }).id;

      // Owner-routed by default, so the master can't decide it until it routes it to itself.
      const early = yield* call("mission_draft_approve", master, { draftId, action: "approve" });
      expect(early.isError).toBe(true);
      const laneRoute = yield* call("mission_draft_route", threadCaller(laneThread), {
        draftId,
        approver: "master",
        reason: "routine",
      });
      expect(laneRoute.isError).toBe(true);
      const routed = yield* call("mission_draft_route", master, {
        draftId,
        approver: "master",
        reason: "routine status line",
      });
      expect(routed.structured.draft).toMatchObject({
        approver: "master",
        routeNote: "routine status line",
      });
      const annotated = yield* call("mission_draft_annotate", master, {
        draftId,
        summary: "Deploy note to Sam",
        flags: ["routine"],
      });
      expect(annotated.structured.draft).toMatchObject({
        summary: "Deploy note to Sam",
        flags: ["routine"],
      });
      // Approving names the revision the master read.
      const blind = yield* call("mission_draft_approve", master, { draftId, action: "approve" });
      expect(blind.isError).toBe(true);
      expect(blind.text).toContain("needs the revision you read");
      const approved = yield* call("mission_draft_approve", master, {
        draftId,
        action: "approve",
        revision: 0,
      });
      expect(approved.isError).toBe(false);
      expect((approved.structured.draft as { status: string }).status).toBe("approved");

      const saved = yield* call("mission_draft_note", master, {
        missionId,
        scope: { _tag: "person", name: "Sam" },
        text: "Sam likes one line.",
      });
      expect(saved.isError).toBe(false);
      const note = saved.structured.note as { id: string; active: boolean; writtenBy: unknown };
      expect(note.writtenBy).toMatchObject({ _tag: "role", roleId: "role-master" });
      const off = yield* call("mission_draft_note", master, {
        noteId: note.id,
        missionId,
        scope: { _tag: "person", name: "Sam" },
        text: "Sam likes one line.",
        active: false,
      });
      expect((off.structured.note as { active: boolean }).active).toBe(false);
      const laneNote = yield* call("mission_draft_note", threadCaller(laneThread), {
        missionId,
        scope: { _tag: "all" },
        text: "Shout.",
      });
      expect(laneNote.isError).toBe(true);

      const missions = yield* MissionService.MissionService;
      const approvalId = ApprovalId.make("m-1:approval:crw:acme/api#9@cccccccccccc");
      yield* missions.openApproval(
        { _tag: "system", component: "crw" },
        {
          missionId,
          approvalId,
          kind: "merge",
          title: "Good to merge: acme/api#9",
          detail: "Decide in the review thread.",
          requestedBy: "crw",
          links: [],
        },
      );
      const chips = yield* call("mission_approval_annotate", master, {
        missionId,
        approvalId,
        summary: "Small retry fix",
        flags: ["padding"],
      });
      expect(chips.isError).toBe(false);
      const [approval] = yield* missions.approvals({ missionId, ids: [approvalId] });
      expect(approval).toMatchObject({ summary: "Small retry fix", flags: ["padding"] });
    }).pipe(Effect.provide(layer));
  });

  it.effect("M3: the master reopens drafts and suggestions under its own name", () => {
    const { layer } = toolsLayer();
    return Effect.gen(function* () {
      yield* seed;
      const master = threadCaller(masterThread);
      const lane = threadCaller(laneThread);
      const asks = yield* AsksService.AsksService;
      const submitted = yield* call("mission_draft", threadCaller(writerThread), {
        missionId,
        audience: "Sam",
        channel: "cliq",
        target: { kind: "url", label: "Cliq DM", url: null, ref: "sam" },
        text: "Deploy is done.",
      });
      const draftId = (submitted.structured.draft as { id: string }).id;
      yield* call("mission_draft_route", master, {
        draftId,
        approver: "master",
        reason: "routine status line",
      });
      const stale = yield* call("mission_draft_approve", master, {
        draftId,
        action: "approve",
        revision: 3,
      });
      expect(stale.isError).toBe(true);
      expect(stale.text).toContain("changed since revision 3");
      yield* call("mission_draft_approve", master, { draftId, action: "drop", revision: 0 });
      expect((yield* call("mission_draft_reopen", lane, { draftId })).isError).toBe(true);
      const reopened = yield* call("mission_draft_reopen", master, { draftId });
      expect(reopened.structured.draft).toMatchObject({ status: "pending", revision: 1 });

      const suggestion = yield* asks.proposeSuggestion(
        {
          missionId,
          targetKind: "lane",
          target: { kind: "lane", id: "lane-api" },
          title: "Rename the API lane",
          after: { name: "API v2" },
          diffText: "name: API -> API v2",
          why: "Matches the repo.",
          evidence: [{ kind: "lane", id: "lane-api" }],
        },
        { _tag: "system", component: "governor" },
      );
      yield* call("mission_suggestion_decide", master, {
        suggestionId: suggestion.id,
        action: "dismiss",
        dismissReason: "not now",
      });
      expect(
        (yield* call("mission_suggestion_reopen", lane, { suggestionId: suggestion.id })).isError,
      ).toBe(true);
      const back = yield* call("mission_suggestion_reopen", master, {
        suggestionId: suggestion.id,
      });
      expect(back.structured.suggestion).toMatchObject({ status: "open" });
      const store = yield* MissionStore.MissionStore;
      const events = yield* store.recentEvents(missionId, 20);
      expect(
        events.find((event) => event.summary.startsWith("Reopened suggestion"))?.actor,
      ).toEqual({ _tag: "role", roleId: "role-master" });
    }).pipe(Effect.provide(layer));
  });

  it.effect("lets only the master change the plan, keeping ask holds", () => {
    const { layer } = toolsLayer();
    return Effect.gen(function* () {
      yield* seed;
      const master = threadCaller(masterThread);
      const created = yield* call("mission_work_item", master, {
        missionId,
        workItemId: "wi-new",
        title: "Write the runbook",
      });
      expect(created.isError).toBe(false);
      const store = yield* MissionStore.MissionStore;
      const events = yield* store.recentEvents(missionId, 1);
      // Core records the write as the master role the calling thread holds.
      expect(events[0]?.actor).toEqual({ _tag: "role", roleId: "role-master" });

      // A lane thread is not the master.
      const lane = yield* call("mission_work_item", threadCaller(laneThread), {
        missionId,
        workItemId: "wi-free",
        stage: "review",
      });
      expect(lane.isError).toBe(true);
      expect(lane.text).toContain("forbidden");

      // Ask holds stay as the asks set them, whatever the master sends.
      yield* call("mission_ask", master, askInput("Online or offline?"));
      const rewritten = yield* call("mission_work_item", master, {
        missionId,
        workItemId: "wi-held",
        blockedBy: [{ kind: "work-item", id: "wi-free" }],
      });
      expect(rewritten.isError).toBe(false);
      const held = Option.getOrThrow(yield* store.get("work-item", WorkItemId.make("wi-held")));
      expect(held.blockedBy.map((ref) => ref.kind).toSorted()).toEqual(["ask", "work-item"]);

      // A held lane keeps waiting until the owner answers; parking is still allowed.
      const resumed = yield* call("mission_lane", master, {
        missionId,
        laneId: "lane-api",
        status: "working",
      });
      expect(resumed.isError).toBe(true);
      expect(resumed.text).toContain("waiting on ask");
      const parked = yield* call("mission_lane", master, {
        missionId,
        laneId: "lane-api",
        status: "parked",
      });
      expect(parked.isError).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.effect("gives the master every plan control, each on the timeline as the master", () => {
    const { layer } = toolsLayer();
    return Effect.gen(function* () {
      yield* seed;
      const master = threadCaller(masterThread);
      const lane = threadCaller(laneThread);
      const store = yield* MissionStore.MissionStore;
      const run = (name: string, args: Record<string, unknown>) =>
        Effect.map(call(name, master, args), (outcome) => {
          expect(outcome.isError, `${name}: ${outcome.text}`).toBe(false);
          return outcome.structured;
        });

      // A new mission, then this mission's plan.
      const created = yield* run("mission_create", { slug: "side", title: "Side mission" });
      expect(created.ref).toMatchObject({ kind: "mission" });
      const start = yield* store.latestSeq(missionId);
      yield* run("mission_update", { missionId, tier: "P0", guaranteedShare: 0.4 });
      const a = yield* run("mission_sub_mission", { missionId, subMissionId: "sm-a", title: "A" });
      yield* run("mission_sub_mission", { missionId, subMissionId: "sm-b", title: "B" });
      expect(a.ref).toMatchObject({ id: "sm-a" });
      yield* run("mission_sub_mission_reorder", { missionId, order: ["sm-b", "sm-a"] });
      yield* run("mission_lane", { missionId, laneId: "lane-api", subMissionId: "sm-a" });
      yield* run("mission_lane_split", {
        missionId,
        laneId: "lane-api",
        newLaneId: "lane-docs",
        name: "Docs",
        workItemIds: ["wi-free"],
      });
      yield* run("mission_lane_merge", { missionId, laneId: "lane-docs", intoLaneId: "lane-api" });
      yield* run("mission_focus", { missionId, subMissionId: "sm-a" });
      yield* run("mission_sub_mission_merge", {
        missionId,
        subMissionId: "sm-a",
        intoSubMissionId: "sm-b",
      });
      yield* run("mission_sub_mission", { missionId, subMissionId: "sm-b", status: "closed" });
      yield* run("mission_set_status", { missionId, status: "paused" });
      yield* run("mission_set_status", { missionId, status: "active" });
      yield* run("mission_approval_routing", {
        missionId,
        routes: [{ id: "all", match: { _tag: "approval" }, approver: "master" }],
        reason: "Owner handed merges to the master",
      });
      const rule = yield* run("mission_rule", {
        missionId,
        title: "Plain words",
        quote: "Write plainly.",
      });
      const ruleId = (rule.rule as { id: string }).id;
      yield* run("mission_rule_use", { ruleId, outcome: "applied" });
      yield* run("mission_set_status", { missionId, status: "archived" });

      const events = yield* store.eventsSince(missionId, start);
      expect(events.map((event) => event.kind)).toEqual([
        "mission.updated",
        "sub-mission.created",
        "sub-mission.created",
        "sub-mission.reordered",
        "lane.moved",
        "lane.split",
        "lane.merged",
        "mission.updated",
        "sub-mission.merged",
        "sub-mission.closed",
        "mission.paused",
        "mission.resumed",
        "approval-routing.updated",
        "rule.created",
        "rule.applied",
        "mission.archived",
      ]);
      // Plan writes carry the master role; rule writes the master's thread (the rule
      // service checks the binding itself, rules can be global).
      for (const event of events) {
        expect(event.actor).toEqual(
          event.kind.startsWith("rule.")
            ? { _tag: "thread", threadId: masterThread }
            : { _tag: "role", roleId: "role-master" },
        );
      }

      // A lane thread gets none of these controls.
      for (const [name, args] of [
        ["mission_create", { slug: "lane-made", title: "Lane made" }],
        ["mission_set_status", { missionId, status: "active" }],
        ["mission_sub_mission_reorder", { missionId, order: [] }],
        ["mission_approval_routing", { missionId, routes: [] }],
        ["mission_rule", { missionId, title: "Mine", quote: "Lanes rule." }],
      ] as const) {
        const refused = yield* call(name, lane, args);
        expect(refused.isError, name).toBe(true);
        expect(refused.text, name).toContain("forbidden");
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("lets the master decide the approvals routed to it, and only those", () => {
    const { layer } = toolsLayer();
    return Effect.gen(function* () {
      yield* seed;
      const master = threadCaller(masterThread);
      const missions = yield* MissionService.MissionService;
      const crw = { _tag: "system" as const, component: "crw" };
      const open = (approvalId: string) =>
        missions.openApproval(crw, {
          missionId,
          approvalId: ApprovalId.make(approvalId),
          kind: "merge",
          title: `Good to merge: ${approvalId}`,
          detail: "",
          requestedBy: "crw",
          links: [],
        });
      yield* open("ap-owner");
      const ownerRouted = yield* call("mission_approval_decide", master, {
        missionId,
        approvalId: "ap-owner",
        action: "approve",
      });
      expect(ownerRouted.isError).toBe(true);
      expect(ownerRouted.text).toContain("routed to the owner");

      const rerouted = yield* call("mission_approval_route", master, {
        missionId,
        approvalId: "ap-owner",
        approver: "master",
        reason: "Owner said dependency bumps are mine",
      });
      expect(rerouted.isError).toBe(false);
      const decided = yield* call("mission_approval_decide", master, {
        missionId,
        approvalId: "ap-owner",
        action: "approve",
        note: "Bump only",
      });
      expect(decided.isError).toBe(false);
      const listed = yield* call("mission_approvals", master, { missionId });
      const approvals = listed.structured.approvals as Array<{
        id: string;
        status: string;
        approver: string;
        routeNote: string;
      }>;
      expect(
        approvals.map((approval) => [approval.id, approval.status, approval.approver]),
      ).toEqual([["ap-owner", "approved", "master"]]);
      expect(approvals[0]?.routeNote).toBe("Owner said dependency bumps are mine");
    }).pipe(Effect.provide(layer));
  });

  it.effect("builds a watch check for a mission", () => {
    const { layer } = toolsLayer();
    return Effect.gen(function* () {
      yield* seed;
      const watch = yield* call("mission_watch", clientCaller, {
        missionId,
        on: ["ask-opened", "lane-stalled"],
      });
      expect(watch.isError).toBe(false);
      expect(watch.structured.check).toBe(
        `mission watch-check 'm-1' --on ask-opened,lane-stalled --cursor "$WATCH_DIR/mission-cursor"`,
      );
      expect(watch.structured.add).toContain("robob-watch add");
      const unknown = yield* call("mission_watch", clientCaller, {
        missionId: "nope",
        on: ["ask-opened"],
      });
      expect(unknown.isError).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect("N10: the master of a mission past the first page of missions creates missions", () => {
    const { layer } = toolsLayer();
    return Effect.gen(function* () {
      yield* seed;
      yield* crowdMissions;
      const created = yield* call("mission_create", threadCaller(masterThread), {
        slug: "side",
        title: "Side mission",
      });
      expect(created.isError, created.text).toBe(false);
      const store = yield* MissionStore.MissionStore;
      const [event] = yield* store.recentEvents((created.structured.ref as { id: never }).id, 1);
      expect(event?.actor).toEqual({ _tag: "role", roleId: "role-master" });
      const lane = yield* call("mission_create", threadCaller(laneThread), {
        slug: "lane-side",
        title: "Lane side",
      });
      expect(lane.isError).toBe(true);
      expect(lane.text).toContain("forbidden");
    }).pipe(Effect.provide(layer));
  });

  it.effect("lets the master decline or withdraw a member's secret card, never fill it", () => {
    const { answered, layer } = toolsLayer();
    return Effect.gen(function* () {
      yield* seed;
      const turnItemId = TurnItemId.make("turn-item:secret-request:1");
      const close = (caller: ThreadId, args: Record<string, unknown> = {}) =>
        call("mission_secret_request_close", threadCaller(caller), {
          missionId,
          threadId: writerThread,
          turnItemId,
          closeAs: "decline",
          ...args,
        });

      const declined = yield* close(masterThread);
      expect(declined.isError, declined.text).toBe(false);
      expect(declined.structured.status).toBe("declined");
      const withdrawn = yield* close(masterThread, { threadId: laneThread, closeAs: "withdraw" });
      expect(withdrawn.structured.status).toBe("cancelled");
      expect(answered.map(([input]) => [input.threadId, input.answer])).toEqual([
        [writerThread, { type: "decline" }],
        [laneThread, { type: "withdraw" }],
      ]);
      // Each went through as the master's grant for that card, not as the owner.
      for (const [input, by] of answered) {
        expect(by).toBeInstanceOf(MasterSecretClose);
        expect((by as MasterSecretClose).turnItemId).toBe(input.turnItemId);
      }

      // No value parameter, and no one else closes a member's card.
      const save = yield* Effect.exit(close(masterThread, { closeAs: "save", secret: "x" }));
      const saveOutcome = save._tag === "Success" ? save.value : null;
      expect(saveOutcome === null || saveOutcome.isError).toBe(true);
      for (const caller of [laneThread, writerThread, strayThread]) {
        const refused = yield* close(caller);
        expect(refused.isError).toBe(true);
        expect(refused.text).toContain("forbidden");
      }
      const client = yield* call("mission_secret_request_close", clientCaller, {
        missionId,
        threadId: writerThread,
        turnItemId,
        closeAs: "decline",
      });
      expect(client.isError).toBe(true);
      expect(answered).toHaveLength(2);
    }).pipe(Effect.provide(layer));
  });

  it.effect("the master answers and decides for the owner by tool on a verified condition", () => {
    const { layer } = toolsLayer();
    const settled: Array<string> = [];
    // Verifies request req-1 only; the router owns the real check.
    const conditions = Layer.succeed(
      OwnerConditions,
      OwnerConditions.of({
        verify: ({ condition }) =>
          condition.requestId === OwnerRequestId.make("req-1")
            ? Effect.void
            : Effect.fail(new MissionError({ code: "forbidden", detail: "No such request." })),
        settleFor: ({ subject }) => Effect.sync(() => void settled.push(subject.kind)),
      }),
    );
    const onOwnerCondition = { requestId: "req-1", quote: "fine if it stays online" };
    return Effect.gen(function* () {
      yield* seed;
      const master = threadCaller(masterThread);
      const opened = yield* call("mission_ask", threadCaller(laneThread), askInput("Online?"));
      const askId = (opened.structured.ask as { id: string }).id;

      const unknown = yield* call("mission_ask_answer", master, {
        askId,
        optionId: "a",
        text: "",
        onOwnerCondition: { ...onOwnerCondition, requestId: "req-2" },
      });
      expect(unknown.isError).toBe(true);
      const answered = yield* call("mission_ask_answer", master, {
        askId,
        optionId: "a",
        text: "",
        onOwnerCondition,
      });
      expect(answered.isError).toBe(false);
      expect(answered.structured.ask).toMatchObject({
        status: "answered",
        answer: { onOwnerCondition, provenance: { _tag: "agent", threadId: masterThread } },
      });

      const submitted = yield* call("mission_draft", threadCaller(writerThread), {
        missionId,
        audience: "Sam",
        channel: "cliq",
        target: { kind: "url", label: "Cliq DM", url: null, ref: "sam" },
        text: "Deploy is done.",
      });
      const draftId = (submitted.structured.draft as { id: string }).id;
      const decided = yield* call("mission_draft_approve", master, {
        draftId,
        action: "approve",
        revision: 0,
        onOwnerCondition,
      });
      expect(decided.isError).toBe(false);
      expect(decided.structured.draft).toMatchObject({ status: "approved", onOwnerCondition });
      expect(settled).toEqual(["ask", "draft"]);
    }).pipe(Effect.provide(layer.pipe(Layer.provideMerge(conditions))));
  });
});
