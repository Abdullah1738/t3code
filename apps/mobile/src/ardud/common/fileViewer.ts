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
import type { FilePreviewKind } from "@t3tools/shared/filePreview";

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
 * How long to wait for the system's viewer before saying it did not open. The
 * file is fetched first, so a large one is given longer: 20 seconds, plus 4
 * for every megabyte, two minutes at most.
 */
export function fileViewerTimeLimitMs(sizeBytes: number): number {
  const megabytes = Number.isFinite(sizeBytes) && sizeBytes > 0 ? sizeBytes / (1024 * 1024) : 0;
  return Math.min(MAX_MS, Math.round(BASE_MS + megabytes * PER_MEGABYTE_MS));
}
