// @effect-diagnostics nodeBuiltinImport:off - image bytes are copied once, at attach time.
/**
 * Mission images. The bytes are copied when attached, into the attachments
 * folder under a `mission-<uuid>` id, so the existing `attachment` asset URL
 * serves them with no new route. The record lives in the view store; the
 * copy outlives the thread it came from and goes when the mission is archived.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  MissionError,
  VIEW_ASSET_LIMITS,
  type MissionAsset,
  type MissionAssetSource,
  type MissionProvenance,
} from "@t3tools/contracts";
import { readImageDimensions } from "@t3tools/shared/imageDimensions";
import * as Effect from "effect/Effect";

import { openMediaFile } from "../../../assets/MediaFile.ts";
import {
  parseThreadSegmentFromAttachmentId,
  resolveAttachmentPathById,
  toSafeThreadAttachmentSegment,
} from "../../../attachmentStore.ts";

type ImageMime = MissionAsset["mimeType"];

const EXTENSION: Record<ImageMime, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

const has = (bytes: Uint8Array, signature: ReadonlyArray<number>, offset = 0) =>
  signature.every((byte, index) => bytes[offset + index] === byte);

/** The image type from its first bytes; the name and claimed type don't count. */
export const sniffImage = (bytes: Uint8Array): ImageMime | null => {
  if (has(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (has(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (has(bytes, [0x47, 0x49, 0x46, 0x38]) && (bytes[4] === 0x37 || bytes[4] === 0x39)) {
    return bytes[5] === 0x61 ? "image/gif" : null;
  }
  if (has(bytes, [0x52, 0x49, 0x46, 0x46]) && has(bytes, [0x57, 0x45, 0x42, 0x50], 8)) {
    return "image/webp";
  }
  return null;
};

export interface AssetBytes {
  readonly bytes: Uint8Array;
  readonly mimeType: ImageMime;
  readonly name: string;
  readonly width: number | null;
  readonly height: number | null;
  readonly sha256: string;
}

const refuse = (code: MissionError["code"], detail: string) =>
  Effect.fail(new MissionError({ code, detail }));

const tooBig = (size: number) =>
  size > VIEW_ASSET_LIMITS.imageBytes
    ? refuse("invalid", `images are capped at ${VIEW_ASSET_LIMITS.imageBytes} bytes`)
    : Effect.void;

const unreadable = (detail: string) => () => new MissionError({ code: "invalid", detail });

/** An attachment of the caller's own thread; the owner may name any attachment. */
const readAttachment = (
  attachmentsDir: string,
  attachmentId: string,
  provenance: MissionProvenance,
) =>
  Effect.gen(function* () {
    if (provenance._tag === "agent") {
      const own = toSafeThreadAttachmentSegment(provenance.threadId);
      if (own === null || parseThreadSegmentFromAttachmentId(attachmentId) !== own) {
        return yield* refuse("forbidden", "Agents can only attach images from their own thread.");
      }
    } else if (provenance._tag !== "owner-app" && provenance._tag !== "owner-imessage") {
      return yield* refuse("forbidden", "Only the owner and agents can attach images.");
    }
    const path = resolveAttachmentPathById({ attachmentsDir, attachmentId });
    if (path === null) return yield* refuse("not-found", `No attachment ${attachmentId}.`);
    const stat = yield* Effect.tryPromise({
      try: () => NodeFSP.stat(path),
      catch: unreadable(`Attachment ${attachmentId} can't be read.`),
    });
    yield* tooBig(stat.size);
    return yield* Effect.tryPromise({
      try: () => NodeFSP.readFile(path),
      catch: unreadable(`Attachment ${attachmentId} can't be read.`),
    });
  });

/** A file on the server, by its canonical absolute path; links aren't followed. */
const readFile = (path: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      if (!NodePath.isAbsolute(path)) {
        return yield* refuse("invalid", "file paths must be absolute");
      }
      const opened = yield* openMediaFile(path).pipe(
        Effect.mapError(unreadable(`${path} can't be read.`)),
      );
      if (opened === null) {
        return yield* refuse("invalid", `${path} is not a regular file at its real path`);
      }
      yield* tooBig(Number(opened.info.size));
      return yield* Effect.tryPromise({
        try: () => opened.handle.readFile(),
        catch: unreadable(`${path} can't be read.`),
      });
    }),
  );

/** Reads and checks an image from its source. Nothing is written. */
export const readAssetSource = (input: {
  readonly attachmentsDir: string;
  readonly source: MissionAssetSource;
  readonly provenance: MissionProvenance;
  readonly name: string | undefined;
}) =>
  Effect.gen(function* () {
    const source = input.source;
    const bytes: Uint8Array =
      source._tag === "attachment"
        ? yield* readAttachment(input.attachmentsDir, source.attachmentId, input.provenance)
        : yield* readFile(source.path);
    yield* tooBig(bytes.byteLength);
    const mimeType = sniffImage(bytes);
    if (mimeType === null) {
      return yield* refuse("invalid", "only PNG, JPEG, WebP and GIF images can be attached");
    }
    const dimensions = readImageDimensions(bytes);
    const fallback = source._tag === "file" ? NodePath.basename(source.path) : "Image";
    const result: AssetBytes = {
      bytes,
      mimeType,
      name: (input.name ?? fallback).slice(0, 120),
      width: dimensions && dimensions.width > 0 ? dimensions.width : null,
      height: dimensions && dimensions.height > 0 ? dimensions.height : null,
      sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
    };
    return result;
  });

export const assetFilePath = (
  attachmentsDir: string,
  asset: Pick<MissionAsset, "id" | "mimeType">,
) => NodePath.join(attachmentsDir, `${asset.id}${EXTENSION[asset.mimeType]}`);

/** Writes the copy; fails rather than replacing a file already there. */
export const writeAssetFile = (path: string, bytes: Uint8Array) =>
  Effect.tryPromise({
    try: async () => {
      await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
      await NodeFSP.writeFile(path, bytes, { flag: "wx" });
    },
    catch: unreadable("The image couldn't be stored."),
  });

/** Best effort: a file left behind is harmless, a failed delete must not undo a commit. */
export const deleteAssetFile = (path: string) =>
  Effect.promise(() => NodeFSP.rm(path, { force: true }).catch(() => undefined));
