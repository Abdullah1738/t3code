import type { MissionId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { createFixtureMissionsSource, FIXTURE_NOW } from "./fixture/index.ts";
import {
  discussionUnread,
  discussRequestInput,
  groupRequests,
  isDiscussion,
  isRequestUnread,
  looseDiscussions,
  openRequestInput,
  ownerConditionOf,
  requestAbout,
  requestPreview,
  requestTitle,
  yourRequests,
} from "./requestsViewModel.ts";
import type { MissionsSource, OwnerRequest } from "./source.ts";

const CRPKO = "crpko-engineering" as MissionId;
const now = () => Date.parse(FIXTURE_NOW) + 60_000;

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

function latest(source: MissionsSource) {
  let value: ReadonlyArray<OwnerRequest> = [];
  source.subscribeRequests(CRPKO, (next) => {
    value = next;
  });
  return () => value;
}

describe("owner requests", () => {
  it("titles a request by its first line and refuses an empty one", () => {
    expect(requestTitle("  Park the e2e lane\nIt has been idle all week")).toBe(
      "Park the e2e lane",
    );
    expect(requestTitle("x".repeat(90))).toHaveLength(80);
    expect(openRequestInput(CRPKO, "   ").ok).toBe(false);
  });

  it("groups answered unread first and keeps settled apart", () => {
    const source = createFixtureMissionsSource({ now });
    const read = latest(source);
    const { open, settled } = groupRequests(read());
    expect(open.map((r) => r.id)).toEqual([
      "request-dev-cost",
      "request-risk-round",
      "request-dylan-rebase",
    ]);
    expect(settled.map((r) => r.id)).toEqual(["request-codex-topups"]);
    expect(
      read()
        .filter(isRequestUnread)
        .map((r) => r.id),
    ).toEqual(["request-dev-cost"]);
    expect(requestPreview(open[0]!)).toMatch(/^Parked two idle lanes/);
  });

  it("opens, reads, replies, settles and reopens", async () => {
    const source = createFixtureMissionsSource({ now });
    const read = latest(source);
    await source.markRequestRead({ requestId: "request-dev-cost" });
    expect(read().filter(isRequestUnread)).toEqual([]);

    const created = await source.openRequest({ missionId: CRPKO, text: "Park the e2e lane" });
    expect(read().find((r) => r.id === created.id)).toMatchObject({
      status: "waiting",
      title: "Park the e2e lane",
    });

    await source.replyRequest({ requestId: "request-dev-cost", text: "Yes to the resize." });
    const replied = read().find((r) => r.id === "request-dev-cost")!;
    expect(replied.status).toBe("waiting");
    expect(replied.messages.at(-1)).toMatchObject({ author: "owner", text: "Yes to the resize." });

    await source.settleRequest({ requestId: "request-risk-round" });
    await expect(
      source.replyRequest({ requestId: "request-risk-round", text: "more" }),
    ).rejects.toMatchObject({ code: "invalid" });
    await source.reopenRequest({ requestId: "request-risk-round" });
    const reopened = read().find((r) => r.id === "request-risk-round")!;
    expect(reopened.status).toBe("answered");
    expect(isRequestUnread(reopened)).toBe(false);

    // Closing words land in the conversation; reopening with words waits on the master.
    await source.settleRequest({ requestId: created.id, note: " Done, thanks " });
    const closed = read().find((r) => r.id === created.id)!;
    expect(closed.status).toBe("settled");
    expect(closed.messages.at(-1)).toMatchObject({ author: "owner", text: "Done, thanks" });
    await source.reopenRequest({ requestId: created.id, note: "Actually, wait" });
    const back = read().find((r) => r.id === created.id)!;
    expect(back.status).toBe("waiting");
    expect(back.messages.at(-1)).toMatchObject({ author: "owner", text: "Actually, wait" });
  });

  it("keeps one open request per discussed record", async () => {
    const source = createFixtureMissionsSource({ now });
    const read = latest(source);
    const subject = { kind: "ask" as const, id: "ask-kafka-capacity-r004", label: "Kafka" };
    const first = await source.openRequest({ missionId: CRPKO, text: "Why 3 brokers?", subject });
    const again = await source.openRequest({ missionId: CRPKO, text: "And the cost?", subject });
    expect(again.id).toBe(first.id);
    expect(
      read()
        .find((r) => r.id === first.id)
        ?.messages.map((m) => m.text),
    ).toEqual(["Why 3 brokers?", "And the cost?"]);
    await source.settleRequest({ requestId: first.id });
    const fresh = await source.openRequest({ missionId: CRPKO, text: "Back again", subject });
    expect(fresh.id).not.toBe(first.id);
  });

  it("keeps discussions out of Your requests and its unread count", () => {
    const own = request({ id: "own", subject: null, unread: true });
    const talk = request({
      id: "talk",
      subject: { kind: "draft", id: "draft-1", label: "Release note" },
      unread: true,
    });
    expect(isDiscussion(talk)).toBe(true);
    expect(yourRequests([own, talk]).map((r) => r.id)).toEqual(["own"]);
    expect(yourRequests([own, talk]).filter(isRequestUnread)).toHaveLength(1);
  });

  it("counts a discussion's unread master replies for its record's symbol", () => {
    const message = (id: string, author: "owner" | "master") => ({
      id,
      author,
      text: id,
      at: FIXTURE_NOW,
      refs: [],
    });
    const subject = { kind: "draft" as const, id: "draft-1", label: "Release note" };
    const talk = request({
      id: "talk",
      subject,
      unread: true,
      messages: [
        message("a", "master"),
        message("b", "owner"),
        message("c", "master"),
        message("d", "master"),
      ],
    });
    expect(discussionUnread(talk)).toBe(2);
    expect(discussionUnread({ ...talk, unread: false })).toBe(0);
    expect(discussionUnread({ ...talk, status: "settled" })).toBe(0);
    expect(discussionUnread({ ...talk, messages: [message("b", "owner")] })).toBe(1);
    expect(discussionUnread(null)).toBe(0);
  });

  it("finds the open request about a record and reads a decision made on a condition", async () => {
    const source = createFixtureMissionsSource({ now });
    const read = latest(source);
    const subject = { kind: "draft" as const, id: "draft-1", label: "Reply to Dylan" };
    expect(discussRequestInput(CRPKO, subject, "  ").ok).toBe(false);
    const built = discussRequestInput(CRPKO, subject, " Softer opening? ");
    expect(built).toEqual({
      ok: true,
      value: { missionId: CRPKO, text: "Softer opening?", subject },
    });
    expect(requestAbout(read(), subject)).toBeNull();
    const opened = await source.openRequest(built.ok ? built.value : (null as never));
    expect(requestAbout(read(), { kind: "draft", id: "draft-1" })?.id).toBe(opened.id);
    expect(requestAbout(read(), { kind: "ask", id: "draft-1" })).toBeNull();
    await source.settleRequest({ requestId: opened.id });
    expect(requestAbout(read(), subject)).toBeNull();

    const condition = { requestId: opened.id as never, quote: "fine if it ships after 18:00" };
    expect(ownerConditionOf({ onOwnerCondition: condition })).toBe(condition);
    expect(ownerConditionOf({})).toBeNull();
    expect(ownerConditionOf({ onOwnerCondition: null })).toBeNull();
  });

  it("keeps an open discussion surfaced when its record has no card on screen", () => {
    // Shapes of the two live discussions from 20 Oct: one on a note the owner
    // acked, one on a note that aged out of Since you last looked.
    const acked = request({
      id: "request-d613679c",
      subject: { kind: "note", id: "note-169d4966336968db", label: "Codex review spend…" },
      unread: true,
      updatedAt: "2026-10-20T22:28:59.149Z",
    });
    const agedOut = request({
      id: "request-d505b6a1",
      subject: { kind: "note", id: "note-283a7b04c68aa286", label: "Claude budget forecast…" },
      updatedAt: "2026-10-20T22:49:24.937Z",
    });
    const settled = request({
      id: "settled-talk",
      status: "settled",
      unread: true,
      subject: { kind: "ask", id: "ask-1", label: "Old ask" },
    });
    const own = request({ id: "own-ask", status: "waiting" });
    const requests = [own, settled, agedOut, acked];

    expect(looseDiscussions(requests, []).map((item) => item.id)).toEqual([
      "request-d613679c",
      "request-d505b6a1",
    ]);
    expect(
      looseDiscussions(requests, [{ kind: "note", id: "note-283a7b04c68aa286" }]).map(
        (item) => item.id,
      ),
    ).toEqual(["request-d613679c"]);
    expect(
      looseDiscussions(requests, [{ kind: "ask", id: "note-169d4966336968db" }]).map(
        (item) => item.id,
      ),
    ).toEqual(["request-d613679c", "request-d505b6a1"]);
    expect(looseDiscussions([{ ...acked, status: "settled" }], [])).toEqual([]);
  });
});
