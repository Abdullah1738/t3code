import type { MissionEvent } from "@t3tools/contracts";

/**
 * What a `mission watch` can wake on. Each kind is a filter over the mission
 * event log, so a watcher only needs the last seq it saw.
 */
export const WATCH_KINDS = [
  "ask-opened",
  "ask-answered",
  "draft-opened",
  // The writer waits on its draft's decision: approved, sent back, dropped or withdrawn.
  "draft-decided",
  "suggestion-opened",
  "milestone-at-risk",
  "lane-stalled",
  "swarm-paused",
  // What his iMessage agent waits on to show him something.
  "request-replied",
  "request-answered",
  "approval-opened",
  "work-item-done",
] as const;
export type WatchKind = (typeof WATCH_KINDS)[number];

export const isWatchKind = (value: string): value is WatchKind =>
  (WATCH_KINDS as ReadonlyArray<string>).includes(value);

const payloadField = (event: MissionEvent, field: string): unknown =>
  typeof event.payload === "object" && event.payload !== null
    ? (event.payload as Record<string, unknown>)[field]
    : undefined;

const RISKY_MILESTONE = new Set(["at-risk", "missed"]);

export const matchesWatch = (event: MissionEvent, kind: WatchKind): boolean => {
  switch (kind) {
    case "ask-opened":
      return event.kind === "ask.opened" || event.kind === "ask.reopened";
    case "ask-answered":
      return event.kind === "ask.answered";
    case "draft-opened":
      return event.kind === "draft.opened";
    case "draft-decided":
      return event.kind === "draft.decided";
    case "suggestion-opened":
      return event.kind === "suggestion.opened";
    case "milestone-at-risk":
      return (
        event.kind === "milestone.updated" &&
        RISKY_MILESTONE.has(String(payloadField(event, "status") ?? ""))
      );
    case "lane-stalled":
      return (
        event.kind === "lane.parked" ||
        (event.kind === "lane.moved" && payloadField(event, "status") === "stuck")
      );
    case "swarm-paused":
      return (
        event.kind === "mission.paused" ||
        (event.kind === "governor.action" && payloadField(event, "action") === "pause")
      );
    // The master's replies only; his own replies post the same event.
    case "request-replied":
      return event.kind === "request.replied" && event.actor._tag !== "owner";
    case "request-answered":
      return (
        event.kind === "request.replied" &&
        event.actor._tag !== "owner" &&
        payloadField(event, "status") === "answered"
      );
    case "approval-opened":
      return event.kind === "approval.opened";
    case "work-item-done":
      return (
        (event.kind === "work-item.updated" || event.kind === "work-item.created") &&
        payloadField(event, "stage") === "done"
      );
  }
};

/** Matching events; with `id`, only those about that record (a request, draft, item...). */
export const watchMatches = (
  events: ReadonlyArray<MissionEvent>,
  kinds: ReadonlyArray<WatchKind>,
  id?: string,
): MissionEvent[] =>
  events.filter(
    (event) =>
      (id === undefined || event.subject?.id === id) &&
      kinds.some((kind) => matchesWatch(event, kind)),
  );

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * The robob-watch check for a watch: prints the matching events since the
 * last run (the cursor lives in `$WATCH_DIR`) and nothing otherwise, so the
 * watcher wakes only on a match.
 */
export const watchCheckCommand = (input: {
  /** The `mission` CLI command, already shell-safe (e.g. `mission`). */
  readonly cli: string;
  readonly missionId: string;
  readonly kinds: ReadonlyArray<WatchKind>;
  /** Only events about this record. */
  readonly id?: string;
}): string =>
  [
    input.cli,
    "watch-check",
    shellQuote(input.missionId),
    "--on",
    input.kinds.join(","),
    ...(input.id === undefined ? [] : ["--id", shellQuote(input.id)]),
    "--cursor",
    '"$WATCH_DIR/mission-cursor"',
  ].join(" ");

/** The `robob-watch add` line that installs a watch as a wake-mode watcher. */
export const watchAddCommand = (input: {
  readonly cli: string;
  readonly missionId: string;
  readonly kinds: ReadonlyArray<WatchKind>;
  readonly id?: string;
  readonly intervalSeconds?: number;
}): string =>
  [
    "robob-watch add",
    "--id",
    shellQuote(
      `mission-${input.missionId}-${input.kinds.join("-")}${input.id === undefined ? "" : `-${input.id}`}`,
    ),
    "--title",
    shellQuote(
      `Mission ${input.missionId}: ${input.kinds.join(", ")}${input.id === undefined ? "" : ` on ${input.id}`}`,
    ),
    "--check",
    shellQuote(watchCheckCommand(input)),
    "--mode wake",
    "--interval",
    String(input.intervalSeconds ?? 120),
    "--context",
    shellQuote(
      `Mission ${input.missionId} changed (${input.kinds.join(", ")}). Read it with mission_status or mission_digest.`,
    ),
  ].join(" ");
