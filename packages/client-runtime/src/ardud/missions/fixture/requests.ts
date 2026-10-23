import { MissionId, placeRequestImages, type OwnerRequestImage } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { isRequestUnread, requestTitle, yourRequests } from "../requestsViewModel.ts";
import type { Listener, MissionsSource, OwnerRequest, Unsubscribe } from "../source.ts";
import { AT, CRPKO } from "./data.ts";
import { fail } from "./util.ts";

/** The fixture keeps no image files: each image shows as its plain label where he put it. */
function withFixtureImages(text: string, images: ReadonlyArray<OwnerRequestImage> = []): string {
  return placeRequestImages(
    text,
    images.map((_, at) => `[image ${at + 1}]`),
  ).trim();
}

// Sample owner requests for the fixture source, shaped like the router's
// owner-request records once mapped for the UI.

const decodeMissionId = Schema.decodeUnknownSync(MissionId);

const ref = <K extends OwnerRequest["links"][number]["kind"]>(
  kind: K,
  id: string,
  label: string,
) => ({ kind, id, label });

function seedRequests(): OwnerRequest[] {
  const mission = decodeMissionId(CRPKO);
  return [
    {
      id: "request-dev-cost",
      missionId: mission,
      title: "Get dev env cost under $40 a day before Monday",
      status: "answered",
      messages: [
        {
          id: "request-dev-cost-1",
          author: "owner",
          text: "Get dev env cost under $40 a day before Monday. Park what you have to.",
          at: AT("06:10"),
          refs: [],
        },
        {
          id: "request-dev-cost-2",
          author: "master",
          text: "Parked two idle lanes and opened a resize of the dev cluster. One call needs you: Kafka capacity for r004.",
          at: AT("07:52"),
          refs: [],
        },
      ],
      hasOlder: false,
      links: [
        ref("work-item", "codec-v4", "Dev cluster resize"),
        ref("ask", "ask-kafka-capacity-r004", "Kafka capacity r004"),
      ],
      subject: null,
      unread: true,
      createdAt: AT("06:10"),
      updatedAt: AT("07:52"),
      settledAt: null,
    },
    {
      id: "request-dylan-rebase",
      missionId: mission,
      title: "Tell Dylan to rebase backoffice-core#334 before the next round",
      status: "waiting",
      messages: [
        {
          id: "request-dylan-rebase-1",
          author: "owner",
          text: "Tell Dylan to rebase backoffice-core#334 before the next review round.",
          at: AT("08:05"),
          refs: [],
        },
      ],
      hasOlder: false,
      links: [],
      subject: null,
      unread: false,
      createdAt: AT("08:05"),
      updatedAt: AT("08:05"),
      settledAt: null,
    },
    {
      id: "request-risk-round",
      missionId: mission,
      title: "Why did risk#68 need a fifth round?",
      status: "answered",
      messages: [
        {
          id: "request-risk-round-1",
          author: "owner",
          text: "Why did risk#68 need a fifth round?",
          at: AT("21:40", 16),
          refs: [],
        },
        {
          id: "request-risk-round-2",
          author: "master",
          text: "Round 4 found 19 issues across 5 workers; two broke rule 104, so Sol reviews again before Astra's final pass.",
          at: AT("22:15", 16),
          refs: [],
        },
      ],
      hasOlder: false,
      links: [ref("work-item", "risk68-r4", "risk#68 r4"), ref("rule", "rule-104", "Rule 104")],
      subject: null,
      unread: false,
      createdAt: AT("21:40", 16),
      updatedAt: AT("22:15", 16),
      settledAt: null,
    },
    {
      id: "request-codex-topups",
      missionId: mission,
      title: "Stop asking me about Codex top-ups under 2 usable",
      status: "settled",
      messages: [
        {
          id: "request-codex-topups-1",
          author: "owner",
          text: "Stop asking me about Codex top-ups under 2 usable. Just queue the review.",
          at: AT("10:00", 15),
          refs: [],
        },
        {
          id: "request-codex-topups-2",
          author: "master",
          text: "Saved as a rule: reviews queue when fewer than 2 Codex accounts are usable.",
          at: AT("10:04", 15),
          refs: [],
        },
      ],
      hasOlder: false,
      links: [ref("rule", "rule-105", "Rule 105")],
      subject: null,
      unread: false,
      createdAt: AT("10:00", 15),
      updatedAt: AT("10:20", 15),
      settledAt: AT("10:20", 15),
    },
  ];
}

export interface RequestsContext {
  readonly memo: <T>(key: string, compute: () => T) => T;
  readonly commit: () => void;
  readonly watch: <T>(read: () => T, listener: Listener<T>) => Unsubscribe;
  readonly nowIso: () => string;
  readonly localId: (prefix: string) => string;
}

export type RequestsSource = Pick<
  MissionsSource,
  | "subscribeRequests"
  | "subscribeRequest"
  | "openRequest"
  | "replyRequest"
  | "settleRequest"
  | "reopenRequest"
  | "markRequestRead"
>;

export function createRequests(ctx: RequestsContext): RequestsSource & {
  /** Answered requests the owner has not read, for the views pin. */
  readonly unreadFor: (missionId: string) => number;
} {
  const { memo, commit, watch, nowIso, localId } = ctx;
  let requests = seedRequests();

  const missionRequests = (missionId: string) =>
    memo(`requests:${missionId}`, () =>
      requests
        .filter((request) => request.missionId === missionId)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    );

  function update(
    requestId: string,
    change: (request: OwnerRequest) => OwnerRequest | string,
  ): Promise<void> {
    const request = requests.find((r) => r.id === requestId);
    if (!request) return fail("not-found", `Request ${requestId} not found.`);
    const next = change(request);
    if (typeof next === "string") return fail("invalid", next);
    requests = requests.map((r) => (r.id === requestId ? next : r));
    commit();
    return Promise.resolve();
  }

  return {
    // Discussions count on their record's card, not under Your requests.
    unreadFor: (missionId) =>
      yourRequests(missionRequests(missionId)).filter(isRequestUnread).length,

    subscribeRequests: (missionId, listener) => watch(() => missionRequests(missionId), listener),

    subscribeRequest: ({ requestId }, listener) =>
      watch(() => requests.find((request) => request.id === requestId) ?? null, listener),

    openRequest({ missionId, text, subject, images }) {
      const body = withFixtureImages(text, images);
      if (body === "") return fail("invalid", "Write what you want first.");
      const at = nowIso();
      // One open request per record: Discuss again continues it.
      const about = subject
        ? requests.find(
            (request) =>
              request.missionId === missionId &&
              request.status !== "settled" &&
              request.subject?.kind === subject.kind &&
              request.subject.id === subject.id,
          )
        : undefined;
      if (about) {
        const next: OwnerRequest = {
          ...about,
          status: "waiting",
          messages: [
            ...about.messages,
            { id: localId("request-message"), author: "owner", text: body, at, refs: [] },
          ],
          unread: false,
          updatedAt: at,
        };
        requests = requests.map((request) => (request.id === about.id ? next : request));
        commit();
        return Promise.resolve(next);
      }
      const id = localId("request");
      const request: OwnerRequest = {
        id,
        missionId,
        title: requestTitle(body),
        status: "waiting",
        messages: [{ id: `${id}-1`, author: "owner", text: body, at, refs: [] }],
        hasOlder: false,
        links: [],
        subject: subject ?? null,
        unread: false,
        createdAt: at,
        updatedAt: at,
        settledAt: null,
      };
      requests = [...requests, request];
      commit();
      return Promise.resolve(request);
    },

    replyRequest({ requestId, text, images }) {
      const body = withFixtureImages(text, images);
      if (body === "") return fail("invalid", "Write a reply first.");
      return update(requestId, (request) => {
        if (request.status === "settled") return "Reopen it before replying.";
        const at = nowIso();
        return {
          ...request,
          status: "waiting",
          messages: [
            ...request.messages,
            { id: localId("request-message"), author: "owner", text: body, at, refs: [] },
          ],
          unread: false,
          updatedAt: at,
        };
      });
    },

    settleRequest: ({ requestId, note }) =>
      update(requestId, (request) => {
        if (request.status === "settled") return "It is already settled.";
        const at = nowIso();
        const text = note?.trim() ?? "";
        const messages =
          text === ""
            ? request.messages
            : [
                ...request.messages,
                { id: localId("request-message"), author: "owner" as const, text, at, refs: [] },
              ];
        return {
          ...request,
          status: "settled",
          messages,
          settledAt: at,
          updatedAt: at,
          unread: false,
        };
      }),

    reopenRequest: ({ requestId, note }) =>
      update(requestId, (request) => {
        if (request.status !== "settled") return "It is still open.";
        const at = nowIso();
        const text = note?.trim() ?? "";
        // Reopening with words is the owner speaking again: it waits on the master.
        if (text !== "") {
          return {
            ...request,
            status: "waiting",
            messages: [
              ...request.messages,
              { id: localId("request-message"), author: "owner", text, at, refs: [] },
            ],
            settledAt: null,
            updatedAt: at,
          };
        }
        const last = request.messages.at(-1);
        return {
          ...request,
          status: last?.author === "master" ? "answered" : "waiting",
          settledAt: null,
          updatedAt: at,
        };
      }),

    markRequestRead({ requestId }) {
      const request = requests.find((r) => r.id === requestId);
      if (!request) return fail("not-found", `Request ${requestId} not found.`);
      if (!request.unread) return Promise.resolve();
      return update(requestId, (current) => ({ ...current, unread: false }));
    },
  };
}
