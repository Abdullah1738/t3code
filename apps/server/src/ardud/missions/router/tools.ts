import {
  DecideKnockInput,
  MarkReadInput,
  MissionAttentionInput,
  MissionId,
  OrchestratorMcpFailure,
  RoomPageInput,
  RoomTuningInput,
  SetMissionMemberInput,
  SubscribeRoomInput,
  TuneRoomInput,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";
import * as Schema from "effect/Schema";

import * as McpInvocationContext from "../../../mcp/McpInvocationContext.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import { MissionRouter } from "./MissionRouter.ts";

/**
 * Router tools for agents in mission threads. The calling thread comes from
 * the MCP invocation context, never from parameters. Posting is `mission_post`
 * (asks track), which goes through the same router.
 */

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  MissionRouter,
];

const Records = Schema.Array(Schema.Unknown);

const MissionInboxTool = Tool.make("mission_inbox", {
  description:
    "Your unread mission messages, oldest first (up to 30, with bodies): requests, blockers, controls and evidence addressed to you or your roles. Handle them, then call mission_mark_read for each room so the doorbell stops.",
  parameters: Tool.EmptyParams,
  success: Schema.Struct({ unread: Schema.Number, entries: Records }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
});

const MissionMarkReadTool = Tool.make("mission_mark_read", {
  description:
    "Mark a room read up to a message seq. Reading is the acknowledgement: do not post an ack message.",
  parameters: MarkReadInput,
  success: Schema.Struct({ position: Schema.Unknown }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
});

const MissionRoomsTool = Tool.make("mission_rooms", {
  description: "The rooms of a mission you belong to, with their last seq and noise.",
  parameters: Schema.Struct({ missionId: MissionId }),
  success: Schema.Struct({ rooms: Records }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
});

const MissionRoomTool = Tool.make("mission_room", {
  description:
    "Open a room: its newest message summaries (default 50, at most 200), subscriptions and receipts. Pass beforeSeq for older pages. Message bodies come from mission_inbox.",
  parameters: RoomPageInput,
  success: Schema.Struct({ page: Schema.Unknown }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
});

const MissionSubscribeTool = Tool.make("mission_subscribe", {
  description:
    "Join, retune or mute a room for yourself (your thread, a role or lane you hold). mode wake rings you for wakeOn kinds (default request, blocker, control); read follows without ringing; mute stops both. The master may set any member's subscription.",
  parameters: SubscribeRoomInput,
  success: Schema.Struct({ subscription: Schema.Unknown }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
});

const MissionKnocksTool = Tool.make("mission_knocks", {
  description:
    "As the mission's master, the pending knocks you may decide: sends from outside the mission to its members. Knocks addressed to the master are the owner's alone.",
  parameters: Schema.Struct({ missionId: MissionId }),
  success: Schema.Struct({ knocks: Records }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
});

const MissionKnockDecideTool = Tool.make("mission_knock_decide", {
  description:
    "As the mission's master, forward (optionally edited, optionally to another member) or drop a pending knock that is not addressed to the master.",
  parameters: DecideKnockInput,
  success: Schema.Struct({ knock: Schema.Unknown }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
});

const MissionSetMemberTool = Tool.make("mission_set_member", {
  description:
    "As the mission's master, attach or remove a member: a thread (it can then read and post in the mission's rooms and be reached by members) or a service session (its sends are routed as mission traffic). You cannot attach a thread that already belongs to another mission; the owner can.",
  parameters: SetMissionMemberInput,
  success: Schema.Struct({ seq: Schema.Number, ref: Schema.Unknown }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
});

const MissionRoomTuningTool = Tool.make("mission_room_tuning", {
  description:
    "A room's wake rules: whether it is muted and each subscriber's mode and wakeOn kinds.",
  parameters: RoomTuningInput,
  success: Schema.Struct({ tuning: Schema.Unknown }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
});

const MissionTuneRoomTool = Tool.make("mission_tune_room", {
  description:
    "As the mission's master, mute or unmute a room and set wake rules for any of its subscribers (mode wake|read|mute, wakeOn kinds), as one logged change. A muted room wakes only the actors a message names.",
  parameters: TuneRoomInput,
  success: Schema.Struct({ tuning: Schema.Unknown }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
});

const MissionAttentionTool = Tool.make("mission_attention", {
  description:
    "As the mission's master, messages members left unread after their one reminder. The router does not ring for them again; chase or reassign them yourself.",
  parameters: MissionAttentionInput,
  success: Schema.Struct({ entries: Records }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
});

interface ToolConfig {
  readonly parameters: Schema.Constraint;
  readonly success: Schema.Constraint;
  readonly failure: Schema.Constraint;
  readonly failureMode: Tool.FailureMode;
}

// Strict everywhere so unknown keys, nested ones included, are refused.
const annotated = <Name extends string, Config extends ToolConfig, R>(
  tool: Tool.Tool<Name, Config, R>,
  title: string,
  readonly: boolean,
) =>
  tool
    .annotate(Tool.Title, title)
    .annotate(Tool.Readonly, readonly)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, readonly)
    .annotate(Tool.OpenWorld, false)
    .annotate(Tool.Strict, true);

export const RouterToolkit = Toolkit.make(
  annotated(MissionInboxTool, "Mission inbox", true),
  annotated(MissionMarkReadTool, "Mark a mission room read", false),
  annotated(MissionRoomsTool, "Mission rooms", true),
  annotated(MissionRoomTool, "Mission room", true),
  annotated(MissionSubscribeTool, "Subscribe to a mission room", false),
  annotated(MissionKnocksTool, "Mission knocks", true),
  annotated(MissionKnockDecideTool, "Decide a mission knock", false),
  annotated(MissionSetMemberTool, "Set a mission member", false),
  annotated(MissionRoomTuningTool, "Mission room wake rules", true),
  annotated(MissionTuneRoomTool, "Tune a mission room", false),
  annotated(MissionAttentionTool, "Mission attention", true),
);
