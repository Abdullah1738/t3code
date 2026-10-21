import { useCallback, useMemo, type ReactNode } from "react";
import * as Schema from "effect/Schema";

import type { AnswerAskInput, MissionId, ViewBackedRecord } from "@t3tools/contracts";
import {
  markAsset,
  viewCard,
  withAssetFeedback,
  type AssetMark,
  type AssetReview,
  type ViewBlock,
  type ViewGalleryAsset,
} from "@t3tools/client-runtime/ardud/missions";

import { useLocalStorage } from "../../../hooks/useLocalStorage";
import { useMissionViews } from "../missionsStore";
import { ViewBlocks, type ViewChoiceState } from "./ViewBlocks";

// A card whose record picked a template other than the built-in one (a
// stock release or UI review template, or one the master made) draws that
// template's body. Per-image review marks stay in this browser until the
// answer goes, so a reload keeps them.

const AssetMarkSchema = Schema.Struct({
  verdict: Schema.NullOr(Schema.Literals(["ok", "change"])),
  note: Schema.String,
  pin: Schema.NullOr(Schema.Struct({ x: Schema.Number, y: Schema.Number })),
});
const AssetReviewSchema = Schema.NullOr(Schema.Record(Schema.String, AssetMarkSchema));
const NO_MARKS: AssetReview = {};

export interface TemplatedCard {
  readonly kicker: string | null;
  readonly body: ReactNode;
  /** Adds the image marks to an answer. */
  readonly attach: (input: AnswerAskInput) => AnswerAskInput;
  /** Forgets the marks once the answer went. */
  readonly clear: () => void;
}

const galleryAssets = (blocks: ReadonlyArray<ViewBlock>): ReadonlyArray<ViewGalleryAsset> =>
  blocks.flatMap((block) =>
    block.kind === "gallery"
      ? block.assets
      : block.kind === "group"
        ? galleryAssets(block.children)
        : block.kind === "collapsible"
          ? block.items.flatMap((item) => galleryAssets(item.children))
          : [],
  );

export function useTemplatedCard(
  missionId: MissionId,
  backed: ViewBackedRecord,
  options: { nowMs: number; masterRoleId: string | null; choice?: ViewChoiceState },
): TemplatedCard | null {
  const snapshot = useMissionViews(missionId)?.snapshot;
  const [stored, setMarks] = useLocalStorage<AssetReview | null, unknown>(
    `t3code:missions:review:${backed.kind}:${backed.record.id}`,
    null,
    AssetReviewSchema,
  );
  const marks = stored ?? NO_MARKS;
  const view = useMemo(
    () =>
      viewCard(backed, snapshot?.templates ?? [], {
        nowMs: options.nowMs,
        masterRoleId: options.masterRoleId,
        assets: snapshot?.assets ?? [],
      }),
    [backed, snapshot, options.nowMs, options.masterRoleId],
  );
  const onMark = useCallback(
    (assetId: string, change: Partial<AssetMark>) =>
      setMarks((current) => markAsset(current ?? NO_MARKS, assetId, change)),
    [setMarks],
  );
  if (view.source === "builtin") return null;
  const assets = galleryAssets(view.blocks);
  return {
    kicker: view.kicker, // taste-skill-ignore: the card frame's kicker, not a page eyebrow
    body: (
      <ViewBlocks
        blocks={view.blocks}
        choice={options.choice}
        review={{ marks, onMark, disabled: options.choice?.disabled ?? false }}
      />
    ),
    attach: (input) => withAssetFeedback(input, marks, assets),
    clear: () => setMarks(null),
  };
}
