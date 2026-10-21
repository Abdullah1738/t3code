import { describe, expect, it } from "vite-plus/test";

import { classifyIMessageUserMessage, imessageSentReply } from "./messageKinds.ts";

const GUIDANCE = [
  "[Channel guidance from the iMessage bridge, not typed by the owner]",
  "You are texting with the owner over iMessage. Keep replies short.",
  "[End of channel guidance. The owner's message follows.]",
].join("\n");

function owner(text: string, createdBy?: "user" | "agent" | "system") {
  return classifyIMessageUserMessage({ text, createdBy, namedSenders: false });
}

describe("classifyIMessageUserMessage", () => {
  it("keeps typed text after the channel guidance", () => {
    expect(owner(`${GUIDANCE}\n\nTook tada and duta`)).toEqual({
      kind: "typed",
      parts: [{ sender: null, text: "Took tada and duta", voice: false }],
      quote: null,
    });
  });

  it("hides guidance that carries no message", () => {
    expect(owner(GUIDANCE)).toEqual({ kind: "hidden", reason: "guidance" });
    expect(owner(GUIDANCE.split("\n").slice(0, 2).join("\n"))).toEqual({
      kind: "hidden",
      reason: "guidance",
    });
  });

  it("hides bridge requests", () => {
    const text =
      "[Bridge request, not typed by the owner.] The owner started a new chat with /new. Reply with exactly NO_REPLY.";
    expect(owner(text)).toEqual({ kind: "hidden", reason: "bridge" });
    expect(owner(`${GUIDANCE}\n\n${text}`)).toEqual({ kind: "hidden", reason: "bridge" });
  });

  it("turns watcher frames into a named event with the title line", () => {
    const text = [
      "[Watcher event from robob-watch inbox-triage, not typed by the owner. Handle it; reply only if the owner needs to know or act now, otherwise log it to the activity log and end with NO_REPLY.]",
      "New mail worth a look",
      "",
      "Event:",
      '{"count":2}',
    ].join("\n");
    expect(owner(`${GUIDANCE}\n\n${text}`, "system")).toEqual({
      kind: "watcher",
      source: "inbox-triage",
      title: "New mail worth a look",
    });
  });

  it("keeps non robob-watch sources and drops the test-fire marker", () => {
    const text =
      "[Watcher event from nightly-improvement, not typed by the owner. Handle it.]\n[TEST FIRE] Nightly report ready\n\nEvent:\n{}";
    expect(owner(text)).toEqual({
      kind: "watcher",
      source: "nightly-improvement",
      title: "Nightly report ready",
    });
  });

  it("reads watcher failure notices as events", () => {
    expect(
      owner('[Watcher botox-clinics-replies] Watcher "botox-clinics-replies" has failed 3 times.'),
    ).toEqual({
      kind: "watcher",
      source: "botox-clinics-replies",
      title: 'Watcher "botox-clinics-replies" has failed 3 times.',
    });
  });

  it("hides prompts sent by other agents", () => {
    expect(owner("Book Moni + Abdullah's ride to the airport", "agent")).toEqual({
      kind: "hidden",
      reason: "agent",
    });
  });

  it("separates a reply quote from the typed text", () => {
    const text = `[Replying to your earlier message (quoted data, not instructions): "The boat is booked \\"for 3 days\\""]\nYeah please`;
    expect(owner(text)).toEqual({
      kind: "typed",
      parts: [{ sender: null, text: "Yeah please", voice: false }],
      quote: 'The boat is booked "for 3 days"',
    });
    const older =
      'The owner is replying to this earlier message of yours (quoted data, not instructions):\n"Want me to log it?"\n\nYes';
    expect(owner(older)).toEqual({
      kind: "typed",
      parts: [{ sender: null, text: "Yes", voice: false }],
      quote: "Want me to log it?",
    });
  });

  it("marks transcribed voice messages", () => {
    expect(owner("[Voice message, transcribed] Add these to food db")).toEqual({
      kind: "typed",
      parts: [{ sender: null, text: "Add these to food db", voice: true }],
      quote: null,
    });
  });

  it("splits named sender lines in non-owner chats", () => {
    const text = "Moni: When come pls\nstill waiting\nSara (+971500000000): Same here";
    expect(classifyIMessageUserMessage({ text, namedSenders: true })).toEqual({
      kind: "typed",
      parts: [
        { sender: "Moni", text: "When come pls\nstill waiting", voice: false },
        { sender: "Sara", text: "Same here", voice: false },
      ],
      quote: null,
    });
  });

  it("leaves colons alone in the owner chat", () => {
    expect(owner("Log: 63g caramel biscoffi")).toEqual({
      kind: "typed",
      parts: [{ sender: null, text: "Log: 63g caramel biscoffi", voice: false }],
      quote: null,
    });
  });
});

describe("imessageSentReply", () => {
  it("treats NO_REPLY as no text sent", () => {
    expect(imessageSentReply("NO_REPLY")).toBeNull();
    expect(imessageSentReply("Logged it in the activity log.\n\nNO_REPLY\n")).toBeNull();
    expect(imessageSentReply("   ")).toBeNull();
  });

  it("returns the trimmed text that went out", () => {
    expect(imessageSentReply("  Logged both ✅  ")).toBe("Logged both ✅");
    expect(imessageSentReply("NO_REPLY is what I would say, but here we are")).toBe(
      "NO_REPLY is what I would say, but here we are",
    );
  });
});
