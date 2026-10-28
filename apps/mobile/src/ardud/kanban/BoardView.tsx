import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import {
  activeFilterCount,
  activeGoals,
  boardFilter,
  clearFilters,
  filterFacets,
  sanitizeBoardFilterPrefs,
  setupBanner,
  stageBoard,
  toggleFilterValue,
  type BoardFilterPrefs,
  type CardView,
  type GoalSummary,
  type KanbanBoardState,
  type StageBoard,
  type StageColumn,
} from "@t3tools/client-runtime/ardud/kanban";
import { Fragment, useRef, useState } from "react";
import { Pressable, ScrollView, type TextInputInstance, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Menu } from "../../components/ui/Menu";
import { SearchField } from "../../components/ui/SearchField";
import { cn } from "../../lib/cn";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { ChoiceRow, LinkButton } from "../common/parts";
import {
  BOARD_PAD,
  type BoardLayout,
  type BoardTab,
  boardTabs,
  COLUMN_GAP,
  defaultBoardTab,
  filterActionId,
  parseFilterAction,
  type FilterAction,
} from "./logic";
import { CardTile, GoalBar, ShippedRow, StageHead, UnderlineTabs } from "./parts";

// Needs Owner cards shown above the tabs before "All N" opens the rest.
const OWNER_PREVIEW = 2;

/**
 * The board: Needs Owner first, then the stages. A phone shows one stage at a
 * time behind tabs; a wide screen shows them side by side with Needs Owner
 * pinned on its warm band at the right.
 */
export function BoardView(props: {
  readonly state: KanbanBoardState;
  readonly layout: BoardLayout;
  readonly nowMs: number;
  readonly selectedCardId: string | null;
  readonly bottomInset: number;
  readonly onOpenCard: (cardId: string) => void;
  readonly onOpenGoal: (goalId: string) => void;
  /** Opens the board's Setup discussion; shown only while setup runs. */
  readonly onViewSetup: (discussionId: string) => void;
  readonly onEndSetup: () => void;
}) {
  const goals = activeGoals(props.state);
  const boardId = props.state.board.id;
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const storedFilters = AsyncResult.isSuccess(preferencesResult)
    ? preferencesResult.value.kanbanBoardFilters
    : undefined;
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const prefs = sanitizeBoardFilterPrefs(storedFilters?.[boardId]);
  const setPrefs = (next: BoardFilterPrefs) =>
    savePreferences({
      transform: (current) => ({
        kanbanBoardFilters: { ...current.kanbanBoardFilters, [boardId]: next },
      }),
    });
  const setup = setupBanner(props.state.board);
  const [query, setQuery] = useState("");
  const searchRef = useRef<TextInputInstance | null>(null);
  const filter = boardFilter(props.state, prefs, query.trim());
  const pickedGoalIds = filter.goalIds ?? [];
  const board = stageBoard(props.state, props.nowMs, filter);
  const picked = activeFilterCount(prefs);
  const menuActions = filterMenuActions(props.state, prefs);
  const onFilterAction = (id: string) => {
    const action = parseFilterAction(id);
    if (action === null) return;
    setPrefs(applyFilterAction(prefs, action));
  };
  const filterRow = (
    <View className="gap-2.5">
      {setup ? (
        <View className="flex-row items-center gap-2 rounded-2xl bg-grouped-card px-4 py-3">
          <LinkButton
            label={setup.label}
            accessibilityLabel={setup.label}
            onPress={() => props.onViewSetup(setup.discussionId)}
          />
          <LinkButton label="End setup" onPress={props.onEndSetup} />
        </View>
      ) : null}
      <View className="flex-row items-center gap-2">
        <SearchField
          inputRef={searchRef}
          autoFocus={false}
          accessibilityLabel="Search cards"
          clearAccessibilityLabel="Clear search"
          placeholder="Search cards"
          value={query}
          onChangeText={setQuery}
        />
        <Menu
          accessibilityLabel="Filter cards"
          shouldOpenOnLongPress={false}
          title="Filter"
          actions={menuActions}
          onPressAction={({ nativeEvent }) => onFilterAction(nativeEvent.event)}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={picked > 0 ? `Filter, ${picked} picked` : "Filter"}
            className={cn(
              "min-h-11 justify-center rounded-full px-4",
              picked > 0 ? "bg-foreground" : "bg-grouped-card",
            )}
          >
            <Text
              className={cn(
                "text-[13px] font-t3-semibold",
                picked > 0 ? "text-screen" : "text-foreground",
              )}
            >
              {picked > 0 ? `Filter · ${picked}` : "Filter"}
            </Text>
          </Pressable>
        </Menu>
      </View>
      <ChoiceRow
        accessibilityLabel="Settled cards"
        options={[
          { value: "hide", label: "Hide settled" },
          { value: "include", label: "Show settled" },
          { value: "only", label: "Only settled" },
        ]}
        selected={prefs.settled}
        onSelect={(settled) => setPrefs({ ...prefs, settled })}
      />
    </View>
  );

  if (props.layout.kind === "tabs") {
    return (
      <TabsBoard
        board={board}
        filterRow={filterRow}
        hideGoal={pickedGoalIds.length > 0}
        selectedCardId={props.selectedCardId}
        bottomInset={props.bottomInset}
        onOpenCard={props.onOpenCard}
      />
    );
  }
  return (
    <ColumnsBoard
      board={board}
      goals={
        pickedGoalIds.length > 0
          ? goals.filter((entry) => pickedGoalIds.includes(entry.goal.id))
          : goals
      }
      layout={props.layout}
      filterRow={filterRow}
      hideGoal={pickedGoalIds.length > 0}
      selectedCardId={props.selectedCardId}
      bottomInset={props.bottomInset}
      onOpenCard={props.onOpenCard}
      onOpenGoal={props.onOpenGoal}
    />
  );
}

function TabsBoard(props: {
  readonly board: StageBoard;
  readonly filterRow: React.ReactNode;
  readonly hideGoal: boolean;
  readonly selectedCardId: string | null;
  readonly bottomInset: number;
  readonly onOpenCard: (cardId: string) => void;
}) {
  const { board } = props;
  const tabs = boardTabs(board);
  // Chosen once on open; a stage emptying later doesn't move the owner off it.
  const [tab, setTab] = useState<BoardTab>(() => defaultBoardTab(tabs));
  const [allOwner, setAllOwner] = useState(false);
  const owner = board.owner.cards;
  const shownOwner = allOwner ? owner : owner.slice(0, OWNER_PREVIEW);

  return (
    <ScrollView
      className="flex-1"
      contentContainerStyle={{ paddingBottom: props.bottomInset + 16 }}
      // The filter and Needs Owner scroll away; the stage tabs stay.
      stickyHeaderIndices={[1]}
    >
      <View className="gap-2.5 px-4 pb-3 pt-2">
        {props.filterRow}
        {owner.length > 0 ? (
          <View className="gap-2">
            <StageHead label={board.owner.label} count={owner.length} owner />
            {shownOwner.map((view) => (
              <CardTile
                key={view.id}
                view={view}
                tone="owner"
                hideGoal={props.hideGoal}
                selected={view.id === props.selectedCardId}
                onOpen={props.onOpenCard}
              />
            ))}
            {owner.length > OWNER_PREVIEW ? (
              <View className="items-start px-1">
                <LinkButton
                  label={allOwner ? "Fewer" : `All ${owner.length}`}
                  expanded={allOwner}
                  onPress={() => setAllOwner(!allOwner)}
                />
              </View>
            ) : null}
          </View>
        ) : null}
      </View>
      <UnderlineTabs accessibilityLabel="Stage" tabs={tabs} selected={tab} onSelect={setTab} />
      <View className="gap-2 px-4 pt-3">
        {tab === "shipped" ? (
          <ShippedList
            columns={board.shipped}
            selectedCardId={props.selectedCardId}
            onOpenCard={props.onOpenCard}
          />
        ) : (
          <CardList
            cards={board.active.find((column) => column.stage === tab)?.cards ?? []}
            hideGoal={props.hideGoal}
            selectedCardId={props.selectedCardId}
            onOpenCard={props.onOpenCard}
          />
        )}
      </View>
    </ScrollView>
  );
}

function CardList(props: {
  readonly cards: ReadonlyArray<CardView>;
  readonly hideGoal: boolean;
  readonly selectedCardId: string | null;
  readonly onOpenCard: (cardId: string) => void;
}) {
  if (props.cards.length === 0) return <Empty />;
  return props.cards.map((view) => (
    <CardTile
      key={view.id}
      view={view}
      hideGoal={props.hideGoal}
      selected={view.id === props.selectedCardId}
      onOpen={props.onOpenCard}
    />
  ));
}

function ShippedList(props: {
  readonly columns: ReadonlyArray<StageColumn>;
  readonly selectedCardId: string | null;
  readonly onOpenCard: (cardId: string) => void;
}) {
  const shown = props.columns.filter((column) => column.cards.length > 0);
  if (shown.length === 0) return <Empty />;
  return shown.map((column, index) => (
    <Fragment key={column.stage}>
      <StageHead
        label={column.label}
        count={column.cards.length}
        className={cn(index > 0 && "mt-2")}
      />
      {column.cards.map((view) => (
        <ShippedRow
          key={view.id}
          view={view}
          selected={view.id === props.selectedCardId}
          onOpen={props.onOpenCard}
        />
      ))}
    </Fragment>
  ));
}

function Empty() {
  return <Text className="px-1 py-3 text-[13px] text-foreground-muted">No cards</Text>;
}

function ColumnsBoard(props: {
  readonly board: StageBoard;
  readonly goals: ReadonlyArray<GoalSummary>;
  readonly layout: Extract<BoardLayout, { kind: "columns" }>;
  readonly filterRow: React.ReactNode;
  readonly hideGoal: boolean;
  readonly selectedCardId: string | null;
  readonly bottomInset: number;
  readonly onOpenCard: (cardId: string) => void;
  readonly onOpenGoal: (goalId: string) => void;
}) {
  const { board, layout } = props;
  const columnStyle = { width: layout.column };
  const stages = (
    <View className="flex-1 flex-row" style={{ gap: COLUMN_GAP }}>
      {board.active.map((column) => (
        <View key={column.stage} style={columnStyle}>
          <StageHead label={column.label} count={column.cards.length} />
          <ColumnScroll bottomInset={props.bottomInset}>
            <CardList
              cards={column.cards}
              hideGoal={props.hideGoal}
              selectedCardId={props.selectedCardId}
              onOpenCard={props.onOpenCard}
            />
          </ColumnScroll>
        </View>
      ))}
      <View style={columnStyle}>
        <ColumnScroll bottomInset={props.bottomInset}>
          {board.shipped.map((column) => (
            <View key={column.stage} className="gap-1">
              <StageHead label={column.label} count={column.cards.length} />
              {column.cards.map((view) => (
                <ShippedRow
                  key={view.id}
                  view={view}
                  selected={view.id === props.selectedCardId}
                  onOpen={props.onOpenCard}
                />
              ))}
            </View>
          ))}
        </ColumnScroll>
      </View>
    </View>
  );

  return (
    <View className="flex-1 gap-3 pt-2">
      <View className="gap-2.5" style={{ paddingHorizontal: BOARD_PAD }}>
        {props.goals.length > 0 ? (
          <GoalStrip goals={props.goals} onOpenGoal={props.onOpenGoal} />
        ) : null}
        {props.filterRow}
      </View>
      <View className="flex-1 flex-row" style={{ gap: COLUMN_GAP }}>
        {layout.scrolls ? (
          <ScrollView
            horizontal
            className="flex-1"
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ paddingLeft: BOARD_PAD }}
          >
            {stages}
          </ScrollView>
        ) : (
          <View className="flex-1" style={{ paddingLeft: BOARD_PAD }}>
            {stages}
          </View>
        )}
        <View
          className="rounded-tl-[16px] bg-warning px-2.5 pt-1.5"
          style={{ width: layout.owner }}
        >
          <StageHead label={board.owner.label} count={board.owner.cards.length} owner />
          <ColumnScroll bottomInset={props.bottomInset}>
            {board.owner.cards.length === 0 ? (
              <Empty />
            ) : (
              board.owner.cards.map((view) => (
                <CardTile
                  key={view.id}
                  view={view}
                  tone="band"
                  hideGoal={props.hideGoal}
                  selected={view.id === props.selectedCardId}
                  onOpen={props.onOpenCard}
                />
              ))
            )}
          </ColumnScroll>
        </View>
      </View>
    </View>
  );
}

function ColumnScroll(props: { readonly bottomInset: number; readonly children: React.ReactNode }) {
  return (
    <ScrollView
      className="flex-1"
      showsVerticalScrollIndicator={false}
      contentContainerClassName="gap-2 pt-1"
      contentContainerStyle={{ paddingBottom: props.bottomInset + 16 }}
    >
      {props.children}
    </ScrollView>
  );
}

/** One tile per active goal: name, progress, verified of total. Opens the goal. */
function GoalStrip(props: {
  readonly goals: ReadonlyArray<GoalSummary>;
  readonly onOpenGoal: (goalId: string) => void;
}) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      className="grow-0"
      contentContainerClassName="gap-2.5"
    >
      {props.goals.map(({ goal, progress }) => (
        <Pressable
          key={goal.id}
          accessibilityRole="button"
          accessibilityLabel={`${goal.name}, ${progress.verified} of ${progress.total} verified`}
          onPress={() => props.onOpenGoal(goal.id)}
          className="w-[300px] flex-row items-center gap-3 rounded-[12px] bg-card px-3.5 py-2.5"
        >
          <Text
            numberOfLines={1}
            className="max-w-[110px] text-[15px] font-t3-medium text-foreground"
          >
            {goal.name}
          </Text>
          <GoalBar progress={progress} />
          <Text className="text-[12px] text-foreground-muted">
            {progress.verified}/{progress.total}
          </Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

/** Applies one menu pick to the saved prefs. "clear" keeps the settled choice. */
function applyFilterAction(prefs: BoardFilterPrefs, action: FilterAction): BoardFilterPrefs {
  if (action.kind === "clear") return clearFilters(prefs);
  return toggleFilterValue(prefs, action.facet, action.value);
}

/**
 * The native menu's entries: one checkable item per option in each facet, with
 * its count, then "Clear filters" when anything is picked. Ids come from
 * filterActionId so parseFilterAction reads them back.
 */
function filterMenuActions(state: KanbanBoardState, prefs: BoardFilterPrefs) {
  const actions = filterFacets(state, prefs.settled).map((view) => ({
    id: `group:${view.facet}`,
    title: view.label,
    subactions: view.options.map((option) => {
      const value = view.facet === "priorities" ? Number(option.value) : option.value;
      const checked = (prefs[view.facet] as ReadonlyArray<number | string>).includes(value);
      return {
        id: filterActionId(
          view.facet === "priorities"
            ? { kind: "toggle", facet: "priorities", value: Number(option.value) }
            : { kind: "toggle", facet: view.facet, value: option.value },
        ),
        title: `${option.label} · ${option.count}`,
        state: checked ? ("on" as const) : ("off" as const),
        attributes: { keepsMenuPresented: true },
      };
    }),
  }));
  if (activeFilterCount(prefs) > 0) {
    return [...actions, { id: filterActionId({ kind: "clear" }), title: "Clear filters" }];
  }
  return actions;
}
