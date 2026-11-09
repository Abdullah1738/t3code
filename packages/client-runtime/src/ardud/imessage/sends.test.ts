import { describe, expect, it } from "vite-plus/test";

import { imessageSendOf, isIMessageSendTool, shellCommands } from "./sends.ts";

const at = "2026-11-09T09:00:00.000Z";

describe("isIMessageSendTool", () => {
  it("matches the tool under every harness's prefix and nothing else", () => {
    for (const name of [
      "imessage_send",
      "mcp__t3-code__imessage_send",
      "t3-code.imessage_send",
      "t3-code-thread_1_imessage_send",
    ]) {
      expect(isIMessageSendTool(name)).toBe(true);
    }
    for (const name of ["imessage_sender", "xyimessage_send", "send", null]) {
      expect(isIMessageSendTool(name)).toBe(false);
    }
  });
});

describe("shellCommands", () => {
  it("splits on control operators and honours quotes", () => {
    expect(
      shellCommands(
        `cd /x && bun cli.ts send --text "It's \\"done\\"" --key 'a b'; echo $'one\\ntwo'`,
      ),
    ).toEqual([
      ["cd", "/x"],
      ["bun", "cli.ts", "send", "--text", 'It\'s "done"', "--key", "a b"],
      ["echo", "one\ntwo"],
    ]);
  });
});

describe("imessageSendOf", () => {
  it("reads a CLI send with --to and --flag=value", () => {
    expect(
      imessageSendOf({
        id: "c",
        createdAt: at,
        tone: "tool",
        command:
          "/Users/a/.bun/bin/bun /Users/a/.local/share/spectrum-bridge/src/cli.ts send --to moni --session s --key=k --text 'Ride is booked'",
      }),
    ).toEqual({
      id: "c",
      text: "Ride is booked",
      file: null,
      to: "moni",
      state: "sent",
      via: "cli",
      createdAt: at,
    });
  });

  it("ignores other bridge commands and other tools", () => {
    expect(
      imessageSendOf({
        id: "c",
        createdAt: at,
        tone: "tool",
        command: "bun ~/.local/share/spectrum-bridge/src/cli.ts react --target m --kind like",
      }),
    ).toBeNull();
    expect(
      imessageSendOf({
        id: "t",
        createdAt: at,
        tone: "tool",
        payload: {
          type: "dynamic_tool",
          toolName: "mcp__t3-code__t3_thread_send",
          input: { message: "x" },
        },
      }),
    ).toBeNull();
  });

  it("marks a tool send still running as sending", () => {
    expect(
      imessageSendOf({
        id: "t",
        createdAt: at,
        tone: "tool",
        payload: {
          type: "dynamic_tool",
          toolName: "imessage_send",
          status: "running",
          input: { text: "On it" },
        },
      }),
    ).toMatchObject({ state: "sending", via: "tool", text: "On it" });
  });
});
