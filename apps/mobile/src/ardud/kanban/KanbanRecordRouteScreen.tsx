import { type StaticScreenProps, useNavigation } from "@react-navigation/native";
import type { KanbanBoardState } from "@t3tools/client-runtime/ardud/kanban";
import { type ReactNode, useState } from "react";
import { View } from "react-native";
import { KeyboardAvoidingView, useKeyboardState } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppBar } from "../../components/ui/AppBar";
import type { AppBarAction } from "../../components/ui/AppBar.types";
import { FeedError, LoadingLine } from "../common/FeedError";
import { EmptyLine } from "../common/parts";
import { useHeaderInset, useNowMs } from "../common/hooks";
import { CardDetail } from "./CardDetail";
import { Chat } from "./Chat";
import { DiscussionList } from "./DiscussionList";
import { GoalView } from "./GoalView";
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
      return (
        <Shell title={card ? `#${card.number}` : "Card"} onBack={back}>
          <CardDetail
            boardId={boardId}
            state={state}
            cardId={record.id ?? ""}
            nowMs={nowMs}
            bottomInset={bottomInset}
            onOpenCard={nav.openCard}
            onOpenGoal={nav.openGoal}
            onOpenThread={nav.openThread}
          />
        </Shell>
      );
    }
    case "goal":
      return (
        <Shell title={state.goals.get(record.id ?? "")?.name ?? "Goal"} onBack={back}>
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
  readonly children: ReactNode;
}) {
  const headerInset = useHeaderInset();
  return (
    <View collapsable={false} className="flex-1 bg-screen" style={{ paddingTop: headerInset }}>
      <AppBar
        title={props.title}
        sidebar={false}
        onBack={props.onBack}
        {...(props.actions ? { actions: props.actions } : {})}
      />
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
  return (
    <Shell
      title={title}
      onBack={props.onBack}
      actions={
        card
          ? [
              {
                accessibilityLabel: `Open #${card.number}`,
                icon: "doc.text",
                onPress: () => nav.openCard(card.id),
              },
            ]
          : []
      }
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
    </Shell>
  );
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

  return (
    <Shell
      title="Discussions"
      onBack={props.onBack}
      actions={[{ accessibilityLabel: "New discussion", icon: "plus", onPress: () => open(null) }]}
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
