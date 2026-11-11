import type { StaticScreenProps } from "@react-navigation/native";
import {
  askAge,
  askBatchTitle,
  askKindLabel,
  askOutcome,
  needsYouFiltered,
  needsYouKinds,
  needsYouMarkOf,
  needsYouSections,
  sameDay,
  shortWhen,
  type NeedsYouFilter,
  type NeedsYouItem,
  type NeedsYouMark,
} from "@t3tools/client-runtime/ardud/kanban";
import { useEffect, useRef, useState } from "react";
import { FlatList, Pressable, RefreshControl, View } from "react-native";
import type { TextInputInstance } from "react-native";

import type { AppBarMenu } from "../../../components/ui/AppBar.types";
import { SymbolView } from "../../../components/ui/AppSymbol";
import { AppText as Text } from "../../../components/ui/AppText";
import { SearchField } from "../../../components/ui/SearchField";
import { cn } from "../../../lib/cn";
import { LoadingLine } from "../../common/FeedError";
import { useNowMs } from "../../common/hooks";
import { ChoiceRow } from "../../common/parts";
import { useAsk, useAsks, useOwnerStanding, useWatchAsks } from "./askStore";
import {
  MARK_LABELS,
  askRowMedia,
  boardChips,
  queueRows,
  type NeedsYouQueueParams,
  type QueueRow,
} from "./logic";
import { useNeedsYouNav } from "./nav";
import { Screen, useBottomInset } from "./Screen";
import { AskToastBar, BarButton, OfflineBand, OwnerBand, Pill } from "./ui";
import { useQueue } from "./useQueue";

const ALL_BOARDS = "";

/** Every ask that waits on him, across boards: the list he works down. */
export function NeedsYouRouteScreen({ route }: StaticScreenProps<NeedsYouQueueParams | undefined>) {
  const asks = useAsks();
  const nav = useNeedsYouNav();
  const nowMs = useNowMs();
  const bottomInset = useBottomInset();
  useWatchAsks(true);
  useOwnerStanding();
  const queue = useQueue(nowMs);
  const [boardId, setBoardId] = useState<string | null>(route.params?.board?.trim() || null);
  const [kind, setKind] = useState<string | null>(null);
  const [holds, setHolds] = useState(false);
  const [query, setQuery] = useState("");
  const [openBatches, setOpenBatches] = useState<ReadonlySet<string>>(new Set());
  const [refreshing, setRefreshing] = useState(false);
  const searchRef = useRef<TextInputInstance | null>(null);
  // A link in the web page's form names the ask to open on top of the queue.
  const linked = route.params?.ask?.trim() || null;
  const { openAsk } = nav;
  useEffect(() => {
    if (linked !== null) openAsk(linked);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Once per link, not each time the navigator hands out a new object.
  }, [linked]);

  const filter: NeedsYouFilter = { boardId, kind, holds, query };
  const filtered = needsYouFiltered(filter);
  const sections = needsYouSections(
    queue.needsYou,
    filter,
    queue.boardNames,
    new Map(Object.entries(queue.marks)),
    queue.hidden,
  );
  const rows = queueRows(sections, openBatches);
  // An ask whose answer is on its way no longer counts.
  const owed = queue.needsYou.items.filter((item) => !queue.hidden.has(item.key));
  const chips = boardChips(queue.open, owed);
  const kinds = needsYouKinds(queue.needsYou);
  const waiting = queue.needsYou.counts.agent + queue.needsYou.counts.evaluator;
  const oneBoard = boardId !== null || queue.boardNames.size <= 1;
  const clearFilter = () => {
    setBoardId(null);
    setKind(null);
    setHolds(false);
    setQuery("");
  };
  const refresh = () => {
    setRefreshing(true);
    void asks.refreshAsks().then(
      () => setRefreshing(false),
      () => setRefreshing(false),
    );
  };

  const menus: ReadonlyArray<AppBarMenu> = [
    {
      title: "Filter",
      icon:
        kind !== null || holds
          ? "line.3.horizontal.decrease.circle.fill"
          : "line.3.horizontal.decrease.circle",
      items: [
        {
          id: "holds",
          title: "Holds a card",
          selected: holds,
          onPress: () => setHolds(!holds),
        },
        {
          id: "kinds",
          inline: true,
          items: [
            {
              id: "kind-all",
              title: "All kinds",
              selected: kind === null,
              onPress: () => setKind(null),
            },
            ...kinds.map((entry) => ({
              id: `kind-${entry.kind}`,
              title: `${askKindLabel(entry.kind)} · ${entry.count}`,
              selected: kind === entry.kind,
              onPress: () => setKind(kind === entry.kind ? null : entry.kind),
            })),
          ],
        },
      ],
    },
    {
      title: "More",
      icon: "ellipsis.circle",
      items: [
        { id: "history", title: "History", icon: "clock", onPress: nav.openHistory },
        {
          id: "reference",
          title: "What an ask can be",
          icon: "info.circle",
          onPress: nav.openReference,
        },
      ],
    },
  ];

  const subtitle = queue.read
    ? [
        `${owed.length} to answer`,
        waiting > 0 ? `${waiting} waiting on agents` : null,
        queue.needsYou.counts.snoozed > 0 ? `${queue.needsYou.counts.snoozed} snoozed` : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : undefined;

  const header = (
    <View className="gap-3 pb-1">
      <OwnerBand />
      <OfflineBand />
      {queue.open.length > 0 ? (
        <SearchField
          inputRef={searchRef}
          autoFocus={false}
          accessibilityLabel="Search asks"
          clearAccessibilityLabel="Clear search"
          placeholder="Search asks"
          value={query}
          onChangeText={setQuery}
        />
      ) : null}
      {chips.length > 1 ? (
        <ChoiceRow
          accessibilityLabel="Board"
          options={[
            { value: ALL_BOARDS, label: "All", count: owed.length },
            ...chips.map((chip) => ({ value: chip.id, label: chip.name, count: chip.count })),
          ]}
          selected={boardId ?? ALL_BOARDS}
          onSelect={(value) => setBoardId(value === ALL_BOARDS ? null : value)}
        />
      ) : null}
    </View>
  );

  const empty = !queue.read ? (
    queue.status === "error" ? (
      <Empty
        alert
        title="Couldn't load asks"
        detail={queue.error ?? undefined}
        action={{ label: "Retry", onPress: () => void asks.refreshAsks() }}
      />
    ) : (
      <LoadingLine />
    )
  ) : filtered ? (
    <Empty title="No asks match" action={{ label: "Clear filters", onPress: clearFilter }} />
  ) : (
    <AllClear
      nowMs={nowMs}
      waiting={waiting}
      snoozed={queue.needsYou.counts.snoozed}
      onHistory={nav.openHistory}
    />
  );

  return (
    <Screen title="Needs you" subtitle={subtitle} onBack={nav.back} menus={menus}>
      <FlatList
        data={rows}
        keyExtractor={(row) => row.key}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={{
          paddingHorizontal: 16,
          paddingTop: 12,
          paddingBottom: bottomInset + 84,
        }}
        ListHeaderComponent={header}
        ListEmptyComponent={empty}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
        renderItem={({ item: row, index }) =>
          row._tag === "section" ? (
            <SectionRow label={row.label} count={row.count} />
          ) : row._tag === "ask" ? (
            <AskRow
              row={row}
              first={rows[index - 1]?._tag === "section"}
              board={oneBoard ? "" : (queue.boardNames.get(row.item.boardId) ?? "")}
              mark={needsYouMarkOf(row.item, queue.marks)}
              nowMs={nowMs}
              onOpen={() => nav.openAsk(row.key)}
            />
          ) : (
            <BatchRow
              row={row}
              first={rows[index - 1]?._tag === "section"}
              board={oneBoard ? "" : (queue.boardNames.get(row.entry.boardId) ?? "")}
              onOpen={() => nav.openBatch(row.entry.boardId, row.entry.batchKey)}
              onToggle={() =>
                setOpenBatches((current) => {
                  const next = new Set(current);
                  if (!next.delete(row.key)) next.add(row.key);
                  return next;
                })
              }
            />
          )
        }
      />
      <AskToastBar
        bottom={bottomInset + 8}
        onUndo={(key) => {
          if (key === null) return;
          const batch = /^batch:([^:]+):(.*)$/.exec(key);
          if (batch) nav.openBatch(batch[1]!, batch[2]!);
          else nav.openAsk(key);
        }}
        onView={nav.openAsk}
      />
    </Screen>
  );
}

function SectionRow(props: { readonly label: string; readonly count: number }) {
  return (
    <View
      accessible
      accessibilityRole="header"
      accessibilityLabel={`${props.label}, ${props.count}`}
      className="flex-row items-baseline justify-between gap-3 px-1 pb-1.5 pt-5"
    >
      <Text className="text-sm font-t3-semibold text-foreground">{props.label}</Text>
      <Text className="text-sm tabular-nums text-foreground-muted">{props.count}</Text>
    </View>
  );
}

const rowShape = (nested: boolean, first: boolean, last: boolean) =>
  cn(
    "overflow-hidden bg-grouped-card",
    nested && "pl-5",
    first && "rounded-t-[22px]",
    last ? "rounded-b-[22px]" : "mb-px",
  );

/** One ask in the list: what kind it is and where, how long it has waited, and its title. */
function AskRow(props: {
  readonly row: Extract<QueueRow, { _tag: "ask" }>;
  readonly first: boolean;
  readonly board: string;
  readonly mark: NeedsYouMark | undefined;
  readonly nowMs: number;
  readonly onOpen: () => void;
}) {
  const { item } = props.row;
  const media = askRowMedia(item.ask.blocks);
  const when =
    item.snoozed && item.ask.snoozedUntil
      ? `until ${shortWhen(item.ask.snoozedUntil, props.nowMs)}`
      : askAge(item.ageMs);
  const where = `${askKindLabel(item.kind)} · ${props.board ? `${props.board} ` : ""}#${item.cardNumber}`;
  const title = item.ask.title ?? item.cardTitle;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[
        title,
        where,
        item.blocking && !item.notice ? "holds its card" : null,
        props.mark ? MARK_LABELS[props.mark] : null,
        media.pictures > 0
          ? `${media.pictures} ${media.pictures === 1 ? "picture" : "pictures"}`
          : null,
        media.video ? "has video" : null,
        when,
      ]
        .filter(Boolean)
        .join(", ")}
      onPress={props.onOpen}
      className={cn(
        "min-h-16 justify-center gap-1 px-3.5 py-3 active:bg-card-alt",
        rowShape(props.row.nested, props.first, props.row.last),
      )}
    >
      <View className="flex-row items-center gap-1.5">
        <RowDot item={item} />
        <Text numberOfLines={1} className="min-w-0 flex-1 text-2xs text-foreground-muted">
          {where}
        </Text>
        {props.mark ? (
          <Pill
            label={MARK_LABELS[props.mark]}
            tone={props.mark === "failed" ? "negative" : "accent"}
          />
        ) : null}
        {media.pictures > 0 ? (
          <View className="flex-row items-center gap-0.5">
            <SymbolView
              name="photo"
              size={11}
              tintColorClassName="accent-icon-muted"
              type="monochrome"
            />
            <Text className="text-2xs tabular-nums text-foreground-muted">{media.pictures}</Text>
          </View>
        ) : null}
        {media.video ? (
          <SymbolView
            name="play"
            size={10}
            tintColorClassName="accent-icon-muted"
            type="monochrome"
          />
        ) : null}
        <Text className="text-2xs tabular-nums text-foreground-muted">{when}</Text>
      </View>
      <Text
        numberOfLines={2}
        className={cn(
          "text-base text-foreground",
          props.mark ? "font-t3-semibold" : "font-t3-medium",
        )}
      >
        {title}
      </Text>
    </Pressable>
  );
}

/** Amber when the ask holds its card; a quiet dot otherwise. The words say it too. */
function RowDot(props: { readonly item: Pick<NeedsYouItem, "blocking" | "notice"> }) {
  return (
    <View
      className={cn(
        "size-1.5 rounded-full",
        props.item.blocking && !props.item.notice ? "bg-warning-foreground" : "bg-foreground-muted",
      )}
    />
  );
}

/** Asks that share a batch, folded as one row: open it to answer them together. */
function BatchRow(props: {
  readonly row: Extract<QueueRow, { _tag: "batch" }>;
  readonly first: boolean;
  readonly board: string;
  readonly onOpen: () => void;
  readonly onToggle: () => void;
}) {
  const { entry, open } = props.row;
  const first = entry.items[0]!;
  const count = entry.items.length;
  const oldest = Math.max(...entry.items.map((item) => item.ageMs));
  const title = askBatchTitle(entry.items.map((item) => item.kind));
  const where = props.board || askKindLabel(first.kind);
  return (
    <View className={rowShape(false, props.first, props.row.last)}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${title}, ${where}, ${count} asks, answer them together, ${askAge(oldest)}`}
        onPress={props.onOpen}
        className="min-h-16 justify-center gap-1 px-3.5 pb-1 pt-3 active:bg-card-alt"
      >
        <View className="flex-row items-center gap-1.5">
          <RowDot item={{ blocking: entry.items.some((item) => item.blocking), notice: false }} />
          <Text numberOfLines={1} className="min-w-0 flex-1 text-2xs text-foreground-muted">
            {where}
          </Text>
          <Text className="text-2xs tabular-nums text-foreground-muted">{askAge(oldest)}</Text>
        </View>
        <Text numberOfLines={2} className="text-base font-t3-medium text-foreground">
          {title}
        </Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${open ? "Hide" : "Show"} the ${count} asks`}
        accessibilityState={{ expanded: open }}
        onPress={props.onToggle}
        className="min-h-11 justify-center self-start px-3.5"
      >
        <Text className="text-sm font-t3-semibold text-primary-text">
          {open ? "Hide" : "Show"} the {count}
        </Text>
      </Pressable>
    </View>
  );
}

function Empty(props: {
  readonly title: string;
  readonly detail?: string | undefined;
  readonly action?: { readonly label: string; readonly onPress: () => void };
  /** A failure: read out when it appears. */
  readonly alert?: boolean;
}) {
  return (
    <View
      accessibilityRole={props.alert ? "alert" : undefined}
      className="items-start gap-2 px-1 pt-8"
    >
      <Text accessibilityRole="header" className="text-lg font-t3-semibold text-foreground">
        {props.title}
      </Text>
      {props.detail ? <Text className="text-sm text-foreground-muted">{props.detail}</Text> : null}
      {props.action ? (
        <View className="pt-1">
          <BarButton label={props.action.label} onPress={props.action.onPress} />
        </View>
      ) : null}
    </View>
  );
}

/** The queue is clear: what today came to, and the way to what he answered. */
function AllClear(props: {
  readonly nowMs: number;
  readonly waiting: number;
  readonly snoozed: number;
  readonly onHistory: () => void;
}) {
  const asks = useAsks();
  const closed = useAsk((state) => state.closed);
  useEffect(() => {
    void asks.loadClosedAsks();
  }, [asks]);
  const answered =
    closed === null
      ? null
      : closed.filter(
          (entry) =>
            askOutcome(entry.ask) !== null &&
            entry.ask.answer !== undefined &&
            sameDay(entry.ask.answer.at, props.nowMs),
        ).length;
  const facts: ReadonlyArray<readonly [string, number | null]> = [
    ["Answered today", answered],
    ["Waiting on agents", props.waiting],
    ["Snoozed", props.snoozed],
  ];
  return (
    <View className="items-start gap-4 px-1 pt-10">
      <SymbolView
        name="checkmark.circle"
        size={36}
        tintColorClassName="accent-primary-text"
        type="monochrome"
      />
      <View className="gap-1">
        <Text accessibilityRole="header" className="text-xl font-t3-semibold text-foreground">
          Nothing needs you
        </Text>
        <Text className="text-sm text-foreground-muted">
          Agents carry on with what you answered. New asks show up here.
        </Text>
      </View>
      <View className="flex-row flex-wrap gap-x-7 gap-y-3">
        {facts.map(([name, value]) => (
          <View key={name} accessible accessibilityLabel={`${name}: ${value ?? "not read yet"}`}>
            <Text className="text-2xs text-foreground-muted">{name}</Text>
            <Text className="text-xl font-t3-semibold tabular-nums text-foreground">
              {value ?? "–"}
            </Text>
          </View>
        ))}
      </View>
      <BarButton label="See what you answered" onPress={props.onHistory} />
    </View>
  );
}
