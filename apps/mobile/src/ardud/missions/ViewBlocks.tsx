import type {
  AnswerAskInput,
  AssetResource,
  MissionId,
  ViewBackedRecord,
} from "@t3tools/contracts";
import {
  assetMarkOf,
  refLabel,
  resolveViewSnapshotLayout,
  viewCard,
  viewSection,
  viewSectionData,
  withAssetFeedback,
  type AssetMark,
  type AssetReview,
  type ViewBlock,
  type ViewChoiceOption,
  type ViewGalleryAsset,
  type ViewListRow,
  type ViewTableRow,
} from "@t3tools/client-runtime/ardud/missions";
import { Image } from "expo-image";
import { Fragment, useMemo, useState, type ReactNode } from "react";
import { Modal, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { assetImageSource } from "../../lib/assetImageSource";
import { cn } from "../../lib/cn";
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
import { useMissionViews } from "./viewsStore";

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
  }
}

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

/** The master's sections, in layout order, each hidden while it has nothing. */
export function CustomSections(props: { readonly missionId: MissionId; readonly nowMs: number }) {
  const views = useMissionViews(props.missionId);
  const sections = useMemo(() => {
    if (!views) return [];
    const { snapshot } = views;
    return resolveViewSnapshotLayout(snapshot).stacked.flatMap((entry) => {
      if (entry.kind !== "custom" || entry.section === null) return [];
      const data = viewSectionData(snapshot, entry.section.id);
      const view = viewSection(entry.section, {
        nowMs: props.nowMs,
        data,
        assets: snapshot.assets ?? [],
      });
      const shown = data?.rows.length ?? 0;
      const more = data !== null && data.total > shown ? data.total : null;
      return view.empty ? [] : [{ key: entry.key, title: entry.title, view, more }];
    });
  }, [views, props.nowMs]);
  return (
    <>
      {sections.map((section) => (
        <Fragment key={section.key}>
          <SectionHead
            className="pt-3"
            title={section.title}
            trailing={section.more === null ? null : <Meta>{section.more}</Meta>}
          />
          <Group>
            <View className="gap-3 px-3.5 py-3">
              <ViewBlocks blocks={section.view.blocks} />
            </View>
          </Group>
        </Fragment>
      ))}
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
