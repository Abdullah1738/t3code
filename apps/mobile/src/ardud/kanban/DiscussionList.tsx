import type { MenuAction } from "@react-native-menu/menu";
import {
  type DiscussionRow,
  discussionRows,
  type KanbanBoardState,
} from "@t3tools/client-runtime/ardud/kanban";
import { clockLabel } from "@t3tools/client-runtime/ardud/common";
import { snoozeWakeLabel } from "@t3tools/client-runtime/state/thread-settled";
import { Fragment, useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, type TextInputInstance, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Menu } from "../../components/ui/Menu";
import { SearchField } from "../../components/ui/SearchField";
import { cn } from "../../lib/cn";
import { LoadingLine } from "../common/FeedError";
import { EmptyLine } from "../common/parts";
import { discussionMenu, MENU_ICONS, runDiscussionMenu } from "./discussionActions";
import { kanbanClient } from "./kanbanStore";

/**
 * Board discussions, newest first, like the thread list: open ones on top,
 * then Snoozed and Settled shelves that open on tap. Long-press a row for
 * Settle, Snooze and Rename.
 */
export function DiscussionList(props: {
  readonly state: KanbanBoardState;
  readonly nowMs: number;
  readonly bottomInset: number;
  readonly selectedId?: string | null;
  readonly onOpen: (discussionId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState({ snoozed: false, settled: false });
  const searchRef = useRef<TextInputInstance | null>(null);
  const groups = discussionRows(props.state, props.nowMs, { query });
  const total = groups.active.length + groups.snoozed.length + groups.settled.length;
  const boardId = props.state.board.id;
  useEffect(() => kanbanClient().watchPreviews(boardId), [boardId]);
  if (!props.state.discussionsLoaded && total === 0 && query === "") return <LoadingLine />;
  const searching = query.trim() !== "";
  const rowList = (rows: ReadonlyArray<DiscussionRow>) =>
    rows.map((row, index) => (
      <Fragment key={row.id}>
        {index > 0 && row.id !== props.selectedId ? <View className="mx-3 h-px bg-border" /> : null}
        <DiscussionItem
          boardId={boardId}
          row={row}
          nowMs={props.nowMs}
          selected={row.id === props.selectedId}
          onOpen={props.onOpen}
        />
      </Fragment>
    ));

  return (
    <ScrollView
      className="flex-1"
      keyboardShouldPersistTaps="handled"
      contentContainerClassName="px-3 pt-2"
      contentContainerStyle={{ paddingBottom: props.bottomInset + 16 }}
    >
      {total > 0 || searching ? (
        <View className="pb-2">
          <SearchField
            inputRef={searchRef}
            autoFocus={false}
            accessibilityLabel="Search discussions"
            clearAccessibilityLabel="Clear search"
            placeholder="Search"
            value={query}
            onChangeText={setQuery}
          />
        </View>
      ) : null}
      {total === 0 ? <EmptyLine label={searching ? "No matches" : "No discussions"} /> : null}
      {rowList(groups.active)}
      {(["snoozed", "settled"] as const).map((kind) => {
        const rows = groups[kind];
        if (rows.length === 0) return null;
        // A search shows every match without making the owner open shelves.
        const expanded = searching || open[kind];
        return (
          <View key={kind}>
            <Shelf
              label={kind === "snoozed" ? "Snoozed" : "Settled"}
              count={rows.length}
              expanded={expanded}
              tone={kind}
              onToggle={() => setOpen((current) => ({ ...current, [kind]: !current[kind] }))}
            />
            {expanded ? rowList(rows) : null}
          </View>
        );
      })}
    </ScrollView>
  );
}

function Shelf(props: {
  readonly label: string;
  readonly count: number;
  readonly expanded: boolean;
  readonly tone: "snoozed" | "settled";
  readonly onToggle: () => void;
}) {
  const snoozed = props.tone === "snoozed";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${props.label}, ${props.count}`}
      accessibilityState={{ expanded: props.expanded }}
      onPress={props.onToggle}
      className="mb-1 mt-4 min-h-11 flex-row items-center gap-2.5 px-3"
    >
      <Text
        className={cn(
          "text-xs font-t3-medium",
          snoozed ? "text-foreground-secondary" : "text-foreground-tertiary",
        )}
      >
        {props.expanded ? props.label : `${props.label} (${props.count})`}
      </Text>
      <View className={cn("h-px flex-1", snoozed ? "bg-primary/20" : "bg-border")} />
      <View style={{ transform: [{ rotate: props.expanded ? "0deg" : "-90deg" }] }}>
        <SymbolView name="chevron.down" size={10} tintColorClassName="accent-foreground-tertiary" />
      </View>
    </Pressable>
  );
}

function menuActions(row: DiscussionRow): MenuAction[] {
  return discussionMenu({
    settled: row.settledAt !== null,
    snoozed: row.snoozedUntil !== null,
    now: new Date(),
  }).map((item) => ({
    id: item.id,
    title: item.title,
    image: MENU_ICONS[item.id],
    ...("presets" in item ? { subactions: [...item.presets] } : {}),
  }));
}

function DiscussionItem(props: {
  readonly boardId: string;
  readonly row: DiscussionRow;
  readonly nowMs: number;
  readonly selected: boolean;
  readonly onOpen: (discussionId: string) => void;
}) {
  const { row } = props;
  const settled = row.settledAt !== null;
  const wake =
    row.snoozedUntil === null
      ? null
      : snoozeWakeLabel(row.snoozedUntil, { now: new Date(props.nowMs).toISOString() });
  const label = [
    row.title,
    row.unread > 0 ? `${row.unread} unread` : null,
    wake && `snoozed ${wake}`,
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <Menu
      shouldOpenOnLongPress
      title={row.title}
      actions={menuActions(row)}
      onPressAction={({ nativeEvent }) =>
        runDiscussionMenu({
          boardId: props.boardId,
          discussionId: row.id,
          title: row.title,
          choice: nativeEvent.event,
        })
      }
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityHint="Long-press for settle, snooze and rename"
        accessibilityState={{ selected: props.selected }}
        onPress={() => props.onOpen(row.id)}
        className={cn("min-h-16 gap-1 rounded-[12px] px-3 py-2.5", props.selected && "bg-card")}
      >
        <View className="flex-row items-center gap-2">
          <Text
            numberOfLines={1}
            className={cn(
              "shrink text-[15px]",
              settled ? "text-foreground-muted" : "text-foreground",
              row.unread > 0 ? "font-t3-bold" : "font-t3-medium",
            )}
          >
            {row.title}
          </Text>
          {row.unread > 0 ? <View className="size-1.5 rounded-full bg-primary" /> : null}
          <View className="flex-1" />
          {wake ? (
            <View className="flex-row items-center gap-1">
              <SymbolView name="clock" size={11} tintColorClassName="accent-foreground-muted" />
              <Text className="text-[12px] text-foreground-muted">{wake}</Text>
            </View>
          ) : row.at ? (
            <Text className="text-[12px] text-foreground-muted">
              {clockLabel(row.at, props.nowMs)}
            </Text>
          ) : null}
        </View>
        {row.preview ? (
          <Text numberOfLines={1} className="text-[13px] text-foreground-muted">
            {row.preview}
          </Text>
        ) : null}
      </Pressable>
    </Menu>
  );
}
