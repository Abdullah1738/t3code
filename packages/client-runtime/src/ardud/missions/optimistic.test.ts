// @effect-diagnostics globalDate:off - Tests build times on the local clock.
import type { InboxItemKind, InboxMark, MissionId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { createFixtureMissionsSource, FIXTURE_NOW } from "./fixture/index.ts";
import { commentsOf, inboxTabCounts } from "./inboxViewModel.ts";
import {
  reopenedRequest,
  settledRequest,
  withOptimisticDecisions,
  withoutInboxItem,
} from "./optimistic.ts";
import type { MissionInboxSnapshot, MissionsSource, OwnerRequest } from "./source.ts";

const CRPKO = "crpko-engineering" as MissionId;
const NOW = Date.parse(FIXTURE_NOW) + 60_000;
const AT = new Date(NOW).toISOString();

function request(overrides: Partial<OwnerRequest> & Pick<OwnerRequest, "id">): OwnerRequest {
  return {
    missionId: CRPKO,
    title: overrides.id,
    status: "answered",
    messages: [],
    hasOlder: false,
    links: [],
    subject: null,
    unread: false,
    createdAt: FIXTURE_NOW,
    updatedAt: FIXTURE_NOW,
    settledAt: null,
    ...overrides,
  };
}

function fixtureInbox(): MissionInboxSnapshot {
  let inbox: MissionInboxSnapshot | null = null;
  createFixtureMissionsSource({ now: () => NOW }).subscribeInbox(null, (value) => {
    inbox = value;
  })();
  if (!inbox) throw new Error("fixture inbox did not emit");
  return inbox;
}

interface Send {
  readonly method: string;
  readonly input: unknown;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

/** A source whose feeds the test pushes and whose sends the test settles. */
function controlled() {
  const base = createFixtureMissionsSource({ now: () => NOW });
  const inboxListeners = new Set<(inbox: MissionInboxSnapshot) => void>();
  const requestListeners = new Set<(requests: ReadonlyArray<OwnerRequest>) => void>();
  const threadListeners = new Set<(request: OwnerRequest | null) => void>();
  const sends: Send[] = [];
  const send =
    (method: string) =>
    (input: unknown): Promise<void> =>
      new Promise((resolve, reject) => {
        sends.push({ method, input, resolve: () => resolve(), reject });
      });
  const upstream: MissionsSource = {
    ...base,
    subscribeInbox: (_missionId, listener) => {
      inboxListeners.add(listener);
      return () => inboxListeners.delete(listener);
    },
    subscribeRequests: (_missionId, listener) => {
      requestListeners.add(listener);
      return () => requestListeners.delete(listener);
    },
    subscribeRequest: (_input, listener) => {
      threadListeners.add(listener);
      return () => threadListeners.delete(listener);
    },
    answerAsk: send("answerAsk"),
    decideDraft: send("decideDraft"),
    decideApproval: send("decideApproval"),
    decideKnock: send("decideKnock"),
    decideSuggestion: send("decideSuggestion"),
    ackNote: send("ackNote"),
    settleRequest: send("settleRequest"),
    reopenRequest: send("reopenRequest"),
  };
  const timers: Array<{ run: () => void; cancelled: boolean }> = [];
  const source = withOptimisticDecisions(upstream, {
    now: () => NOW,
    schedule: (run) => {
      const timer = { run, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
  });
  return {
    source,
    sends,
    pushInbox: (inbox: MissionInboxSnapshot) => {
      for (const listener of inboxListeners) listener(inbox);
    },
    pushRequests: (requests: ReadonlyArray<OwnerRequest>) => {
      for (const listener of requestListeners) listener(requests);
    },
    pushThread: (value: OwnerRequest | null) => {
      for (const listener of threadListeners) listener(value);
    },
    endGrace: () => {
      for (const timer of timers.splice(0)) if (!timer.cancelled) timer.run();
    },
  };
}

function latest<T>(subscribe: (listener: (value: T) => void) => () => void) {
  const seen: T[] = [];
  subscribe((value) => seen.push(value));
  return {
    seen,
    get value(): T {
      const value = seen.at(-1);
      if (value === undefined) throw new Error("nothing emitted");
      return value;
    },
  };
}

const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve));

describe("withoutInboxItem", () => {
  const inbox = fixtureInbox();

  it("drops an owner-routed approval and its count", () => {
    const next = withoutInboxItem(inbox, "approval", "approval-backoffice-core-334");
    expect(next.approvals.map((approval) => approval.id)).not.toContain(
      "approval-backoffice-core-334",
    );
    expect(next.counts.approve).toBe(inbox.counts.approve - 1);
    expect(next.masterCounts).toBe(inbox.masterCounts);
  });

  it("drops a master-routed draft from the master's count", () => {
    const next = withoutInboxItem(inbox, "draft", "draft-dylan-bo-334");
    expect(next.drafts.map((draft) => draft.id)).toEqual(["draft-pavan-risk-124"]);
    expect(next.masterCounts.approve).toBe(inbox.masterCounts.approve - 1);
    expect(next.counts).toBe(inbox.counts);
  });

  it("routes suggestions by acceptor", () => {
    const owner = withoutInboxItem(inbox, "suggestion", "suggestion-review-slot");
    expect(owner.counts.suggestions).toBe(inbox.counts.suggestions - 1);
    const master = withoutInboxItem(inbox, "suggestion", "suggestion-triage-sweeps");
    expect(master.masterCounts.suggestions).toBe(inbox.masterCounts.suggestions - 1);
  });

  it("keeps the inbox when the item is already gone", () => {
    const once = withoutInboxItem(inbox, "ask", inbox.asks[0]!.id);
    expect(withoutInboxItem(once, "ask", inbox.asks[0]!.id)).toBe(once);
    expect(withoutInboxItem(inbox, "knock", "missing")).toBe(inbox);
  });

  const markOn = (
    kind: InboxItemKind,
    id: string,
    overrides: Partial<InboxMark> = {},
  ): InboxMark => ({
    id: `${kind}:${id}`,
    missionId: null,
    subject: { kind, id },
    comments: [],
    snooze: { at: FIXTURE_NOW, until: null, stamp: "s" },
    updatedAt: FIXTURE_NOW,
    ...overrides,
  });

  it("drops a snooze-only mark so snoozed counts stay right", () => {
    const ask = inbox.asks[0]!;
    const next = withoutInboxItem({ ...inbox, marks: [markOn("ask", ask.id)] }, "ask", ask.id);
    expect(next.marks).toEqual([]);
    expect(inboxTabCounts(next, "owner", NOW).decide).toBe(0);
  });

  it("keeps the comments on a decided item and only lifts its snooze", () => {
    const ask = inbox.asks[0]!;
    const comments = [{ id: "c-1", body: "Leaning hold", at: FIXTURE_NOW }];
    const snoozed = markOn("ask", ask.id, { comments });
    const next = withoutInboxItem({ ...inbox, marks: [snoozed] }, "ask", ask.id);
    expect(commentsOf(next, `ask:${ask.id}`)).toEqual(comments);
    expect(next.marks?.[0]?.snooze).toBeNull();
    expect(inboxTabCounts(next, "owner", NOW).decide).toBe(0);
    // Comments without a snooze are left exactly as they were.
    const commented = { ...inbox, marks: [markOn("ask", ask.id, { comments, snooze: null })] };
    expect(withoutInboxItem(commented, "ask", ask.id).marks).toBe(commented.marks);
  });
});

describe("settledRequest and reopenedRequest", () => {
  it("settles with the closing note on the thread", () => {
    const next = settledRequest(request({ id: "r", unread: true }), "  thanks ", AT);
    expect(next).toMatchObject({ status: "settled", unread: false, settledAt: AT, updatedAt: AT });
    expect(next.messages.map((message) => [message.author, message.text])).toEqual([
      ["owner", "thanks"],
    ]);
  });

  it("settles without a message when the note is blank", () => {
    expect(settledRequest(request({ id: "r" }), " ", AT).messages).toEqual([]);
  });

  it("reopens to answered when the master spoke last, waiting after a note", () => {
    const settled = request({
      id: "r",
      status: "settled",
      settledAt: FIXTURE_NOW,
      messages: [{ id: "m1", author: "master", text: "done", at: FIXTURE_NOW, refs: [] }],
    });
    expect(reopenedRequest(settled, undefined, AT)).toMatchObject({
      status: "answered",
      settledAt: null,
    });
    const noted = reopenedRequest(settled, "not quite", AT);
    expect(noted.status).toBe("waiting");
    expect(noted.messages.at(-1)).toMatchObject({ author: "owner", text: "not quite" });
  });

  it("leaves a request already in the target state alone", () => {
    const open = request({ id: "r" });
    expect(reopenedRequest(open, undefined, AT)).toBe(open);
    const settled = settledRequest(open, undefined, AT);
    expect(settledRequest(settled, "again", AT)).toBe(settled);
  });
});

describe("withOptimisticDecisions", () => {
  const inbox = fixtureInbox();
  const draftId = "draft-pavan-risk-124";
  const decideDraft = { draftId, action: "approve" } as const;

  it("removes the item at once and sends in the background", () => {
    const harness = controlled();
    const shown = latest<MissionInboxSnapshot>((listener) =>
      harness.source.subscribeInbox(null, listener),
    );
    harness.pushInbox(inbox);
    void harness.source.decideDraft(decideDraft as never);
    expect(shown.value.drafts.map((draft) => draft.id)).not.toContain(draftId);
    expect(shown.value.counts.approve).toBe(inbox.counts.approve - 1);
    expect(harness.sends.map((send) => send.method)).toEqual(["decideDraft"]);
  });

  it("sends the decision note as given and keeps the item's comments in view", () => {
    const harness = controlled();
    const shown = latest<MissionInboxSnapshot>((listener) =>
      harness.source.subscribeInbox(null, listener),
    );
    const comments = [{ id: "c-1", body: "Earlier thought", at: FIXTURE_NOW }];
    harness.pushInbox({
      ...inbox,
      marks: [
        {
          id: `draft:${draftId}`,
          missionId: null,
          subject: { kind: "draft", id: draftId },
          comments,
          snooze: null,
          updatedAt: FIXTURE_NOW,
        },
      ],
    });
    const noted = { ...decideDraft, note: "Post after lunch" };
    void harness.source.decideDraft(noted as never);
    expect(harness.sends[0]?.input).toEqual(noted);
    expect(shown.value.drafts.map((draft) => draft.id)).not.toContain(draftId);
    expect(commentsOf(shown.value, `draft:${draftId}`)).toEqual(comments);
  });

  it("keeps the item hidden when a stale snapshot lands before the send finishes", async () => {
    const harness = controlled();
    const shown = latest<MissionInboxSnapshot>((listener) =>
      harness.source.subscribeInbox(null, listener),
    );
    harness.pushInbox(inbox);
    const sent = harness.source.decideDraft(decideDraft as never);
    harness.pushInbox({ ...inbox, revision: inbox.revision + 1 });
    expect(shown.value.drafts.map((draft) => draft.id)).not.toContain(draftId);
    harness.sends[0]!.resolve();
    await sent;
    harness.pushInbox({ ...inbox, revision: inbox.revision + 2 });
    expect(shown.value.drafts.map((draft) => draft.id)).not.toContain(draftId);
  });

  it("trusts the server once the grace ends", async () => {
    const harness = controlled();
    const shown = latest<MissionInboxSnapshot>((listener) =>
      harness.source.subscribeInbox(null, listener),
    );
    harness.pushInbox(inbox);
    const sent = harness.source.decideDraft(decideDraft as never);
    harness.sends[0]!.resolve();
    await sent;
    harness.endGrace();
    expect(shown.value).toBe(inbox);
  });

  it("brings the item back and rethrows when the send fails", async () => {
    const harness = controlled();
    const shown = latest<MissionInboxSnapshot>((listener) =>
      harness.source.subscribeInbox(null, listener),
    );
    harness.pushInbox(inbox);
    const sent = harness.source.decideDraft(decideDraft as never);
    const failure = new Error("offline");
    harness.sends[0]!.reject(failure);
    await expect(sent).rejects.toBe(failure);
    expect(shown.value).toBe(inbox);
  });

  it("ignores a second decision on an item still being sent", async () => {
    const harness = controlled();
    harness.source.subscribeInbox(null, () => {});
    harness.pushInbox(inbox);
    void harness.source.decideDraft(decideDraft as never);
    await harness.source.decideDraft({ draftId, action: "drop" } as never);
    expect(harness.sends).toHaveLength(1);
  });

  it("sends every decision on different items and shows the counts that are left", async () => {
    const harness = controlled();
    const shown = latest<MissionInboxSnapshot>((listener) =>
      harness.source.subscribeInbox(null, listener),
    );
    harness.pushInbox(inbox);
    const approvals = inbox.approvals.map((approval) =>
      harness.source.decideApproval({ approvalId: approval.id, action: "approve" } as never),
    );
    const notes = inbox.fyi.map((note) => harness.source.ackNote({ noteId: note.id } as never));
    expect(harness.sends).toHaveLength(inbox.approvals.length + inbox.fyi.length);
    expect(shown.value.approvals).toEqual([]);
    expect(shown.value.fyi).toEqual([]);
    expect(inboxTabCounts(shown.value, "owner", NOW)).toMatchObject({ approve: 1, fyi: 0 });
    expect(inboxTabCounts(shown.value, "master", NOW).approve).toBe(1);

    harness.sends[0]!.reject(new Error("nope"));
    await expect(approvals[0]).rejects.toThrow("nope");
    expect(shown.value.approvals.map((approval) => approval.id)).toEqual([inbox.approvals[0]!.id]);
    for (const send of harness.sends.slice(1)) send.resolve();
    await Promise.all([...approvals.slice(1), ...notes]);
    await flush();
    expect(shown.value.fyi).toEqual([]);
  });

  it("settles a request in the list and the thread at once", async () => {
    const harness = controlled();
    const open = request({ id: "r1", status: "waiting" });
    const other = request({ id: "r2" });
    const list = latest<ReadonlyArray<OwnerRequest>>((listener) =>
      harness.source.subscribeRequests(CRPKO, listener),
    );
    const thread = latest<OwnerRequest | null>((listener) =>
      harness.source.subscribeRequest({ missionId: CRPKO, requestId: "r1" }, listener),
    );
    harness.pushRequests([open, other]);
    harness.pushThread(open);
    const sent = harness.source.settleRequest({ requestId: "r1", note: "thanks" });
    expect(list.value[0]).toMatchObject({ id: "r1", status: "settled" });
    expect(list.value[1]).toBe(other);
    expect(thread.value).toMatchObject({ status: "settled" });

    harness.sends[0]!.reject(new Error("offline"));
    await expect(sent).rejects.toThrow("offline");
    expect(list.value[0]).toBe(open);
    expect(thread.value).toBe(open);
  });

  it("reopens a settled request after its settle went through", async () => {
    const harness = controlled();
    const list = latest<ReadonlyArray<OwnerRequest>>((listener) =>
      harness.source.subscribeRequests(CRPKO, listener),
    );
    harness.pushRequests([request({ id: "r1", status: "waiting" })]);
    const settle = harness.source.settleRequest({ requestId: "r1" });
    harness.sends[0]!.resolve();
    await settle;
    void harness.source.reopenRequest({ requestId: "r1" });
    expect(harness.sends.map((send) => send.method)).toEqual(["settleRequest", "reopenRequest"]);
    expect(list.value[0]?.status).toBe("waiting");
  });

  it("does not re-emit when nothing changed", () => {
    const harness = controlled();
    const list = latest<ReadonlyArray<OwnerRequest>>((listener) =>
      harness.source.subscribeRequests(CRPKO, listener),
    );
    const requests = [request({ id: "r1" })];
    harness.pushRequests(requests);
    void harness.source.decideKnock({ knockId: "k", action: "drop" } as never);
    expect(list.seen).toEqual([requests]);
  });
});
