import type { MissionRecordRef } from "@t3tools/contracts";

import type { OwnerRequest } from "../source.ts";
import { isRequestUnread, requestAbout, yourRequests } from "../requestsViewModel.ts";

// Phone helpers over the shared `OwnerRequest`. Requests come from the shared
// missions source (`subscribeRequests` / `subscribeRequest`); forms and
// grouping come from `requestsViewModel`. What is left here is what only the
// phone shows.

/** Master messages after the owner's last word, while the request is unread. */
export function unreadMasterMessages(request: OwnerRequest): number {
  if (!isRequestUnread(request)) return 0;
  let count = 0;
  for (let index = request.messages.length - 1; index >= 0; index -= 1) {
    if (request.messages[index]?.author !== "master") break;
    count += 1;
  }
  return Math.max(count, 1);
}

export interface DiscussionView {
  /** The open discussion about the record, or null before the owner starts one. */
  readonly request: OwnerRequest | null;
  /** The counter on the item's discussion symbol. Adds to no other count. */
  readonly unread: number;
}

export function discussionOn(
  requests: ReadonlyArray<OwnerRequest>,
  subject: MissionRecordRef,
): DiscussionView {
  const request = requestAbout(requests, subject);
  return { request, unread: request ? unreadMasterMessages(request) : 0 };
}

export interface RequestFigures {
  /** Answered by the master and not opened yet. */
  readonly answered: number;
  readonly waiting: number;
}

/** The board's Your requests figure. Discussions on items never count. */
export function requestFigures(requests: ReadonlyArray<OwnerRequest>): RequestFigures {
  const own = yourRequests(requests);
  return {
    answered: own.filter(isRequestUnread).length,
    waiting: own.filter((request) => request.status === "waiting").length,
  };
}
