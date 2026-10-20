import type { AnswerAskInput, AssetFeedback, MissionAssetId } from "@t3tools/contracts";

import type { ViewGalleryAsset } from "./cards.ts";

// Per-image review on an ask: the owner marks images ok or to change, with a
// note and a pin, and it all goes with the answer on Submit (one wake for the
// asker). Marks live on the client until then.

export interface AssetMark {
  readonly verdict: "ok" | "change" | null;
  readonly note: string;
  /** Where on the image the note points, 0..1 from the top left. */
  readonly pin: { readonly x: number; readonly y: number } | null;
}

/** Marks by asset id. */
export type AssetReview = Readonly<Record<string, AssetMark>>;

export const EMPTY_ASSET_MARK: AssetMark = { verdict: null, note: "", pin: null };

const NOTE_MAX = 2000;

export function assetMarkOf(review: AssetReview, assetId: string): AssetMark {
  return Object.hasOwn(review, assetId) ? (review[assetId] ?? EMPTY_ASSET_MARK) : EMPTY_ASSET_MARK;
}

const isEmpty = (mark: AssetMark) =>
  mark.verdict === null && mark.note.trim() === "" && mark.pin === null;

/** The review with one image's mark changed; an emptied mark is dropped. */
export function markAsset(
  review: AssetReview,
  assetId: string,
  change: Partial<AssetMark>,
): AssetReview {
  const next = { ...assetMarkOf(review, assetId), ...change };
  const clamp = (value: number) => Math.min(Math.max(value, 0), 1);
  const mark: AssetMark = {
    verdict: next.verdict,
    note: next.note.slice(0, NOTE_MAX),
    pin: next.pin === null ? null : { x: clamp(next.pin.x), y: clamp(next.pin.y) },
  };
  const { [assetId]: _dropped, ...rest } = review;
  return isEmpty(mark) ? rest : { ...rest, [assetId]: mark };
}

/** Feedback for the images still shown, in gallery order. */
export function assetFeedback(
  review: AssetReview,
  assets: ReadonlyArray<Pick<ViewGalleryAsset, "id">>,
): AssetFeedback[] {
  return assets.flatMap((asset) => {
    const mark = assetMarkOf(review, asset.id);
    if (isEmpty(mark)) return [];
    return [
      {
        assetId: asset.id as MissionAssetId,
        verdict: mark.verdict,
        note: mark.note.trim(),
        pin: mark.pin,
      },
    ];
  });
}

const percent = (value: number) => `${Math.round(value * 100)}%`;

/** The feedback as lines a person reads in the room: "home.png: change. Smaller logo (at 40%, 12%)". */
export function assetFeedbackText(
  feedback: ReadonlyArray<AssetFeedback>,
  assets: ReadonlyArray<Pick<ViewGalleryAsset, "id" | "name">>,
): string {
  const names = new Map(assets.map((asset) => [asset.id, asset.name]));
  return feedback
    .map((item) => {
      const verdict =
        item.verdict === "ok" ? "looks right" : item.verdict === "change" ? "change" : "note";
      const note = item.note === "" ? "" : `. ${item.note}`;
      const pin = item.pin === null ? "" : ` (at ${percent(item.pin.x)}, ${percent(item.pin.y)})`;
      return `${names.get(item.assetId) ?? item.assetId}: ${verdict}${note}${pin}`;
    })
    .join("\n");
}

/** The answer with the image marks added, as feedback and as readable lines after the text. */
export function withAssetFeedback(
  input: AnswerAskInput,
  review: AssetReview,
  assets: ReadonlyArray<Pick<ViewGalleryAsset, "id" | "name">>,
): AnswerAskInput {
  const feedback = assetFeedback(review, assets);
  if (feedback.length === 0) return input;
  const lines = assetFeedbackText(feedback, assets);
  const text = input.text.trim() === "" ? lines : `${input.text.trim()}\n\n${lines}`;
  return { ...input, text, feedback };
}
