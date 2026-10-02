import { afterEach, describe, expect, test } from "bun:test";
import { parseMessageChangeEvent } from "@photon-ai/advanced-imessage/grpc";
import { ingest } from "../src/ingress.ts";
import { Store } from "../src/store.ts";

const owner = "+15555550123";
const cutoff = Date.parse("2026-09-10T10:00:00Z");
const stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
function setup() { const s = new Store(":memory:"); s.set("bootstrapCutoff", cutoff); stores.push(s); return s; }
function event(sequence: number, at: number, sender = owner, prefix = "any") {
  return parseMessageChangeEvent({
    chatGuid: `${prefix};-;${sender}`, occurredAt: new Date(at).toISOString(), isFromMe: false,
    actor: { address: sender, service: "CHAT_SERVICE_TYPE_IMESSAGE" },
    messageReceived: { message: { guid: `message-${sequence}`, dateCreated: new Date(at).toISOString(),
      isFromMe: false, itemType: "MESSAGE_ITEM_TYPE_NORMAL", chatGuids: [`${prefix};-;${sender}`],
      sender: { address: sender, service: "CHAT_SERVICE_TYPE_IMESSAGE" }, content: { text: "hello", attachments: [] } } },
  }, sequence)!;
}
describe("durable ingress", () => {
  test("ignores pre-start history but never loses post-start input during bootstrap retry", () => {
    const store = setup();
    expect(ingest(store, event(1, cutoff - 1000), owner, true)).toBe(false);
    // Simulate catch-up failure before complete, followed by a replay.
    expect(ingest(store, event(1, cutoff - 1000), owner, true)).toBe(false);
    expect(ingest(store, event(2, cutoff + 1000), owner, true)).toBe(true);
    expect(store.pendingInbound()).toHaveLength(1);
    expect(store.get<number>("photonCursor")).toBe(2);
    ingest(store, { type: "catchup.complete", headSequence: 2 }, owner, true);
    expect(store.get<boolean>("bootstrapped")).toBe(true);
  });
  test("canonicalizes aliases while preserving exact owner auth", () => {
    const store = setup();
    expect(ingest(store, event(1, cutoff, owner, "iMessage"), owner, true)).toBe(true);
    expect(ingest(store, event(2, cutoff, owner, "any"), owner, true)).toBe(true);
    expect(store.get<string>("chatGuid")).toBe(`any;-;${owner}`);
    expect(ingest(store, event(3, cutoff, "+15555550999"), owner, true)).toBe(false);
    expect(store.pendingInbound()).toHaveLength(2);
  });
  test("disabled receiver never pairs or queues tool execution", () => {
    const store = setup();
    expect(ingest(store, event(1, cutoff), owner, false)).toBe(false);
    expect(store.get("paired")).toBeUndefined();
    expect(store.pendingInbound()).toHaveLength(0);
  });
  test("completed bootstrap accepts delayed timestamps and cursor never regresses", () => {
    const store = setup();
    ingest(store, { type: "catchup.complete", headSequence: 10 }, owner, true);
    expect(ingest(store, event(11, cutoff - 1000), owner, true)).toBe(true);
    ingest(store, { type: "catchup.complete", headSequence: 9 }, owner, true);
    expect(store.get<number>("photonCursor")).toBe(11);
  });
  test("chunk provider aliases resolve before the full operation finishes", () => {
    const store = setup();
    store.enqueue({ id: "notification", kind: "notification", text: "hello" });
    store.set("provider-operation:second-chunk", "notification");
    expect(store.byProviderId("second-chunk")?.id).toBe("notification");
  });
});
