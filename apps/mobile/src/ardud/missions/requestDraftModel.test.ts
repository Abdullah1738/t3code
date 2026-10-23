import { requestTextWithImages } from "@t3tools/client-runtime/ardud/missions";
import { describe, expect, it } from "vite-plus/test";

import {
  chippedImages,
  draftWords,
  imageOfChip,
  insertImageChips,
  requestDraftContext,
} from "./requestDraftModel";

const header = {
  id: "0b6c1e2a-1d7a-4b55-9a51-5c1f4f6a0001",
  name: "header.png",
  mimeType: "image/png",
  sizeBytes: 2048,
};
const footer = {
  id: "0b6c1e2a-1d7a-4b55-9a51-5c1f4f6a0002",
  name: "footer.jpg",
  mimeType: "image/jpeg",
  sizeBytes: 4096,
};

describe("request draft chips", () => {
  it("puts chips at the cursor and sends them as numbered markers in that order", () => {
    const typed = "The  should match.";
    const first = insertImageChips(typed, { start: 4, end: 4 }, [footer]);
    const second = insertImageChips(first.text, { start: 0, end: 0 }, [header]);

    expect(second.text.startsWith("![header.png](")).toBe(true);
    expect(chippedImages(second.text, [header, footer])).toEqual([header, footer]);

    const sent = requestTextWithImages(second.text, [
      { contextId: header.id, attachmentId: "upload-header" },
      { contextId: footer.id, attachmentId: "upload-footer" },
    ]);
    expect(sent.text).toBe("{image1} The {image2} should match.");
    expect(sent.images).toEqual([
      { _tag: "attachment", attachmentId: "upload-header" },
      { _tag: "attachment", attachmentId: "upload-footer" },
    ]);
  });

  it("forgets an image once its chip is deleted from the text", () => {
    const { text } = insertImageChips("Look", { start: 4, end: 4 }, [header, footer]);
    const withoutHeader = text.replace(/!\[header\.png\]\([^)]*\) ?/, "");

    expect(chippedImages(withoutHeader, [header, footer])).toEqual([footer]);
    expect(requestDraftContext(withoutHeader, [header, footer])?.records).toEqual([
      expect.objectContaining({ kind: "image", contextId: footer.id, name: "footer.jpg" }),
    ]);
    expect(requestDraftContext("Look", [header, footer])).toBeUndefined();
  });

  it("finds the tapped chip's image and keeps the words alone for a note", () => {
    const { text } = insertImageChips("Fix", { start: 3, end: 3 }, [header]);
    const chip = text.slice(text.indexOf("!["));

    expect(imageOfChip(chip.trim(), [header, footer])).toBe(header);
    expect(draftWords(`${text}please`)).toBe("Fix please");
  });
});
