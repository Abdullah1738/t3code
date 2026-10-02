import type { ArdudBoardEntry } from "@t3tools/contracts";

/** The card's status line, matching OpenChamber's wording. */
export function statusLabel(entry: Pick<ArdudBoardEntry, "state" | "status">): string {
  if (entry.status === "deleted") return "Deleted";
  if (entry.state === "backlog") return "Saved for later";
  if (entry.state === "scheduled") return "Scheduled task";
  if (entry.state === "waiting")
    return entry.status === "unknown" ? "Checking status…" : "Ready for review";
  switch (entry.status) {
    case "working":
      return "Working…";
    case "queued":
      return "Queued…";
    case "background":
      return "Waiting on background work…";
    case "needs-input":
      return "Needs your input";
    default:
      return "Checking status…";
  }
}

export function formatBoardAge(updatedAt: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - updatedAt) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
