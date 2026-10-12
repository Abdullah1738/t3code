import {
  ASSISTANT_CITATION_MAX_TEXT_LENGTH,
  EnvironmentId,
  MessageId,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  ThreadId,
} from "@t3tools/contracts";
import { collectAssistantCitations } from "@t3tools/shared/assistantCitations";
import { findAssistantCitationText } from "@t3tools/shared/assistantTextSelection";
import { describe, expect, it } from "vite-plus/test";

import {
  assistantMarkdownText,
  createMobileAssistantCitation,
  insertAssistantCitation,
} from "./assistantCitationSelection";

const ids = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
  messageId: MessageId.make("message-1"),
};

const markdown = [
  "## Plan",
  "",
  "Retry the **upload** once, then [check the logs](https://example.com/logs).",
  "",
  "- First `step`",
  "- Second step",
  "",
  "```ts",
  "retry();",
  "```",
  "",
  "![diagram](https://example.com/a.png)",
].join("\n");

describe("assistantMarkdownText", () => {
  it("keeps the words a reader sees, block by block, and drops Markdown syntax", () => {
    const text = assistantMarkdownText(markdown);
    expect(text.replace(/\s+/g, " ")).toBe(
      "Plan Retry the upload once, then check the logs. First step Second step retry();",
    );
    expect(text).toMatch(/^Plan\n+Retry/);
  });
});

describe("createMobileAssistantCitation", () => {
  it("records where a unique selection sits so web can find it again", () => {
    const citation = createMobileAssistantCitation({
      ...ids,
      markdown,
      selectedText: "upload once, then check\nthe logs",
    });
    expect(citation).toMatchObject({
      ...ids,
      version: 1,
      text: "upload once, then check\nthe logs",
      prefix: "Plan Retry the ",
      suffix: ". First step Second step retry()",
    });
    if (citation === null || citation === "too-long") throw new Error("expected a citation");
    expect(findAssistantCitationText(assistantMarkdownText(markdown), citation)).toEqual({
      start: citation.start,
      end: citation.end,
    });
  });

  it("keeps a repeated selection without a position web could resolve to the wrong place", () => {
    expect(createMobileAssistantCitation({ ...ids, markdown, selectedText: "step" })).toEqual({
      ...ids,
      version: 1,
      text: "step",
      start: 0,
      end: 4,
      prefix: "",
      suffix: "",
    });
  });

  it("refuses empty and over-long selections", () => {
    expect(createMobileAssistantCitation({ ...ids, markdown, selectedText: " \n " })).toBeNull();
    const long = "word ".repeat(ASSISTANT_CITATION_MAX_TEXT_LENGTH / 4);
    expect(createMobileAssistantCitation({ ...ids, markdown: long, selectedText: long })).toBe(
      "too-long",
    );
  });
});

describe("insertAssistantCitation", () => {
  const citation = {
    ...ids,
    version: 1 as const,
    text: "quote",
    start: 0,
    end: 5,
    prefix: "",
    suffix: "",
  };

  it("separates the chip from the text around it and leaves the caret after it", () => {
    const inserted = insertAssistantCitation(
      "Explain this please",
      { start: 12, end: 12 },
      citation,
    );
    const [chip] = collectAssistantCitations(inserted!.text);
    expect(chip).toMatchObject({ start: inserted!.citation.start, end: inserted!.citation.end });
    expect(inserted!.text).toBe(`Explain this ${inserted!.citation.source} please`);
    expect(inserted!.caret).toBe(inserted!.citation.end + 1);
  });

  it("does not add a leading space at the start or after whitespace", () => {
    expect(insertAssistantCitation("", { start: 0, end: 0 }, citation)?.citation.start).toBe(0);
    expect(insertAssistantCitation("Why ", { start: 4, end: 4 }, citation)?.text).toMatch(
      /^Why \[Assistant quote\]\([^)]+\) $/,
    );
  });

  it("refuses a quote that would push the draft past the input limit", () => {
    const draft = "x".repeat(PROVIDER_SEND_TURN_MAX_INPUT_CHARS - 10);
    expect(
      insertAssistantCitation(draft, { start: draft.length, end: draft.length }, citation),
    ).toBeNull();
  });
});
