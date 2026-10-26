import { useNavigation } from "@react-navigation/native";
import type { KanbanBoard } from "@t3tools/contracts";
import { totalUnread } from "@t3tools/client-runtime/ardud/kanban";
import { Fragment } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Group, NewCount, Row, SectionHead, Separator, Title } from "../missions/parts";
import { useKanbanBoard, useKanbanBoards } from "./kanbanStore";
import { Glyph } from "./parts";

/**
 * The Boards group on the phone's thread list, under Missions: one row per
 * board with what waits on the owner. Nothing shows until a board exists.
 */
export function KanbanBoardsGroup() {
  const navigation = useNavigation();
  const boards = useKanbanBoards();
  if (!boards || boards.length === 0) return null;
  return (
    <View className="gap-1.5 px-4 pb-1 pt-3">
      <SectionHead title="Boards" />
      <Group>
        {boards.map((board, index) => (
          <Fragment key={board.id}>
            {index > 0 ? <Separator /> : null}
            <BoardRow
              board={board}
              onOpen={() => navigation.navigate("KanbanBoard", { boardId: board.id })}
            />
          </Fragment>
        ))}
      </Group>
    </View>
  );
}

function BoardRow(props: { readonly board: KanbanBoard; readonly onOpen: () => void }) {
  const state = useKanbanBoard(props.board.id);
  let owner = 0;
  let running = 0;
  for (const card of state?.cards.values() ?? []) {
    if (card.settledAt !== null) continue;
    if (card.stage === "needs_owner") owner += 1;
    else if (card.activeThreadId !== null) running += 1;
  }
  const unread = state ? totalUnread(state) : 0;
  const name = state?.board.name ?? props.board.name;
  return (
    <Row
      accessibilityLabel={owner > 0 ? `${name}, ${owner} need you` : name}
      onPress={props.onOpen}
      className="items-center"
    >
      <Glyph kind={owner > 0 ? "wait" : running > 0 ? "ok" : "idle"} />
      <Title className="flex-1">{name}</Title>
      <NewCount count={unread} accessibilityLabel={`${unread} unread`} />
      {owner > 0 ? (
        <View className="h-[22px] min-w-[22px] items-center justify-center rounded-full bg-warning-foreground px-1.5">
          <Text className="text-xs font-t3-bold text-screen">{owner}</Text>
        </View>
      ) : null}
    </Row>
  );
}
