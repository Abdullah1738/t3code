/**
 * A role or lane thread's pending permission request goes to its lead (see
 * `leadTiersOf`), not to the owner's Telegram, the same way its questions do.
 * This is the text the lead gets: what the thread wants to do, and how to
 * approve or decline it or take it to the owner.
 */
import {
  type ProviderApprovalOption,
  RespondMissionApprovalInput,
  type ThreadId,
} from "@t3tools/contracts";

/** The router's producer name for these notices: their author in the room. */
export const LEAD_APPROVAL_PRODUCER = "lane-approvals";

const PROMPT_MAX = 800;
const TITLE_MAX = 160;

const clip = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
};

/** What a pending permission request asks, as far as it is recorded. */
export interface PendingApproval {
  /** The request kind: command, file-read, file-change, mcp-elicitation, permission... */
  readonly requestKind: string;
  readonly title: string | null;
  readonly prompt: string | null;
  /** The decisions the provider offers, when it lists them. */
  readonly options: ReadonlyArray<ProviderApprovalOption> | null;
}

/** The decisions a lead may give (see `RespondMissionApprovalInput`). */
const LEAD_APPROVAL_DECISIONS: ReadonlyArray<string> =
  RespondMissionApprovalInput.fields.decision.literals;

export const leadApprovalKey = (threadId: ThreadId, requestId: string, leadThreadId: ThreadId) =>
  `lead-approval:${threadId}:${requestId}:${leadThreadId}`;

export const leadApprovalText = (input: {
  /** What the asking thread is called in the mission (its lane, else its role). */
  readonly asker: string;
  readonly threadId: ThreadId;
  readonly requestId: string;
  readonly approval: PendingApproval;
}): string => {
  const { approval } = input;
  const lines = [
    `${input.asker} is waiting on a permission request you lead (${approval.requestKind}):`,
  ];
  if (approval.title !== null && approval.title.trim().length > 0) {
    lines.push(`- ${clip(approval.title, TITLE_MAX)}`);
  }
  if (approval.prompt !== null && approval.prompt.trim().length > 0) {
    lines.push(`- ${clip(approval.prompt, PROMPT_MAX)}`);
  }
  const offered = (approval.options ?? []).filter((option) =>
    LEAD_APPROVAL_DECISIONS.includes(option.decision),
  );
  const decisions = offered.length > 0 ? offered : null;
  lines.push(
    `  Decisions: ${
      decisions === null
        ? LEAD_APPROVAL_DECISIONS.join(" / ")
        : decisions.map((option) => `${option.decision} (${clip(option.label, 60)})`).join(" / ")
    }`,
  );
  lines.push(
    "",
    `Approve or decline it with mission_approval_respond using threadId ${input.threadId} and requestId ${input.requestId}.`,
    "If only the owner can decide, ask him with mission_ask, then answer it with what he says.",
    "If it is no longer pending, it was answered or dismissed.",
  );
  return lines.join("\n");
};
