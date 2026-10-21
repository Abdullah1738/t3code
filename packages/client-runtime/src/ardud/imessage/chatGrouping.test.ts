import { describe, expect, it } from "vitest";

import { groupIMessageThreads, imessageChatOfPath, OWNER_CHAT_SLUG } from "./chatGrouping";

const ROOT = "/Users/ardud/.robob/imessage";

describe("imessageChatOfPath", () => {
  it("maps owner threads under the date folder to the owner chat", () => {
    expect(imessageChatOfPath(`${ROOT}/2026-10-20/session-abc`)).toEqual({
      slug: OWNER_CHAT_SLUG,
      date: "2026-10-20",
    });
  });

  it("maps other chats under chats/<slug>/<date>", () => {
    expect(imessageChatOfPath(`${ROOT}/chats/moni/2026-10-21/session-x`)).toEqual({
      slug: "moni",
      date: "2026-10-21",
    });
    expect(imessageChatOfPath(`${ROOT}/chats/group-family-a1b2c3/2026-10-21`)).toEqual({
      slug: "group-family-a1b2c3",
      date: "2026-10-21",
    });
  });

  it("ignores paths outside the iMessage workspace and malformed chat paths", () => {
    expect(imessageChatOfPath("/Users/ardud/code/app")).toBeNull();
    expect(imessageChatOfPath(null)).toBeNull();
    expect(imessageChatOfPath(`${ROOT}/chats/moni`)).toBeNull();
    expect(imessageChatOfPath(`${ROOT}/notes`)).toBeNull();
  });
});

describe("groupIMessageThreads", () => {
  const thread = (id: string, path: string, updatedAt: string, running = false) => ({
    id,
    path,
    title: id,
    updatedAt,
    running,
  });

  it("groups threads per chat with the latest activity and running flag", () => {
    const groups = groupIMessageThreads([
      thread("owner-old", `${ROOT}/2026-10-19/session-1`, "2026-10-19T10:00:00Z"),
      thread("owner-new", `${ROOT}/2026-10-20/session-2`, "2026-10-20T09:00:00Z", true),
      thread("moni", `${ROOT}/chats/moni/2026-10-21/session-3`, "2026-10-21T08:00:00Z"),
      thread("code", "/Users/ardud/code/app", "2026-10-22T08:00:00Z"),
    ]);

    expect(groups).toEqual([
      {
        slug: "moni",
        threadIds: ["moni"],
        latestThreadId: "moni",
        latestActivityAt: "2026-10-21T08:00:00Z",
        running: false,
      },
      {
        slug: OWNER_CHAT_SLUG,
        threadIds: ["owner-new", "owner-old"],
        latestThreadId: "owner-new",
        latestActivityAt: "2026-10-20T09:00:00Z",
        running: true,
      },
    ]);
  });

  it("returns an empty list when there are no iMessage threads", () => {
    expect(groupIMessageThreads([thread("x", "/tmp/x", "2026-10-20T00:00:00Z")])).toEqual([]);
  });
});
