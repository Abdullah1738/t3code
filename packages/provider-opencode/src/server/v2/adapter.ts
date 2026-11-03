import * as NodeURL from "node:url";

import {
  AbsolutePath,
  Agent,
  Form,
  Location,
  Model,
  Permission,
  Provider,
  Session,
  SessionMessage,
  Skill,
  type OpenCodeEvent,
} from "@opencode/client/effect";
import { Mcp } from "@opencode/schema/mcp";
import {
  isOrchestrationV2WorkActive,
  type ChatAttachment,
  type OrchestrationV2AppThread,
  type OrchestrationV2AssistantPhase,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2Subagent,
  type OrchestrationV2TurnItem,
  type OrchestrationV2UserInputQuestion,
  type MessageId,
  type ModelSelection,
  type ProviderApprovalDecision,
  type ProviderInstanceId,
  type RunId,
  type RuntimeRequestId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as OpenCode2Client from "./OpenCode2Client.ts";
import * as OpenCode2Server from "./OpenCode2Server.ts";
import * as OpenCodeRuntime from "../OpenCodeRuntime.ts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { buildRuntimeInstructions } from "@t3tools/provider-core/server/runtimeInstructions";
import { t3OrchestrationSystemPrompt } from "@t3tools/provider-core/server/orchestrationInstructions";
import { SKILL_MENTION_PATTERN } from "@t3tools/shared/composerInlineTokens";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import { getModelSelectionStringOptionValue, modelSelectionsEqual } from "@t3tools/shared/model";
import { causeErrorTag } from "@t3tools/shared/observability";

import {
  isProviderNativeImageAttachment,
  providerMessageTextWithAttachmentPaths,
} from "@t3tools/provider-core/server/attachmentPrompt";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import {
  backgroundWorkNotification,
  type BackgroundWorkReport,
} from "@t3tools/provider-core/server/notification";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import {
  makeSubagentChildThread,
  makeSubagentConversationArtifacts,
  subagentThreadTitle,
} from "@t3tools/provider-core/server/subagentProjection";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { turnScopedSelectionTransition } from "@t3tools/provider-core/server/selectionTransition";
import { OPENCODE_PROVIDER, openCodePermissionRequestKind } from "../adapter.ts";
import { openCodeToolTurnItem } from "../toolItems.ts";

const OpenCode2ProviderCapabilities = {
  sessions: {
    supportsMultipleProviderThreadsPerSession: true,
    supportsModelSwitchInSession: true,
    supportsProviderSwitchingViaHandoff: true,
    supportsRuntimeModeSwitchInSession: true,
    pendingRequestsSurviveRestart: false,
  },
  threads: {
    canCreateEmptyThread: true,
    canReadThreadSnapshot: true,
    canRollbackThread: true,
    canForkThread: true,
    canForkFromTurn: true,
    canForkFromSubagentThread: false,
    exposesNativeThreadId: true,
  },
  turns: {
    exposesNativeTurnId: false,
    emitsTurnStarted: true,
    emitsTurnCompleted: true,
    supportsInterrupt: true,
    supportsActiveSteering: true,
    supportsSteeringByInterruptRestart: true,
    supportsQueuedMessages: true,
    terminalStatusQuality: "strong",
  },
  streaming: {
    streamsAssistantText: true,
    streamsReasoning: true,
    streamsToolOutput: false,
    streamsPlanText: false,
    emitsMessageCompleted: true,
  },
  tools: {
    exposesToolItemIds: true,
    emitsToolStarted: true,
    emitsToolCompleted: true,
    emitsToolOutput: true,
    supportsMcpTools: false,
    supportsDynamicToolCallbacks: false,
  },
  approvals: {
    supportsCommandApproval: true,
    supportsFileReadApproval: true,
    supportsFileChangeApproval: true,
    supportsApplyPatchApproval: true,
    approvalsHaveNativeRequestIds: true,
    approvalCallbacksAreLiveOnly: true,
    approvalsCanOriginateFromSubagents: true,
  },
  planning: {
    emitsPlanUpdated: false,
    emitsTodoList: false,
    emitsProposedPlan: false,
    supportsStructuredQuestions: true,
    planDeltasHaveItemIds: false,
  },
  subagents: {
    supportsSubagents: true,
    exposesSubagentThreadIds: true,
    emitsSubagentLifecycle: true,
    canWaitForSubagents: true,
    canCloseSubagents: false,
    canForkSubagentThread: false,
  },
  context: {
    acceptsSystemContext: false,
    acceptsDeveloperContext: false,
    acceptsSyntheticUserContext: true,
    canGenerateSummaries: false,
    canConsumeHandoffSummaries: true,
    supportsDeltaHandoff: true,
    supportsFullThreadHandoff: true,
    maxRecommendedHandoffChars: null,
  },
  checkpointing: {
    appCanCheckpointFilesystem: true,
    supportsNestedCheckpointScopes: true,
    providerCanRollbackConversation: true,
    providerRollbackReturnsSnapshot: true,
    providerCanReadConversationSnapshot: true,
  },
  identity: {
    nativeThreadIds: "strong",
    nativeTurnIds: "weak",
    nativeItemIds: "strong",
    nativeRequestIds: "strong",
  },
  runtimePolicy: { enforcement: "native" },
} satisfies OrchestrationV2ProviderCapabilities;

type EventOf<T extends OpenCodeEvent["type"]> = Extract<OpenCodeEvent, { readonly type: T }>;
type Tokens = EventOf<"session.step.ended">["data"]["tokens"];

interface TurnOwner {
  readonly appThread: OrchestrationV2AppThread;
  readonly threadId: OrchestrationV2AppThread["id"];
  readonly runId: RunId | null;
  readonly runOrdinal: number;
  readonly rootNodeId: ProviderAdapter.ProviderAdapterV2TurnInput["rootNodeId"];
  readonly modelSelection: ModelSelection;
  readonly runtimePolicy: Pick<ProviderAdapter.ProviderAdapterV2RuntimePolicy, "cwd">;
}

interface ActiveTurn {
  readonly input: TurnOwner;
  providerTurn: OrchestrationV2ProviderTurn;
  readonly texts: Map<string, OpenBlock>;
  readonly tools: Map<string, { readonly name: string; input: Record<string, unknown> }>;
  readonly startedAt: Map<string, DateTime.Utc>;
  /** The last node state emitted for each text, reasoning and tool block. */
  readonly nodes: Map<string, string>;
  readonly ordinals: Map<string, number>;
  nextOrdinal: number;
  readonly usage: {
    input: number;
    cached: number;
    cacheWrite: number;
    output: number;
    reasoning: number;
  };
  steps: number;
  lastStep: Tokens | undefined;
  /** The turn's last step's native finish (session.step.ended); null until one ends. */
  lastFinish: string | null;
  /** Native finish per assistant message: a text's phase comes from its step. */
  readonly finishByMessage: Map<string, string>;
  /** Texts a recovered message shows a tool call after: narration whatever the step's finish says. */
  readonly narrationTexts: Set<string>;
  /** Completed texts whose step has not ended yet; they are re-emitted with their phase then. */
  readonly awaitingFinish: Map<string, { readonly block: OpenBlock["block"]; readonly text: string }>;
  before: string | null | undefined;
  compaction: { readonly nativeId: string; readonly startedAt: DateTime.Utc } | undefined;
  compactions: number;
  interrupted: boolean;
  unsent: boolean;
  /**
   * Installed while the event stream reconnects, and not set up yet. The
   * session's executions are not this turn's until then: one OpenCode runs on
   * its own meanwhile is held as a wake, which the turn joins once it is set
   * up. It takes no steers, and a Stop ends it here.
   */
  parked: boolean;
  /** Set while its request is on the way: the server may not have its prompt yet. */
  submitting: boolean;
  /**
   * Steers sent into this turn that OpenCode has not delivered yet, by inbox
   * id. Each one wakes the session, so an execution that ends before reading
   * one is followed by another that does, and the turn spans both.
   */
  readonly steers: Set<string>;
  readonly settledInbox: Set<string>;
  heldEnd: TurnTerminal | undefined;
  awaitingStart: boolean;
  /**
   * Prefixes a subagent session's tool ids in native item ids: the model
   * names tool calls, so a child's could repeat its parent's.
   */
  readonly scope: string;
  usedSubagents: boolean;
}

interface SubagentCall {
  readonly toolId: string;
  readonly nativeId: string;
  readonly state: ThreadState;
  readonly turn: ActiveTurn;
  readonly ordinal: number;
  readonly startedAt: DateTime.Utc;
  prompt: string;
  title: string | null;
  agent: string | undefined;
  model: string | null;
  background: boolean;
  joined: SubagentCall | undefined;
  child: ThreadState | undefined;
  /** The child's inbox item carrying this call's prompt. */
  inbox: string | undefined;
  /** The child execution that took that prompt in, counted by `executions`. */
  execution: number | undefined;
  /** When OpenCode made the call, in its clock's milliseconds: its prompt reached the child later. */
  launched: number | undefined;
  status: OrchestrationV2Subagent["status"];
  result: string | null;
  completedAt: DateTime.Utc | null;
}

/** A foreground `subagent` call a reconnect found ended, and how. */
interface FinishedCall {
  readonly call: SubagentCall;
  readonly status: OrchestrationV2Subagent["status"];
  readonly output: string;
}

/**
 * An execution OpenCode ran on a thread's session without T3 asking: the
 * parent's answer once a background subagent ended. Its events are held until
 * the continuation turn T3 opens for it takes them.
 */
interface Wake {
  messageId: MessageId | undefined;
  readonly events: Array<OpenCode2Client.OpenCode2StreamEvent>;
  running: boolean;
  readonly reports: Array<BackgroundWorkReport>;
  readonly detail: string | null;
  dropped: boolean;
  readonly after: string | undefined;
  readonly first: string | undefined;
  readonly children: Set<string>;
}

interface OpenBlock {
  readonly block: { readonly assistantMessageID: string; readonly ordinal: number };
  readonly kind: "text" | "reasoning";
  readonly startedAt: DateTime.Utc;
  text: string;
}

interface ThreadState {
  readonly sessionId: string;
  providerThread: OrchestrationV2ProviderThread;
  readonly providerTurns: Map<string, OrchestrationV2ProviderTurn>;
  active: ActiveTurn | undefined;
  model: ModelRef | undefined;
  /**
   * Set when a turn ended here while OpenCode may still be running it: a Stop
   * that timed out, a prompt whose request failed without a clear answer, or a
   * request T3 could not answer. Execution events carry only the session id,
   * so the next execution end belongs to that run; it clears this and ends no turn.
   */
  unsettled: boolean;
  /**
   * A prompt whose request failed may start its run late; that start is the
   * run's own, and only a start after it means its end was lost.
   */
  unsettledStarted: boolean;
  directory: string;
  agent: string;
  title: string | undefined;
  rules: ReadonlyArray<Rule> | undefined;
  policy: RulesPolicy;
  readonly grants: Array<Rule>;
  readonly calls: Map<string, SubagentCall>;
  subagent:
    | {
        call: SubagentCall;
        readonly appThread: OrchestrationV2AppThread;
        turns: number;
        prompt: string | undefined;
        queued: string | undefined;
      }
    | undefined;
  readonly wakes: Array<Wake>;
  readonly reports: Map<
    string,
    {
      readonly inboxId: string;
      readonly childId: string;
      readonly report: BackgroundWorkReport;
      readonly text: string;
    }
  >;
  readonly stoppedChildren: Set<string>;
  readonly strandedSteers: Set<string>;
  /** How many executions this session started, which tells one apart from the next. */
  executions: number;
  /**
   * The number of the execution the stream is in, or was in last. A reconnect
   * can place the stream back in one it numbered earlier.
   */
  execution: number;
  /** T3's MCP server as registered for this thread, and the instructions entry sent with it. */
  mcp:
    | {
        readonly name: string;
        readonly directory: string;
        readonly credential: string;
        readonly url: string;
      }
    | undefined;
  instructions: string | undefined;
}

/**
 * A text's phase from its step's native finish. `stop` ends the reply, `tool-calls` means the
 * text came before a tool call. Any other finish (length, error, content-filter) is not proven.
 */
const phaseFromFinish = (finish: string | undefined): OrchestrationV2AssistantPhase =>
  finish === "stop" ? "answer" : finish === "tool-calls" ? "narration" : "unknown";

/** The thread's turn that owns its session's executions; a parked one does not yet. */
const runningTurn = (state: ThreadState | undefined) =>
  state?.active?.parked === true ? undefined : state?.active;

type TurnTerminal =
  | { readonly status: "completed" | "interrupted" }
  | { readonly status: "failed"; readonly failure: ReturnType<typeof makeProviderFailure> };

type Rule = Permission.Rule;
type RulesPolicy = Pick<
  ProviderAdapter.ProviderAdapterV2RuntimePolicy,
  "runtimeMode" | "interactionMode"
>;
type NativeForm = EventOf<"form.created">["data"]["form"];

interface PendingRequest {
  readonly request: OrchestrationV2RuntimeRequest;
  readonly item: OrchestrationV2TurnItem;
  readonly node: OrchestrationV2ExecutionNode;
  readonly state: ThreadState;
  readonly turn: ActiveTurn;
  readonly sessionId: string;
  answering: boolean;
  readonly native:
    | {
        readonly type: "permission";
        readonly id: string;
        readonly action: string;
        readonly resources: ReadonlyArray<string>;
        readonly save: ReadonlyArray<string>;
      }
    | { readonly type: "form"; readonly id: string; readonly form: NativeForm };
}

const rule = (action: string, effect: Rule["effect"]): Rule => ({ action, resource: "*", effect });

/**
 * OpenCode skips every tool of a server whose name is over 64 characters (its
 * tool namespace limit), and its router rejects adding one over 100, so a
 * thread id that does not fit is replaced by a digest of it.
 */
export const t3McpServerName = Effect.fn("t3McpServerName")(function* (threadId: string) {
  const name = `t3-code-${threadId.replaceAll(/[^a-zA-Z0-9_-]/g, "_")}`;
  if (name.length <= 64) return name;
  const crypto = yield* Crypto.Crypto;
  const digest = yield* crypto
    .digest("SHA-256", new TextEncoder().encode(threadId))
    .pipe(Effect.orDie);
  return `t3-code-${Hex.encode(digest).slice(0, 16)}`;
});

/** Whether an OpenCode server URL points at this machine. */
const isLoopbackUrl = (url: string): boolean => {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
    return host === "localhost" || host === "::1" || /^127\./.test(host);
  } catch {
    return false;
  }
};

/**
 * The rules that keep T3's MCP servers to their own thread, after the mode's:
 * the last matching rule wins, so every thread's T3 server is denied and then
 * this thread's own is allowed again, in every mode.
 */
const mcpRules = (mcpServerName: string | null): ReadonlyArray<Rule> =>
  mcpServerName === null
    ? []
    : [
        { action: "t3-code-*", resource: "*", effect: "deny" },
        { action: `${mcpServerName}_*`, resource: "*", effect: "allow" },
      ];

const sessionRules = (
  policy: RulesPolicy,
  paths: ReadonlyArray<Rule>,
  grants: ReadonlyArray<Rule>,
  mcpServerName: string | null,
): ReadonlyArray<Rule> => [
  ...(policy.runtimeMode === "full-access"
    ? [rule("*", "allow")]
    : [
        rule("shell", "ask"),
        rule("edit", policy.runtimeMode === "auto-accept-edits" ? "allow" : "ask"),
        rule("external_directory", "ask"),
      ]),
  ...grants,
  // Plan mode writes only its plan, which `paths` allows again. Shell and read
  // are never denied: the free tier refuses sessions whose rules deny them.
  ...(policy.interactionMode === "plan" ? [rule("edit", "deny")] : []),
  ...paths,
  ...mcpRules(mcpServerName),
];

const sameRules = (left: ReadonlyArray<Rule> | undefined, right: ReadonlyArray<Rule>) =>
  left?.length === right.length &&
  left.every(
    (entry, index) =>
      entry.action === right[index]?.action &&
      entry.resource === right[index]?.resource &&
      entry.effect === right[index]?.effect,
  );

/**
 * A reject without a message is OpenCode's "stop": it ends the whole execution,
 * which is Cancel.
 */
const DECLINED = "The user declined this request.";

/**
 * Steered into the session before a decline: a declined shell call reaches the
 * model only as "Unable to execute command", which it retries.
 */
const declinedNote = (action: string, resources: ReadonlyArray<string>) =>
  `The user declined the ${action} request${resources.length === 0 ? "" : ` (${resources.join(", ")})`}. Do not retry it; continue without it or ask the user how to proceed.`;

const sessionGrantLabel = (action: string, save: ReadonlyArray<string>) =>
  save.every((pattern) => pattern === "*")
    ? `Allow every ${action} request this session`
    : `Allow ${save.join(", ")} this session`;

const text = (value: string | undefined, fallback: string) => value?.trim() || fallback;

const formQuestions = (
  form: NativeForm,
):
  | { readonly questions: ReadonlyArray<OrchestrationV2UserInputQuestion> }
  | { readonly unsupported: string } => {
  const questions: Array<OrchestrationV2UserInputQuestion> = [];
  for (const [index, field] of form.fields.entries()) {
    if (field.type === "external") return { unsupported: "a link to open" };
    if (field.type !== "string" && field.type !== "multiselect") {
      return { unsupported: `a ${field.type} value` };
    }
    if (field.hidden === true) return { unsupported: "a hidden field" };
    if ((field.when?.length ?? 0) > 0) return { unsupported: "a field that depends on another" };
    const header = text(field.title, `Question ${index + 1}`);
    const options = (field.options ?? []).map((option) => {
      const label = text(option.label, text(option.value, "Option"));
      return { label, description: text(option.description, label), value: option.value };
    });
    questions.push({
      id: field.key,
      header,
      question: text(field.description, header),
      options,
      multiSelect: field.type === "multiselect",
      allowCustomAnswer: field.custom === true || options.length === 0,
    });
  }
  return { questions };
};

const formAnswer = (form: NativeForm, answers: Readonly<Record<string, unknown>>) => {
  const answer: Record<string, string | ReadonlyArray<string>> = {};
  for (const field of form.fields) {
    const raw = answers[field.key];
    const values = (Array.isArray(raw) ? raw : [raw]).filter(
      (value): value is string => typeof value === "string" && value.trim().length > 0,
    );
    if (values.length > 0) {
      answer[field.key] = field.type === "multiselect" ? values : values.join(", ");
    }
  }
  return answer;
};

const approves = (decision: ProviderApprovalDecision) =>
  decision === "accept" || decision === "acceptForSession" || decision === "acceptAlways";

const permissionGone = {
  PermissionNotFoundError: () => Effect.void,
  SessionNotFoundError: () => Effect.void,
};
const formGone = {
  FormNotFoundError: () => Effect.void,
  FormAlreadySettledError: () => Effect.void,
  SessionNotFoundError: () => Effect.void,
};

const agentPaths = (rules: ReadonlyArray<Rule>) =>
  rules.filter(
    (entry) =>
      entry.effect === "allow" &&
      entry.resource !== "*" &&
      (entry.action === "edit" || entry.action === "external_directory"),
  );

const ref = (nativeId: string, strength: "strong" | "weak" = "strong") => ({
  driver: OPENCODE_PROVIDER,
  nativeId,
  strength,
});

const sessionIdOf = (providerThread: OrchestrationV2ProviderThread) => {
  const nativeId = providerThread.nativeThreadRef?.nativeId;
  return nativeId === undefined || nativeId === null
    ? Effect.fail(
        new ProviderAdapter.ProviderAdapterProtocolError({
          driver: OPENCODE_PROVIDER,
          detail: `Provider thread ${providerThread.id} has no OpenCode session`,
        }),
      )
    : Effect.succeed(nativeId);
};

const textOf = (content: ReadonlyArray<{ readonly type: string; readonly text?: string }>) =>
  content.flatMap((part) => (part.type === "text" && part.text ? [part.text] : [])).join("\n");

const stringField = (record: Readonly<Record<string, unknown>> | undefined, key: string) => {
  const value = record?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
};

const reportOutcome = (state: string | undefined) =>
  state === "completed"
    ? ("completed" as const)
    : state === "error"
      ? ("failed" as const)
      : state === "cancelled"
        ? ("cancelled" as const)
        : ("unknown" as const);

const subagentOutput = (text: string) =>
  /^<subagent\b[^>]*>\n?([\s\S]*?)\n?<\/subagent>$/.exec(text.trim())?.[1] ?? text;

const XML_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/**
 * The description of the call a subagent report answers. OpenCode puts it on
 * the report's `<subagent …>` wrapper; the payload may carry it too.
 */
const reportDescription = (payload: {
  readonly text: string;
  readonly description?: unknown;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
}) => {
  const direct =
    stringField(payload.metadata, "description") ??
    (typeof payload.description === "string" && payload.description.trim().length > 0
      ? payload.description
      : undefined);
  if (direct !== undefined) return direct;
  const quoted = /^<subagent\b[^>]*\bdescription="([^"]*)"/.exec(payload.text.trim())?.[1];
  return quoted?.replace(/&(amp|lt|gt|quot|apos);/g, (_, name: string) => XML_ENTITIES[name] ?? _);
};

/** What OpenCode puts before a call's prompt when the call creates its subagent. */
const SUBAGENT_PREAMBLE = "You are a subagent spawned by another session.\n";

/** Whether a child prompt is the one a call sent, as a new subagent or a resumed one. */
const isPromptOf = (call: SubagentCall, text: string) =>
  call.prompt.length > 0 && (text === call.prompt || text === SUBAGENT_PREAMBLE + call.prompt);

const isContinuation = (turnInput: ProviderAdapter.ProviderAdapterV2TurnInput) =>
  turnInput.message.createdBy === "agent" && turnInput.message.creationSource === "provider";

const wakeTurnId = (sessionId: string, attemptId: string) => `${sessionId}:wake:${attemptId}`;
const isWakeTurn = (turn: OrchestrationV2ProviderTurn) =>
  turn.nativeTurnRef?.nativeId?.includes(":wake:") === true;

const INTERRUPT_TIMEOUT = "10 seconds";
const INSTRUCTIONS_KEY = "t3-code";
/**
 * A lost event stream is resubscribed with backoff for this long before the
 * session breaks. A busy server can stall for minutes at a time (a big
 * database, many sessions), and turns started meanwhile wait for the outcome,
 * so only a real outage should fail them.
 */
const RECONNECT_WINDOW = "15 minutes";
const RECONNECT_SCHEDULE = Schedule.exponential("2 seconds").pipe(
  Schedule.modifyDelay(({ duration }) =>
    Effect.succeed(Duration.min(duration, Duration.seconds(30))),
  ),
  Schedule.upTo({ duration: RECONNECT_WINDOW }),
);
/**
 * Reading back what a gap missed pages through every running session's history.
 * It holds the event lock, so interrupts wait on it; a slow pass just retries.
 */
const RECONCILE_TIMEOUT = "45 seconds";
/** One resubscribe attempt; a server that never answers it is retried. */
const RESUBSCRIBE_TIMEOUT = "30 seconds";
/** A background subagent's result when its end was lost with the event stream. */
const LOST_BACKGROUND =
  "T3 Code lost its connection to OpenCode while this subagent ran, so its result is not shown.";
const INVENTORY_TIMEOUT = "5 seconds";
const ACTIVE_CHECK_TIMEOUT = "5 seconds";
/** Answers that mean the server refused a prompt; any other failure may have been accepted. */
const CLEAR_PROMPT_REJECTIONS: ReadonlySet<string> = new Set([
  "InvalidRequestError",
  "ConflictError",
  "UnauthorizedError",
  "CommandNotFoundError",
  "SkillNotFoundError",
]);

export const OPENCODE_2_STILL_STOPPING =
  "OpenCode is still stopping the previous turn. Send the message again in a moment.";
const REQUEST_REPLY_TIMEOUT = "10 seconds";

const deliver = <E>(answer: Effect.Effect<void, E>) =>
  answer.pipe(
    Effect.retry({ times: 1 }),
    Effect.timeout(REQUEST_REPLY_TIMEOUT),
    Effect.exit,
    Effect.map(Exit.isSuccess),
  );

type ModelRef = ReturnType<typeof Model.Ref.make>;

/**
 * OpenCode takes a client id (it must start with `msg_`) and answers a repeat of one in the same
 * session with the item it already has, so a retried request never queues a second message, and a
 * turn knows the message fork and rollback cut at before OpenCode answers. The id is unique across
 * the whole server, which refuses it in any other session (409), so it names the session: another
 * T3 database or environment on the same server repeats thread ids and run ordinals, never session
 * ids.
 */
const turnPromptId = (sessionId: string, attemptId: string) =>
  SessionMessage.ID.make(`msg_t3_turn_${sessionId}:${attemptId}`);
const steerPromptId = (sessionId: string, messageId: string) =>
  SessionMessage.ID.make(`msg_t3_steer_${sessionId}:${messageId}`);

const promptOf = (turn: OrchestrationV2ProviderTurn) => {
  const nativeId = turn.nativeTurnRef?.nativeId;
  return nativeId?.startsWith("msg_") === true ? nativeId : undefined;
};

const boundaryAfter = (
  turns: ReadonlyArray<OrchestrationV2ProviderTurn>,
  providerThreadId: OrchestrationV2ProviderThread["id"],
  kept: OrchestrationV2ProviderTurn | undefined,
  prompts: ReadonlySet<string>,
) => {
  const later = turns
    .filter(
      (turn) =>
        turn.providerThreadId === providerThreadId &&
        (kept === undefined || turn.ordinal > kept.ordinal),
    )
    .toSorted((left, right) => left.ordinal - right.ordinal);
  if (later.some((turn) => promptOf(turn) === undefined && !isWakeTurn(turn))) {
    return Effect.fail(
      new ProviderAdapter.ProviderAdapterProtocolError({
        driver: OPENCODE_PROVIDER,
        detail:
          "This OpenCode conversation has turns from an earlier T3 Code version, so it can't be cut there.",
      }),
    );
  }
  return Effect.succeed(
    later.map(promptOf).find((messageId) => messageId !== undefined && prompts.has(messageId)) ??
      null,
  );
};

const isProviderAdapterError = Schema.is(ProviderAdapter.ProviderAdapterV2Error);

const modelRef = (selection: ProviderAdapter.ProviderAdapterV2TurnInput["modelSelection"]) => {
  const parsed = OpenCodeRuntime.parseOpenCodeModelSlug(selection.model);
  if (parsed === null) return undefined;
  const variant = getModelSelectionStringOptionValue(selection, "variant");
  return Model.Ref.make({
    providerID: Provider.ID.make(parsed.providerID),
    id: Model.ID.make(parsed.modelID),
    ...(variant === undefined ? {} : { variant: Model.VariantID.make(variant) }),
  });
};
const malformedModel = (model: string) =>
  `OpenCode model '${model}' must use provider/model format`;
const sameModel = (left: ModelRef, right: ModelRef | undefined) =>
  left.providerID === right?.providerID &&
  left.id === right?.id &&
  (left.variant ?? "default") === (right?.variant ?? "default");

const agentFor = (input: ProviderAdapter.ProviderAdapterV2TurnInput) =>
  input.runtimePolicy.interactionMode === "plan" ? "plan" : "build";

const commandOf = (text: string) => {
  const match = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  return match === null ? undefined : { name: match[1]!, text: match[2] ?? "" };
};

const SKILL_MENTION = new RegExp(SKILL_MENTION_PATTERN.source, "u");

const skillsNamed = (text: string, known: ReadonlySet<string>) => [
  ...new Set(
    [...text.matchAll(SKILL_MENTION_PATTERN)].flatMap((match) =>
      known.has(match[2] ?? "") ? [match[2]!] : [],
    ),
  ),
];

const turnTokenUsage = (turn: ActiveTurn, status: OrchestrationV2ProviderTurn["status"]) =>
  turn.steps === 0
    ? {
        usageScope: "main_agent" as const,
        usageStatus: "unavailable" as const,
        hasSubagents: turn.usedSubagents,
      }
    : {
        usageScope: "main_agent" as const,
        usageStatus: status === "completed" ? ("complete" as const) : ("partial" as const),
        inputTokens: turn.usage.input,
        cachedInputTokens: turn.usage.cached,
        cacheCreationTokens: turn.usage.cacheWrite,
        outputTokens: turn.usage.output,
        reasoningTokens: turn.usage.reasoning,
        hasSubagents: turn.usedSubagents,
      };

export const make = Effect.fn("OpenCode2Adapter.make")(function* (instanceId: ProviderInstanceId) {
  const server = yield* OpenCode2Server.OpenCode2Server;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const host = yield* ProviderHost.ProviderHost;
  const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
  const fileSystem = yield* FileSystem.FileSystem;
  const continuationRequests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
  const crypto = yield* Crypto.Crypto;
  const driver = OPENCODE_PROVIDER;
  const mcpServerNameFor = (threadId: string) =>
    t3McpServerName(threadId).pipe(Effect.provideService(Crypto.Crypto, crypto));

  const borrow = Effect.gen(function* () {
    const lent = yield* Deferred.make<
      OpenCode2Server.OpenCode2Connection,
      OpenCodeRuntime.OpenCodeRuntimeError
    >();
    yield* server
      .withConnection((connection) =>
        Deferred.succeed(lent, connection).pipe(Effect.andThen(Effect.never)),
      )
      .pipe(
        Effect.catch((error) => Deferred.fail(lent, error)),
        Effect.forkScoped,
      );
    return yield* Deferred.await(lent);
  });

  const openSession = Effect.fn("OpenCode2Adapter.openSession")(function* (
    input: Parameters<ProviderAdapter.ProviderAdapterV2["Service"]["openSession"]>[0],
    initial: {
      readonly connection: OpenCode2Server.OpenCode2Connection;
      readonly scope: Scope.Closeable;
    },
  ) {
    let connection = initial.connection;
    let client = connection.client;
    const sessionScope = yield* Effect.scope;
    // Context windows by directory, then `provider/model`: a project's own
    // OpenCode config can change a model's limits, and this one runtime serves
    // the instance's threads in every directory.
    const contextWindows = new Map<string, Map<string, number>>();
    const directoryOf = (cwd: string | null | undefined) => cwd ?? host.paths.cwd;
    const windowOf = (cwd: string | null | undefined, model: string) =>
      contextWindows.get(directoryOf(cwd))?.get(model);
    const now = yield* DateTime.now;
    let session: OrchestrationV2ProviderSession = {
      id: input.providerSessionId,
      driver,
      providerInstanceId: instanceId,
      status: "ready",
      cwd: input.runtimePolicy.cwd ?? host.paths.cwd,
      model: input.modelSelection.model,
      capabilities: OpenCode2ProviderCapabilities,
      createdAt: now,
      updatedAt: now,
      lastError: null,
    };
    const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event, Cause.Done>();
    const threads = new Map<string, ThreadState>();
    const childOwners = new Map<string, ThreadState>();
    const announced = new Map<string, EventOf<"session.created">["data"]>();
    const strays = new Map<string, ThreadState>();
    const busy = new Set<string>();
    const shells = new Map<string, string>(); // running shell id -> the session that started it
    const runsShell = (sessionId: string) => [...shells.values()].includes(sessionId);
    const pending = new Map<RuntimeRequestId, PendingRequest>();
    const lock = yield* Semaphore.make(1);
    const clearing = new Map<string, Deferred.Deferred<void>>();
    const stagedReverts = new Set<string>();
    const sessionGates = yield* KeyedLock.make<string>();
    const exclusive =
      (providerThread: OrchestrationV2ProviderThread) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>) => {
        const sessionId = providerThread.nativeThreadRef?.nativeId;
        if (sessionId == null) return effect;
        return sessionGates.withLock(sessionId, effect);
      };
    const emit = (event: ProviderAdapter.ProviderAdapterV2Event) =>
      Queue.offer(events, event).pipe(Effect.asVoid);
    const ownerOf = (sessionId: string) => childOwners.get(sessionId) ?? threads.get(sessionId);
    const markUnsettled = (state: ThreadState) => {
      state.unsettled = true;
      state.unsettledStarted = busy.has(state.sessionId);
    };

    const newThreadState = (
      sessionId: string,
      providerThread: OrchestrationV2ProviderThread,
      directory: string,
      subagent: ThreadState["subagent"],
    ): ThreadState => ({
      sessionId,
      providerThread,
      providerTurns: new Map(),
      active: undefined,
      model: undefined,
      unsettled: false,
      unsettledStarted: false,
      directory,
      agent: "build",
      title: undefined,
      rules: undefined,
      policy: input.runtimePolicy,
      grants: [],
      calls: new Map(),
      subagent,
      wakes: [],
      reports: new Map(),
      stoppedChildren: new Set(),
      strandedSteers: new Set(),
      executions: 0,
      execution: 0,
      mcp: undefined,
      instructions: undefined,
    });

    const rootOf = (state: ThreadState): ThreadState => {
      let current = state;
      while (current.subagent !== undefined) current = current.subagent.call.state;
      return current;
    };

    const sessionsOf = (thread: ThreadState): ReadonlyArray<ThreadState> => [
      thread,
      ...[...threads.values()].filter((state) => {
        for (let above = state.subagent?.call.state; above; above = above.subagent?.call.state) {
          if (above === thread) return true;
        }
        return false;
      }),
    ];

    const runningCalls = (thread: ThreadState): ReadonlyArray<SubagentCall> =>
      sessionsOf(thread).flatMap((state) => [...state.calls.values()]);

    /**
     * The calls a subagent session answers for: the one that launched it and
     * the ones that joined it while it ran.
     */
    const callsAttachedTo = (child: ThreadState): ReadonlyArray<SubagentCall> => {
      const parent = child.subagent?.call.state;
      if (parent === undefined) return [];
      return [...parent.calls.values()].filter((candidate) => candidate.child === child);
    };

    const callsAbove = (sessionId: string) => {
      const calls: Array<SubagentCall> = [];
      let current = threads.get(sessionId);
      while (current?.subagent !== undefined) {
        calls.push(current.subagent.call);
        current = current.subagent.call.state;
      }
      return calls;
    };

    const requestTurn = (sessionId: string) => {
      const state = ownerOf(sessionId);
      if (state === undefined) return undefined;
      const background = callsAbove(sessionId).findLast((call) => call.background);
      if (background !== undefined) {
        return isOrchestrationV2WorkActive(background.status)
          ? { state, turn: background.turn }
          : undefined;
      }
      const turn = runningTurn(state);
      return turn === undefined ? undefined : { state, turn };
    };

    const owesWork = (state: ThreadState) =>
      state.wakes.length > 0 ||
      state.reports.size > 0 ||
      (state.subagent !== undefined && busy.has(state.sessionId)) ||
      [...state.calls.values()].some((call) => call.background) ||
      runsShell(state.sessionId);

    const hasBackground = (thread: ThreadState) => sessionsOf(thread).some(owesWork);

    const setSessionStatus =
      /* Provider events include streaming deltas; avoid a span for each update. */
      Effect.fnUntraced(function* (
        status: OrchestrationV2ProviderSession["status"],
        lastError: string | null,
      ) {
        // The session is shared by every thread on this instance and is persisted
        // once per attached thread, so a repeat of the same state is not worth a write.
        if (session.status === status && session.lastError === lastError) return;
        session = { ...session, status, lastError, updatedAt: yield* DateTime.now };
        yield* emit({ type: "provider_session.updated", driver, providerSession: session });
      });

    const ordinalOf = (turn: ActiveTurn, nativeId: string) => {
      const known = turn.ordinals.get(nativeId);
      if (known !== undefined) return known;
      const next = turn.nextOrdinal++;
      turn.ordinals.set(nativeId, next);
      return next;
    };

    const itemBase = (
      state: ThreadState,
      turn: ActiveTurn,
      nativeId: string,
      status: OrchestrationV2TurnItem["status"],
      startedAt: DateTime.Utc,
      completedAt: DateTime.Utc | null,
      updatedAt: DateTime.Utc,
    ) => ({
      id: idAllocator.derive.turnItemFromProviderItem({ driver, nativeItemId: nativeId }),
      threadId: turn.input.threadId,
      runId: turn.input.runId,
      nodeId: idAllocator.derive.nodeFromProviderItem({ driver, nativeItemId: nativeId }),
      providerThreadId: state.providerThread.id,
      providerTurnId: turn.providerTurn.id,
      nativeItemRef: ref(nativeId),
      parentItemId: null,
      ordinal: ordinalOf(turn, nativeId),
      status,
      title: null,
      startedAt,
      completedAt,
      updatedAt,
    });

    const emitNode = (
      state: ThreadState,
      turn: ActiveTurn,
      nativeId: string,
      kind: OrchestrationV2ExecutionNode["kind"],
      status: OrchestrationV2ExecutionNode["status"],
      startedAt: DateTime.Utc,
      completedAt: DateTime.Utc | null,
    ) => {
      const node: OrchestrationV2ExecutionNode = {
        id: idAllocator.derive.nodeFromProviderItem({ driver, nativeItemId: nativeId }),
        threadId: turn.input.threadId,
        runId: turn.input.runId,
        parentNodeId: turn.input.rootNodeId,
        rootNodeId: turn.input.rootNodeId,
        kind,
        status,
        countsForRun: false,
        providerThreadId: state.providerThread.id,
        providerTurnId: turn.providerTurn.id,
        nativeItemRef: ref(nativeId),
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt,
        completedAt,
      };
      // Text and tool updates arrive per delta while their node stays the same.
      const key = JSON.stringify(node);
      if (turn.nodes.get(nativeId) === key) return Effect.void;
      turn.nodes.set(nativeId, key);
      return emit({ type: "node.updated", driver, node });
    };

    const emitText = Effect.fnUntraced(function* (
      state: ThreadState,
      turn: ActiveTurn,
      data: {
        readonly assistantMessageID: string;
        readonly ordinal: number;
        readonly text?: string;
      },
      kind: "text" | "reasoning",
      update: (current: string) => string,
      completed = "text" in data,
    ) {
      const nativeId = `${data.assistantMessageID}:${kind}:${data.ordinal}`;
      const updatedAt = yield* DateTime.now;
      const entry = turn.texts.get(nativeId) ?? {
        block: data,
        kind,
        startedAt: updatedAt,
        text: "",
      };
      entry.text = update(entry.text);
      if (completed) {
        turn.texts.delete(nativeId);
        if (kind === "text" && entry.text.length > 0 && !turn.finishByMessage.has(data.assistantMessageID)) {
          turn.awaitingFinish.set(nativeId, { block: entry.block, text: entry.text });
        }
      } else turn.texts.set(nativeId, entry);
      if (entry.text.length === 0) return;
      const status = completed ? "completed" : "running";
      const completedAt = completed ? updatedAt : null;
      const nodeKind = kind === "text" ? "assistant_message" : "reasoning";
      yield* emitNode(state, turn, nativeId, nodeKind, status, entry.startedAt, completedAt);
      const base = itemBase(state, turn, nativeId, status, entry.startedAt, completedAt, updatedAt);
      if (kind === "reasoning") {
        yield* emit({
          type: "turn_item.updated",
          driver,
          turnItem: { ...base, type: "reasoning", text: entry.text, streaming: !completed },
        });
        return;
      }
      const messageId = idAllocator.derive.messageFromProviderItem({
        driver,
        nativeItemId: nativeId,
      });
      const phase = turn.narrationTexts.has(nativeId)
        ? "narration"
        : phaseFromFinish(turn.finishByMessage.get(data.assistantMessageID));
      const message: OrchestrationV2ConversationMessage = {
        createdBy: "agent",
        creationSource: "provider",
        id: messageId,
        threadId: turn.input.threadId,
        runId: turn.input.runId,
        nodeId: base.nodeId,
        role: "assistant",
        text: entry.text,
        phase,
        attachments: [],
        streaming: !completed,
        createdAt: entry.startedAt,
        updatedAt,
      };
      yield* emit({ type: "message.updated", driver, message });
      yield* emit({
        type: "turn_item.updated",
        driver,
        turnItem: {
          ...base,
          type: "assistant_message",
          messageId,
          text: entry.text,
          phase,
          streaming: !completed,
        },
      });
    });

    const emitTool = Effect.fnUntraced(function* (
      state: ThreadState,
      turn: ActiveTurn,
      id: string,
      status: "running" | "completed" | "failed" | "interrupted",
      result?: { readonly output: string | undefined; readonly metadata: unknown },
    ) {
      const tool = turn.tools.get(id);
      if (tool === undefined) return;
      const updatedAt = yield* DateTime.now;
      const startedAt = turn.startedAt.get(id) ?? updatedAt;
      const completedAt = status === "running" ? null : updatedAt;
      const nativeId = `${turn.scope}${id}`;
      yield* emitNode(state, turn, nativeId, "tool_call", status, startedAt, completedAt);
      yield* emit({
        type: "turn_item.updated",
        driver,
        turnItem: openCodeToolTurnItem(
          itemBase(state, turn, nativeId, status, startedAt, completedAt, updatedAt),
          {
            name: tool.name,
            input: tool.input,
            output: result?.output,
            completedMetadata: status === "completed" ? result?.metadata : undefined,
          },
        ),
      });
    });

    const emitCompaction = Effect.fnUntraced(function* (
      state: ThreadState,
      turn: ActiveTurn,
      status: "running" | "completed" | "failed" | "interrupted",
      summary?: string,
    ) {
      const compaction = turn.compaction;
      if (compaction === undefined) return;
      const updatedAt = yield* DateTime.now;
      const completedAt = status === "running" ? null : updatedAt;
      yield* emit({
        type: "turn_item.updated",
        driver,
        turnItem: {
          ...itemBase(
            state,
            turn,
            compaction.nativeId,
            status,
            compaction.startedAt,
            completedAt,
            updatedAt,
          ),
          nodeId: turn.input.rootNodeId,
          type: "compaction",
          driver,
          title:
            status === "running"
              ? "Compacting context"
              : status === "completed"
                ? "Context compacted"
                : status === "failed"
                  ? "Compaction failed"
                  : "Compaction interrupted",
          ...(summary === undefined || summary.length === 0 ? {} : { summary }),
        },
      });
      if (status !== "running") turn.compaction = undefined;
    });

    const emitProviderTurn = (
      state: ThreadState,
      turn: ActiveTurn,
      providerTurn: OrchestrationV2ProviderTurn,
    ) => {
      state.providerTurns.set(String(providerTurn.id), providerTurn);
      return emit({
        type: "provider_turn.updated",
        driver,
        threadId: turn.input.threadId,
        providerTurn,
      });
    };

    const makeTurn = (
      owner: TurnOwner,
      providerTurn: OrchestrationV2ProviderTurn,
      options: { readonly scope: string; readonly awaitingStart: boolean },
    ): ActiveTurn => ({
      input: owner,
      providerTurn,
      texts: new Map(),
      tools: new Map(),
      startedAt: new Map(),
      nodes: new Map(),
      ordinals: new Map(),
      nextOrdinal: providerTurn.ordinal * 100 + 1,
      usage: { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0 },
      steps: 0,
      lastStep: undefined,
      lastFinish: null,
      finishByMessage: new Map(),
      narrationTexts: new Set(),
      awaitingFinish: new Map(),
      before: undefined,
      compaction: undefined,
      compactions: 0,
      interrupted: false,
      unsent: false,
      parked: false,
      submitting: false,
      steers: new Set(),
      settledInbox: new Set(),
      heldEnd: undefined,
      awaitingStart: options.awaitingStart,
      scope: options.scope,
      usedSubagents: false,
    });

    const emitSubagent = Effect.fnUntraced(function* (call: SubagentCall) {
      const updatedAt = yield* DateTime.now;
      const { turn, state } = call;
      const nodeId = idAllocator.derive.nodeFromProviderItem({
        driver,
        nativeItemId: call.nativeId,
      });
      const completedAt = isOrchestrationV2WorkActive(call.status)
        ? null
        : (call.completedAt ?? updatedAt);
      const childProviderThreadId = call.child?.providerThread.id ?? null;
      const childThreadId = call.child?.subagent?.appThread.id ?? null;
      // Reconnect backfill can report this call through emitTool, so its cached node is stale now.
      turn.nodes.delete(call.nativeId);
      yield* emit({
        type: "node.updated",
        driver,
        node: {
          id: nodeId,
          threadId: turn.input.threadId,
          runId: turn.input.runId,
          parentNodeId: turn.input.rootNodeId,
          rootNodeId: turn.input.rootNodeId,
          kind: "subagent",
          status: call.status,
          countsForRun: false,
          providerThreadId: childProviderThreadId ?? state.providerThread.id,
          providerTurnId: turn.providerTurn.id,
          nativeItemRef: ref(call.nativeId),
          runtimeRequestId: null,
          checkpointScopeId: null,
          startedAt: call.startedAt,
          completedAt,
        },
      });
      yield* emit({
        type: "subagent.updated",
        driver,
        subagent: {
          id: nodeId,
          threadId: turn.input.threadId,
          runId: turn.input.runId,
          parentNodeId: turn.input.rootNodeId,
          origin: "provider_native",
          createdBy: "agent",
          driver,
          providerInstanceId: instanceId,
          providerThreadId: childProviderThreadId,
          childThreadId,
          nativeTaskRef: ref(call.nativeId),
          prompt: call.prompt,
          title: call.title,
          model: call.model,
          status: call.status,
          result: call.result,
          startedAt: call.startedAt,
          completedAt,
          updatedAt,
        },
      });
      yield* emit({
        type: "turn_item.updated",
        driver,
        turnItem: {
          id: idAllocator.derive.turnItemFromProviderItem({ driver, nativeItemId: call.nativeId }),
          threadId: turn.input.threadId,
          runId: turn.input.runId,
          nodeId,
          providerThreadId: state.providerThread.id,
          providerTurnId: turn.providerTurn.id,
          nativeItemRef: ref(call.nativeId),
          parentItemId: null,
          ordinal: call.ordinal,
          status: call.status,
          title: call.title,
          startedAt: call.startedAt,
          completedAt,
          updatedAt,
          type: "subagent",
          subagentId: nodeId,
          origin: "provider_native",
          driver,
          providerInstanceId: instanceId,
          childThreadId,
          prompt: call.prompt,
          result: call.result,
        },
      });
      yield* syncRoster(rootOf(call.state));
    });

    const syncRoster = Effect.fnUntraced(function* (state: ThreadState) {
      const roster = runningCalls(state)
        .filter((call) => call.background)
        .map((call) => ({
          taskId: call.nativeId,
          kind: "subagent" as const,
          ...(call.title?.trim() ? { description: call.title.trim() } : {}),
          ...(call.child?.subagent === undefined
            ? {}
            : { childThreadId: call.child.subagent.appThread.id }),
        }));
      const current = state.providerThread.pendingBackgroundTasks ?? [];
      if (
        current.length === roster.length &&
        current.every(
          (task, index) =>
            task.taskId === roster[index]?.taskId &&
            task.description === roster[index]?.description &&
            (task.kind === "subagent" ? task.childThreadId : undefined) ===
              roster[index]?.childThreadId,
        )
      ) {
        return;
      }
      state.providerThread = {
        ...state.providerThread,
        pendingBackgroundTasks: roster,
        updatedAt: yield* DateTime.now,
      };
      yield* emit({
        type: "provider_thread.updated",
        driver,
        providerThread: state.providerThread,
      });
    });

    const withReportedModel = (
      providerThread: OrchestrationV2ProviderThread,
      model: ModelRef | undefined,
    ): OrchestrationV2ProviderThread => {
      if (model === undefined) return providerThread;
      const modelSelection: ModelSelection = {
        instanceId,
        model: `${model.providerID}/${model.id}`,
        options: model.variant === undefined ? [] : [{ id: "variant", value: model.variant }],
      };
      if (
        providerThread.nativeMetadata?.modelSelection !== undefined &&
        modelSelectionsEqual(providerThread.nativeMetadata.modelSelection, modelSelection)
      )
        return providerThread;
      return {
        ...providerThread,
        nativeMetadata: { ...providerThread.nativeMetadata, modelSelection },
      };
    };

    const attachChild = Effect.fnUntraced(function* (call: SubagentCall, childId: string) {
      if (call.child !== undefined) return;
      const info = announced.get(childId);
      announced.delete(childId);
      const now = yield* DateTime.now;
      const nodeId = idAllocator.derive.nodeFromProviderItem({
        driver,
        nativeItemId: call.nativeId,
      });
      const childThreadId = idAllocator.derive.threadFromProviderThread({
        driver,
        nativeThreadId: childId,
        providerInstanceId: instanceId,
      });
      const providerThreadId = idAllocator.derive.providerThread({
        driver,
        nativeThreadId: childId,
        providerInstanceId: instanceId,
      });
      if (info?.model !== undefined) call.model = `${info.model.providerID}/${info.model.id}`;
      call.title = call.title ?? info?.title ?? null;
      const parentThread = call.turn.input.appThread;
      const appThread = makeSubagentChildThread({
        parentThread,
        childThreadId,
        parentNodeId: nodeId,
        activeProviderThreadId: providerThreadId,
        providerInstanceId: instanceId,
        modelSelection: {
          instanceId,
          model: call.model ?? call.turn.input.modelSelection.model,
        },
        title: subagentThreadTitle({
          parentTitle: parentThread.title,
          title: call.title,
          prompt: call.prompt,
          ordinal: call.ordinal,
        }),
        now,
        createdBy: "agent",
        creationSource: "provider",
      });
      const providerThread: OrchestrationV2ProviderThread = {
        id: providerThreadId,
        driver,
        providerInstanceId: instanceId,
        providerSessionId: input.providerSessionId,
        appThreadId: childThreadId,
        ownerNodeId: nodeId,
        nativeThreadRef: ref(childId),
        nativeConversationHeadRef: null,
        status: "active",
        firstRunOrdinal: null,
        lastRunOrdinal: null,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      };
      const previous = threads.get(childId);
      // Called again while it runs, the subagent takes the prompt as a steer
      // and OpenCode reports that run once, for every call that joined it.
      if (previous?.active !== undefined) {
        call.joined = [...call.state.calls.values()].findLast(
          (candidate) =>
            candidate !== call && candidate.child === previous && candidate.joined === undefined,
        );
      }
      const subagent = {
        call,
        appThread,
        turns: previous?.subagent?.turns ?? 0,
        prompt: call.prompt,
        queued: undefined,
      };
      const child =
        previous ?? newThreadState(childId, providerThread, call.state.directory, subagent);
      child.subagent = subagent;
      child.model = info?.model ?? child.model;
      child.providerThread = withReportedModel(providerThread, child.model);
      child.directory = call.state.directory;
      child.agent = info?.agent ?? call.agent ?? child.agent;
      child.rules = info?.permissions ?? child.rules;
      threads.set(childId, child);
      childOwners.set(childId, rootOf(call.state));
      call.child = child;
      yield* emit({ type: "app_thread.created", driver, appThread });
      yield* emit({
        type: "provider_thread.updated",
        driver,
        providerThread: child.providerThread,
      });
      yield* emitSubagent(call);
      // A session called again was not made now, so it may hold the rules of
      // a mode the thread has left. OpenCode applies a rules change to the
      // asks after it, so it gets the thread's as soon as its call names it.
      if (info === undefined) {
        yield* writeRules(child, rootOf(call.state).policy).pipe(
          Effect.timeout(REQUEST_REPLY_TIMEOUT),
          Effect.ignore({ log: true }),
        );
      }
    });

    const settleCall: (
      call: SubagentCall,
      status: OrchestrationV2Subagent["status"],
      result?: string,
    ) => Effect.Effect<void> = Effect.fnUntraced(function* (call, status, result) {
      if (!isOrchestrationV2WorkActive(call.status)) return;
      call.status = status;
      call.completedAt = yield* DateTime.now;
      if (result !== undefined) call.result = result;
      call.state.calls.delete(call.toolId);
      const child = call.child;
      if (child !== undefined) {
        for (const nested of Array.from(child.calls.values())) {
          if (nested.background && status !== "failed") continue;
          yield* settleCall(nested, status === "completed" ? "interrupted" : status);
        }
        if (child.active !== undefined && status !== "completed") {
          yield* finishTurn(child, { status: "interrupted" });
        }
        child.providerThread = {
          ...child.providerThread,
          status: "idle",
          updatedAt: call.completedAt,
        };
        yield* emit({
          type: "provider_thread.updated",
          driver,
          providerThread: child.providerThread,
        });
      }
      yield* emitSubagent(call);
    });

    const startChildTurn = Effect.fnUntraced(function* (child: ThreadState) {
      const subagent = child.subagent;
      if (subagent === undefined || child.active !== undefined) return;
      subagent.turns += 1;
      const startedAt = yield* DateTime.now;
      const nativeTurnId = `${child.sessionId}:turn:${subagent.turns}`;
      const rootNodeId = idAllocator.derive.nodeFromProviderItem({
        driver,
        nativeItemId: `${nativeTurnId}:root`,
      });
      const providerTurn: OrchestrationV2ProviderTurn = {
        id: idAllocator.derive.providerTurn({ driver, nativeTurnId }),
        providerThreadId: child.providerThread.id,
        nodeId: rootNodeId,
        runAttemptId: null,
        nativeTurnRef: ref(nativeTurnId, "weak"),
        ordinal: subagent.turns,
        status: "running",
        startedAt,
        completedAt: null,
      };
      const turn = makeTurn(
        {
          appThread: subagent.appThread,
          threadId: subagent.appThread.id,
          runId: null,
          runOrdinal: subagent.call.turn.input.runOrdinal,
          rootNodeId,
          modelSelection: subagent.appThread.modelSelection,
          runtimePolicy: subagent.call.turn.input.runtimePolicy,
        },
        providerTurn,
        { scope: `${child.sessionId}:`, awaitingStart: false },
      );
      turn.before = subagent.queued;
      subagent.queued = undefined;
      child.active = turn;
      yield* emit({
        type: "node.updated",
        driver,
        node: {
          id: rootNodeId,
          threadId: turn.input.threadId,
          runId: null,
          parentNodeId: null,
          rootNodeId,
          kind: "root_turn",
          status: "running",
          countsForRun: false,
          providerThreadId: child.providerThread.id,
          providerTurnId: providerTurn.id,
          nativeItemRef: ref(nativeTurnId, "weak"),
          runtimeRequestId: null,
          checkpointScopeId: null,
          startedAt,
          completedAt: null,
        },
      });
      yield* emitProviderTurn(child, turn, providerTurn);
      const prompt = subagent.prompt;
      subagent.prompt = undefined;
      if (prompt !== undefined && prompt.length > 0) {
        const nativeId = `${nativeTurnId}:prompt`;
        const artifacts = makeSubagentConversationArtifacts({
          messageId: idAllocator.derive.messageFromProviderItem({ driver, nativeItemId: nativeId }),
          senderThreadId: subagent.call.turn.input.threadId,
          turnItemId: idAllocator.derive.turnItemFromProviderItem({
            driver,
            nativeItemId: nativeId,
          }),
          threadId: turn.input.threadId,
          rootNodeId,
          providerThreadId: child.providerThread.id,
          providerTurnId: providerTurn.id,
          nativeItemRef: ref(nativeId, "weak"),
          role: "user",
          text: prompt,
          ordinal: ordinalOf(turn, nativeId),
          now: startedAt,
        });
        yield* emit({ type: "message.updated", driver, message: artifacts.message });
        yield* emit({ type: "turn_item.updated", driver, turnItem: artifacts.turnItem });
      }
    });

    const offerWake = Effect.fnUntraced(function* (state: ThreadState, wake: Wake) {
      const route = state.providerThread.appThreadId;
      if (route === null || wake.messageId === undefined) return;
      const notification = backgroundWorkNotification(wake.reports);
      yield* continuationRequests.offer({
        threadId: route,
        providerThreadId: state.providerThread.id,
        driver,
        detail: wake.detail,
        messageId: wake.messageId,
        ...(notification === null ? {} : { notification }),
        dispatchIfCurrent: (dispatch) =>
          wake.dropped ? Effect.succeed(Option.none()) : Effect.map(dispatch, Option.some),
      });
    });

    const finishTurn = Effect.fnUntraced(function* (
      state: ThreadState,
      terminal: TurnTerminal,
      threadDisposition: "reusable" | "broken" = "reusable",
    ) {
      const turn = state.active;
      if (turn === undefined) return;
      state.active = undefined;
      for (const inboxID of turn.steers) state.strandedSteers.add(inboxID);
      for (const entry of pending.values()) {
        const background = callsAbove(entry.sessionId).some((call) => call.background);
        if (
          entry.sessionId === state.sessionId ||
          (entry.turn === turn && !(background && terminal.status !== "failed"))
        ) {
          yield* settleRequest(entry, "cancelled");
        }
      }
      const completedAt = yield* DateTime.now;
      for (const open of turn.texts.values()) {
        yield* emitText(state, turn, open.block, open.kind, (text) => text, true);
      }
      for (const id of turn.tools.keys()) {
        yield* emitTool(
          state,
          turn,
          id,
          terminal.status === "completed" ? "completed" : "interrupted",
        );
      }
      for (const call of Array.from(state.calls.values())) {
        if (call.turn !== turn) continue;
        if (call.background && terminal.status !== "failed") continue;
        yield* settleCall(call, terminal.status === "completed" ? "completed" : terminal.status);
      }
      if (state.subagent !== undefined) {
        yield* emit({
          type: "node.updated",
          driver,
          node: {
            id: turn.input.rootNodeId,
            threadId: turn.input.threadId,
            runId: null,
            parentNodeId: null,
            rootNodeId: turn.input.rootNodeId,
            kind: "root_turn",
            status: terminal.status,
            countsForRun: false,
            providerThreadId: state.providerThread.id,
            providerTurnId: turn.providerTurn.id,
            nativeItemRef: turn.providerTurn.nativeTurnRef,
            runtimeRequestId: null,
            checkpointScopeId: null,
            startedAt: turn.providerTurn.startedAt,
            completedAt,
          },
        });
      }
      yield* emitCompaction(state, turn, terminal.status === "failed" ? "failed" : "interrupted");
      const window = windowOf(turn.input.runtimePolicy.cwd, turn.input.modelSelection.model);
      const lastStep = turn.lastStep;
      yield* emitProviderTurn(state, turn, {
        ...turn.providerTurn,
        status: terminal.status,
        completedAt,
        finish: turn.lastFinish,
        turnTokenUsage: turnTokenUsage(turn, terminal.status),
        ...(lastStep === undefined
          ? {}
          : {
              tokenUsage: {
                usedTokens:
                  lastStep.input + lastStep.cache.read + lastStep.cache.write + lastStep.output,
                maxTokens: window ?? null,
                inputTokens: lastStep.input + lastStep.cache.read + lastStep.cache.write,
                cachedInputTokens: lastStep.cache.read,
                outputTokens: lastStep.output,
                reasoningOutputTokens: lastStep.reasoning,
                updatedAt: DateTime.formatIso(completedAt),
              },
            }),
      });
      // A subagent's session is its call's to settle: a turn there is runless,
      // and T3 has no terminal to wait on.
      if (state.subagent !== undefined) {
        const call = state.subagent.call;
        if (!call.background && terminal.status !== "completed") {
          yield* settleCall(call, terminal.status);
          yield* settleShared(call, terminal.status);
        }
        if (terminal.status === "failed") {
          // A background call is settled by the report its parent reads, and a
          // child that failed has no report to read: every call attached to it
          // has to end with the failure, or the background ones keep the thread
          // showing work that is gone. Which of them joined the child last
          // does not matter: a foreground call is one until it is marked
          // background, and the earlier background call outlives that window.
          for (const attached of callsAttachedTo(state)) {
            yield* settleCall(attached, terminal.status, terminal.failure.message);
          }
        }
        return;
      }
      state.providerThread = {
        ...state.providerThread,
        status: threadDisposition === "broken" ? "error" : "idle",
        updatedAt: completedAt,
      };
      yield* emit({
        type: "provider_thread.updated",
        driver,
        providerThread: state.providerThread,
      });
      const anyActive = [...threads.values()].some(
        (candidate) => candidate.subagent === undefined && candidate.active !== undefined,
      );
      yield* setSessionStatus(pending.size > 0 ? "waiting" : anyActive ? "running" : "ready", null);
      const base = {
        type: "turn.terminal" as const,
        driver,
        // After a native fork the session's own thread has a fresh id, and the
        // terminal must name the thread the start was recorded against.
        providerThreadId: turn.providerTurn.providerThreadId,
        providerTurnId: turn.providerTurn.id,
        runOrdinal: turn.input.runOrdinal,
        threadDisposition,
      };
      yield* emit(
        terminal.status === "failed"
          ? {
              ...base,
              status: "failed",
              failure: terminal.failure,
              failureItemOrdinal: ordinalOf(turn, `terminal-failure:${turn.providerTurn.id}`),
            }
          : { ...base, status: terminal.status, failure: null },
      );
      // A spawned server lists its models lazily, so a window still unknown is
      // read again for the next turn, off this stream so it never delays one.
      if (window === undefined) {
        yield* Effect.forkIn(readModels(directoryOf(turn.input.runtimePolicy.cwd)), sessionScope);
      }
    });

    /**
     * Ends the turn a request T3 could not answer would block, and stops the
     * session: OpenCode waits on an unanswered request forever. The stopped
     * run's end is its own, not the next turn's.
     */
    const abandonRequest = Effect.fnUntraced(function* (state: ThreadState, reason: string) {
      yield* Effect.logWarning("Could not answer an OpenCode request; ending its turn.", {
        reason,
      });
      if (state.active === undefined) return;
      markUnsettled(state);
      yield* finishTurn(state, {
        status: "failed",
        failure: makeProviderFailure({
          message: "OpenCode is waiting on a request T3 Code couldn't answer.",
          class: "provider_error",
        }),
      });
      yield* client.session
        .interrupt({ sessionID: Session.ID.make(state.sessionId) })
        .pipe(Effect.timeout("2 seconds"), Effect.ignore({ log: true }));
    });

    const forgetRequest = Effect.fnUntraced(function* (entry: PendingRequest) {
      if (!pending.delete(entry.request.id)) return false;
      if (pending.size === 0 && session.status === "waiting") {
        yield* setSessionStatus("running", null);
      }
      return true;
    });

    /**
     * T3's own answers are only forgotten: the orchestrator already recorded them.
     */
    const settleRequest = Effect.fnUntraced(function* (
      entry: PendingRequest,
      status: "resolved" | "cancelled",
    ) {
      if (!(yield* forgetRequest(entry)) || entry.answering) return;
      const now = yield* DateTime.now;
      const itemStatus = status === "resolved" ? "completed" : "cancelled";
      yield* emit({
        type: "runtime_request.updated",
        driver,
        threadId: entry.turn.input.threadId,
        runtimeRequest: { ...entry.request, status, resolvedAt: now },
      });
      yield* emit({
        type: "node.updated",
        driver,
        node: { ...entry.node, status: itemStatus, completedAt: now },
      });
      yield* emit({
        type: "turn_item.updated",
        driver,
        turnItem: { ...entry.item, status: itemStatus, completedAt: now, updatedAt: now },
      });
    });

    const stopStaleRequest = (
      sessionId: string,
      native: { readonly type: "permission" | "form"; readonly id: string },
    ): Effect.Effect<void> =>
      native.type === "permission"
        ? client.permission
            .reply({
              sessionID: Session.ID.make(sessionId),
              requestID: Permission.ID.make(native.id),
              decision: "reject",
            })
            .pipe(
              Effect.catchTags(permissionGone),
              Effect.timeout(REQUEST_REPLY_TIMEOUT),
              Effect.ignore({ log: true }),
            )
        : client.session.form
            .cancel({ sessionID: sessionId, formID: Form.ID.make(native.id) })
            .pipe(
              Effect.catchTags(formGone),
              Effect.timeout(REQUEST_REPLY_TIMEOUT),
              Effect.ignore({ log: true }),
            );

    /**
     * Stops what a session still waits on when this runtime first loads it:
     * T3 shows none of those requests (a restart or a closed session expired
     * them), and OpenCode would wait on them forever.
     */
    const stopLeftoverRequests = Effect.fnUntraced(function* (state: ThreadState) {
      const sessionID = Session.ID.make(state.sessionId);
      const listed = yield* Effect.all([
        client.permission.list({ sessionID }),
        client.session.form.list({ sessionID }),
      ]).pipe(Effect.timeout(ACTIVE_CHECK_TIMEOUT), Effect.option);
      if (listed._tag === "None") {
        return yield* Effect.logWarning("Could not list an OpenCode session's open requests.");
      }
      const [permissions, forms] = listed.value;
      if (permissions.length === 0 && forms.length === 0) return;
      markUnsettled(state);
      for (const request of permissions) {
        yield* stopStaleRequest(state.sessionId, { type: "permission", id: request.id });
      }
      for (const form of forms) {
        yield* stopStaleRequest(state.sessionId, { type: "form", id: form.id });
      }
    });

    const showRequest = Effect.fnUntraced(function* (
      sessionId: string,
      native: PendingRequest["native"],
      body:
        | {
            readonly type: "approval_request";
            readonly requestKind: Extract<
              OrchestrationV2TurnItem,
              { type: "approval_request" }
            >["requestKind"];
            readonly prompt: string;
            readonly options: Extract<
              OrchestrationV2TurnItem,
              { type: "approval_request" }
            >["options"];
          }
        | {
            readonly type: "user_input_request";
            readonly questions: ReadonlyArray<OrchestrationV2UserInputQuestion>;
          },
    ) {
      const target = requestTurn(sessionId);
      if (target === undefined) return;
      const { state, turn } = target;
      if ([...pending.values()].some((entry) => entry.native.id === native.id)) return;
      const now = yield* DateTime.now;
      const requestId = yield* idAllocator.allocate.runtimeRequest({
        driver,
        providerTurnId: turn.providerTurn.id,
        nativeRequestId: native.id,
      });
      const nodeId = idAllocator.derive.approvalNode({ requestId });
      const request: OrchestrationV2RuntimeRequest = {
        id: requestId,
        nodeId,
        providerTurnId: turn.providerTurn.id,
        nativeRequestRef: ref(native.id),
        kind: body.type === "approval_request" ? body.requestKind : "user_input",
        status: "pending",
        responseCapability: { type: "live", providerSessionId: input.providerSessionId },
        createdAt: now,
        resolvedAt: null,
      };
      const node: OrchestrationV2ExecutionNode = {
        id: nodeId,
        threadId: turn.input.threadId,
        runId: turn.input.runId,
        parentNodeId: turn.input.rootNodeId,
        rootNodeId: turn.input.rootNodeId,
        kind: body.type,
        status: "waiting",
        countsForRun: false,
        providerThreadId: state.providerThread.id,
        providerTurnId: turn.providerTurn.id,
        nativeItemRef: ref(native.id),
        runtimeRequestId: requestId,
        checkpointScopeId: null,
        startedAt: now,
        completedAt: null,
      };
      const base = {
        id: idAllocator.derive.approvalTurnItem({ requestId }),
        threadId: turn.input.threadId,
        runId: turn.input.runId,
        nodeId,
        providerThreadId: state.providerThread.id,
        providerTurnId: turn.providerTurn.id,
        nativeItemRef: ref(native.id),
        parentItemId: null,
        ordinal: ordinalOf(turn, native.id),
        status: "waiting" as const,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
      };
      const item: OrchestrationV2TurnItem =
        body.type === "approval_request"
          ? {
              ...base,
              title: native.type === "permission" ? native.action : null,
              type: "approval_request",
              requestId,
              requestKind: body.requestKind,
              prompt: body.prompt,
              ...(body.options === undefined ? {} : { options: body.options }),
            }
          : {
              ...base,
              title: "User input",
              type: "user_input_request",
              requestId,
              questions: body.questions,
            };
      pending.set(requestId, {
        request,
        item,
        node,
        state,
        turn,
        sessionId,
        answering: false,
        native,
      });
      yield* emit({ type: "node.updated", driver, node });
      yield* emit({
        type: "runtime_request.updated",
        driver,
        threadId: turn.input.threadId,
        runtimeRequest: request,
      });
      yield* emit({ type: "turn_item.updated", driver, turnItem: item });
      yield* setSessionStatus("waiting", null);
    });

    const onPermissionAsked = Effect.fnUntraced(function* (data: Permission.Request) {
      const turn = threads.get(data.sessionID)?.active;
      const toolName =
        data.source === undefined ? undefined : turn?.tools.get(data.source.id)?.name;
      const save = data.save ?? [];
      yield* showRequest(
        data.sessionID,
        { type: "permission", id: data.id, action: data.action, resources: data.resources, save },
        {
          type: "approval_request",
          requestKind: openCodePermissionRequestKind(data.action, toolName),
          prompt: data.resources.length === 0 ? data.action : data.resources.join("\n"),
          options: [
            { decision: "cancel", label: "Cancel" },
            { decision: "decline", label: "Decline" },
            ...(save.length > 0
              ? [
                  {
                    decision: "acceptForSession" as const,
                    label: sessionGrantLabel(data.action, save),
                  },
                ]
              : []),
            { decision: "accept", label: "Approve" },
          ],
        },
      );
    });

    const onFormCreated = Effect.fnUntraced(function* (form: NativeForm) {
      const target = requestTurn(form.sessionID);
      if (target === undefined) return;
      const { state } = target;
      const mapped = formQuestions(form);
      if ("questions" in mapped) {
        return yield* showRequest(
          form.sessionID,
          { type: "form", id: form.id, form },
          { type: "user_input_request", questions: mapped.questions },
        );
      }
      // Cancelling ends OpenCode's execution as a user stop, so the turn is
      // failed here with the reason and that stop's end is skipped.
      yield* Effect.logWarning("Declined an OpenCode form T3 Code cannot show.", {
        reason: mapped.unsupported,
      });
      const cancelled = yield* deliver(
        client.session.form.cancel({ sessionID: form.sessionID, formID: form.id }),
      );
      // The session that asked is the one blocked on the form and stopped by
      // its cancel: a subagent's own, whose parent reads its failed call and
      // goes on. A subagent's session has no Stop end to skip.
      const asker = threads.get(form.sessionID) ?? state;
      if (!cancelled) return yield* abandonRequest(asker, "form cancel failed");
      if (asker.subagent === undefined) markUnsettled(asker);
      yield* finishTurn(asker, {
        status: "failed",
        failure: makeProviderFailure({
          message: `OpenCode asked for ${mapped.unsupported}, which T3 Code can't show. The question was declined.`,
          class: "provider_error",
        }),
      });
    });

    const onAsked = Effect.fnUntraced(function* (
      asked:
        | { readonly type: "permission"; readonly request: Permission.Request }
        | { readonly type: "form"; readonly form: NativeForm },
    ) {
      const asking = asked.type === "permission" ? asked.request.sessionID : asked.form.sessionID;
      if (strays.has(asking)) {
        return yield* stopStaleRequest(
          asking,
          asked.type === "permission"
            ? { type: "permission", id: asked.request.id }
            : { type: "form", id: asked.form.id },
        );
      }
      const state = ownerOf(asking);
      if (state === undefined) return;
      const target = requestTurn(asking);
      if (target !== undefined && !target.turn.awaitingStart) {
        if (asked.type === "permission") return yield* onPermissionAsked(asked.request);
        return yield* onFormCreated(asked.form);
      }
      if (state.unsettled || state.active?.awaitingStart === true) {
        yield* stopStaleRequest(
          asking,
          asked.type === "permission"
            ? { type: "permission", id: asked.request.id }
            : { type: "form", id: asked.form.id },
        );
      }
    });

    const sessionOfEvent = (event: OpenCode2Client.OpenCode2StreamEvent) =>
      event.type === "unreadable.execution.ended" || event.type === "unreadable.execution.started"
        ? event.sessionID
        : "sessionID" in event.data && typeof event.data.sessionID === "string"
          ? event.data.sessionID
          : undefined;

    const executionEnd = (type: string) =>
      type === "session.execution.succeeded" ||
      type === "session.execution.failed" ||
      type === "session.execution.interrupted";

    const startCall = Effect.fnUntraced(function* (
      state: ThreadState,
      turn: ActiveTurn,
      toolId: string,
    ) {
      const nativeId = `${turn.scope}${toolId}`;
      const call: SubagentCall = {
        toolId,
        nativeId,
        state,
        turn,
        ordinal: ordinalOf(turn, nativeId),
        startedAt: yield* DateTime.now,
        prompt: "",
        title: null,
        agent: undefined,
        model: null,
        background: false,
        joined: undefined,
        child: undefined,
        inbox: undefined,
        execution: undefined,
        launched: undefined,
        status: "running",
        result: null,
        completedAt: null,
      };
      turn.usedSubagents = true;
      state.calls.set(toolId, call);
      yield* emitSubagent(call);
      return call;
    });

    const onTurnEvent = Effect.fnUntraced(function* (
      state: ThreadState,
      turn: ActiveTurn,
      event: OpenCode2Client.OpenCode2StreamEvent,
    ) {
      switch (event.type) {
        case "session.text.started":
        case "session.reasoning.started":
        case "session.text.delta":
        case "session.reasoning.delta":
        case "session.text.ended":
        case "session.reasoning.ended": {
          const data = event.data;
          const kind = event.type.startsWith("session.text.") ? "text" : "reasoning";
          return yield* emitText(state, turn, data, kind, (text) =>
            "delta" in data ? text + data.delta : "text" in data ? data.text : text,
          );
        }
        case "session.tool.input.started":
          if (event.data.name === "question") return;
          if (event.data.name === "subagent") return yield* startCall(state, turn, event.data.id);
          turn.tools.set(event.data.id, { name: event.data.name, input: {} });
          turn.startedAt.set(event.data.id, yield* DateTime.now);
          return yield* emitTool(state, turn, event.data.id, "running");
        case "session.tool.called": {
          const call = state.calls.get(event.data.id);
          if (call !== undefined) {
            const { input } = event.data;
            call.prompt = stringField(input, "prompt") ?? call.prompt;
            call.title = stringField(input, "description") ?? call.title;
            call.agent = stringField(input, "agent");
            call.model = stringField(input, "model") ?? call.model;
            call.background = input["background"] === true;
            call.launched = event.created;
            return yield* emitSubagent(call);
          }
          const tool = turn.tools.get(event.data.id);
          if (tool !== undefined) tool.input = event.data.input;
          return yield* emitTool(state, turn, event.data.id, "running");
        }
        case "session.tool.progress": {
          const call = state.calls.get(event.data.id);
          const childId = stringField(event.data.metadata, "sessionID");
          if (call !== undefined && childId !== undefined) yield* attachChild(call, childId);
          return;
        }
        case "session.tool.success": {
          const call = state.calls.get(event.data.id);
          if (call !== undefined) {
            const childId = stringField(event.data.metadata, "sessionID");
            if (childId !== undefined) yield* attachChild(call, childId);
            // A background call returns at launch, and so does one that joined a
            // background run; the report settles it.
            if (event.data.metadata?.["status"] === "running") {
              if (call.background) return;
              call.background = true;
              return yield* emitSubagent(call);
            }
            const output = subagentOutput(textOf(event.data.content));
            yield* settleCall(call, "completed", output);
            return yield* settleShared(call, "completed", output);
          }
          const output = textOf(event.data.content);
          yield* emitTool(state, turn, event.data.id, "completed", {
            output,
            metadata: event.data.metadata,
          });
          turn.tools.delete(event.data.id);
          return;
        }
        case "session.tool.failed": {
          const aborted = event.data.error.type === "aborted";
          const call = state.calls.get(event.data.id);
          if (call !== undefined) {
            const status = aborted ? "interrupted" : "failed";
            yield* settleCall(call, status, event.data.error.message);
            return yield* settleShared(call, status, event.data.error.message);
          }
          yield* emitTool(state, turn, event.data.id, aborted ? "interrupted" : "failed", {
            output: event.data.error.message,
            metadata: event.data.metadata,
          });
          turn.tools.delete(event.data.id);
          return;
        }
        case "session.compaction.started":
          turn.compaction = {
            nativeId: `${turn.providerTurn.id}:compaction:${turn.compactions++}`,
            startedAt: yield* DateTime.now,
          };
          return yield* emitCompaction(state, turn, "running");
        case "session.compaction.ended":
          return yield* emitCompaction(state, turn, "completed", event.data.text);
        case "session.compaction.failed":
          return yield* emitCompaction(state, turn, "failed");
        case "session.step.ended":
        case "session.step.failed": {
          if (event.type === "session.step.ended") {
            const messageID = event.data.assistantMessageID;
            turn.finishByMessage.set(messageID, event.data.finish);
            turn.lastFinish = event.data.finish;
            // Snapshot: re-emitting stores the text again while it awaits a finish, and a live iterator would revisit it forever.
            for (const [nativeId, waiting] of [...turn.awaitingFinish]) {
              if (waiting.block.assistantMessageID !== messageID) continue;
              turn.awaitingFinish.delete(nativeId);
              yield* emitText(state, turn, waiting.block, "text", () => waiting.text, true);
            }
          }
          const tokens = event.data.tokens;
          if (tokens === undefined) return;
          turn.steps += 1;
          turn.lastStep = tokens;
          turn.usage.input += tokens.input + tokens.cache.read + tokens.cache.write;
          turn.usage.cached += tokens.cache.read;
          turn.usage.cacheWrite += tokens.cache.write;
          turn.usage.output += tokens.output + tokens.reasoning;
          turn.usage.reasoning += tokens.reasoning;
          return;
        }
        case "session.execution.started":
          turn.heldEnd = undefined;
          return;
        case "session.execution.succeeded":
          return yield* endExecution(state, turn, {
            status: turn.interrupted ? "interrupted" : "completed",
          });
        case "session.execution.interrupted":
          return yield* endExecution(state, turn, { status: "interrupted" });
        case "session.execution.failed":
          return yield* endExecution(state, turn, {
            status: "failed",
            failure: makeProviderFailure({
              message: event.data.error.message,
              code: event.data.error.type,
              class:
                event.data.error.type === "provider.quota" ||
                event.data.error.type === "provider.rate-limit"
                  ? "usage_limit"
                  : "provider_error",
              ...(event.data.error.type === "provider.quota" ||
              event.data.error.type === "provider.rate-limit"
                ? { category: "quota" as const }
                : {}),
            }),
          });
        default:
          return;
      }
    });

    const drainReports = (state: ThreadState) => {
      const delivered = [...state.reports.values()];
      state.reports.clear();
      const stopped =
        delivered.length > 0 &&
        delivered.every((entry) => state.stoppedChildren.has(entry.childId));
      for (const entry of delivered) state.stoppedChildren.delete(entry.childId);
      return { delivered, stopped };
    };

    const interruptStopped = Effect.fnUntraced(function* (state: ThreadState) {
      markUnsettled(state);
      yield* client.session
        .interrupt({ sessionID: Session.ID.make(state.sessionId) })
        .pipe(Effect.timeout(INTERRUPT_TIMEOUT), Effect.ignore({ log: true }));
    });

    const takeReports = Effect.fnUntraced(function* (state: ThreadState) {
      const taken = drainReports(state);
      if (taken.stopped) yield* interruptStopped(state);
      return taken;
    });

    const onWake = Effect.fnUntraced(function* (state: ThreadState) {
      const { delivered, stopped } = drainReports(state);
      if (stopped) return yield* interruptStopped(state);
      // The wake goes on the thread before anything can yield, so the thread
      // never reads as idle between OpenCode starting this turn on its own and
      // the continuation being asked for. Its message id comes after.
      const wake: Wake = {
        messageId: undefined,
        events: [],
        running: true,
        reports: delivered.map((entry) => entry.report),
        detail: delivered.length === 0 ? null : delivered.map((entry) => entry.text).join("\n\n"),
        dropped: false,
        after: delivered.at(-1)?.inboxId,
        first: delivered[0]?.inboxId,
        children: new Set(),
      };
      state.wakes.push(wake);
      const route = state.providerThread.appThreadId;
      if (route !== null) {
        wake.messageId = yield* idAllocator.allocate.message({ threadId: route, ordinal: 0 });
      }
      yield* Effect.logInfo("OpenCode started a turn on its own; asking for a continuation.", {
        providerThreadId: state.providerThread.id,
      });
      yield* offerWake(state, wake);
    });

    /**
     * A prompt sent to a subagent while it still runs is answered by that same
     * execution, and OpenCode reports the execution once, or not at all when
     * a foreground call took it. The end of one call's execution ends the
     * background calls whose prompts that execution took in too.
     */
    const settleShared = Effect.fnUntraced(function* (
      call: SubagentCall,
      status: OrchestrationV2Subagent["status"],
      output?: string,
    ) {
      if (call.child === undefined || call.execution === undefined) return;
      const shared = [...call.state.calls.values()].filter(
        (candidate) =>
          candidate !== call &&
          candidate.background &&
          candidate.child === call.child &&
          candidate.execution === call.execution,
      );
      for (const candidate of shared) yield* settleCall(candidate, status, output);
    });

    /** A background subagent's end, as OpenCode queues it for its parent. */
    const onReport = Effect.fnUntraced(function* (
      state: ThreadState,
      inboxId: string,
      payload: {
        readonly text: string;
        readonly description?: unknown;
        readonly metadata?: Readonly<Record<string, unknown>> | undefined;
      },
    ) {
      const childId = stringField(payload.metadata, "childID");
      if (stringField(payload.metadata, "source") !== "subagent" || childId === undefined) return;
      strays.delete(childId);
      const description = reportDescription(payload);
      // A subagent called again runs in the same session, so several calls can
      // name this child. Only a background call gets a report: the one whose
      // description it carries, else the oldest still running.
      const onChild = [...state.calls.values()].filter(
        (candidate) => candidate.background && candidate.child?.sessionId === childId,
      );
      const call =
        onChild.find((candidate) => description !== undefined && candidate.title === description) ??
        onChild[0];
      // A call that joined this run shares its report, unless a reconnect read
      // back that its prompt went into a later execution.
      const calls = [...state.calls.values()].filter(
        (candidate) =>
          candidate === call ||
          (call !== undefined &&
            candidate.joined === call &&
            (candidate.execution === undefined ||
              call.execution === undefined ||
              candidate.execution === call.execution)),
      );
      const outcome = reportOutcome(stringField(payload.metadata, "state"));
      state.reports.set(inboxId, {
        inboxId,
        childId,
        text: payload.text,
        report: {
          kind: "subagent",
          label: call?.title ?? description,
          childThreadId: call?.child?.subagent?.appThread.id,
          outcome,
        },
      });
      if (call === undefined) return;
      const status = state.stoppedChildren.has(childId)
        ? ("interrupted" as const)
        : outcome === "failed"
          ? ("failed" as const)
          : outcome === "cancelled"
            ? ("cancelled" as const)
            : ("completed" as const);
      const output = subagentOutput(payload.text);
      for (const each of calls) yield* settleCall(each, status, output);
      yield* settleShared(call, status, output);
    });

    const holderOf = (sessionId: string) => {
      const own = threads.get(sessionId);
      if (own !== undefined) return own.wakes.at(-1)?.running === true ? own : undefined;
      const parent = announced.get(sessionId)?.parentID;
      const holder = parent === undefined ? undefined : threads.get(parent);
      return holder !== undefined && runningTurn(holder) === undefined && holder.wakes.length > 0
        ? holder
        : undefined;
    };

    /**
     * Ends the turn with its execution, unless a steer sent into it is still
     * undelivered: OpenCode then starts another execution for it, which the
     * turn owns too. A Stop leaves steers undelivered and starts nothing.
     */
    const endExecution = Effect.fnUntraced(function* (
      state: ThreadState,
      turn: ActiveTurn,
      end: TurnTerminal,
    ) {
      if (end.status === "completed" && turn.steers.size > 0) {
        turn.heldEnd = end;
        return;
      }
      yield* finishTurn(state, end);
    });

    const endIfSettled = (state: ThreadState, turn: ActiveTurn) =>
      turn.heldEnd !== undefined && turn.steers.size === 0
        ? finishTurn(state, turn.heldEnd)
        : Effect.void;

    const handleEvent = Effect.fnUntraced(function* (event: OpenCode2Client.OpenCode2StreamEvent) {
      const sessionId = sessionOfEvent(event);
      const cleared = sessionId === undefined ? undefined : clearing.get(sessionId);
      if (cleared !== undefined) {
        if (event.type === "unreadable.execution.ended" || executionEnd(event.type)) {
          return yield* Deferred.succeed(cleared, undefined);
        }
        if (
          event.type === "session.execution.started" ||
          event.type === "unreadable.execution.started"
        ) {
          return;
        }
      }
      if (sessionId !== undefined) {
        if (
          event.type === "session.execution.started" ||
          event.type === "unreadable.execution.started"
        ) {
          // A session runs one execution at a time, each opening with `started`
          // on this ordered stream. Once the run `unsettled` waits on has
          // started, a later start means that run is over: an end not seen by
          // now was lost with a dropped stream, and the next end is this
          // execution's own.
          const state = threads.get(sessionId);
          if (state?.unsettled === true) {
            if (state.unsettledStarted) state.unsettled = false;
            else state.unsettledStarted = true;
          }
          busy.add(sessionId);
        } else if (event.type === "unreadable.execution.ended" || executionEnd(event.type)) {
          busy.delete(sessionId);
        }
      }
      if (event.type === "session.created" && event.data.parentID !== undefined) {
        const strayCaller = strays.get(event.data.parentID);
        if (strayCaller !== undefined) {
          strays.set(event.data.sessionID, strayCaller);
          return;
        }
        const owner = ownerOf(event.data.parentID);
        if (owner !== undefined) {
          childOwners.set(event.data.sessionID, owner);
          announced.set(event.data.sessionID, event.data);
          holderOf(event.data.parentID)?.wakes.at(-1)?.children.add(event.data.sessionID);
        }
        return;
      }
      const holder = sessionId === undefined ? undefined : holderOf(sessionId);
      const held = holder?.wakes.at(-1);
      if (holder !== undefined && held !== undefined) {
        held.events.push(event);
        if (
          sessionId === holder.sessionId &&
          (event.type === "unreadable.execution.ended" || executionEnd(event.type))
        ) {
          held.running = false;
        }
        return;
      }
      return yield* route(event, sessionId);
    });

    const route = Effect.fnUntraced(function* (
      event: OpenCode2Client.OpenCode2StreamEvent,
      sessionId: string | undefined,
      held = false,
    ) {
      const ended =
        !held && (event.type === "unreadable.execution.ended" || executionEnd(event.type))
          ? threads.get(sessionId ?? "")
          : undefined;
      if (ended?.unsettled === true) {
        ended.unsettled = false;
        return;
      }
      if (
        event.type === "session.execution.started" ||
        event.type === "unreadable.execution.started"
      ) {
        const state = threads.get(sessionId ?? "");
        if (state !== undefined) state.execution = ++state.executions;
      }
      // Marks where a running turn's own execution begins; it never ends one.
      // With no turn running it is a subagent's or a follow-up's start, below.
      if (event.type === "unreadable.execution.started") {
        const turn = runningTurn(threads.get(event.sessionID));
        if (turn !== undefined) {
          turn.awaitingStart = false;
          turn.heldEnd = undefined;
          return;
        }
      }
      if (event.type === "unreadable.execution.ended") {
        const state = threads.get(event.sessionID);
        const turn = runningTurn(state);
        if (state === undefined || turn === undefined || turn.awaitingStart) return;
        return yield* endExecution(
          state,
          turn,
          event.executionType === "session.execution.succeeded"
            ? { status: turn.interrupted ? "interrupted" : "completed" }
            : event.executionType === "session.execution.interrupted"
              ? { status: "interrupted" }
              : {
                  status: "failed",
                  failure: makeProviderFailure({
                    message: "OpenCode ended the turn with an error this version cannot read.",
                    class: "provider_error",
                  }),
                },
        );
      }
      if (event.type === "permission.asked") {
        return yield* onAsked({ type: "permission", request: event.data });
      }
      if (event.type === "form.created")
        return yield* onAsked({ type: "form", form: event.data.form });
      if (
        event.type === "permission.replied" ||
        event.type === "form.replied" ||
        event.type === "form.cancelled"
      ) {
        const nativeId = event.type === "permission.replied" ? event.data.requestID : event.data.id;
        const entry = [...pending.values()].find((candidate) => candidate.native.id === nativeId);
        if (entry === undefined || entry.answering) return;
        const answered =
          event.type === "form.replied" ||
          (event.type === "permission.replied" && event.data.reply !== "reject");
        return yield* settleRequest(entry, answered ? "resolved" : "cancelled");
      }
      // A background shell wakes its session when it ends, so it is pending work like a background subagent.
      if (event.type === "shell.created") {
        const owner = stringField(event.data.info.metadata, "sessionID");
        if (owner !== undefined && event.data.info.status === "running")
          shells.set(event.data.info.id, owner);
        return;
      }
      if (event.type === "shell.exited" || event.type === "shell.deleted") {
        shells.delete(event.data.id);
        return;
      }
      if (event.type === "location.shutdown") {
        const directory = event.location?.directory;
        if (directory === undefined) return;
        for (const state of threads.values()) {
          if (state.mcp?.directory !== directory) continue;
          // Idle eviction also shuts a location down; an idle thread gets its server back from its next prepareTurn.
          if (
            state.active === undefined &&
            !busy.has(state.sessionId) &&
            !runsShell(state.sessionId)
          )
            continue;
          // Forked so the event lock isn't held over HTTP; the session gate keeps it apart from a turn's prepareTurn.
          yield* Effect.forkIn(
            sessionGates.withLock(state.sessionId, readdMcp(state, directory)),
            sessionScope,
          );
        }
        return;
      }
      if (sessionId === undefined) return;
      const state = threads.get(sessionId);
      if (state === undefined) return;
      if (event.type === "session.moved") {
        state.directory = event.data.location.directory;
        // Forked so the event lock isn't held over HTTP; the session gate keeps it apart from a turn's prepareTurn.
        // Scheduled on every move while registered: an in-flight add reconciles against the latest directory.
        if (state.mcp !== undefined) {
          yield* Effect.forkIn(
            sessionGates.withLock(state.sessionId, followMove(state)),
            sessionScope,
          );
        }
        return;
      }
      if (event.type === "session.model.selected" || event.type === "session.step.started") {
        if (event.type === "session.model.selected") state.model = event.data.model;
        const providerThread = withReportedModel(state.providerThread, event.data.model);
        if (providerThread !== state.providerThread) {
          state.providerThread = { ...providerThread, updatedAt: yield* DateTime.now };
          yield* emit({
            type: "provider_thread.updated",
            driver,
            providerThread: state.providerThread,
          });
        }
      }
      if (
        event.type === "session.inbox.enqueued" &&
        state.subagent !== undefined &&
        state.active === undefined
      ) {
        state.subagent.queued ??= event.data.inboxID;
      }
      // A subagent's prompt, matched to the call that sent it.
      const parent = state.subagent?.call.state;
      if (
        event.type === "session.inbox.enqueued" &&
        event.data.item.type === "user" &&
        parent !== undefined
      ) {
        const text = event.data.item.payload.text;
        const matches = [...parent.calls.values()].filter(
          (candidate) =>
            candidate.child === state &&
            candidate.inbox === undefined &&
            isPromptOf(candidate, text),
        );
        // Two calls sending the same prompt cannot be told apart.
        if (matches.length === 1) matches[0]!.inbox = event.data.inboxID;
      }
      if (event.type === "session.inbox.enqueued" && event.data.item.type === "synthetic") {
        return yield* onReport(state, event.data.inboxID, event.data.item.payload);
      }
      if (event.type === "session.inbox.cancelled" || event.type === "session.inbox.delivered") {
        state.reports.delete(event.data.inboxID);
        // The execution that took this call's prompt in answers it. A prompt
        // that starts an execution is delivered after that start. A reconnect
        // may already have read the delivery back from the child's history,
        // which places the stream in that execution, so the prompts it takes
        // in next count into it too, whatever starts the stream repeated.
        if (event.type === "session.inbox.delivered") {
          for (const call of parent?.calls.values() ?? []) {
            if (call.child !== state || call.inbox !== event.data.inboxID) continue;
            if (call.execution === undefined) call.execution = state.execution;
            else state.execution = call.execution;
          }
        }
        const turn = state.active;
        if (turn !== undefined && turn.steers.delete(event.data.inboxID)) {
          turn.settledInbox.add(event.data.inboxID);
          if (event.type === "session.inbox.cancelled") yield* endIfSettled(state, turn);
        }
        return;
      }
      if (
        event.type === "session.inbox.enqueued" &&
        event.data.item.type === "user" &&
        state.subagent !== undefined &&
        state.subagent.prompt === undefined &&
        state.active === undefined
      ) {
        state.subagent.prompt = event.data.item.payload.text;
        return;
      }
      const started =
        event.type === "session.execution.started" || event.type === "unreadable.execution.started";
      if (state.subagent !== undefined && state.active === undefined && started) {
        if ((yield* takeReports(state)).stopped) {
          state.subagent.queued = undefined;
          return;
        }
        return yield* startChildTurn(state);
      }
      const turn = runningTurn(state);
      if (turn === undefined) {
        if (started && state.subagent === undefined) return yield* onWake(state);
        return;
      }
      if (turn.awaitingStart) {
        if (event.type === "session.execution.started") turn.awaitingStart = false;
        return;
      }
      return yield* onTurnEvent(state, turn, event);
    });

    // The stream is the only terminal signal, and it is volatile: events sent
    // while it is down are gone, and a restarted server never ends the
    // execution it lost. So a lost stream reconnects, then reconciles each
    // running turn from the server's own state (see `reconcile`). Only when
    // reconnecting keeps failing are the turns failed and the session broken,
    // so T3 reopens it. Set first, so a turn starting meanwhile is held for
    // the reconnect. `reconnected` completes when a reconnect ends either way;
    // `streamEnded` says no stream comes back (gave up, or the session closed).
    let streamFailure: string | undefined;
    let streamEnded = false;
    let reconnected = yield* Deferred.make<void>();
    const endStream = Effect.fnUntraced(function* (message: string) {
      streamFailure ??= message;
      streamEnded = true;
      yield* Deferred.succeed(reconnected, undefined);
    });
    // A held turn waits on `reconnected`; a closing session ends that wait.
    yield* Effect.addFinalizer(() => endStream("The OpenCode session closed."));
    const failAll = Effect.fnUntraced(function* (message: string) {
      streamFailure = message;
      yield* endStream(message);
      for (const state of threads.values()) {
        const failure = makeProviderFailure({ message, class: "transport_error" });
        yield* finishTurn(state, { status: "failed", failure }, "broken");
      }
      for (const state of threads.values()) {
        for (const call of runningCalls(state)) yield* settleCall(call, "failed");
        for (const wake of state.wakes.splice(0)) wake.dropped = true;
        state.reports.clear();
      }
      yield* setSessionStatus("error", message);
      yield* Queue.end(events);
    });
    /**
     * Emits what a running turn missed while the stream was down, from the
     * session's history since the turn began: text, reasoning and tools, each
     * under the same native id its live events would have used, so nothing
     * already shown is duplicated. A turn begins at its prompt, whose id T3
     * chose (`nativeTurnRef`), or after `before` for a `/name` command or a
     * continuation.
     * Returns how that history says the turn's execution ended: the `idle` item
     * OpenCode appends after each one, or undefined when there is none after
     * the turn's start. A foreground `subagent` call that ended in the gap
     * goes into `finished`, for the background calls whose prompts its run
     * also answered.
     */
    const backfill = Effect.fnUntraced(function* (
      sessionId: string,
      state: ThreadState,
      finished: Array<FinishedCall>,
    ) {
      const turn = state.active;
      if (turn === undefined) return undefined;
      const promptId = promptOf(turn.providerTurn);
      const { before } = turn;
      if (promptId === undefined && before === undefined) return undefined;
      const start = before !== undefined ? before : promptId;
      const read = yield* OpenCode2Client.paginate(
        { sessionID: Session.ID.make(sessionId), order: "desc" as const, limit: 50 },
        client.message.list,
      ).pipe(
        Stream.takeUntil((message) => message.id === start),
        Stream.runCollect,
      );
      // Without its start the history holds only earlier turns (the stream
      // dropped before the prompt landed): none of it is this turn's.
      const found = start === null || read.at(-1)?.id === start;
      if (!found) return undefined;
      const recent = before !== undefined && before !== null ? read.slice(0, -1) : read;
      const idle = recent.find((message) => message.type === "idle");
      for (const message of recent.toReversed()) {
        if (message.type !== "assistant" || state.active !== turn) continue;
        // The listed message carries its step's native finish, as the live step-ended event does. Record
        // it before its texts are emitted, so each text gets the same phase the live path would give it.
        if (typeof message.finish === "string") {
          if (!turn.finishByMessage.has(message.id)) turn.finishByMessage.set(message.id, message.finish);
          // History runs oldest first, so the turn ends on its newest step's finish, as live.
          turn.lastFinish = message.finish;
        }
        const lastTool = message.content.findLastIndex((part) => part.type === "tool");
        const ordinals = { text: 0, reasoning: 0 };
        for (const [index, part] of message.content.entries()) {
          if (part.type === "text" || part.type === "reasoning") {
            const block = { assistantMessageID: message.id, ordinal: ordinals[part.type]++ };
            if (part.type === "text" && index < lastTool) {
              turn.narrationTexts.add(`${message.id}:text:${block.ordinal}`);
            }
            yield* emitText(state, turn, block, part.type, () => part.text, true);
            continue;
          }
          if (part.type !== "tool") continue;
          // A `subagent` call is its item and child thread, as live: a
          // background one launched in the gap must hold its thread's
          // completion. One already settled live (its item exists but its
          // call is gone) is not started again.
          if (part.name === "subagent") {
            const known = state.calls.get(part.id);
            if (known === undefined && turn.ordinals.has(`${turn.scope}${part.id}`)) continue;
            const call = known ?? (yield* startCall(state, turn, part.id));
            const input = part.state.input;
            if (typeof input === "object" && input !== null) {
              const fields = input as Record<string, unknown>;
              call.prompt = stringField(fields, "prompt") ?? call.prompt;
              call.title = stringField(fields, "description") ?? call.title;
              call.agent = stringField(fields, "agent") ?? call.agent;
              call.model = stringField(fields, "model") ?? call.model;
              call.background = fields["background"] === true;
            }
            call.launched ??= DateTime.toEpochMillis(part.time.created);
            const metadata = "metadata" in part.state ? part.state.metadata : undefined;
            const childId = stringField(metadata, "sessionID");
            if (childId !== undefined) yield* attachChild(call, childId);
            if (part.state.status === "completed" && metadata?.["status"] !== "running") {
              const output = subagentOutput(textOf(part.state.content));
              yield* settleCall(call, "completed", output);
              if (!call.background) finished.push({ call, status: "completed", output });
            } else if (part.state.status === "error") {
              // As live: a call stopped with its turn ends interrupted, not failed.
              const status = part.state.error.type === "aborted" ? "interrupted" : "failed";
              yield* settleCall(call, status, part.state.error.message);
              if (!call.background) {
                finished.push({ call, status, output: part.state.error.message });
              }
            } else {
              yield* emitSubagent(call);
            }
            continue;
          }
          if (!turn.tools.has(part.id)) {
            turn.tools.set(part.id, { name: part.name, input: {} });
            turn.startedAt.set(part.id, yield* DateTime.now);
          }
          const tool = turn.tools.get(part.id)!;
          if (typeof part.state.input === "object" && part.state.input !== null) {
            tool.input = part.state.input as Record<string, unknown>;
          }
          if (part.state.status === "completed") {
            yield* emitTool(state, turn, part.id, "completed", {
              output: textOf(part.state.content),
              metadata: part.state.metadata,
            });
            turn.tools.delete(part.id);
          } else if (part.state.status === "error") {
            yield* emitTool(state, turn, part.id, "failed", {
              output: part.state.error.message,
              metadata: part.state.metadata,
            });
            turn.tools.delete(part.id);
          } else {
            yield* emitTool(state, turn, part.id, "running");
          }
        }
      }
      return idle === undefined ? undefined : { outcome: idle.outcome };
    });

    /**
     * Ties the calls sharing a child to the executions that took their prompts
     * in, read back from the child's history, so one report (or a foreground
     * call's end) settles a background call as it would have live, even when
     * its prompt went in while the stream was down or before a backfill
     * started the call. OpenCode appends an `idle` item after each execution,
     * so the prompts between two of them are one execution's, and those after
     * the last one are the running execution's. A prompt counts for a call
     * only once the call was made, or by its inbox id when that is known.
     * Then each foreground call in `finished` settles the background calls its
     * run answered.
     */
    const recoverShared = Effect.fnUntraced(function* (
      state: ThreadState,
      finished: ReadonlyArray<FinishedCall>,
      active: Readonly<Record<string, unknown>>,
    ) {
      const sessions = new Set(sessionsOf(state));
      const ended = finished.filter(({ call }) => sessions.has(call.state));
      const byChild = new Map<ThreadState, Array<SubagentCall>>();
      for (const call of [...runningCalls(state), ...ended.map(({ call }) => call)]) {
        if (call.child === undefined || call.prompt.length === 0) continue;
        if (call.inbox === undefined && call.launched === undefined) continue;
        byChild.set(call.child, [...(byChild.get(call.child) ?? []), call]);
      }
      for (const [child, all] of byChild) {
        // Two calls sending the same prompt cannot be told apart by it, only
        // by the inbox items they are known to have.
        const calls = all.filter(
          (call) =>
            call.inbox !== undefined ||
            all.every(
              (other) =>
                other === call || other.inbox !== undefined || other.prompt !== call.prompt,
            ),
        );
        // Read back even for a single call that has its execution: the stream
        // comes back in the child's latest one, which only its history tells,
        // and a call made from now on may join it.
        if (!calls.some((call) => !ended.some((end) => end.call === call))) continue;
        // A stopped child's background calls end as interrupted, unless a
        // foreground call's run answered them.
        if (!(child.sessionId in active) && !ended.some(({ call }) => call.child === child)) {
          continue;
        }
        // Executions back from the newest, each with the calls whose prompt it took in.
        const runs: Array<Array<{ call: SubagentCall; id: string }>> = [[]];
        const left = new Set(calls);
        const since = () =>
          Math.min(...[...left].map((call) => call.launched ?? Number.NEGATIVE_INFINITY));
        yield* OpenCode2Client.paginate(
          { sessionID: Session.ID.make(child.sessionId), order: "desc" as const, limit: 50 },
          client.message.list,
        ).pipe(
          Stream.takeWhile(
            (message) => left.size > 0 && DateTime.toEpochMillis(message.time.created) >= since(),
          ),
          Stream.runForEach((message) =>
            Effect.sync(() => {
              if (message.type === "idle") runs.push([]);
              if (message.type !== "user") return;
              const id = String(message.id);
              const created = DateTime.toEpochMillis(message.time.created);
              const call =
                [...left].find((candidate) => candidate.inbox === id) ??
                [...left].find(
                  (candidate) =>
                    candidate.inbox === undefined &&
                    candidate.launched! <= created &&
                    isPromptOf(candidate, message.text),
                );
              if (call === undefined) return;
              left.delete(call);
              runs.at(-1)!.push({ call, id });
            }),
          ),
        );
        // Each execution gets a count of its own, oldest first, so the running
        // one has the latest: prompts delivered into it from now on share it,
        // and none that an earlier one took in.
        for (const run of runs.toReversed()) {
          child.execution = ++child.executions;
          for (const { call, id } of run) {
            call.inbox ??= id;
            call.execution = child.execution;
          }
        }
      }
      for (const { call, status, output } of ended) yield* settleShared(call, status, output);
    });

    /**
     * Settles each thread turn that was running when the stream dropped, from
     * the server: a session still running keeps its turn (its next events
     * arrive on the new stream); one that stopped ends the turn with the
     * outcome of the `idle` item after the turn's start. A restarted server
     * writes no such item for the execution it lost, and `session.outcome` is
     * still the previous execution's, so no `idle` means the turn was
     * interrupted. A continuation turn is settled the same way, from the report
     * its execution answers. A turn still holding for an undelivered steer only
     * ends once the session is idle. Permission asks and question forms are
     * read back from every session still running, so a run that asked during
     * the gap can be answered.
     *
     * What the stream carried outside a turn is not read back: a background
     * subagent's report, a follow-up OpenCode started on its own, or one held
     * for its continuation turn. So background work is settled, not resumed: a
     * subagent whose session stopped ends as interrupted, and a thread's held
     * follow-ups and queued reports are dropped, so nothing waits on an event
     * that already went by.
     */
    const reconcile = Effect.gen(function* () {
      // A subagent's turn ends before the turn that waits on it, so the
      // deepest sessions are read back first.
      // A turn whose request the server may not have yet has no history to
      // read back (one held for this reconnect sends once it is done).
      const running = [...threads]
        .filter(
          ([, state]) =>
            state.active !== undefined && !state.active.unsent && !state.active.submitting,
        )
        .toSorted(([left], [right]) => callsAbove(right).length - callsAbove(left).length);
      const withBackground = () =>
        [...threads.values()].filter(
          (state) => state.subagent === undefined && hasBackground(state),
        );
      const marked = [...threads.values()].some((state) => state.unsettled);
      if (
        running.length === 0 &&
        withBackground().length === 0 &&
        busy.size === 0 &&
        !marked &&
        strays.size === 0
      ) {
        return;
      }
      const active = yield* client.session.active();
      const finished: Array<FinishedCall> = [];
      // An execution that ended while the stream was down never said so.
      for (const sessionId of busy) if (!(sessionId in active)) busy.delete(sessionId);
      for (const state of threads.values()) {
        if (state.unsettled && !(state.sessionId in active)) state.unsettledStarted = true;
      }
      for (const childId of strays.keys()) if (!(childId in active)) strays.delete(childId);
      for (const [sessionId, state] of running) {
        const turn = state.active;
        if (turn === undefined) continue;
        const ended = yield* backfill(sessionId, state, finished);
        if (sessionId in active || state.active !== turn) continue;
        yield* finishTurn(
          state,
          ended?.outcome === "succeeded"
            ? { status: turn.interrupted ? "interrupted" : "completed" }
            : ended?.outcome === "failed"
              ? {
                  status: "failed",
                  failure: makeProviderFailure({
                    message:
                      "OpenCode ended the turn with an error while T3 Code was reconnecting.",
                    class: "provider_error",
                  }),
                }
              : { status: "interrupted" },
        );
      }
      // Read after the backfill, which can start background calls made in the gap.
      for (const state of withBackground()) {
        // A run a foreground call shared already answered its background calls.
        yield* recoverShared(state, finished, active);
        // A subagent still running keeps its call; its end arrives on the new
        // stream. One not given its child yet waits only while the turn that
        // has to name it still runs: once that turn ended here, its session's
        // events are dropped.
        for (const call of runningCalls(state)) {
          const alive =
            call.child !== undefined
              ? call.child.sessionId in active
              : call.state.active === call.turn && call.state.sessionId in active;
          if (!alive) yield* settleCall(call, "interrupted", LOST_BACKGROUND);
        }
        for (const session of sessionsOf(state)) {
          discardWakes(session, session.wakes.splice(0));
          session.reports.clear();
        }
      }
      // Stopped off the lock this reconcile holds; one still running waits for a Stop.
      for (const thread of new Set([...strays.values()].map(rootOf))) {
        yield* Effect.forkIn(stopStrays(thread), sessionScope);
      }
      const listed = new Map<string, Set<string>>();
      for (const sessionId of Object.keys(active)) {
        if (ownerOf(sessionId) === undefined) continue;
        const sessionID = Session.ID.make(sessionId);
        const [permissions, forms] = yield* Effect.all([
          client.permission.list({ sessionID }),
          client.session.form.list({ sessionID }),
        ]);
        listed.set(sessionId, new Set([...permissions, ...forms].map((request) => request.id)));
        const shown = new Set([...pending.values()].map((entry) => entry.native.id));
        for (const request of permissions) {
          if (!shown.has(request.id)) yield* onAsked({ type: "permission", request });
        }
        for (const form of forms) {
          if (!shown.has(form.id)) yield* onAsked({ type: "form", form });
        }
      }
      for (const entry of Array.from(pending.values())) {
        if (listed.get(entry.sessionId)?.has(entry.native.id) !== true) {
          yield* settleRequest(entry, "cancelled");
        }
      }
    });

    const reconnect = Effect.gen(function* () {
      // Returned on any failure, including the interrupt a closing session
      // sends a reconnect still in flight, so a spawned server can idle-stop.
      const scope = yield* Scope.make();
      const { next, stream } = yield* Effect.gen(function* () {
        const next = yield* borrow.pipe(Effect.provideService(Scope.Scope, scope));
        // A stalled server can accept the subscription and never answer it.
        return { next, stream: yield* next.events.pipe(Effect.timeout(RESUBSCRIBE_TIMEOUT)) };
      }).pipe(Effect.onError(() => Scope.close(scope, Exit.void)));
      const previous = currentScope;
      connection = next;
      client = next.client;
      currentScope = scope;
      yield* Scope.close(previous, Exit.void);
      // A restarted server forgot T3's MCP servers; the next turn adds them
      // again. Executions may have ended and started unseen, so a prompt
      // delivered from now on is never counted into one from before.
      for (const state of threads.values()) {
        state.mcp = undefined;
        state.execution = ++state.executions;
      }
      // Shell events sent while the stream was down are lost, so a stale entry must not pin a thread forever.
      shells.clear();
      yield* lock.withPermit(reconcile).pipe(Effect.timeout(RECONCILE_TIMEOUT));
      return stream;
    }).pipe(Effect.retry(RECONNECT_SCHEDULE));

    let currentScope = initial.scope;
    yield* Effect.addFinalizer(() => Scope.close(currentScope, Exit.void));
    const follow = (
      stream: Stream.Stream<OpenCode2Client.OpenCode2StreamEvent, unknown>,
    ): Effect.Effect<void> =>
      stream.pipe(
        Stream.runForEach((event) => lock.withPermit(handleEvent(event))),
        Effect.exit,
        Effect.flatMap(() =>
          Effect.gen(function* () {
            streamFailure = "The OpenCode event stream was lost. Reconnecting.";
            yield* Effect.logWarning("Lost the OpenCode event stream; reconnecting.");
            // The last failure is kept for the log: it can carry the server's
            // URL or response text, so only its tag is annotated and the full
            // failure stays in the log's cause.
            const next = yield* reconnect.pipe(
              Effect.tapCause((cause) =>
                Effect.logWarning(
                  "Could not reconnect to the OpenCode event stream; failing the session.",
                  cause,
                ).pipe(Effect.annotateLogs({ errorTag: causeErrorTag(cause) })),
              ),
              // A defect fails the session too, so no held turn waits on it.
              Effect.exit,
            );
            if (Exit.isFailure(next)) {
              return yield* failAll("The OpenCode event stream was lost and could not reconnect.");
            }
            streamFailure = undefined;
            const done = reconnected;
            reconnected = yield* Deferred.make<void>();
            yield* Deferred.succeed(done, undefined);
            return yield* follow(next.value);
          }),
        ),
      );
    // Subscribed before any session or prompt call, so no event of theirs is missed.
    yield* follow(yield* connection.events).pipe(Effect.forkScoped);

    // A server T3 did not start keeps running after T3 stops, so stop the turns
    // it would otherwise finish unseen. A spawned server stops with its owner.
    if (connection.external) {
      yield* Effect.addFinalizer(() =>
        Effect.forEach(
          [...threads].filter(([, state]) => state.active !== undefined),
          ([sessionId]) =>
            client.session
              .interrupt({ sessionID: Session.ID.make(sessionId) })
              .pipe(Effect.timeout("1 second"), Effect.ignore({ log: true })),
          { concurrency: 8, discard: true },
        ),
      );
    }

    const readModels = (directory: string) =>
      Effect.suspend(() => {
        const windows = contextWindows.get(directory) ?? new Map<string, number>();
        contextWindows.set(directory, windows);
        return client.model.list({ location: { directory } }).pipe(
          Effect.timeout("5 seconds"),
          Effect.tap((models) =>
            Effect.sync(() => {
              for (const model of models.data) {
                windows.set(
                  `${model.providerID}/${model.id}`,
                  model.limit.input ?? model.limit.context,
                );
              }
            }),
          ),
          Effect.ignore({ log: true }),
        );
      });
    const readModelsOnce = (cwd: string | null | undefined) =>
      contextWindows.has(directoryOf(cwd)) ? Effect.void : readModels(directoryOf(cwd));
    yield* readModels(session.cwd);

    const agentRules = new Map<string, ReadonlyMap<string, ReadonlyArray<Rule>>>();
    const pathsFor = Effect.fnUntraced(function* (
      directory: string,
      agents: ReadonlyArray<string>,
    ) {
      let known = agentRules.get(directory);
      if (known === undefined) {
        // A fresh server lists no agents for its first moments, like its models.
        const listed = yield* client.agent.list({ location: { directory } }).pipe(
          Effect.repeat({
            until: (list) => list.data.length > 0,
            schedule: Schedule.spaced("250 millis"),
          }),
          Effect.timeout("5 seconds"),
          Effect.tapCause((cause) =>
            Effect.logWarning(
              "Could not list OpenCode agents; their path rules are skipped.",
              cause,
            ).pipe(Effect.annotateLogs({ errorTag: causeErrorTag(cause) })),
          ),
          Effect.option,
        );
        if (listed._tag === "None") return [];
        known = new Map(
          listed.value.data.map((agent) => [agent.id, agentPaths(agent.permissions)]),
        );
        agentRules.set(directory, known);
      }
      const paths = new Map<string, Rule>();
      for (const agent of agents) {
        for (const entry of known.get(agent) ?? []) {
          paths.set(`${entry.action}\u0000${entry.resource}`, entry);
        }
      }
      return [...paths.values()];
    });

    const rulesFor = Effect.fnUntraced(function* (
      thread: Pick<ThreadState, "directory" | "agent" | "grants">,
      policy: RulesPolicy,
      appThreadId: string | null,
    ) {
      const plan = policy.interactionMode === "plan";
      const paths =
        policy.runtimeMode === "full-access" && !plan
          ? []
          : yield* pathsFor(thread.directory, plan ? [thread.agent, "plan"] : [thread.agent]);
      return sessionRules(
        policy,
        paths,
        policy.runtimeMode === "full-access" ? [] : thread.grants,
        appThreadId === null ? null : yield* mcpServerNameFor(appThreadId),
      );
    });

    const writeRules = Effect.fnUntraced(function* (state: ThreadState, policy: RulesPolicy) {
      const rules = yield* rulesFor(state, policy, rootOf(state).providerThread.appThreadId);
      if (!sameRules(state.rules, rules)) {
        yield* client.session.update({
          sessionID: Session.ID.make(state.sessionId),
          permissions: rules,
        });
        state.rules = rules;
      }
      state.policy = policy;
    });

    const writeTitle = Effect.fnUntraced(function* (state: ThreadState, title: string) {
      const next = title.trim();
      // An empty title asks OpenCode to generate one.
      if (next === "" || next === state.title) return;
      yield* client.session.update({ sessionID: Session.ID.make(state.sessionId), title: next });
      state.title = next;
    });

    const register = (
      providerThread: OrchestrationV2ProviderThread,
      native: {
        readonly id: string;
        readonly model?: ModelRef | undefined;
        readonly agent?: string | undefined;
        readonly title?: string | undefined;
        readonly permissions?: ReadonlyArray<Rule> | undefined;
      },
      directory: string,
    ) => {
      providerThread = withReportedModel(providerThread, native.model);
      const existing = threads.get(native.id);
      if (existing !== undefined) {
        existing.providerThread = providerThread;
        existing.model = native.model;
        existing.directory = directory;
        existing.agent = native.agent ?? existing.agent;
        existing.title = native.title;
        existing.rules = native.permissions;
        return existing;
      }
      const state = newThreadState(native.id, providerThread, directory, undefined);
      state.model = native.model;
      state.agent = native.agent ?? state.agent;
      state.title = native.title;
      state.rules = native.permissions;
      threads.set(native.id, state);
      return state;
    };

    /**
     * A rollback also waits for background subagents, whose reports wake the
     * session into the history it would cut.
     */
    const ensureQuiet = Effect.fnUntraced(function* (
      sessionId: string,
      verb: "roll back" | "fork",
    ) {
      const state = threads.get(sessionId);
      const busyHere =
        state !== undefined &&
        (state.active !== undefined ||
          busy.has(sessionId) ||
          (verb === "roll back" && hasBackground(state)));
      const busyThere =
        !busyHere &&
        (state === undefined || state.unsettled) &&
        sessionId in (yield* client.session.active().pipe(Effect.timeout(ACTIVE_CHECK_TIMEOUT)));
      if (busyHere || busyThere) {
        return yield* new ProviderAdapter.ProviderAdapterProtocolError({
          driver: OPENCODE_PROVIDER,
          detail: `Cannot ${verb} OpenCode session ${sessionId} while it is still working`,
        });
      }
    });

    const cancelStrandedSteers = Effect.fnUntraced(function* (state: ThreadState) {
      const sessionID = Session.ID.make(state.sessionId);
      for (const inboxID of Array.from(state.strandedSteers)) {
        const cancelled = yield* client.session.inbox
          .cancel({ sessionID, inboxID: SessionMessage.ID.make(inboxID) })
          .pipe(
            Effect.timeout(REQUEST_REPLY_TIMEOUT),
            Effect.tapCause((cause) =>
              Effect.logWarning("Could not take back an OpenCode steer.", cause),
            ),
            Effect.exit,
            Effect.map(Exit.isSuccess),
          );
        if (cancelled) state.strandedSteers.delete(inboxID);
      }
    });

    /**
     * Clears a staged revert and waits out the empty execution `clear` runs,
     * which is no turn of T3's. 2.0.18 wakes the session after every clear,
     * with or without a stage (seen live), so that execution always comes.
     */
    const clearRevert = Effect.fnUntraced(function* (sessionId: string) {
      const settled = yield* Deferred.make<void>();
      clearing.set(sessionId, settled);
      yield* client.session.revert
        .clear({ sessionID: Session.ID.make(sessionId) })
        .pipe(
          Effect.andThen(Deferred.await(settled)),
          Effect.timeout(REQUEST_REPLY_TIMEOUT),
          Effect.ensuring(Effect.sync(() => clearing.delete(sessionId))),
        );
      stagedReverts.delete(sessionId);
    });

    /**
     * If either fails or is interrupted the stage is cleared, since OpenCode commits a staged
     * revert on the next prompt; a clear that fails too is tried again before that prompt. Files
     * stay where they are: T3 restores its own checkpoint when the user asked for files, and a
     * rewind without files must not touch them.
     */
    const rollBackTo = Effect.fnUntraced(function* (
      sessionId: string,
      boundary: SessionMessage.ID,
    ) {
      const sessionID = Session.ID.make(sessionId);
      // Each step is bounded: a server that never answers would otherwise
      // hold the session's gate, and the next turn with it.
      yield* client.session.revert.stage({ sessionID, messageID: boundary, files: false }).pipe(
        Effect.timeout(REQUEST_REPLY_TIMEOUT),
        Effect.andThen(
          client.session.revert.commit({ sessionID }).pipe(Effect.timeout(REQUEST_REPLY_TIMEOUT)),
        ),
        Effect.onError(() =>
          clearRevert(sessionId).pipe(
            Effect.tapError(() => Effect.sync(() => stagedReverts.add(sessionId))),
            Effect.ignore({ log: true }),
          ),
        ),
      );
    });

    /**
     * The list takes one type, so it reads all.
     */
    const userMessages = (sessionId: string) =>
      OpenCode2Client.paginate(
        { sessionID: Session.ID.make(sessionId), limit: 100 },
        client.message.list,
      ).pipe(
        Stream.runCollect,
        Effect.map(
          (messages) =>
            new Set(
              messages.flatMap((message) =>
                message.type === "user" || message.type === "synthetic" ? [String(message.id)] : [],
              ),
            ),
        ),
      );

    const snapshotOf = Effect.fnUntraced(function* (
      providerThread: OrchestrationV2ProviderThread,
      sessionId: string,
    ) {
      const history = yield* OpenCode2Client.paginate(
        { sessionID: Session.ID.make(sessionId), order: "asc" as const, limit: 100 },
        client.message.list,
      ).pipe(Stream.runCollect);
      const snapshotAt = yield* DateTime.now;
      const messages = history.flatMap((message): Array<OrchestrationV2ConversationMessage> => {
        const text =
          message.type === "user"
            ? message.text
            : message.type === "assistant"
              ? textOf(message.content)
              : "";
        if (text.length === 0 || (message.type !== "user" && message.type !== "assistant")) {
          return [];
        }
        const createdAt = message.time.created;
        return [
          {
            createdBy: message.type === "user" ? "user" : "agent",
            creationSource: "provider",
            id: idAllocator.derive.messageFromProviderItem({
              driver,
              nativeItemId: message.id,
            }),
            threadId: providerThread.appThreadId ?? input.threadId,
            runId: null,
            nodeId: null,
            role: message.type,
            text,
            attachments: [],
            streaming: false,
            createdAt,
            updatedAt: createdAt,
          },
        ];
      });
      const lastUser = history.findLast((message) => message.type === "user")?.id;
      const state = threads.get(sessionId);
      return {
        providerThread: {
          ...providerThread,
          providerSessionId: input.providerSessionId,
          nativeConversationHeadRef: lastUser === undefined ? null : ref(lastUser, "weak"),
          status: "idle" as const,
          updatedAt: snapshotAt,
        },
        providerTurns: state === undefined ? [] : [...state.providerTurns.values()],
        messages,
        runtimeRequests: [],
      };
    });

    const promptText = (turnInput: ProviderAdapter.ProviderAdapterV2TurnInput) =>
      providerMessageTextWithAttachmentPaths({
        text: turnInput.message.text,
        attachments: turnInput.message.attachments,
        resolveAttachmentPath: host.resolveAttachmentPath,
      }).trim();

    const promptFiles = Effect.fnUntraced(function* (attachments: ReadonlyArray<ChatAttachment>) {
      const files: Array<{ uri: string; name: string }> = [];
      // An external server may not share T3's attachment directory.
      if (connection.external) return files;
      for (const attachment of attachments) {
        if (!isProviderNativeImageAttachment(attachment)) continue;
        const path = host.resolveAttachmentPath(attachment);
        if (path === null) continue;
        // OpenCode rejects the whole prompt if an attached file is missing.
        const exists = yield* fileSystem.exists(path).pipe(Effect.orElseSucceed(() => false));
        if (exists) files.push({ uri: NodeURL.pathToFileURL(path).href, name: attachment.name });
      }
      return files;
    });

    const removeMcp = (mcp: { readonly name: string; readonly directory: string }) =>
      Effect.suspend(() =>
        client.mcp.remove({ server: mcp.name, location: { directory: mcp.directory } }),
      ).pipe(Effect.timeout("5 seconds"), Effect.ignore({ log: true }));

    const addMcp = (mcp: {
      readonly name: string;
      readonly directory: string;
      readonly credential: string;
      readonly url: string;
    }) =>
      Effect.suspend(() =>
        client.mcp.add({
          server: mcp.name,
          location: { directory: mcp.directory },
          config: new Mcp.RemoteConfig({
            type: "remote",
            url: mcp.url,
            headers: { Authorization: mcp.credential },
            oauth: false,
          }),
        }),
      ).pipe(
        Effect.timeout(INVENTORY_TIMEOUT),
        Effect.as(true),
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not add T3 Code's MCP server to OpenCode.", cause).pipe(
            Effect.as(false),
          ),
        ),
      );

    // A reload or eviction dropped the location's runtime MCP servers; a running thread needs its own back now.
    const readdMcp = Effect.fnUntraced(function* (state: ThreadState, directory: string) {
      const registered = state.mcp;
      if (registered === undefined || registered.directory !== directory) return;
      if (!(yield* addMcp(registered))) return;
      // An unload while the add ran already removed the old copy; drop the one just added.
      if (threads.get(state.sessionId) !== state) yield* removeMcp(registered);
    });

    // Runs when the agent moved its session: the server must follow it to the new directory.
    // The session may move again while an add is in flight, so each add is checked
    // against the directory the session is in when it lands, not the one it started for.
    const followMove = Effect.fnUntraced(function* (state: ThreadState) {
      for (;;) {
        const registered = state.mcp;
        if (registered === undefined || registered.directory === state.directory) return;
        const target = state.directory;
        const moved = { ...registered, directory: target };
        // state.mcp stays on the old directory; the next prepareTurn removes it and re-adds at the new one.
        if (!(yield* addMcp(moved))) return;
        if (threads.get(state.sessionId) !== state || state.directory !== target) {
          yield* removeMcp(moved);
          if (threads.get(state.sessionId) !== state) return;
          continue;
        }
        state.mcp = moved;
        yield* removeMcp(registered);
        return;
      }
    });

    yield* Effect.addFinalizer(() =>
      Effect.forEach(
        [...threads.values()].flatMap((state) => (state.mcp === undefined ? [] : [state.mcp])),
        removeMcp,
        { concurrency: 8, discard: true },
      ),
    );

    const prepareTurn = Effect.fnUntraced(function* (
      sessionId: string,
      state: ThreadState,
      turnInput: ProviderAdapter.ProviderAdapterV2TurnInput,
    ) {
      const mcpSession = yield* mcpSessions.read(turnInput.threadId);
      // state.directory follows session.moved, so the server goes where the agent moved the session.
      const directory = state.directory;
      const name = yield* mcpServerNameFor(turnInput.threadId);
      // An external server may not reach T3's MCP endpoint, as with 1.x. A
      // loopback one shares this host, so it can.
      const wanted =
        mcpSession === undefined || (connection.external && !isLoopbackUrl(connection.url))
          ? undefined
          : {
              name,
              directory,
              credential: mcpSession.authorizationHeader,
              url: mcpSession.endpoint,
            };
      if (
        state.mcp !== undefined &&
        (wanted === undefined ||
          state.mcp.directory !== wanted.directory ||
          state.mcp.credential !== wanted.credential ||
          state.mcp.url !== wanted.url)
      ) {
        yield* removeMcp(state.mcp);
        state.mcp = undefined;
      }
      // Idle Location eviction drops runtime MCP servers without clearing T3's cache.
      // Re-adding an unchanged config keeps its existing connection.
      let mcpAvailable = false;
      if (wanted !== undefined) {
        mcpAvailable = yield* addMcp(wanted);
        if (mcpAvailable) state.mcp = wanted;
      }
      const instructions = [
        buildRuntimeInstructions({ harness: "OpenCode", model: turnInput.modelSelection.model }),
        t3OrchestrationSystemPrompt(mcpAvailable, {
          browser: mcpSession?.browserToolsAvailable ?? false,
          device: mcpSession?.capabilities?.has("device") ?? false,
        }),
      ]
        .filter((part) => part !== undefined && part.length > 0)
        .join("\n\n");
      if (instructions !== state.instructions) {
        yield* client.session.instructions.entry.put({
          sessionID: Session.ID.make(sessionId),
          key: INSTRUCTIONS_KEY,
          value: instructions,
        });
        state.instructions = instructions;
      }
    });

    const markBefore = (sessionId: string, before: string | null) =>
      Effect.sync(() => {
        const turn = threads.get(sessionId)?.active;
        if (turn !== undefined) turn.before = before;
      });

    const beginTurn = Effect.fn("OpenCode2Adapter.beginTurn")(function* (
      state: ThreadState,
      turnInput: ProviderAdapter.ProviderAdapterV2TurnInput,
      awaitingStart: boolean,
    ) {
      const startedAt = yield* DateTime.now;
      const nativeTurnId = `${state.sessionId}:attempt:${turnInput.attemptId}`;
      const providerTurn: OrchestrationV2ProviderTurn = {
        id: idAllocator.derive.providerTurn({ driver, nativeTurnId }),
        providerThreadId: turnInput.providerThread.id,
        nodeId: turnInput.rootNodeId,
        runAttemptId: turnInput.attemptId,
        nativeTurnRef: ref(
          isContinuation(turnInput)
            ? wakeTurnId(state.sessionId, turnInput.attemptId)
            : turnPromptId(state.sessionId, turnInput.attemptId),
          "weak",
        ),
        ordinal: turnInput.providerTurnOrdinal,
        status: "running",
        startedAt,
        completedAt: null,
      };
      const turn = makeTurn(turnInput, providerTurn, { scope: "", awaitingStart });
      // No stream is left to end this turn, so it must not start. One that
      // starts while the stream reconnects is read back once it is back.
      if (streamEnded) {
        return yield* new ProviderAdapter.ProviderAdapterEventStreamError({
          driver,
          providerSessionId: input.providerSessionId,
          cause: streamFailure,
        });
      }
      state.active = turn;
      yield* emitProviderTurn(state, turn, providerTurn);
      state.providerThread = {
        ...state.providerThread,
        status: "active",
        firstRunOrdinal: state.providerThread.firstRunOrdinal ?? turnInput.runOrdinal,
        lastRunOrdinal: turnInput.runOrdinal,
        updatedAt: startedAt,
      };
      yield* emit({
        type: "provider_thread.updated",
        driver,
        providerThread: state.providerThread,
      });
      yield* setSessionStatus("running", null);
      return turn;
    });

    const replay = Effect.fnUntraced(function* (wake: Wake) {
      wake.dropped = true;
      for (const event of wake.events) yield* route(event, sessionOfEvent(event), true);
    });

    const discardWakes = (caller: ThreadState, wakes: ReadonlyArray<Wake>) => {
      const retired = new Set<string>();
      const retire = (childId: string) => {
        const info = announced.get(childId);
        if (info === undefined) return;
        announced.delete(childId);
        childOwners.delete(childId);
        strays.set(childId, caller);
        retired.add(childId);
        threads.get(info.parentID ?? "")?.stoppedChildren.add(childId);
      };
      for (const wake of wakes) {
        wake.dropped = true;
        for (const childId of wake.children) retire(childId);
      }
      for (let grew = retired.size > 0; grew;) {
        grew = false;
        for (const [childId, info] of announced) {
          if (info.parentID === undefined || !retired.has(info.parentID)) continue;
          retire(childId);
          grew = true;
        }
      }
    };

    /**
     * Stops a thread's strays one by one, as a Stop stops background subagents, and never under
     * `lock`: one that does not answer would otherwise hold up every event.
     */
    const stopStrays = (thread: ThreadState) =>
      Effect.forEach(
        [...strays].flatMap(([childId, caller]) => (rootOf(caller) === thread ? [childId] : [])),
        (childId) =>
          client.session.interrupt({ sessionID: Session.ID.make(childId) }).pipe(
            Effect.asVoid,
            Effect.catchTags({ SessionNotFoundError: () => Effect.void }),
            Effect.timeout(INTERRUPT_TIMEOUT),
            Effect.tap(() => Effect.sync(() => strays.delete(childId))),
            Effect.ignore({ log: true }),
          ),
        { discard: true },
      );

    /**
     * A user turn that starts while OpenCode runs an execution on its own: the
     * prompt joins that execution, so the turn takes it, and its continuation
     * turn is no longer needed.
     */
    const takeRunningWake = Effect.fnUntraced(function* (state: ThreadState) {
      const wake = state.wakes.at(-1);
      if (wake?.running !== true) return;
      state.wakes.pop();
      yield* replay(wake);
    });

    const runWake = Effect.fnUntraced(function* (
      state: ThreadState,
      turnInput: ProviderAdapter.ProviderAdapterV2TurnInput,
      held?: ActiveTurn,
    ) {
      if (held === undefined) yield* beginTurn(state, turnInput, false);
      yield* lock.withPermit(
        Effect.gen(function* () {
          const index = state.wakes.findIndex(
            (held) => held.messageId === turnInput.message.messageId,
          );
          if (index < 0) return yield* finishTurn(state, { status: "completed" });
          // Queued continuations can't be reordered (they carry a notification),
          // so an earlier wake here lost its continuation to a cancel or a failed
          // dispatch. Dropping it keeps that wake from pinning the session.
          discardWakes(state, state.wakes.splice(0, index));
          yield* Effect.forkIn(stopStrays(state), sessionScope);
          const wake = state.wakes.shift()!;
          const turn = state.active;
          if (turn !== undefined && wake.after !== undefined) turn.before = wake.after;
          // Its first report is where its history begins, so fork and rollback cut there.
          if (turn !== undefined && wake.first !== undefined) {
            turn.providerTurn = { ...turn.providerTurn, nativeTurnRef: ref(wake.first, "weak") };
          }
          if (wake.running) state.unsettled = false;
          yield* replay(wake);
        }),
      );
    });

    const stopBackground = Effect.fnUntraced(function* (state: ThreadState) {
      const calls = runningCalls(state).filter((call) => call.background);
      const callers = sessionsOf(state);
      // A subagent whose call ended runs again when OpenCode wakes it to
      // answer a report of its own background subagent.
      const followUps = callers.filter(
        (caller) =>
          caller.subagent !== undefined &&
          busy.has(caller.sessionId) &&
          !isOrchestrationV2WorkActive(caller.subagent.call.status),
      );
      // OpenCode announces a child's session before the call's progress names
      // it, so a call without a child yet is stopped through its caller's
      // announced children.
      const announcedTo = (caller: ThreadState) =>
        [...announced.values()].flatMap((info) =>
          info.parentID === caller.sessionId ? [info.sessionID] : [],
        );
      const childrenOf = (call: SubagentCall) =>
        call.child === undefined ? announcedTo(call.state) : [call.child.sessionId];
      const children = new Map(
        calls.flatMap((call) => childrenOf(call).map((childId) => [childId, call.state] as const)),
      );
      const unreached = new Set<string>();
      for (const [childId, caller] of children) {
        caller.stoppedChildren.add(childId);
        const reached = yield* client.session
          .interrupt({ sessionID: Session.ID.make(childId) })
          .pipe(
            Effect.catchTags({ SessionNotFoundError: () => Effect.void }),
            Effect.timeout(INTERRUPT_TIMEOUT),
            Effect.tapCause((cause) =>
              Effect.logWarning("Could not stop an OpenCode subagent.", cause),
            ),
            Effect.exit,
            Effect.map(Exit.isSuccess),
          );
        if (!reached) unreached.add(childId);
      }
      for (const followUp of followUps) {
        yield* client.session
          .interrupt({ sessionID: Session.ID.make(followUp.sessionId) })
          .pipe(
            Effect.catchTags({ SessionNotFoundError: () => Effect.void }),
            Effect.timeout(INTERRUPT_TIMEOUT),
            Effect.ignore({ log: true }),
          );
      }
      yield* lock.withPermit(
        Effect.gen(function* () {
          for (const call of calls) {
            if (childrenOf(call).some((childId) => unreached.has(childId))) continue;
            yield* settleCall(call, "interrupted");
          }
          for (const caller of callers) {
            for (const report of caller.reports.values()) {
              caller.stoppedChildren.add(report.childId);
            }
          }
          const running = state.wakes.some((wake) => wake.running);
          discardWakes(state, state.wakes.splice(0));
          if (running) {
            markUnsettled(state);
            yield* client.session
              .interrupt({ sessionID: Session.ID.make(state.sessionId) })
              .pipe(Effect.timeout(INTERRUPT_TIMEOUT), Effect.ignore({ log: true }));
          }
        }),
      );
      yield* stopStrays(state);
    });

    const submit = Effect.fnUntraced(function* (
      sessionId: string,
      turnInput: ProviderAdapter.ProviderAdapterV2TurnInput,
      state: ThreadState,
      turn: ActiveTurn,
    ) {
      const sessionID = Session.ID.make(sessionId);
      const sending = () => {
        if (state.active !== turn || turn.interrupted) return false;
        turn.unsent = false;
        return true;
      };
      const text = turnInput.message.text.trim();
      const bare = turnInput.message.attachments.length === 0;
      const id = turnPromptId(sessionId, turnInput.attemptId);
      if (bare && text === "/compact") {
        if (!sending()) return;
        return yield* client.session.compact({ sessionID, id }).pipe(Effect.asVoid);
      }
      const location = { directory: turnInput.runtimePolicy.cwd ?? host.paths.cwd };
      const command = bare ? commandOf(text) : undefined;
      if (command !== undefined) {
        const commands = yield* client.command.list({ location }).pipe(
          Effect.timeout(INVENTORY_TIMEOUT),
          Effect.map((list) => list.data),
          Effect.orElseSucceed(() => []),
        );
        if (commands.some((entry) => entry.name === command.name)) {
          // `session.command` takes no id of T3's and its answer carries none,
          // so the turn remembers where the history stood before it.
          const newest = yield* client.message.list({ sessionID, order: "desc", limit: 1 });
          yield* markBefore(sessionId, newest.data[0]?.id ?? null);
          if (!sending()) return;
          return yield* client.session.command({ sessionID, ...command });
        }
      }
      const skills = SKILL_MENTION.test(text)
        ? skillsNamed(
            text,
            yield* client.skill.list({ location }).pipe(
              Effect.timeout(INVENTORY_TIMEOUT),
              Effect.map((list) => new Set(list.data.map((skill) => skill.id))),
              Effect.orElseSucceed(() => new Set<string>()),
            ),
          )
        : [];
      const files = yield* promptFiles(turnInput.message.attachments);
      if (!sending()) return;
      return yield* client.session
        .prompt({
          sessionID,
          id,
          text: promptText(turnInput),
          ...(files.length === 0 ? {} : { files }),
          ...(skills.length === 0
            ? {}
            : { skills: skills.map((id) => ({ id: Skill.ID.make(id) })) }),
        })
        .pipe(Effect.asVoid);
    });

    /** The thread's session, with no turn running. */
    const idleState = (sessionId: string) =>
      Effect.gen(function* () {
        const state = threads.get(sessionId);
        if (state === undefined) {
          return yield* new ProviderAdapter.ProviderAdapterProtocolError({
            driver: OPENCODE_PROVIDER,
            detail: `OpenCode session ${sessionId} is not registered`,
          });
        }
        if (state.active !== undefined) {
          return yield* new ProviderAdapter.ProviderAdapterProtocolError({
            driver: OPENCODE_PROVIDER,
            detail: `OpenCode session ${sessionId} already has an active turn`,
            reason: "previous_turn_active",
          });
        }
        return state;
      });

    /**
     * Sets up and sends a turn on a live stream. `held` is a turn installed
     * while the stream was reconnecting; it is sent only while still the
     * session's turn, and every path after this ends it with a terminal.
     */
    const startNow = (turnInput: ProviderAdapter.ProviderAdapterV2TurnInput, held?: ActiveTurn) =>
      Effect.gen(function* () {
        // Its checks and setup take the session's gate, so a rollback or
        // fork sees either no turn or this one installed; the prompt after
        // it does not hold the gate.
        const started = yield* exclusive(turnInput.providerThread)(
          Effect.gen(function* () {
            const sessionId = yield* sessionIdOf(turnInput.providerThread);
            const state = held === undefined ? yield* idleState(sessionId) : threads.get(sessionId);
            if (state === undefined || (held !== undefined && state.active !== held)) return;
            // OpenCode already ran this turn on its own; it prompts nothing.
            if (isContinuation(turnInput)) {
              if (held !== undefined) {
                held.unsent = false;
                held.parked = false;
              }
              return yield* runWake(state, turnInput, held);
            }
            // After a timed-out Stop the server says whether that run is gone. A
            // run still going is stopped again and this turn fails so it can be
            // sent again; a run that is gone may still have its end on the
            // stream, which the turn skips.
            const afterUnsettled = state.unsettled;
            let stillStopping = false;
            if (state.unsettled) {
              const active = yield* client.session
                .active()
                .pipe(Effect.timeout(ACTIVE_CHECK_TIMEOUT));
              stillStopping = sessionId in active;
              if (stillStopping) {
                yield* client.session
                  .interrupt({ sessionID: Session.ID.make(sessionId) })
                  .pipe(Effect.timeout(INTERRUPT_TIMEOUT), Effect.ignore({ log: true }));
              } else {
                state.unsettled = false;
              }
            }
            // Installs the turn; every path after it ends the turn with a terminal.
            if (held !== undefined) held.awaitingStart = afterUnsettled;
            const begin =
              held === undefined
                ? beginTurn(state, turnInput, afterUnsettled)
                : Effect.succeed(held);
            if (stillStopping) {
              yield* begin;
              return yield* finishTurn(state, {
                status: "failed",
                failure: makeProviderFailure({
                  message: OPENCODE_2_STILL_STOPPING,
                  class: "provider_error",
                }),
              });
            }
            // A turn T3 will not run still starts and fails, so the refusal is what
            // the user reads.
            const model = modelRef(turnInput.modelSelection);
            if (model === undefined) {
              yield* begin;
              return yield* finishTurn(state, {
                status: "failed",
                failure: makeProviderFailure({
                  message: malformedModel(turnInput.modelSelection.model),
                  class: "validation_error",
                }),
              });
            }
            // Plan mode is OpenCode's `plan` agent, switched before the rules are
            // written so they keep that agent's own path allows. Switching to or
            // from `plan` queues OpenCode's own "Plan mode" reminder for the prompt.
            const agent = agentFor(turnInput);
            if (agent !== state.agent) {
              yield* client.session.switchAgent({
                sessionID: Session.ID.make(sessionId),
                agent: Agent.ID.make(agent),
              });
              state.agent = agent;
            }
            // The thread's mode may have changed since the session was loaded,
            // and its subagents still running hold the rules they started with.
            // Those run on whether or not this turn starts, so theirs are best effort.
            yield* writeRules(state, turnInput.runtimePolicy);
            // A thread renamed since the last turn, or titled after its first prompt.
            yield* writeTitle(state, turnInput.appThread.title).pipe(
              Effect.timeout(REQUEST_REPLY_TIMEOUT),
              Effect.ignore({ log: true }),
            );
            for (const call of runningCalls(state)) {
              if (call.child === undefined) continue;
              yield* writeRules(call.child, turnInput.runtimePolicy).pipe(
                Effect.timeout(REQUEST_REPLY_TIMEOUT),
                Effect.ignore({ log: true }),
              );
            }
            // A selection changed since the last turn applies now; OpenCode keeps
            // the session's model otherwise.
            if (!sameModel(model, state.model)) {
              yield* client.session.switchModel({ sessionID: Session.ID.make(sessionId), model });
              state.model = model;
            }
            // Steers a stopped turn never delivered would reach the model first,
            // and a revert a failed rollback left staged would be committed.
            yield* cancelStrandedSteers(state);
            if (stagedReverts.has(sessionId)) yield* clearRevert(sessionId);
            yield* prepareTurn(sessionId, state, turnInput);
            const turn = yield* begin;
            // A held turn a Stop ended during its setup sends nothing.
            if (state.active !== turn) return;
            turn.unsent = true;
            turn.parked = false;
            // An execution OpenCode is running on its own takes this prompt at
            // its next step, so this turn is that execution from here on.
            yield* lock.withPermit(takeRunningWake(state));
            return { state, sessionId, turn };
          }),
        );
        if (started === undefined) return;
        const { state, sessionId, turn } = started;
        turn.submitting = true;
        yield* submit(sessionId, turnInput, state, turn).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              turn.submitting = false;
            }),
          ),
          // Deleted outside T3: the thread is broken, and forgetting it makes
          // the next turn resume, fail, and recreate it with a handoff.
          Effect.catchTags({
            SessionNotFoundError: () =>
              finishTurn(
                state,
                {
                  status: "failed",
                  failure: makeProviderFailure({
                    message:
                      "The OpenCode session no longer exists. Send the message again to continue in a new session.",
                    class: "provider_error",
                  }),
                },
                "broken",
              ).pipe(Effect.andThen(Effect.sync(() => threads.delete(sessionId)))),
          }),
          Effect.tapError((cause) =>
            state.active === turn
              ? Effect.gen(function* () {
                  // Without a clear rejection the server may have taken the
                  // prompt, so the next turn checks before it prompts again.
                  if (!CLEAR_PROMPT_REJECTIONS.has(cause._tag)) markUnsettled(state);
                  yield* finishTurn(state, {
                    status: "failed",
                    failure: makeProviderFailure({ cause, class: "provider_error" }),
                  });
                })
              : Effect.void,
          ),
        );
      });

    const runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
      sessionUpdateFanout: "interested_threads",
      instanceId,
      driver,
      providerSessionId: input.providerSessionId,
      get providerSession() {
        return session;
      },
      events: Stream.fromQueue(events),
      // A background subagent keeps its session busy after its parent's turn,
      // and a held wake still needs its turn: idle release must wait for both.
      hasPendingBackgroundWork: Effect.sync(() => [...threads.values()].some(owesWork)),
      hasPendingBackgroundWorkForThread: (providerThread) =>
        Effect.sync(() => {
          const nativeId = providerThread.nativeThreadRef?.nativeId;
          const state = nativeId == null ? undefined : threads.get(nativeId);
          return state !== undefined && hasBackground(state);
        }),
      getModelContextWindow: (selection, cwd) =>
        selection.instanceId === instanceId
          ? windowOf(cwd === undefined ? session.cwd : cwd, selection.model)
          : undefined,
      ensureThread: Effect.fn("OpenCode2Adapter.ensureThread")(
        function* (threadInput) {
          if (threadInput.existingProviderThread?.nativeThreadRef != null) {
            return yield* runtime.resumeThread({
              providerThread: threadInput.existingProviderThread,
              threadId: threadInput.threadId,
              modelSelection: threadInput.modelSelection,
              runtimePolicy: threadInput.runtimePolicy,
            });
          }
          yield* readModelsOnce(threadInput.runtimePolicy.cwd);
          const model = modelRef(threadInput.modelSelection);
          if (model === undefined) {
            return yield* new ProviderAdapter.ProviderAdapterProtocolError({
              driver: OPENCODE_PROVIDER,
              detail: malformedModel(threadInput.modelSelection.model),
            });
          }
          const directory = threadInput.runtimePolicy.cwd ?? host.paths.cwd;
          const policy = threadInput.runtimePolicy;
          const permissions = yield* rulesFor(
            { directory, agent: "build", grants: [] },
            policy,
            threadInput.threadId,
          );
          const title = threadInput.title?.trim() || undefined;
          // A session created with a title is never titled by OpenCode's own model.
          const created = yield* client.session.create({
            location: Location.PublicRef.make({ directory: AbsolutePath.make(directory) }),
            model,
            permissions,
            ...(title === undefined ? {} : { title }),
          });
          const createdAt = yield* DateTime.now;
          const providerThread: OrchestrationV2ProviderThread = {
            ...(threadInput.existingProviderThread ?? {
              id: idAllocator.derive.providerThread({ driver, nativeThreadId: created.id }),
              driver,
              providerInstanceId: instanceId,
              appThreadId: threadInput.threadId,
              ownerNodeId: null,
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              forkedFrom: null,
              createdAt,
            }),
            providerSessionId: input.providerSessionId,
            nativeThreadRef: ref(created.id),
            nativeConversationHeadRef: null,
            status: "idle",
            updatedAt: createdAt,
          };
          const state = register(
            providerThread,
            {
              id: created.id,
              model: created.model,
              agent: created.agent,
              title: title ?? created.title,
              permissions,
            },
            directory,
          );
          state.policy = policy;
          return state.providerThread;
        },
        (effect, threadInput) =>
          effect.pipe(
            Effect.mapError((cause) =>
              isProviderAdapterError(cause)
                ? cause
                : new ProviderAdapter.ProviderAdapterEnsureThreadError({
                    driver,
                    threadId: threadInput.threadId,
                    cause,
                  }),
            ),
          ),
      ),
      resumeThread: Effect.fn("OpenCode2Adapter.resumeThread")(
        function* (threadInput) {
          const sessionId = yield* sessionIdOf(threadInput.providerThread);
          if (threadInput.runtimePolicy !== undefined) {
            yield* readModelsOnce(threadInput.runtimePolicy.cwd);
          }
          const native = yield* client.session.get({ sessionID: Session.ID.make(sessionId) });
          const providerThread: OrchestrationV2ProviderThread = {
            ...threadInput.providerThread,
            providerSessionId: input.providerSessionId,
            status: "idle",
            updatedAt: yield* DateTime.now,
          };
          const cwd = threadInput.runtimePolicy?.cwd;
          const loaded = threads.has(sessionId);
          const state = register(providerThread, native, cwd ?? native.location.directory);
          if (!loaded) yield* stopLeftoverRequests(state);
          yield* writeRules(state, threadInput.runtimePolicy ?? state.policy);
          if (cwd != null && native.location.directory !== cwd) {
            yield* client.session.move({
              sessionID: Session.ID.make(sessionId),
              directory: AbsolutePath.make(cwd),
            });
          }
          return state.providerThread;
        },
        (effect, threadInput) =>
          effect.pipe(
            Effect.mapError((cause) =>
              isProviderAdapterError(cause)
                ? cause
                : new ProviderAdapter.ProviderAdapterResumeThreadError({
                    driver,
                    providerSessionId: input.providerSessionId,
                    providerThreadId: threadInput.providerThread.id,
                    cause,
                  }),
            ),
          ),
      ),
      compactThread: (turnInput) =>
        runtime.startTurn({ ...turnInput, message: { ...turnInput.message, text: "/compact" } }),
      startTurn: Effect.fn("OpenCode2Adapter.startTurn")(
        function* (turnInput) {
          if (streamEnded) {
            return yield* new ProviderAdapter.ProviderAdapterEventStreamError({
              driver,
              providerSessionId: input.providerSessionId,
              cause: streamFailure ?? "The OpenCode event stream ended.",
            });
          }
          if (streamFailure === undefined) return yield* startNow(turnInput);
          // A lost stream is reconnecting. The turn is installed now and sent
          // once the stream is back, so a stalled server delays it instead of
          // failing it, and the caller is not held for the reconnect. It ends
          // with the rest if reconnecting gives up, and a Stop ends it here.
          const { state, held } = yield* exclusive(turnInput.providerThread)(
            Effect.gen(function* () {
              const sessionId = yield* sessionIdOf(turnInput.providerThread);
              const state = yield* idleState(sessionId);
              // Reconnecting may have given up while this waited for the gate.
              if (streamEnded) {
                return yield* new ProviderAdapter.ProviderAdapterEventStreamError({
                  driver,
                  providerSessionId: input.providerSessionId,
                  cause: streamFailure ?? "The OpenCode event stream ended.",
                });
              }
              const held = yield* beginTurn(state, turnInput, false);
              held.unsent = true;
              held.parked = true;
              return { state, held };
            }),
          );
          yield* Effect.gen(function* () {
            // The stream can drop again right after it came back.
            while (streamFailure !== undefined && !streamEnded) yield* Deferred.await(reconnected);
            if (streamEnded || state.active !== held || held.interrupted) return;
            yield* startNow(turnInput, held);
          }).pipe(
            Effect.catchCause((cause) =>
              state.active === held && !Cause.hasInterruptsOnly(cause)
                ? finishTurn(state, {
                    status: "failed",
                    failure: makeProviderFailure({
                      cause: Cause.squash(cause),
                      class: "provider_error",
                    }),
                  })
                : Effect.void,
            ),
            Effect.forkIn(sessionScope),
          );
        },
        (effect, turnInput) =>
          effect.pipe(
            Effect.mapError((cause) =>
              isProviderAdapterError(cause)
                ? cause
                : new ProviderAdapter.ProviderAdapterTurnStartError({
                    driver,
                    threadId: turnInput.threadId,
                    providerThreadId: turnInput.providerThread.id,
                    runId: turnInput.runId,
                    cause,
                  }),
            ),
          ),
      ),
      steerTurn: Effect.fn("OpenCode2Adapter.steerTurn")(
        function* (steerInput) {
          const sessionId = yield* sessionIdOf(steerInput.providerThread);
          const state = threads.get(sessionId);
          const turn = state?.active;
          if (
            state === undefined ||
            turn === undefined ||
            turn.providerTurn.id !== steerInput.providerTurnId ||
            turn.interrupted ||
            // A turn held for a reconnect has no execution to steer yet.
            turn.parked
          ) {
            return yield* new ProviderAdapter.ProviderAdapterProtocolError({
              driver: OPENCODE_PROVIDER,
              detail: `OpenCode turn ${steerInput.providerTurnId} is not active`,
            });
          }
          const inboxID = steerPromptId(sessionId, steerInput.message.messageId);
          if (turn.settledInbox.has(inboxID)) return;
          turn.steers.add(inboxID);
          state.strandedSteers.delete(inboxID);
          const files = yield* promptFiles(steerInput.message.attachments);
          if (state.active !== turn || turn.interrupted) {
            yield* lock.withPermit(
              Effect.gen(function* () {
                turn.steers.delete(inboxID);
                // Stop may have stranded this steer, but it never reached OpenCode.
                state.strandedSteers.delete(inboxID);
                if (state.active === turn) {
                  if (turn.interrupted && turn.heldEnd !== undefined) {
                    turn.heldEnd = { status: "interrupted" };
                  }
                  yield* endIfSettled(state, turn);
                }
              }),
            );
            return yield* new ProviderAdapter.ProviderAdapterProtocolError({
              driver: OPENCODE_PROVIDER,
              detail: `OpenCode turn ${steerInput.providerTurnId} is not active`,
            });
          }
          yield* client.session
            .prompt({
              sessionID: Session.ID.make(sessionId),
              id: inboxID,
              text: providerMessageTextWithAttachmentPaths({
                text: steerInput.message.text,
                attachments: steerInput.message.attachments,
                resolveAttachmentPath: host.resolveAttachmentPath,
              }).trim(),
              ...(files.length === 0 ? {} : { files }),
              delivery: "steer",
            })
            .pipe(
              Effect.tapError((cause) =>
                lock.withPermit(
                  Effect.gen(function* () {
                    turn.steers.delete(inboxID);
                    if (!CLEAR_PROMPT_REJECTIONS.has(cause._tag)) state.strandedSteers.add(inboxID);
                    if (state.active === turn) yield* endIfSettled(state, turn);
                  }),
                ),
              ),
            );
        },
        (effect, steerInput) =>
          effect.pipe(
            Effect.mapError((cause) =>
              isProviderAdapterError(cause)
                ? cause
                : new ProviderAdapter.ProviderAdapterSteerRunError({
                    driver,
                    providerThreadId: steerInput.providerThread.id,
                    providerTurnId: steerInput.providerTurnId,
                    cause,
                  }),
            ),
          ),
      ),
      interruptTurn: Effect.fn("OpenCode2Adapter.interruptTurn")(
        function* (interruptInput) {
          const sessionId = yield* sessionIdOf(interruptInput.providerThread);
          const state = threads.get(sessionId);
          if (state === undefined) return;
          const turn = state.active;
          // A delayed Stop must not reach the new turn's background work.
          if (turn !== undefined && turn.providerTurn.id !== interruptInput.providerTurnId) return;
          // User Stop also stops background work on a settled thread. A turn
          // interrupted to restart with new input leaves it running.
          if (interruptInput.requestRuntimeRestart === true) yield* stopBackground(state);
          if (turn === undefined) return;
          // A turn held for a reconnect sent nothing, and the server may not
          // answer yet: it ends here, and never sends its request.
          if (turn.parked) {
            turn.interrupted = true;
            return yield* lock.withPermit(finishTurn(state, { status: "interrupted" }));
          }
          // The session answers with `session.execution.interrupted`, which ends
          // the turn. A server that does not answer in time is stuck, so the turn
          // ends here instead of waiting on it.
          turn.interrupted = true;
          const reply = yield* client.session
            .interrupt({ sessionID: Session.ID.make(sessionId) })
            .pipe(
              Effect.timeoutOption(INTERRUPT_TIMEOUT),
              Effect.tapError(() =>
                Effect.sync(() => {
                  turn.interrupted = false;
                }),
              ),
            );
          if (reply._tag === "None") {
            markUnsettled(state);
            return yield* lock.withPermit(finishTurn(state, { status: "interrupted" }));
          }
          // Between the executions a late steer spans nothing runs yet. The
          // steers are taken back, and a run they already started is skipped.
          if (!reply.value.interrupted && state.active === turn && turn.heldEnd !== undefined) {
            markUnsettled(state);
            yield* lock.withPermit(finishTurn(state, { status: "interrupted" }));
            return yield* cancelStrandedSteers(state);
          }
          if (!reply.value.interrupted && state.active === turn && turn.unsent) {
            return yield* lock.withPermit(finishTurn(state, { status: "interrupted" }));
          }
          if (!reply.value.interrupted && state.active === turn) {
            turn.interrupted = false;
            return yield* new ProviderAdapter.ProviderAdapterProtocolError({
              driver: OPENCODE_PROVIDER,
              detail: `OpenCode session ${sessionId} had nothing running to stop`,
            });
          }
        },
        (effect, interruptInput) =>
          effect.pipe(
            Effect.mapError((cause) =>
              isProviderAdapterError(cause)
                ? cause
                : new ProviderAdapter.ProviderAdapterInterruptError({
                    driver,
                    providerThreadId: interruptInput.providerThread.id,
                    providerTurnId: interruptInput.providerTurnId,
                    cause,
                  }),
            ),
          ),
      ),
      unloadThread: Effect.fn("OpenCode2Adapter.unloadThread")(function* ({ providerThread }) {
        const nativeId = providerThread.nativeThreadRef?.nativeId;
        const state = nativeId == null ? undefined : threads.get(nativeId);
        if (
          nativeId == null ||
          state === undefined ||
          state.active !== undefined ||
          hasBackground(state)
        ) {
          return;
        }
        threads.delete(nativeId);
        for (const [child, owner] of childOwners) {
          if (owner !== state) continue;
          childOwners.delete(child);
          threads.delete(child);
        }
        if (state.mcp !== undefined) yield* removeMcp(state.mcp);
      }),
      respondToRuntimeRequest: Effect.fn("OpenCode2Adapter.respondToRuntimeRequest")(
        function* (requestInput) {
          const entry = pending.get(requestInput.requestId);
          if (entry === undefined || entry.answering) {
            return yield* new ProviderAdapter.ProviderAdapterProtocolError({
              driver,
              detail: `No pending OpenCode request ${requestInput.requestId}`,
            });
          }
          const { decision, answers } = requestInput;
          const { native } = entry;
          if (native.type === "permission" && decision === undefined) {
            return yield* new ProviderAdapter.ProviderAdapterProtocolError({
              driver,
              detail: `OpenCode approval request ${requestInput.requestId} requires a decision`,
            });
          }
          entry.answering = true;
          // OpenCode's own "always" saves a grant for the whole project, so a
          // subagent's own, not its parent's.
          const asker = threads.get(entry.sessionId) ?? entry.state;
          if (
            native.type === "permission" &&
            (decision === "acceptForSession" || decision === "acceptAlways")
          ) {
            const state = asker;
            for (const resource of native.save) {
              if (
                !state.grants.some(
                  (grant) => grant.action === native.action && grant.resource === resource,
                )
              ) {
                state.grants.push({ action: native.action, resource, effect: "allow" });
              }
            }
            yield* writeRules(state, rootOf(state).policy).pipe(Effect.ignore({ log: true }));
          }
          const sessionID = Session.ID.make(entry.sessionId);
          if (native.type === "permission" && decision === "decline") {
            yield* client.session
              .synthetic({
                sessionID,
                text: declinedNote(native.action, native.resources),
                delivery: "steer",
                resume: false,
              })
              .pipe(Effect.timeout(REQUEST_REPLY_TIMEOUT), Effect.ignore({ log: true }));
          }
          const delivered = yield* native.type === "permission"
            ? deliver(
                client.permission
                  .reply({
                    sessionID,
                    requestID: Permission.ID.make(native.id),
                    decision: decision !== undefined && approves(decision) ? "once" : "reject",
                    ...(decision === "decline" ? { message: DECLINED } : {}),
                  })
                  .pipe(Effect.catchTags(permissionGone)),
              )
            : deliver(
                (answers === undefined || decision === "decline" || decision === "cancel"
                  ? client.session.form.cancel({
                      sessionID: entry.sessionId,
                      formID: Form.ID.make(native.id),
                    })
                  : client.session.form.reply({
                      sessionID: entry.sessionId,
                      formID: Form.ID.make(native.id),
                      answer: formAnswer(native.form, answers),
                    })
                ).pipe(Effect.catchTags(formGone)),
              );
          yield* forgetRequest(entry);
          if (!delivered) yield* abandonRequest(asker, "answer not delivered");
        },
        (effect, requestInput) =>
          effect.pipe(
            Effect.mapError((cause) =>
              isProviderAdapterError(cause)
                ? cause
                : new ProviderAdapter.ProviderAdapterRuntimeRequestResponseError({
                    driver,
                    requestId: requestInput.requestId,
                    cause,
                  }),
            ),
          ),
      ),
      readThreadSnapshot: Effect.fn("OpenCode2Adapter.readThreadSnapshot")(
        function* ({ providerThread }) {
          const sessionId = yield* sessionIdOf(providerThread);
          return yield* snapshotOf(providerThread, sessionId);
        },
        (effect, { providerThread }) =>
          effect.pipe(
            Effect.mapError((cause) =>
              isProviderAdapterError(cause)
                ? cause
                : new ProviderAdapter.ProviderAdapterReadThreadSnapshotError({
                    driver,
                    providerThreadId: providerThread.id,
                    cause,
                  }),
            ),
          ),
      ),
      rollbackThread: Effect.fn("OpenCode2Adapter.rollbackThread")(
        function* (rollbackInput) {
          const { providerThread, target } = rollbackInput;
          const sessionId = yield* sessionIdOf(providerThread);
          yield* ensureQuiet(sessionId, "roll back");
          if (!threads.has(sessionId)) {
            yield* runtime.resumeThread({ providerThread });
            yield* ensureQuiet(sessionId, "roll back");
          }
          const boundary = yield* boundaryAfter(
            rollbackInput.providerThreadTurns,
            providerThread.id,
            target.type === "provider_turn" ? target.providerTurn : undefined,
            yield* userMessages(sessionId),
          );
          if (boundary !== null) {
            yield* rollBackTo(sessionId, SessionMessage.ID.make(boundary));
          }
          const keptOrdinal = target.type === "provider_turn" ? target.providerTurn.ordinal : 0;
          const loaded = threads.get(sessionId);
          for (const [id, turn] of loaded?.providerTurns ?? []) {
            if (turn.ordinal > keptOrdinal) loaded?.providerTurns.delete(id);
          }
          const snapshot = yield* snapshotOf(providerThread, sessionId);
          const kept = new Map(
            rollbackInput.providerThreadTurns
              .filter(
                (turn) =>
                  turn.providerThreadId === providerThread.id && turn.ordinal <= keptOrdinal,
              )
              .map((turn) => [turn.id, turn] as const),
          );
          for (const turn of snapshot.providerTurns) kept.set(turn.id, turn);
          return { ...snapshot, providerTurns: [...kept.values()] };
        },
        (effect, rollbackInput) =>
          effect.pipe(
            exclusive(rollbackInput.providerThread),
            Effect.mapError((cause) =>
              isProviderAdapterError(cause)
                ? cause
                : new ProviderAdapter.ProviderAdapterRollbackThreadError({
                    driver,
                    providerThreadId: rollbackInput.providerThread.id,
                    checkpointId: rollbackInput.target.checkpointId,
                    cause,
                  }),
            ),
          ),
      ),
      forkThread: Effect.fn("OpenCode2Adapter.forkThread")(
        function* (forkInput) {
          const source = forkInput.sourceProviderThread;
          const sourceId = yield* sessionIdOf(source);
          // OpenCode forks whatever history the source has, so a fork taken
          // while anything writes to it would copy a run half done.
          yield* ensureQuiet(sourceId, "fork");
          const selected =
            forkInput.providerTurnId === undefined
              ? undefined
              : forkInput.sourceProviderTurns?.find((turn) => turn.id === forkInput.providerTurnId);
          if (forkInput.providerTurnId !== undefined && selected === undefined) {
            return yield* new ProviderAdapter.ProviderAdapterProtocolError({
              driver: OPENCODE_PROVIDER,
              detail: `OpenCode fork boundary turn ${forkInput.providerTurnId} was not found`,
            });
          }
          const before =
            selected === undefined
              ? null
              : yield* boundaryAfter(
                  forkInput.sourceProviderTurns ?? [],
                  source.id,
                  selected,
                  yield* userMessages(sourceId),
                );
          // A fork copies the source's history, model, location and rules; its
          const forked = yield* client.session.fork({
            sessionID: Session.ID.make(sourceId),
            ...(before === null ? {} : { before: SessionMessage.ID.make(before) }),
          });
          const createdAt = yield* DateTime.now;
          const providerThread: OrchestrationV2ProviderThread = {
            id: idAllocator.derive.providerThread({ driver, nativeThreadId: forked.id }),
            driver,
            providerInstanceId: instanceId,
            providerSessionId: input.providerSessionId,
            appThreadId: forkInput.targetThreadId,
            ownerNodeId: forkInput.ownerNodeId ?? null,
            nativeThreadRef: ref(forked.id),
            nativeConversationHeadRef: null,
            status: "idle",
            firstRunOrdinal: null,
            lastRunOrdinal: null,
            handoffIds: [],
            forkedFrom: {
              providerThreadId: source.id,
              ...(forkInput.providerTurnId === undefined
                ? {}
                : { providerTurnId: forkInput.providerTurnId }),
            },
            createdAt,
            updatedAt: createdAt,
          };
          // inherits that worktree too, but its first turn starts without a
          // resume, so a target in another worktree takes the session there now.
          const cwd = forkInput.runtimePolicy?.cwd;
          const state = register(providerThread, forked, cwd ?? forked.location.directory);
          yield* writeRules(state, forkInput.runtimePolicy ?? state.policy);
          if (cwd != null && forked.location.directory !== cwd) {
            yield* client.session.move({
              sessionID: Session.ID.make(forked.id),
              directory: AbsolutePath.make(cwd),
            });
          }
          return state.providerThread;
        },
        (effect, forkInput) =>
          effect.pipe(
            exclusive(forkInput.sourceProviderThread),
            Effect.mapError((cause) =>
              isProviderAdapterError(cause)
                ? cause
                : new ProviderAdapter.ProviderAdapterForkThreadError({
                    driver,
                    providerThreadId: forkInput.sourceProviderThread.id,
                    cause,
                  }),
            ),
          ),
      ),
    };
    return runtime;
  });

  return ProviderAdapter.ProviderAdapterV2.of({
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(OpenCode2ProviderCapabilities),
    planSelectionTransition: () => Effect.succeed(turnScopedSelectionTransition()),
    // The session borrows the instance's server for as long as it is open, so a
    // spawned server is not idle-stopped under a long tool call.
    openSession: Effect.fn("OpenCode2Adapter.borrowAndOpenSession")(
      function* (input) {
        const scope = yield* Scope.make();
        yield* Effect.addFinalizer((exit) => Scope.close(scope, exit));
        const connection = yield* borrow.pipe(Effect.provideService(Scope.Scope, scope));
        return yield* openSession(input, { connection, scope });
      },
      (effect, input) =>
        effect.pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapter.ProviderAdapterOpenSessionError({
                driver,
                providerSessionId: input.providerSessionId,
                cause,
              }),
          ),
        ),
    ),
  });
});
