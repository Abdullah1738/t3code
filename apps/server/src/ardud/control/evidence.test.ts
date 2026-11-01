import { describe, expect, it } from "@effect/vitest";

import { messagePreview, runToolEvidence } from "./evidence.ts";

const assistant = { type: "assistant_message" } as const;
const command = { type: "command_execution" } as const;

describe("runToolEvidence", () => {
  it("is none only when the run is terminal and every item is loaded with no tool item", () => {
    const evidence = runToolEvidence({
      runStatus: "completed",
      turnItems: [assistant, assistant],
      itemsComplete: true,
    });
    expect(evidence).toStrictEqual({ toolEvidence: "none", complete: true });
  });

  it("is unknown when the run is still going, even with no tool item seen so far", () => {
    const evidence = runToolEvidence({
      runStatus: "running",
      turnItems: [assistant],
      itemsComplete: true,
    });
    expect(evidence.toolEvidence).toBe("unknown");
    expect(evidence.complete).toBe(false);
  });

  it("is unknown when some of the run's items were not loaded", () => {
    const evidence = runToolEvidence({
      runStatus: "completed",
      turnItems: [assistant],
      itemsComplete: false,
    });
    expect(evidence.toolEvidence).toBe("unknown");
    expect(evidence.complete).toBe(false);
  });

  it("is unknown when the run status is unavailable", () => {
    const evidence = runToolEvidence({
      runStatus: null,
      turnItems: [assistant],
      itemsComplete: true,
    });
    expect(evidence.toolEvidence).toBe("unknown");
  });

  it("is ran when any tool item is found, even on a partial read", () => {
    const evidence = runToolEvidence({
      runStatus: "running",
      turnItems: [assistant, command],
      itemsComplete: false,
    });
    expect(evidence.toolEvidence).toBe("ran");
    expect(evidence.complete).toBe(false);
  });

  it("is ran for a completed run whose items are all loaded and include a tool", () => {
    const evidence = runToolEvidence({
      runStatus: "completed",
      turnItems: [command, assistant],
      itemsComplete: true,
    });
    expect(evidence).toStrictEqual({ toolEvidence: "ran", complete: true });
  });
});

describe("messagePreview", () => {
  it("returns short text unchanged and cuts long text to 200 characters", () => {
    expect(messagePreview({ text: "hello" })).toBe("hello");
    expect(messagePreview({ text: "x".repeat(500) }).length).toBe(200);
  });
});
