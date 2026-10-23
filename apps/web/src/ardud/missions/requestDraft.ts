import type { RequestDraftImage } from "@t3tools/client-runtime/ardud/missions";

import type { ComposerImageAttachment } from "../../composerDraftStore";
import type { AttachmentUploadState } from "../../lib/attachmentUploadState";
import { imageContextReference } from "../../lib/composerContextRecords";
import { collectInlineContextIds } from "../../lib/composerContextReferences";

/** The contract's cap on images in one request message. */
export const REQUEST_IMAGE_LIMIT = 12;

/**
 * Images whose chip is still in the text. Deleting a chip drops its image, and
 * undo brings it back, so images stay in the draft until it sends or closes.
 */
export function chippedImages(
  text: string,
  images: ReadonlyArray<ComposerImageAttachment>,
): ReadonlyArray<ComposerImageAttachment> {
  const ids = new Set(collectInlineContextIds(text));
  return images.filter((image) => ids.has(imageContextReference(image).contextId));
}

export type RequestDraftImages =
  | { readonly ok: true; readonly images: ReadonlyArray<RequestDraftImage> }
  | { readonly ok: false; readonly reason: string };

/** Each chipped image's uploaded id, or why the draft can't go yet. */
export function requestDraftImages(
  text: string,
  images: ReadonlyArray<ComposerImageAttachment>,
  uploads: Readonly<Record<string, AttachmentUploadState>>,
): RequestDraftImages {
  const chipped = chippedImages(text, images);
  if (chipped.length > REQUEST_IMAGE_LIMIT) {
    return { ok: false, reason: `A message takes up to ${REQUEST_IMAGE_LIMIT} images.` };
  }
  const ready: RequestDraftImage[] = [];
  for (const image of chipped) {
    const upload = uploads[image.id];
    if (upload?.status === "failed") {
      return { ok: false, reason: `${image.name} didn't upload. Remove it and attach it again.` };
    }
    if (upload?.status !== "ready") return { ok: false, reason: "Images are still uploading." };
    ready.push({
      contextId: imageContextReference(image).contextId,
      attachmentId: upload.attachmentId,
    });
  }
  return { ok: true, images: ready };
}
