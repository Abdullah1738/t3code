import { describe, expect, it } from "vite-plus/test";
import { PROVIDER_SEND_TURN_MAX_ATTACHMENTS } from "@t3tools/contracts";

import { composerBlocks, composerLimitError, composerTitleSource } from "./composerAttachments";

const image = {
  type: "image" as const,
  id: "att-1",
  name: "a.png",
  mimeType: "image/png",
  sizeBytes: 10,
};
const file = {
  type: "file" as const,
  id: "att-2",
  name: "doc.pdf",
  mimeType: "application/pdf",
  sizeBytes: 20,
};

describe("composerBlocks", () => {
  it("sends text only as one md block", () => {
    expect(composerBlocks("hello", [])).toEqual([{ _tag: "md", text: "hello" }]);
  });

  it("sends files only as attachment blocks", () => {
    expect(composerBlocks("", [image, file])).toEqual([
      { _tag: "attachment", attachment: image },
      { _tag: "attachment", attachment: file },
    ]);
  });

  it("puts text first, then the files", () => {
    expect(composerBlocks("see these", [image])).toEqual([
      { _tag: "md", text: "see these" },
      { _tag: "attachment", attachment: image },
    ]);
  });

  it("produces nothing when there is no text and no file", () => {
    expect(composerBlocks("", [])).toEqual([]);
  });
});

describe("composerTitleSource", () => {
  it("uses the first non-empty line of the text", () => {
    expect(composerTitleSource("\n  Pricing question \nmore", ["x.pdf"])).toBe("Pricing question");
  });

  it("falls back to the first file name when there is no text", () => {
    expect(composerTitleSource("   ", ["report.pdf", "b.png"])).toBe("report.pdf");
  });

  it("falls back to Request when there is neither text nor a file", () => {
    expect(composerTitleSource("", [])).toBe("Request");
  });
});

describe("composerLimitError", () => {
  it("accepts the limit itself", () => {
    expect(composerLimitError(PROVIDER_SEND_TURN_MAX_ATTACHMENTS)).toBeNull();
  });

  it("reports the error once the count is over the limit", () => {
    expect(composerLimitError(PROVIDER_SEND_TURN_MAX_ATTACHMENTS + 1)).toBe(
      `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} files per message.`,
    );
  });
});
