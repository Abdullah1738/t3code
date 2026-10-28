import { type StaticScreenProps, useNavigation } from "@react-navigation/native";
import { totalUnread } from "@t3tools/client-runtime/ardud/kanban";
import { useState } from "react";
import { View } from "react-native";
import { KeyboardAvoidingView, useKeyboardState } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppBar } from "../../components/ui/AppBar";
import { FeedError, LoadingLine } from "../common/FeedError";
import { EmptyLine } from "../common/parts";
import { useBoardAction, useHeaderInset, useNowMs } from "../common/hooks";
import { BoardView } from "./BoardView";
import { CardDetail } from "./CardDetail";
import { kanbanClient, useKanbanBoard, useKanbanBoardFeed } from "./kanbanStore";
import { boardLayout, cardPaneWidth, type KanbanBoardParams } from "./logic";
import { useKanbanNav } from "./nav";

/**
 * One board. A phone shows the stages behind tabs and pushes a card; a wide
 * iPad shows the columns and opens a card in a pane at the right.
 */
export function KanbanBoardRouteScreen(props: StaticScreenProps<KanbanBoardParams | undefined>) {
  // Opening another board can reuse this screen; a fresh body per board
  // drops the old board's tab, filter and open card.
  return <BoardScreen key={props.route.params?.boardId ?? ""} {...props} />;
}

function BoardScreen({ route }: StaticScreenProps<KanbanBoardParams | undefined>) {
  const navigation = useNavigation();
  const headerInset = useHeaderInset();
  const insets = useSafeAreaInsets();
  const keyboardVisible = useKeyboardState((state) => state.isVisible);
  const bottomInset = keyboardVisible ? 8 : Math.max(insets.bottom, 12);
  const nowMs = useNowMs();
  const boardId = route.params?.boardId?.trim() ?? "";
  const state = useKanbanBoard(boardId);
  const feed = useKanbanBoardFeed(boardId);
  const nav = useKanbanNav(boardId);
  const [width, setWidth] = useState(0);
  const [paneCardId, setPaneCardId] = useState<string | null>(null);
  const action = useBoardAction();
  const layout = boardLayout(width);
  const pane = layout.kind === "columns";
  const openCard = (cardId: string) => (pane ? setPaneCardId(cardId) : nav.openCard(cardId));
  const paneCard = pane && paneCardId !== null && state?.cards.has(paneCardId) ? paneCardId : null;
  const unread = state ? totalUnread(state) : 0;

  let body: React.ReactNode;
  if (boardId === "") body = <EmptyLine label="This link does not open a board." />;
  else if (state === undefined)
    body = feed.failure ? (
      <FeedError what="the board" feed={feed} nowMs={nowMs} />
    ) : (
      <LoadingLine />
    );
  else
    body = (
      <View className="flex-1">
        <FeedError what="the board" feed={feed} nowMs={nowMs} />
        <BoardView
          state={state}
          layout={layout}
          nowMs={nowMs}
          selectedCardId={paneCard}
          bottomInset={bottomInset}
          onOpenCard={openCard}
          onOpenGoal={nav.openGoal}
          onViewSetup={nav.openDiscussion}
          onEndSetup={() =>
            void action.run("Couldn't end setup", () => kanbanClient().endSetup(boardId))
          }
        />
        {/* A drawer over the columns, so opening a card never reflows the board. */}
        {paneCard !== null ? (
          <View
            className="absolute inset-y-0 right-0 border-l border-border bg-screen"
            style={{ width: cardPaneWidth(width) }}
          >
            <CardDetail
              key={paneCard}
              boardId={boardId}
              state={state}
              cardId={paneCard}
              nowMs={nowMs}
              bottomInset={bottomInset}
              onOpenCard={setPaneCardId}
              onOpenGoal={nav.openGoal}
              onOpenThread={nav.openThread}
              onClose={() => setPaneCardId(null)}
            />
          </View>
        ) : null}
      </View>
    );

  return (
    <View collapsable={false} className="flex-1 bg-screen" style={{ paddingTop: headerInset }}>
      <AppBar
        title={state?.board.name ?? "Board"}
        sidebar={false}
        onBack={() => navigation.goBack()}
        actions={
          state
            ? [
                {
                  accessibilityLabel: unread > 0 ? `Discussions, ${unread} unread` : "Discussions",
                  icon: "bubble.left.and.bubble.right",
                  onPress: nav.openDiscussions,
                },
                {
                  accessibilityLabel: "New discussion",
                  icon: "plus",
                  onPress: () => nav.openDiscussion(null),
                },
              ]
            : []
        }
      />
      <KeyboardAvoidingView automaticOffset behavior="height" className="flex-1">
        <View className="flex-1" onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
          {width > 0 ? body : null}
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}
