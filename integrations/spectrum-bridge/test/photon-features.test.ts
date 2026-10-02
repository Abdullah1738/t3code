import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as grpc from "@photon-ai/advanced-imessage/grpc";
import { EFFECTS, isEffect, Photon } from "../src/photon.ts";

const owner = "+15555550123";
const chatGuid = `iMessage;-;${owner}`;
const canonical = `any;-;${owner}`;
const duplicate = () => new grpc.IMessageError("duplicate", { code: "duplicateMessage", grpcCode: 6, retryable: false });

describe("Photon rich sends (mocked, no network)", () => {
  const clients: Photon[] = [];
  let factory: ReturnType<typeof spyOn<typeof grpc, "createGrpcClient">>;
  let fake: {
    messages: { sendText: ReturnType<typeof mock>; sendCustomizedMiniApp: ReturnType<typeof mock> };
    polls: { create: ReturnType<typeof mock> };
    close: ReturnType<typeof mock>;
  };
  const client = () => { const photon = new Photon("project-test", "test-only-secret"); clients.push(photon); return photon; };

  beforeEach(() => {
    fake = {
      messages: {
        sendText: mock(async () => ({ guid: "text-guid" })),
        sendCustomizedMiniApp: mock(async () => ({ guid: "app-guid" })),
      },
      polls: {
        create: mock(async () => ({
          pollMessageGuid: "poll-guid", chatGuid: canonical, title: "Lunch?",
          options: [{ optionIdentifier: "o-1", text: "Pizza", creatorHandle: owner }, { optionIdentifier: "o-2", text: "Sushi" }],
          votes: [],
        })),
      },
      close: mock(async () => {}),
    };
    factory = spyOn(grpc, "createGrpcClient").mockImplementation(() => fake as unknown as grpc.AdvancedIMessage);
    spyOn(globalThis, "fetch").mockImplementation((async () => { throw new Error("No live calls allowed"); }) as unknown as typeof fetch);
  });
  afterEach(async () => {
    await Promise.all(clients.splice(0).map(photon => photon.close()));
    mock.restore();
  });

  test("EFFECTS lists every SDK effect name and isEffect accepts only those names", () => {
    expect(EFFECTS).toEqual(Object.keys(grpc.MessageEffect) as typeof EFFECTS);
    expect(EFFECTS).toContain("confetti");
    expect(EFFECTS).toContain("invisible");
    for (const name of EFFECTS) expect(isEffect(name)).toBe(true);
    for (const value of ["", "Confetti", "com.apple.messages.effect.CKConfettiEffect", "toString", "__proto__", 1, undefined]) {
      expect(isEffect(value)).toBe(false);
    }
  });

  test("sendText maps effect names, subject, formatting, and link previews onto SDK options", async () => {
    const photon = client();
    const formatting = [{ type: "bold" as const, start: 0, length: 4 }];
    expect(await photon.sendText({ id: "op", chatGuid, text: "Bold https://x.test", replyTo: "parent",
      effect: "slam", subject: "Heads up", formatting, enableLinkPreview: true })).toEqual({ providerId: "text-guid" });
    expect(fake.messages.sendText).toHaveBeenLastCalledWith(canonical, "Bold https://x.test", {
      clientMessageId: "op", replyTo: "parent", effect: "com.apple.MobileSMS.expressivesend.impact",
      subject: "Heads up", formatting, enableLinkPreview: true,
    });
    await photon.sendText({ id: "op-2", chatGuid, text: "plain", formatting: [], enableLinkPreview: false });
    expect(fake.messages.sendText).toHaveBeenLastCalledWith(canonical, "plain", { clientMessageId: "op-2" });
    await photon.sendText({ id: "op-3", chatGuid, text: "boom", effect: "confetti" });
    expect(fake.messages.sendText).toHaveBeenLastCalledWith(canonical, "boom", {
      clientMessageId: "op-3", effect: "com.apple.messages.effect.CKConfettiEffect" });
  });

  test("an unknown effect is rejected before any RPC", async () => {
    await expect(client().sendText({ id: "op", chatGuid, text: "x", effect: "rainbow" as never })).rejects.toThrow("invalidEffect");
    expect(factory).not.toHaveBeenCalled();
  });

  test("sendPoll creates with the durable ID and projects only option identity and text", async () => {
    const photon = client();
    const input = { id: "poll-op", chatGuid, title: "Lunch?", options: ["Pizza", "Sushi"] };
    expect(await photon.sendPoll(input)).toEqual({ providerId: "poll-guid",
      options: [{ optionIdentifier: "o-1", text: "Pizza" }, { optionIdentifier: "o-2", text: "Sushi" }] });
    expect(fake.polls.create).toHaveBeenCalledWith(canonical, "Lunch?", ["Pizza", "Sushi"], { clientMessageId: "poll-op" });
    fake.polls.create.mockRejectedValueOnce(duplicate());
    expect(await photon.sendPoll(input)).toEqual({ duplicate: true });
    const other = new grpc.ConnectionError("private", { code: "timeout", grpcCode: 4, retryable: true });
    fake.polls.create.mockRejectedValueOnce(other);
    await expect(photon.sendPoll(input)).rejects.toBe(other);
  });

  test.each([
    { title: " ", options: ["a", "b"] }, { title: "t", options: ["a"] }, { title: "t", options: ["a", " "] },
  ])("sendPoll rejects invalid poll %j before any RPC", async poll => {
    await expect(client().sendPoll({ id: "op", chatGuid, ...poll })).rejects.toThrow("invalidPoll");
    await expect(client().sendPoll({ id: "op", chatGuid: "any;-;+15555550999;x", title: "t", options: ["a", "b"] })).rejects.toThrow("unauthorized");
    expect(factory).not.toHaveBeenCalled();
  });

  test("sendApp sends the fixed Spectrum extension card with only provided layout fields", async () => {
    const photon = client();
    expect(await photon.sendApp({ id: "app-op", chatGuid, url: "https://apps.test/a/", caption: "Tracker",
      trailingCaption: "Now", summary: "Open tracker" })).toEqual({ providerId: "app-guid" });
    expect(fake.messages.sendCustomizedMiniApp).toHaveBeenCalledWith(canonical, {
      appName: "Spectrum", extensionBundleId: "codes.photon.Spectrum.MessagesExtension", teamId: "P8XT6232SL",
      appStoreId: 6777616651, url: "https://apps.test/a/",
      layout: { caption: "Tracker", trailingCaption: "Now", summary: "Open tracker" },
    }, { clientMessageId: "app-op" });
    fake.messages.sendCustomizedMiniApp.mockRejectedValueOnce(duplicate());
    expect(await photon.sendApp({ id: "app-op", chatGuid, url: "https://apps.test/a/", caption: "Tracker" })).toEqual({ duplicate: true });
  });

  test.each(["http://apps.test/", "file:///etc/passwd", "not a url", "javascript:alert(1)"])("sendApp rejects non-https URL %j", async url => {
    await expect(client().sendApp({ id: "op", chatGuid, url, caption: "c" })).rejects.toThrow("invalidApp");
    expect(factory).not.toHaveBeenCalled();
  });
});
