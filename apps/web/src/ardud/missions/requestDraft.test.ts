import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentId } from "@t3tools/contracts";
import { requestTextWithImages } from "@t3tools/client-runtime/ardud/missions";

import type { ComposerImageAttachment } from "../../composerDraftStore";
import type { AttachmentUploadState } from "../../lib/attachmentUploadState";
import { imageContextReference } from "../../lib/composerContextRecords";
import { formatInlineContextReference } from "../../lib/composerContextReferences";
import { REQUEST_IMAGE_LIMIT, requestDraftImages } from "./requestDraft";

const environmentId = "env-1" as EnvironmentId;

function image(id: string): ComposerImageAttachment {
  return {
    type: "image",
    id,
    name: `${id}.png`,
    mimeType: "image/png",
    sizeBytes: 10,
    previewUrl: `blob:${id}`,
    file: new File(["x"], `${id}.png`, { type: "image/png" }),
  } as ComposerImageAttachment;
}

const chip = (attachment: ComposerImageAttachment) =>
  formatInlineContextReference(imageContextReference(attachment));

const ready = (attachmentId: string): AttachmentUploadState => ({
  status: "ready",
  environmentId,
  attachmentId,
});

describe("requestDraftImages", () => {
  it("sends only the images still chipped, in the order the chips sit", () => {
    const [a, b, gone] = [image("a"), image("b"), image("gone")];
    const text = `Left ${chip(b)} vs right ${chip(a)}`;
    const result = requestDraftImages(text, [a, b, gone], {
      a: ready("upload-a"),
      b: ready("upload-b"),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(requestTextWithImages(text, result.images)).toEqual({
      text: "Left {image1} vs right {image2}",
      images: [
        { _tag: "attachment", attachmentId: "upload-b" },
        { _tag: "attachment", attachmentId: "upload-a" },
      ],
    });
  });

  it("holds the message while a chip is uploading or failed", () => {
    const a = image("a");
    const text = `See ${chip(a)}`;
    expect(requestDraftImages(text, [a], {})).toEqual({
      ok: false,
      reason: "Images are still uploading.",
    });
    expect(
      requestDraftImages(text, [a], {
        a: { status: "failed", environmentId, reason: "offline" },
      }),
    ).toEqual({ ok: false, reason: "a.png didn't upload. Remove it and attach it again." });
  });

  it("refuses more images than one message takes", () => {
    const images = Array.from({ length: REQUEST_IMAGE_LIMIT + 1 }, (_, at) => image(`i${at}`));
    const text = images.map(chip).join(" ");
    const uploads = Object.fromEntries(images.map((item) => [item.id, ready(`up-${item.id}`)]));
    expect(requestDraftImages(text, images, uploads)).toEqual({
      ok: false,
      reason: `A message takes up to ${REQUEST_IMAGE_LIMIT} images.`,
    });
  });
});
