import { describe, expect, it } from "vite-plus/test";
import {
  ASSISTANT_CITATION_CONTEXT_LENGTH,
  EnvironmentId,
  MessageId,
  ThreadId,
} from "@t3tools/contracts";

import { formatAssistantCitationHref, parseAssistantCitationHref } from "./assistantCitations.ts";
import {
  type AssistantTextSelector,
  createAssistantTextSelector,
  findAssistantCitationText,
  locateAssistantTextSelector,
} from "./assistantTextSelection.ts";

function selector(
  text: string,
  overrides: Partial<Omit<AssistantTextSelector, "text">> = {},
): AssistantTextSelector {
  return {
    text,
    start: 0,
    end: text.replace(/\s+/g, " ").length,
    prefix: "",
    suffix: "",
    ...overrides,
  };
}

function roundTripSelector(selector: AssistantTextSelector) {
  return parseAssistantCitationHref(
    formatAssistantCitationHref({
      version: 1,
      environmentId: EnvironmentId.make("environment"),
      threadId: ThreadId.make("thread"),
      messageId: MessageId.make("assistant"),
      ...selector,
    }),
  );
}

describe("createAssistantTextSelector", () => {
  it("keeps exact selected whitespace while normalizing its UTF-16 positions", () => {
    const text = "Before \n  quote\t \n after";
    expect(
      createAssistantTextSelector(text, "Before \n".length, "Before \n  quote\t".length),
    ).toEqual({
      text: "  quote\t",
      start: 6,
      end: 13,
      prefix: "Before",
      suffix: "after",
    });
  });

  it.each([
    0,
    ASSISTANT_CITATION_CONTEXT_LENGTH - 2,
    ASSISTANT_CITATION_CONTEXT_LENGTH - 1,
    ASSISTANT_CITATION_CONTEXT_LENGTH,
  ])("keeps complete context code points with %i neighboring UTF-16 units", (paddingLength) => {
    const padding = "x".repeat(paddingLength);
    const text = `😀${padding}quote${padding}🚀`;
    const start = text.indexOf("quote");
    const captured = createAssistantTextSelector(text, start, start + 5);
    const keepEmoji = paddingLength + 2 <= ASSISTANT_CITATION_CONTEXT_LENGTH;
    expect(captured).toEqual({
      text: "quote",
      start,
      end: start + 5,
      prefix: `${keepEmoji ? "😀" : ""}${padding}`,
      suffix: `${padding}${keepEmoji ? "🚀" : ""}`,
    });
    expect(roundTripSelector(captured!)).toMatchObject(captured!);
  });

  it("preserves multiline quotes and their matching location through a citation URL", () => {
    const quote = "selected\r\n  code 🚀";
    const prefix = "x".repeat(ASSISTANT_CITATION_CONTEXT_LENGTH - 1);
    const suffix = "y".repeat(ASSISTANT_CITATION_CONTEXT_LENGTH - 1);
    const text = `${quote} elsewhere\n😀${prefix}${quote}${suffix}🚀`;
    const rawStart = text.lastIndexOf(quote);
    const captured = createAssistantTextSelector(text, rawStart, rawStart + quote.length);
    const start = "selected code 🚀 elsewhere 😀".length + prefix.length;
    const end = start + "selected code 🚀".length;
    expect(captured).toEqual({ text: quote, start, end, prefix, suffix });

    const parsed = roundTripSelector(captured!);
    expect(parsed).toMatchObject(captured!);
    expect(findAssistantCitationText(text, parsed!)).toEqual({ start, end });
    expect(findAssistantCitationText(`Inserted paragraph.\n${text}`, parsed!)).toEqual({
      start: "Inserted paragraph. ".length + start,
      end: "Inserted paragraph. ".length + end,
    });
  });

  it.each(["prefix", "suffix"])(
    "does not relocate to a replacement-character decoy after clipping the %s",
    (side) => {
      const prefix = "x".repeat(ASSISTANT_CITATION_CONTEXT_LENGTH - (side === "prefix" ? 1 : 0));
      const suffix = "y".repeat(ASSISTANT_CITATION_CONTEXT_LENGTH - (side === "suffix" ? 1 : 0));
      const occurrence = (character: string) =>
        `${side === "prefix" ? character : ""}${prefix}quote${suffix}${side === "suffix" ? character : ""}`;
      const text = `${occurrence("😀")} / ${occurrence("\uFFFD")}`;
      const start = text.indexOf("quote");
      const captured = createAssistantTextSelector(text, start, start + 5);
      const parsed = roundTripSelector(captured!);
      expect(parsed).toMatchObject(captured!);
      expect(findAssistantCitationText(text, captured!)).toBeNull();
      expect(findAssistantCitationText(text, parsed!)).toBeNull();
    },
  );

  it.each(["", " \n\t\r\n"])("rejects empty or whitespace-only selections: %j", (text) => {
    expect(createAssistantTextSelector(text, 0, text.length)).toBeNull();
  });
});

describe("findAssistantCitationText", () => {
  it("resolves an exact selection with its saved position and context", () => {
    expect(
      findAssistantCitationText(
        "Before the selected text after.",
        selector("selected text", { start: 11, end: 24, prefix: "Before the ", suffix: " after." }),
      ),
    ).toEqual({ start: 11, end: 24 });
  });

  it("finds a unique quote when insertion before it shifts its offsets", () => {
    expect(
      findAssistantCitationText(
        "An inserted paragraph. Before the selected text after.",
        selector("selected text", { start: 11, end: 24, prefix: "Before the ", suffix: " after." }),
      ),
    ).toEqual({ start: 34, end: 47 });
  });

  it("still finds a unique quote after its surrounding text changes", () => {
    expect(
      findAssistantCitationText(
        "New selected text nearby.",
        selector("selected text", { start: 11, end: 24, prefix: "Before the ", suffix: " after." }),
      ),
    ).toEqual({ start: 4, end: 17 });
  });

  it("uses both context sides when each side alone matches several repeated quotes", () => {
    const text = "left quote one; other quote two; left quote two";
    expect(
      findAssistantCitationText(
        text,
        selector("quote", { start: 5, end: 10, prefix: "left ", suffix: " two" }),
      ),
    ).toEqual({ start: 38, end: 43 });
  });

  it("does not trust stale offsets that now point at another occurrence", () => {
    expect(
      findAssistantCitationText(
        "wrong quote here; right quote there",
        selector("quote", { start: 6, end: 11, prefix: "right ", suffix: " there" }),
      ),
    ).toEqual({ start: 24, end: 29 });
  });

  it.each([
    { prefix: "first ", suffix: "", expected: { start: 6, end: 11 } },
    { prefix: "", suffix: " last", expected: { start: 14, end: 19 } },
  ])(
    "allows a single context side to disambiguate: $prefix / $suffix",
    ({ expected, ...context }) => {
      expect(
        findAssistantCitationText("first quote / quote last", selector("quote", context)),
      ).toEqual(expected);
    },
  );

  it("does not guess between quotes without context, even at the saved position", () => {
    expect(findAssistantCitationText("quote / quote", selector("quote"))).toBeNull();
  });

  it("does not use distance or saved offsets to break a context tie", () => {
    expect(
      findAssistantCitationText(
        "same quote end / same quote end",
        selector("quote", { start: 5, end: 10, prefix: "same ", suffix: " end" }),
      ),
    ).toBeNull();
  });

  it("rejects repeated quotes when neither occurrence matches all supplied context", () => {
    expect(
      findAssistantCitationText(
        "left quote wrong / wrong quote right",
        selector("quote", { prefix: "left ", suffix: " right" }),
      ),
    ).toBeNull();
  });

  it("counts overlapping occurrences when checking ambiguity", () => {
    expect(findAssistantCitationText("banana", selector("ana", { start: 1, end: 4 }))).toBeNull();
  });

  it("matches multiline code after indentation, tabs, and line endings change", () => {
    const quote = "if (ready) {\r\n    run();\r\n}";
    expect(
      findAssistantCitationText(
        "Example:\nif (ready) {\n\trun();\n}\nDone.",
        selector(quote, { prefix: "Example:\n", suffix: "\nDone." }),
      ),
    ).toEqual({ start: 9, end: 30 });
  });

  it("normalizes nonbreaking spaces and keeps selected boundary whitespace", () => {
    expect(
      findAssistantCitationText(
        "before\u00a0\n quoted\t text \nafter",
        selector("\nquoted  text\t"),
      ),
    ).toEqual({ start: 6, end: 19 });
  });

  it("does not trim the document's leading whitespace out of its offsets", () => {
    expect(findAssistantCitationText("\n\t  quote", selector("quote"))).toEqual({
      start: 1,
      end: 6,
    });
  });

  it("uses UTF-16 offsets for emoji and combining characters", () => {
    expect(findAssistantCitationText("😀 cafe\u0301 🚀 done", selector("cafe\u0301 🚀"))).toEqual({
      start: 3,
      end: 11,
    });
  });

  it("uses up to 32 UTF-16 context units without requiring the entire surrounding text", () => {
    const prefix = "x".repeat(ASSISTANT_CITATION_CONTEXT_LENGTH - 1) + " ";
    const suffix = " " + "y".repeat(ASSISTANT_CITATION_CONTEXT_LENGTH - 1);
    const text = `unrelated quote / ${prefix}quote${suffix} changed further away`;
    const start = text.lastIndexOf("quote");
    expect(findAssistantCitationText(text, selector("quote", { prefix, suffix }))).toEqual({
      start,
      end: start + 5,
    });
  });

  it.each(["", " \n\t\r\n", "absent", "QUOTE", "qu.te"])(
    "rejects empty or missing literal text: %j",
    (quote) => {
      expect(findAssistantCitationText("quote", selector(quote))).toBeNull();
    },
  );

  it.each([
    { start: -1, end: 4 },
    { start: 2.5, end: 7.5 },
    { start: Number.NaN, end: Number.NaN },
    { start: Number.POSITIVE_INFINITY, end: Number.POSITIVE_INFINITY },
    { start: 8, end: 3 },
  ])("treats invalid stored offsets as unusable hints: $start / $end", (offsets) => {
    expect(findAssistantCitationText("a quote", selector("quote", offsets))).toEqual({
      start: 2,
      end: 7,
    });
  });
});

describe("locateAssistantTextSelector", () => {
  it("adds position and context when the selected text occurs once", () => {
    const text = "Intro line.\nThe selected   text sits here.\nOutro.";
    const located = locateAssistantTextSelector(text, " selected text\n");

    expect(located).toEqual({
      text: "selected text",
      start: 16,
      end: 29,
      prefix: "Intro line. The ",
      suffix: " sits here. Outro.",
    });
    expect(findAssistantCitationText(text, roundTripSelector(located!)!)).toEqual({
      start: 16,
      end: 29,
    });
  });

  it("keeps only the quote when its position is ambiguous or unknown", () => {
    for (const text of ["quote / quote", "nothing to see"]) {
      const located = locateAssistantTextSelector(text, "quote");
      expect(located).toEqual(selector("quote"));
      expect(findAssistantCitationText(text, located!)).toBeNull();
    }
    expect(findAssistantCitationText("one quote", selector("quote"))).toEqual({
      start: 4,
      end: 9,
    });
  });

  it("rejects whitespace-only selections", () => {
    expect(locateAssistantTextSelector("text", " \n\t")).toBeNull();
  });
});
