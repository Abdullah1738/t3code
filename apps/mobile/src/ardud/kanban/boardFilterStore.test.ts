import { describe, expect, it } from "vite-plus/test";

import {
  boardFilterFor,
  publishBoardFilter,
  subscribeBoardFilters,
} from "./boardFilterStore";

describe("boardFilterStore", () => {
  it("defaults to hiding settled cards", () => {
    expect(boardFilterFor("board-default")).toEqual({ settled: "hide" });
  });

  it("returns the published filter", () => {
    publishBoardFilter("board-read", { settled: "include", priorities: [1] });
    expect(boardFilterFor("board-read")).toEqual({ settled: "include", priorities: [1] });
  });

  it("notifies on a change but not on an equal filter", () => {
    const boardId = "board-notify";
    let calls = 0;
    const unsubscribe = subscribeBoardFilters(() => {
      calls += 1;
    });
    publishBoardFilter(boardId, { settled: "only" });
    expect(calls).toBe(1);
    publishBoardFilter(boardId, { settled: "only" });
    expect(calls).toBe(1);
    publishBoardFilter(boardId, { settled: "hide" });
    expect(calls).toBe(2);
    unsubscribe();
  });

  it("stops notifying after unsubscribe", () => {
    const boardId = "board-unsub";
    let calls = 0;
    const unsubscribe = subscribeBoardFilters(() => {
      calls += 1;
    });
    unsubscribe();
    publishBoardFilter(boardId, { settled: "include" });
    expect(calls).toBe(0);
  });

  it("keeps two boards apart", () => {
    publishBoardFilter("board-a", { settled: "include", query: "alpha" });
    publishBoardFilter("board-b", { settled: "only", query: "beta" });
    expect(boardFilterFor("board-a")).toEqual({ settled: "include", query: "alpha" });
    expect(boardFilterFor("board-b")).toEqual({ settled: "only", query: "beta" });
  });
});
