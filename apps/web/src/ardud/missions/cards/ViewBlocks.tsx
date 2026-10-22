import { useId, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { flushSync } from "react-dom";
import { CheckIcon, ChevronRightIcon, CopyIcon, XIcon } from "lucide-react";

import type { AssetResource, DraftChannel } from "@t3tools/contracts";
import {
  assetMarkOf,
  DRAFT_CHANNEL_LABEL,
  type AssetMark,
  type AssetReview,
  type ViewBlock,
  type ViewGalleryAsset,
  type ViewTableCell,
  // --- blocks additions ---
  viewChartLabels,
  viewChartScale,
  type ViewChart,
  type ViewChartPoint,
  type ViewStatTile,
  type ViewTimelineEntry,
  // --- end blocks additions ---
  viewChartFraction,
  viewMarkdownFold,
  viewMarkdownPreview,
} from "@t3tools/client-runtime/ardud/missions";
import type { ViewLongTextInput } from "@t3tools/contracts";
// --- blocks additions ---
import { VIEW_HARD_LIMITS, type ViewTone } from "@t3tools/contracts";
import { useCopyToClipboard } from "../../../hooks/useCopyToClipboard";
// --- end blocks additions ---

import { useAssetUrlState } from "../../../assets/assetUrls";
import { Button } from "../../../components/ui/button";
import { Dialog, DialogPopup, DialogTitle } from "../../../components/ui/dialog";
import { Textarea } from "../../../components/ui/textarea";
import { observeResize } from "../../../lib/observeResize";
import { cn } from "../../../lib/utils";
import { usePrimaryEnvironmentId } from "../../../state/environments";
import ChatMarkdown from "../../../components/ChatMarkdown";
import { missionErrorMessage, retryViewLongText, useViewLongText } from "../missionsStore";
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
// shared card primitives, plus the list, table, meter, gallery, stat, chart,
// timeline, callout and code blocks.

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
    // --- views additions ---
    case "markdown":
      return block.source ? (
        <LongMarkdown source={block.source} maxLines={block.maxLines} />
      ) : (
        <MarkdownText text={block.text ?? ""} maxLines={block.maxLines} />
      );
    case "collapsible":
      return <CollapsibleBlock block={block} choice={props.choice} review={props.review} />;
    // --- end views additions ---
    // --- blocks additions ---
    case "stat":
      return <StatBlock label={block.label} tiles={block.tiles} />;
    case "chart":
      return <ChartBlock type={block.type} charts={block.charts} />;
    case "timeline":
      return <TimelineBlock entries={block.entries} />;
    case "callout":
      return <CalloutBlock tone={block.tone} texts={block.texts} />;
    case "code":
      return block.source ? (
        <LongCode source={block.source} label={block.label} />
      ) : (
        <CodeText text={block.text ?? ""} label={block.label} />
      );
    // --- end blocks additions ---
  }
}

// --- views additions ---
// ---------------------------------------------------------------------------
// collapsible, markdown

function CollapsibleBlock(props: {
  block: Extract<ViewBlock, { kind: "collapsible" }>;
  choice: ViewChoiceState | undefined;
  review: ViewReviewState | undefined;
}) {
  // Taps override the default, so a newer first row still opens by itself.
  const [toggled, setToggled] = useState<ReadonlyMap<string, boolean>>(new Map());
  return (
    <ul className="flex min-w-0 flex-col">
      {props.block.items.map((item, index) => {
        const open = toggled.get(item.key) ?? (props.block.open === "first" && index === 0);
        const toggle = () => setToggled((current) => new Map(current).set(item.key, !open));
        const long = item.children.some((child) => child.kind === "markdown");
        return (
          <li key={item.key} className={cn("flex min-w-0 flex-col", DESK_ROW)}>
            <button
              type="button"
              aria-expanded={open}
              onClick={toggle}
              className="flex min-w-0 items-baseline gap-2 rounded-lg py-2 text-start text-sm outline-none focus-visible:ring-2 focus-visible:ring-(--m-accent) focus-visible:ring-inset"
            >
              <ChevronRightIcon
                aria-hidden
                className={cn(
                  "size-3.5 shrink-0 self-center text-(--m-muted)",
                  open && "rotate-90",
                )}
              />
              <span className="min-w-0 flex-1 truncate font-medium text-(--m-text)">
                {item.title}
              </span>
              {item.meta.map((meta) => (
                <span
                  key={meta}
                  className="hidden shrink-0 text-xs text-(--m-muted) tabular-nums sm:inline"
                >
                  {meta}
                </span>
              ))}
            </button>
            {open ? (
              <div className="flex min-w-0 flex-col gap-2.5 pb-3 ps-5.5">
                {item.meta.length > 0 ? (
                  <p className="text-xs text-(--m-muted) tabular-nums sm:hidden">
                    {item.meta.join(" · ")}
                  </p>
                ) : null}
                <ViewBlocks blocks={item.children} choice={props.choice} review={props.review} />
                {long ? (
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost-muted"
                    className="self-start"
                    onClick={toggle}
                  >
                    Collapse
                  </Button>
                ) : null}
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/** Lines of `text-sm leading-relaxed`; markdown blocks can't line-clamp, so they cap height. */
const markdownCap = (maxLines: number | null) =>
  maxLines === null ? undefined : { maxHeight: `${maxLines * 1.625}em` };

function MarkdownText(props: { text: string; maxLines: number | null }) {
  const [unfolded, setUnfolded] = useState(false);
  const [size, setSize] = useState<{ content: number; cap: number } | null>(null);
  const content = useRef<HTMLDivElement>(null);
  const id = useId();
  const capped = props.maxLines !== null;
  const open = capped && unfolded;
  const preview =
    props.maxLines === null
      ? { text: props.text, cut: false }
      : viewMarkdownPreview(props.text, props.maxLines);
  const { maxLines } = props;
  useLayoutEffect(() => {
    const element = content.current;
    const clip = element?.parentElement;
    // Measured while folded only: the open block keeps the fold it opened from.
    if (!element || !clip || maxLines === null || open) return;
    const measure = () => {
      const next = {
        content: element.getBoundingClientRect().height,
        cap: maxLines * 1.625 * Number.parseFloat(getComputedStyle(clip).fontSize),
      };
      setSize((last) => (last?.content === next.content && last.cap === next.cap ? last : next));
    };
    measure();
    return observeResize(element, measure);
  }, [maxLines, open]);
  if (props.text.trim() === "") return null;
  // The DOM lays out the longest report fine, so web grows in place at any length.
  const fold = viewMarkdownFold({
    chars: props.text.length,
    cut: preview.cut,
    contentHeight: size?.content ?? null,
    // Before the first measure only a cut preview is known to overflow.
    capHeight: capped ? (size?.cap ?? Number.POSITIVE_INFINITY) : null,
  });
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div
        id={id}
        data-mission-markdown=""
        className={cn("min-w-0 text-sm text-(--m-text)", capped && !open && "overflow-hidden")}
        style={open ? undefined : markdownCap(props.maxLines)}
      >
        <div ref={content}>
          <ChatMarkdown
            text={open ? props.text : preview.text}
            cwd={undefined}
            headingLevelOffset={2}
          />
        </div>
      </div>
      {fold === "none" && !open ? null : (
        <Button
          type="button"
          size="xs"
          variant="ghost-muted"
          className="self-start"
          aria-expanded={open}
          aria-controls={id}
          onClick={(event) => {
            if (!open) {
              setUnfolded(true);
              return;
            }
            // Folding a long report would leave the reader far below it; keep the button in view.
            const button = event.currentTarget;
            flushSync(() => setUnfolded(false));
            button.scrollIntoView({ block: "nearest" });
          }}
        >
          {open ? "Show less" : "Show all"}
        </Button>
      )}
    </div>
  );
}

function LongMarkdown(props: { source: ViewLongTextInput; maxLines: number | null }) {
  const state = useViewLongText(props.source);
  if (state === undefined || state.status === "loading") {
    return (
      <div aria-hidden className="flex flex-col gap-2 py-1">
        {[0.9, 0.7, 0.8].map((width) => (
          <span
            key={width}
            className="h-3 rounded-md bg-(--m-active)"
            style={{ width: `${width * 100}%` }}
          />
        ))}
      </div>
    );
  }
  if (state.status === "failed") {
    return (
      <div className="flex min-w-0 items-center gap-3 text-sm text-(--m-muted)">
        <span className="min-w-0 flex-1">{missionErrorMessage(state.error)}</span>
        <Button
          type="button"
          size="xs"
          variant="ghost-muted"
          onClick={() => retryViewLongText(props.source)}
        >
          Retry
        </Button>
      </div>
    );
  }
  const { value } = state;
  return (
    <>
      <MarkdownText text={value.text} maxLines={props.maxLines} />
      {value.truncated ? (
        <p className="text-xs text-(--m-muted)">
          Cut at {value.text.length.toLocaleString()} of {value.size.toLocaleString()} characters.
        </p>
      ) : null}
    </>
  );
}
// --- end views additions ---

// --- blocks additions ---
// ---------------------------------------------------------------------------
// stat, chart, timeline, callout, code

const TONE_TEXT: Record<ViewTone, string> = {
  good: "text-(--m-positive)",
  warn: "text-(--m-warning)",
  bad: "text-(--m-negative)",
  info: "text-(--m-info)",
};

const TONE_DOT: Record<ViewTone, string> = {
  good: "bg-(--m-positive)",
  warn: "bg-(--m-warning)",
  bad: "bg-(--m-negative)",
  info: "bg-(--m-info)",
};

const TONE_NOTE: Record<ViewTone, string> = {
  good: "bg-(--m-positive)/10 text-(--m-positive)",
  warn: "bg-(--m-warning)/10 text-(--m-warning)",
  bad: "bg-(--m-negative)/10 text-(--m-negative)",
  info: "bg-(--m-info)/10 text-(--m-info)",
};

function StatBlock(props: { label: string; tiles: ReadonlyArray<ViewStatTile> }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-xs text-(--m-muted)">{props.label}</span>
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-6 gap-y-2">
        {props.tiles.map((tile) => (
          <span key={tile.key} className="flex min-w-0 items-baseline gap-1.5 tabular-nums">
            <span
              className={cn(
                "text-2xl font-semibold tracking-tight",
                tile.delta === null && tile.tone !== null
                  ? TONE_TEXT[tile.tone]
                  : "text-(--m-text)",
              )}
            >
              {tile.prefix}
              {tile.value}
            </span>
            {tile.suffix ? <span className="text-sm text-(--m-muted)">{tile.suffix}</span> : null}
            {tile.delta ? (
              <span
                className={cn("text-xs", tile.tone ? TONE_TEXT[tile.tone] : "text-(--m-muted)")}
              >
                {tile.delta}
              </span>
            ) : null}
          </span>
        ))}
      </div>
    </div>
  );
}

function ChartBlock(props: { type: "line" | "bar"; charts: ReadonlyArray<ViewChart> }) {
  return (
    <div className="flex min-w-0 flex-col gap-4">
      {props.charts.map((chart) => (
        <figure key={chart.key} className="flex min-w-0 flex-col gap-1.5">
          {chart.title ? (
            <figcaption className="truncate text-xs text-(--m-muted)">{chart.title}</figcaption>
          ) : null}
          <ChartPlot type={props.type} title={chart.title} points={chart.points} />
        </figure>
      ))}
    </div>
  );
}

/** Where a point's centre sits across the plot, 0..100. */
const chartX = (type: "line" | "bar", index: number, count: number) =>
  type === "bar" ? ((index + 0.5) / count) * 100 : count === 1 ? 50 : (index / (count - 1)) * 100;

function ChartPlot(props: {
  type: "line" | "bar";
  title: string | null;
  points: ReadonlyArray<ViewChartPoint>;
}) {
  const { points } = props;
  const scale = viewChartScale(points);
  const y = (value: number) => 100 - viewChartFraction(scale, value) * 100;
  const zero = y(0);
  const band = 100 / points.length;
  const last = points.at(-1);
  // One point has no slope; it reads as a level line across the plot.
  const line =
    points.length === 1
      ? `0,${y(points[0]!.value)} 100,${y(points[0]!.value)}`
      : points
          .map((point, index) => `${chartX("line", index, points.length)},${y(point.value)}`)
          .join(" ");
  return (
    <div className="flex min-w-0 gap-2">
      <div
        aria-hidden
        className="relative h-36 w-9 shrink-0 text-2xs text-(--m-muted) tabular-nums"
      >
        {scale.ticks.map((tick) => (
          <span
            key={tick.value}
            className="absolute end-0 -translate-y-1/2 leading-none"
            style={{ top: `${y(tick.value)}%` }}
          >
            {tick.label}
          </span>
        ))}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <svg
          role="img"
          aria-label={`${props.title ?? "Chart"}: ${points.length} points${last ? `, last ${last.label ? `${last.label} ` : ""}${last.value.toLocaleString()}` : ""}`}
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          className="h-36 w-full overflow-visible"
        >
          {scale.ticks.map((tick) => (
            <line
              key={tick.value}
              x1={0}
              x2={100}
              y1={y(tick.value)}
              y2={y(tick.value)}
              stroke={tick.value === 0 ? "var(--m-tick)" : "var(--m-rule)"}
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {props.type === "bar" ? (
            points.map((point, index) => (
              <rect
                // Points have no ids; their order is the rows'.
                // eslint-disable-next-line react/no-array-index-key
                key={index}
                x={index * band + band * 0.2}
                width={band * 0.6}
                y={Math.min(y(point.value), zero)}
                height={Math.abs(zero - y(point.value))}
                fill="var(--m-accent)"
              />
            ))
          ) : (
            <polyline
              points={line}
              fill="none"
              stroke="var(--m-accent)"
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          )}
        </svg>
        <div aria-hidden className="relative h-4 text-2xs text-(--m-muted) tabular-nums">
          {viewChartLabels(points).map((tick, slot, all) => (
            <span
              key={tick.index}
              className={cn(
                "absolute top-0 truncate whitespace-nowrap",
                slot === 0
                  ? ""
                  : slot === all.length - 1
                    ? "-translate-x-full"
                    : "-translate-x-1/2",
              )}
              style={{
                left: `${slot === 0 ? 0 : slot === all.length - 1 ? 100 : chartX(props.type, tick.index, points.length)}%`,
              }}
            >
              {tick.label}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function TimelineBlock(props: { entries: ReadonlyArray<ViewTimelineEntry> }) {
  return (
    <ol className="ms-1 flex min-w-0 flex-col border-s border-(--m-rule)">
      {props.entries.map((entry) => (
        <li key={entry.key} className="relative flex min-w-0 flex-col gap-0.5 ps-4 pb-3 last:pb-0">
          <span
            aria-hidden
            className={cn(
              "absolute -start-[4.5px] top-1.5 size-2 rounded-full",
              entry.tone ? TONE_DOT[entry.tone] : "bg-(--m-tick)",
            )}
          />
          <span className="flex min-w-0 items-baseline gap-3 text-sm">
            <span className="min-w-0 flex-1 truncate font-medium text-(--m-text)">
              {entry.title}
            </span>
            {entry.at ? (
              <span className="shrink-0 text-xs text-(--m-muted) tabular-nums">{entry.at}</span>
            ) : null}
          </span>
          {entry.meta.length > 0 ? (
            <span className="truncate text-xs text-(--m-muted)">{entry.meta.join(" · ")}</span>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

function CalloutBlock(props: { tone: ViewTone; texts: ReadonlyArray<string> }) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {props.texts.map((text, index) => (
        <p
          // Notes have no ids; their order is the rows'.
          // eslint-disable-next-line react/no-array-index-key
          key={index}
          role="note"
          className={cn("rounded-lg px-3 py-2 text-sm break-words", TONE_NOTE[props.tone])}
        >
          {text}
        </p>
      ))}
    </div>
  );
}

function CodeText(props: { text: string; label: string | null; note?: string | undefined }) {
  const [unfolded, setUnfolded] = useState(false);
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "code", timeout: 1_200 });
  if (props.text.trim() === "") return null;
  const codeLines = props.text.split("\n");
  const fold = VIEW_HARD_LIMITS.codeFoldLines;
  const folded = !unfolded && codeLines.length > fold;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-xs text-(--m-muted)">{props.label}</span>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost-muted"
          aria-label={isCopied ? "Copied" : "Copy"}
          onClick={() => copyToClipboard(props.text)}
        >
          {isCopied ? <CheckIcon /> : <CopyIcon />}
        </Button>
      </div>
      <pre className="min-w-0 overflow-x-auto rounded-xl bg-(--m-raised) px-3 py-2 font-mono text-xs leading-5 text-(--m-text)">
        <code>{folded ? codeLines.slice(0, fold).join("\n") : props.text}</code>
      </pre>
      {codeLines.length > fold ? (
        <Button
          type="button"
          size="xs"
          variant="ghost-muted"
          className="self-start"
          onClick={() => setUnfolded(!unfolded)}
        >
          {folded ? `Show all ${codeLines.length.toLocaleString()} lines` : "Show less"}
        </Button>
      ) : null}
      {props.note ? <p className="text-xs text-(--m-muted)">{props.note}</p> : null}
    </div>
  );
}

function LongCode(props: { source: ViewLongTextInput; label: string | null }) {
  const state = useViewLongText(props.source);
  if (state === undefined || state.status === "loading") {
    return <div aria-hidden className="h-24 rounded-xl bg-(--m-active)" />;
  }
  if (state.status === "failed") {
    return (
      <div className="flex min-w-0 items-center gap-3 text-sm text-(--m-muted)">
        <span className="min-w-0 flex-1">{missionErrorMessage(state.error)}</span>
        <Button
          type="button"
          size="xs"
          variant="ghost-muted"
          onClick={() => retryViewLongText(props.source)}
        >
          Retry
        </Button>
      </div>
    );
  }
  const { value } = state;
  return (
    <CodeText
      text={value.text}
      label={props.label}
      note={
        value.truncated
          ? `Cut at ${value.text.length.toLocaleString()} of ${value.size.toLocaleString()} characters.`
          : undefined
      }
    />
  );
}
// --- end blocks additions ---

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
