import { expect, test } from "bun:test";
import { LineError } from "../src/line.ts";
import { Sendblue, toInbound } from "../src/sendblue.ts";

const LINE = "+15550000";

type Call = {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body?: Record<string, unknown>;
  form?: FormData;
  signal?: AbortSignal | null;
};

function fakeFetch(handler: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const body = init?.body;
    const call: Call = {
      url,
      method: init?.method ?? "GET",
      headers: { ...(init?.headers as Record<string, string> | undefined) },
      body: typeof body === "string" ? JSON.parse(body) : undefined,
      form: body instanceof FormData ? body : undefined,
      signal: init?.signal,
    };
    calls.push(call);
    return handler(call);
  }) as unknown as typeof fetch;
  return { fetch: fetchFn, calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function makeClient(fetchFn: typeof fetch) {
  return new Sendblue({
    keyId: "key-id",
    secret: "secret",
    number: LINE,
    fetch: fetchFn,
    timing: { backoffMinMs: 1, backoffMaxMs: 2, stallMs: 5_000 },
  });
}

function sse(chunks: string[], keepOpen: boolean, signal?: AbortSignal | null) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        if (!keepOpen) {
          controller.close();
          return;
        }
        signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")), { once: true });
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

const frame = (id: string, type: string, data: Record<string, unknown>) =>
  `id: ${id}\nevent: ${type}\ndata: ${JSON.stringify({ id, type, occurred_at: "2026-10-21T10:00:00.000Z", data })}\n\n`;

test("sendText posts dm and group sends with reply_to and returns the handle", async () => {
  const fake = fakeFetch(() => json(202, { message_handle: "m1", status: "QUEUED" }));
  const client = makeClient(fake.fetch);

  expect(await client.sendText("dm:+15550001", "hello", { replyTo: "h0" })).toEqual({ handle: "m1" });
  const dm = fake.calls[0]!;
  expect(dm.url.pathname).toBe("/api/send-message");
  expect(dm.headers["sb-api-key-id"]).toBe("key-id");
  expect(dm.headers["sb-api-secret-key"]).toBe("secret");
  expect(dm.body).toEqual({ number: "+15550001", from_number: LINE, content: "hello", reply_to: { message_handle: "h0" } });

  await client.sendText("group:grp9", "hi all", { mediaUrl: "https://cdn.example/x.png" });
  expect(fake.calls[1]!.url.pathname).toBe("/api/send-group-message");
  expect(fake.calls[1]!.body).toEqual({ group_id: "grp9", from_number: LINE, content: "hi all", media_url: "https://cdn.example/x.png" });
});

test("sendApp posts the Spectrum identity and rejects groups", async () => {
  const fake = fakeFetch(() => json(202, { message_handle: "card1" }));
  const client = makeClient(fake.fetch);

  expect(
    await client.sendApp("dm:+15550001", {
      url: "https://example.com/s/1",
      caption: "Order",
      subcaption: "view it",
      imageUrl: "https://x.example/i.png",
      fallbackText: "Order placed",
    }),
  ).toEqual({ handle: "card1" });
  expect(fake.calls[0]!.body).toMatchObject({
    number: "+15550001",
    from_number: LINE,
    app_card: {
      appName: "Spectrum",
      appStoreId: 6777616651,
      extensionBundleId: "codes.photon.Spectrum.MessagesExtension",
      teamId: "P8XT6232SL",
      url: "https://example.com/s/1",
      fallbackText: "Order placed",
      layout: { caption: "Order", subcaption: "view it", imageUrl: "https://x.example/i.png" },
    },
  });

  await expect(client.sendApp("group:grp9", { url: "https://example.com", caption: "x" })).rejects.toMatchObject({ code: "unsupported", retryable: false });
  expect(fake.calls.length).toBe(1);
});

test("react, typing, read and requestLocation hit their endpoints and no-op for groups", async () => {
  const fake = fakeFetch(() => json(200, {}));
  const client = makeClient(fake.fetch);

  await client.react("h1", "🔥");
  expect(fake.calls[0]!.url.pathname).toBe("/api/send-reaction");
  expect(fake.calls[0]!.body).toEqual({ from_number: LINE, message_handle: "h1", reaction: "🔥" });

  await client.typing("dm:+15550001");
  expect(fake.calls[1]!.url.pathname).toBe("/api/send-typing-indicator");
  expect(fake.calls[1]!.body).toEqual({ number: "+15550001", from_number: LINE });

  await client.read("dm:+15550001");
  expect(fake.calls[2]!.url.pathname).toBe("/api/mark-read");
  expect(fake.calls[2]!.body).toEqual({ number: "+15550001", from_number: LINE });

  await client.requestLocation("dm:+15550001");
  expect(fake.calls[3]!.url.pathname).toBe("/api/request-location");
  expect(fake.calls[3]!.body).toEqual({ number: "+15550001", from_number: LINE });

  const before = fake.calls.length;
  await client.typing("group:grp9");
  await client.read("group:grp9");
  expect(fake.calls.length).toBe(before);
  await expect(client.requestLocation("group:grp9")).rejects.toMatchObject({ code: "unsupported" });
});

test("upload sends multipart and returns media_url", async () => {
  const fake = fakeFetch(() => json(201, { media_url: "https://storage.example/doc.pdf" }));
  const client = makeClient(fake.fetch);

  expect(await client.upload({ data: new Uint8Array([1, 2, 3]), name: "doc.pdf", mimeType: "application/pdf" })).toBe(
    "https://storage.example/doc.pdf",
  );
  expect(fake.calls[0]!.url.pathname).toBe("/api/upload-file");
  const file = fake.calls[0]!.form?.get("file");
  if (!(file instanceof File)) throw new Error("upload sent no file part");
  expect(file.name).toBe("doc.pdf");
  expect(file.type).toBe("application/pdf");
});

test("download enforces the byte cap and reads name and mime", async () => {
  const fake = fakeFetch(
    () =>
      new Response(new Uint8Array([9, 8, 7]), {
        headers: { "content-type": "image/png; charset=x", "content-disposition": 'attachment; filename="photo one.png"' },
      }),
  );
  const client = makeClient(fake.fetch);

  expect(await client.download("https://cdn.example/att/abc.png", 100, 1_000)).toEqual({
    data: new Uint8Array([9, 8, 7]),
    name: "photo one.png",
    mimeType: "image/png",
  });

  const big = makeClient(fakeFetch(() => new Response(new Uint8Array(50), { headers: { "content-type": "video/mp4" } })).fetch);
  await expect(big.download("https://cdn.example/att/big.mp4", 10, 1_000)).rejects.toMatchObject({ code: "too_large", retryable: false });
});

test("getMessage returns undefined on 404 and maps inbound and outbound rows", async () => {
  const fake = fakeFetch((call) => {
    if (call.url.pathname.endsWith("/missing")) return json(404, { message: "not found" });
    if (call.url.pathname.endsWith("/in1")) return json(200, { data: { message_handle: "in1", from_number: "+15550001", content: "x", is_outbound: false } });
    return json(200, { message_handle: "out1", is_outbound: true, number: "+15550001", content: "y", status: "SENT" });
  });
  const client = makeClient(fake.fetch);

  expect(await client.getMessage("missing")).toBeUndefined();
  expect(await client.getMessage("in1")).toMatchObject({ handle: "in1", chat: "dm:+15550001", text: "x", kind: "other" });
  expect(await client.getMessage("out1")).toMatchObject({ handle: "out1", chat: "dm:+15550001", text: "y", status: "SENT" });
});

test("location returns the shared fix only when the contact is sharing", async () => {
  const fake = fakeFetch((call) => {
    if (call.url.pathname.endsWith("/%2B15550001")) {
      return json(200, {
        number: "+15550001",
        state: "shared_with_fix",
        location: { latitude: 25, longitude: 55, accuracy: 10, timestamp: "2026-10-21T10:00:00.000Z" },
      });
    }
    return json(200, { number: "+15550002", state: "not_shared" });
  });
  const client = makeClient(fake.fetch);

  const fix = await client.location("+15550001");
  expect(fix).toMatchObject({ latitude: 25, longitude: 55, accuracy: 10 });
  expect(fake.calls[0]!.url.searchParams.get("from_number")).toBe(LINE);
  expect(await client.location("+15550002")).toBeUndefined();
});

test("backfill pages through updated messages and keeps inbound rows for our line", async () => {
  const row = (handle: string, line: string) => ({
    message_handle: handle,
    from_number: "+15550001",
    to_number: line,
    sendblue_number: line,
    is_outbound: false,
    content: handle,
    date_sent: "2026-10-21T10:00:00.000Z",
  });
  const page1 = Array.from({ length: 100 }, (_, i) => row(`h${i}`, LINE));
  const page2 = [row("tail", LINE), row("other", "+19999999999")];
  const fake = fakeFetch((call) => (call.url.searchParams.get("offset") === "0" ? json(200, { data: page1 }) : json(200, { data: page2 })));
  const client = makeClient(fake.fetch);

  const rows = await client.backfill(Date.parse("2026-10-21T00:00:00Z"));
  expect(rows.length).toBe(101);
  expect(rows[100]).toMatchObject({ handle: "tail", chat: "dm:+15550001" });
  expect(fake.calls.length).toBe(2);
  const query = fake.calls[0]!.url.searchParams;
  expect(query.get("updated_at_gte")).toBe("2026-10-21T00:00:00.000Z");
  expect(query.get("is_outbound")).toBe("false");
  expect(query.get("sendblue_number")).toBe(LINE);
  expect(query.get("order_by")).toBe("updated_at");
  expect(query.get("order_direction")).toBe("asc");
});

test("outbound filters to the requested chat", async () => {
  const fake = fakeFetch(() =>
    json(200, {
      data: [
        { message_handle: "o1", is_outbound: true, number: "+15550001", content: "sent", status: "SENT", date_sent: "2026-10-21T10:00:00.000Z" },
        { message_handle: "o2", is_outbound: true, number: "+15550009", content: "other", status: "SENT", date_sent: "2026-10-21T10:00:00.000Z" },
      ],
    }),
  );
  const client = makeClient(fake.fetch);

  const rows = await client.outbound("dm:+15550001", 0);
  expect(rows.map((row) => row.handle)).toEqual(["o1"]);
  expect(fake.calls[0]!.url.searchParams.get("number")).toBe("+15550001");
  expect(fake.calls[0]!.url.searchParams.get("is_outbound")).toBe("true");
});

test("toInbound maps group, location and reply fields", () => {
  const group = toInbound({
    message_handle: "g1",
    from_number: "+15550002",
    group_id: "grp9",
    group_display_name: "Crew",
    participants: ["+15550002", "+15550003"],
    content: "yo",
    message_type: "group",
    service: "iMessage",
    date_sent: "2026-10-21T10:00:00.000Z",
  });
  expect(group).toMatchObject({ handle: "g1", chat: "group:grp9", groupName: "Crew", kind: "message", participants: ["+15550002", "+15550003"] });
  expect(group.sentAt).toBe(Date.parse("2026-10-21T10:00:00.000Z"));

  const location = toInbound({
    message_handle: "l1",
    from_number: "+15550001",
    message_type: "location",
    location: { latitude: 25.1, longitude: 55.2, accuracy: 5, timestamp: "2026-10-21T10:00:00.000Z" },
  });
  expect(location).toMatchObject({ kind: "location", chat: "dm:+15550001", location: { latitude: 25.1, longitude: 55.2, accuracy: 5 } });

  const reply = toInbound({ message_handle: "r1", from_number: "+15550001", content: "re", reply_to: { message_handle: "h1" } });
  expect(reply.replyTo).toBe("h1");
});

test("events parses split frames, skips heartbeats, dedupes across reconnects and stops on abort", async () => {
  const messageOne = frame("e1", "message.received", {
    message_handle: "h1",
    from_number: "+15550001",
    to_number: LINE,
    sendblue_number: LINE,
    content: "hi",
    is_outbound: false,
    date_sent: "2026-10-21T10:00:00.000Z",
  });
  const messageTwo = frame("e2", "message.received", {
    message_handle: "h2",
    from_number: "+15550001",
    content: "there",
    is_outbound: false,
  });
  const typing = frame("e3", "typing.changed", { number: "+15550001", is_typing: true });
  const status = frame("e4", "message.updated", { message_handle: "h9", is_outbound: true, status: "ERROR", error_reason: "nope" });

  let connection = 0;
  const fake = fakeFetch((call) => {
    if (!call.url.pathname.endsWith("/api/v2/events")) throw new Error(`unexpected ${call.url}`);
    connection += 1;
    if (connection === 1) {
      // Split mid-frame, plus a heartbeat comment; the stream then ends, forcing a reconnect.
      return sse([": heartbeat\n\n" + messageOne.slice(0, 20), messageOne.slice(20)], false);
    }
    // The reconnect replays e1; it must be dropped.
    return sse([messageOne + messageTwo + typing + status], true, call.signal);
  });
  const client = makeClient(fake.fetch);

  const controller = new AbortController();
  const events: Array<{ type: string; text?: string; status?: string; typing?: boolean }> = [];
  for await (const event of client.events(controller.signal)) {
    if (event.type === "message") events.push({ type: "message", text: event.message.text });
    else if (event.type === "typing") events.push({ type: "typing", typing: event.typing });
    else events.push({ type: "status", status: event.status });
    if (events.length === 4) {
      controller.abort();
      break;
    }
  }

  expect(events).toEqual([
    { type: "message", text: "hi" },
    { type: "message", text: "there" },
    { type: "typing", typing: true },
    { type: "status", status: "ERROR" },
  ]);
  expect(connection).toBe(2);
  expect(fake.calls[0]!.headers.accept).toBe("text/event-stream");
});

test("events returns immediately when the signal is already aborted", async () => {
  const fake = fakeFetch(() => sse([], false));
  const client = makeClient(fake.fetch);
  const controller = new AbortController();
  controller.abort();

  const seen: unknown[] = [];
  for await (const event of client.events(controller.signal)) seen.push(event);
  expect(seen).toEqual([]);
  expect(fake.calls.length).toBe(0);
});

test("errors are classified for retry and uncertainty", async () => {
  const failing = (status: number, body: unknown = {}) => makeClient(fakeFetch(() => json(status, body)).fetch);

  await expect(failing(429).sendText("dm:+15550001", "x")).rejects.toMatchObject({ retryable: true, uncertain: false, code: "http_429" });
  await expect(failing(500).sendText("dm:+15550001", "x")).rejects.toMatchObject({ retryable: true, uncertain: true, code: "http_500" });
  await expect(failing(400, { message: "bad number", error_key: "invalid_number" }).sendText("dm:+15550001", "x")).rejects.toMatchObject({
    retryable: false,
    uncertain: false,
    code: "http_400:invalid_number",
  });
  await expect(failing(500).getMessage("h1")).rejects.toMatchObject({ retryable: true, uncertain: false });
  await expect(failing(200, {}).sendText("dm:+15550001", "x")).rejects.toMatchObject({ code: "no_handle", uncertain: true });

  const dropped = makeClient(
    fakeFetch(() => {
      throw new TypeError("socket hang up");
    }).fetch,
  );
  const sendFailure = await dropped.sendText("dm:+15550001", "x").catch((error: unknown) => error);
  expect(sendFailure).toBeInstanceOf(LineError);
  expect(sendFailure).toMatchObject({ code: "network", retryable: true, uncertain: true });
  const readFailure = await dropped.location("+15550001").catch((error: unknown) => error);
  expect(readFailure).toMatchObject({ code: "network", retryable: true, uncertain: false });
});
