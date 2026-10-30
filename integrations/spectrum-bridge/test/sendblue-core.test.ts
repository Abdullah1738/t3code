import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { decide, slugFor, roleOf, chatInfo } from "../src/access.ts";
import type { Access } from "../src/chats.ts";
import { chatKey, LineError, type ChatKey, type Line, type LineInbound, type LineOutbound } from "../src/line.ts";
import { handleInbound, type IngressDeps } from "../src/sb-ingress.ts";
import { classifyDownloadFailure, classifySendFailure, TransportError } from "../src/photon.ts";
import { inboundFromLine, sbTransport } from "../src/sb-transport.ts";
import { Delivery } from "../src/delivery.ts";
import { Sendblue } from "../src/sendblue.ts";
import { Store } from "../src/store.ts";
import { cardLayout } from "../src/card-text.ts";

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
    expect(mapped.sentAt).toBe(5);
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
      outbound: async () => [{ handle: "out-earlier", chat: chatKey.dm(owner), text: "hello", sentAt: 300, status: "sent" } as LineOutbound],
    });
    const transport = sbTransport(line, chatKey.dm(owner), s, () => 200);
    await expect(transport.sendText({ id: "op-1", chatGuid: "x", text: "hello" })).rejects.toMatchObject({ retryable: true, ambiguous: true });
    const retried = await transport.sendText({ id: "op-1", chatGuid: "x", text: "hello" });
    expect(retried).toEqual({ providerId: "out-earlier", duplicate: true });
    expect(line.sent).toHaveLength(0);
  });

  describe("uncertain sends (the 23 Oct board went out three times)", () => {
    const board = "Board for today (you fly today). I'll keep it short: \"gate\" first.";
    const delivered = (over: Partial<LineOutbound> = {}): LineOutbound =>
      ({ handle: "be6c5134", chat: chatKey.dm(owner), text: "Board for today (you fly today). I\u2019ll keep it short: \u201cgate\u201d first.", sentAt: 51_000, status: "DELIVERED", ...over });
    const timeout = () => new LineError("Sendblue POST /api/send-message failed: timeout", "network", true, true);

    test("a copy Messages stored with curly quotes is found, not sent again", async () => {
      let clock = 0;
      let fail = true;
      const looked: number[] = [];
      const line = fakeLine({
        sendText: async () => { if (fail) { fail = false; throw timeout(); } return { handle: "again" }; },
        outbound: async (_chat, since) => { looked.push(since); return [delivered()]; },
      });
      const transport = sbTransport(line, chatKey.dm(owner), store(), () => clock);
      await expect(transport.sendText({ id: "op", chatGuid: "x", text: board })).rejects.toMatchObject({ code: "network", ambiguous: true });
      clock = 40_000;
      expect(await transport.sendText({ id: "op", chatGuid: "x", text: board })).toEqual({ providerId: "be6c5134", duplicate: true });
      expect(looked).toEqual([-60_000]);
      expect(line.sent).toHaveLength(0);
    });

    test("a miss waits for the slow copy instead of resending, then sends once the copy is overdue", async () => {
      let clock = 0;
      let landed = false;
      let fail = true;
      const s = store();
      const line = fakeLine({
        sendText: async (chat, text) => {
          if (fail) { fail = false; throw timeout(); }
          line.sent.push({ chat, text, handle: "second" });
          return { handle: "second" };
        },
        outbound: async () => landed ? [delivered()] : [],
      });
      const transport = sbTransport(line, chatKey.dm(owner), s, () => clock);
      await expect(transport.sendText({ id: "op", chatGuid: "x", text: board })).rejects.toMatchObject({ ambiguous: true });
      clock = 30_000;
      await expect(transport.sendText({ id: "op", chatGuid: "x", text: board })).rejects.toMatchObject({ code: "sendUnconfirmed", retryable: true, ambiguous: true });
      landed = true;
      expect(await transport.sendText({ id: "op", chatGuid: "x", text: board })).toEqual({ providerId: "be6c5134", duplicate: true });
      expect(line.sent).toHaveLength(0);

      landed = false;
      fail = true;
      await expect(transport.sendText({ id: "late", chatGuid: "x", text: "Later" })).rejects.toMatchObject({ ambiguous: true });
      clock += 119_000;
      await expect(transport.sendText({ id: "late", chatGuid: "x", text: "Later" })).rejects.toMatchObject({ code: "sendUnconfirmed" });
      clock += 1_000;
      expect(await transport.sendText({ id: "late", chatGuid: "x", text: "Later" })).toEqual({ providerId: "second" });
      expect(s.get<unknown>("sent-attempt:late")).toEqual({ first: 30_000, last: 150_000 });
    });

    test("the lookback covers the first attempt, and a copy another row already owns is not taken", async () => {
      let clock = 0;
      const s = store();
      const looked: number[] = [];
      s.enqueue({ id: "yesterday", kind: "conversation", text: "Done." });
      s.outboxState("yesterday", "sent", "claimed");
      const line = fakeLine({
        sendText: async () => { throw timeout(); },
        outbound: async (_chat, since) => {
          looked.push(since);
          return [delivered({ handle: "claimed", text: "Done." }), delivered({ handle: "failed", text: "Done.", status: "ERROR" })];
        },
      });
      const transport = sbTransport(line, chatKey.dm(owner), s, () => clock);
      await expect(transport.sendText({ id: "op", chatGuid: "x", text: "Done." })).rejects.toMatchObject({ ambiguous: true });
      clock = 200_000;
      await expect(transport.sendText({ id: "op", chatGuid: "x", text: "Done." })).rejects.toMatchObject({ ambiguous: true });
      clock = 400_000;
      await expect(transport.sendText({ id: "op", chatGuid: "x", text: "Done." })).rejects.toMatchObject({ ambiguous: true });
      expect(looked).toEqual([-60_000, -60_000]);
      expect(s.get<unknown>("sent-attempt:op")).toEqual({ first: 0, last: 400_000 });
    });

    test("files match on the uploaded URL and cards on their page URL", async () => {
      let clock = 0;
      let fail = 2;
      const sends: string[] = [];
      const line = fakeLine({
        sendText: async (_chat, _text, options) => { sends.push(options?.mediaUrl ?? ""); if (fail-- > 0) throw timeout(); return { handle: "x" }; },
        sendApp: async (_chat, card) => { sends.push(card.url); if (fail-- > 0) throw timeout(); return { handle: "x" }; },
        outbound: async () => [
          delivered({ handle: "photo", text: "", mediaUrl: "https://storage.example/en28_body.png" }),
          delivered({ handle: "card", text: "Board", card: { url: "https://robob.example/board/?v=1", layout: { caption: "Board" } } }),
        ],
      });
      const transport = sbTransport(line, chatKey.dm(owner), store(), () => clock);
      const file = { id: "file", chatGuid: "x", attachmentGuid: "https://storage.example/en28_body.png" };
      const card = { id: "card", chatGuid: "x", url: "https://robob.example/board/?v=1", caption: "Board" };
      await expect(transport.sendAttachment(file)).rejects.toMatchObject({ ambiguous: true });
      await expect(transport.sendApp(card)).rejects.toMatchObject({ ambiguous: true });
      clock = 10_000;
      expect(await transport.sendAttachment(file)).toEqual({ providerId: "photo", duplicate: true });
      expect(await transport.sendApp(card)).toEqual({ providerId: "card", duplicate: true });
      expect(sends).toHaveLength(2);
    });

    test("a live card's retry does not take a newer card to the same page", async () => {
      // A ride card keeps one page and changes its caption; each update is its own row. The first
      // update timed out without going out, the second went out but its response was lost.
      let clock = 0;
      const page = "https://robob.example/ride/abc";
      const sends: string[] = [];
      const sent: LineOutbound[] = [];
      const line = fakeLine({
        sendApp: async (_chat, card) => {
          // What Sendblue stores is the layout sendApp cleaned, without the time.
          const layout = cardLayout(card)!;
          sends.push(layout.caption!);
          const handle = `h${sends.length}`;
          if (sends.length === 1) throw timeout();
          sent.push(delivered({ handle, text: layout.caption!, card: { url: page, layout }, sentAt: clock + 1_000 }));
          if (sends.length === 2) throw timeout();
          return { handle };
        },
        outbound: async () => sent,
      });
      const transport = sbTransport(line, chatKey.dm(owner), store(), () => clock);
      const approaching = { id: "approaching", chatGuid: "x", url: page, caption: "Driver approaching" };
      const arrived = { id: "arrived", chatGuid: "x", url: page, caption: "Driver 3 min away, 10:42" };
      await expect(transport.sendApp(approaching)).rejects.toMatchObject({ ambiguous: true });
      clock = 30_000;
      await expect(transport.sendApp(arrived)).rejects.toMatchObject({ ambiguous: true });
      clock = 200_000;
      expect(await transport.sendApp(approaching)).toEqual({ providerId: "h3" });
      expect(await transport.sendApp(arrived)).toEqual({ providerId: "h2", duplicate: true });
      expect(sends).toEqual(["Driver approaching", "Driver 3 min away", "Driver approaching"]);
    });

    test("an unthreaded copy finds what the threaded attempt it replaces already sent", async () => {
      let clock = 0;
      const line = fakeLine({
        sendText: async () => { throw timeout(); },
        outbound: async () => [delivered({ handle: "threaded", text: "Reply" })],
      });
      const transport = sbTransport(line, chatKey.dm(owner), store(), () => clock);
      await expect(transport.sendText({ id: "threaded-id", chatGuid: "x", text: "Reply", replyTo: "parent" })).rejects.toMatchObject({ ambiguous: true });
      clock = 5_000;
      expect(await transport.sendText({ id: "unthreaded-id", retryOf: "threaded-id", chatGuid: "x", text: "Reply" }))
        .toEqual({ providerId: "threaded", duplicate: true, original: true });
    });

    test("a definite failure clears the attempt so the next try sends at once", async () => {
      let clock = 0;
      let fail = true;
      const s = store();
      const looked: number[] = [];
      const line = fakeLine({
        sendText: async (chat, text) => {
          if (fail) { fail = false; throw new LineError("rate limited", "http_429", true, false); }
          line.sent.push({ chat, text, handle: "ok" });
          return { handle: "ok" };
        },
        outbound: async (_chat, since) => { looked.push(since); return []; },
      });
      const transport = sbTransport(line, chatKey.dm(owner), s, () => clock);
      await expect(transport.sendText({ id: "op", chatGuid: "x", text: "hi" })).rejects.toMatchObject({ code: "http_429", ambiguous: false });
      expect(s.get("sent-attempt:op")).toBeUndefined();
      clock = 5_000;
      expect(await transport.sendText({ id: "op", chatGuid: "x", text: "hi" })).toEqual({ providerId: "ok" });
      expect(looked).toEqual([]);
    });

    test("a copy sent before this send's first attempt belongs to another row, even when nothing claims it", async () => {
      // An earlier card to the same page timed out, landed late and was then dropped by /new.
      let clock = 100_000;
      let fail = true;
      const looked: number[] = [];
      const line = fakeLine({
        sendApp: async () => { if (fail) { fail = false; throw timeout(); } return { handle: "new-card" }; },
        outbound: async (_chat, since) => { looked.push(since); return [delivered({ handle: "old-card", text: "Board", card: { url: "https://robob.example/board/", layout: { caption: "Board" } }, sentAt: 42_000 })]; },
      });
      const transport = sbTransport(line, chatKey.dm(owner), store(), () => clock);
      const card = { id: "card", chatGuid: "x", url: "https://robob.example/board/", caption: "Board" };
      await expect(transport.sendApp(card)).rejects.toMatchObject({ ambiguous: true });
      clock = 110_000;
      await expect(transport.sendApp(card)).rejects.toMatchObject({ code: "sendUnconfirmed" });
      clock = 220_000;
      expect(await transport.sendApp(card)).toEqual({ providerId: "new-card" });
      expect(looked).toEqual([40_000, 40_000]);
    });

    test("a send whose response body was lost is looked for, and the rest of the message still goes", async () => {
      const start = Date.parse("2026-10-23T07:00:00Z");
      setSystemTime(start);
      try {
        const posted: string[] = [];
        const delivered: Record<string, unknown>[] = [];
        const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
          const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
          if (init?.method === "POST") {
            const content = String(JSON.parse(String(init.body)).content);
            posted.push(content);
            const handle = `h${posted.length}`;
            delivered.push({ message_handle: handle, is_outbound: true, number: owner, content, status: "DELIVERED", date_sent: new Date(Date.now() + 1_000).toISOString() });
            // The first send went out, but its response body never arrived.
            return posted.length === 1 ? new Response("", { status: 200 }) : Response.json({ message_handle: handle });
          }
          expect(url.pathname).toBe("/api/v2/messages");
          return Response.json({ data: delivered });
        }) as unknown as typeof fetch;
        const line = new Sendblue({ keyId: "k", secret: "s", number: "+19362300565", fetch: fetchFn });
        const s = store();
        s.set("route", { id: "session", generation: 1 });
        const delivery = new Delivery(s, sbTransport(line, chatKey.dm(owner), s), {
          projectScope: "scope", enabled: () => true, chatGuid: () => chatKey.dm(owner), log: () => {}, sleep: async () => {},
        });
        s.enqueue({ id: "board", kind: "conversation", text: "word ".repeat(800).trim(), sessionId: "session", generation: 1 });
        await delivery.tick();
        expect(s.getOperation("board")).toMatchObject({ state: "pending", attempts: 1 });
        setSystemTime(start + 60_000);
        await delivery.tick();
        expect(posted).toHaveLength(2);
        expect(posted.join("").replace(/\s/g, "")).toBe("word".repeat(800));
        expect(s.getOperation("board")).toMatchObject({ state: "sent", attempts: 2 });
        expect([s.byProviderId("h1")?.id, s.byProviderId("h2")?.id]).toEqual(["board", "board"]);
      } finally {
        setSystemTime();
      }
    });

    test("a lost upload response or a history read with no data is tried again, and the file goes once", async () => {
      const start = Date.parse("2026-10-24T07:00:00Z");
      setSystemTime(start);
      try {
        const calls: string[] = [];
        const delivered: Record<string, unknown>[] = [];
        let lists = 0;
        const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
          const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
          calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
          if (url.pathname === "/api/upload-file") {
            // The first upload's response body never arrived.
            return calls.filter(call => call.endsWith("/api/upload-file")).length === 1
              ? new Response("", { status: 200 }) : Response.json({ media_url: "https://storage.example/ab12_report.pdf" });
          }
          if (url.pathname === "/api/send-message") {
            const media = String(JSON.parse(String(init!.body)).media_url);
            delivered.push({ message_handle: "f1", is_outbound: true, number: owner, content: "", media_url: media, status: "DELIVERED", date_sent: new Date(Date.now() + 1_000).toISOString() });
            return new Response("", { status: 200 });
          }
          // The first history read came back empty-handed too.
          return ++lists === 1 ? new Response("", { status: 200 }) : Response.json({ data: delivered });
        }) as unknown as typeof fetch;
        const line = new Sendblue({ keyId: "k", secret: "s", number: "+19362300565", fetch: fetchFn });
        const s = store();
        s.set("route", { id: "session", generation: 1 });
        const delivery = new Delivery(s, sbTransport(line, chatKey.dm(owner), s), {
          projectScope: "scope", enabled: () => true, chatGuid: () => chatKey.dm(owner), log: () => {}, sleep: async () => {},
        });
        const data = new Uint8Array([1, 2, 3]);
        s.enqueue({ id: "file", kind: "conversation", text: "", sessionId: "session", generation: 1,
          attachment: { sha256: s.putBlob(data), name: "report.pdf", mimeType: "application/pdf", size: data.byteLength } });
        for (const at of [0, 60_000, 180_000, 300_000]) {
          setSystemTime(start + at);
          await delivery.tick();
        }
        expect(s.getOperation("file")).toMatchObject({ state: "sent" });
        expect(calls.filter(call => call === "POST /api/send-message")).toHaveLength(1);
        expect(s.byProviderId("f1")?.id).toBe("file");
      } finally {
        setSystemTime();
      }
    });

    test("an attempt stored by the previous build still triggers the lookup", async () => {
      const s = store();
      s.set("sent-attempt:op", 1_000);
      const line = fakeLine({ outbound: async () => [delivered({ handle: "old", text: "hi" })] });
      expect(await sbTransport(line, chatKey.dm(owner), s, () => 500_000).sendText({ id: "op", chatGuid: "x", text: "hi" }))
        .toEqual({ providerId: "old", duplicate: true });
    });
  });

  test("line failure codes reach the logs and keep their flags; free text in an HTTP error key does not", async () => {
    const fail = (error: LineError) => sbTransport(fakeLine({ typing: async () => { throw error; } }), chatKey.dm(owner), store()).typing("x", true);
    await expect(fail(new LineError("x", "http_400:invalid_number", false, false))).rejects.toMatchObject({ code: "http_400:invalid_number", retryable: false });
    await expect(fail(new LineError("x", "http_400:Number is not valid, see https://x", false, false))).rejects.toMatchObject({ code: "http_400" });
    await expect(fail(new LineError("x", "weird\ncode", true, true))).rejects.toMatchObject({ code: "lineFailure", retryable: true, ambiguous: true });
    expect(classifySendFailure(new TransportError("http_400:invalid_number", false, false))).toEqual({ retryable: false, uncertain: false, code: "http_400:invalid_number" });
    expect(classifySendFailure(new TransportError("network", true, true))).toEqual({ retryable: true, uncertain: true, code: "network" });
    expect(classifySendFailure(new TransportError("http_429", true, false))).toEqual({ retryable: true, uncertain: false, code: "http_429" });
    expect(classifyDownloadFailure(new TransportError("too_large"))).toEqual({ retryable: false, code: "attachmentTooLarge" });
    expect(classifyDownloadFailure(new TransportError("http_404"))).toEqual({ retryable: true, code: "attachmentUnavailable" });
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

  test("typing starts with a 60 s bubble and stops explicitly", async () => {
    const calls: unknown[] = [];
    const line = fakeLine({ typing: async (chat, options) => { calls.push([chat, options]); } });
    const transport = sbTransport(line, chatKey.dm(owner), store());
    await transport.typing("x", true);
    await transport.typing("x", false);
    expect(calls).toEqual([
      [chatKey.dm(owner), { state: "start", maxDurationMs: 60_000 }],
      [chatKey.dm(owner), { state: "stop" }],
    ]);
  });

  test("a message we send re-arms typing while it is on, and only then", async () => {
    const calls: string[] = [];
    const line = fakeLine({ typing: async (_chat, options) => { calls.push(options?.state ?? "legacy"); } });
    const transport = sbTransport(line, chatKey.dm(owner), store());
    await transport.sendText({ id: "a", chatGuid: "x", text: "before" });
    await transport.typing("x", true);
    await transport.sendText({ id: "b", chatGuid: "x", text: "progress" });
    await transport.sendApp({ id: "c", chatGuid: "x", url: "https://example.com", caption: "Card" });
    // A duplicate never went out, so the bubble is still showing.
    await transport.sendText({ id: "b", chatGuid: "x", text: "progress" });
    await transport.typing("x", false);
    await transport.sendText({ id: "d", chatGuid: "x", text: "final" });
    expect(calls).toEqual(["start", "start", "start", "stop"]);
  });

  test("a slow re-arm never lands after the stop", async () => {
    const calls: string[] = [];
    let release = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    let first = true;
    const line = fakeLine({ typing: async (_chat, options) => {
      if (first) { first = false; await gate; }
      calls.push(options?.state ?? "legacy");
    } });
    const transport = sbTransport(line, chatKey.dm(owner), store());
    const started = transport.typing("x", true);
    await transport.sendText({ id: "a", chatGuid: "x", text: "progress" });
    const stopped = transport.typing("x", false);
    release();
    await Promise.all([started, stopped]);
    expect(calls).toEqual(["start", "start", "stop"]);
  });

  test("static card chats send interactive:false with the page's preview image", async () => {
    const cards: unknown[] = [];
    const line = fakeLine({ sendApp: async (_chat, card) => { cards.push(card); return { handle: "app-s" }; } });
    const pages: string[] = [];
    const transport = sbTransport(line, chatKey.dm(moni), store(), undefined, {
      static: true, previewImage: async url => { pages.push(url); return "https://cdn.example/p.png"; },
    });
    await transport.sendApp({ id: "s1", chatGuid: "x", url: "https://example.com/ride", caption: "Ride" });
    await transport.sendApp({ id: "s2", chatGuid: "x", url: "https://example.com/r2", caption: "Ride", imageUrl: "https://given.example/i.png" });
    expect(cards).toEqual([
      { url: "https://example.com/ride", caption: "Ride", interactive: false, imageUrl: "https://cdn.example/p.png" },
      { url: "https://example.com/r2", caption: "Ride", interactive: false, imageUrl: "https://given.example/i.png" },
    ]);
    expect(pages).toEqual(["https://example.com/ride"]);

    const live: unknown[] = [];
    const liveLine = fakeLine({ sendApp: async (_chat, card) => { live.push(card); return { handle: "app-l" }; } });
    await sbTransport(liveLine, chatKey.dm(owner), store()).sendApp({ id: "l1", chatGuid: "x", url: "https://example.com/a", caption: "A" });
    expect(live).toEqual([{ url: "https://example.com/a", caption: "A" }]);
  });

  test("a static card still goes out when the preview lookup fails", async () => {
    const cards: unknown[] = [];
    const line = fakeLine({ sendApp: async (_chat, card) => { cards.push(card); return { handle: "app-f" }; } });
    const transport = sbTransport(line, chatKey.dm(moni), store(), undefined, {
      static: true, previewImage: async () => { throw new Error("offline"); },
    });
    await transport.sendApp({ id: "f1", chatGuid: "x", url: "https://example.com/x", caption: "X" });
    expect(cards).toEqual([{ url: "https://example.com/x", caption: "X", interactive: false }]);
  });

  test("typing failures surface as transport errors with the line code", async () => {
    const line = fakeLine({ typing: async () => { throw new LineError("x", "http_503:worker_unavailable", true, false); } });
    const transport = sbTransport(line, chatKey.dm(owner), store());
    await expect(transport.typing("x", true)).rejects.toMatchObject({ code: "http_503:worker_unavailable" });
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

test("outboundStatuses maps Sendblue's status by handle", async () => {
  const line = fakeLine({
    outbound: async () => [
      { handle: "h1", chat: chatKey.dm(owner), text: "x", sentAt: 1, status: "ERROR" } as LineOutbound,
      { handle: "", chat: chatKey.dm(owner), text: "y", sentAt: 2, status: "SENT" } as LineOutbound,
    ],
  });
  const transport = sbTransport(line, chatKey.dm(owner), store(), () => 200);
  expect([...(await transport.outboundStatuses(0))]).toEqual([["h1", "ERROR"]]);
});

test("a threaded reply whose response was lost but landed is resent unthreaded when Sendblue later fails it", async () => {
  let clock = Date.parse("2026-10-29T12:00:00Z");
  setSystemTime(clock);
  const copies: { handle: string; replyTo?: string; text: string; sentAt: number; status: string }[] = [];
  const line = fakeLine({
    sendText: async (_chat, text, options) => {
      const handle = `out-${copies.length + 1}`;
      copies.push({ handle, replyTo: options?.replyTo, text, sentAt: clock + 1_000, status: "SENT" });
      if (copies.length === 1) throw new LineError("timeout", "timeout", true, true);
      return { handle };
    },
    outbound: async () => copies.map(copy => ({ handle: copy.handle, chat: chatKey.dm(owner), text: copy.text, sentAt: copy.sentAt, status: copy.status }) as LineOutbound),
  });
  const s = store();
  const transport = sbTransport(line, chatKey.dm(owner), s, () => Date.now());
  const delivery = new Delivery(s, transport, {
    projectScope: "scope", chatGuid: () => chatKey.dm(owner), enabled: () => true,
    sleep: async () => {}, statuses: since => transport.outboundStatuses(since),
  });
  s.enqueue({ id: "reply", kind: "conversation", text: "Use 70% alcohol", replyTo: "inbound-1" });
  await delivery.tick();
  setSystemTime(clock += 5_000);
  await delivery.tick();
  expect(copies).toHaveLength(1);
  expect(s.getOperation("reply")!.state).toBe("sent");
  copies[0]!.status = "ERROR";
  setSystemTime(clock += 5 * 60_000);
  await delivery.tick();
  await delivery.tick();
  expect(copies).toHaveLength(2);
  expect(copies[0]!.replyTo).toBe("inbound-1");
  expect(copies[1]).toMatchObject({ replyTo: undefined, text: "Use 70% alcohol", status: "SENT" });
  expect(s.getOperation("reply")!.state).toBe("sent");
  setSystemTime(clock += 10 * 60_000);
  await delivery.tick();
  await delivery.tick();
  expect(copies).toHaveLength(2);
  setSystemTime();
});

test("review: a recovered unthreaded fallback must not get a second unthreaded copy", async () => {
  const start = Date.parse("2026-10-29T12:00:00Z");
  setSystemTime(start);
  try {
    let posts = 0;
    let checks = 0;
    const copies: { handle: string; replyTo?: string; text: string; sentAt: number; status: string }[] = [];
    const line = fakeLine({
      sendText: async (_chat, text, options) => {
        posts++;
        if (posts === 1) throw new LineError("refused", "http_400", false, false);
        const handle = `copy-${copies.length + 1}`;
        copies.push({ handle, replyTo: options?.replyTo, text, sentAt: Date.now() + 1_000, status: "SENT" });
        if (posts === 2) throw new LineError("timeout", "timeout", true, true);
        return { handle };
      },
      outbound: async () => copies.map(copy => ({ ...copy, chat: chatKey.dm(owner) }) as LineOutbound),
    });
    const s = store();
    const transport = sbTransport(line, chatKey.dm(owner), s);
    const delivery = new Delivery(s, transport, {
      projectScope: "scope", chatGuid: () => chatKey.dm(owner), enabled: () => true, sleep: async () => {},
      statuses: since => { checks++; return transport.outboundStatuses(since); },
    });
    s.enqueue({ id: "reply", kind: "conversation", text: "Use 70% alcohol", replyTo: "inbound-1" });
    await delivery.tick();
    setSystemTime(start + 5_000);
    await delivery.tick();
    setSystemTime(start + 35_000);
    await delivery.tick();
    expect(copies).toHaveLength(1);
    expect(copies[0]!.replyTo).toBeUndefined();
    expect(s.getOperation("reply")!.state).toBe("sent");
    copies[0]!.status = "ERROR";
    setSystemTime(start + 5 * 60_000);
    await delivery.tick();
    await delivery.tick();
    expect(copies).toHaveLength(1);
    expect(checks).toBe(0);
  } finally { setSystemTime(); }
});

test("review: a recovered late unthreaded copy must not loop back to pending when it fails", async () => {
  const start = Date.parse("2026-10-29T12:00:00Z");
  setSystemTime(start);
  try {
    const copies: { handle: string; replyTo?: string; text: string; sentAt: number; status: string }[] = [];
    const events: string[] = [];
    const line = fakeLine({
      sendText: async (_chat, text, options) => {
        const handle = `copy-${copies.length + 1}`;
        copies.push({ handle, replyTo: options?.replyTo, text, sentAt: Date.now() + 1_000, status: "SENT" });
        if (copies.length === 2) throw new LineError("timeout", "timeout", true, true);
        return { handle };
      },
      outbound: async () => copies.map(copy => ({ ...copy, chat: chatKey.dm(owner) }) as LineOutbound),
    });
    const s = store();
    const transport = sbTransport(line, chatKey.dm(owner), s);
    const delivery = new Delivery(s, transport, {
      projectScope: "scope", chatGuid: () => chatKey.dm(owner), enabled: () => true, sleep: async () => {},
      statuses: since => transport.outboundStatuses(since), log: event => events.push(event),
    });
    s.enqueue({ id: "reply", kind: "conversation", text: "Use 70% alcohol", replyTo: "inbound-1" });
    await delivery.tick();
    copies[0]!.status = "ERROR";
    setSystemTime(start + 5 * 60_000);
    await delivery.tick();
    await delivery.tick();
    setSystemTime(start + 5 * 60_000 + 30_000);
    await delivery.tick();
    expect(copies).toHaveLength(2);
    expect(copies[1]!.replyTo).toBeUndefined();
    expect(s.getOperation("reply")!.state).toBe("sent");
    copies[1]!.status = "ERROR";
    for (const minutes of [6, 7]) {
      setSystemTime(start + minutes * 60_000);
      await delivery.tick();
      await delivery.tick();
    }
    expect(copies).toHaveLength(2);
    expect(events.filter(event => event === "outbound-async-unthreaded")).toHaveLength(1);
  } finally { setSystemTime(); }
});
