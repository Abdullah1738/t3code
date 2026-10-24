// Pure recovery rules: who lost what, what each thread should do next, the
// order they resume in, and the exact notice text. No I/O here.
import type {
  LaneId,
  LaneStatus,
  MissionActor,
  MissionId,
  MissionRecoverySettings,
  MissionRecoveryState,
  MissionStatus,
  RecoveryAction,
  RecoveryCause,
  RecoveryHeldHold,
  RecoveryIncident,
  RecoveryLostChild,
  RecoveryThread,
  RoleId,
  RoleKind,
  SubMissionId,
  ThreadId,
} from "@t3tools/contracts";

export const DEFAULT_SETTINGS = { resumePerMinute: 4, masterLeadSeconds: 60 } as const;
/** Same thread interrupted this often within an hour stops getting resume turns. */
export const MAX_RUN_INTERRUPTS_PER_HOUR = 3;
/**
 * Boots in a row that cut the same turn (no run of the thread completed in
 * between) before recovery stops resuming it: a turn that takes the server
 * down would otherwise be resumed into the next crash.
 */
export const MAX_BOOT_CUTS = 3;
export const NOTICE_PREFIX = "[mission recovery]";

/** One mission member thread as the mission sees it right now. */
export interface MemberInfo {
  readonly missionId: MissionId;
  readonly missionTitle: string;
  readonly missionStatus: MissionStatus;
  readonly threadId: ThreadId;
  readonly roleId: RoleId | null;
  readonly roleKind: RoleKind | null;
  readonly roleName: string | null;
  readonly laneId: LaneId | null;
  readonly laneName: string | null;
  readonly laneStatus: LaneStatus | null;
  readonly laneStatusReason: string | null;
  readonly subMissionId: SubMissionId | null;
  readonly subMissionTitle: string | null;
  /** Sub-mission priority order; lanes outside a sub-mission sort last. */
  readonly subMissionOrder: number;
  readonly subMissionPaused: boolean;
  /** Focus mode is on and this lane is outside the focused sub-mission. */
  readonly focusHeldBy: string | null;
  readonly onCriticalPath: boolean;
  /** Open owner ask this thread waits on, as "ask-1: question". */
  readonly waitingOnAsk: string | null;
  readonly lastActiveAt: string | null;
}

/** The turn item a cut run stopped in. */
export interface CutItem {
  readonly type: string;
  readonly status: string;
  readonly text: string | null;
}

/** A member run that ended without finishing. */
export interface CutRun {
  readonly runId: string;
  readonly threadId: ThreadId;
  readonly ordinal: number;
  readonly status: string;
  readonly completedAt: string | null;
  /** Message of a `run_interrupt_request` on this run, when someone pressed Stop or a watcher interrupted it. */
  readonly interruptMessage: string | null;
  /** A later run on the thread already started (Robob's restart continuation, or anyone). */
  readonly continued: boolean;
  readonly items: ReadonlyArray<CutItem>;
}

export interface ChildFacts {
  readonly id: string;
  readonly threadId: ThreadId;
  readonly runId: string | null;
  readonly origin: string;
  readonly status: string;
  readonly title: string | null;
  readonly prompt: string | null;
  readonly progress: string | null;
  readonly providerThreadId: string | null;
  readonly childThreadId: string | null;
  readonly completedAt: string | null;
}

const OPEN_CHILD = new Set(["pending", "running", "waiting"]);
const MUTATING_ITEMS = new Set(["command_execution", "dynamic_tool"]);
const LOST_CHILD = new Set(["cancelled", "interrupted", "failed"]);

export const truncate = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
};

const firstLine = (text: string | null) => {
  if (text === null) return null;
  const line = text.split("\n").find((part) => part.trim().length > 0);
  return line === undefined ? null : truncate(line, 120);
};

export const sessionFromProviderThread = (value: string | null) =>
  /native-thread:(ses_[A-Za-z0-9]+)/.exec(value ?? "")?.[1] ?? null;

/**
 * A Stop (owner, or anyone interrupting on purpose) leaves an interrupt
 * request on the run; the stall watch marks its own with "stall watch: ...".
 * An interrupted run without one is treated as a Stop too: never resume it.
 */
export const isOwnerStop = (run: CutRun) =>
  run.interruptMessage === null
    ? run.status === "interrupted"
    : !run.interruptMessage.toLowerCase().startsWith("stall watch");

/** Runs recovery cares about: cancelled, failed, or interrupted by the stall watch. */
export const isCut = (run: CutRun) =>
  run.status === "cancelled" || run.status === "failed" || run.status === "interrupted";

export const isOpenChild = (child: ChildFacts) => OPEN_CHILD.has(child.status);

export const describeChild = (child: ChildFacts): RecoveryLostChild => {
  const native = child.origin !== "app_owned";
  return {
    title: truncate(child.title ?? firstLine(child.prompt) ?? "untitled child", 120),
    kind: native ? "native-subagent" : "delegated-task",
    ref: native ? sessionFromProviderThread(child.providerThreadId) : child.id,
    childThreadId: (child.childThreadId as ThreadId | null) ?? null,
    lastStatus: !native && isOpenChild(child) ? "still running in its own thread" : child.status,
    doing: child.progress === null ? firstLine(child.prompt) : truncate(child.progress, 120),
  };
};

/**
 * Children a thread lost: ones that ended cancelled, interrupted or failed
 * inside the window, plus ones still marked open on the cut run (nothing
 * will finish them). Named ids (from stream-recovery) count regardless of
 * the window.
 */
export const pickLost = (
  children: ReadonlyArray<ChildFacts>,
  window: { readonly from: string; readonly to: string },
  cutRunId: string | null,
  named: ReadonlySet<string> = new Set(),
): Array<ChildFacts> =>
  children.filter((child) => {
    if (isOpenChild(child)) return cutRunId !== null && child.runId === cutRunId;
    if (!LOST_CHILD.has(child.status)) return false;
    if (named.has(child.id)) return true;
    if (child.completedAt === null) return false;
    return child.completedAt >= window.from && child.completedAt <= window.to;
  });

/** At a role handoff: the old thread's children still open, or lost since `since`. */
export const handoffChildren = (children: ReadonlyArray<ChildFacts>, since: string) =>
  children.filter(
    (child) =>
      isOpenChild(child) ||
      (LOST_CHILD.has(child.status) && child.completedAt !== null && child.completedAt >= since),
  );

export const lostChildren = (
  children: ReadonlyArray<ChildFacts>,
  window: { readonly from: string; readonly to: string },
  cutRunId: string | null,
  named: ReadonlySet<string> = new Set(),
): Array<RecoveryLostChild> => pickLost(children, window, cutRunId, named).map(describeChild);

const MUTATIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bgit\s+push\b/i, "a git push"],
  [/\bgh\s+pr\s+merge\b|\bgit\s+merge\b|\bmerge_pull_request\b/i, "a merge"],
  [/\bdeploy\b|\bdeploy\.zsh\b|\brelease\b.*\b(publish|cut)\b/i, "a deploy"],
  [/\bterraform\s+(apply|destroy|import)\b|\btofu\s+apply\b/i, "a terraform apply"],
  [
    /\bkubectl\s+(apply|delete|rollout|scale)\b|\bhelm\s+(upgrade|install|uninstall)\b/i,
    "a cluster change",
  ],
  [/\bmigrat(e|ion)\b/i, "a migration"],
  [/\b(alter|drop|truncate)\s+table\b|\binsert\s+into\b/i, "a database write"],
  [
    /\bcommerce\b.*\b(order|checkout|pay|recover-payment)\b|\buber\b.*\b(book|request)\b/i,
    "a payment or order",
  ],
  [/\b(checkout|purchase|payment|transfer|withdraw|refund)\b/i, "a payment-like action"],
  [/\bcoord(ctl)?\b.*\b(claim|release)\b|\bclaim\b.*\b(lane|ticket|pool)\b/i, "a coord claim"],
  [/\bpool[-_ ]?hold\b|\bmission_pool\b/i, "a pool hold"],
];

/** Names the mutation a cut item was inside, or null when it was harmless. */
export const mutationOf = (items: ReadonlyArray<CutItem>): string | null => {
  const inFlight = items.filter((item) => item.status !== "completed");
  const last = items.at(-1);
  const candidates = last === undefined ? inFlight : [...inFlight, last];
  for (const item of candidates) {
    if (item.text === null || !MUTATING_ITEMS.has(item.type)) continue;
    for (const [pattern, label] of MUTATIONS) {
      if (pattern.test(item.text)) return `${label} (\`${truncate(item.text, 100)}\`)`;
    }
  }
  return null;
};

/** "running `offbox wait run-1`" for the item a run stopped in. */
export const activityOf = (items: ReadonlyArray<CutItem>): string | null => {
  const inFlight = items.filter((item) => item.status !== "completed");
  const item = inFlight.at(-1) ?? items.at(-1);
  if (item === undefined) return null;
  const text = item.text === null ? null : truncate(item.text, 120);
  switch (item.type) {
    case "command_execution":
      return text === null ? "running a command" : `running \`${text}\``;
    case "dynamic_tool":
      return text === null ? "calling a tool" : `calling \`${text}\``;
    case "subagent":
      return text === null ? "waiting on a background child" : `waiting on \`${text}\``;
    case "assistant_message":
      return "writing a reply";
    case "reasoning":
      return "thinking";
    case "file_change":
      return "editing files";
    case "web_search":
      return "searching the web";
    case "file_search":
      return "searching files";
    case "user_input_request":
    case "approval_request":
      return "waiting for an answer";
    case "user_message":
      return "starting a new turn";
    default:
      return `in a ${item.type.replaceAll("_", " ")} step`;
  }
};

export interface PlanInput {
  readonly member: MemberInfo;
  readonly cut: CutRun | null;
  readonly lost: ReadonlyArray<RecoveryLostChild>;
  readonly holds: ReadonlyArray<RecoveryHeldHold>;
  readonly recentInterrupts: number;
  readonly cause: RecoveryCause;
}

/** Why a lane stays as it is after recovery, or null when it may resume. */
export const holdReason = (member: MemberInfo): string | null => {
  if (member.missionStatus === "paused") return "mission paused";
  if (member.subMissionPaused) return `sub-mission "${member.subMissionTitle}" paused`;
  if (member.laneStatus === "parked") return "lane parked";
  if (member.focusHeldBy !== null) return `held by focus mode on "${member.focusHeldBy}"`;
  if (member.waitingOnAsk !== null) return `waiting on owner ask ${member.waitingOnAsk}`;
  return null;
};

export const planThread = (
  input: PlanInput,
): {
  readonly action: RecoveryAction;
  readonly reason: string;
  readonly mutation: string | null;
} => {
  const { member, cut, lost, holds } = input;
  const mutation = cut === null ? null : mutationOf(cut.items);
  // An idle thread's live hold is just held; it matters when the run holding
  // it was cut, or when its lease ran out while nobody was watching.
  const openHolds = holds.filter(
    (hold) => hold.reconcileRequired || (cut !== null && hold.status === "active"),
  );
  const reconcile = mutation !== null || openHolds.length > 0;
  const isMaster = member.roleKind === "master";
  if (cut !== null && isOwnerStop(cut)) {
    return { action: "skip", reason: "stopped by the owner", mutation };
  }
  if (member.laneStatus === "retired") return { action: "skip", reason: "lane retired", mutation };
  if (input.cause === "run-interrupted" && input.recentInterrupts >= MAX_RUN_INTERRUPTS_PER_HOUR) {
    return {
      action: "skip",
      reason: `interrupted ${input.recentInterrupts} times in the last hour; left for the master`,
      mutation,
    };
  }
  const held = holdReason(member);
  const lostSomething = cut !== null || lost.length > 0 || reconcile;
  if (held !== null) {
    if (!lostSomething && !isMaster)
      return { action: "skip", reason: `nothing lost; ${held}`, mutation };
    return { action: "notice-only", reason: held, mutation };
  }
  if (!lostSomething) {
    return isMaster
      ? { action: "notice-only", reason: "summary for the master", mutation }
      : { action: "skip", reason: "nothing was running", mutation };
  }
  if (cut !== null && cut.continued && lost.length === 0 && !reconcile && !isMaster) {
    return { action: "skip", reason: "turn already continued, nothing lost", mutation };
  }
  if (reconcile) {
    return {
      action: "reconcile-first",
      reason:
        mutation !== null
          ? `cut inside ${mutation}`
          : `holds ${openHolds.length} pool hold${openHolds.length === 1 ? "" : "s"}`,
      mutation,
    };
  }
  if (cut === null) return { action: "resume", reason: "background children lost", mutation };
  return { action: "resume", reason: "turn cut", mutation };
};

const ROLE_RANK: Partial<Record<RoleKind, number>> = {
  master: 0,
  "sub-coordinator": 1,
  "lane-lead": 2,
  "lane-worker": 3,
  verifier: 4,
  reviewer: 5,
  "final-reviewer": 5,
};

// Threads that restart work go first; notices to threads that stay put, then skips.
const ACTION_RANK: Record<RecoveryAction, number> = {
  resume: 0,
  "reconcile-first": 0,
  "notice-only": 1,
  skip: 2,
};

/**
 * Resume order: master first, then threads that restart work, by sub-mission
 * priority and inside one sub-mission the critical path first. Notice-only
 * threads follow, skipped ones go last.
 */
export const orderThreads = <
  T extends {
    readonly member: MemberInfo;
    readonly action: RecoveryAction;
  },
>(
  threads: ReadonlyArray<T>,
): Array<T> =>
  threads.toSorted((left, right) => {
    const rank = (entry: T) => [
      entry.member.roleKind === "master" ? 0 : 1,
      ACTION_RANK[entry.action],
      entry.member.subMissionOrder,
      entry.member.onCriticalPath ? 0 : 1,
      ROLE_RANK[entry.member.roleKind ?? "custom"] ?? 9,
    ];
    const a = rank(left);
    const b = rank(right);
    for (let index = 0; index < a.length; index += 1) {
      const diff = (a[index] ?? 0) - (b[index] ?? 0);
      if (diff !== 0) return diff;
    }
    const activeDiff = (right.member.lastActiveAt ?? "").localeCompare(
      left.member.lastActiveAt ?? "",
    );
    if (activeDiff !== 0) return activeDiff;
    return left.member.threadId.localeCompare(right.member.threadId);
  });

/** "22:41" in the owner's zone. */
export const clockLabel = (iso: string, timeZone: string) => {
  const date = Date.parse(iso);
  if (Number.isNaN(date)) return iso;
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone,
  }).format(date);
};

/**
 * Closes a note queued behind a running turn. It lands when that turn ends,
 * maybe hours later, and only knows what recovery saw when it looked.
 */
export const queuedNoteStamp = (seenAt: string, queuedAt: string) =>
  `As of ${seenAt}${queuedAt === seenAt ? ", queued" : `, queued at ${queuedAt}`} behind your running turn: work and children started after ${seenAt} aren't covered here, so check the current state before acting on this.`;

const CAUSE_LABEL: Record<RecoveryCause, string> = {
  "server-restart": "restart",
  "opencode-restart": "OpenCode restart",
  "run-interrupted": "interrupted runs",
  succession: "role handoff",
};

export const stateLabel = (cause: RecoveryCause, at: string, timeZone: string) =>
  `Recovered from ${CAUSE_LABEL[cause]} at ${clockLabel(at, timeZone)}`;

/**
 * A thread recovery would resume, stopped because boots kept cutting the same
 * turn and not yet released or decided by the owner or master. A lane is held;
 * the master still gets its summary, told not to rerun its own turn.
 */
export const isBootStopped = (thread: RecoveryThread) =>
  (thread.bootCuts ?? 0) >= MAX_BOOT_CUTS &&
  (thread.action === "resume" || thread.action === "reconcile-first") &&
  (thread.roleKind === "master" || thread.state === "held") &&
  thread.decidedBy === null;

export const bootStopReason = (cuts: number) =>
  `the same turn was cut by ${cuts} boots in a row; not resumed on its own`;

const OPEN_STATES = new Set(["pending", "held", "failed"]);

export const isOpen = (thread: RecoveryThread) => OPEN_STATES.has(thread.state);

/** Overview badge for one mission, or null once every thread resumed or was decided. */
export const missionState = (
  incident: RecoveryIncident,
  missionId: MissionId,
  timeZone: string,
): MissionRecoveryState | null => {
  if (incident.clearedAt !== null) return null;
  const threads = incident.threads.filter((thread) => thread.missionId === missionId);
  const pending = threads.filter(isOpen).length;
  if (threads.length === 0 || pending === 0) return null;
  return {
    incidentId: incident.id,
    cause: incident.cause,
    at: incident.windowEnd,
    label: stateLabel(incident.cause, incident.windowEnd, timeZone),
    total: threads.length,
    pending,
    reconcile: threads.filter(
      (thread) =>
        thread.action === "reconcile-first" || thread.holds.some((hold) => hold.reconcileRequired),
    ).length,
  };
};

// --- notice text ---

const childLine = (child: RecoveryLostChild) => {
  if (child.kind === "native-subagent") {
    return `\`${child.title}\` (native subagent, ${child.ref === null ? "no session id recorded" : `session ${child.ref}`})`;
  }
  const status =
    child.lastStatus === "still running in its own thread" ? ", may still be running" : "";
  return `\`${child.title}\` (delegated task ${child.ref ?? "unknown id"}${status})`;
};

const joinList = (parts: ReadonlyArray<string>) =>
  parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;

const childrenText = (lost: ReadonlyArray<RecoveryLostChild>) => {
  if (lost.length === 0) return "You had no background children.";
  const native = lost.some((child) => child.kind === "native-subagent");
  const delegated = lost.some((child) => child.kind === "delegated-task");
  const count = lost.length === 1 ? "1 background child" : `${lost.length} background children`;
  const how = [
    ...(native
      ? [
          "native subagents by passing the session id back to the subagent tool with a short prompt (keeps their context)",
        ]
      : []),
    ...(delegated
      ? [
          "delegated tasks by checking task_status (leave a running one alone, re-delegate a stopped one with the same brief)",
        ]
      : []),
  ];
  const stopped = !native
    ? ""
    : delegated
      ? " The native subagents were stopped and will not report back."
      : " They were stopped and will not report back.";
  return `You had ${count}: ${joinList(lost.map(childLine))}.${stopped} Resume each one: ${joinList(how)}.`;
};

const holdText = (holds: ReadonlyArray<RecoveryHeldHold>) =>
  holds
    .map(
      (hold) =>
        `pool ${hold.poolId} hold ${hold.holdId} (${hold.purpose || "no purpose"}${hold.reconcileRequired ? ", lease ran out, now reconcile-required" : `, ${hold.status}`})`,
    )
    .join("; ");

export interface NoticeContext {
  readonly cause: RecoveryCause;
  /** HH:MM of the interruption. */
  readonly at: string;
}

const opening = (context: NoticeContext, thread: RecoveryThread) => {
  switch (context.cause) {
    case "server-restart":
      return `Robob restarted at ${context.at}.`;
    case "opencode-restart":
      return `OpenCode restarted at ${context.at}.`;
    case "run-interrupted":
      return `Your run was interrupted at ${context.at}${thread.interruptReason ? ` (${truncate(thread.interruptReason, 160)})` : ""}.`;
    case "succession":
      return `You took over ${thread.laneName === null ? "this role" : `lane "${thread.laneName}"`} at ${context.at}${thread.handoffFrom ? ` from thread "${thread.handoffFrom.title}" (${thread.handoffFrom.threadId})` : ""}.`;
  }
};

const cutText = (context: NoticeContext, thread: RecoveryThread) => {
  if (context.cause === "succession") {
    return thread.lostChildren.length === 0 ? "The old thread had no background children." : "";
  }
  if (thread.cutRunId === null) return "";
  const what = thread.lastActivity === null ? "" : ` while you were ${thread.lastActivity}`;
  const continued = thread.serverContinued
    ? " That turn was already continued; this note covers what it was not told."
    : "";
  return `Your turn was cut${what}.${continued}`;
};

const successionChildren = (lost: ReadonlyArray<RecoveryLostChild>) =>
  lost.length === 0
    ? ""
    : childrenText(lost)
        .replace(/^You had/, "The old thread had")
        .replace("They were stopped and will not report back.", "They will not report back to you.")
        .replace(
          "The native subagents were stopped and will not report back.",
          "The native subagents will not report back to you.",
        )
        .replace("Resume each one:", "Adopt each one if the work still matters:");

/**
 * Who an instruction is from, as recorded by the service: the owner, or the
 * master role. Anything else is not dressed up as either, and a later
 * decision (`decidedBy`) never stands in for the instruction's author.
 */
const instructionLabel = (decidedBy: MissionActor | null): string => {
  switch (decidedBy?._tag) {
    case "owner":
      return "From the owner";
    case "role":
      return "From the master";
    default:
      return "Recovery instruction";
  }
};

/** The message one mission thread gets. */
export const threadNotice = (context: NoticeContext, thread: RecoveryThread) => {
  const waits = thread.action === "notice-only" && thread.roleKind !== "master";
  const children =
    context.cause === "succession"
      ? successionChildren(thread.lostChildren)
      : childrenText(thread.lostChildren);
  const parts = [
    NOTICE_PREFIX,
    opening(context, thread),
    cutText(context, thread),
    waits
      ? children.replace("Resume each one:", "When you are released, resume each one:")
      : children,
  ];
  if (
    thread.action === "reconcile-first" ||
    (thread.action === "notice-only" && thread.holds.length > 0)
  ) {
    const inside = thread.reason.startsWith("cut inside")
      ? thread.reason.replace("cut inside", "You were inside")
      : null;
    const holds = thread.holds.length === 0 ? null : `You hold ${holdText(thread.holds)}.`;
    parts.push(
      [
        "Before anything else, check the exact state of what was in flight.",
        inside === null ? null : `${inside}.`,
        holds,
        "Do not repeat it blindly: read back whether it happened, then finish it or roll forward.",
      ]
        .filter((part) => part !== null)
        .join(" "),
    );
  }
  if (thread.instruction !== null) {
    parts.push(`${instructionLabel(thread.instructionBy ?? null)}: ${thread.instruction}`);
  }
  const stoppedMaster = thread.roleKind === "master" && isBootStopped(thread);
  if (stoppedMaster) {
    parts.push(
      `This turn was cut by ${thread.bootCuts} boots in a row, so recovery does not resume it: do not rerun what it was running until you know that is not what takes the server down.`,
    );
  } else if ((thread.bootCuts ?? 0) >= MAX_BOOT_CUTS && !waits) {
    parts.push(
      `This turn was cut by ${thread.bootCuts} boots in a row. Before you run it again, check that what it was running is not what takes the server down.`,
    );
  }
  if (stoppedMaster) {
    parts.push("Then carry on with the rest of the mission.");
  } else if (waits) {
    parts.push(`Your work stays as it is (${thread.reason}): do not restart it now.`);
  } else {
    parts.push("Then continue your work.");
  }
  return parts.filter((part) => part.length > 0).join(" ");
};

const ACTION_TEXT: Record<RecoveryAction, string> = {
  resume: "resume",
  "reconcile-first": "reconcile first, then resume",
  "notice-only": "notice only, stays as it is",
  skip: "skipped",
};

const threadLabel = (thread: RecoveryThread) =>
  `${thread.laneName === null ? (thread.roleKind ?? "thread") : `lane "${thread.laneName}"`} ("${thread.title}", ${thread.threadId})`;

const lineFor = (thread: RecoveryThread) => {
  const parts = [`${threadLabel(thread)}: ${ACTION_TEXT[thread.action]} (${thread.reason}).`];
  if (thread.cutRunId !== null && thread.lastActivity !== null)
    parts.push(`Cut while ${thread.lastActivity}.`);
  if (thread.serverContinued) parts.push("Its turn was already continued.");
  if (thread.lostChildren.length > 0) {
    parts.push(
      `Lost ${thread.lostChildren.length}: ${thread.lostChildren.map(childLine).join(", ")}.`,
    );
  }
  if (thread.holds.length > 0) parts.push(`Holds ${holdText(thread.holds)}.`);
  return parts.join(" ");
};

export interface MasterSummaryInput {
  readonly context: NoticeContext;
  readonly missionTitle: string;
  readonly downSeconds: number | null;
  readonly master: RecoveryThread;
  readonly others: ReadonlyArray<RecoveryThread>;
  readonly settings: MissionRecoverySettings;
  /** HH:MM lanes start at when the note is queued behind the master's turn. */
  readonly lanesStartAt?: string | null;
}

/** The master's notice: its own losses plus every lane's planned action, in resume order. */
export const masterNotice = (input: MasterSummaryInput) => {
  const { context, master, settings } = input;
  const down =
    input.downSeconds === null || input.downSeconds < 60
      ? ""
      : ` (down about ${Math.round(input.downSeconds / 60)} min)`;
  const stopped = input.others.filter(isBootStopped);
  const queue = input.others.filter(
    (thread) => thread.action !== "skip" && !stopped.includes(thread),
  );
  const skipped = input.others.filter((thread) => thread.action === "skip");
  const head =
    context.cause === "run-interrupted" && master.cutRunId === null
      ? `Mission runs were interrupted at ${context.at}.`
      : `${opening(context, master).replace(/\.$/, "")}${down}.`;
  const lines = [
    `${NOTICE_PREFIX} ${head} Mission "${input.missionTitle}": ${input.others.length + (master.action === "notice-only" && master.cutRunId === null ? 0 : 1)} thread(s) affected. You get this first.`,
  ];
  if (queue.length > 0) {
    lines.push(
      `Resume plan, in order (${settings.resumePerMinute} per minute, lanes start ${input.lanesStartAt ? `at ${input.lanesStartAt}` : `${settings.masterLeadSeconds}s after this note`}):`,
    );
    queue.forEach((thread, index) => lines.push(`${index + 1}. ${lineFor(thread)}`));
  } else {
    lines.push("No lane needs a resume turn.");
  }
  if (skipped.length > 0) {
    lines.push(
      `Skipped: ${skipped.map((thread) => `${threadLabel(thread)} (${thread.reason})`).join("; ")}.`,
    );
  }
  if (stopped.length > 0) {
    lines.push(
      `Not resumed on their own, the same turn was cut by ${MAX_BOOT_CUTS} or more boots in a row: ${stopped.map((thread) => `${threadLabel(thread)} (${thread.bootCuts} boots${thread.lastActivity === null ? "" : `, cut while ${thread.lastActivity}`})`).join("; ")}. Check what each was running first; resume one by hand with mission_recovery_resume (mode now or release, with its threadId), or skip it.`,
    );
  }
  const reconcileHolds = [master, ...input.others].flatMap((thread) =>
    thread.holds
      .filter((hold) => hold.reconcileRequired)
      .map((hold) => `${hold.holdId} (${threadLabel(thread)})`),
  );
  if (reconcileHolds.length > 0) {
    lines.push(`Pool holds now reconcile-required: ${reconcileHolds.join(", ")}.`);
  }
  lines.push(
    "To change the plan, call mission_recovery_resume (mode hold, now, release, skip or order, with threadId or laneId and an optional instruction that goes into that lane's notice) and mission_recovery_settings for the pace. mission_recovery_status shows where it stands.",
  );
  if (master.cutRunId !== null || master.lostChildren.length > 0 || master.holds.length > 0) {
    lines.push(`Your own turn: ${threadNotice(context, master).slice(NOTICE_PREFIX.length + 1)}`);
  } else {
    lines.push("Your own turn was not running. Re-plan if needed, then continue.");
  }
  return lines.join("\n");
};

export const incidentSummary = (
  missionThreads: ReadonlyArray<RecoveryThread>,
  label: string,
  settings: MissionRecoverySettings,
) => {
  const counts = new Map<RecoveryAction, number>();
  const stopped = missionThreads.filter(isBootStopped);
  for (const thread of missionThreads) {
    if (stopped.includes(thread)) continue;
    counts.set(thread.action, (counts.get(thread.action) ?? 0) + 1);
  }
  const parts = (["resume", "reconcile-first", "notice-only", "skip"] as const)
    .filter((action) => (counts.get(action) ?? 0) > 0)
    .map((action) => `${counts.get(action)} ${ACTION_TEXT[action].split(",")[0]}`);
  const lanes = stopped.filter((thread) => thread.roleKind !== "master");
  const held =
    lanes.length === 0
      ? ""
      : ` Not resumed on their own (same turn cut by ${MAX_BOOT_CUTS}+ boots in a row; resume by hand): ${lanes.map((thread) => `"${truncate(thread.title, 40)}"`).join(", ")}.`;
  const master =
    lanes.length === stopped.length
      ? ""
      : ` The master's own turn was cut by ${MAX_BOOT_CUTS}+ boots in a row; it was told not to rerun it.`;
  return truncate(
    `${label}: ${missionThreads.length} thread(s)${parts.length === 0 ? "" : ` (${parts.join(", ")})`}.${held}${master} Master first, then ${settings.resumePerMinute} per minute.`,
    400,
  );
};
