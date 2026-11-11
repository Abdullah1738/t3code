import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import { KANBAN_CARD_ASK_GUIDE } from "./kanbanAskGuide.ts";

describe("KANBAN_CARD_ASK_GUIDE", () => {
  it("is the card_ask tool description the server gives agents", () => {
    const tools = NodeFS.readFileSync(
      new URL("../../../../apps/server/src/ardud/kanban/tools/tools.ts", import.meta.url),
      "utf8",
    );
    // The description is the third argument of the tool: its own string, or this constant.
    const description =
      /"card_ask",\s*"Ask the owner",\s*("(?:[^"\\]|\\.)*"|KANBAN_CARD_ASK_GUIDE)\s*,/.exec(
        tools,
      )?.[1];
    expect(description).toBeDefined();
    if (description !== "KANBAN_CARD_ASK_GUIDE") {
      expect(JSON.parse(description!)).toBe(KANBAN_CARD_ASK_GUIDE);
    }
  });
});
