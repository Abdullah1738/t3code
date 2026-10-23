/**
 * Images inside owner request messages.
 *
 * A composer sends `{image1}`, `{image2}`... where each chip sits and the images
 * in the same order. The server stores each image as a mission asset and writes
 * `[image 1: /abs/path/mission-<uuid>.png]` in its place, so every agent read
 * (inbox, request view, wake text) carries the path where the owner put it.
 * Clients split that text back into text and image parts.
 *
 * Typed text that looks like a ref is escaped first (`[image 1\: ...]`), so only
 * refs the server wrote turn into images. Reading unescapes it again.
 */

const MARKER = /\{image(\d{1,2})\}/g;
const REF = /\[image (\d{1,2}): ([^\]\n]+)\]/g;
const TYPED_REF = /\[image (\d{1,2})(\\*):/g;
const ESCAPED_REF = /\[image (\d{1,2})\\(\\*):/g;
const ASSET_ID = /^mission-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const requestImageMarker = (index: number): string => `{image${index}}`;

export const requestImageRef = (index: number, path: string): string => `[image ${index}: ${path}]`;

/** Typed words with every ref look-alike escaped, so none reads as an image. */
export const escapeRequestImageRefs = (text: string): string =>
  text.replace(TYPED_REF, "[image $1\\$2:");

const unescapeRequestImageRefs = (text: string): string =>
  text.replace(ESCAPED_REF, "[image $1$2:");

/**
 * Puts each ref wherever its `{imageN}` marker is (1-based, in `refs` order). A
 * ref without a marker goes at the end; a marker without a ref stays as typed.
 * The typed text is escaped first, so call it once per message, refs or not.
 */
export const placeRequestImages = (text: string, refs: ReadonlyArray<string>): string => {
  const placed = new Set<number>();
  const body = escapeRequestImageRefs(text).replace(MARKER, (marker, digits: string) => {
    const index = Number(digits);
    const ref = refs[index - 1];
    if (ref === undefined) return marker;
    placed.add(index);
    return ref;
  });
  const rest = refs.filter((_, at) => !placed.has(at + 1));
  if (rest.length === 0) return body;
  const head = body.trimEnd();
  return head.length === 0 ? rest.join("\n") : `${head}\n\n${rest.join("\n")}`;
};

export type RequestTextPart =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "image";
      readonly index: number;
      readonly assetId: string;
      readonly path: string;
    };

const assetIdOf = (path: string): string | null => {
  const name = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
  const dot = name.lastIndexOf(".");
  const id = dot > 0 ? name.slice(0, dot) : name;
  return ASSET_ID.test(id) ? id : null;
};

/** Splits a stored message into text and the image refs inside it. */
export const requestTextParts = (text: string): ReadonlyArray<RequestTextPart> => {
  const parts: Array<RequestTextPart> = [];
  let from = 0;
  for (const match of text.matchAll(REF)) {
    const path = match[2]!.trim();
    const assetId = assetIdOf(path);
    if (assetId === null) continue;
    if (match.index > from) {
      parts.push({ type: "text", text: unescapeRequestImageRefs(text.slice(from, match.index)) });
    }
    parts.push({ type: "image", index: Number(match[1]), assetId, path });
    from = match.index + match[0].length;
  }
  if (from < text.length) {
    parts.push({ type: "text", text: unescapeRequestImageRefs(text.slice(from)) });
  }
  return parts;
};

/** The text with each image ref shortened to `[image N]`, for titles and previews. */
export const requestPlainText = (text: string): string =>
  requestTextParts(text)
    .map((part) => (part.type === "text" ? part.text : `[image ${part.index}]`))
    .join("");
