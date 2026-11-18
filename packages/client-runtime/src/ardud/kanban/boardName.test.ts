import { describe, expect, it } from "vite-plus/test";

import { boardRenameValue } from "./boardName.ts";

describe("boardRenameValue", () => {
  it.each([
    ["", "Robob", null],
    ["   ", "Robob", null],
    ["\t\r\n", "Robob", null],
    ["\u00a0\u2003", "Robob", null],
    ["Robob", "Robob", null],
    ["  Robob\t", "Robob", null],
    ["Robob", " Robob ", null],
    ["  Board work  ", "Robob", "Board work"],
    ["robob", "Robob", "robob"],
    ["Board  work", "Robob", "Board  work"],
    ["لوحة", "Robob", "لوحة"],
  ])("normalizes %j against %j", (value, current, expected) => {
    expect(boardRenameValue(value, current)).toBe(expected);
  });
});
