import type { MilestoneStatus } from "@t3tools/contracts";

// Static class maps so every colour is a theme token and the lint rules can
// see each class literally.

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
