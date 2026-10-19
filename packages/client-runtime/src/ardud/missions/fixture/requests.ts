import { MissionId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { requestTitle } from "../requestsViewModel.ts";
import { applySectionChange, defaultLayout, type MissionLayout } from "../sections.ts";
import type { Listener, MissionsSource, OwnerRequest, Unsubscribe } from "../source.ts";
import { AT, CRPKO } from "./data.ts";
import { fail } from "./util.ts";

// Sample owner requests and per-mission section lists. Both are UI-side until
// the router track ships owner requests and the views track ships the layout
// record; the RPC source serves them from here and marks them sample.

const decodeMissionId = Schema.decodeUnknownSync(MissionId);

const ref = <K extends OwnerRequest["messages"][number]["refs"][number]["kind"]>(
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
          refs: [
            ref("work-item", "codec-v4", "Dev cluster resize"),
            ref("ask", "ask-kafka-capacity-r004", "Kafka capacity r004"),
          ],
        },
      ],
      createdAt: AT("06:10"),
      updatedAt: AT("07:52"),
      readAt: AT("06:10"),
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
      createdAt: AT("08:05"),
      updatedAt: AT("08:05"),
      readAt: AT("08:05"),
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
          refs: [ref("work-item", "risk68-r4", "risk#68 r4"), ref("rule", "rule-104", "Rule 104")],
        },
      ],
      createdAt: AT("21:40", 16),
      updatedAt: AT("22:15", 16),
      readAt: AT("23:02", 16),
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
          refs: [ref("rule", "rule-105", "Rule 105")],
        },
      ],
      createdAt: AT("10:00", 15),
      updatedAt: AT("10:20", 15),
      readAt: AT("10:20", 15),
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
  /** Items waiting on the owner, for the hide summary of Needs you. */
  readonly ownerWaiting: (missionId: string) => number;
}

export type RequestsSource = Pick<
  MissionsSource,
  | "subscribeLayout"
  | "changeSection"
  | "subscribeRequests"
  | "openRequest"
  | "replyRequest"
  | "settleRequest"
  | "reopenRequest"
  | "markRequestRead"
>;

export function createRequests(ctx: RequestsContext): RequestsSource {
  const { memo, commit, watch, nowIso, localId } = ctx;
  let requests = seedRequests();
  const layouts = new Map<string, MissionLayout>();

  const layoutOf = (missionId: MissionId): MissionLayout => {
    const known = layouts.get(missionId);
    if (known) return known;
    const fresh = defaultLayout(missionId);
    layouts.set(missionId, fresh);
    return fresh;
  };

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
    subscribeLayout: (missionId, listener) => watch(() => layoutOf(missionId), listener),

    changeSection({ missionId, key, change }) {
      const before = layoutOf(missionId);
      const result = applySectionChange(before, key, change, {
        id: localId("layout-change"),
        at: nowIso(),
        by: "owner",
        ownerWaiting: ctx.ownerWaiting(missionId),
      });
      if (!result.ok) return fail("invalid", result.error);
      if (result.value !== before) {
        layouts.set(missionId, result.value);
        commit();
      }
      return Promise.resolve();
    },

    subscribeRequests: (missionId, listener) => watch(() => missionRequests(missionId), listener),

    openRequest({ missionId, text }) {
      const body = text.trim();
      if (body === "") return fail("invalid", "Write what you want first.");
      const at = nowIso();
      const id = localId("request");
      const request: OwnerRequest = {
        id,
        missionId,
        title: requestTitle(body),
        status: "waiting",
        messages: [{ id: `${id}-1`, author: "owner", text: body, at, refs: [] }],
        createdAt: at,
        updatedAt: at,
        readAt: at,
        settledAt: null,
      };
      requests = [...requests, request];
      commit();
      return Promise.resolve(request);
    },

    replyRequest({ requestId, text }) {
      const body = text.trim();
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
          updatedAt: at,
          readAt: at,
        };
      });
    },

    settleRequest: ({ requestId }) =>
      update(requestId, (request) => {
        if (request.status === "settled") return "It is already settled.";
        const at = nowIso();
        return { ...request, status: "settled", settledAt: at, updatedAt: at, readAt: at };
      }),

    reopenRequest: ({ requestId }) =>
      update(requestId, (request) => {
        if (request.status !== "settled") return "It is still open.";
        const last = request.messages.at(-1);
        return {
          ...request,
          status: last?.author === "master" ? "answered" : "waiting",
          settledAt: null,
          updatedAt: nowIso(),
        };
      }),

    markRequestRead({ requestId }) {
      const request = requests.find((r) => r.id === requestId);
      if (!request) return fail("not-found", `Request ${requestId} not found.`);
      const last = request.messages.at(-1);
      if (request.readAt !== null && (!last || last.at <= request.readAt)) {
        return Promise.resolve();
      }
      return update(requestId, (current) => ({ ...current, readAt: nowIso() }));
    },
  };
}
