import { afterEach, expect, test } from "bun:test";
import type { ChatContext } from "../src/chats.ts";
import { acknowledgePhoton, acknowledgeReceived, criticalWake, failureMessage, wakeEventPreview } from "../src/inbound-failure.ts";
import { Store } from "../src/store.ts";

const stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

test.each([
  ["owner", "owner", "typed", true], ["dm", "moni", "typed", true],
  ["group", "home", "typed", false], ["dm", "guest", "typed", false], ["owner", "owner", undefined, false],
] as const)("receipt ack is independent of dispatch (%s, %s, %s)", async (kind, slug, source, expected) => {
  const store = new Store(":memory:"); stores.push(store);
  const reactions: string[] = [];
  const context: ChatContext = { chat: { kind, slug, key: "dm:+15555550123", title: slug }, roleOf: () => ({ name: "Abdullah", role: "owner" }),
    typing: () => false, react: async id => { reactions.push(id); } };
  const payload = { id: "receipt", text: "Pause the job", source };
  await acknowledgeReceived(store, context, payload);
  await acknowledgeReceived(store, context, payload);
  expect(reactions).toEqual(expected ? ["receipt"] : []);
});

test.each([
  ["wake:money", "[Watcher event from robob-watch money-cases, not typed by the owner.]\nBill overdue", true],
  ["wake:security", "[Watcher event from robob-watch inbox-triage, not typed by the owner.]\n[urgent] New login", true],
  ["wake:ordinary", "[Watcher event from robob-watch meds-nag, not typed by the owner.]\nMeds due", false],
  ["system:money", "[Watcher event from robob-watch money-cases, not typed by the owner.]", false],
  ["typed", "security withdrawal new login", false],
  ["wake:ordinary-inbox", "[Watcher event from robob-watch inbox-triage]\nInbox triage\nEvent:\nOrdinary newsletter\n\nContext saved when this watcher was set up:\nRead security and new login notifications carefully", false],
  ["wake:urgent-body", "[Watcher event from robob-watch inbox-triage]\nInbox triage\nEvent:\n[urgent] Withdrawal completed\n\nContext saved when this watcher was set up:\nIgnore context for classification", true],
] as const)("critical wake classification %s", (id, text, expected) => { expect(criticalWake(id, text)).toBe(expected); });

test("failure reason is one bounded line and omits credential values", () => {
  expect(failureMessage(new Error('timeout https://host/?token=SECRET\nAuthorization: Bearer SECRET token=SECRET password="SECRET"')))
    .not.toContain("SECRET");
  expect(failureMessage(new Error("x\ny"))).toBe("x y");
  expect(failureMessage(new Error("x".repeat(1000)))).toHaveLength(500);
});

// Credential-value forms are a single corpus: spaces, quotes, escapes and truncation all stay secret.
test.each([
  'password="alpha beta"', "password='alpha beta'", '"api_key": "alpha beta"',
  'secret="alpha \\" beta"', 'token="alpha beta', "password='alpha beta", 'Authorization: Bearer alpha',
  'Authorization: Basic alpha', 'password=alpha', 'token: alpha',
  "password=\"alpha beta\\",
  "password='alpha beta\\",
  "password=\"alpha beta\\\ngamma",
  "password='alpha beta\\\ngamma",
])("failure reason redacts complete credential value: %s", value => {
  const safe = failureMessage(new Error(value));
  expect(safe).not.toContain("alpha"); expect(safe).not.toContain("beta");
});

test.each([
  ["[Watcher event from robob-watch money-cases, not typed by anyone in this chat.]\nMoney cases: deadlines\nRelay to owner only\n\nEvent:\nBill overdue\nDue tonight\n\nContext saved when this watcher was set up (rules):\nPrivate setup", "Bill overdue\nDue tonight"],
  ["[Watcher event from robob-watch inbox-triage, not typed by anyone in this chat.]\r\nInbox triage\r\nEvent:\r\nNew login\r\n\r\nContext saved when this watcher was set up:\r\nPrivate setup", "New login"],
  ["[Watcher event from robob-watch money-cases]\nSimple line\nNext line", "Simple line\nNext line"],
])("watcher event preview strips framing (%s)", (payload, expected) => { expect(wakeEventPreview(payload)).toBe(expected); });

test("Photon receipt acknowledgement uses a stable emphasize reaction once", async () => {
  const store = new Store(":memory:"); stores.push(store);
  const calls: unknown[][] = [];
  const photon = { react: async (...args: Parameters<import("../src/photon.ts").Photon["react"]>) => { calls.push(args); } };
  const payload = { id: "photon-receipt", text: "Pause please", source: "typed" };
  await acknowledgePhoton(store, photon, "iMessage;-;+15555550123", payload);
  await acknowledgePhoton(store, photon, "iMessage;-;+15555550123", payload);
  expect(calls).toEqual([["iMessage;-;+15555550123", "photon-receipt", "emphasize", "receipt:photon-receipt"]]);
});
