import { afterEach, beforeEach, describe, expect, jest, mock, setSystemTime, spyOn, test } from "bun:test";
import * as grpc from "@photon-ai/advanced-imessage/grpc";
import { Photon, TransportError, canonicalOwnerChat, classifySendFailure, inboundOccurredAt, normalizeInbound, ownerChatGuid } from "../src/photon.ts";

const owner = "+15555550123";
const chatGuid = `iMessage;-;${owner}`;
const canonicalChatGuid = `any;-;${owner}`;
const timestamp = "2026-09-10T00:00:00.000Z";
const address = { address: owner, service: "CHAT_SERVICE_TYPE_IMESSAGE" };

// Proto3-JSON fixtures are decoded by the installed SDK, not hand-cast to its types.
function received(message: Record<string, unknown> = {}, context: Record<string, unknown> = {}) {
  const event = grpc.parseMessageChangeEvent({
    chatGuid, occurredAt: timestamp, actor: address, isFromMe: false,
    messageReceived: {
      message: {
        guid: "inbound-guid", dateCreated: timestamp, sender: address,
        isFromMe: false, chatGuids: [chatGuid], itemType: "MESSAGE_ITEM_TYPE_NORMAL",
        content: { text: "Hello", attachments: [] }, ...message,
      },
    },
    ...context,
  }, 12);
  if (event?.type !== "message.received") throw new Error("Invalid received fixture");
  return event;
}

function changed(change: Record<string, unknown>) {
  const event = grpc.parseMessageChangeEvent({
    chatGuid, occurredAt: timestamp, actor: address, isFromMe: false, ...change,
  }, 13);
  if (!event) throw new Error("Invalid change fixture");
  return event;
}

function rawAttachment(extra: Record<string, unknown> = {}) {
  return {
    guid: "attachment-guid", fileName: "voice.caf", mimeType: "audio/x-caf", uti: "com.apple.coreaudio-format",
    totalBytes: "3", transferState: "TRANSFER_STATE_FINISHED", ...extra,
  };
}

function attachment(): grpc.AttachmentInfo {
  return received({ content: { attachments: [rawAttachment()] } }).message.content.attachments[0]!;
}

describe("ownerChatGuid", () => {
  test.each([owner, "owner@example.com"])("accepts only the two exact DM forms for %s", identity => {
    for (const prefix of ["any", "iMessage"]) {
      expect(ownerChatGuid(`${prefix};-;${identity}`, identity)).toBe(true);
    }
    for (const guid of [
      `SMS;-;${identity}`, `RCS;-;${identity}`, `other;-;${identity}`, `ANY;-;${identity}`,
      `any;+;${identity}`, `iMessage;+;${identity}`, `any;-;${identity};extra`,
      `any;-;${identity} `, ` any;-;${identity}`, `any;-;other@example.com`, identity,
    ]) expect(ownerChatGuid(guid, identity)).toBe(false);
  });

  test.each(["", " ", ` ${owner}`, `${owner};extra`, `${owner}\n`])("rejects invalid owner %j", identity => {
    expect(ownerChatGuid(`any;-;${identity}`, identity)).toBe(false);
  });
});

describe("canonicalOwnerChat", () => {
  test.each([owner, "owner@example.com"])("canonicalizes only an exact owner alias for %s", identity => {
    for (const prefix of ["any", "iMessage"]) {
      expect(canonicalOwnerChat(`${prefix};-;${identity}`, identity)).toBe(`any;-;${identity}`);
    }
  });

  test.each([
    "", owner, `SMS;-;${owner}`, `RCS;-;${owner}`, `ANY;-;${owner}`, `any;+;${owner}`,
    `any;-;${owner};extra`, `any;-;${owner}\n`, ` ${canonicalChatGuid}`, "any;-;+15555550999",
  ])("rejects unauthorized GUID %j without leaking it", guid => {
    expect(() => canonicalOwnerChat(guid, owner)).toThrow("Photon transport failed (unauthorized)");
  });

  test.each(["", " ", `${owner};extra`, `${owner}\n`])("rejects invalid owner %j", identity => {
    expect(() => canonicalOwnerChat(`any;-;${identity}`, identity)).toThrow("unauthorized");
  });
});

describe("classifySendFailure", () => {
  test.each([14, 4, 1, 2, 13])("gRPC status %i is uncertain and retryable despite missing retry metadata", grpcCode => {
    const error = new grpc.IMessageError("private send details", {
      code: "internalError", grpcCode, retryable: false, context: { recipient: owner },
    });
    expect(classifySendFailure(error)).toEqual({ retryable: true, uncertain: true, code: "internalError" });
    expect(error.retryable).toBe(false);
  });

  test.each([3, 5, 7, 9, 11, 12, 16])("gRPC rejection %i is permanent even with a retry hint", grpcCode => {
    const error = new grpc.IMessageError("private rejection details", { code: "internalError", grpcCode, retryable: true });
    expect(classifySendFailure(error)).toEqual({ retryable: false, uncertain: false, code: "internalError" });
  });

  test.each([
    new grpc.AuthenticationError("private credentials", { code: "unauthenticated", grpcCode: 16, retryable: false }),
    new grpc.AuthenticationError("private identity", { code: "unauthorized", grpcCode: 7, retryable: false }),
    new grpc.ValidationError("private argument", { code: "invalidArgument", grpcCode: 3, retryable: false }),
    new grpc.ValidationError("private precondition", { code: "preconditionFailed", grpcCode: 9, retryable: false }),
  ])("classifies SDK auth and validation errors without raw context %#", error => {
    expect(classifySendFailure(error)).toEqual({ retryable: false, uncertain: false, code: error.code });
  });

  test.each([false, true])("quota rejection respects retryable=%s without implying delivery", retryable => {
    const error = new grpc.RateLimitError("private quota", { code: "dailyLimitExceeded", grpcCode: 8, retryable });
    expect(classifySendFailure(error)).toEqual({ retryable, uncertain: false, code: "dailyLimitExceeded" });
  });

  test.each([
    new TransportError("unauthorized"), new TransportError("invalidOperationId"),
    new TransportError("tokenHttp401"), new TransportError("tokenHttp503", true),
    new TransportError("tokenNetwork", true), new TransportError("closed"),
    new TransportError("tokenNetwork", true, true),
    new TransportError("catchupTimeout", true), new TransportError("catchupIncomplete", true),
    new TransportError("attachmentTimeout", true), new TransportError("invalidAttachment"),
    new TransportError("attachmentTooLarge"),
  ])("preserves explicit transport retry and ambiguity flags %#", error => {
    expect(classifySendFailure(error)).toEqual({ retryable: error.retryable, uncertain: error.ambiguous, code: error.code });
  });

  test.each([
    undefined, null, "private exception", new Error("private exception"),
    Object.assign(new Error("private details"), { code: "unauthorized", retryable: false, ambiguous: false }),
    new grpc.IMessageError("private details", { code: "internalError", grpcCode: 0, retryable: false }),
  ])("unknown failures never claim that a send did not happen %#", error => {
    expect(classifySendFailure(error)).toEqual({
      retryable: true, uncertain: true, code: error instanceof grpc.IMessageError ? "internalError" : "unknownSendFailure",
    });
  });

  test("unrecognized SDK or transport codes cannot leak into logs", () => {
    const error = new grpc.IMessageError("private exception", { code: "internalError", grpcCode: 14, retryable: false });
    for (const code of ["privateSecret", "https://private.invalid/?token=secret", "bad\ncode", "tokenHttp401\n"]) {
      expect(classifySendFailure(Object.assign(error, { code }))).toEqual({ retryable: true, uncertain: true, code: "unknownSendFailure" });
      expect(classifySendFailure(new TransportError(code))).toEqual({ retryable: true, uncertain: true, code: "unknownSendFailure" });
    }
  });
});

describe("inboundOccurredAt", () => {
  test("reads milliseconds from the SDK Date, not message creation or the current clock", () => {
    const event = received({ dateCreated: "2026-09-09T00:00:00.000Z" });
    expect(event.occurredAt).toBeInstanceOf(Date);
    expect(inboundOccurredAt(event)).toBe(Date.parse(timestamp));
    expect(inboundOccurredAt(received({}, { occurredAt: "1970-01-01T00:00:00.000Z" }))).toBe(0);
  });

  test("missing or invalid timestamps and non-inbound events have no timestamp fallback", () => {
    for (const occurredAt of [new Date(NaN), undefined, timestamp, Date.parse(timestamp)]) {
      expect(inboundOccurredAt(Object.assign(received(), { occurredAt }))).toBeUndefined();
    }
    expect(inboundOccurredAt({ type: "catchup.complete", headSequence: 14 })).toBeUndefined();
    expect(inboundOccurredAt(changed({ messageRead: { messageGuid: "target", readAt: timestamp } }))).toBeUndefined();
  });
});

describe("normalizeInbound", () => {
  test("normalizes SDK-decoded text and prefers the canonical reply target", () => {
    const event = received({ replyTargetGuid: "real-parent", replyToGuid: "unrelated", threadOriginatorGuid: "thread-root" });
    expect(normalizeInbound(event, owner, chatGuid)).toEqual({
      id: "inbound-guid", text: "Hello", replyTo: "real-parent", isAudioMessage: false, attachments: [], source: "typed",
    });
    expect(normalizeInbound(received({ replyToGuid: "unrelated" }), owner, chatGuid)?.replyTo).toBeUndefined();
    expect(normalizeInbound(received({ replyTargetGuid: "inbound-guid" }), owner, chatGuid)?.replyTo).toBeUndefined();
  });

  test.each([undefined, "", "inbound-guid"])("falls back to threadOriginatorGuid for replyTargetGuid %j", replyTargetGuid => {
    expect(normalizeInbound(received({ replyTargetGuid, threadOriginatorGuid: "thread-root" }), owner, chatGuid)?.replyTo).toBe("thread-root");
    for (const threadOriginatorGuid of [undefined, "", "inbound-guid"]) {
      expect(normalizeInbound(received({ replyTargetGuid, threadOriginatorGuid }), owner, chatGuid)?.replyTo).toBeUndefined();
    }
  });

  test.each([canonicalChatGuid, chatGuid])("accepts either alias of owner DM %s without relaxing event or sender matching", dm => {
    for (const storedGuid of [canonicalChatGuid, chatGuid]) {
      for (const chatGuids of [[canonicalChatGuid], [chatGuid], [canonicalChatGuid, chatGuid], []]) {
        const event = received({ chatGuids }, { chatGuid: dm });
        expect(normalizeInbound(event, owner, storedGuid)).toEqual({
          id: "inbound-guid", text: "Hello", isAudioMessage: false, attachments: [], source: "typed",
        });
        expect(event.chatGuid).toBe(dm);
        expect(event.message.chatGuids).toEqual(chatGuids);
      }
    }
    for (const sender of [undefined, { ...address, address: "+15555550999" }]) {
      expect(normalizeInbound(received({ chatGuids: [dm], sender }, { chatGuid: dm }), owner, dm)).toBeUndefined();
    }
    expect(normalizeInbound(received({ chatGuids: [dm], isFromMe: true }, { chatGuid: dm }), owner, dm)).toBeUndefined();
    expect(normalizeInbound(received({ chatGuids: [dm] }, { chatGuid: dm, isFromMe: true }), owner, dm)).toBeUndefined();
    expect(normalizeInbound(received({ chatGuids: [dm] }, { chatGuid: dm, actor: { ...address, address: "+15555550999" } }), owner, dm)).toBeUndefined();
  });

  test("voice and mixed attachments serialize as metadata, with no lazy accessors", () => {
    const event = received({
      isAudioMessage: true,
      content: { text: "\uFFFC", attachments: [rawAttachment()] },
    });
    const download = mock(() => { throw new Error("must not download"); });
    Object.assign(event.message.content.attachments[0]!, { download, data: download });
    const normalized = normalizeInbound(event, owner, chatGuid)!;
    expect(normalized.text).toBe("");
    expect(normalized.isAudioMessage).toBe(true);
    expect(normalized.attachments).toEqual([attachment()]);
    expect(JSON.parse(JSON.stringify(normalized))).toEqual(normalized);
    expect(Object.values(normalized.attachments[0]!)).not.toContain(download);
    expect(download).not.toHaveBeenCalled();
    const mixed = received({ content: { text: "Photo\n\uFFFC", attachments: [rawAttachment({ mimeType: "image/jpeg", fileName: "photo.jpg" })] } });
    expect(normalizeInbound(mixed, owner, chatGuid)?.text).toBe("Photo\n");
    expect(normalizeInbound(mixed, owner, chatGuid)?.attachments[0]?.mimeType).toBe("image/jpeg");
  });

  test.each([
    { sender: undefined },
    { sender: { ...address, address: "+15555550999" } },
    { sender: { ...address, address: ` ${owner}` } },
    { sender: { ...address, address: owner.slice(1) } },
    { isFromMe: true },
    { chatGuids: ["iMessage;+;group"] },
    { chatGuids: [chatGuid, "iMessage;+;group"] },
    { chatGuids: [canonicalChatGuid, "iMessage;-;+15555550999"] },
    { chatGuids: [chatGuid, "any;-;+15555550999"] },
    { chatGuids: [chatGuid, `SMS;-;${owner}`] },
    { isSystemMessage: true },
    { isServiceMessage: true },
    { isCorrupt: true },
    { itemType: "MESSAGE_ITEM_TYPE_CHAT_ACTION" },
    { guid: "" },
  ])("rejects unauthorized or non-user message metadata %j", message => {
    expect(normalizeInbound(received(message), owner, chatGuid)).toBeUndefined();
  });

  test("event context cannot be overridden by the target message's owner", () => {
    expect(normalizeInbound(received({}, { actor: { ...address, address: "+15555550999" } }), owner, chatGuid)).toBeUndefined();
    expect(normalizeInbound(received({}, { isFromMe: true }), owner, chatGuid)).toBeUndefined();
    expect(normalizeInbound(received({}, { chatGuid: "iMessage;+;group" }), owner, chatGuid)).toBeUndefined();
    expect(normalizeInbound(received({}, { chatGuid: "iMessage;+;group" }), owner, "iMessage;+;group")).toBeUndefined();
    for (const guid of ["any;-;+15555550999", "iMessage;-;+15555550999", `SMS;-;${owner}`, `${canonicalChatGuid}\n`]) {
      expect(normalizeInbound(received({}, { chatGuid: guid }), owner, canonicalChatGuid)).toBeUndefined();
      expect(normalizeInbound(received(), owner, guid)).toBeUndefined();
    }
    expect(normalizeInbound(received(), owner, `SMS;-;${owner}`)).toBeUndefined();
    expect(normalizeInbound(received({ chatGuids: [] }, { actor: undefined }), owner, chatGuid)?.text).toBe("Hello");
  });

  test("missing direction flags or conflicting actors cannot inherit message authorization", () => {
    const event = received({}, { chatGuid: canonicalChatGuid });
    expect(normalizeInbound(Object.assign(event, { isFromMe: undefined }), owner, canonicalChatGuid)).toBeUndefined();
    const missingMessageDirection = received();
    Object.assign(missingMessageDirection.message, { isFromMe: undefined });
    expect(normalizeInbound(missingMessageDirection, owner, canonicalChatGuid)).toBeUndefined();
    for (const actor of [{ ...address, address: ` ${owner}` }, { ...address, address: owner.slice(1) }]) {
      expect(normalizeInbound(received({}, { actor }), owner, canonicalChatGuid)).toBeUndefined();
    }
  });

  test("exact email identity is required too", () => {
    const email = "owner@example.com";
    const dm = `iMessage;-;${email}`;
    const event = received({ sender: { ...address, address: email }, chatGuids: [dm] }, { actor: undefined, chatGuid: dm });
    expect(normalizeInbound(event, email, dm)?.text).toBe("Hello");
    expect(normalizeInbound(event, "Owner@example.com", dm)).toBeUndefined();
  });

  test("skips receipt, edit, unsend, reaction, sticker, and completion events", () => {
    const events: grpc.CatchUpEvent[] = [
      changed({ messageRead: { messageGuid: "target", readAt: timestamp } }),
      changed({ messageEdited: { messageGuid: "target", editedAt: timestamp, content: { text: "Edit" } } }),
      changed({ messageUnsent: { messageGuid: "target", retractedAt: timestamp } }),
      changed({ reactionAdded: { messageGuid: "target", reaction: { kind: "MESSAGE_REACTION_KIND_LIKE" } } }),
      changed({ reactionRemoved: { messageGuid: "target", reaction: { kind: "MESSAGE_REACTION_KIND_LIKE" } } }),
      changed({ stickerPlaced: { messageGuid: "target", sticker: rawAttachment() } }),
      { type: "catchup.complete", headSequence: 14 },
    ];
    for (const event of events) expect(normalizeInbound(event, owner, chatGuid)).toBeUndefined();
  });

  test.each([
    { reaction: { kind: "MESSAGE_REACTION_KIND_LOVE" } },
    { reactionTargetGuid: "target" },
    { reactionSelected: false },
    { reactionSelected: true },
  ])("skips tapback rows even if received as text: %j", fields => {
    expect(normalizeInbound(received(fields), owner, chatGuid)).toBeUndefined();
  });

  test("existing reactions on an ordinary message do not suppress that message", () => {
    expect(normalizeInbound(received({ appliedReactions: [{
      messageGuid: "tapback", dateCreated: timestamp, reaction: { kind: "MESSAGE_REACTION_KIND_LIKE" },
    }] }), owner, chatGuid)?.text).toBe("Hello");
  });

  test("skips empty content and hidden, outgoing, or sticker artifacts", () => {
    expect(normalizeInbound(received({ content: { text: " \n\uFFFC" } }), owner, chatGuid)).toBeUndefined();
    for (const flags of [{ isHidden: true }, { isOutgoing: true }, { isSticker: true }, { guid: "" }]) {
      expect(normalizeInbound(received({ content: { attachments: [rawAttachment(flags)] } }), owner, chatGuid)).toBeUndefined();
    }
    const pending = received({ content: { attachments: [rawAttachment({ transferState: "TRANSFER_STATE_PENDING" })] } });
    expect(normalizeInbound(pending, owner, chatGuid)?.attachments[0]?.transferState).toBe("pending");
  });
});

describe("Photon transport (mocked, no network)", () => {
  const clients: Photon[] = [];
  const envKeys = ["SPECTRUM_CLOUD_URL", "SPECTRUM_IMESSAGE_ADDRESS"] as const;
  let savedEnv: (string | undefined)[];
  let options: grpc.ClientOptions | undefined;
  let factory: ReturnType<typeof spyOn<typeof grpc, "createGrpcClient">>;
  type Fetch = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => Promise<Response>;
  let fetchMock: ReturnType<typeof spyOn<{ fetch: Fetch }, "fetch">>;
  let fake: {
    messages: { sendText: ReturnType<typeof mock>; sendAttachment: ReturnType<typeof mock>; get: ReturnType<typeof mock>; setReaction: ReturnType<typeof mock> };
    chats: { setTyping: ReturnType<typeof mock>; markRead: ReturnType<typeof mock>; get: ReturnType<typeof mock> };
    events: { catchUp: ReturnType<typeof mock> };
    attachments: { downloadStream: ReturnType<typeof mock>; upload: ReturnType<typeof mock> };
    close: ReturnType<typeof mock>;
  };

  function client() {
    const photon = new Photon("project-test", "test-only-secret");
    clients.push(photon);
    return photon;
  }

  function tokenResponse(token = "test-token", expiresIn = 100) {
    return Response.json({ succeed: true, data: { type: "shared", token, expiresIn } });
  }

  function tokenCallback() {
    if (typeof options?.token !== "function") throw new Error("Missing token callback");
    return options.token;
  }

  beforeEach(() => {
    savedEnv = envKeys.map(key => process.env[key]);
    for (const key of envKeys) delete process.env[key];
    options = undefined;
    fake = {
      messages: {
        sendText: mock(async () => ({ guid: "provider-guid" })),
        sendAttachment: mock<grpc.MessagesResource["sendAttachment"]>(async () => received({ guid: "provider-attachment-guid" }).message),
        get: mock(async () => received().message),
        setReaction: mock(async () => received().message),
      },
      chats: {
        setTyping: mock(async () => {}),
        markRead: mock(async () => {}),
        get: mock(async () => ({ guid: chatGuid, isGroup: false })),
      },
      events: { catchUp: mock(() => { throw new Error("Unexpected catch-up"); }) },
      attachments: {
        downloadStream: mock(() => { throw new Error("Unexpected download"); }),
        upload: mock<grpc.AttachmentsResource["upload"]>(async () => ({ attachment: attachment() })),
      },
      close: mock(async () => {}),
    };
    factory = spyOn(grpc, "createGrpcClient").mockImplementation(config => {
      options = config;
      return fake as unknown as grpc.AdvancedIMessage;
    });
    fetchMock = spyOn(globalThis as { fetch: Fetch }, "fetch").mockImplementation(async () => tokenResponse());
  });

  afterEach(async () => {
    await Promise.all(clients.splice(0).map(photon => photon.close()));
    mock.restore();
    jest.useRealTimers();
    setSystemTime();
    envKeys.forEach((key, i) => {
      if (savedEnv[i] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[i];
    });
  });

  test("constructor is lazy and check only issues tokens to the fixed authenticated endpoint", async () => {
    const photon = client();
    expect(factory).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    await photon.check();
    expect(factory).not.toHaveBeenCalled();
    expect(fake.messages.sendText).not.toHaveBeenCalled();
    expect(fake.messages.get).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://spectrum.photon.codes/projects/project-test/imessage/tokens");
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("error");
    expect(init).toMatchObject({ proxy: "", verbose: false });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(new Headers(init?.headers).get("authorization")).toBe(`Basic ${btoa("project-test:test-only-secret")}`);
  });

  test("gRPC is fixed TLS, gets a callback, and never enables implicit retries", async () => {
    const photon = client();
    await photon.typing(chatGuid, true);
    expect(options).toMatchObject({
      address: "imessage.spectrum.photon.codes:443", tls: true, autoIdempotency: false, retry: false,
      channelOptions: { "grpc.enable_http_proxy": 0 },
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await tokenCallback()()).toBe("test-token");
  });

  test("initial token issue and refresh at exactly 80% TTL are singleflight", async () => {
    setSystemTime(new Date(timestamp));
    const start = Date.now();
    const photon = client();
    let resolve!: (response: Response) => void;
    fetchMock.mockImplementation(() => new Promise<Response>(done => { resolve = done; }));
    const initial = [photon.check(), photon.check(), photon.check()];
    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolve(tokenResponse());
    await Promise.all(initial);
    await photon.typing(chatGuid, true);
    const token = tokenCallback();
    setSystemTime(start + 79_999);
    expect(await token()).toBe("test-token");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    setSystemTime(start + 80_000);
    const refresh = [token(), token(), token()];
    expect(fetchMock).toHaveBeenCalledTimes(2);
    resolve(tokenResponse("refreshed-token", 200));
    expect(await Promise.all(refresh)).toEqual(["refreshed-token", "refreshed-token", "refreshed-token"]);
    setSystemTime(start + 239_999);
    expect(await token()).toBe("refreshed-token");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("failed refresh does not reuse expired tokens and releases the singleflight lock", async () => {
    setSystemTime(new Date(timestamp));
    const start = Date.now();
    const photon = client();
    await photon.check();
    setSystemTime(start + 100_000);
    fetchMock.mockImplementationOnce(async () => new Response("private token error", { status: 503 }));
    const outcomes = await Promise.allSettled([photon.check(), photon.check()]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const outcome of outcomes) {
      expect(outcome.status).toBe("rejected");
      if (outcome.status === "rejected") expect(outcome.reason).toMatchObject({ code: "tokenHttp503", retryable: true, ambiguous: false });
    }
    await photon.check();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  test.each([
    null, {}, { succeed: false },
    { succeed: true, data: { type: "dedicated", auth: {}, numbers: {}, expiresIn: 100 } },
    ...[0, -1, "100", null, 1e100].map(expiresIn => ({ succeed: true, data: { type: "shared", token: "secret", expiresIn } })),
    { succeed: true, data: { type: "shared", token: "", expiresIn: 100 } },
    { succeed: true, data: { type: "other", token: "secret", expiresIn: 100 } },
  ])("rejects non-shared or invalid token payloads %j", async payload => {
    fetchMock.mockImplementation(async () => Response.json(payload));
    await expect(client().check()).rejects.toBeInstanceOf(TransportError);
    expect(factory).not.toHaveBeenCalled();
  });

  test("token errors do not expose response bodies or network credentials", async () => {
    const photon = client();
    fetchMock.mockImplementationOnce(async () => new Response("private-secret", { status: 401 }));
    await expect(photon.check()).rejects.toThrow("Photon transport failed (tokenHttp401)");
    fetchMock.mockImplementationOnce(async () => { throw new Error("private-secret"); });
    await expect(photon.check()).rejects.toThrow("Photon transport failed (tokenNetwork)");
    fetchMock.mockImplementationOnce(async () => new Response("private-invalid-json"));
    await expect(photon.check()).rejects.toThrow("Photon transport failed (invalidTokenResponse)");
  });

  test.each([...envKeys])("rejects unsafe %s without contacting any endpoint", key => {
    process.env[key] = "https://untrusted.invalid";
    expect(() => client()).toThrow("Photon transport failed (endpointOverride)");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(factory).not.toHaveBeenCalled();
  });

  test("later environment changes cannot redirect either fixed endpoint", async () => {
    const photon = client();
    process.env.SPECTRUM_CLOUD_URL = "https://untrusted.invalid";
    process.env.SPECTRUM_IMESSAGE_ADDRESS = "untrusted.invalid:443";
    await photon.check();
    await photon.typing(chatGuid, true);
    expect(String(fetchMock.mock.calls[0]![0])).toStartWith("https://spectrum.photon.codes/");
    expect(options?.address).toBe("imessage.spectrum.photon.codes:443");
  });

  test("sends with the exact stable operation ID and reply target", async () => {
    const photon = client();
    const input = { id: "outbox:reminder:1", chatGuid, text: "Private message", replyTo: "parent-guid" };
    expect(await photon.sendText(input)).toEqual({ providerId: "provider-guid" });
    await photon.sendText(input);
    expect(fake.messages.sendText.mock.calls).toEqual([
      [canonicalChatGuid, input.text, { clientMessageId: input.id, replyTo: "parent-guid" }],
      [canonicalChatGuid, input.text, { clientMessageId: input.id, replyTo: "parent-guid" }],
    ]);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  test.each(["voice.caf", "Original photo (1).jpg", "archive.tar.gz", "caf\u00e9.png", " original.txt "])("uploads exact bytes with unchanged basename %j using only public SDK fields", async name => {
    const photon = client();
    const data = new Uint8Array([9, 1, 2, 3, 9]).subarray(1, 4);
    const input = { id: "outbox:upload:1", data, name, mimeType: "application/octet-stream" };
    expect(await photon.uploadAttachment(input)).toEqual({ guid: "attachment-guid" });
    await photon.uploadAttachment(input);
    const request = { data, fileName: name } satisfies grpc.AttachmentInput;
    expect(fake.attachments.upload.mock.calls).toEqual([[request], [request]]);
    expect(fake.attachments.upload.mock.calls[0]![0].data).toBe(data);
    expect(options).toMatchObject({ autoIdempotency: false, retry: false, timeout: 30_000 });
    expect(fake.messages.sendAttachment).not.toHaveBeenCalled();
    expect(fake.messages.sendText).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test.each([0, 20 * 1024 * 1024])("accepts %i upload bytes", async size => {
    const data = new Uint8Array(size);
    expect(await client().uploadAttachment({ id: "upload-id", data, name: "original.bin", mimeType: "application/octet-stream" })).toEqual({ guid: "attachment-guid" });
    expect(fake.attachments.upload).toHaveBeenCalledWith({ data, fileName: "original.bin" });
  });

  test("rejects uploads above 20 MiB before any RPC", async () => {
    await expect(client().uploadAttachment({
      id: "upload-id", data: new Uint8Array(20 * 1024 * 1024 + 1), name: "original.bin", mimeType: "application/octet-stream",
    })).rejects.toThrow("Photon transport failed (attachmentTooLarge)");
    expect(factory).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test.each(["", " ", ".", "..", "../private.caf", "/private.caf", "folder/private.caf", "folder\\private.caf", "C:private.caf", "C:\\private.caf", "private.caf/", "private\n.caf", "private\0.caf", "private\x7f.caf"])("rejects unsafe upload basename %j rather than rewriting it", async name => {
    await expect(client().uploadAttachment({ id: "upload-id", data: new Uint8Array([1]), name, mimeType: "audio/x-caf" }))
      .rejects.toThrow("Photon transport failed (invalidAttachment)");
    expect(factory).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test.each(["", " ", "audio/x-caf\nprivate", "audio/\0caf"])("rejects invalid MIME metadata %j without forwarding it", async mimeType => {
    await expect(client().uploadAttachment({ id: "upload-id", data: new Uint8Array([1]), name: "voice.caf", mimeType }))
      .rejects.toThrow("Photon transport failed (invalidAttachment)");
    expect(factory).not.toHaveBeenCalled();
  });

  test("upload failures, including typed duplicates, retain identity without retrying or inventing a GUID", async () => {
    const photon = client();
    const input = { id: "upload-id", data: new Uint8Array([1]), name: "voice.caf", mimeType: "audio/x-caf" };
    const logs = [spyOn(console, "log"), spyOn(console, "warn"), spyOn(console, "error")];
    for (const error of [
      new grpc.IMessageError("private duplicate details", { code: "duplicateMessage", grpcCode: 6, retryable: false, context: { guid: "untrusted-guid" } }),
      Object.assign(new Error("private details"), { code: "duplicateMessage" }),
      new grpc.ConnectionError("private network details", { code: "timeout", grpcCode: 4, retryable: true }),
      new grpc.RateLimitError("private quota", { code: "uploadRateExceeded", grpcCode: 8, retryable: false }),
    ]) {
      fake.attachments.upload.mockRejectedValueOnce(error);
      await expect(photon.uploadAttachment(input)).rejects.toBe(error);
    }
    expect(fake.attachments.upload).toHaveBeenCalledTimes(4);
    expect(fake.messages.sendAttachment).not.toHaveBeenCalled();
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });

  test.each([undefined, "parent-guid"])("sends attachments with the exact stable operation ID and reply target %j", async replyTo => {
    const photon = client();
    const input = { id: "outbox:attachment:1", chatGuid, attachmentGuid: "uploaded-guid", replyTo };
    expect(await photon.sendAttachment(input)).toEqual({ providerId: "provider-attachment-guid" });
    await photon.sendAttachment(input);
    const sendOptions = { clientMessageId: input.id, ...(replyTo === undefined ? {} : { replyTo }) };
    expect(fake.messages.sendAttachment.mock.calls).toEqual([
      [canonicalChatGuid, input.attachmentGuid, sendOptions],
      [canonicalChatGuid, input.attachmentGuid, sendOptions],
    ]);
    expect(fake.attachments.upload).not.toHaveBeenCalled();
    expect(fake.messages.sendText).not.toHaveBeenCalled();
    expect(factory).toHaveBeenCalledTimes(1);
  });

  test("uncertain attachment sends require caller retry with the same durable key and accept only typed duplicates", async () => {
    const photon = client();
    const input = { id: "durable-attachment-key", chatGuid, attachmentGuid: "uploaded-guid", replyTo: "parent-guid" };
    const error = new grpc.IMessageError("private network details", { code: "internalError", grpcCode: 14, retryable: false });
    fake.messages.sendAttachment.mockRejectedValueOnce(error);
    await expect(photon.sendAttachment(input)).rejects.toBe(error);
    expect(classifySendFailure(error)).toEqual({ retryable: true, uncertain: true, code: "internalError" });
    expect(fake.messages.sendAttachment).toHaveBeenCalledTimes(1);
    fake.messages.sendAttachment.mockRejectedValueOnce(new grpc.IMessageError("duplicate", { code: "duplicateMessage", grpcCode: 6, retryable: false }));
    expect(await photon.sendAttachment({ ...input, chatGuid: canonicalChatGuid })).toEqual({ duplicate: true });
    expect(fake.messages.sendAttachment.mock.calls).toEqual([
      [canonicalChatGuid, input.attachmentGuid, { clientMessageId: input.id, replyTo: input.replyTo }],
      [canonicalChatGuid, input.attachmentGuid, { clientMessageId: input.id, replyTo: input.replyTo }],
    ]);
    for (const failure of [
      Object.assign(new Error("not typed"), { code: "duplicateMessage" }),
      new grpc.ConnectionError("private network details", { code: "timeout", grpcCode: 4, retryable: true }),
      new grpc.IMessageError("content quota", { code: "contentDuplicateExceeded", grpcCode: 8, retryable: false }),
    ]) {
      fake.messages.sendAttachment.mockRejectedValueOnce(failure);
      await expect(photon.sendAttachment(input)).rejects.toBe(failure);
    }
    expect(fake.messages.sendAttachment).toHaveBeenCalledTimes(5);
  });

  test.each(["", " "])("rejects empty attachment GUID %j before any RPC", async attachmentGuid => {
    await expect(client().sendAttachment({ id: "stable-id", chatGuid, attachmentGuid })).rejects.toThrow("invalidAttachment");
    expect(factory).not.toHaveBeenCalled();
  });

  test.each([owner, "+1234567", "+123456789012345"])("all chat RPCs canonicalize either DM alias for %s", async identity => {
    const photon = client();
    for (const prefix of ["any", "iMessage"]) {
      const guid = `${prefix};-;${identity}`;
      const canonical = `any;-;${identity}`;
      await photon.sendText({ id: "stable-id", chatGuid: guid, text: "text" });
      await photon.sendAttachment({ id: "stable-attachment-id", chatGuid: guid, attachmentGuid: "uploaded-guid" });
      await photon.typing(guid, true);
      await photon.read(guid);
      await photon.react(guid, "target", "like", "stable-reaction-id");
      expect(fake.messages.sendText).toHaveBeenLastCalledWith(canonical, "text", { clientMessageId: "stable-id" });
      expect(fake.messages.sendAttachment).toHaveBeenLastCalledWith(canonical, "uploaded-guid", { clientMessageId: "stable-attachment-id" });
      expect(fake.chats.setTyping).toHaveBeenLastCalledWith(canonical, true);
      expect(fake.chats.markRead).toHaveBeenLastCalledWith(canonical);
      expect(fake.messages.setReaction).toHaveBeenLastCalledWith(canonical, "target", { kind: "like" }, true, { clientMessageId: "stable-reaction-id" });
    }
  });

  test.each([
    "", owner, `any;${owner}`, `any;-;${owner};extra`, `any;+;${owner}`, `iMessage;+;${owner}`,
    `SMS;-;${owner}`, `RCS;-;${owner}`, `ANY;-;${owner}`, `any;-;${owner}\n`, ` ${canonicalChatGuid}`,
    "any;-;owner@example.com", "iMessage;-;owner@example.com", "any;-;15555550123", "any;-;+05555550123",
    "any;-;+123456", "any;-;+1234567890123456", "any;-;+1555 5550123", "any;-;+\u0661\u0665\u0665\u0665\u0665\u0665\u0665\u0660\u0661\u0662\u0663",
  ])("all chat RPCs reject malformed or non-E164 DM %j before creating gRPC", async guid => {
    const photon = client();
    await expect(photon.sendText({ id: "stable-id", chatGuid: guid, text: "text" })).rejects.toThrow("unauthorized");
    await expect(photon.sendAttachment({ id: "stable-id", chatGuid: guid, attachmentGuid: "uploaded-guid" })).rejects.toThrow("unauthorized");
    await expect(photon.typing(guid, true)).rejects.toThrow("unauthorized");
    await expect(photon.read(guid)).rejects.toThrow("unauthorized");
    await expect(photon.react(guid, "target", "like", "stable-id")).rejects.toThrow("unauthorized");
    expect(factory).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("uncertain sends are retried only by the caller using the same durable key", async () => {
    const photon = client();
    const input = { id: "durable-outbox-key", chatGuid, text: "Private message", replyTo: "parent-guid" };
    const error = new grpc.IMessageError("private network details", { code: "internalError", grpcCode: 14, retryable: false });
    fake.messages.sendText.mockRejectedValueOnce(error);
    await expect(photon.sendText(input)).rejects.toBe(error);
    expect(classifySendFailure(error)).toEqual({ retryable: true, uncertain: true, code: "internalError" });
    expect(fake.messages.sendText).toHaveBeenCalledTimes(1);
    fake.messages.sendText.mockRejectedValueOnce(new grpc.IMessageError("duplicate", { code: "duplicateMessage", grpcCode: 6, retryable: false }));
    expect(await photon.sendText({ ...input, chatGuid: canonicalChatGuid })).toEqual({ duplicate: true });
    expect(fake.messages.sendText.mock.calls).toEqual([
      [canonicalChatGuid, input.text, { clientMessageId: input.id, replyTo: input.replyTo }],
      [canonicalChatGuid, input.text, { clientMessageId: input.id, replyTo: input.replyTo }],
    ]);
  });

  test("only a typed duplicateMessage is accepted; all other failures retain identity", async () => {
    const photon = client();
    const input = { id: "stable-id", chatGuid, text: "Private message" };
    const duplicate = new grpc.IMessageError("private context", { code: "duplicateMessage", grpcCode: 6, retryable: false });
    fake.messages.sendText.mockRejectedValueOnce(duplicate);
    expect(await photon.sendText(input)).toEqual({ duplicate: true });
    for (const error of [
      Object.assign(new Error("not typed"), { code: "duplicateMessage" }),
      new grpc.ConnectionError("private network details", { code: "timeout", grpcCode: 4, retryable: true }),
      new grpc.IMessageError("content quota", { code: "contentDuplicateExceeded", grpcCode: 8, retryable: false }),
    ]) {
      fake.messages.sendText.mockRejectedValueOnce(error);
      await expect(photon.sendText(input)).rejects.toBe(error);
    }
    expect(fake.messages.sendText).toHaveBeenCalledTimes(4);
  });

  test("typing, raw lookup, and reactions map directly without contact sharing", async () => {
    const photon = client();
    await photon.typing(chatGuid, true);
    await photon.typing(chatGuid, false);
    expect(fake.chats.setTyping.mock.calls).toEqual([[canonicalChatGuid, true], [canonicalChatGuid, false]]);
    expect((await photon.getMessage("target")).guid).toBe("inbound-guid");
    expect(fake.messages.get).toHaveBeenCalledWith("target");
    for (const kind of ["like", "love", "dislike", "laugh", "emphasize", "question"] as const) {
      await photon.react(chatGuid, "target", kind, `reaction:${kind}`);
      expect(fake.messages.setReaction).toHaveBeenLastCalledWith(canonicalChatGuid, "target", { kind }, true, { clientMessageId: `reaction:${kind}` });
    }
    fake.messages.setReaction.mockRejectedValueOnce(new grpc.IMessageError("duplicate", { code: "duplicateMessage", grpcCode: 6, retryable: false }));
    await photon.react(chatGuid, "target", "like", "reaction:like");
    const error = new Error("uncertain");
    fake.messages.setReaction.mockRejectedValueOnce(error);
    await expect(photon.react(chatGuid, "target", "like", "reaction:like")).rejects.toBe(error);
  });

  test.each([canonicalChatGuid, chatGuid])("read canonicalizes %s and propagates errors", async dm => {
    const photon = client();
    await photon.read(dm);
    expect(fake.chats.markRead).toHaveBeenCalledWith(canonicalChatGuid);
    expect(fake.chats.get).not.toHaveBeenCalled();
    const error = new Error("read failed");
    fake.chats.markRead.mockRejectedValueOnce(error);
    await expect(photon.read(dm)).rejects.toBe(error);
  });

  test.each([owner, "+1234567", "+123456789012345"])("resolveChat reads and returns the canonical DM for %s", async identity => {
    const photon = client();
    for (const prefix of ["any", "iMessage"]) {
      const guid = `${prefix};-;${identity}`;
      fake.chats.get.mockResolvedValueOnce({ guid, isGroup: false, displayName: "Private name" });
      expect(await photon.resolveChat(identity)).toEqual({ guid: `any;-;${identity}` });
      expect(fake.chats.get).toHaveBeenLastCalledWith(`any;-;${identity}`);
    }
    expect(fake.chats.get).toHaveBeenCalledTimes(2);
    expect(fake.messages.get).not.toHaveBeenCalled();
    expect(fake.messages.sendText).not.toHaveBeenCalled();
    expect(fake.messages.setReaction).not.toHaveBeenCalled();
    expect(fake.chats.markRead).not.toHaveBeenCalled();
    expect(fake.chats.setTyping).not.toHaveBeenCalled();
  });

  test.each([
    { guid: "any;-;+15555550999", isGroup: false },
    { guid: `SMS;-;${owner}`, isGroup: false },
    { guid: `other;-;${owner}`, isGroup: false },
    { guid: `any;+;${owner}`, isGroup: true },
    { guid: chatGuid, isGroup: true },
    { guid: "", isGroup: false },
  ])("resolveChat rejects non-owner or non-DM results %j", async chat => {
    fake.chats.get.mockResolvedValueOnce(chat);
    await expect(client().resolveChat(owner)).rejects.toThrow("invalidOwnerChat");
  });

  test("resolveChat rejects invalid owners before RPC and preserves lookup errors", async () => {
    const photon = client();
    for (const identity of ["", " ", `${owner};extra`, `${owner}\n`, "owner@example.com", "15555550123", "+05555550123", "+123456", "+1234567890123456"]) {
      await expect(photon.resolveChat(identity)).rejects.toThrow("invalidOwner");
    }
    expect(factory).not.toHaveBeenCalled();
    const error = new grpc.NotFoundError("not found", { code: "chatNotFound", grpcCode: 5, retryable: false });
    fake.chats.get.mockRejectedValueOnce(error);
    await expect(photon.resolveChat(owner)).rejects.toBe(error);
  });

  test("empty operation IDs are rejected before gRPC", async () => {
    const photon = client();
    await expect(photon.sendText({ id: " ", chatGuid, text: "text" })).rejects.toThrow("invalidOperationId");
    for (const id of ["", " "]) {
      await expect(photon.sendAttachment({ id, chatGuid, attachmentGuid: "uploaded-guid" })).rejects.toThrow("invalidOperationId");
      await expect(photon.uploadAttachment({ id, data: new Uint8Array([1]), name: "original.bin", mimeType: "application/octet-stream" })).rejects.toThrow("invalidOperationId");
    }
    await expect(photon.react(chatGuid, "target", "like", "")).rejects.toThrow("invalidOperationId");
    expect(factory).not.toHaveBeenCalled();
  });

  test("catchUp preserves every event and checkpoint, without normalization or lookup", async () => {
    jest.useFakeTimers();
    const events: grpc.CatchUpEvent[] = [
      received(),
      changed({ messageRead: { messageGuid: "target", readAt: timestamp } }),
      received({}, { chatGuid: "iMessage;+;other" }),
      { type: "chat.archived", sequence: 15, chatGuid, occurredAt: new Date(timestamp), isFromMe: true },
      { type: "group.changed", sequence: 16, chatGuid, occurredAt: new Date(timestamp), isFromMe: true, change: { type: "iconRemoved" } },
      { type: "poll.changed", sequence: 17, chatGuid, occurredAt: new Date(timestamp), isFromMe: false, pollMessageGuid: "poll", delta: { type: "unvoted", optionIdentifier: "option" } },
      { type: "catchup.complete", headSequence: 18 },
    ];
    const cleanup = mock(async () => {});
    fake.events.catchUp.mockImplementation(() => new grpc.TypedEventStream((async function* () { yield* events; })(), cleanup));
    const result = [];
    for await (const event of client().catchUp(11)) result.push(event);
    expect(result).toEqual(events);
    result.forEach((event, index) => expect(event).toBe(events[index]));
    expect(fake.events.catchUp).toHaveBeenCalledWith(11);
    expect(fake.messages.get).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  test("catchUp closes on early return and propagates stream errors", async () => {
    jest.useFakeTimers();
    const cleanup = mock(async () => {});
    fake.events.catchUp.mockImplementation(() => new grpc.TypedEventStream((async function* () { yield received(); yield received(); })(), cleanup));
    const photon = client();
    for await (const _event of photon.catchUp()) break;
    expect(fake.events.catchUp).toHaveBeenCalledWith(undefined);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
    const error = new Error("stream broke");
    fake.events.catchUp.mockImplementation(() => new grpc.TypedEventStream((async function* () { throw error; })(), cleanup));
    await expect(photon.catchUp(12).next()).rejects.toBe(error);
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(jest.getTimerCount()).toBe(0);
  });

  test.each([false, true])("catchUp rejects normal EOF without the native completion marker (events=%s)", async withEvents => {
    jest.useFakeTimers();
    const event = received();
    const cleanup = mock(async () => {});
    fake.events.catchUp.mockImplementation(() => new grpc.TypedEventStream((async function* () {
      if (withEvents) yield event;
    })(), cleanup));
    const stream = client().catchUp(11);
    if (withEvents) expect((await stream.next()).value).toBe(event);
    await expect(stream.next()).rejects.toMatchObject({ code: "catchupIncomplete", retryable: true, ambiguous: false });
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  test("breaking on catchup.complete cleans up without checking incomplete EOF or waiting for more data", async () => {
    jest.useFakeTimers();
    const complete: grpc.CatchUpEvent = { type: "catchup.complete", headSequence: 12 };
    const afterComplete = mock(() => {});
    const cleanup = mock(async () => {});
    fake.events.catchUp.mockImplementation(() => new grpc.TypedEventStream((async function* () {
      yield received();
      yield complete;
      afterComplete();
      await new Promise(() => {});
    })(), cleanup));
    const events = [];
    for await (const event of client().catchUp(11)) {
      events.push(event);
      if (event.type === "catchup.complete") break;
    }
    expect(events).toHaveLength(2);
    expect(events[1]).toBe(complete);
    expect(afterComplete).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  test.each([false, true])("catchUp's absolute 30-second deadline interrupts a hung read (events=%s)", async withEvents => {
    jest.useFakeTimers();
    const cleanup = mock(async () => {});
    fake.events.catchUp.mockImplementation(() => new grpc.TypedEventStream((async function* () {
      if (withEvents) { yield received(); yield received(); }
      await new Promise(() => {});
    })(), cleanup));
    const photon = client();
    const stream = photon.catchUp(11);
    if (withEvents) {
      expect((await stream.next()).done).toBe(false);
      jest.advanceTimersByTime(20_000);
      expect((await stream.next()).done).toBe(false);
      expect(jest.getTimerCount()).toBe(1);
    }
    const pending = stream.next();
    jest.advanceTimersByTime(withEvents ? 9_999 : 29_999);
    expect(cleanup).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    await expect(pending).rejects.toMatchObject({ code: "catchupTimeout", retryable: true, ambiguous: false });
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
    expect((await stream.next()).done).toBe(true);

    const next = photon.catchUp(12);
    if (withEvents) { await next.next(); await next.next(); }
    const retry = next.next();
    expect(jest.getTimerCount()).toBe(1);
    jest.advanceTimersByTime(29_999);
    expect(cleanup).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(1);
    await expect(retry).rejects.toMatchObject({ code: "catchupTimeout", retryable: true });
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(jest.getTimerCount()).toBe(0);
  });

  test("catchUp timeout remains visible even when SDK cancellation fails", async () => {
    jest.useFakeTimers();
    const cleanup = mock(async () => { throw new Error("private cancellation failure"); });
    fake.events.catchUp.mockImplementation(() => new grpc.TypedEventStream((async function* () {
      await new Promise(() => {});
      yield received();
    })(), cleanup));
    const pending = client().catchUp().next();
    jest.advanceTimersByTime(30_000);
    await expect(pending).rejects.toThrow("Photon transport failed (catchupTimeout)");
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  test("catchUp cannot swallow a timeout through caller return between events", async () => {
    jest.useFakeTimers();
    const cleanup = mock(async () => {});
    fake.events.catchUp.mockImplementation(() => new grpc.TypedEventStream((async function* () {
      yield received();
      yield { type: "catchup.complete", headSequence: 12 } as const;
    })(), cleanup));
    const stream = client().catchUp();
    expect((await stream.next()).done).toBe(false);
    jest.advanceTimersByTime(30_000);
    expect(cleanup).toHaveBeenCalledTimes(1);
    await expect(stream.return(undefined)).rejects.toMatchObject({ code: "catchupTimeout", retryable: true });
    expect(jest.getTimerCount()).toBe(0);
  });

  test("catchUp completion does not disable the deadline for a subsequent hung read", async () => {
    jest.useFakeTimers();
    const cleanup = mock(async () => {});
    fake.events.catchUp.mockImplementation(() => new grpc.TypedEventStream((async function* () {
      yield { type: "catchup.complete", headSequence: 12 } as const;
      await new Promise(() => {});
    })(), cleanup));
    const stream = client().catchUp();
    expect((await stream.next()).value).toEqual({ type: "catchup.complete", headSequence: 12 });
    const pending = stream.next();
    jest.advanceTimersByTime(30_000);
    await expect(pending).rejects.toMatchObject({ code: "catchupTimeout", retryable: true });
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  test("bounded attachment download combines chunks and closes the stream", async () => {
    jest.useFakeTimers();
    const cleanup = mock(async () => {});
    fake.attachments.downloadStream.mockImplementation(() => new grpc.TypedEventStream((async function* () {
      yield { type: "header", info: attachment() } as const;
      yield { type: "primaryChunk", data: new Uint8Array([1, 2]) } as const;
      yield { type: "primaryChunk", data: new Uint8Array([3]) } as const;
    })(), cleanup));
    expect(await client().downloadAttachment("attachment-guid", 3)).toEqual({ data: new Uint8Array([1, 2, 3]), name: "voice.caf", mimeType: "audio/x-caf" });
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(fake.messages.get).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  test.each([
    "a18f173c-5d78-447a-aef6-32f62f392a0d",
    "A18F173C-5D78-447A-AEF6-32F62F392A0D",
    "spc-att-11111111-2222-4333-8444-555555555555",
  ])("scoped attachment download accepts provider header GUID %s without changing the RPC target", async headerGuid => {
    jest.useFakeTimers();
    const guid = "spc-att-11111111-2222-4333-8444-555555555555";
    const cleanup = mock(async () => {});
    const info = { ...attachment(), guid: headerGuid, originalGuid: headerGuid, totalBytes: 235612, mimeType: "image/png", fileName: "photo.png" };
    fake.attachments.downloadStream.mockImplementation(() => new grpc.TypedEventStream((async function* () {
      yield { type: "header", info } as const;
      yield { type: "primaryChunk", data: new Uint8Array(100000) } as const;
      yield { type: "primaryChunk", data: new Uint8Array(135612) } as const;
    })(), cleanup));
    const logs = [spyOn(console, "log"), spyOn(console, "warn"), spyOn(console, "error")];
    const result = await client().downloadAttachment(guid, 20 * 1024 * 1024);
    expect(result).toEqual({ data: new Uint8Array(235612), name: "photo.png", mimeType: "image/png" });
    expect(fake.attachments.downloadStream.mock.calls).toEqual([[guid]]);
    expect(info.guid).toBe(headerGuid);
    expect(fake.messages.get).not.toHaveBeenCalled();
    expect(fake.messages.sendText).not.toHaveBeenCalled();
    expect(fake.messages.sendAttachment).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });

  test.each([
    ["attachment-guid", "a18f173c-5d78-447a-aef6-32f62f392a0d"],
    ["11111111-2222-4333-8444-555555555555", "a18f173c-5d78-447a-aef6-32f62f392a0d"],
    ["spc-att-invalid", "a18f173c-5d78-447a-aef6-32f62f392a0d"],
    ["SPC-ATT-11111111-2222-4333-8444-555555555555", "a18f173c-5d78-447a-aef6-32f62f392a0d"],
    ["spc-att-11111111-2222-4333-8444-555555555555\n", "a18f173c-5d78-447a-aef6-32f62f392a0d"],
    ...["", "wrong-guid", "spc-att-a18f173c-5d78-447a-aef6-32f62f392a0d", "a18f173c-5d78-447a-aef6-32f62f392a0d\n"].map(headerGuid => ["spc-att-11111111-2222-4333-8444-555555555555", headerGuid] as const),
  ] as const)("rejects header aliases outside the scoped-to-native contract %#", async (guid, headerGuid) => {
    jest.useFakeTimers();
    const cleanup = mock(async () => {});
    const readBytes = mock(() => {});
    fake.attachments.downloadStream.mockImplementation(() => new grpc.TypedEventStream((async function* () {
      yield { type: "header", info: { ...attachment(), guid: headerGuid, originalGuid: guid } } as const;
      readBytes();
      yield { type: "primaryChunk", data: new Uint8Array(3) } as const;
    })(), cleanup));
    await expect(client().downloadAttachment(guid, 3)).rejects.toThrow("Photon transport failed (invalidAttachment)");
    expect(fake.attachments.downloadStream.mock.calls).toEqual([[guid]]);
    expect(readBytes).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  test.each([
    [4, 0, [3], false, "attachmentTooLarge"],
    [3, 0, [4], false, "attachmentTooLarge"],
    [3, 0, [2], false, "invalidAttachment"],
    [3, 0, [3], true, "invalidAttachment"],
    [-1, 0, [], false, "invalidAttachment"],
    [NaN, 0, [], false, "invalidAttachment"],
    [Number.MAX_SAFE_INTEGER + 1, 0, [], false, "invalidAttachment"],
    [3, -1, [], false, "invalidAttachment"],
  ] as const)("scoped-to-native headers retain size and stream validation %#", async (totalBytes, companionBytes, sizes, duplicateHeader, code) => {
    jest.useFakeTimers();
    const cleanup = mock(async () => {});
    const header = {
      type: "header", info: { ...attachment(), guid: "a18f173c-5d78-447a-aef6-32f62f392a0d", totalBytes },
      companionInfo: { totalBytes: companionBytes, fileName: "companion.mov", mimeType: "video/quicktime", kind: "livePhotoVideo" },
    } as const;
    fake.attachments.downloadStream.mockImplementation(() => new grpc.TypedEventStream((async function* () {
      yield header;
      if (duplicateHeader) yield header;
      for (const size of sizes) yield { type: "primaryChunk", data: new Uint8Array(size) } as const;
    })(), cleanup));
    await expect(client().downloadAttachment("spc-att-11111111-2222-4333-8444-555555555555", 3)).rejects.toMatchObject({ code });
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  test.each([
    [{ type: "header", info: { ...attachment(), totalBytes: 4 } }],
    [{ type: "header", info: attachment() }, { type: "primaryChunk", data: new Uint8Array(4) }],
    [{ type: "header", info: attachment() }, { type: "companionChunk", data: new Uint8Array(4) }],
    [{ type: "primaryChunk", data: new Uint8Array(3) }],
    [{ type: "header", info: { ...attachment(), guid: "wrong-guid" } }],
    [{ type: "header", info: attachment() }, { type: "primaryChunk", data: new Uint8Array(2) }],
  ])("rejects oversized or invalid attachment streams %#", async (...frames) => {
    jest.useFakeTimers();
    const cleanup = mock(async () => {});
    fake.attachments.downloadStream.mockImplementation(() => new grpc.TypedEventStream((async function* () { yield* frames; })(), cleanup));
    await expect(client().downloadAttachment("attachment-guid", 3)).rejects.toBeInstanceOf(TransportError);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  test.each([0, 3])("a Live Photo accepts its %i-byte primary without downloading the unused companion", async size => {
    const cleanup = mock(async () => {});
    const companionRead = mock(() => {});
    fake.attachments.downloadStream.mockImplementation(() => new grpc.TypedEventStream((async function* () {
      yield { type: "header", info: { ...attachment(), guid: "attachment-guid", totalBytes: size }, companionInfo: {
        totalBytes: 30 * 1024 * 1024, fileName: "live.mov", mimeType: "video/quicktime", kind: "live-photo-video",
      } } as const;
      if (size) yield { type: "primaryChunk", data: new Uint8Array([1, 2, 3]) } as const;
      companionRead();
      yield { type: "companionChunk", data: new Uint8Array(30 * 1024 * 1024) } as const;
    })(), cleanup));
    expect(await client().downloadAttachment("attachment-guid", 3)).toEqual({ data: size ? new Uint8Array([1, 2, 3]) : new Uint8Array(), name: "voice.caf", mimeType: "audio/x-caf" });
    expect(companionRead).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  test.each([
    [false, "attachment-guid"], [true, "attachment-guid"],
    [true, "spc-att-11111111-2222-4333-8444-555555555555"],
  ] as const)("attachment download's absolute 30-second deadline aborts a hung read (chunks=%s, guid=%s)", async (withChunks, guid) => {
    jest.useFakeTimers();
    const aborted = new AbortController();
    const cleanup = mock(async () => { aborted.abort(); });
    let release!: () => void;
    let reading!: () => void;
    const firstRead = new Promise<void>(resolve => { reading = resolve; });
    let resumed!: () => void;
    const secondRead = new Promise<void>(resolve => { resumed = resolve; });
    fake.attachments.downloadStream.mockImplementation(() => new grpc.TypedEventStream((async function* () {
      if (withChunks) {
        yield { type: "header", info: { ...attachment(), guid: guid.startsWith("spc-att-") ? "a18f173c-5d78-447a-aef6-32f62f392a0d" : guid } } as const;
        yield { type: "primaryChunk", data: new Uint8Array([1]) } as const;
      }
      reading();
      await new Promise<void>(resolve => { release = resolve; });
      if (withChunks) yield { type: "primaryChunk", data: new Uint8Array([2, 3]) } as const;
      resumed();
      await new Promise(() => {});
    })(), cleanup));
    const photon = client();
    const pending = photon.downloadAttachment(guid, 3);
    await firstRead;
    jest.advanceTimersByTime(20_000);
    release();
    await secondRead;
    jest.advanceTimersByTime(9_999);
    expect(cleanup).not.toHaveBeenCalled();
    expect(aborted.signal.aborted).toBe(false);
    jest.advanceTimersByTime(1);
    await expect(pending).rejects.toMatchObject({ code: "attachmentTimeout", retryable: true, ambiguous: false });
    expect(aborted.signal.aborted).toBe(true);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
    await photon.close();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  test("attachment timeout remains visible when SDK cancellation fails", async () => {
    jest.useFakeTimers();
    const cleanup = mock(async () => { throw new Error("private cancellation failure"); });
    fake.attachments.downloadStream.mockImplementation(() => new grpc.TypedEventStream((async function* () {
      await new Promise(() => {});
      yield { type: "header", info: attachment() } as const;
    })(), cleanup));
    const pending = client().downloadAttachment("attachment-guid", 3);
    jest.advanceTimersByTime(30_000);
    await expect(pending).rejects.toThrow("Photon transport failed (attachmentTimeout)");
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  test("a caller-supplied attachment deadline replaces the 30-second default and must be valid", async () => {
    jest.useFakeTimers();
    const cleanup = mock(async () => {});
    fake.attachments.downloadStream.mockImplementation(() => new grpc.TypedEventStream((async function* () {
      await new Promise(() => {});
      yield { type: "header", info: attachment() } as const;
    })(), cleanup));
    let settled = false;
    const pending = client().downloadAttachment("attachment-guid", 3, 130_000);
    pending.catch(() => {}).finally(() => { settled = true; });
    jest.advanceTimersByTime(129_999);
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(cleanup).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    await expect(pending).rejects.toMatchObject({ code: "attachmentTimeout", retryable: true });
    for (const timeout of [0, -1, 1.5, Number.NaN]) {
      await expect(client().downloadAttachment("attachment-guid", 3, timeout)).rejects.toMatchObject({ code: "invalidAttachmentLimit" });
    }
  });

  test("attachment stream failures propagate unchanged and clear the deadline", async () => {
    jest.useFakeTimers();
    const error = new Error("private stream failure");
    const cleanup = mock(async () => {});
    fake.attachments.downloadStream.mockImplementation(() => new grpc.TypedEventStream((async function* () {
      yield { type: "header", info: attachment() } as const;
      throw error;
    })(), cleanup));
    await expect(client().downloadAttachment("attachment-guid", 3)).rejects.toBe(error);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  test("close interrupts pending attachment downloads and clears their deadlines", async () => {
    jest.useFakeTimers();
    const cleanup = mock(async () => {});
    fake.attachments.downloadStream.mockImplementation(() => new grpc.TypedEventStream((async function* () {
      await new Promise(() => {});
      yield { type: "header", info: attachment() } as const;
    })(), cleanup));
    const photon = client();
    const pending = photon.downloadAttachment("attachment-guid", 3);
    await photon.close();
    await expect(pending).rejects.toThrow("closed");
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  test("close is idempotent, cancels pending streams, and prevents new calls", async () => {
    jest.useFakeTimers();
    const cleanup = mock(async () => {});
    fake.events.catchUp.mockImplementation(() => new grpc.TypedEventStream((async function* () {
      await new Promise(() => {});
      yield received();
    })(), cleanup));
    const photon = client();
    const pending = photon.catchUp().next();
    const closing = photon.close();
    expect(photon.close()).toBe(closing);
    await expect(pending).rejects.toThrow("closed");
    await closing;
    expect(jest.getTimerCount()).toBe(0);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(fake.close).toHaveBeenCalledTimes(1);
    await expect(photon.check()).rejects.toThrow("closed");
    await expect(photon.typing(chatGuid, false)).rejects.toThrow("closed");
    await expect(photon.read(chatGuid)).rejects.toThrow("closed");
    await expect(photon.resolveChat(owner)).rejects.toThrow("closed");
    await expect(photon.uploadAttachment({ id: "upload-id", data: new Uint8Array([1]), name: "original.bin", mimeType: "application/octet-stream" })).rejects.toThrow("closed");
    await expect(photon.sendAttachment({ id: "send-id", chatGuid, attachmentGuid: "uploaded-guid" })).rejects.toThrow("closed");
    await expect(photon.downloadAttachment("attachment-guid", 3)).rejects.toThrow("closed");
    expect(fake.attachments.upload).not.toHaveBeenCalled();
    expect(fake.messages.sendAttachment).not.toHaveBeenCalled();
    expect(fake.attachments.downloadStream).not.toHaveBeenCalled();
    expect(fake.chats.markRead).not.toHaveBeenCalled();
    expect(fake.chats.get).not.toHaveBeenCalled();
  });

  test("close aborts token issue and never creates a client", async () => {
    fetchMock.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    const photon = client();
    const pending = photon.check();
    await photon.close();
    await expect(pending).rejects.toThrow("closed");
    expect(factory).not.toHaveBeenCalled();
  });
});
