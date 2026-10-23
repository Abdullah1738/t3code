import { requestPlainText, requestTextParts, type RequestTextPart } from "@t3tools/contracts";

export type RequestImagePart = Extract<RequestTextPart, { type: "image" }>;

/**
 * What a request message shows: plain words when it has no image the server
 * wrote, else its parts with the images to draw as chips. Stored words keep
 * typed ref look-alikes escaped, so even the plain path reads through the parts.
 */
export type RequestTextView =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "images";
      readonly parts: ReadonlyArray<RequestTextPart>;
      readonly images: ReadonlyArray<RequestImagePart>;
    };

export const requestTextView = (text: string): RequestTextView => {
  const parts = requestTextParts(text);
  const images = parts.filter((part): part is RequestImagePart => part.type === "image");
  return images.length === 0
    ? { type: "text", text: requestPlainText(text) }
    : { type: "images", parts, images };
};
