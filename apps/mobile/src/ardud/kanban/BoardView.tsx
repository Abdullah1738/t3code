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
  type SetupBannerView,
  type GoalSummary,
  type KanbanBoardState,
  type StageBoard,
  type StageColumn,
} from "@t3tools/client-runtime/ardud/kanban";
import type { KanbanThreadRow } from "@t3tools/contracts";
import { ageView } from "@t3tools/client-runtime/ardud/common";
import { Fragment, useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, type TextInputInstance, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Menu } from "../../components/ui/Menu";
import { SearchField } from "../../components/ui/SearchField";
import { cn } from "../../lib/cn";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { confirmAction } from "../common/hooks";
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
import { useKanbanBoardThreads } from "./kanbanStore";
import { publishBoardFilter } from "./boardFilterStore";
import { CardTile, GoalBar, ShippedRow, StageHead, UnderlineTabs } from "./parts";

// Needs Owner cards shown above the tabs before "All N" opens the rest.
const OWNER_PREVIEW = 2;

/**
 * Shown on every board view while the board's first setup runs. The main action
 * only opens the Setup discussion; ending setup is behind the actions menu and a
 * confirmation, because it releases the board-wide hold.
 */
export function SetupStrip(props: {
  readonly setup: SetupBannerView;
  readonly onViewSetup: (discussionId: string) => void;
  readonly onEndSetup: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <View className="flex-row items-center gap-2 rounded-2xl bg-grouped-card px-4 py-3">
      <LinkButton
        label={props.setup.label}
        accessibilityLabel={props.setup.label}
        onPress={() => props.onViewSetup(props.setup.discussionId)}
      />
      <LinkButton
        label="Setup actions"
        accessibilityLabel="Setup actions"
        expanded={menuOpen}
        onPress={() => setMenuOpen((open) => !open)}
      />
      {menuOpen ? (
        <LinkButton
          label="End setup"
          accessibilityLabel="End setup"
          onPress={() => {
            setMenuOpen(false);
            confirmAction({
              title: "End setup?",
              message:
                "Card work and review resume on this board. The setup evaluator's remaining work stops being held.",
              confirmLabel: "End setup",
              destructive: true,
              onConfirm: props.onEndSetup,
            });
          }}
        />
      ) : null}
    </View>
  );
}

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
  readonly onOpenThread: (threadId: string) => void;
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
  const [mode, setMode] = useState<BoardMode>("stages");
  const searchRef = useRef<TextInputInstance | null>(null);
  const filter = boardFilter(props.state, prefs, query.trim());
  // Card screens step through the same cards the board shows.
  useEffect(() => publishBoardFilter(boardId, filter), [boardId, filter]);
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
        <SetupStrip
          setup={setup}
          onViewSetup={props.onViewSetup}
          onEndSetup={props.onEndSetup}
        />
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

  // Threads is one view per layout: the stage tabs (phone) or columns (wide)
  // give way to it, so iPad widths reach it too.
  if (props.layout.kind === "tabs") {
    return (
      <TabsBoard
        board={board}
        state={props.state}
        nowMs={props.nowMs}
        mode={mode}
        onSelectMode={setMode}
        filterRow={filterRow}
        hideGoal={pickedGoalIds.length > 0}
        selectedCardId={props.selectedCardId}
        bottomInset={props.bottomInset}
        onOpenCard={props.onOpenCard}
        onOpenThread={props.onOpenThread}
      />
    );
  }
  return (
    <ColumnsBoard
      mode={mode}
      onSelectMode={setMode}
      state={props.state}
      nowMs={props.nowMs}
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
      onOpenThread={props.onOpenThread}
    />
  );
}

function TabsBoard(props: {
  readonly board: StageBoard;
  readonly state: KanbanBoardState;
  readonly nowMs: number;
  readonly mode: BoardMode;
  readonly onSelectMode: (mode: BoardMode) => void;
  readonly filterRow: React.ReactNode;
  readonly hideGoal: boolean;
  readonly selectedCardId: string | null;
  readonly bottomInset: number;
  readonly onOpenCard: (cardId: string) => void;
  readonly onOpenThread: (threadId: string) => void;
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
      <View className="px-4 pt-3">
        <ViewSwitch mode={props.mode} onSelect={props.onSelectMode} />
      </View>
      {props.mode === "threads" ? (
        <View className="px-4 pt-3">
          <BoardThreadsList
            boardId={props.state.board.id}
            state={props.state}
            nowMs={props.nowMs}
            onOpenThread={props.onOpenThread}
          />
        </View>
      ) : (
        <>
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
        </>
      )}
    </ScrollView>
  );
}

type BoardMode = "stages" | "threads";

/** Stages and Threads, shared by every board layout. */
function ViewSwitch(props: { readonly mode: BoardMode; readonly onSelect: (mode: BoardMode) => void }) {
  return (
    <UnderlineTabs
      accessibilityLabel="View"
      tabs={[
        { value: "stages", label: "Stages" },
        { value: "threads", label: "Threads" },
      ]}
      selected={props.mode}
      onSelect={props.onSelect}
    />
  );
}

/**
 * The board's runs in two groups, Evaluators (purpose) and Cards (number and
 * title). Running runs come first; ended history is collapsed. Each row opens
 * its thread, which is read-only there because the board drives it.
 */
function BoardThreadsList(props: {
  readonly boardId: string;
  readonly state: KanbanBoardState;
  readonly nowMs: number;
  readonly onOpenThread: (threadId: string) => void;
}) {
  const rows = useKanbanBoardThreads(props.boardId);
  if (rows === undefined) return null;
  if (rows.length === 0) return <Text className="text-sm text-muted-foreground">No threads yet.</Text>;
  return (
    <View className="gap-5">
      <ThreadGroup
        title="Evaluators"
        empty="No evaluator threads yet."
        rows={rows.filter((row) => row.role === "evaluator")}
        nowMs={props.nowMs}
        onOpenThread={props.onOpenThread}
      />
      <ThreadGroup
        title="Cards"
        empty="No card threads yet."
        rows={rows.filter((row) => row.role !== "evaluator")}
        nowMs={props.nowMs}
        onOpenThread={props.onOpenThread}
      />
    </View>
  );
}

function ThreadGroup(props: {
  readonly title: string;
  readonly empty: string;
  readonly rows: ReadonlyArray<KanbanThreadRow>;
  readonly nowMs: number;
  readonly onOpenThread: (threadId: string) => void;
}) {
  const running = props.rows.filter((row) => row.running);
  const ended = props.rows.filter((row) => !row.running);
  return (
    <View className="gap-2">
      <Text className="text-sm font-medium text-muted-foreground">{props.title}</Text>
      {props.rows.length === 0 ? (
        <Text className="text-sm text-muted-foreground">{props.empty}</Text>
      ) : (
        <>
          {running.map((row) => (
            <ThreadRow key={row.threadId} row={row} nowMs={props.nowMs} onOpenThread={props.onOpenThread} />
          ))}
          {ended.length === 0 ? null : (
            <EndedRows rows={ended} nowMs={props.nowMs} onOpenThread={props.onOpenThread} />
          )}
        </>
      )}
    </View>
  );
}

/** Ended runs collapse behind a toggle so current runs stay on top. */
function EndedRows(props: {
  readonly rows: ReadonlyArray<KanbanThreadRow>;
  readonly nowMs: number;
  readonly onOpenThread: (threadId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <View className="gap-2">
      <LinkButton
        label={open ? `Hide ended · ${props.rows.length}` : `Ended · ${props.rows.length}`}
        expanded={open}
        onPress={() => setOpen(!open)}
      />
      {open
        ? props.rows.map((row) => (
            <ThreadRow key={row.threadId} row={row} nowMs={props.nowMs} onOpenThread={props.onOpenThread} />
          ))
        : null}
    </View>
  );
}

function ThreadRow(props: {
  readonly row: KanbanThreadRow;
  readonly nowMs: number;
  readonly onOpenThread: (threadId: string) => void;
}) {
  const { row } = props;
  // Card identity and purpose stay visible next to the title, so repeated
  // evaluator runs and renamed or reused card threads can be told apart.
  const identity =
    row.role === "evaluator"
      ? `Evaluator · ${row.purpose ?? "run"}`
      : row.cardNumber !== null
        ? `Card #${row.cardNumber}${row.cardTitle ? ` ${row.cardTitle}` : ""}`
        : "Card";
  const activity = row.lastActivityAt === null ? null : ageView(row.lastActivityAt, props.nowMs);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open ${row.title ?? identity}`}
      onPress={() => props.onOpenThread(row.threadId)}
      className="gap-1 rounded-xl border border-border px-3 py-2"
    >
      <Text numberOfLines={1} className="text-sm font-medium text-foreground">
        {row.title ?? identity}
      </Text>
      <Text numberOfLines={1} className="text-xs text-muted-foreground">
        {identity}
        {row.model === null ? "" : ` · ${row.model.model}`}
        {activity === null ? "" : ` · ${activity.label} ago`}
        {row.running ? " · running" : " · ended"}
      </Text>
    </Pressable>
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
  readonly nowMs: number;
  readonly layout: Extract<BoardLayout, { kind: "columns" }>;
  readonly mode: BoardMode;
  readonly onSelectMode: (mode: BoardMode) => void;
  readonly filterRow: React.ReactNode;
  readonly hideGoal: boolean;
  readonly selectedCardId: string | null;
  readonly bottomInset: number;
  readonly onOpenCard: (cardId: string) => void;
  readonly onOpenGoal: (goalId: string) => void;
  readonly onOpenThread: (threadId: string) => void;
  readonly state: KanbanBoardState;
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
        <ViewSwitch mode={props.mode} onSelect={props.onSelectMode} />
        {props.goals.length > 0 ? (
          <GoalStrip goals={props.goals} onOpenGoal={props.onOpenGoal} />
        ) : null}
        {props.filterRow}
      </View>
      {props.mode === "threads" ? null : (
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
      )}
      {props.mode === "threads" ? (
        <ScrollView className="flex-1" contentContainerStyle={{ paddingBottom: props.bottomInset + 16 }}>
          <View className="px-4 pt-1">
            <BoardThreadsList
              boardId={props.state.board.id}
              state={props.state}
              nowMs={props.nowMs}
              onOpenThread={props.onOpenThread}
            />
          </View>
        </ScrollView>
      ) : null}
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
