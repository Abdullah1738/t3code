import { describe, expect, it } from "@effect/vitest";

import { bridgeCliPaths } from "./ImessageBridgeCli.ts";
import { bridgeCliArgs, bridgeCliError, defaultSendKey, parseBridgeAck } from "./send.ts";

const keyInput = {
  threadId: "thread-1",
  providerSessionId: "provider-1",
  runId: "run-1",
  to: undefined,
  text: "hello",
  file: undefined,
};

describe("defaultSendKey", () => {
  it("is stable for the same call and prefixed with 40 hex", () => {
    const key = defaultSendKey(keyInput);
    expect(key).toMatch(/^mcp:[a-f0-9]{40}$/);
    expect(defaultSendKey({ ...keyInput })).toBe(key);
  });

  it("changes with the run, the text, the target or the file", () => {
    const key = defaultSendKey(keyInput);
    expect(defaultSendKey({ ...keyInput, runId: "run-2" })).not.toBe(key);
    expect(defaultSendKey({ ...keyInput, runId: null })).not.toBe(key);
    expect(defaultSendKey({ ...keyInput, text: "hello!" })).not.toBe(key);
    expect(defaultSendKey({ ...keyInput, to: "moni" })).not.toBe(key);
    expect(defaultSendKey({ ...keyInput, file: "/tmp/a.png" })).not.toBe(key);
    expect(defaultSendKey({ ...keyInput, providerSessionId: "provider-2" })).not.toBe(key);
  });

  it("does not collide when fields shift between positions", () => {
    expect(defaultSendKey({ ...keyInput, to: "a", text: "b" })).not.toBe(
      defaultSendKey({ ...keyInput, to: undefined, text: "ab" }),
    );
  });
});

describe("bridgeCliArgs", () => {
  const base = { file: undefined, to: undefined, effect: undefined, session: "s1", key: "k1" };

  it("sends text with inline option values", () => {
    expect(bridgeCliArgs({ ...base, text: "--not-an-option\nline two" })).toEqual([
      "send",
      "--text=--not-an-option\nline two",
      "--session=s1",
      "--key=k1",
    ]);
  });

  it("adds --to or --effect", () => {
    expect(bridgeCliArgs({ ...base, text: "hi", to: "moni" })).toEqual([
      "send",
      "--text=hi",
      "--session=s1",
      "--key=k1",
      "--to=moni",
    ]);
    expect(bridgeCliArgs({ ...base, text: "hi", effect: "confetti" })).toEqual([
      "send",
      "--text=hi",
      "--session=s1",
      "--key=k1",
      "--effect=confetti",
    ]);
  });

  it("sends a file with an optional caption", () => {
    expect(bridgeCliArgs({ ...base, text: undefined, file: "/tmp/a b.png" })).toEqual([
      "send-file",
      "--file=/tmp/a b.png",
      "--session=s1",
      "--key=k1",
    ]);
    expect(bridgeCliArgs({ ...base, text: "look", file: "/tmp/a.png" })).toEqual([
      "send-file",
      "--file=/tmp/a.png",
      "--text=look",
      "--session=s1",
      "--key=k1",
    ]);
  });
});

describe("parseBridgeAck", () => {
  const hex = "a".repeat(64);

  it("reads the CLI's acknowledgement", () => {
    expect(parseBridgeAck(`{"id":"send:${hex}","created":true}\n`, "send")).toEqual({
      id: `send:${hex}`,
      created: true,
    });
    expect(parseBridgeAck(`{"id":"file:${hex}","created":false}`, "file")).toEqual({
      id: `file:${hex}`,
      created: false,
    });
  });

  it("refuses anything else", () => {
    expect(parseBridgeAck(`{"id":"file:${hex}","created":true}`, "send")).toBeUndefined();
    expect(parseBridgeAck(`{"id":"send:abc","created":true}`, "send")).toBeUndefined();
    expect(parseBridgeAck(`{"id":"send:${hex}"}`, "send")).toBeUndefined();
    expect(parseBridgeAck("not json", "send")).toBeUndefined();
    expect(parseBridgeAck("", "send")).toBeUndefined();
  });
});

describe("bridgeCliError", () => {
  it("passes on only the CLI's error line, cleaned and capped", () => {
    expect(
      bridgeCliError(
        'noise\n{"error":"Bridge request failed (HTTP 403): not\\u0007 allowed"}\n',
        1,
      ),
    ).toBe("Bridge request failed (HTTP 403): not allowed");
    expect(bridgeCliError(JSON.stringify({ error: "x".repeat(900) }), 1)).toHaveLength(500);
  });

  it("falls back to the exit code without echoing raw output", () => {
    const message = bridgeCliError("SECRET_TOKEN=abc stack trace", 2);
    expect(message).toBe("iMessage bridge CLI failed (exit 2)");
    expect(bridgeCliError("", null)).toBe("iMessage bridge CLI failed");
  });
});

describe("bridgeCliPaths", () => {
  it("uses the env overrides, else the deployed defaults", () => {
    expect(bridgeCliPaths({}, "/Users/me")).toEqual({
      bun: "/Users/me/.bun/bin/bun",
      cli: "/Users/me/.local/share/spectrum-bridge/src/cli.ts",
    });
    expect(
      bridgeCliPaths({ ROBOB_BUN: "/opt/bun", ROBOB_IMESSAGE_BRIDGE_CLI: "/x/cli.ts" }, "/h"),
    ).toEqual({ bun: "/opt/bun", cli: "/x/cli.ts" });
  });
});
