// @effect-diagnostics globalDate:off globalTimers:off - Optimistic decisions live in client UI state, outside an Effect runtime, on the device clock.

// The owner's decisions show the moment they are made. Each decision patches
// the inbox and request snapshots while it is being sent; a failure drops the
// patch, so the item comes back and the caller reports the error as before.

import { approverOf, type Approver, type InboxItemKind } from "@t3tools/contracts";

import type {
  Listener,
  MissionInboxSnapshot,
  MissionsSource,
  OwnerRequest,
  OwnerRequestMessage,
  Unsubscribe,
} from "./source.ts";

const less = (count: number) => Math.max(0, count - 1);

/**
 * The inbox without one waiting item and its count. Unchanged when the item is
 * gone. Its mark loses the snooze, as the server drops it once the item
 * changes, so snoozed counts stay right; the comments stay to be read on the
 * decided item, and a mark left with none goes.
 */
export function withoutInboxItem(
  inbox: MissionInboxSnapshot,
  kind: InboxItemKind,
  id: string,
): MissionInboxSnapshot {
  const next = removeItem(inbox, kind, id);
  if (next === inbox || !inbox.marks) return next;
  const markId = `${kind}:${id}`;
  const mark = inbox.marks.find((candidate) => candidate.id === markId);
  if (!mark || mark.snooze === null) return next;
  return {
    ...next,
    marks:
      mark.comments.length === 0
        ? inbox.marks.filter((candidate) => candidate !== mark)
        : inbox.marks.map((candidate) =>
            candidate === mark ? { ...candidate, snooze: null } : candidate,
          ),
  };
}

function removeItem(
  inbox: MissionInboxSnapshot,
  kind: InboxItemKind,
  id: string,
): MissionInboxSnapshot {
  const { counts } = inbox;
  switch (kind) {
    case "ask": {
      if (!inbox.asks.some((ask) => ask.id === id)) return inbox;
      return {
        ...inbox,
        asks: inbox.asks.filter((ask) => ask.id !== id),
        counts: { ...counts, decide: less(counts.decide) },
      };
    }
    case "knock": {
      if (!inbox.knocks.some((knock) => knock.id === id)) return inbox;
      return {
        ...inbox,
        knocks: inbox.knocks.filter((knock) => knock.id !== id),
        counts: { ...counts, knocks: less(counts.knocks) },
      };
    }
    case "note": {
      if (!inbox.fyi.some((note) => note.id === id)) return inbox;
      return {
        ...inbox,
        fyi: inbox.fyi.filter((note) => note.id !== id),
        counts: { ...counts, fyi: less(counts.fyi) },
      };
    }
    case "draft": {
      const draft = inbox.drafts.find((record) => record.id === id);
      if (!draft) return inbox;
      return {
        ...inbox,
        drafts: inbox.drafts.filter((record) => record !== draft),
        ...lessOn(inbox, approverOf(draft), "approve"),
      };
    }
    case "approval": {
      const approval = inbox.approvals.find((record) => record.id === id);
      if (!approval) return inbox;
      return {
        ...inbox,
        approvals: inbox.approvals.filter((record) => record !== approval),
        ...lessOn(inbox, approverOf(approval), "approve"),
      };
    }
    case "suggestion": {
      const suggestion = inbox.suggestions.find((record) => record.id === id);
      if (!suggestion) return inbox;
      return {
        ...inbox,
        suggestions: inbox.suggestions.filter((record) => record !== suggestion),
        ...lessOn(inbox, suggestion.acceptor, "suggestions"),
      };
    }
  }
}

/** Drafts, approvals and suggestions count on the inbox they are routed to. */
function lessOn(
  inbox: MissionInboxSnapshot,
  route: Approver,
  tab: "approve" | "suggestions",
): Pick<MissionInboxSnapshot, "counts" | "masterCounts"> {
  return route === "master"
    ? {
        counts: inbox.counts,
        masterCounts: { ...inbox.masterCounts, [tab]: less(inbox.masterCounts[tab]) },
      }
    : {
        counts: { ...inbox.counts, [tab]: less(inbox.counts[tab]) },
        masterCounts: inbox.masterCounts,
      };
}

function ownerMessage(request: OwnerRequest, text: string, at: string): OwnerRequestMessage {
  return { id: `optimistic:${request.id}:${at}`, author: "owner", text, at, refs: [] };
}

/** The request as the server settles it: the owner's closing note, if any, goes on the thread. */
export function settledRequest(
  request: OwnerRequest,
  note: string | undefined,
  at: string,
): OwnerRequest {
  if (request.status === "settled") return request;
  const text = note?.trim() ?? "";
  return {
    ...request,
    status: "settled",
    messages: text ? [...request.messages, ownerMessage(request, text, at)] : request.messages,
    unread: false,
    updatedAt: at,
    settledAt: at,
  };
}

/** The request as the server reopens it: waiting on the master after a note, else as the thread last stood. */
export function reopenedRequest(
  request: OwnerRequest,
  note: string | undefined,
  at: string,
): OwnerRequest {
  if (request.status !== "settled") return request;
  const text = note?.trim() ?? "";
  if (text) {
    return {
      ...request,
      status: "waiting",
      messages: [...request.messages, ownerMessage(request, text, at)],
      updatedAt: at,
      settledAt: null,
    };
  }
  const last = request.messages.at(-1);
  return {
    ...request,
    status: last?.author === "master" ? "answered" : "waiting",
    updatedAt: at,
    settledAt: null,
  };
}

export interface OptimisticDecisionsOptions {
  readonly now?: () => number;
  /**
   * How long a sent decision keeps covering snapshots, so a feed that has not
   * caught up yet cannot bring the item back. After that the server's word
   * stands.
   */
  readonly graceMs?: number;
  /** Runs `run` after `ms`; returns a cancel. Defaults to `setTimeout`. */
  readonly schedule?: (run: () => void, ms: number) => () => void;
}

export const OPTIMISTIC_GRACE_MS = 5_000;

interface Decision {
  readonly inbox?: (inbox: MissionInboxSnapshot) => MissionInboxSnapshot;
  readonly request?: {
    readonly id: string;
    readonly apply: (request: OwnerRequest) => OwnerRequest;
  };
  sending: boolean;
  cancel: (() => void) | null;
}

type Patch = Pick<Decision, "inbox" | "request">;

const defaultSchedule = (run: () => void, ms: number) => {
  const timer = setTimeout(run, ms);
  return () => clearTimeout(timer);
};

/**
 * `source` with the owner's decisions shown at once. Every decision is keyed
 * by its item; a second decision on an item still being sent is ignored and
 * resolves at once. Decisions on different items send side by side.
 */
export function withOptimisticDecisions(
  source: MissionsSource,
  options: OptimisticDecisionsOptions = {},
): MissionsSource {
  const now = options.now ?? Date.now;
  const graceMs = options.graceMs ?? OPTIMISTIC_GRACE_MS;
  const schedule = options.schedule ?? defaultSchedule;
  const decisions = new Map<string, Decision>();
  const watchers = new Set<() => void>();
  let version = 0;

  const changed = () => {
    version += 1;
    for (const watcher of watchers) watcher();
  };

  const drop = (key: string, decision: Decision) => {
    if (decisions.get(key) !== decision) return;
    decisions.delete(key);
    changed();
  };

  const decide = (key: string, patch: Patch, send: () => Promise<void>): Promise<void> => {
    const current = decisions.get(key);
    if (current?.sending) return Promise.resolve();
    current?.cancel?.();
    const decision: Decision = { ...patch, sending: true, cancel: null };
    decisions.set(key, decision);
    changed();
    let sent: Promise<void>;
    try {
      sent = send();
    } catch (error) {
      sent = Promise.reject(error);
    }
    return sent.then(
      () => {
        if (decisions.get(key) !== decision) return;
        decision.sending = false;
        decision.cancel = schedule(() => drop(key, decision), graceMs);
      },
      (error: unknown) => {
        drop(key, decision);
        throw error;
      },
    );
  };

  const removes = (kind: InboxItemKind, id: string): Patch => ({
    inbox: (inbox) => withoutInboxItem(inbox, kind, id),
  });

  const changesRequest = (
    id: string,
    change: (request: OwnerRequest, note: string | undefined, at: string) => OwnerRequest,
    note: string | undefined,
  ): Patch => {
    const at = new Date(now()).toISOString();
    return { request: { id, apply: (request) => change(request, note, at) } };
  };

  const patchInbox = (inbox: MissionInboxSnapshot) => {
    let next = inbox;
    for (const decision of decisions.values()) if (decision.inbox) next = decision.inbox(next);
    return next;
  };

  const patchRequest = (request: OwnerRequest) => {
    let next = request;
    for (const decision of decisions.values()) {
      if (decision.request?.id === request.id) next = decision.request.apply(next);
    }
    return next;
  };

  const patchRequests = (requests: ReadonlyArray<OwnerRequest>) => {
    if (decisions.size === 0) return requests;
    const next = requests.map(patchRequest);
    return next.some((request, index) => request !== requests[index]) ? next : requests;
  };

  /** Shows the latest upstream value with the decisions on it, again whenever they change. */
  const overlay = <T>(
    listener: Listener<T>,
    patch: (value: T) => T,
    subscribe: (emit: Listener<T>) => Unsubscribe,
  ): Unsubscribe => {
    let upstream: { readonly value: T; readonly version: number } | null = null;
    let shown: { readonly value: T } | null = null;
    const show = (value: T) => {
      if (upstream && Object.is(upstream.value, value) && upstream.version === version) return;
      upstream = { value, version };
      const next = patch(value);
      if (shown && Object.is(shown.value, next)) return;
      shown = { value: next };
      listener(next);
    };
    const watcher = () => {
      if (upstream) show(upstream.value);
    };
    watchers.add(watcher);
    const stop = subscribe(show);
    return () => {
      watchers.delete(watcher);
      stop();
    };
  };

  return {
    ...source,
    subscribeInbox: (missionId, listener, onError) =>
      overlay(listener, patchInbox, (emit) => source.subscribeInbox(missionId, emit, onError)),
    subscribeRequests: (missionId, listener, onError) =>
      overlay(listener, patchRequests, (emit) =>
        source.subscribeRequests(missionId, emit, onError),
      ),
    subscribeRequest: (input, listener) =>
      overlay(
        listener,
        (request: OwnerRequest | null) => (request ? patchRequest(request) : request),
        (emit) => source.subscribeRequest(input, emit),
      ),
    answerAsk: (input) =>
      decide(`ask:${input.askId}`, removes("ask", input.askId), () => source.answerAsk(input)),
    decideDraft: (input) =>
      decide(`draft:${input.draftId}`, removes("draft", input.draftId), () =>
        source.decideDraft(input),
      ),
    decideApproval: (input) =>
      decide(`approval:${input.approvalId}`, removes("approval", input.approvalId), () =>
        source.decideApproval(input),
      ),
    decideKnock: (input) =>
      decide(`knock:${input.knockId}`, removes("knock", input.knockId), () =>
        source.decideKnock(input),
      ),
    decideSuggestion: (input) =>
      decide(`suggestion:${input.suggestionId}`, removes("suggestion", input.suggestionId), () =>
        source.decideSuggestion(input),
      ),
    ackNote: (input) =>
      decide(`note:${input.noteId}`, removes("note", input.noteId), () => source.ackNote(input)),
    settleRequest: (input) =>
      decide(
        `request:${input.requestId}`,
        changesRequest(input.requestId, settledRequest, input.note),
        () => source.settleRequest(input),
      ),
    reopenRequest: (input) =>
      decide(
        `request:${input.requestId}`,
        changesRequest(input.requestId, reopenedRequest, input.note),
        () => source.reopenRequest(input),
      ),
  };
}
