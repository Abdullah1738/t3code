import { describe, expect, it } from "vite-plus/test";

import {
  VIEW_MARKDOWN_READER_CHARS,
  viewMarkdownChunks,
  viewMarkdownFold,
  viewMarkdownPreview,
} from "./markdownFold.ts";

const section = (n: number, bullets: number) =>
  [
    `## Section ${n}`,
    "",
    `Lead paragraph for section ${n}, long enough to wrap a line or two on a phone.`,
    "",
    ...Array.from({ length: bullets }, (_, i) => `- Point ${n}.${i} with a few words of detail`),
    "",
  ].join("\n");

const report = (sections: number, bullets = 8) =>
  ["# Daily report", "", "_Written at 09:00._", "", ""].join("\n") +
  Array.from({ length: sections }, (_, n) => section(n, bullets)).join("\n");

const fenced = (lines: number) =>
  ["```ts", ...Array.from({ length: lines }, (_, i) => `## not a heading ${i}`), "```"].join("\n");

const squash = (text: string) => text.replace(/\s+/g, " ").trim();

/** A heading, a paragraph after a blank line, or a list's first item. */
const BLOCK_START = /^(?:## Section \d+\n|Lead paragraph|- Point \d+\.0 )/;

describe("viewMarkdownFold", () => {
  const fits = { chars: 1_000, cut: false, contentHeight: 300, capHeight: 400 };

  it("offers nothing when the block is uncapped or fits", () => {
    expect(viewMarkdownFold({ ...fits, capHeight: null, contentHeight: 9_000 })).toBe("none");
    expect(viewMarkdownFold(fits)).toBe("none");
    expect(viewMarkdownFold({ ...fits, contentHeight: 400.6 })).toBe("none");
    expect(viewMarkdownFold({ ...fits, contentHeight: null })).toBe("none");
  });

  it("grows in place when an ordinary block overflows", () => {
    expect(viewMarkdownFold({ ...fits, contentHeight: 402 })).toBe("inline");
    expect(viewMarkdownFold({ ...fits, cut: true, contentHeight: 100 })).toBe("inline");
  });

  it("opens the reader for a long report", () => {
    const chars = VIEW_MARKDOWN_READER_CHARS + 1;
    expect(viewMarkdownFold({ ...fits, chars, cut: true })).toBe("reader");
    expect(viewMarkdownFold({ ...fits, chars: VIEW_MARKDOWN_READER_CHARS, cut: true })).toBe(
      "inline",
    );
    expect(viewMarkdownFold({ ...fits, chars })).toBe("none");
  });
});

describe("viewMarkdownPreview", () => {
  it("keeps a short text whole", () => {
    const text = report(2);
    expect(viewMarkdownPreview(text, 40)).toEqual({ text, cut: false });
  });

  it("cuts a long text where a block starts", () => {
    const text = report(200);
    const preview = viewMarkdownPreview(text, 40);
    expect(preview.cut).toBe(true);
    expect(text.startsWith(preview.text)).toBe(true);
    expect(preview.text.length).toBeGreaterThan(40 * 160 - 4);
    expect(preview.text.length).toBeLessThan(40 * 160 * 2);
    expect(text.slice(preview.text.length).trimStart()).toMatch(BLOCK_START);
  });

  it("ends a prefix at a line when no block starts nearby", () => {
    const text = Array.from({ length: 2_000 }, (_, i) => `line ${i} of a long run`).join("\n");
    const preview = viewMarkdownPreview(text, 40);
    expect(preview.cut).toBe(true);
    expect(preview.text.length).toBeLessThanOrEqual(40 * 160 * 2);
    expect(text.startsWith(`${preview.text}\n`)).toBe(true);
  });

  it("ends a code block whole when it closes near the budget", () => {
    const text = `${report(1)}\n${fenced(60)}\n\nAfter the code.\n\n${report(30)}`;
    const preview = viewMarkdownPreview(text, 10);
    expect(preview.cut).toBe(true);
    expect(preview.text.endsWith("```")).toBe(true);
  });

  it("cuts a huge code block at a line", () => {
    const text = `${report(1)}\n${fenced(800)}\n\nAfter the code.`;
    const preview = viewMarkdownPreview(text, 10);
    expect(preview.cut).toBe(true);
    expect(preview.text.length).toBeLessThanOrEqual(10 * 160 * 2);
    expect(text.startsWith(`${preview.text}\n`)).toBe(true);
  });
});

describe("viewMarkdownChunks", () => {
  const texts = (text: string, target?: number) =>
    viewMarkdownChunks(text, target).map((chunk) => chunk.text);

  it("splits a report at block starts and loses nothing", () => {
    const text = report(400);
    const chunks = viewMarkdownChunks(text);
    expect(chunks.length).toBeGreaterThan(10);
    expect(squash(chunks.map((chunk) => chunk.text).join("\n\n"))).toBe(squash(text));
    for (const chunk of chunks.slice(1)) {
      expect(chunk.text).toMatch(BLOCK_START);
      expect(chunk.continuesList).toBe(false);
    }
    for (const chunk of chunks.slice(0, -1)) expect(chunk.text.length).toBeLessThan(6_000 * 2);
  });

  it("falls back to list items when a section is one long list", () => {
    const text = report(1, 2_000);
    const chunks = viewMarkdownChunks(text);
    expect(chunks.length).toBeGreaterThan(5);
    expect(squash(chunks.map((chunk) => chunk.text).join("\n"))).toBe(squash(text));
    for (const chunk of chunks.slice(1)) {
      expect(chunk.text).toMatch(/^- Point 0\.\d+/);
      expect(chunk.continuesList).toBe(true);
    }
  });

  it("keeps a code block in one piece", () => {
    const text = `Intro.\n\n${fenced(2_000)}\n\nAfter the code.`;
    const chunks = texts(text, 500);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toMatch(/```$/);
    expect(chunks[1]).toBe("After the code.");
  });

  it("only closes a fence on a bare run of its character", () => {
    const body = Array.from({ length: 400 }, (_, i) => `## still code ${i}`).join("\n");
    const text = `Intro.\n\n\`\`\`\n${body}\n\`\`\`js\n${body}\n\`\`\`\n\nAfter the code.`;
    expect(texts(text, 500)).toEqual([
      text.slice(0, -"\n\nAfter the code.".length),
      "After the code.",
    ]);
  });

  it("reads Windows line endings", () => {
    const text = report(400).replace(/\n/g, "\r\n");
    const chunks = texts(text);
    expect(chunks.length).toBeGreaterThan(10);
    for (const chunk of chunks.slice(1))
      expect(chunk).toMatch(/^(?:## Section|Lead paragraph|- Point)/);
  });

  it("doesn't split before paragraph text that only looks like a list", () => {
    const line = "A sentence that runs on without a blank line after it,";
    const text = Array.from({ length: 400 }, (_, i) => (i % 2 ? "2024. A year" : line)).join("\n");
    expect(texts(text, 500)).toEqual([text]);
  });

  it("ends even with a target of zero", () => {
    expect(texts("One.\n\nTwo.", 0)).toEqual(["One.", "Two."]);
  });
});
