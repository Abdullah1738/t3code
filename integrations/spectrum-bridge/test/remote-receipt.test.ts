import { afterEach, expect, spyOn, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chatKey, type Line, type LineInbound } from "../src/line.ts";
import { RemoteBox } from "../src/remote-box.ts";
import { ChatRegistry } from "../src/runtime.ts";
import { acknowledgeSendblue } from "../src/sb-main.ts";
import { handleInbound } from "../src/sb-ingress.ts";
import { Store } from "../src/store.ts";
import { captureLogs } from "./log-fixture.ts";

const owner = "+15555550123", moni = "+15555550199";
const privateText = "MONI_RECEIPT_PRIVACY_CANARY_79";
const keys = generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
const roots: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup(react: (id: string, reaction: string) => Promise<void> = async () => {}) {
  const root = mkdtempSync(join(tmpdir(), "remote-receipt-")); roots.push(root);
  const tokenFile = join(root, "token"), publicKeyFile = join(root, "public-key");
  writeFileSync(tokenFile, "a".repeat(40)); writeFileSync(publicKeyFile, keys.publicKey);
  const ownerStore = new Store(join(root, "state.sqlite")); stores.push(ownerStore);
  const access = { people: [{ name: "Moni", role: "admin" as const, addresses: [moni] }], groups: [] };
  const failures: string[] = [], reactions: [string, string][] = [];
  const unexpected = async () => { throw new Error("receipt must only call line.react"); };
  const line: Line = { number: "+15555550000", react: async (id, reaction) => {
    reactions.push([id, reaction]); await react(id, reaction);
  }, events: async function* () { throw new Error("receipt must not open the line stream"); },
    backfill: unexpected, outbound: unexpected, sendText: unexpected, upload: unexpected,
    getMessage: unexpected, sendApp: unexpected, typing: unexpected, read: unexpected,
    requestLocation: unexpected, location: unexpected, setOptOut: unexpected, download: unexpected };
  const log = (event: string) => { failures.push(event); };
  const registry = new ChatRegistry({ line, owner, ownerStore, stateRoot: root, access: () => access,
    build: chat => {
      if (chat.store !== ownerStore) stores.push(chat.store);
      if (chat.info.slug === "moni") chat.remote = new RemoteBox({ kind: "remote-box", url: "http://127.0.0.1:12345",
        tokenFile, callbackTokenFile: tokenFile, publicKeyFile, callbackPort: 12346, epoch: "test", boxId: "bx_test" }, chat.store,
      { log, active: () => true,
        fetch: async () => { throw new Error("receipt must not contact the box"); } });
      return {};
    },
  });
  const chat = registry.open(chatKey.dm(moni)), remote = chat.remote!;
  const accepted = spyOn(remote, "accept");
  const sink = registry.sink(async () => {}, () => true, undefined, (chat, input) => acknowledgeSendblue(chat, input, log));
  const deps = { line, owner, ownerStore, access: async () => access, sink };
  const message: LineInbound = { handle: "remote-receipt", chat: chat.info.key, from: moni, participants: [],
    text: privateText, kind: "message", service: "iMessage", sentAt: Date.now() };
  const receive = (overrides: Partial<LineInbound> = {}, source: "live" | "backfill" = "live") => handleInbound(deps, { ...message, ...overrides }, source);
  return { root, chat, remote, registry, sink, accepted, reactions, failures, receive };
}

function containsPrivateText(root: string): boolean {
  return readdirSync(root, { withFileTypes: true }).some(entry => entry.isDirectory()
    ? containsPrivateText(join(root, entry.name)) : readFileSync(join(root, entry.name)).includes(Buffer.from(privateText)));
}

test("remote typed inbound gets one Mac receipt and stores only a receipt marker beside ciphertext", async () => {
  const s = setup();
  const logs = await captureLogs(async () => {
    expect(await s.receive()).toBe(true);
    expect(s.accepted).toHaveBeenCalledTimes(1);
    expect(s.reactions).toEqual([["remote-receipt", "👀"]]);
  });
  expect(s.chat.store.get<boolean>("eyes:remote-receipt")).toBe(true);
  expect(s.chat.store.pendingInbound()).toHaveLength(0);
  expect(s.chat.store.db.query("SELECT id FROM remote_inbox").all()).toHaveLength(1);
  expect(containsPrivateText(s.root)).toBe(false);
  expect(JSON.stringify([logs, s.failures]).includes(privateText)).toBe(false);
});

test("remote redelivery and receipt replay send no second reaction", async () => {
  const s = setup();
  await captureLogs(async () => {
    expect(await s.receive()).toBe(true);
    expect(await s.receive()).toBe(false);
    acknowledgeSendblue(s.chat, { id: "remote-receipt", text: privateText, source: "typed" }, () => {});
  });
  expect(s.reactions).toHaveLength(1);
});

test("remote accept and sealing finish while the Mac receipt is pending", async () => {
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const s = setup(async () => blocked);
  try {
    await captureLogs(async () => {
      expect(await s.receive()).toBe(true);
      expect(await s.receive()).toBe(false);
      expect(s.reactions).toHaveLength(1);
      expect(s.chat.store.db.query("SELECT id FROM remote_inbox WHERE sealed IS NOT NULL").all()).toHaveLength(1);
      expect(s.chat.store.get("eyes:remote-receipt")).toBeUndefined();
      release(); await blocked;
    });
    expect(s.chat.store.get<boolean>("eyes:remote-receipt")).toBe(true);
  } finally { release(); }
});

test.each([
  { label: "named tapback", text: `Liked “${privateText}”`, source: "live" },
  { label: "emoji tapback", text: `Reacted 👀 to “${privateText}”`, source: "live" },
  { label: "backfill", text: privateText, source: "backfill" },
] as const)("remote $label never gets a receipt", async ({ text, source }) => {
  const s = setup();
  const logs = await captureLogs(async () => { expect(await s.receive({ text }, source)).toBe(true); });
  expect(s.reactions).toHaveLength(0);
  expect(s.chat.store.get("eyes:remote-receipt")).toBeUndefined();
  expect(containsPrivateText(s.root)).toBe(false);
  expect(JSON.stringify(logs).includes(privateText)).toBe(false);
});

test("remote non-typed inbound never gets a receipt", async () => {
  const s = setup();
  await captureLogs(async () => {
    expect(s.sink.acceptInto(s.chat.info.key, undefined, moni).accept({ id: "machine-input", text: privateText })).toBe(true);
  });
  expect(s.reactions).toHaveLength(0);
});

test.each(["throw", "reject"] as const)("Mac receipt %s cannot fail accept or retry on redelivery", async failure => {
  const s = setup(() => {
    const error = new Error(privateText);
    if (failure === "throw") throw error;
    return Promise.reject(error);
  });
  const logs = await captureLogs(async () => {
    expect(await s.receive()).toBe(true);
    expect(await s.receive()).toBe(false);
  });
  expect(s.reactions).toHaveLength(1);
  expect(s.failures.filter(name => name === "receipt-ack-failed")).toHaveLength(1);
  expect(logs.some(line => line.error?.tag === "sb-main.catch7")).toBe(true);
  expect(s.chat.store.db.query("SELECT id FROM remote_inbox WHERE sealed IS NOT NULL").all()).toHaveLength(1);
  expect(containsPrivateText(s.root)).toBe(false);
  expect(JSON.stringify([logs, s.failures]).includes(privateText)).toBe(false);
});

test("owner receipts keep their existing behavior and groups remain quiet", async () => {
  const s = setup();
  await captureLogs(async () => {
    const sink = s.sink.acceptInto(chatKey.dm(owner), undefined, owner);
    expect(sink.accept({ id: "owner-receipt", text: "owner input", source: "typed", logSource: "backfill" })).toBe(true);
    const group = s.sink.acceptInto(chatKey.group("group-receipt"), undefined, owner);
    expect(group.accept({ id: "group-receipt", text: "group input", source: "typed" })).toBe(true);
  });
  expect(s.reactions).toEqual([["owner-receipt", "👀"]]);
});
