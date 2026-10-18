import type { LaneStatus, MilestoneStatus, MissionHealth } from "@t3tools/contracts";
import type { LaneFoldTone } from "@t3tools/client-runtime/ardud/missions";

// Static class maps so every colour is a theme token and the lint rules can
// see each class literally.

export const HEALTH_DOT_CLASS: Record<MissionHealth, string> = {
  green: "bg-success",
  amber: "bg-warning",
  red: "bg-destructive",
  unknown: "bg-muted-foreground/40",
};

export const HEALTH_TEXT_CLASS: Record<MissionHealth, string> = {
  green: "text-success-foreground",
  amber: "text-warning-foreground",
  red: "text-destructive-foreground",
  unknown: "text-muted-foreground",
};

export const LANE_DOT_CLASS: Record<LaneStatus | LaneFoldTone, string> = {
  working: "bg-success",
  stuck: "bg-destructive",
  waiting: "bg-warning",
  idle: "bg-muted-foreground/40",
  parked: "bg-muted-foreground/25",
  retired: "bg-muted-foreground/15",
};

export const LANE_TEXT_CLASS: Record<LaneFoldTone, string> = {
  working: "text-sidebar-muted-foreground",
  stuck: "text-destructive-foreground",
  waiting: "text-warning-foreground",
  idle: "text-sidebar-muted-foreground/70",
  parked: "text-sidebar-muted-foreground/70",
};

export const MILESTONE_LABEL: Record<MilestoneStatus, string> = {
  planned: "Planned",
  "on-track": "On track",
  "at-risk": "At risk",
  done: "Done",
  missed: "Missed",
};

export const MILESTONE_BADGE_VARIANT = {
  planned: "outline",
  "on-track": "success",
  "at-risk": "warning",
  done: "secondary",
  missed: "error",
} as const satisfies Record<MilestoneStatus, string>;

export const HEALTH_BADGE_VARIANT = {
  green: "success",
  amber: "warning",
  red: "error",
  unknown: "outline",
} as const satisfies Record<MissionHealth, string>;
