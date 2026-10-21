/**
 * Pure rules for mission rooms: who may reach a member thread (the send
 * guard), who a message wakes, the per-thread doorbell, broadcast receipts and
 * the per-room noise meter. No I/O here; the store and service feed these.
 */
import type {
  BroadcastReceipt,
  MissionActor,
  MissionId,
  MissionMessage,
  MissionMessageKind,
  MissionProvenance,
  RoomNoise,
  Subscription,
  ThreadId,
} from "@t3tools/contracts";

// ---------------------------------------------------------------------------
// Membership and the send guard

/**
 * How a thread belongs to a mission: the master, a thread the master (or a
 * member) created, a side thread the owner attached, or a service the master
 * runs (registered by its auth session).
 */
export type MemberKind = "master" | "created" | "attached" | "service";

export interface Member {
  readonly missionId: MissionId;
  readonly threadId: ThreadId;
  readonly kind: MemberKind;
}

/** Every transport that can put text into another thread. */
export type SendPath =
  | "control-api"
  | "coord-shim"
  | "thread-send"
  | "thread-send-attachments"
  | "queued-edit"
  | "merge-back"
  | "request-respond"
  | "scheduled-task"
  | "schedule-edit"
  /** A non-owner app/CLI session writing through the generic WS dispatch. */
  | "ws-dispatch"
  /** A launch that reuses an existing thread id. */
  | "thread-launch"
  /** A delegated task started under someone else's thread. */
  | "delegate"
  /** Recording a created child under someone else's run. */
  | "created-record"
  /** Starting or retargeting a pull request watch on someone else's thread. */
  | "pr-watch"
  /** A pull request watch waking its thread with PR activity. */
  | "pr-watch-wake"
  /** Forking a member thread. */
  | "fork";

/** Who created or last authorized a schedule, as recorded by the guard. */
export type ScheduleCreator =
  | { readonly _tag: "owner" }
  | { readonly _tag: "thread"; readonly threadId: ThreadId };

/**
 * Who is sending, taken from the authenticated transport context only.
 * Nothing here comes from the request body.
 */
export type SendSender =
  /** The owner typing in Robob (app session) or a verified iMessage inbound. */
  | { readonly _tag: "owner"; readonly provenance: MissionProvenance }
  /** An agent thread (MCP caller). */
  | { readonly _tag: "thread"; readonly threadId: ThreadId; readonly title: string }
  /** A control-API bearer session. Shared tokens make this anonymous unless registered. */
  | {
      readonly _tag: "session";
      readonly sessionId: string;
      readonly subject: string;
      /** The client's own name from pairing. Display only: never grants anything. */
      readonly label?: string;
      /**
       * The Robob component the credential was issued to, read from its stored
       * origin claim (never the body). Set only for components whose sends are
       * their own: see `sessionPrincipal`.
       */
      readonly component?: string;
    }
  /** An OAuth MCP client outside Robob. */
  | { readonly _tag: "mcp-client"; readonly sessionId: string; readonly label: string }
  /**
   * A scheduled task firing into its bound thread. `creator` is the recorded
   * authority, null when nothing was recorded (legacy or unknown origin).
   */
  | {
      readonly _tag: "schedule";
      readonly scheduledTaskId: string;
      readonly title: string;
      readonly creator: ScheduleCreator | null;
    };

export type GuardReason =
  | "owner"
  | "self"
  | "master"
  | "owner-schedule"
  | "self-schedule"
  | "member"
  | "service"
  | "outsider"
  | "other-mission"
  | "anonymous"
  | "agent-schedule"
  | "unrecorded-schedule"
  /** One of Robob's own components (a watcher, t3ctl, crw): delivered and logged. */
  | "component"
  /** The target's lead answering the target's pending question. */
  | "lead";

export type GuardDecision =
  /** Target is not in any mission: the guard has no say. */
  | { readonly _tag: "not-member" }
  | { readonly _tag: "allow"; readonly missionId: MissionId; readonly reason: GuardReason }
  /** A member's direct send: delivered as a room request addressed to the target instead. */
  | {
      readonly _tag: "route";
      readonly missionId: MissionId;
      readonly author: MissionActor;
      readonly reason: GuardReason;
    }
  /** Anyone else: held as a knock in the owner's inbox. */
  | { readonly _tag: "knock"; readonly missionId: MissionId; readonly reason: GuardReason };

export interface GuardFacts {
  /** The target's membership, or null when the target belongs to no mission. */
  readonly target: Member | null;
  /** The sender thread's or service session's membership, if any. */
  readonly sender: Member | null;
  readonly from: SendSender;
  readonly targetThreadId: ThreadId;
  /**
   * The sender thread is one of the target's leads (see `leadTiersOf`) and
   * this is its answer to the target's pending question.
   */
  readonly leads?: boolean;
}

/**
 * Membership decides who may reach a member thread. Owner typing passes.
 * The master reaches its own members directly, and so does a lead answering
 * the question its lane asked it. Robob's own components reach every member
 * but the master directly. Other members and member services are routed
 * through rooms. Schedules the owner made pass; a thread's schedule passes
 * only into that same thread, and a schedule with no recorded creator is
 * never treated as self. Everything else knocks.
 */
export const decideSend = (facts: GuardFacts): GuardDecision => {
  const { target, sender, from } = facts;
  if (target === null) return { _tag: "not-member" };
  const missionId = target.missionId;
  const allow = (reason: GuardReason): GuardDecision => ({ _tag: "allow", missionId, reason });
  const knock = (reason: GuardReason): GuardDecision => ({ _tag: "knock", missionId, reason });
  const sameMission = sender !== null && sender.missionId === missionId;

  switch (from._tag) {
    case "owner":
      return allow("owner");
    case "schedule":
      // The stored creator decides, never the task's createdBy label: any
      // operate-scope caller can write that label.
      if (from.creator === null) return knock("unrecorded-schedule");
      if (from.creator._tag === "owner") return allow("owner-schedule");
      if (from.creator.threadId === facts.targetThreadId) return allow("self-schedule");
      return knock("agent-schedule");
    case "thread": {
      if (from.threadId === facts.targetThreadId) return allow("self");
      if (!sameMission) return knock(sender === null ? "outsider" : "other-mission");
      if (sender.kind === "master") return allow("master");
      if (facts.leads === true) return allow("lead");
      return {
        _tag: "route",
        missionId,
        author: { _tag: "thread", threadId: from.threadId },
        reason: "member",
      };
    }
    case "session":
      // Nothing but the owner reaches the master unasked.
      if (from.component !== undefined && target.kind !== "master") return allow("component");
      if (sameMission && sender.kind === "service") {
        return {
          _tag: "route",
          missionId,
          author: { _tag: "system", component: `service:${from.subject}` },
          reason: "service",
        };
      }
      return knock(sender === null ? "anonymous" : "other-mission");
    case "mcp-client":
      return knock("outsider");
  }
};

/** Where the sender label in a knock or routed message comes from. */
export const senderLabel = (from: SendSender): string => {
  switch (from._tag) {
    case "owner":
      return "owner";
    case "thread":
      return from.title.length > 0 ? from.title : from.threadId;
    case "session":
      return from.label ?? from.component ?? "an unnamed session";
    case "mcp-client":
      return `MCP client ${from.label}`;
    case "schedule":
      return `schedule ${from.title}`;
  }
};

// ---------------------------------------------------------------------------
// Wake rules

/** Kinds that mean someone should act. Status and evidence are FYI unless addressed. */
const ACTIONABLE: ReadonlySet<MissionMessageKind> = new Set([
  "request",
  "decision",
  "blocker",
  "control",
]);

export const isActionable = (kind: MissionMessageKind): boolean => ACTIONABLE.has(kind);

/** Default wakeOn for a new subscription by mode. */
export const defaultWakeOn = (mode: Subscription["mode"]): MissionMessageKind[] =>
  mode === "wake" ? ["request", "blocker", "control"] : [];

export const actorKey = (actor: MissionActor): string => {
  switch (actor._tag) {
    case "owner":
      return "owner";
    case "role":
      return `role:${actor.roleId}`;
    case "lane":
      return `lane:${actor.laneId}`;
    case "thread":
      return `thread:${actor.threadId}`;
    case "system":
      return `system:${actor.component}`;
    case "person":
      return `person:${actor.name}`;
  }
};

export const sameActor = (left: MissionActor, right: MissionActor): boolean =>
  actorKey(left) === actorKey(right);

const uniqueActors = (actors: ReadonlyArray<MissionActor>): MissionActor[] => {
  const seen = new Set<string>();
  const out: MissionActor[] = [];
  for (const actor of actors) {
    const key = actorKey(actor);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(actor);
  }
  return out;
};

export interface WakeContext {
  readonly subscriptions: ReadonlyArray<Subscription>;
  /** Lead and verifier of the message's work item, for evidence of done. */
  readonly itemWatchers: ReadonlyArray<MissionActor>;
}

/**
 * Who a message wakes (design 5). Status wakes nobody. Blockers, requests,
 * decisions and controls addressed to someone wake them. Evidence wakes the
 * item lead and verifier. With no addressee, subscribers whose `wakeOn`
 * includes the kind wake; a control with no addressee wakes every subscriber
 * that is not muted. The author and the owner (who reads the UI) never wake.
 */
export const wakeTargets = (
  message: Pick<MissionMessage, "kind" | "to" | "author">,
  context: WakeContext,
): MissionActor[] => {
  if (message.kind === "status") return [];
  const targets: MissionActor[] = [];
  if (message.to.length > 0) {
    targets.push(...message.to);
  } else if (message.kind === "control") {
    for (const sub of context.subscriptions) if (sub.mode !== "mute") targets.push(sub.subscriber);
  } else {
    for (const sub of context.subscriptions) {
      if (sub.mode === "wake" && sub.wakeOn.includes(message.kind)) targets.push(sub.subscriber);
    }
  }
  if (message.kind === "evidence") targets.push(...context.itemWatchers);
  return uniqueActors(targets).filter(
    (actor) => actor._tag !== "owner" && !sameActor(actor, message.author),
  );
};

/** Named recipients a control's receipt counts: its addressees, or the non-muted room. */
export const receiptRecipients = (
  message: Pick<MissionMessage, "kind" | "to" | "author">,
  subscriptions: ReadonlyArray<Subscription>,
): MissionActor[] => {
  if (message.kind !== "control") return [];
  const named =
    message.to.length > 0
      ? message.to
      : subscriptions.filter((sub) => sub.mode !== "mute").map((sub) => sub.subscriber);
  return uniqueActors(named).filter(
    (actor) => actor._tag !== "owner" && !sameActor(actor, message.author),
  );
};

/** "Reached 21 of 21": a recipient is reached once its read position covers the message. */
export const receiptFor = (
  seq: number,
  recipients: ReadonlyArray<{ readonly actor: MissionActor; readonly label: string }>,
  readSeqOf: (actor: MissionActor) => number,
): BroadcastReceipt => {
  const pending = recipients.filter((entry) => readSeqOf(entry.actor) < seq);
  return {
    reached: recipients.length - pending.length,
    total: recipients.length,
    pending: pending.map((entry) => entry.label),
    // --- finish-b ---
    pendingActors: pending.map((entry) => entry.actor),
  };
};

// ---------------------------------------------------------------------------
// Doorbell

/** Thread states as the control API reports them. Doorbells ring only idle or waiting threads. */
export type ThreadActivity = "idle" | "running" | "waiting" | "needs-input" | "queued" | "missing";

export const canRing = (activity: ThreadActivity): boolean =>
  activity === "idle" || activity === "waiting";

export interface DoorbellState {
  /** A wake is out and the thread has not settled since. */
  readonly outstanding: boolean;
  /** Newest message seq the last ring (and anything folded into it) covered. */
  readonly rungSeq: number;
}

export interface PendingDelivery {
  readonly seq: number;
  /** Already covered by a ring (rung or folded in). */
  readonly covered: boolean;
}

export type DoorbellAction =
  | { readonly _tag: "none" }
  /** Unread deliveries join the outstanding wake: the woken turn reads them too. */
  | { readonly _tag: "fold"; readonly upToSeq: number }
  | { readonly _tag: "ring"; readonly upToSeq: number; readonly unread: number };

/**
 * One outstanding wake per thread. A new ring needs: no outstanding wake, an
 * idle or waiting thread, and unread deliveries no earlier ring covered.
 * While a wake is still queued on the thread (nothing running), new
 * deliveries fold into it. Read deliveries never ring.
 */
export const doorbellAction = (
  state: DoorbellState,
  activity: ThreadActivity,
  unread: ReadonlyArray<PendingDelivery>,
): DoorbellAction => {
  if (unread.length === 0 || activity === "missing") return { _tag: "none" };
  const newest = Math.max(...unread.map((delivery) => delivery.seq));
  const uncovered = unread.filter((delivery) => !delivery.covered);
  if (state.outstanding) {
    // Queued means only queued messages, our wake among them, not started yet.
    if (activity === "queued" && uncovered.length > 0) return { _tag: "fold", upToSeq: newest };
    return { _tag: "none" };
  }
  if (uncovered.length === 0 || !canRing(activity)) return { _tag: "none" };
  return { _tag: "ring", upToSeq: newest, unread: unread.length };
};

/** Idempotent request id for a ring: the same thread and newest seq never ring twice. */
export const wakeRequestId = (missionId: MissionId, threadId: ThreadId, upToSeq: number): string =>
  `mission-wake:${missionId}:${threadId}:${upToSeq}`;

/** The single line a ring puts in the thread. */
export const wakeLine = (input: {
  readonly unread: number;
  readonly rooms: ReadonlyArray<string>;
  readonly newest: string;
}): string => {
  const rooms = input.rooms.length > 0 ? ` in ${input.rooms.join(", ")}` : "";
  const plural = input.unread === 1 ? "message" : "messages";
  return `[mission] ${input.unread} unread ${plural}${rooms} (newest: ${input.newest}). Read them with mission_inbox, handle, then mission_mark_read.`;
};

// ---------------------------------------------------------------------------
// Noise meter

export const NOISE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Messages per hour and actionable share over the last 24h (or the room's
 * age when younger, at least an hour), and wakes in that window whose
 * recipient settled without posting anything.
 */
export const noiseFor = (input: {
  readonly now: number;
  readonly roomCreatedAt: number;
  readonly kinds: ReadonlyArray<MissionMessageKind>;
  readonly wastedWakes: number;
}): RoomNoise => {
  const windowMs = Math.max(
    60 * 60 * 1000,
    Math.min(NOISE_WINDOW_MS, input.now - input.roomCreatedAt),
  );
  const total = input.kinds.length;
  const actionable = input.kinds.filter(isActionable).length;
  return {
    messagesPerHour: Math.round((total / (windowMs / 3_600_000)) * 100) / 100,
    actionableShare: total === 0 ? 0 : Math.round((actionable / total) * 1000) / 1000,
    wastedWakes: input.wastedWakes,
    // --- finish-b ---
    kinds24h: Object.fromEntries(
      [...new Set(input.kinds)].map((kind) => [
        kind,
        input.kinds.filter((each) => each === kind).length,
      ]),
    ),
  };
};
