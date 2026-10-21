import { afterEach, describe, expect, test } from "bun:test";
import { decide, slugFor, roleOf, chatInfo } from "../src/access.ts";
import type { Access } from "../src/chats.ts";
import { chatKey, LineError, type ChatKey, type Line, type LineInbound, type LineOutbound } from "../src/line.ts";
import { handleInbound, type IngressDeps } from "../src/sb-ingress.ts";
import { inboundFromLine, sbTransport } from "../src/sb-transport.ts";
import { Store } from "../src/store.ts";

const owner = "+15555550123";
const moni = "+15555550199";
const access: Access = {
  people: [{ name: "Moni", role: "admin", addresses: [moni, "moni@example.com"] }],
  groups: [{ id: "grp-allowed", name: "Family" }],
};
const stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
const store = () => { const s = new Store(":memory:"); stores.push(s); return s; };

function inbound(overrides: Partial<LineInbound> = {}): LineInbound {
  return {
    handle: "h-1", chat: chatKey.dm(owner), from: owner, text: "hi", kind: "message", service: "iMessage",
    participants: [], sentAt: 1_000, ...overrides,
  };
}

function fakeLine(overrides: Partial<Line> = {}): Line & { sent: { chat: ChatKey; text: string; handle: string }[] } {
  const sent: { chat: ChatKey; text: string; handle: string }[] = [];
  const base: Line = {
    number: "+19362300565",
    events: async function* () {},
    backfill: async () => [],
    outbound: async () => [],
    sendText: async (chat, text) => {
      const handle = `out-${sent.length + 1}`;
      sent.push({ chat, text, handle });
      return { handle };
    },
    upload: async () => "https://cdn.example/file.jpg",
    getMessage: async () => undefined,
    sendApp: async () => ({ handle: "app-1" }),
    react: async () => {},
    typing: async () => {},
    read: async () => {},
    requestLocation: async () => {},
    location: async () => undefined,
    download: async () => ({ data: new Uint8Array([1]), name: "a.jpg", mimeType: "image/jpeg" }),
  };
  return Object.assign({ ...base, ...overrides }, { sent });
}

describe("access decisions", () => {
  test("owner and a listed person are allowed 1:1", () => {
    expect(decide(access, owner, chatKey.dm(owner), owner, [])).toEqual({ allowed: true });
    expect(decide(access, owner, chatKey.dm(moni), moni, [])).toEqual({ allowed: true });
  });

  test("unknown 1:1 is dropped with the address for the note", () => {
    expect(decide(access, owner, chatKey.dm("+447000000000"), "+447000000000", [])).toEqual({
      allowed: false, reason: "unknown-dm", address: "+447000000000",
    });
  });

  test("a group is allowed when explicitly listed, when the owner is in it, or when an admin is in it", () => {
    expect(decide(access, owner, chatKey.group("grp-allowed"), "+447000000000", []).allowed).toBe(true);
    expect(decide(access, owner, chatKey.group("grp-x"), moni, [owner, moni]).allowed).toBe(true);
    expect(decide(access, owner, chatKey.group("grp-y"), "+447000000000", [owner]).allowed).toBe(true);
  });

  test("an unknown group with only guests is dropped", () => {
    expect(decide(access, owner, chatKey.group("grp-z"), "+447000000000", ["+447000000001"])).toEqual({
      allowed: false, reason: "unknown-group", address: "grp-z",
    });
  });

  test("addresses match case-insensitively and unknown addresses are guests", () => {
    expect(roleOf(access, owner, owner)).toEqual({ name: "Abdullah", role: "owner" });
    expect(roleOf(access, owner, "MONI@EXAMPLE.COM").role).toBe("admin");
    expect(roleOf(access, owner, "Moni@Example.com").role).toBe("admin");
    expect(roleOf(access, owner, "+447000000000").role).toBe("guest");
  });
});

describe("chat slugs", () => {
  test("a person slug comes from their name and stays put", () => {
    expect(slugFor(chatKey.dm(moni), access, owner)).toBe("moni");
    expect(slugFor(chatKey.dm(owner), access, owner)).toBe("owner");
  });

  test("a group slug keeps six id characters even when renamed", () => {
    expect(slugFor(chatKey.group("abcdef123456"), access, owner, "Family Trip!")).toBe("group-family-trip-abcdef");
    expect(slugFor(chatKey.group("abcdef123456"), access, owner)).toBe("group-abcdef");
  });

  test("chatInfo titles a group by its name", () => {
    const info = chatInfo(chatKey.group("abcdef123456"), "group-family-abcdef", access, "Family");
    expect(info.kind).toBe("group");
    expect(info.title).toBe("Family");
  });
});

describe("inbound mapping", () => {
  test("text becomes the row, attachments keep the media URL, audio is flagged", () => {
    const mapped = inboundFromLine({ handle: "h", text: "", from: moni, mediaUrl: "https://cdn/x/voice.caf", kind: "message",
      service: "iMessage", sentAt: 5 });
    expect(mapped.id).toBe("h");
    expect(mapped.isAudioMessage).toBe(true);
    expect(mapped.attachments[0]).toMatchObject({ guid: "https://cdn/x/voice.caf", mimeType: "audio/x-caf", totalBytes: 0 });
    expect(mapped.source).toBe("typed");
    expect(mapped.sender).toBe(moni);
  });

  test("a location share becomes the shared-location text and keeps coordinates", () => {
    const mapped = inboundFromLine({ handle: "h", text: "", from: moni, kind: "location", service: "iMessage", sentAt: 5,
      location: { latitude: 25.2, longitude: 55.3, accuracy: 12 } });
    expect(mapped.text).toBe("[Shared location] 25.2,55.3 (±12 m)");
    expect(mapped.location).toMatchObject({ latitude: 25.2, longitude: 55.3, accuracy: 12 });
  });
});

describe("transport shim", () => {
  test("a retry of an id whose first send was uncertain returns the earlier handle and does not resend", async () => {
    const s = store();
    let failNext = true;
    const line = fakeLine({
      sendText: async (chat, text) => {
        if (failNext) { failNext = false; throw new LineError("timeout", "timeout", true, true); }
        return { handle: "out-retry" };
      },
      outbound: async () => [{ handle: "out-earlier", chat: chatKey.dm(owner), text: "hello", sentAt: 100, status: "sent" } as LineOutbound],
    });
    const transport = sbTransport(line, chatKey.dm(owner), s, () => 200);
    await expect(transport.sendText({ id: "op-1", chatGuid: "x", text: "hello" })).rejects.toMatchObject({ retryable: true, ambiguous: true });
    const retried = await transport.sendText({ id: "op-1", chatGuid: "x", text: "hello" });
    expect(retried).toEqual({ providerId: "out-earlier", duplicate: true });
    expect(line.sent).toHaveLength(0);
  });

  test("a successful send records its handle so a later repeat is a duplicate", async () => {
    const s = store();
    const line = fakeLine();
    const transport = sbTransport(line, chatKey.dm(owner), s);
    expect(await transport.sendText({ id: "op-2", chatGuid: "x", text: "yo" })).toEqual({ providerId: "out-1" });
    expect(await transport.sendText({ id: "op-2", chatGuid: "x", text: "yo" })).toEqual({ providerId: "out-1", duplicate: true });
    expect(line.sent).toHaveLength(1);
  });

  test("a poll goes out as numbered text", async () => {
    const line = fakeLine();
    const transport = sbTransport(line, chatKey.dm(owner), store());
    await transport.sendPoll({ id: "p-1", chatGuid: "x", title: "Pick", options: ["Yes", "No"] });
    expect(line.sent[0]!.text).toBe("Pick\n1. Yes\n2. No");
  });

  test("typing false is not sent, typing true is", async () => {
    const calls: boolean[] = [];
    const line = fakeLine({ typing: async () => { calls.push(true); } });
    const transport = sbTransport(line, chatKey.dm(owner), store());
    await transport.typing("x", false);
    await transport.typing("x", true);
    expect(calls).toEqual([true]);
  });
});

describe("ingress", () => {
  function deps(overrides: Partial<IngressDeps> = {}) {
    const ownerStore = store();
    const accepted: unknown[] = [];
    const notes: string[] = [];
    const deps: IngressDeps = {
      line: fakeLine(),
      owner,
      ownerStore,
      access: async () => access,
      sink: {
        acceptInto: () => ({ accept: input => { accepted.push(input); return true; } }),
        setTyping: () => {},
        note: async (_address, text) => { notes.push(text); },
      },
      ...overrides,
    };
    return { deps, accepted, notes };
  }

  test("an allowed message is accepted into the chat store", async () => {
    const { deps: d, accepted } = deps();
    expect(await handleInbound(d, inbound())).toBe(true);
    expect(accepted).toHaveLength(1);
  });

  test("an unknown 1:1 sends exactly one note per address", async () => {
    const { deps: d, notes } = deps();
    const stranger = inbound({ handle: "h-2", chat: chatKey.dm("+447000000000"), from: "+447000000000" });
    expect(await handleInbound(d, stranger)).toBe(false);
    expect(await handleInbound(d, { ...stranger, handle: "h-3" })).toBe(false);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("allow --address +447000000000 --name");
  });

  test("messages from our own line number are skipped", async () => {
    const { deps: d, accepted } = deps();
    expect(await handleInbound(d, inbound({ from: "+19362300565" }))).toBe(false);
    expect(accepted).toHaveLength(0);
  });
});
