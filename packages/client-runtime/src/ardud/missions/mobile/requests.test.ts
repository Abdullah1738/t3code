import type { MissionId, MissionRecordRef } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { createFixtureMissionsSource, FIXTURE_NOW } from "../fixture/index.ts";
import type { OwnerRequest, OwnerRequestMessage } from "../source.ts";
import { discussionOn, requestFigures, unreadMasterMessages } from "./requests.ts";

const CRPKO = "crpko-engineering" as MissionId;
const AT = "2026-10-19T08:00:00.000Z";
const ASK: MissionRecordRef = { kind: "ask", id: "ask-1" };

function message(author: OwnerRequestMessage["author"], id: string): OwnerRequestMessage {
  return { id, author, text: `${author} ${id}`, at: AT, refs: [] };
}

function request(
  id: string,
  patch: Partial<OwnerRequest> & Pick<OwnerRequest, "status" | "unread">,
): OwnerRequest {
  return {
    id,
    missionId: CRPKO,
    title: id,
    messages: [message("owner", `${id}-1`)],
    hasOlder: false,
    links: [],
    subject: null,
    createdAt: AT,
    updatedAt: AT,
    settledAt: null,
    ...patch,
  };
}

describe("discussion on an item", () => {
  it("counts the master's messages since the owner's last word", () => {
    const thread = request("d", {
      status: "answered",
      unread: true,
      subject: ASK,
      messages: [message("owner", "1"), message("master", "2"), message("master", "3")],
    });
    expect(discussionOn([thread], ASK)).toEqual({ request: thread, unread: 2 });
    expect(discussionOn([thread], { kind: "ask", id: "other" })).toEqual({
      request: null,
      unread: 0,
    });
  });

  it("reads zero once the owner has read it or it is settled", () => {
    const read = request("d", {
      status: "answered",
      unread: false,
      subject: ASK,
      messages: [message("owner", "1"), message("master", "2")],
    });
    expect(unreadMasterMessages(read)).toBe(0);
    expect(unreadMasterMessages({ ...read, unread: true, status: "settled" })).toBe(0);
  });
});

describe("Your requests figure", () => {
  it("never counts a discussion on an item", () => {
    const figures = requestFigures([
      request("own-answered", { status: "answered", unread: true }),
      request("own-waiting", { status: "waiting", unread: false }),
      request("discussion", { status: "answered", unread: true, subject: ASK }),
      request("discussion-waiting", { status: "waiting", unread: false, subject: ASK }),
    ]);
    expect(figures).toEqual({ answered: 1, waiting: 1 });
  });

  it("reads the fixture through the shared source", async () => {
    const source = createFixtureMissionsSource({ now: () => Date.parse(FIXTURE_NOW) });
    const requests = await new Promise<ReadonlyArray<OwnerRequest>>((resolve) => {
      const close = source.subscribeRequests(CRPKO, (value) => {
        resolve(value);
        queueMicrotask(close);
      });
    });
    const figures = requestFigures(requests);
    expect(figures.answered + figures.waiting).toBeGreaterThan(0);
  });
});
