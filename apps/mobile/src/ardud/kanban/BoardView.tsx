import {
  activeGoals,
  stageBoard,
  type CardView,
  type GoalSummary,
  type KanbanBoardState,
  type SettledFilter,
  type StageBoard,
  type StageColumn,
} from "@t3tools/client-runtime/ardud/kanban";
import type { KanbanThreadLink } from "@t3tools/contracts";
import { Fragment, useRef, useState } from "react";
import { Pressable, ScrollView, type TextInputInstance, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SearchField } from "../../components/ui/SearchField";
import { cn } from "../../lib/cn";
import { ChoiceRow, LinkButton } from "../common/parts";
import {
  BOARD_PAD,
  type BoardLayout,
  type BoardTab,
  boardTabs,
  COLUMN_GAP,
  defaultBoardTab,
} from "./logic";
import { useKanbanBoardThreads } from "./kanbanStore";
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
}) {
  const goals = activeGoals(props.state);
  const [goalId, setGoalId] = useState<string | null>(null);
  // A goal that finished or vanished stops filtering.
  const filter = goals.some((entry) => entry.goal.id === goalId) ? goalId : null;
  const [query, setQuery] = useState("");
  const [settled, setSettled] = useState<SettledFilter>("hide");
  const searchRef = useRef<TextInputInstance | null>(null);
  const board = stageBoard(props.state, props.nowMs, { goalId: filter, query, settled });
  const filterRow = (
    <View className="gap-2.5">
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
        <Pressable
          accessibilityRole="switch"
          accessibilityLabel="Show settled cards"
          accessibilityState={{ checked: settled === "include" }}
          onPress={() => setSettled((current) => (current === "hide" ? "include" : "hide"))}
          className={cn(
            "min-h-11 justify-center rounded-full px-4",
            settled === "include" ? "bg-foreground" : "bg-grouped-card",
          )}
        >
          <Text
            className={cn(
              "text-[13px] font-t3-semibold",
              settled === "include" ? "text-screen" : "text-foreground",
            )}
          >
            Settled
          </Text>
        </Pressable>
      </View>
      {goals.length > 0 ? (
        <ChoiceRow
          accessibilityLabel="Goal"
          options={[
            { value: "", label: "All" },
            ...goals.map((entry) => ({ value: entry.goal.id, label: entry.goal.name })),
          ]}
          selected={filter ?? ""}
          onSelect={(value) => setGoalId(value === "" ? null : value)}
        />
      ) : null}
    </View>
  );

  if (props.layout.kind === "tabs") {
    return (
      <TabsBoard
        board={board}
        filterRow={filterRow}
        hideGoal={filter !== null}
        selectedCardId={props.selectedCardId}
        bottomInset={props.bottomInset}
        onOpenCard={props.onOpenCard}
      />
    );
  }
  return (
    <ColumnsBoard
      board={board}
      goals={goals}
      layout={props.layout}
      filterRow={filterRow}
      hideGoal={filter !== null}
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
  const [mode, setMode] = useState<"stages" | "threads">("stages");
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
      <UnderlineTabs
        accessibilityLabel="View"
        tabs={[
          { value: "stages", label: "Stages" },
          { value: "threads", label: "Threads" },
        ]}
        selected={mode}
        onSelect={setMode}
      />
      {mode === "threads" ? (
        <View className="px-4 pt-3">
          <BoardThreadsList boardId={props.boardId} state={board} />
        </View>
      ) : null}
      {mode === "stages" ? (
        <UnderlineTabs accessibilityLabel="Stage" tabs={tabs} selected={tab} onSelect={setTab} />
      ) : null}
      {mode === "stages" ? (
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
      ) : null}
    </ScrollView>
  );
}

/**
 * The board's threads in two groups, cards and evaluators, the same split as
 * the web Threads view. Board threads are read-only on the phone too.
 */
function BoardThreadsList(props: {
  readonly boardId: string;
  readonly state: KanbanBoardState;
}) {
  const threads = useKanbanBoardThreads(props.boardId);
  if (threads === undefined) return null;
  if (threads.length === 0) return <Text className="text-sm text-muted-foreground">No threads yet.</Text>;
  const evaluators = threads.filter((link) => link.role === "evaluator");
  const cardThreads = threads.filter((link) => link.role !== "evaluator");
  const cards = props.state.cards;
  const cardLabel = (link: KanbanThreadLink) => {
    const card = link.cardId === null ? undefined : cards.get(link.cardId);
    return card ? `#${card.number} ${card.title}` : (link.cardId ?? "Card");
  };
  return (
    <View className="gap-5">
      <ThreadRows title="Evaluators" empty="No evaluator threads yet." links={evaluators} label={(link) => link.purpose ?? "evaluator"} />
      <ThreadRows title="Cards" empty="No card threads yet." links={cardThreads} label={cardLabel} />
    </View>
  );
}

function ThreadRows(props: {
  readonly title: string;
  readonly empty: string;
  readonly links: ReadonlyArray<KanbanThreadLink>;
  readonly label: (link: KanbanThreadLink) => string;
}) {
  return (
    <View className="gap-2">
      <Text className="text-sm font-medium text-muted-foreground">{props.title}</Text>
      {props.links.length === 0 ? (
        <Text className="text-sm text-muted-foreground">{props.empty}</Text>
      ) : (
        props.links.map((link) => (
          <View key={link.threadId} className="flex-row items-center justify-between gap-3 rounded-xl border border-border px-3 py-2">
            <Text numberOfLines={1} className="flex-1 text-sm text-foreground">{props.label(link)}</Text>
            <Text className="text-xs text-muted-foreground">
              {link.role}
              {link.endedAt === null ? " · running" : " · ended"}
            </Text>
          </View>
        ))
      )}
    </View>
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
