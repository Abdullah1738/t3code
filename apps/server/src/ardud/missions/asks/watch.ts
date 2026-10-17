import type { MissionEvent } from "@t3tools/contracts";

/**
 * What a `mission watch` can wake on. Each kind is a filter over the mission
 * event log, so a watcher only needs the last seq it saw.
 */
export const WATCH_KINDS = [
  "ask-opened",
  "ask-answered",
  "draft-opened",
  "suggestion-opened",
  "fork-closed",
  "milestone-at-risk",
  "lane-stalled",
  "swarm-paused",
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
    case "suggestion-opened":
      return event.kind === "suggestion.opened";
    case "fork-closed":
      return event.kind === "fork.closed" && payloadField(event, "archived") !== true;
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
  }
};

export const watchMatches = (
  events: ReadonlyArray<MissionEvent>,
  kinds: ReadonlyArray<WatchKind>,
): MissionEvent[] => events.filter((event) => kinds.some((kind) => matchesWatch(event, kind)));

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
}): string =>
  [
    input.cli,
    "watch-check",
    shellQuote(input.missionId),
    "--on",
    input.kinds.join(","),
    "--cursor",
    '"$WATCH_DIR/mission-cursor"',
  ].join(" ");
