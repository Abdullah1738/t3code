import { assert, it } from "@effect/vitest";

import { controlChars, textProblem } from "./text.ts";

it("accepts tabs, newlines, Unicode and emoji", () => {
  assert.isNull(controlChars("§ tab\tline\nreturn\r😀 —"));
  assert.isNull(textProblem([["message", "§ tab\tline\nreturn\r😀 —"]]));
});

it("counts control characters and reports the first UTF-16 offset", () => {
  assert.deepStrictEqual(controlChars("ab\u0000cd\u0003"), { offset: 2, char: 0, count: 2 });
  assert.deepStrictEqual(controlChars("😀\u007f"), { offset: 2, char: 0x7f, count: 1 });
});

it("names the first bad field and formats its control character, offset and count", () => {
  assert.strictEqual(
    textProblem([
      ["title", null],
      ["description", "clean"],
      ["comment", "ab\u0000cd\u0003"],
      ["note", "\u007f"],
    ]),
    "comment has a control character U+0000 at offset 2 (2 in all). Board text can't hold control characters other than tab and newlines, so nothing was saved. This usually means a broken decode; in Code Mode, Uint8Array.from(text, fn) ignores fn, so decode base64 with Uint8Array.fromBase64(b64).",
  );
  assert.include(textProblem([["note", "x\u007f"]]) ?? "", "U+007F at offset 1 (1 in all)");
});
