import {
  ComposerContextId,
  type ImageContextRecord,
  type OrchestrationMessageContext,
} from "@t3tools/contracts";
import {
  collectComposerContextReferences,
  formatComposerContextReference,
  replaceComposerContextReferences,
  sanitizeComposerContextLabel,
} from "@t3tools/shared/composerContextReferences";

/** The most images one request message carries, as the server allows. */
export const REQUEST_IMAGE_LIMIT = 12;

/** What a request draft needs to know about an image to show and send its chip. */
export interface RequestDraftImageFile {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
}

export interface DraftSelection {
  readonly start: number;
  readonly end: number;
}

/** The images whose chip is still in the text, in the order they were attached. */
export function chippedImages<T extends RequestDraftImageFile>(
  text: string,
  images: ReadonlyArray<T>,
): ReadonlyArray<T> {
  const ids = new Set<string>(collectComposerContextReferences(text).map((ref) => ref.contextId));
  return images.filter((image) => ids.has(image.id));
}

function chipOf(image: RequestDraftImageFile): string {
  return formatComposerContextReference({
    kind: "image",
    contextId: ComposerContextId.make(image.id),
    label: sanitizeComposerContextLabel(image.name, "image"),
  });
}

/** Puts one chip per image where the cursor is, spaced off the words around it. */
export function insertImageChips(
  text: string,
  selection: DraftSelection,
  images: ReadonlyArray<RequestDraftImageFile>,
): { readonly text: string; readonly selection: DraftSelection } {
  const start = Math.max(0, Math.min(text.length, selection.start));
  const end = Math.max(start, Math.min(text.length, selection.end));
  const before = text.slice(0, start);
  const after = text.slice(end);
  const chips = images.map(chipOf).join(" ");
  const lead = before.length > 0 && !/\s$/.test(before) ? " " : "";
  const trail = after.length === 0 || !/^\s/.test(after) ? " " : "";
  const inserted = `${lead}${chips}${trail}`;
  const cursor = start + inserted.length;
  return { text: before + inserted + after, selection: { start: cursor, end: cursor } };
}

/** The chip records the native editor draws, one per image still in the text. */
export function requestDraftContext(
  text: string,
  images: ReadonlyArray<RequestDraftImageFile>,
): OrchestrationMessageContext | undefined {
  const records = chippedImages(text, images).map((image): ImageContextRecord => ({
    version: 1,
    contextId: ComposerContextId.make(image.id),
    label: sanitizeComposerContextLabel(image.name, "image"),
    kind: "image",
    attachmentId: image.id,
    name: image.name,
    mimeType: image.mimeType,
    sizeBytes: image.sizeBytes,
  }));
  return records.length === 0 ? undefined : { version: 1, records };
}

/** The image behind a tapped chip, from the chip's own markdown. */
export function imageOfChip<T extends RequestDraftImageFile>(
  source: string,
  images: ReadonlyArray<T>,
): T | undefined {
  const contextId = collectComposerContextReferences(source)[0]?.contextId;
  return contextId === undefined ? undefined : images.find((image) => image.id === contextId);
}

/** The words of a draft without its chips, for notes that can't carry images. */
export function draftWords(text: string): string {
  return replaceComposerContextReferences(text, () => "")
    .replace(/[ \t]+/g, " ")
    .trim();
}
