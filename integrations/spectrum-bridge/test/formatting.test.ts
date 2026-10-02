import { describe, expect, test } from "bun:test";
import { formatText, hasUrl, isSingleUrl, splitFormatted, stripInternalText } from "../src/formatting.ts";

describe("stripInternalText DCP metadata", () => {
  test("drops a trailing bare boundary id line", () => {
    expect(stripInternalText("All done, the deploy is green.\n\n@162@")).toBe("All done, the deploy is green.");
    expect(stripInternalText("Done.\n@162@  \n")).toBe("Done.");
  });

  test("drops inline block and blocked ids bounded by spaces or punctuation", () => {
    expect(stripInternalText("See the summary @b7@ above.")).toBe("See the summary above.");
    expect(stripInternalText("Nothing to add (@blocked@).")).toBe("Nothing to add ().");
    expect(stripInternalText("@12@ Start here, then @b3@, done")).toBe("Start here, then, done");
    expect(stripInternalText("@BLOCKED@ yes")).toBe("yes");
  });

  test("keeps emails, @mentions and look-alikes that are not standalone tokens", () => {
    const keep = "Mail abdullah@example.com or ping @Abdullah, @162 and 162@ and a@1@b stay; foo@162@ too.";
    expect(stripInternalText(keep)).toBe(keep);
    expect(stripInternalText("@@162@@")).toBe("@@162@@");
  });

  test("keeps an id inside URLs and code", () => {
    const keep = "Open https://example.com/a/@123@/b?x=@b7@ and run `echo @162@` then\n```\n@blocked@\n```";
    expect(stripInternalText(keep)).toBe(keep);
  });

  test("removes dcp-system-reminder blocks and stray dcp tags", () => {
    expect(stripInternalText("Before.\n\n<dcp-system-reminder>\nCompress now.\n</dcp-system-reminder>\n\nAfter.")).toBe("Before.\n\nAfter.");
    expect(stripInternalText("Hi <dcp-message-id priority=\"high\">m0007</dcp-message-id> there")).toBe("Hi there");
    expect(stripInternalText("Hi <dcp-message-id>b2</dcp-message-id>")).toBe("Hi");
    expect(stripInternalText("Hi </dcp-system-reminder> there <dcp-x/>")).toBe("Hi there");
    expect(stripInternalText("a <dcpfoo> b")).toBe("a <dcpfoo> b");
  });

  test("removes exact compressed-section header lines only", () => {
    expect(stripInternalText("[Compressed conversation section]\nThe answer is 4.\n\n\n\nBye")).toBe("The answer is 4.\n\nBye");
    const keep = "Quoted: [Compressed conversation section] mid-line stays";
    expect(stripInternalText(keep)).toBe(keep);
  });

  test("a message of nothing but metadata becomes empty", () => {
    expect(stripInternalText("@162@")).toBe("");
    expect(stripInternalText("\n<dcp-system-reminder>x</dcp-system-reminder>\n@b7@\n[Compressed conversation section]\n")).toBe("");
  });
});

describe("stripInternalText", () => {
  test("removes closed blocks wherever they sit and keeps the real text", () => {
    expect(stripInternalText("<think>Plans the reply.</think>Here's the answer.")).toBe("Here's the answer.");
    expect(stripInternalText("Yes.\n\n<think>\nsecond-guessing\n</think>\n\nDone.")).toBe("Yes.\n\nDone.");
    expect(stripInternalText("<thinking>deep thoughts</thinking> <INTERNAL>more</INTERNAL> ok")).toBe("ok");
    expect(stripInternalText("<reasoning>why</reasoning>")).toBe("");
  });

  test("drops an unclosed block to the end and removes orphan closing tags", () => {
    expect(stripInternalText("Hello <think>keeps going forever")).toBe("Hello");
    expect(stripInternalText("Hmm.</think> Final answer.")).toBe("Hmm. Final answer.");
    expect(stripInternalText("Ant tags <antml:thinking>x</antml:thinking> too")).toBe("Ant tags too");
  });

  test("leaves ordinary text, code and URLs untouched", () => {
    const keep = "I think **bold** counts: <3 and <think twice about it.";
    expect(stripInternalText(keep)).toBe(keep);
  });

  test("a raw internal-looking tag still gets cut even inside a URL path", () => {
    expect(stripInternalText("see https://x.test/page</thinking> for details")).toBe("see https://x.test/page for details");
  });

  test("formatting ranges survive a stripped prefix", () => {
    expect(formatText("<think>x</think> a **bold** move")).toEqual({
      text: "a bold move", formatting: [{ type: "bold", start: 2, length: 4 }],
    });
  });
});

describe("formatText", () => {
  test("strips bold, italic, and strikethrough markers into UTF-16 ranges", () => {
    expect(formatText("**Bold** then *it* and ~~gone~~.")).toEqual({ text: "Bold then it and gone.", formatting: [
      { type: "bold", start: 0, length: 4 }, { type: "italic", start: 10, length: 2 }, { type: "strikethrough", start: 17, length: 4 },
    ] });
  });

  test("ranges count UTF-16 units, including astral characters", () => {
    expect(formatText("\u{1F600} **\u{1F680}x** done")).toEqual({ text: "\u{1F600} \u{1F680}x done",
      formatting: [{ type: "bold", start: 3, length: 3 }] });
  });

  test("nested italic inside bold keeps both ranges", () => {
    expect(formatText("**a *b* c**")).toEqual({ text: "a b c", formatting: [
      { type: "bold", start: 0, length: 5 }, { type: "italic", start: 2, length: 1 },
    ] });
  });

  test.each([
    "a * b * c", "* list\n* item", "- item *", "2*3*4", "word*s*", "**a**b", "x**a**", "snake_case_name", "_under_ __score__",
    "`**code**`", "```\n**block**\n```", "https://x.test/**a**/*b*", "http://x.test/~~a~~", "** spaced **", "* spaced *",
    "~~ spaced ~~", "***", "**", "**unclosed", "a*b*c", "3 * 4 = 12 and 5 * 6", "path/*glob*/x",
  ])("leaves %j untouched", text => {
    expect(formatText(text)).toEqual({ text, formatting: [] });
  });

  test("protected spans do not block formatting elsewhere on the line", () => {
    expect(formatText("run `a*b*c` then **go** https://x.test/*y*")).toEqual({
      text: "run `a*b*c` then go https://x.test/*y*", formatting: [{ type: "bold", start: 17, length: 2 }],
    });
  });

  test("markers next to punctuation and quotes still pair", () => {
    expect(formatText("(**a**), \"*b*\"!").text).toBe("(a), \"b\"!");
  });

  test("formatting never crosses lines", () => {
    expect(formatText("**a\nb**")).toEqual({ text: "**a\nb**", formatting: [] });
  });
});

describe("splitFormatted", () => {
  test("splits on code points and clips ranges per chunk", () => {
    expect(splitFormatted(formatText("x **abcd** y"), 4)).toEqual([
      { text: "x ab", formatting: [{ type: "bold", start: 2, length: 2 }] },
      { text: "cd y", formatting: [{ type: "bold", start: 0, length: 2 }] },
    ]);
    const astral = splitFormatted({ text: "\u{1F600}\u{1F600}\u{1F600}", formatting: [{ type: "italic", start: 2, length: 2 }] }, 1);
    expect(astral.map(chunk => chunk.text)).toEqual(["\u{1F600}", "\u{1F600}", "\u{1F600}"]);
    expect(astral.map(chunk => chunk.formatting)).toEqual([[], [{ type: "italic", start: 0, length: 2 }], []]);
    expect(splitFormatted({ text: "", formatting: [] }, 3)).toEqual([]);
  });
});

test("hasUrl detects only http(s) links", () => {
  expect(hasUrl("see https://x.test")).toBe(true);
  expect(hasUrl("HTTP://x.test")).toBe(true);
  expect(hasUrl("ftp://x.test https:// ")).toBe(false);
  expect(hasUrl("no link")).toBe(false);
});

test("isSingleUrl accepts only a message that is exactly one http(s) URL", () => {
  expect(isSingleUrl("https://x.test/a?b=1")).toBe(true);
  expect(isSingleUrl("  http://x.test  ")).toBe(false);
  expect(isSingleUrl("see https://x.test")).toBe(false);
  expect(isSingleUrl("https://x.test\nhttps://y.test")).toBe(false);
  expect(isSingleUrl("ftp://x.test")).toBe(false);
});
