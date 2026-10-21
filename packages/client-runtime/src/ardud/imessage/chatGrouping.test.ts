import { describe, expect, it } from "vite-plus/test";

import {
  groupIMessageThreads,
  imessageChatOfPath,
  OWNER_CHAT_SLUG,
  sortIMessageChats,
  sortIMessageThreadsByCreation,
} from "./chatGrouping.ts";

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
  const thread = (
    id: string,
    path: string,
    createdAt: string,
    updatedAt: string,
    options: { running?: boolean; child?: boolean } = {},
  ) => ({
    id,
    path,
    title: id,
    createdAt,
    updatedAt,
    running: options.running ?? false,
    child: options.child ?? false,
  });

  it("groups threads per chat in creation order with the latest activity and running flag", () => {
    const groups = groupIMessageThreads([
      // The older session was touched last; creation order still decides the transcript.
      thread(
        "owner-old",
        `${ROOT}/2026-10-19/session-1`,
        "2026-10-19T06:00:00Z",
        "2026-10-20T11:00:00Z",
      ),
      thread(
        "owner-new",
        `${ROOT}/2026-10-20/session-2`,
        "2026-10-20T06:00:00Z",
        "2026-10-20T09:00:00Z",
        { running: true },
      ),
      thread(
        "moni",
        `${ROOT}/chats/moni/2026-10-21/session-3`,
        "2026-10-21T07:00:00Z",
        "2026-10-21T08:00:00Z",
      ),
      thread("code", "/Users/ardud/code/app", "2026-10-22T08:00:00Z", "2026-10-22T08:00:00Z"),
    ]);

    expect(groups).toEqual([
      {
        slug: "moni",
        threadIds: ["moni"],
        latestThreadId: "moni",
        latestTitle: "moni",
        latestActivityAt: "2026-10-21T08:00:00Z",
        running: false,
      },
      {
        slug: OWNER_CHAT_SLUG,
        threadIds: ["owner-old", "owner-new"],
        latestThreadId: "owner-new",
        latestTitle: "owner-new",
        latestActivityAt: "2026-10-20T11:00:00Z",
        running: true,
      },
    ]);
  });

  it("leaves subagent threads that share a chat folder out of the chat", () => {
    const groups = groupIMessageThreads([
      thread(
        "root",
        `${ROOT}/2026-10-21/session-1`,
        "2026-10-21T06:00:00Z",
        "2026-10-21T06:30:00Z",
      ),
      thread(
        "subagent",
        `${ROOT}/2026-10-21/session-1`,
        "2026-10-21T07:00:00Z",
        "2026-10-21T09:00:00Z",
        { running: true, child: true },
      ),
    ]);

    expect(groups).toEqual([
      {
        slug: OWNER_CHAT_SLUG,
        threadIds: ["root"],
        latestThreadId: "root",
        latestTitle: "root",
        latestActivityAt: "2026-10-21T06:30:00Z",
        running: false,
      },
    ]);
  });

  it("returns an empty list when there are no iMessage threads", () => {
    expect(
      groupIMessageThreads([thread("x", "/tmp/x", "2026-10-20T00:00:00Z", "2026-10-20T00:00:00Z")]),
    ).toEqual([]);
  });
});

describe("sortIMessageThreadsByCreation", () => {
  it("orders oldest first regardless of input order", () => {
    const sorted = sortIMessageThreadsByCreation([
      { id: "b", createdAt: "2026-10-21T06:00:00Z" },
      { id: "a", createdAt: "2026-10-20T06:00:00Z" },
      { id: "c", createdAt: "2026-10-22T06:00:00Z" },
    ]);
    expect(sorted.map((thread) => thread.id)).toEqual(["a", "b", "c"]);
  });
});

describe("sortIMessageChats", () => {
  it("lists the owner first, then people, then groups", () => {
    const chats = [{ slug: "group-family-a1b2c3" }, { slug: "moni" }, { slug: OWNER_CHAT_SLUG }];
    expect(sortIMessageChats(chats).map((chat) => chat.slug)).toEqual([
      OWNER_CHAT_SLUG,
      "moni",
      "group-family-a1b2c3",
    ]);
  });
});
