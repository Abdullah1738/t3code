import type { MissionId } from "@t3tools/contracts";

import type {
  OpenRequestInput,
  OwnerRequest,
  OwnerRequestMessage,
  OwnerRequestStatus,
  ReplyRequestInput,
} from "./source.ts";

// Wording and grouping for the owner's requests to the master.

export const REQUEST_STATUS_LABEL: Record<OwnerRequestStatus, string> = {
  waiting: "Waiting on master",
  answered: "Answered",
  settled: "Settled",
};

/** Request titles come from the first line of the owner's text, cut at this length. */
export const REQUEST_TITLE_MAX = 80;

type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const err = <T>(error: string): Result<T> => ({ ok: false, error });

/** The title a new request gets: its first line, trimmed and cut. */
export function requestTitle(text: string): string {
  const line = text.trim().split("\n")[0]?.trim() ?? "";
  return line.length <= REQUEST_TITLE_MAX ? line : `${line.slice(0, REQUEST_TITLE_MAX - 1)}…`;
}

export function openRequestInput(missionId: MissionId, text: string): Result<OpenRequestInput> {
  const trimmed = text.trim();
  if (trimmed === "") return err("Write what you want first.");
  return ok({ missionId, text: trimmed });
}

export function replyRequestInput(requestId: string, text: string): Result<ReplyRequestInput> {
  const trimmed = text.trim();
  if (trimmed === "") return err("Write a reply first.");
  return ok({ requestId, text: trimmed });
}

export function lastMasterReply(
  request: Pick<OwnerRequest, "messages">,
): OwnerRequestMessage | null {
  for (let index = request.messages.length - 1; index >= 0; index -= 1) {
    const message = request.messages[index];
    if (message?.author === "master") return message;
  }
  return null;
}

/** The master spoke since the owner last read it. */
export function isRequestUnread(request: Pick<OwnerRequest, "status" | "unread">): boolean {
  return request.status !== "settled" && request.unread;
}

export function unreadRequestCount(requests: ReadonlyArray<OwnerRequest>): number {
  return requests.filter(isRequestUnread).length;
}

export interface RequestGroups {
  /** Answered first (unread on top), then waiting; newest activity first within each. */
  readonly open: ReadonlyArray<OwnerRequest>;
  readonly settled: ReadonlyArray<OwnerRequest>;
}

export function groupRequests(requests: ReadonlyArray<OwnerRequest>): RequestGroups {
  const rank = (request: OwnerRequest) =>
    isRequestUnread(request) ? 0 : request.status === "answered" ? 1 : 2;
  const newest = (left: OwnerRequest, right: OwnerRequest) =>
    right.updatedAt.localeCompare(left.updatedAt);
  const open = requests
    .filter((request) => request.status !== "settled")
    .sort((left, right) => rank(left) - rank(right) || newest(left, right));
  const settled = requests.filter((request) => request.status === "settled").sort(newest);
  return { open, settled };
}

/** The row's second line: the master's last reply, else the owner's own text. */
export function requestPreview(request: Pick<OwnerRequest, "messages">): string {
  const reply = lastMasterReply(request);
  const source = reply ?? request.messages[0];
  return source?.text.split("\n")[0]?.trim() ?? "";
}
