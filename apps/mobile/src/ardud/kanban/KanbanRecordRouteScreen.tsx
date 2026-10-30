import { type StaticScreenProps, useNavigation } from "@react-navigation/native";
import {
  cardSteps,
  discussionSnoozed,
  type KanbanBoardState,
  setupBanner,
} from "@t3tools/client-runtime/ardud/kanban";
import type { KanbanDiscussion } from "@t3tools/contracts";
import { type ReactNode, useState } from "react";
import { View } from "react-native";
import { KeyboardAvoidingView, useKeyboardState } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppBar } from "../../components/ui/AppBar";
import { IconButton } from "../../components/ui/IconButton";
import type { AppBarAction, AppBarMenu } from "../../components/ui/AppBar.types";
import { FeedError, LoadingLine } from "../common/FeedError";
import { EmptyLine } from "../common/parts";
import { useBoardAction, useHeaderInset, useNowMs } from "../common/hooks";
import { CardDetail } from "./CardDetail";
import { useBoardFilter } from "./boardFilterStore";
import { copyLinkAction } from "./copyLink";
import { SetupStrip } from "./BoardView";
import { Chat } from "./Chat";
import { CustomSnoozeSheet } from "../../features/threads/CustomSnoozeSheet";
import {
  discussionMenu,
  MENU_ICONS,
  runDiscussionMenu,
  snoozeDiscussion,
} from "./discussionActions";
import { DiscussionList } from "./DiscussionList";
import { GoalView } from "./GoalView";
import { useHideCardDiscussions } from "./useHideCardDiscussions";
import { kanbanClient, useKanbanBoard, useKanbanBoardFeed } from "./kanbanStore";
import { kanbanRecordState, type KanbanRecordParams, requestTitle } from "./logic";
import { useKanbanNav } from "./nav";

// From this width the discussion list keeps a chat open beside it.
const SPLIT_WIDTH = 700;

/** A pushed board record: a card, a discussion, the discussion list or a goal. */
export function KanbanRecordRouteScreen({
  route,
}: StaticScreenProps<KanbanRecordParams | undefined>) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const keyboardVisible = useKeyboardState((state) => state.isVisible);
  const bottomInset = keyboardVisible ? 8 : Math.max(insets.bottom, 12);
  const nowMs = useNowMs();
  const record = kanbanRecordState(route.params);
  const boardId = record?.boardId ?? "";
  const state = useKanbanBoard(boardId);
  const feed = useKanbanBoardFeed(boardId);
  const nav = useKanbanNav(boardId);
  const back = () => navigation.goBack();
  const filter = useBoardFilter(boardId);

  if (record === null) {
    return (
      <Shell title="Board" onBack={back}>
        <EmptyLine label="This link does not open anything." />
      </Shell>
    );
  }
  if (state === undefined) {
    return (
      <Shell title={FALLBACK_TITLE[record.kind]} onBack={back}>
        {feed.failure ? <FeedError what="the board" feed={feed} nowMs={nowMs} /> : <LoadingLine />}
      </Shell>
    );
  }

  switch (record.kind) {
    case "card": {
      const card = state.cards.get(record.id ?? "");
      const steps = cardSteps(state, nowMs, filter, "stage", record.id ?? "");
      // Stepping replaces this screen's card (no new screen), so Back still returns to the board.
      const step = (id: string) => navigation.setParams({ ...route.params, id });
      return (
        <Shell
          title={card ? `#${card.number}` : "Card"}
          onBack={back}
          actions={[
            ...(card
              ? [copyLinkAction("kanban-card", card.id, `#${card.number} ${card.title}`)]
              : []),
            {
              accessibilityLabel: "Previous card",
              icon: "chevron.up",
              disabled: steps.previous === null,
              onPress: () => steps.previous && step(steps.previous),
            },
            {
              accessibilityLabel: "Next card",
              icon: "chevron.down",
              disabled: steps.next === null,
              onPress: () => steps.next && step(steps.next),
            },
          ]}
          state={state}
          boardId={boardId}
        >
          <CardDetail
            key={record.id}
            boardId={boardId}
            state={state}
            cardId={record.id ?? ""}
            nowMs={nowMs}
            bottomInset={bottomInset}
            onOpenCard={nav.openCard}
            onOpenGoal={nav.openGoal}
            onOpenThread={nav.openThread}
            stepper={{ steps, onStep: step, onDone: back }}
          />
        </Shell>
      );
    }
    case "goal":
      return (
        <Shell
          title={state.goals.get(record.id ?? "")?.name ?? "Goal"}
          onBack={back}
          state={state}
          boardId={boardId}
        >
          <GoalView
            state={state}
            goalId={record.id ?? ""}
            nowMs={nowMs}
            bottomInset={bottomInset}
            onOpenCard={nav.openCard}
          />
        </Shell>
      );
    case "discussion":
      return (
        <DiscussionScreen
          boardId={boardId}
          state={state}
          discussionId={record.id}
          nowMs={nowMs}
          bottomInset={bottomInset}
          onBack={back}
          onCreated={(id) => navigation.setParams({ ...route.params, id })}
        />
      );
    case "discussions":
      return (
        <DiscussionsScreen
          boardId={boardId}
          state={state}
          nowMs={nowMs}
          bottomInset={bottomInset}
          onBack={back}
        />
      );
  }
}

const FALLBACK_TITLE = {
  card: "Card",
  goal: "Goal",
  discussion: "Discussion",
  discussions: "Discussions",
} as const;

function Shell(props: {
  readonly title: string;
  readonly onBack: () => void;
  readonly actions?: ReadonlyArray<AppBarAction>;
  readonly menus?: ReadonlyArray<AppBarMenu>;
  /** The board, for its setup strip while the first setup runs. */
  readonly state?: KanbanBoardState;
  readonly boardId?: string;
  readonly children: ReactNode;
}) {
  const headerInset = useHeaderInset();
  const setup = props.state ? setupBanner(props.state.board) : null;
  const navSetup = useKanbanNav(props.boardId ?? "");
  const action = useBoardAction();
  return (
    <View collapsable={false} className="flex-1 bg-screen" style={{ paddingTop: headerInset }}>
      <AppBar
        title={props.title}
        sidebar={false}
        onBack={props.onBack}
        {...(props.actions ? { actions: props.actions } : {})}
        {...(props.menus ? { menus: props.menus } : {})}
      />
      {setup && props.boardId ? (
        <View className="px-4 pt-2">
          <SetupStrip
            setup={setup}
            onViewSetup={(id) => navSetup.openDiscussion(id)}
            onEndSetup={() =>
              void action.run("Couldn't end setup", () =>
                kanbanClient().endSetup(props.boardId ?? ""),
              )
            }
          />
        </View>
      ) : null}
      <KeyboardAvoidingView automaticOffset behavior="height" className="flex-1">
        {props.children}
      </KeyboardAvoidingView>
    </View>
  );
}

/** Makes a new discussion titled from its first message. */
const createDiscussion = async (boardId: string, firstText: string) =>
  (await kanbanClient().createDiscussion(boardId, requestTitle(firstText))).id;

function DiscussionScreen(props: {
  readonly boardId: string;
  readonly state: KanbanBoardState;
  readonly discussionId: string | null;
  readonly nowMs: number;
  readonly bottomInset: number;
  readonly onBack: () => void;
  readonly onCreated: (discussionId: string) => void;
}) {
  const nav = useKanbanNav(props.boardId);
  const discussion =
    props.discussionId === null ? undefined : props.state.discussions.get(props.discussionId);
  const card = discussion?.cardId ? props.state.cards.get(discussion.cardId) : undefined;
  const title = props.discussionId === null ? "New discussion" : discussion?.title || "Discussion";
  const [customSnoozeOpen, setCustomSnoozeOpen] = useState(false);
  return (
    <Shell
      title={title}
      onBack={props.onBack}
      state={props.state}
      boardId={props.boardId}
      menus={
        discussion
          ? [
              discussionOptions(props.boardId, discussion, props.nowMs, () =>
                setCustomSnoozeOpen(true),
              ),
            ]
          : []
      }
      actions={[
        ...(card
          ? [
              {
                accessibilityLabel: `Open #${card.number}`,
                icon: "doc.text" as const,
                onPress: () => nav.openCard(card.id),
              },
            ]
          : []),
        ...(discussion
          ? [copyLinkAction("kanban-discussion", discussion.id, discussion.title)]
          : []),
      ]}
    >
      <Chat
        boardId={props.boardId}
        state={props.state}
        discussionId={props.discussionId}
        ensureDiscussion={async (firstText) => {
          const id = await createDiscussion(props.boardId, firstText);
          props.onCreated(id);
          return id;
        }}
        nowMs={props.nowMs}
        bottomInset={props.bottomInset}
        onOpenCard={nav.openCard}
      />
      {customSnoozeOpen && discussion ? (
        <CustomSnoozeSheet
          onClose={() => setCustomSnoozeOpen(false)}
          onSnooze={(snoozedUntil) => snoozeDiscussion(props.boardId, discussion.id, snoozedUntil)}
        />
      ) : null}
    </Shell>
  );
}

/** Settle, snooze and rename from the open discussion's header. */
function discussionOptions(
  boardId: string,
  discussion: KanbanDiscussion,
  nowMs: number,
  onCustomSnooze: () => void,
): AppBarMenu {
  const run = (choice: string) =>
    runDiscussionMenu({
      boardId,
      discussionId: discussion.id,
      title: discussion.title,
      choice,
      onCustomSnooze,
    });
  return {
    title: "Discussion options",
    icon: "ellipsis.circle",
    items: discussionMenu({
      settled: discussion.settledAt !== null,
      snoozed: discussionSnoozed(discussion, nowMs),
      pinned: discussion.pinnedAt !== null,
      now: new Date(nowMs),
    }).map((item) =>
      "presets" in item
        ? {
            id: item.id,
            title: item.title,
            icon: MENU_ICONS[item.id],
            items: item.presets.map((preset) => ({ ...preset, onPress: () => run(preset.id) })),
          }
        : {
            id: item.id,
            title: item.title,
            icon: MENU_ICONS[item.id],
            onPress: () => run(item.id),
          },
    ),
  };
}

function DiscussionsScreen(props: {
  readonly boardId: string;
  readonly state: KanbanBoardState;
  readonly nowMs: number;
  readonly bottomInset: number;
  readonly onBack: () => void;
}) {
  const nav = useKanbanNav(props.boardId);
  const [width, setWidth] = useState(0);
  const wide = width >= SPLIT_WIDTH;
  // On a wide screen the list keeps a chat open beside it; a new one has a null id.
  // The key stays when a new discussion gets its id, so the chat isn't remade mid-send.
  const [selected, setSelected] = useState<{
    readonly id: string | null;
    readonly key: string;
  } | null>(null);
  const open = (id: string | null) =>
    wide ? setSelected({ id, key: id ?? `new-${Date.now()}` }) : nav.openDiscussion(id);
  const selectedId = selected?.id ?? null;
  const splitDiscussion = selectedId === null ? undefined : props.state.discussions.get(selectedId);
  const { hideCards, toggleHideCards } = useHideCardDiscussions();
  const [unreadOnly, setUnreadOnly] = useState(false);

  return (
    <Shell
      title="Discussions"
      onBack={props.onBack}
      state={props.state}
      boardId={props.boardId}
      actions={[{ accessibilityLabel: "New discussion", icon: "plus", onPress: () => open(null) }]}
      menus={[
        {
          title: "Filter",
          icon: "line.3.horizontal.decrease.circle",
          items: [
            {
              id: "hide-cards",
              title: "Hide card discussions",
              selected: hideCards,
              onPress: toggleHideCards,
            },
            {
              id: "unread-only",
              title: "Unread only",
              selected: unreadOnly,
              onPress: () => setUnreadOnly((on) => !on),
            },
          ],
        },
      ]}
    >
      <View
        className="flex-1 flex-row"
        onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      >
        <View className={wide ? "w-[320px] border-r border-border" : "flex-1"}>
          <DiscussionList
            state={props.state}
            nowMs={props.nowMs}
            bottomInset={props.bottomInset}
            selectedId={wide ? selectedId : null}
            hideCards={hideCards}
            unreadOnly={unreadOnly}
            onOpen={open}
          />
        </View>
        {wide ? (
          <View className="flex-1">
            {selected ? (
              <Chat
                key={selected.key}
                boardId={props.boardId}
                state={props.state}
                discussionId={selected.id}
                header={
                  splitDiscussion ? (
                    <View className="flex-row justify-end px-4 pt-2">
                      <IconButton
                        {...copyLinkAction(
                          "kanban-discussion",
                          splitDiscussion.id,
                          splitDiscussion.title,
                        )}
                      />
                    </View>
                  ) : undefined
                }
                ensureDiscussion={async (firstText) => {
                  const id = await createDiscussion(props.boardId, firstText);
                  setSelected((current) => (current ? { ...current, id } : current));
                  return id;
                }}
                nowMs={props.nowMs}
                bottomInset={props.bottomInset}
                onOpenCard={nav.openCard}
              />
            ) : (
              <EmptyLine label="No discussion open" />
            )}
          </View>
        ) : null}
      </View>
    </Shell>
  );
}
