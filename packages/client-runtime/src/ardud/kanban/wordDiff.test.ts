import { describe, expect, it } from "vite-plus/test";

import { diffCount, diffPieces, diffReadsInline, wordDiff } from "./wordDiff.ts";

const text = (pieces: ReturnType<typeof diffPieces>) =>
  pieces
    .map((piece) => (piece.kind === "same" ? piece.text : `[${piece.kind[0]}:${piece.text}]`))
    .join("");

describe("wordDiff", () => {
  const before = "Cards in Needs owner wait for the owner. Do not move them.";
  const after = "Cards in Needs you wait for Abdullah. Do not move them.";
  const ops = wordDiff(before, after);

  it("counts the words added and removed", () => {
    expect(diffCount(ops)).toEqual({ added: 2, removed: 3 });
  });

  it("rebuilds each side", () => {
    expect(text(diffPieces(ops, "before")).replace(/\[r:([^\]]*)\]/g, "$1")).toBe(before);
    expect(text(diffPieces(ops, "after")).replace(/\[a:([^\]]*)\]/g, "$1")).toBe(after);
  });

  it("marks both in one text", () => {
    expect(text(diffPieces(ops, "both"))).toBe(
      "Cards in Needs [r:owner] [a:you] wait for [r:the owner.] [a:Abdullah.] Do not move them.",
    );
  });

  it("reads a reworded line inline and a rewritten one as was / now", () => {
    expect(diffReadsInline(ops, before, after)).toBe(true);
    const rewritten = "Which port should the bridge listen on from now?";
    expect(diffReadsInline(wordDiff(before, rewritten), before, rewritten)).toBe(false);
  });

  it("handles empty sides", () => {
    expect(wordDiff("", "new text")).toEqual([{ kind: "+", text: "new text" }]);
    expect(wordDiff("same", "same")).toEqual([{ kind: "=", text: "same" }]);
  });
});
