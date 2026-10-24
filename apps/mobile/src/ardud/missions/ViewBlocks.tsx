import type {
  AnswerAskInput,
  AssetResource,
  MissionId,
  MissionViewsSnapshot,
  ViewBackedRecord,
} from "@t3tools/contracts";
import {
  assetMarkOf,
  refLabel,
  viewCard,
  viewSection,
  viewSectionData,
  viewSectionSource,
  withAssetFeedback,
  type AssetMark,
  type AssetReview,
  type ViewBlock,
  type ViewChoiceOption,
  type ViewGalleryAsset,
  type ViewListRow,
  type ViewLongTextRequest,
  type ViewSectionEntry,
  type ViewTableRow,
  // --- blocks additions ---
  viewChartLabels,
  viewChartScale,
  type ViewChart,
  type ViewChartPoint,
  type ViewStatTile,
  type ViewTimelineEntry,
  // --- end blocks additions ---
  viewChartFraction,
  viewMarkdownChunks,
  viewMarkdownFold,
  viewMarkdownPreview,
} from "@t3tools/client-runtime/ardud/missions";
import { missionErrorMessage } from "@t3tools/client-runtime/ardud/missions/mobile";
import { Image } from "expo-image";
import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import { FlatList, Modal, Pressable, ScrollView, View } from "react-native";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";
// --- blocks additions ---
import { VIEW_HARD_LIMITS, type ViewTone } from "@t3tools/contracts";
import * as Clipboard from "expo-clipboard";
import Svg, { Line, Polyline, Rect } from "react-native-svg";
import { useResolveClassNames } from "uniwind";
// --- end blocks additions ---

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { useMarkdownPreviewStyles } from "../../features/files/FileMarkdownPreview";
import { assetImageSource } from "../../lib/assetImageSource";
import { cn } from "../../lib/cn";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { markdownGapBefore } from "../../native/markdownSpacing";
import { SelectableMarkdownText } from "../../native/SelectableMarkdownText";
import { useAssetUrl } from "../../state/assets";
import { useMissionsEnvironmentId } from "./missionsStore";
import {
  ActionButton,
  Body,
  Chip,
  Facts,
  Group,
  LinkButton,
  LinkChips,
  Meta,
  SectionHead,
  TextField,
  Title,
} from "./parts";
import { useReviewMarks } from "./reviewMarks";
import { retryViewLongText, useMissionViews, useViewLongText } from "./viewsStore";

// The phone's drawing of view blocks: the bodies of templated cards and the
// sections the master placed. Tables become stacked rows, the first column
// as the row's title. Images open full screen; on a UI review each image
// takes a verdict, a note and a pin, sent together with the answer.

export interface ViewChoiceState {
  readonly picked: string | null;
  readonly onPick: (optionId: string) => void;
  readonly disabled: boolean;
}

export interface ViewReviewState {
  readonly marks: AssetReview;
  readonly onMark: (assetId: string, change: Partial<AssetMark>) => void;
  readonly disabled: boolean;
}

interface BlockProps {
  readonly choice?: ViewChoiceState | undefined;
  readonly review?: ViewReviewState | undefined;
}

export function ViewBlocks(props: BlockProps & { readonly blocks: ReadonlyArray<ViewBlock> }) {
  return (
    <>
      {props.blocks.map((block, index) => (
        <Block
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

function Block(props: BlockProps & { readonly block: ViewBlock }) {
  const { block } = props;
  switch (block.kind) {
    case "text":
      if (block.text.trim() === "") return null;
      return block.tone === "meta" ? (
        <Meta numberOfLines={block.maxLines}>{block.text}</Meta>
      ) : (
        <Text
          selectable
          numberOfLines={block.maxLines}
          className="text-[15px] leading-6 text-foreground"
        >
          {block.text}
        </Text>
      );
    case "label":
      return (
        <Text className="text-[13px] font-t3-semibold text-foreground-muted">{block.text}</Text>
      );
    case "facts":
      return <Facts facts={block.rows} />;
    case "flags":
      return block.flags.length === 0 ? null : (
        <View className="flex-row flex-wrap gap-1.5">
          {block.flags.map((flag) => (
            <Chip key={flag} label={flag} />
          ))}
        </View>
      );
    case "links":
      return <LinkChips links={block.links} />;
    case "refs":
      return block.refs.length === 0 ? null : (
        <View className="flex-row flex-wrap gap-1.5">
          {block.refs.map((ref) => (
            <Chip key={`${ref.kind}:${ref.id}`} label={refLabel(ref)} />
          ))}
        </View>
      );
    case "draft":
      return (
        <View className="gap-2 rounded-[18px] bg-grouped-card px-3.5 py-3">
          {block.target ? <LinkChips links={[block.target]} /> : null}
          {block.audience ? <Meta>To {block.audience}</Meta> : null}
          <Body>{block.text}</Body>
        </View>
      );
    case "choice":
      return props.choice ? (
        <ChoiceList options={block.options} advice={block.recommendation} choice={props.choice} />
      ) : null;
    case "list":
      return <ListRows rows={block.rows} />;
    case "table":
      return <TableRows columns={block.columns} rows={block.rows} />;
    case "meter":
      return <MeterBar value={block.value} max={block.max} />;
    case "gallery":
      return <Gallery assets={block.assets} review={block.review ? props.review : undefined} />;
    case "group":
      return (
        <View className={block.direction === "row" ? "flex-row flex-wrap gap-3" : "gap-3"}>
          <ViewBlocks blocks={block.children} choice={props.choice} review={props.review} />
        </View>
      );
    // --- views additions ---
    case "markdown":
      return block.source === null ? (
        <MarkdownText text={block.text ?? ""} maxLines={block.maxLines} />
      ) : (
        <LongMarkdown source={block.source} maxLines={block.maxLines} />
      );
    case "collapsible":
      return <CollapsibleRows block={block} choice={props.choice} review={props.review} />;
    // --- end views additions ---
    // --- blocks additions ---
    case "stat":
      return <StatTiles label={block.label} tiles={block.tiles} />;
    case "chart":
      return <Charts type={block.type} charts={block.charts} />;
    case "timeline":
      return <Timeline entries={block.entries} />;
    case "callout":
      return <Callouts tone={block.tone} texts={block.texts} />;
    case "code":
      return block.source === null ? (
        <CodeText text={block.text ?? ""} label={block.label} />
      ) : (
        <LongCode source={block.source} label={block.label} />
      );
    // --- end blocks additions ---
  }
}

// --- views additions ---
function CollapsibleRows(
  props: BlockProps & { readonly block: Extract<ViewBlock, { kind: "collapsible" }> },
) {
  // Taps override the default, so a newer first row still opens by itself.
  const [toggled, setToggled] = useState<ReadonlyMap<string, boolean>>(new Map());
  return (
    <View>
      {props.block.items.map((item, index) => {
        const open = toggled.get(item.key) ?? index < props.block.openCount;
        const toggle = () => setToggled((current) => new Map(current).set(item.key, !open));
        const long = item.children.some((child) => child.kind === "markdown");
        return (
          <Fragment key={item.key}>
            {index > 0 ? <View className="h-px bg-border" /> : null}
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded: open }}
              onPress={toggle}
              className="min-h-11 flex-row items-center gap-2.5 py-2.5"
            >
              <SymbolView
                name={open ? "chevron.down" : "chevron.right"}
                size={12}
                tintColorClassName="accent-icon-subtle"
                type="monochrome"
              />
              <View className="min-w-0 flex-1 gap-1">
                <Title>{item.title}</Title>
                {item.meta.length > 0 ? (
                  <View className="flex-row flex-wrap gap-x-3 gap-y-1">
                    {item.meta.map((meta) => (
                      <Meta key={meta}>{meta}</Meta>
                    ))}
                  </View>
                ) : null}
              </View>
            </Pressable>
            {open ? (
              <View className="gap-3 pb-3 pl-[22px]">
                <ViewBlocks blocks={item.children} choice={props.choice} review={props.review} />
                {long ? (
                  <View className="items-start">
                    <LinkButton label="Collapse" onPress={toggle} />
                  </View>
                ) : null}
              </View>
            ) : null}
          </Fragment>
        );
      })}
    </View>
  );
}

const openMarkdownLink = (href: string) => void tryOpenExternalUrl(href, "markdown-link");

/** Markdown folded to `maxLines`; long text opens in a full-screen reader. */
export function MarkdownText(props: { readonly text: string; readonly maxLines: number | null }) {
  const styles = useMarkdownPreviewStyles();
  const [unfolded, setUnfolded] = useState(false);
  const [reading, setReading] = useState(false);
  const [height, setHeight] = useState<number | null>(null);
  const preview = useMemo(
    () =>
      props.maxLines === null
        ? { text: props.text, cut: false }
        : viewMarkdownPreview(props.text, props.maxLines),
    [props.text, props.maxLines],
  );
  if (props.text.trim() === "") return null;
  // The native markdown view can't clamp lines, so a capped block clips its height.
  const cap = props.maxLines === null ? null : props.maxLines * styles.nativeTextStyle.lineHeight;
  const fold = viewMarkdownFold({
    chars: props.text.length,
    cut: preview.cut,
    contentHeight: height,
    capHeight: cap,
  });
  const open = unfolded && fold === "inline";
  return (
    <View>
      {/* Clips even when open: a document pulls its leading heading's margin
          up, and the native view must not catch touches above the block. */}
      <View
        className="overflow-hidden"
        style={{ maxHeight: cap === null || open ? undefined : cap }}
      >
        {/* Lays out at full height inside the clip, which is how overflow
            shows. Measured open too, so a width or text change refolds. */}
        <View onLayout={(event) => setHeight(event.nativeEvent.layout.height)}>
          <SelectableMarkdownText
            markdown={open ? props.text : preview.text}
            textStyle={styles.nativeTextStyle}
            spacing="document"
            onLinkPress={openMarkdownLink}
          />
        </View>
      </View>
      {fold === "none" ? null : (
        <View className="items-start">
          <LinkButton
            label={open ? "Show less" : "Show all"}
            onPress={() => (fold === "reader" ? setReading(true) : setUnfolded(!open))}
          />
        </View>
      )}
      {reading ? <MarkdownReader text={props.text} onClose={() => setReading(false)} /> : null}
    </View>
  );
}

/**
 * A long report in a screen of its own. It renders in pieces as they scroll
 * in, where one native view of the whole text would lay out every line first.
 */
function MarkdownReader(props: { readonly text: string; readonly onClose: () => void }) {
  return (
    <Modal
      visible
      animationType="slide"
      supportedOrientations={["portrait", "landscape"]}
      onRequestClose={props.onClose}
    >
      {/* Its own provider: the modal is a separate window whose insets follow
          rotation, where the board's would go stale. */}
      <SafeAreaProvider>
        <MarkdownReaderBody text={props.text} onClose={props.onClose} />
      </SafeAreaProvider>
    </Modal>
  );
}

function MarkdownReaderBody(props: { readonly text: string; readonly onClose: () => void }) {
  const styles = useMarkdownPreviewStyles();
  const insets = useSafeAreaInsets();
  const chunks = useMemo(() => viewMarkdownChunks(props.text), [props.text]);
  return (
    <View
      className="flex-1 bg-screen"
      style={{ paddingTop: insets.top, paddingLeft: insets.left, paddingRight: insets.right }}
    >
      <View className="min-h-12 flex-row items-center justify-end px-4">
        <LinkButton label="Done" onPress={props.onClose} />
      </View>
      <FlatList
        data={chunks}
        keyExtractor={(_, index) => String(index)}
        initialNumToRender={2}
        windowSize={7}
        contentContainerStyle={{
          width: "100%",
          maxWidth: 720,
          alignSelf: "center",
          paddingHorizontal: 16,
          paddingBottom: insets.bottom + 24,
        }}
        renderItem={({ item, index }) => (
          <View
            style={{
              paddingTop: index === 0 ? 4 : markdownGapBefore(item.text, item.continuesList),
            }}
          >
            <SelectableMarkdownText
              markdown={item.text}
              textStyle={styles.nativeTextStyle}
              spacing="document"
              onLinkPress={openMarkdownLink}
            />
          </View>
        )}
      />
    </View>
  );
}

function LongMarkdown(props: {
  readonly source: ViewLongTextRequest;
  readonly maxLines: number | null;
}) {
  const state = useViewLongText(props.source);
  if (state === undefined || state.status === "loading") {
    return (
      <View accessibilityLabel="Loading" className="gap-2 py-1">
        {[0.9, 0.7, 0.8].map((width) => (
          <View
            key={width}
            className="h-3 rounded-md bg-secondary"
            style={{ width: `${width * 100}%` }}
          />
        ))}
      </View>
    );
  }
  if (state.status === "failed") {
    return (
      <View className="flex-row items-center gap-3">
        <Meta className="min-w-0 flex-1">{missionErrorMessage(state.error)}</Meta>
        <LinkButton label="Retry" onPress={() => retryViewLongText(props.source)} />
      </View>
    );
  }
  const { value } = state;
  return (
    <>
      <MarkdownText text={value.text} maxLines={props.maxLines} />
      {value.truncated ? (
        <Meta>
          Cut at {value.text.length.toLocaleString()} of {value.size.toLocaleString()} characters.
        </Meta>
      ) : null}
    </>
  );
}
// --- end views additions ---

// --- blocks additions ---
const TONE_TEXT: Record<ViewTone, string> = {
  good: "text-adaptive-emerald-700-300",
  warn: "text-adaptive-amber-700-300",
  bad: "text-adaptive-rose-700-300",
  info: "text-adaptive-sky-700-300",
};

const TONE_DOT: Record<ViewTone, string> = {
  good: "bg-adaptive-emerald-600-400",
  warn: "bg-adaptive-amber-700-400",
  bad: "bg-adaptive-rose-600-400",
  info: "bg-adaptive-sky-600-400",
};

const TONE_NOTE: Record<ViewTone, string> = {
  good: "bg-adaptive-emerald-500-a12-a16",
  warn: "bg-adaptive-amber-500-a12-a16",
  bad: "bg-adaptive-rose-500-a12-a16",
  info: "bg-adaptive-sky-500-a12-a16",
};

function StatTiles(props: { readonly label: string; readonly tiles: ReadonlyArray<ViewStatTile> }) {
  return (
    <View className="gap-1">
      <Meta>{props.label}</Meta>
      <View className="flex-row flex-wrap items-baseline gap-x-6 gap-y-2">
        {props.tiles.map((tile) => (
          <View key={tile.key} className="flex-row items-baseline gap-1.5">
            <Text
              className={cn(
                "text-2xl font-t3-semibold tabular-nums",
                tile.delta === null && tile.tone !== null
                  ? TONE_TEXT[tile.tone]
                  : "text-foreground",
              )}
            >
              {tile.prefix}
              {tile.value}
            </Text>
            {tile.suffix ? (
              <Text className="text-sm text-foreground-muted">{tile.suffix}</Text>
            ) : null}
            {tile.delta ? (
              <Text
                className={cn(
                  "text-xs tabular-nums",
                  tile.tone ? TONE_TEXT[tile.tone] : "text-foreground-muted",
                )}
              >
                {tile.delta}
              </Text>
            ) : null}
          </View>
        ))}
      </View>
    </View>
  );
}

function Charts(props: {
  readonly type: "line" | "bar";
  readonly charts: ReadonlyArray<ViewChart>;
}) {
  return (
    <View className="gap-4">
      {props.charts.map((chart) => (
        <View key={chart.key} className="gap-1.5">
          {chart.title ? <Meta numberOfLines={1}>{chart.title}</Meta> : null}
          <ChartPlot type={props.type} title={chart.title} points={chart.points} />
        </View>
      ))}
    </View>
  );
}

const PLOT_HEIGHT = 144;
const X_LABEL_WIDTH = 72;

/** Where a point's centre sits across the plot, 0..1. */
const chartX = (type: "line" | "bar", index: number, count: number) =>
  type === "bar" ? (index + 0.5) / count : count === 1 ? 0.5 : index / (count - 1);

function ChartPlot(props: {
  readonly type: "line" | "bar";
  readonly title: string | null;
  readonly points: ReadonlyArray<ViewChartPoint>;
}) {
  // SVG takes colours as props, not classes.
  const { color: accent } = useResolveClassNames("text-primary");
  const { color: rule } = useResolveClassNames("text-border");
  const { color: baseline } = useResolveClassNames("text-icon-muted");
  // SVG wants pixels; the plot's width is only known once it lays out.
  const [width, setWidth] = useState(0);
  const { points } = props;
  const scale = viewChartScale(points);
  const y = (value: number) => PLOT_HEIGHT - viewChartFraction(scale, value) * PLOT_HEIGHT;
  const zero = y(0);
  const band = width / points.length;
  const last = points.at(-1);
  // One point has no slope; it reads as a level line across the plot.
  const line =
    points.length === 1
      ? `0,${y(points[0]!.value)} ${width},${y(points[0]!.value)}`
      : points
          .map(
            (point, index) => `${chartX("line", index, points.length) * width},${y(point.value)}`,
          )
          .join(" ");
  const labels = viewChartLabels(points);
  return (
    <View className="flex-row gap-2">
      <View style={{ height: PLOT_HEIGHT }} className="w-9">
        {scale.ticks.map((tick) => (
          <Text
            key={tick.value}
            numberOfLines={1}
            className="absolute right-0 text-[11px] leading-[14px] tabular-nums text-foreground-muted"
            style={{ top: y(tick.value) - 7 }}
          >
            {tick.label}
          </Text>
        ))}
      </View>
      <View className="min-w-0 flex-1 gap-1.5">
        <View
          accessible
          accessibilityRole="image"
          accessibilityLabel={`${props.title ?? "Chart"}: ${points.length} points${last ? `, last ${last.label ? `${last.label} ` : ""}${last.value.toLocaleString()}` : ""}`}
          style={{ height: PLOT_HEIGHT }}
          onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
        >
          {width > 0 ? (
            <Svg width={width} height={PLOT_HEIGHT}>
              {scale.ticks.map((tick) => (
                <Line
                  key={tick.value}
                  x1={0}
                  x2={width}
                  y1={y(tick.value)}
                  y2={y(tick.value)}
                  stroke={tick.value === 0 ? baseline : rule}
                  strokeWidth={1}
                />
              ))}
              {props.type === "bar" ? (
                points.map((point, index) => (
                  <Rect
                    // Points have no ids; their order is the rows'.
                    // eslint-disable-next-line react/no-array-index-key
                    key={index}
                    x={index * band + band * 0.2}
                    width={band * 0.6}
                    y={Math.min(y(point.value), zero)}
                    height={Math.abs(zero - y(point.value))}
                    fill={accent}
                  />
                ))
              ) : (
                <Polyline
                  points={line}
                  fill="none"
                  stroke={accent}
                  strokeWidth={2}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              )}
            </Svg>
          ) : null}
        </View>
        <View className="h-4">
          {width > 0
            ? labels.map((tick, slot) => {
                const first = slot === 0;
                const final = slot === labels.length - 1 && !first;
                const centre = chartX(props.type, tick.index, points.length) * width;
                return (
                  <Text
                    key={tick.index}
                    numberOfLines={1}
                    className={cn(
                      "absolute top-0 text-[11px] tabular-nums text-foreground-muted",
                      first ? "text-left" : final ? "text-right" : "text-center",
                    )}
                    style={
                      first
                        ? { left: 0, maxWidth: X_LABEL_WIDTH }
                        : final
                          ? { right: 0, maxWidth: X_LABEL_WIDTH }
                          : { left: centre - X_LABEL_WIDTH / 2, width: X_LABEL_WIDTH }
                    }
                  >
                    {tick.label}
                  </Text>
                );
              })
            : null}
        </View>
      </View>
    </View>
  );
}

function Timeline(props: { readonly entries: ReadonlyArray<ViewTimelineEntry> }) {
  return (
    <View className="ml-1 border-l border-border">
      {props.entries.map((entry, index) => (
        <View
          key={entry.key}
          className={cn("gap-0.5 pl-4", index < props.entries.length - 1 ? "pb-3" : undefined)}
        >
          <View
            className={cn(
              "absolute top-1.5 size-2 rounded-full",
              entry.tone ? TONE_DOT[entry.tone] : "bg-foreground-muted",
            )}
            style={{ left: -4.5 }}
          />
          <View className="flex-row items-baseline gap-3">
            <Text
              numberOfLines={2}
              className="min-w-0 flex-1 text-sm font-t3-semibold text-foreground"
            >
              {entry.title}
            </Text>
            {entry.at ? <Meta className="tabular-nums">{entry.at}</Meta> : null}
          </View>
          {entry.meta.length > 0 ? <Meta numberOfLines={1}>{entry.meta.join(" · ")}</Meta> : null}
        </View>
      ))}
    </View>
  );
}

function Callouts(props: { readonly tone: ViewTone; readonly texts: ReadonlyArray<string> }) {
  return (
    <View className="gap-2">
      {props.texts.map((text, index) => (
        <View
          // Notes have no ids; their order is the rows'.
          // eslint-disable-next-line react/no-array-index-key
          key={index}
          className={cn("rounded-xl px-3 py-2", TONE_NOTE[props.tone])}
        >
          <Text selectable className={cn("text-sm leading-5", TONE_TEXT[props.tone])}>
            {text}
          </Text>
        </View>
      ))}
    </View>
  );
}

function CodeText(props: {
  readonly text: string;
  readonly label: string | null;
  readonly note?: string | undefined;
}) {
  const [unfolded, setUnfolded] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1_200);
    return () => clearTimeout(timer);
  }, [copied]);
  if (props.text.trim() === "") return null;
  const codeLines = props.text.split("\n");
  const fold = VIEW_HARD_LIMITS.codeFoldLines;
  const folded = !unfolded && codeLines.length > fold;
  const copy = () =>
    void Clipboard.setStringAsync(props.text).then(
      () => setCopied(true),
      () => undefined,
    );
  return (
    <View className="gap-1.5">
      <View className="flex-row items-center gap-2">
        <Meta numberOfLines={1} className="min-w-0 flex-1">
          {props.label ?? ""}
        </Meta>
        <LinkButton label={copied ? "Copied" : "Copy"} onPress={copy} />
      </View>
      <ScrollView horizontal className="rounded-xl bg-subtle" contentContainerClassName="px-3 py-2">
        <Text selectable className="font-mono text-xs leading-5 text-foreground">
          {folded ? codeLines.slice(0, fold).join("\n") : props.text}
        </Text>
      </ScrollView>
      {codeLines.length > fold ? (
        <View className="items-start">
          <LinkButton
            label={folded ? `Show all ${codeLines.length.toLocaleString()} lines` : "Show less"}
            onPress={() => setUnfolded(!unfolded)}
          />
        </View>
      ) : null}
      {props.note ? <Meta>{props.note}</Meta> : null}
    </View>
  );
}

function LongCode(props: { readonly source: ViewLongTextRequest; readonly label: string | null }) {
  const state = useViewLongText(props.source);
  if (state === undefined || state.status === "loading") {
    return <View accessibilityLabel="Loading" className="h-24 rounded-xl bg-secondary" />;
  }
  if (state.status === "failed") {
    return (
      <View className="flex-row items-center gap-3">
        <Meta className="min-w-0 flex-1">{missionErrorMessage(state.error)}</Meta>
        <LinkButton label="Retry" onPress={() => retryViewLongText(props.source)} />
      </View>
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

function ChoiceList(props: {
  readonly options: ReadonlyArray<ViewChoiceOption>;
  readonly advice: string | null;
  readonly choice: ViewChoiceState;
}) {
  return (
    <View className="gap-2">
      <View accessibilityRole="radiogroup" className="gap-2">
        {props.options.map((option) => {
          const picked = props.choice.picked === option.id;
          return (
            <Pressable
              key={option.id}
              accessibilityRole="radio"
              accessibilityState={{ checked: picked, disabled: props.choice.disabled }}
              disabled={props.choice.disabled}
              onPress={() => props.choice.onPick(option.id)}
              className={cn(
                "min-h-11 flex-row gap-3 rounded-[18px] px-3.5 py-3",
                picked ? "bg-update" : "bg-grouped-card",
              )}
            >
              <View
                className={cn(
                  "mt-1 size-3.5 rounded-full border",
                  picked ? "border-primary bg-primary" : "border-foreground-muted",
                )}
              />
              <View className="flex-1 gap-1">
                <View className="flex-row items-center gap-2">
                  <Text className="flex-1 text-[15px] font-t3-semibold text-foreground">
                    {option.label}
                  </Text>
                  {option.recommended ? <Meta>Master's pick</Meta> : null}
                </View>
                {option.detail ? <Meta>{option.detail}</Meta> : null}
              </View>
            </Pressable>
          );
        })}
      </View>
      {props.advice ? <Meta>{props.advice}</Meta> : null}
    </View>
  );
}

function ListRows(props: { readonly rows: ReadonlyArray<ViewListRow> }) {
  return (
    <View>
      {props.rows.map((row, index) => (
        <Fragment key={row.key}>
          {index > 0 ? <View className="h-px bg-border" /> : null}
          <View className="flex-row items-start gap-3 py-2.5">
            <View className="min-w-0 flex-1 gap-1">
              <Title>{row.title}</Title>
              {row.meta.length > 0 ? (
                <View className="flex-row flex-wrap gap-x-3 gap-y-1">
                  {row.meta.map((meta) => (
                    <Meta key={meta}>{meta}</Meta>
                  ))}
                </View>
              ) : null}
            </View>
            {row.status ? <Chip label={row.status} /> : null}
          </View>
        </Fragment>
      ))}
    </View>
  );
}

function TableRows(props: {
  readonly columns: ReadonlyArray<{ readonly label: string }>;
  readonly rows: ReadonlyArray<ViewTableRow>;
}) {
  return (
    <View>
      {props.rows.map((row, index) => {
        const [first, ...rest] = row.cells.map((cell) => cell.text ?? cell.link?.label ?? null);
        const facts = rest.flatMap((value, at) => {
          const label = props.columns[at + 1]?.label;
          return value === null || value === "" || label === undefined ? [] : [{ label, value }];
        });
        return (
          <Fragment key={row.key}>
            {index > 0 ? <View className="h-px bg-border" /> : null}
            <View className="gap-1.5 py-2.5">
              {first ? <Title>{first}</Title> : null}
              <Facts facts={facts} />
            </View>
          </Fragment>
        );
      })}
    </View>
  );
}

function MeterBar(props: { readonly value: number; readonly max: number }) {
  const share = props.max > 0 ? Math.min(1, Math.max(0, props.value / props.max)) : 0;
  return (
    <View className="flex-row items-center gap-3">
      <View
        accessibilityRole="progressbar"
        accessibilityValue={{ min: 0, max: props.max, now: props.value }}
        className="h-1.5 flex-1 overflow-hidden rounded-full bg-secondary"
      >
        <View className="h-full rounded-full bg-primary" style={{ width: `${share * 100}%` }} />
      </View>
      <Meta>{`${props.value}/${props.max}`}</Meta>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Images

function useAssetImage(asset: ViewGalleryAsset) {
  const environmentId = useMissionsEnvironmentId();
  const resource = useMemo<AssetResource>(
    () => ({ _tag: "attachment", attachmentId: asset.id, fileName: asset.name }),
    [asset.id, asset.name],
  );
  const url = useAssetUrl(environmentId, resource);
  return environmentId !== null && url !== null
    ? assetImageSource(environmentId, resource, url)
    : null;
}

const VERDICT_LABEL = { ok: "Looks right", change: "Change" } as const;

function Gallery(props: {
  readonly assets: ReadonlyArray<ViewGalleryAsset>;
  readonly review: ViewReviewState | undefined;
}) {
  const [open, setOpen] = useState<number | null>(null);
  if (props.assets.length === 0) return null;
  const opened = open === null ? undefined : props.assets[open];
  return (
    <>
      <View className="flex-row flex-wrap gap-2">
        {props.assets.map((asset, index) => (
          <Thumb
            key={asset.id}
            asset={asset}
            verdict={props.review ? assetMarkOf(props.review.marks, asset.id).verdict : null}
            onOpen={() => setOpen(index)}
          />
        ))}
      </View>
      {opened !== undefined && open !== null ? (
        <Viewer
          asset={opened}
          position={open}
          count={props.assets.length}
          onStep={(step) => setOpen((open + step + props.assets.length) % props.assets.length)}
          onClose={() => setOpen(null)}
          review={props.review}
        />
      ) : null}
    </>
  );
}

function Thumb(props: {
  readonly asset: ViewGalleryAsset;
  readonly verdict: "ok" | "change" | null;
  readonly onOpen: () => void;
}) {
  const source = useAssetImage(props.asset);
  return (
    <Pressable
      accessibilityRole="imagebutton"
      accessibilityLabel={props.asset.name}
      onPress={props.onOpen}
      className="basis-[48%] overflow-hidden rounded-[14px] bg-secondary"
      style={{ aspectRatio: 4 / 3 }}
    >
      {source ? (
        <Image
          source={source}
          cachePolicy="memory-disk"
          contentFit="cover"
          style={{ width: "100%", height: "100%" }}
          accessibilityIgnoresInvertColors
        />
      ) : null}
      {props.verdict ? (
        <View className="absolute bottom-1.5 left-1.5">
          <Chip
            label={VERDICT_LABEL[props.verdict]}
            tone={props.verdict === "change" ? "accent" : "plain"}
          />
        </View>
      ) : null}
    </Pressable>
  );
}

function Viewer(props: {
  readonly asset: ViewGalleryAsset;
  readonly position: number;
  readonly count: number;
  readonly onStep: (step: number) => void;
  readonly onClose: () => void;
  readonly review: ViewReviewState | undefined;
}) {
  const insets = useSafeAreaInsets();
  const source = useAssetImage(props.asset);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const { review, asset } = props;
  const mark = review ? assetMarkOf(review.marks, asset.id) : null;
  const aspect =
    asset.width !== null && asset.height !== null && asset.height > 0
      ? asset.width / asset.height
      : 4 / 3;
  const canMark = review !== undefined && !review.disabled;
  const image: ReactNode = (
    <View
      onLayout={(event) => setSize(event.nativeEvent.layout)}
      className="w-full overflow-hidden rounded-[14px] bg-secondary"
      style={{ aspectRatio: aspect }}
    >
      {source ? (
        <Image
          source={source}
          cachePolicy="memory-disk"
          contentFit="contain"
          style={{ width: "100%", height: "100%" }}
          accessibilityIgnoresInvertColors
        />
      ) : null}
      {mark?.pin ? (
        <View
          pointerEvents="none"
          className="absolute size-4 rounded-full border-2 border-screen bg-primary"
          style={{
            left: mark.pin.x * size.width - 8,
            top: mark.pin.y * size.height - 8,
          }}
        />
      ) : null}
    </View>
  );
  return (
    <Modal visible animationType="fade" onRequestClose={props.onClose}>
      <View
        className="flex-1 bg-screen"
        style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}
      >
        <View className="min-h-12 flex-row items-center gap-3 px-4">
          <Title className="flex-1">{asset.name}</Title>
          {props.count > 1 ? <Meta>{`${props.position + 1}/${props.count}`}</Meta> : null}
          <LinkButton label="Done" onPress={props.onClose} />
        </View>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerClassName="gap-4 px-4 pb-6">
          {canMark ? (
            <Pressable
              accessibilityLabel="Pin a spot"
              onPress={(event) => {
                if (size.width === 0 || size.height === 0) return;
                review.onMark(asset.id, {
                  pin: {
                    x: event.nativeEvent.locationX / size.width,
                    y: event.nativeEvent.locationY / size.height,
                  },
                  verdict: mark?.verdict ?? "change",
                });
              }}
            >
              {image}
            </Pressable>
          ) : (
            image
          )}
          {props.count > 1 ? (
            <View className="flex-row justify-between">
              <LinkButton label="Previous" onPress={() => props.onStep(-1)} />
              <LinkButton label="Next" onPress={() => props.onStep(1)} />
            </View>
          ) : null}
          {review ? (
            <View className="gap-3">
              <View className="flex-row flex-wrap gap-2">
                {(["ok", "change"] as const).map((verdict) => (
                  <ActionButton
                    key={verdict}
                    label={VERDICT_LABEL[verdict]}
                    primary={mark?.verdict === verdict}
                    disabled={!canMark}
                    onPress={() =>
                      review.onMark(asset.id, {
                        verdict: mark?.verdict === verdict ? null : verdict,
                      })
                    }
                  />
                ))}
                {mark?.pin ? (
                  <ActionButton
                    label="Clear pin"
                    disabled={!canMark}
                    onPress={() => review.onMark(asset.id, { pin: null })}
                  />
                ) : null}
              </View>
              <TextField
                value={mark?.note ?? ""}
                onChangeText={(note) => review.onMark(asset.id, { note })}
                placeholder="Note on this image"
                editable={canMark}
              />
            </View>
          ) : null}
        </ScrollView>
      </View>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Sections and templated cards

/** One of the master's sections under its own title, hidden while it has nothing. */
export function CustomSection(props: {
  readonly snapshot: MissionViewsSnapshot;
  readonly entry: ViewSectionEntry;
  readonly nowMs: number;
}) {
  const { snapshot, nowMs } = props;
  const { section, title } = props.entry;
  const shown = useMemo(() => {
    if (section === null) return null;
    const data = viewSectionData(snapshot, section.id);
    const view = viewSection(section, {
      nowMs,
      data,
      source: viewSectionSource(snapshot, section),
      assets: snapshot.assets ?? [],
    });
    const rows = data?.rows.length ?? 0;
    const more = data !== null && data.total > rows ? data.total : null;
    return view.empty ? null : { view, more };
  }, [snapshot, section, nowMs]);
  if (shown === null) return null;
  return (
    <>
      <SectionHead
        className="pt-3"
        title={title}
        trailing={shown.more === null ? null : <Meta>{shown.more}</Meta>}
      />
      <Group>
        <View className="gap-3 px-3.5 py-3">
          {shown.view.notice ? <Meta>{shown.view.notice}</Meta> : null}
          <ViewBlocks blocks={shown.view.blocks} />
        </View>
      </Group>
    </>
  );
}

export interface TemplatedItem {
  readonly kicker: string | null;
  /** The template's body; an ask's options pick through `choice`. */
  readonly render: (choice?: ViewChoiceState) => ReactNode;
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

/**
 * The template body for a record that picked a template other than the
 * built-in one: a stock release or UI review, or one the master made. Null
 * keeps the reader's own layout.
 */
export function useTemplatedItem(
  missionId: MissionId | null,
  backed: ViewBackedRecord,
  nowMs: number,
): TemplatedItem | null {
  const snapshot = useMissionViews(missionId)?.snapshot;
  const { marks, mark, clear } = useReviewMarks(`${backed.kind}:${backed.record.id}`);
  const view = useMemo(
    () =>
      snapshot === undefined
        ? null
        : viewCard(backed, snapshot.templates, {
            nowMs,
            assets: snapshot.assets ?? [],
          }),
    [backed, snapshot, nowMs],
  );
  if (view === null || view.source === "builtin") return null;
  const assets = galleryAssets(view.blocks);
  return {
    kicker: view.kicker,
    render: (choice) => (
      <ViewBlocks
        blocks={view.blocks}
        choice={choice}
        review={{ marks, onMark: mark, disabled: choice?.disabled ?? false }}
      />
    ),
    attach: (input) => withAssetFeedback(input, marks, assets),
    clear,
  };
}
