import { describe, expect, it } from "@effect/vitest";

import { messagePreview, providerTurnsSettled, runToolEvidence } from "./evidence.ts";

const assistant = { type: "assistant_message" } as const;
const command = { type: "command_execution" } as const;
const turn = (status: string) => ({ status }) as never;

describe("providerTurnsSettled", () => {
  it("is true only when every native stream of the run completed", () => {
    expect(providerTurnsSettled([turn("completed"), turn("completed")])).toBe(true);
  });

  it("is false for a lost or abandoned stream, since tools may have run unseen", () => {
    expect(providerTurnsSettled([turn("completed"), turn("running")])).toBe(false);
    expect(providerTurnsSettled([turn("interrupted")])).toBe(false);
    expect(providerTurnsSettled([turn("failed")])).toBe(false);
    expect(providerTurnsSettled([turn("cancelled")])).toBe(false);
  });

  it("is false for a run with no provider turn, since nothing proves its streams settled", () => {
    expect(providerTurnsSettled([])).toBe(false);
  });
});

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

  it("is unknown for a completed run whose stream was lost, so a retry is never allowed on silence", () => {
    // The route computes itemsComplete from the run's provider turns; a lost stream fails that.
    const evidence = runToolEvidence({
      runStatus: "completed",
      turnItems: [assistant],
      itemsComplete: providerTurnsSettled([turn("completed"), turn("interrupted")]),
    });
    expect(evidence.toolEvidence).toBe("unknown");
    expect(evidence.complete).toBe(false);
  });

  it("is none only when the run completed, every native stream settled and no tool item exists", () => {
    const evidence = runToolEvidence({
      runStatus: "completed",
      turnItems: [assistant],
      itemsComplete: providerTurnsSettled([turn("completed")]),
    });
    expect(evidence).toStrictEqual({ toolEvidence: "none", complete: true });
  });
});

describe("messagePreview", () => {
  it("returns short text unchanged and cuts long text to 200 characters", () => {
    expect(messagePreview({ text: "hello" })).toBe("hello");
    expect(messagePreview({ text: "x".repeat(500) }).length).toBe(200);
  });
});
