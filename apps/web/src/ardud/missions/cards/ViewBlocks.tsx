import { useMemo, useState, type MouseEvent } from "react";
import { XIcon } from "lucide-react";

import type { AssetResource, DraftChannel } from "@t3tools/contracts";
import {
  assetMarkOf,
  DRAFT_CHANNEL_LABEL,
  type AssetMark,
  type AssetReview,
  type ViewBlock,
  type ViewGalleryAsset,
  type ViewTableCell,
} from "@t3tools/client-runtime/ardud/missions";

import { useAssetUrlState } from "../../../assets/assetUrls";
import { Button } from "../../../components/ui/button";
import { Dialog, DialogPopup, DialogTitle } from "../../../components/ui/dialog";
import { Textarea } from "../../../components/ui/textarea";
import { cn } from "../../../lib/utils";
import { usePrimaryEnvironmentId } from "../../../state/environments";
import {
  ChoiceBlock,
  DraftBlock,
  FactsBlock,
  FlagsBlock,
  GroupBlock,
  LabelBlock,
  LinksBlock,
  RefsBlock,
  TextBlock,
  type MaxLines,
} from "./blocks";
import { DESK_ROW } from "../deskParts";
import { LinkChip } from "./chips";

// Draws the blocks a card template or a section resolves to. The view model
// (client-runtime views/) did the binding; this only maps blocks onto the
// shared card primitives, plus the list, table, meter and gallery blocks.

/** The card's answer choice, when the template has a choice node. */
export interface ViewChoiceState {
  readonly picked: string | null;
  readonly onPick: (optionId: string | null) => void;
  readonly disabled: boolean;
}

/** Per-image marks on an open review; absent where the gallery only shows. */
export interface ViewReviewState {
  readonly marks: AssetReview;
  readonly onMark: (assetId: string, change: Partial<AssetMark>) => void;
  readonly disabled: boolean;
}

export function ViewBlocks(props: {
  blocks: ReadonlyArray<ViewBlock>;
  choice?: ViewChoiceState | undefined;
  review?: ViewReviewState | undefined;
}) {
  return (
    <>
      {props.blocks.map((block, index) => (
        <ViewBlockView
          // Blocks have no ids; their order is the template's.
          // eslint-disable-next-line react/no-array-index-key
          key={index}
          block={block}
          choice={props.choice}
          review={props.review}
        />
      ))}
    </>
  );
}

const lines = (count: number): MaxLines => Math.min(Math.max(Math.round(count), 1), 6) as MaxLines;

const isChannel = (channel: string | null): channel is DraftChannel =>
  channel !== null && Object.hasOwn(DRAFT_CHANNEL_LABEL, channel);

function ViewBlockView(props: {
  block: ViewBlock;
  choice: ViewChoiceState | undefined;
  review: ViewReviewState | undefined;
}) {
  const { block } = props;
  switch (block.kind) {
    case "text":
      return <TextBlock text={block.text} tone={block.tone} maxLines={lines(block.maxLines)} />;
    case "label":
      return <LabelBlock text={block.text} />;
    case "facts":
      return <FactsBlock rows={block.rows} />;
    case "flags":
      return <FlagsBlock flags={block.flags} />;
    case "links":
      return <LinksBlock links={block.links} />;
    case "refs":
      return <RefsBlock refs={block.refs} />;
    case "draft":
      return (
        <DraftBlock
          channel={isChannel(block.channel) ? block.channel : null}
          people={
            block.audience === null ? [] : [{ kind: "person", name: block.audience, prefix: "To " }]
          }
          link={block.target}
          text={block.text}
          edit={null}
        />
      );
    case "choice":
      return props.choice ? (
        <ChoiceBlock
          options={block.options}
          picked={props.choice.picked}
          onPick={props.choice.onPick}
          advice={block.recommendation}
          disabled={props.choice.disabled}
        />
      ) : null;
    case "list":
      return <ListBlock rows={block.rows} />;
    case "table":
      return <TableBlock columns={block.columns} rows={block.rows} />;
    case "meter":
      return <MeterBlock value={block.value} max={block.max} />;
    case "gallery":
      return (
        <GalleryBlock assets={block.assets} review={block.review ? props.review : undefined} />
      );
    case "group":
      return (
        <GroupBlock direction={block.direction}>
          <ViewBlocks blocks={block.children} choice={props.choice} review={props.review} />
        </GroupBlock>
      );
  }
}

// ---------------------------------------------------------------------------
// list, table, meter

function ListBlock(props: { rows: Extract<ViewBlock, { kind: "list" }>["rows"] }) {
  if (props.rows.length === 0) return null;
  return (
    <ul className="flex min-w-0 flex-col">
      {props.rows.map((row) => (
        <li
          key={row.key}
          className={cn("flex min-w-0 items-baseline gap-3 py-2 text-sm first:pt-0", DESK_ROW)}
        >
          <span className="min-w-0 flex-1 truncate font-medium text-(--m-text)">{row.title}</span>
          {row.meta.map((meta) => (
            <span key={meta} className="shrink-0 text-xs text-(--m-muted) tabular-nums">
              {meta}
            </span>
          ))}
          {row.status ? (
            <span className="shrink-0 text-xs text-(--m-text)">{row.status}</span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function Cell(props: { cell: ViewTableCell; as: string }) {
  if (props.cell.link) return <LinkChip link={props.cell.link} />;
  if (props.cell.text === null) return null;
  return (
    <span
      className={cn(
        props.as === "age" || props.as === "person" ? "text-(--m-muted)" : "text-(--m-text)",
        (props.as === "count" || props.as === "age") && "tabular-nums",
      )}
    >
      {props.cell.text}
    </span>
  );
}

function TableBlock(props: {
  columns: Extract<ViewBlock, { kind: "table" }>["columns"];
  rows: Extract<ViewBlock, { kind: "table" }>["rows"];
}) {
  if (props.rows.length === 0) return null;
  return (
    <>
      {/* Wide screens get the table; phones read each row as a stack, first column as its title. */}
      <table className="hidden w-full min-w-0 table-fixed text-sm sm:table">
        <thead>
          <tr>
            {props.columns.map((column) => (
              <th
                key={column.label}
                scope="col"
                className={cn(
                  "pb-1.5 text-start text-xs font-normal text-(--m-muted)",
                  column.as === "count" && "text-end",
                )}
              >
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {props.rows.map((row) => (
            // taste-skill-ignore: a real table keeps its row rules.
            <tr key={row.key} className="border-t border-(--m-rule)">
              {row.cells.map((cell, index) => {
                const column = props.columns[index];
                return (
                  <td
                    key={column?.label ?? index}
                    className={cn(
                      "truncate py-2 pe-3 align-middle last:pe-0",
                      column?.as === "count" && "text-end",
                    )}
                  >
                    <Cell cell={cell} as={column?.as ?? "text"} />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <ul className="flex min-w-0 flex-col sm:hidden">
        {props.rows.map((row) => (
          <li
            key={row.key}
            className={cn("flex min-w-0 flex-col gap-0.5 py-2 text-sm first:pt-0", DESK_ROW)}
          >
            {row.cells[0] ? <Cell cell={row.cells[0]} as={props.columns[0]?.as ?? "text"} /> : null}
            <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs">
              {row.cells.slice(1).map((cell, index) => (
                <Cell
                  key={props.columns[index + 1]?.label ?? index}
                  cell={cell}
                  as={props.columns[index + 1]?.as ?? "text"}
                />
              ))}
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}

function MeterBlock(props: { value: number; max: number }) {
  const share = props.max <= 0 ? 0 : Math.min(props.value / props.max, 1);
  return (
    <div className="flex min-w-0 items-center gap-3">
      <div
        role="meter"
        aria-valuemin={0}
        aria-valuemax={props.max}
        aria-valuenow={props.value}
        className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-(--m-chip)"
      >
        <div className="h-full rounded-full bg-(--m-accent)" style={{ width: `${share * 100}%` }} />
      </div>
      <span className="shrink-0 text-sm text-(--m-text) tabular-nums">
        {props.value}/{props.max}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// gallery

/** A mission image, served as an attachment resource under its asset id. */
function useMissionImageUrl(asset: ViewGalleryAsset): string | null {
  const environmentId = usePrimaryEnvironmentId();
  const resource = useMemo<AssetResource>(
    () => ({ _tag: "attachment", attachmentId: asset.id, fileName: asset.name }),
    [asset.id, asset.name],
  );
  const state = useAssetUrlState(environmentId, resource);
  return state._tag === "Success" ? state.url : null;
}

function Pin(props: { pin: AssetMark["pin"] }) {
  if (props.pin === null) return null;
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-(--m-accent)"
      style={{ left: `${props.pin.x * 100}%`, top: `${props.pin.y * 100}%` }}
    />
  );
}

const VERDICTS = [
  { verdict: "ok", label: "Looks right" },
  { verdict: "change", label: "Change" },
] as const;

function Verdicts(props: { mark: AssetMark; review: ViewReviewState; assetId: string }) {
  return (
    <div role="group" aria-label="Verdict" className="flex gap-1.5">
      {VERDICTS.map((option) => {
        const pressed = props.mark.verdict === option.verdict;
        return (
          <Button
            key={option.verdict}
            type="button"
            size="xs"
            variant={pressed ? "secondary" : "ghost-muted"}
            aria-pressed={pressed}
            disabled={props.review.disabled}
            onClick={() =>
              props.review.onMark(props.assetId, { verdict: pressed ? null : option.verdict })
            }
          >
            {option.label}
          </Button>
        );
      })}
    </div>
  );
}

function GalleryTile(props: {
  asset: ViewGalleryAsset;
  review: ViewReviewState | undefined;
  onOpen: () => void;
}) {
  const url = useMissionImageUrl(props.asset);
  const mark = props.review ? assetMarkOf(props.review.marks, props.asset.id) : null;
  return (
    <li className="flex min-w-0 flex-col gap-1.5">
      <button
        type="button"
        onClick={props.onOpen}
        aria-label={`Open ${props.asset.name}`}
        className="relative block aspect-[4/3] min-w-0 overflow-hidden rounded-lg bg-(--m-raised) outline-none focus-visible:ring-2 focus-visible:ring-(--m-accent) focus-visible:ring-inset"
      >
        {url ? (
          <img src={url} alt={props.asset.name} loading="lazy" className="size-full object-cover" />
        ) : null}
        {mark ? <Pin pin={mark.pin} /> : null}
      </button>
      {props.review && mark ? (
        <>
          <Verdicts mark={mark} review={props.review} assetId={props.asset.id} />
          {mark.note.trim() !== "" ? (
            <p className="line-clamp-2 text-xs text-(--m-muted)">{mark.note}</p>
          ) : null}
        </>
      ) : null}
    </li>
  );
}

function GalleryBlock(props: {
  assets: ReadonlyArray<ViewGalleryAsset>;
  review: ViewReviewState | undefined;
}) {
  const [open, setOpen] = useState<number | null>(null);
  if (props.assets.length === 0) return null;
  const current = open === null ? null : (props.assets[open] ?? null);
  return (
    <>
      <ul className="grid min-w-0 grid-cols-2 gap-2.5 sm:grid-cols-3">
        {props.assets.map((asset, index) => (
          <GalleryTile
            key={asset.id}
            asset={asset}
            review={props.review}
            onOpen={() => setOpen(index)}
          />
        ))}
      </ul>
      {current ? (
        <Lightbox
          asset={current}
          review={props.review}
          onClose={() => setOpen(null)}
          onStep={
            props.assets.length > 1
              ? (step) =>
                  setOpen((index) =>
                    index === null
                      ? null
                      : (index + step + props.assets.length) % props.assets.length,
                  )
              : null
          }
        />
      ) : null}
    </>
  );
}

function Lightbox(props: {
  asset: ViewGalleryAsset;
  review: ViewReviewState | undefined;
  onClose: () => void;
  onStep: ((step: number) => void) | null;
}) {
  const url = useMissionImageUrl(props.asset);
  const review = props.review;
  const mark = review ? assetMarkOf(review.marks, props.asset.id) : null;
  const placePin = (event: MouseEvent<HTMLButtonElement>) => {
    if (!review || review.disabled) return;
    const box = event.currentTarget.getBoundingClientRect();
    review.onMark(props.asset.id, {
      pin: {
        x: (event.clientX - box.left) / box.width,
        y: (event.clientY - box.top) / box.height,
      },
      verdict: mark?.verdict ?? "change",
    });
  };
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) props.onClose();
      }}
    >
      <DialogPopup
        variant="media"
        showCloseButton={false}
        bottomStickOnMobile={false}
        className="row-start-1 max-h-[92vh] w-[92vw] max-w-[92vw] overflow-visible"
        onKeyDown={(event) => {
          if (!props.onStep) return;
          if (event.key === "ArrowRight") props.onStep(1);
          if (event.key === "ArrowLeft") props.onStep(-1);
        }}
      >
        <div className="flex min-h-0 flex-col items-center gap-3">
          <DialogTitle className="sr-only">{props.asset.name}</DialogTitle>
          <Button
            type="button"
            size="icon-sm"
            variant="media-close"
            className="absolute top-0 right-0 z-20"
            onClick={props.onClose}
            aria-label="Close image"
          >
            <XIcon />
          </Button>
          <button
            type="button"
            onClick={placePin}
            disabled={!review || review.disabled}
            aria-label={review ? "Pin a note here" : props.asset.name}
            className="relative block max-h-[min(72vh,calc(100vh-220px))] max-w-full disabled:cursor-default"
          >
            {url ? (
              <img
                src={url}
                alt={props.asset.name}
                className="max-h-[min(72vh,calc(100vh-220px))] max-w-full rounded-lg object-contain"
              />
            ) : (
              <span className="block h-48 w-72 rounded-lg bg-(--m-raised)" />
            )}
            {mark ? <Pin pin={mark.pin} /> : null}
          </button>
          {review && mark ? (
            <div className="flex w-full max-w-xl flex-col gap-2 rounded-xl bg-(--m-surface) p-3 text-(--m-text)">
              <div className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-sm font-medium">
                  {props.asset.name}
                </span>
                <Verdicts mark={mark} review={review} assetId={props.asset.id} />
              </div>
              <Textarea
                size="sm"
                aria-label={`Note on ${props.asset.name}`}
                placeholder="Note"
                value={mark.note}
                disabled={review.disabled}
                onChange={(event) => review.onMark(props.asset.id, { note: event.target.value })}
              />
              {mark.pin ? (
                <Button
                  type="button"
                  size="xs"
                  variant="ghost-muted"
                  className="self-start"
                  onClick={() => review.onMark(props.asset.id, { pin: null })}
                >
                  Clear pin
                </Button>
              ) : null}
            </div>
          ) : (
            <p className="max-w-full truncate text-xs text-white/80">{props.asset.name}</p>
          )}
        </div>
      </DialogPopup>
    </Dialog>
  );
}
