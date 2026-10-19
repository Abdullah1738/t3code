import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { parsePollChangeEvent } from "@photon-ai/advanced-imessage/grpc";
import { ingest } from "../src/ingress.ts";
import { Store, type PollRecord } from "../src/store.ts";

const owner = "+15555550123";
const cutoff = Date.parse("2026-09-10T10:00:00Z");
const now = cutoff + 60_000;
const stores: Store[] = [];
const record: PollRecord = { operationId: "poll:abc", title: "Lunch?", sessionId: "ses", generation: 2, createdAt: cutoff,
  options: [{ optionIdentifier: "o-1", text: "Pizza" }, { optionIdentifier: "o-2", text: "Sushi" }] };
afterEach(() => { setSystemTime(); for (const store of stores.splice(0)) store.close(); });

function setup(register = true) {
  setSystemTime(now);
  const store = new Store(":memory:");
  store.set("bootstrapCutoff", cutoff);
  if (register) store.set("poll:poll-guid", record);
  stores.push(store);
  return store;
}

function vote(sequence: number, extra: Record<string, unknown> = {}, delta: Record<string, unknown> = { voted: { optionIdentifier: "o-2" } }) {
  const event = parsePollChangeEvent({
    chatGuid: `any;-;${owner}`, pollMessageGuid: "poll-guid", occurredAt: new Date(cutoff + 1_000).toISOString(), isFromMe: false,
    actor: { address: owner, service: "CHAT_SERVICE_TYPE_IMESSAGE" }, ...delta, ...extra,
  }, sequence);
  if (!event) throw new Error("Invalid poll fixture");
  return event;
}

describe("poll vote ingress", () => {
  test("owner votes on a registered poll become inbound rows with a stable id", () => {
    const store = setup();
    expect(ingest(store, vote(5), owner, true)).toBe(true);
    expect(ingest(store, vote(6, {}, { unvoted: { optionIdentifier: "o-2" } }), owner, true)).toBe(true);
    expect(store.pendingInbound()).toEqual([
      { id: "poll-vote:poll-guid:5", state: "pending", payload: {
        id: "poll-vote:poll-guid:5", text: 'Voted for "Sushi" in the poll "Lunch?"', attachments: [], isAudioMessage: false,
        poll: { guid: "poll-guid", optionIdentifier: "o-2", optionText: "Sushi", vote: "voted", operationId: "poll:abc" },
        source: "composed", receivedAt: now } },
      { id: "poll-vote:poll-guid:6", state: "pending", payload: {
        id: "poll-vote:poll-guid:6", text: 'Removed vote for "Sushi" in the poll "Lunch?"', attachments: [], isAudioMessage: false,
        poll: { guid: "poll-guid", optionIdentifier: "o-2", optionText: "Sushi", vote: "unvoted", operationId: "poll:abc" },
        source: "composed", receivedAt: now } },
    ]);
    expect(store.get<unknown>("photonCursor")).toBe(6);
    expect(store.get<unknown>("chatGuid")).toBe(`any;-;${owner}`);
    expect(store.get<unknown>("paired")).toBe(true);
    // A replay of an older cursor never duplicates the row.
    expect(ingest(store, vote(5), owner, true)).toBe(false);
  });

  test.each([
    ["unregistered poll", { pollMessageGuid: "other-guid" }, undefined],
    ["own vote", { isFromMe: true }, undefined],
    ["another actor", { actor: { address: "+15555550999", service: "CHAT_SERVICE_TYPE_IMESSAGE" } }, undefined],
    ["another chat", { chatGuid: "any;-;+15555550999" }, undefined],
    ["group chat", { chatGuid: `any;+;chat123` }, undefined],
    ["unknown option", {}, { voted: { optionIdentifier: "o-9" } }],
    ["created delta", {}, { created: { title: "Lunch?", options: [] } }],
    ["optionAdded delta", {}, { optionAdded: { title: "Lunch?", options: [] } }],
  ] as [string, Record<string, unknown>, Record<string, unknown> | undefined][])("ignores %s but still advances the cursor", (_label, extra, delta) => {
    const store = setup();
    expect(ingest(store, vote(7, extra, delta), owner, true)).toBe(false);
    expect(store.pendingInbound()).toEqual([]);
    expect(store.get<unknown>("photonCursor")).toBe(7);
  });

  test("absent actor is accepted when the chat and direction match", () => {
    const store = setup();
    expect(ingest(store, vote(3, { actor: undefined }), owner, true)).toBe(true);
  });

  test("disabled bridges never queue votes", () => {
    const store = setup();
    expect(ingest(store, vote(3), owner, false)).toBe(false);
    expect(store.pendingInbound()).toEqual([]);
    expect(store.get<unknown>("paired")).toBeUndefined();
    expect(store.get<unknown>("photonCursor")).toBe(3);
  });

  test("historical votes before the bootstrap cutoff are dropped; post-bootstrap ones are kept", () => {
    const store = setup();
    expect(ingest(store, vote(1, { occurredAt: new Date(cutoff - 1_000).toISOString() }), owner, true)).toBe(false);
    expect(ingest(store, vote(2), owner, true)).toBe(true);
    ingest(store, { type: "catchup.complete", headSequence: 2 }, owner, true);
    expect(ingest(store, vote(3, { occurredAt: new Date(cutoff - 5_000).toISOString() }), owner, true)).toBe(true);
    expect(store.pendingInbound().map(row => row.id)).toEqual(["poll-vote:poll-guid:2", "poll-vote:poll-guid:3"]);
  });

  test("a historical vote without a usable timestamp is not classified", () => {
    const store = setup();
    const event = { ...vote(4), occurredAt: new Date(NaN) };
    expect(() => ingest(store, event, owner, true)).toThrow("Cannot classify historical event time");
    expect(store.get<unknown>("photonCursor")).toBeUndefined();
  });
});

describe("polls resent as duplicates", () => {
  const created = (sequence: number, guid = "dup-guid", texts = ["Sushi", "Pizza"]) => vote(sequence,
    { pollMessageGuid: guid, isFromMe: true }, { created: { title: "", options: texts.map((text, n) => ({ optionIdentifier: `d-${n}`, text })) } });
  const unmatched = { operationId: "request:1:question:x", title: "Lunch?", choices: ["Pizza", "Sushi"], sessionId: "ses", generation: 2, createdAt: now };

  test("a duplicate send is registered once our own creation event arrives, and votes count", async () => {
    const { rememberUnmatchedPoll } = await import("../src/poll-match.ts");
    const store = setup(false);
    rememberUnmatchedPoll(store, unmatched);
    expect(ingest(store, created(4), owner, true)).toBe(false);
    expect(store.get<PollRecord>("poll:dup-guid")).toEqual({ operationId: unmatched.operationId, title: "Lunch?", sessionId: "ses", generation: 2,
      createdAt: now, options: [{ optionIdentifier: "d-0", text: "Sushi" }, { optionIdentifier: "d-1", text: "Pizza" }] });
    expect(ingest(store, vote(5, { pollMessageGuid: "dup-guid" }, { voted: { optionIdentifier: "d-1" } }), owner, true)).toBe(true);
    expect(store.pendingInbound()[0]?.payload).toMatchObject({ poll: { optionText: "Pizza", operationId: unmatched.operationId } });
    expect(store.get("poll-unmatched:request:1:question:x")).toBeUndefined();
  });

  test("the creation event may arrive before the duplicate result", async () => {
    const { rememberUnmatchedPoll } = await import("../src/poll-match.ts");
    const store = setup(false);
    ingest(store, created(4), owner, true);
    rememberUnmatchedPoll(store, unmatched);
    expect(store.get<PollRecord>("poll:dup-guid")?.operationId).toBe(unmatched.operationId);
    expect(store.get("poll-seen:dup-guid")).toBeUndefined();
  });

  test("different options, other people's polls and stale entries never pair", async () => {
    const { rememberUnmatchedPoll } = await import("../src/poll-match.ts");
    const store = setup(false);
    rememberUnmatchedPoll(store, unmatched);
    ingest(store, created(4, "other-guid", ["Pizza", "Tacos"]), owner, true);
    ingest(store, vote(5, { pollMessageGuid: "theirs", isFromMe: false }, { created: { title: "", options: [{ optionIdentifier: "t-1", text: "Pizza" }, { optionIdentifier: "t-2", text: "Sushi" }] } }), owner, true);
    expect(store.get("poll:other-guid")).toBeUndefined();
    expect(store.get("poll:theirs")).toBeUndefined();
    setSystemTime(now + 11 * 60_000);
    ingest(store, created(6), owner, true);
    expect(store.get("poll:dup-guid")).toBeUndefined();
  });

  test("a poll already registered by its GUID is left alone", () => {
    const store = setup(true);
    ingest(store, created(4, "poll-guid"), owner, true);
    expect(store.get<PollRecord>("poll:poll-guid")).toEqual(record);
  });

  test("a leftover seen row of a registered poll never swallows the next duplicate", async () => {
    const { rememberUnmatchedPoll } = await import("../src/poll-match.ts");
    const store = setup(false);
    ingest(store, created(4, "normal-guid"), owner, true);
    store.set("poll:normal-guid", { ...record, operationId: "normal-op" });
    rememberUnmatchedPoll(store, unmatched);
    expect(store.get("poll-seen:normal-guid")).toBeUndefined();
    ingest(store, created(5, "dup-guid"), owner, true);
    expect(store.get<PollRecord>("poll:dup-guid")?.operationId).toBe(unmatched.operationId);
    expect(store.get<PollRecord>("poll:normal-guid")?.operationId).toBe("normal-op");
  });

  test("two same-option polls in flight are never guessed at", async () => {
    const { rememberUnmatchedPoll } = await import("../src/poll-match.ts");
    const store = setup(false);
    rememberUnmatchedPoll(store, unmatched);
    rememberUnmatchedPoll(store, { ...unmatched, operationId: "request:1:question:y" });
    ingest(store, created(4, "first-guid"), owner, true);
    expect(store.get("poll:first-guid")).toBeUndefined();
    const other = setup(false);
    ingest(other, created(4, "a-guid"), owner, true);
    ingest(other, created(5, "b-guid"), owner, true);
    rememberUnmatchedPoll(other, unmatched);
    expect(other.get("poll:a-guid")).toBeUndefined();
    expect(other.get("poll:b-guid")).toBeUndefined();
  });
});
