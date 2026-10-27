import { useNavigation } from "@react-navigation/native";
import type { KanbanBoardSummary } from "@t3tools/contracts";
import { Fragment } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Group, NewCount, Row, SectionHead, Separator, Title } from "../missions/parts";
import { BoardIcon } from "./BoardIcon";
import { useKanbanBoards } from "./kanbanStore";
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
        {boards.map((summary, index) => (
          <Fragment key={summary.board.id}>
            {index > 0 ? <Separator /> : null}
            <BoardRow
              summary={summary}
              onOpen={() => navigation.navigate("KanbanBoard", { boardId: summary.board.id })}
            />
          </Fragment>
        ))}
      </Group>
    </View>
  );
}

function BoardRow(props: { readonly summary: KanbanBoardSummary; readonly onOpen: () => void }) {
  const { board, needsOwner: owner, running, unread } = props.summary;
  const name = board.name;
  return (
    <Row
      accessibilityLabel={owner > 0 ? `${name}, ${owner} need you` : name}
      onPress={props.onOpen}
      className="items-center"
    >
      <BoardIcon board={board} />
      <Title className="flex-1">{name}</Title>
      {owner === 0 && running > 0 ? <Glyph kind="ok" /> : null}
      <NewCount count={unread} accessibilityLabel={`${unread} unread`} />
      {owner > 0 ? (
        <View className="h-[22px] min-w-[22px] items-center justify-center rounded-full bg-warning-foreground px-1.5">
          <Text className="text-xs font-t3-bold text-screen">{owner}</Text>
        </View>
      ) : null}
    </Row>
  );
}
