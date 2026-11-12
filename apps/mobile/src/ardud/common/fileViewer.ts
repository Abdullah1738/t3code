/**
 * Which files the attachment screen hands to the system's viewer (Quick Look,
 * or a viewer app on Android), and how long it waits for that viewer.
 *
 * The app plays video and audio itself, so those never leave it: a clip that
 * the system's viewer can't open would otherwise leave the screen waiting.
 * For what is handed over, the app can't see whether the viewer came up, only
 * that it has not come back, so the wait has a time limit. After it the screen
 * says so and offers to try again; a viewer that does come up later still
 * shows over that.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import type { FilePreviewKind } from "@t3tools/shared/filePreview";

import { mediaVideoThumbnailKey } from "../../lib/videoPreviewSource";

/** The viewer a kind of file is handed to, or null when the app shows it itself. */
export function systemViewerKind(kind: FilePreviewKind): "image" | "pdf" | "document" | null {
  if (kind === "image") return "image";
  if (kind === "pdf") return "pdf";
  // No preview of its own: the system may still know the format.
  if (kind === "unsupported") return "document";
  return null;
}

/**
 * What the screen does when the wait for the viewer ends.
 *
 * - `none`: there is nothing to wait for. On Android a picture or a PDF opens
 *   in the app's own sheet, which is up at once and must not be closed under him.
 * - `say`: say it has not opened and offer to try again, and leave the viewer
 *   alone. On iOS the app can't tell a viewer that is up from one that never
 *   came, and one he is reading must not be dismissed.
 * - `closeAndSay`: Android's "Opening document" sheet covers the screen while
 *   the file is fetched: it is taken down so the error can be read.
 */
export function fileViewerStall(
  os: string,
  viewer: "image" | "pdf" | "document" | null,
): "none" | "say" | "closeAndSay" {
  if (viewer === null) return "none";
  if (os === "android") return viewer === "document" ? "closeAndSay" : "none";
  return "say";
}

const BASE_MS = 20_000;
const PER_MEGABYTE_MS = 4_000;
const MAX_MS = 120_000;

/**
 * How long the address of a file on the server is waited for. It is one small
 * request, whatever the file's size.
 */
export const FILE_ADDRESS_TIME_LIMIT_MS = BASE_MS;

/** What the screen says when a file's address or contents did not come in time. */
export const FILE_LOAD_STALLED_TEXT =
  "Loading is taking too long. Try again, or check the connection to Robob.";

/** The same for a file that is on the phone. */
export const LOCAL_FILE_LOAD_STALLED_TEXT = "Loading is taking too long. Try again.";

/** Whether an attachment's error is a wait that ran out, not a file that can't be had. */
export const fileLoadStalled = (error: string | null): boolean =>
  error === FILE_LOAD_STALLED_TEXT || error === LOCAL_FILE_LOAD_STALLED_TEXT;

/**
 * How long to wait for the system's viewer before saying it did not open. The
 * file is fetched first, so a large one is given longer: 20 seconds, plus 4
 * for every megabyte, two minutes at most.
 */
export function fileViewerTimeLimitMs(sizeBytes: number): number {
  const megabytes = Number.isFinite(sizeBytes) && sizeBytes > 0 ? sizeBytes / (1024 * 1024) : 0;
  return Math.min(MAX_MS, Math.round(BASE_MS + megabytes * PER_MEGABYTE_MS));
}

/**
 * What a video attachment's player and its still frame are kept under. The
 * frame cache is one for the whole app, and attachment ids are not unique
 * across servers: two servers restored from the same data hold the same ids.
 * So the key names the server, and is the one the thread's own tile uses for
 * that attachment (the frame is the same file's). A file still on the phone,
 * in a draft, has no server: its key names the draft.
 */
export function attachmentVideoKey(input: {
  readonly attachmentId: string;
  readonly name: string;
  readonly mimeType: string;
  /** The server that holds it; null when there is none. */
  readonly environmentId: EnvironmentId | null;
  /** The draft that holds the file when it is still on the phone. */
  readonly localDraftKey: string | null;
}): string {
  if (input.localDraftKey !== null) {
    return JSON.stringify(["attachment-video", "local", input.localDraftKey, input.attachmentId]);
  }
  if (input.environmentId === null) {
    return JSON.stringify(["attachment-video", "nowhere", input.attachmentId]);
  }
  return mediaVideoThumbnailKey({
    type: "media",
    name: input.name,
    mimeType: input.mimeType,
    environmentId: input.environmentId,
    resource: {
      _tag: "attachment",
      attachmentId: input.attachmentId,
      fileName: input.name,
      mimeType: input.mimeType,
    },
  });
}
