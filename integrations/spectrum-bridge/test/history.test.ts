import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chatHistory } from "../src/history.ts";
import { Store, type OutboxOperation } from "../src/store.ts";

const opened: { store: Store; dir: string }[] = [];
afterEach(() => {
  for (const { store, dir } of opened.splice(0)) { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
const names = (address: string) => ({ owner: "Abdullah", moni: "Moni" })[address] ?? "Someone";
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "sb-history-"));
  const store = new Store(join(dir, "store.sqlite"));
  opened.push({ store, dir });
  const person = (id: string, at: number, extra: Record<string, unknown> = {}) =>
    store.acceptInbound(id, { text: id, sender: "owner", sentAt: at, ...extra });
  const sent = (id: string, at: unknown, extra: Partial<OutboxOperation> = {}) => {
    store.enqueue({ id, text: id, kind: "conversation", ...extra });
    store.outboxState(id, "sent", `handle-${id}`); store.set(`sent-at:${id}`, at);
  };
  const history = (query: Parameters<typeof chatHistory>[3], ownerChat = false) => chatHistory(store, names, "owner", query, ownerChat);
  return { store, person, sent, history };
}

test("interleaves people and sent Robob messages, strips hidden text, and writes nothing", () => {
  const { store, person, sent, history } = setup();
  person("a", 1000); sent("b", 2000, { text: "<think>private</think>Hello", replyTo: "a" });
  person("c", 3000, { sender: "moni" }); sent("d", 4000, { kind: "notification" }); person("e", 5000);
  for (const id of ["wake:x", "secret:x", "reset:x", "command"]) person(id, 6000, id === "command" ? { text: "/new" } : {});
  person("no-time", 0, { sentAt: undefined, receivedAt: undefined });
  store.enqueue({ id: "pending", kind: "conversation", text: "not sent" }); store.set("sent-at:pending", 7000);
  sent("control", 8000, { kind: "control" });
  store.db.exec("PRAGMA query_only = ON");
  expect(history({ limit: 20 })).toEqual({ more: false, messages: [
    { id: "a", at: new Date(1000).toISOString(), from: "Abdullah", text: "a" },
    { id: "b", at: new Date(2000).toISOString(), from: "Robob", text: "Hello", thread: "a" },
    { id: "c", at: new Date(3000).toISOString(), from: "Moni", text: "c" },
    { id: "d", at: new Date(4000).toISOString(), from: "Robob", text: "d" },
    { id: "e", at: new Date(5000).toISOString(), from: "Abdullah", text: "e" },
  ] });
});

test("uses the observed swipe cache before threadOrigin and never guesses from replyTo", () => {
  const { store, person, sent, history } = setup();
  sent("answer", 1, { text: "<think>secret</think>Answer" }); person("target", 2, { sender: "moni", text: "Question" });
  person("cached", 3, { threadOrigin: "target" });
  store.set("swipe:cached", { kind: "robob", outboxId: "answer", text: "<think>hidden</think>Cached" });
  person("inbound-origin", 4, { threadOrigin: "target" });
  person("outbound-origin", 5, { threadOrigin: "handle-answer" });
  store.set("swipe:outbound-origin", { kind: "unknown" });
  person("unknown", 6, { replyTo: "target", threadOrigin: "missing" }); person("plain", 7);
  person("cached-owner", 8); store.set("swipe:cached-owner", { kind: "owner", text: "Owner" });
  person("cached-person", 9); store.set("swipe:cached-person", { kind: "person", sender: "moni", text: "Person" });
  person("preceding-only", 10, { replyTo: "target" });
  store.db.exec("PRAGMA query_only = ON");
  const messages = history({ limit: 20 })!.messages;
  const target = (id: string) => messages.find(m => m.id === id)?.replyTo;
  expect(target("cached")).toEqual({ id: "answer", from: "Robob", text: "Cached" });
  expect(target("inbound-origin")).toEqual({ id: "target", from: "Moni", text: "Question" });
  expect(target("outbound-origin")).toEqual({ id: "answer", from: "Robob", text: "Answer" });
  expect(target("unknown")).toEqual({ unknown: true }); expect(target("preceding-only")).toEqual({ unknown: true });
  expect(target("plain")).toBeUndefined();
  expect(target("cached-owner")).toEqual({ from: "Abdullah", text: "Owner" });
  expect(target("cached-person")).toEqual({ from: "Moni", text: "Person" });
});

test("pages back through interleaved messages without repeats", () => {
  const { person, sent, history } = setup();
  person("a", 1); sent("b", 2); person("c", 3); sent("d", 4); person("e", 5);
  const ids = (query: Parameters<typeof chatHistory>[3]) => {
    const result = history(query)!;
    return { ids: result.messages.map(m => m.id), more: result.more };
  };
  expect(ids({ limit: 2 })).toEqual({ ids: ["d", "e"], more: true });
  expect(ids({ limit: 2, before: "d" })).toEqual({ ids: ["b", "c"], more: true });
  expect(ids({ limit: 2, before: "b" })).toEqual({ ids: ["a"], more: false });
  expect(ids({ limit: 2, before: "a" })).toEqual({ ids: [], more: false });
  expect(history({ limit: 2, before: "missing" })).toBeUndefined();
});

test("finds an inbound id, outbox id or provider handle and excludes internal or unsent rows", () => {
  const { store, person, sent, history } = setup();
  person("a", 1); sent("b", 2);
  store.set("provider-operation:chunk", "b");
  for (const [id, expected] of [["a", "a"], ["b", "b"], ["handle-b", "b"], ["chunk", "b"]]) {
    expect(history({ id: id! })).toMatchObject({ messages: [{ id: expected }], more: false });
  }
  person("secret:a", 3); person("command", 4, { text: "/new" });
  store.enqueue({ id: "pending", kind: "conversation", text: "private" });
  for (const id of ["missing", "pending", "secret:a", "command"]) expect(history({ id })).toBeUndefined();
});

test("keeps replies after people on timestamp ties and preserves Robob queue order", () => {
  const { person, sent, history } = setup();
  person("a", 100); sent("b", 100, { replyTo: "a" }); sent("c", 100, { replyTo: "a" });
  expect(history({ limit: 20 })!.messages.map(m => m.id)).toEqual(["a", "b", "c"]);
});

test("late inbound deliveries do not displace newer sent times at a page boundary", () => {
  const { person, history } = setup();
  person("newest", 5); person("previous", 4); person("late-3", 3); person("late-2", 2); person("late-1", 1);
  expect(history({ limit: 2 })!.messages.map(m => m.id)).toEqual(["previous", "newest"]);
  expect(history({ limit: 2, before: "previous" })!.messages.map(m => m.id)).toEqual(["late-2", "late-3"]);
});

test("repeated outbox pages start a fresh indexed scan", () => {
  const { sent, history } = setup();
  for (let n = 1; n <= 5; n++) sent(`out-${n}`, n);
  for (let n = 0; n < 2; n++) {
    expect(history({ limit: 2 })!.messages.map(m => m.id)).toEqual(["out-4", "out-5"]);
    expect(history({ limit: 2, before: "out-4" })!.messages.map(m => m.id)).toEqual(["out-2", "out-3"]);
    expect(history({ limit: 2, before: "out-2" })).toMatchObject({ messages: [{ id: "out-1" }], more: false });
  }
});

test("clips text and quotes, handles files and senderless legacy rows, and skips invalid send times", () => {
  const { person, sent, history, store } = setup();
  person("legacy", 1, { sender: undefined });
  expect(history({ id: "legacy" }, true)!.messages[0]!.from).toBe("Abdullah");
  expect(history({ id: "legacy" })!.messages[0]!.from).toBe("Someone");
  person("long", 2, { text: "x".repeat(1200), threadOrigin: "legacy" });
  store.set("swipe:long", { kind: "person", sender: "moni", text: "y".repeat(400) });
  person("file", 3, { text: "", attachments: [{}] });
  sent("file-out", 4, { text: "", attachment: { name: "photo.jpg", mimeType: "image/jpeg", size: 1, sha256: "x" } });
  for (const [id, at] of [["string", "5"], ["prefix", "6oops"], ["null", null], ["object", {}], ["huge", 9e15]] as const) sent(id, at);
  sent("hidden", 10, { text: "<think>hidden</think>" });
  sent("last", 9);
  expect(history({ limit: 2 })!.messages.map(m => m.id)).toEqual(["file-out", "last"]);
  const long = history({ id: "long" })!.messages[0]!;
  expect(long.text).toHaveLength(1000);
  expect(long.replyTo && "text" in long.replyTo && long.replyTo.text.length).toBe(300);
  expect(history({ id: "file" })!.messages[0]!.text).toBe("[sent a file]");
  expect(history({ id: "file-out" })!.messages[0]!.text).toBe("[file: photo.jpg]");
});
