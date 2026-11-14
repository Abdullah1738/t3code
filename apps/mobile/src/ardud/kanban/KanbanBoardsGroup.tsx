import { useNavigation } from "@react-navigation/native";
import { KANBAN_WS_METHODS, type KanbanBoardSummary } from "@t3tools/contracts";
import { Fragment } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Menu } from "../../components/ui/Menu";
import { Group, Row, SectionHead, Separator, Title } from "../common/parts";
import { BoardIcon } from "./BoardIcon";
import { useKanbanBoards, useKanbanPermission } from "./kanbanStore";
import { renameBoard } from "./boardActions";
import { NeedsYouHomeRow } from "./needsYou/NeedsYouHomeRow";
import { Glyph } from "./parts";

/**
 * The Boards group on the phone's thread list: one row per board with what
 * waits on the owner. Nothing shows until a board exists.
 */
export function KanbanBoardsGroup() {
  const navigation = useNavigation();
  const boards = useKanbanBoards();
  // The group stays visible with no boards so "New board" is always reachable.
  return (
    <View className="gap-1.5 px-4 pb-1 pt-3">
      <NeedsYouHomeRow />
      <SectionHead title="Boards" />
      <Group>
        {(boards ?? []).map((summary, index) => (
          <Fragment key={summary.board.id}>
            {index > 0 ? <Separator /> : null}
            <BoardRow
              summary={summary}
              onOpen={() => navigation.navigate("KanbanBoard", { boardId: summary.board.id })}
            />
          </Fragment>
        ))}
        {(boards ?? []).length > 0 ? <Separator /> : null}
        <Row onPress={() => navigation.navigate("KanbanNewBoard")} className="items-center">
          <Title className="flex-1">New board</Title>
        </Row>
      </Group>
    </View>
  );
}

/** Icon and count for one pending kind, read by screen readers as a single label. */
function BoardBadge(props: {
  readonly symbol: "text.bubble" | "questionmark.bubble";
  readonly count: number;
  readonly accessibilityLabel: string;
  readonly warning?: boolean;
}) {
  return (
    <View
      accessible
      accessibilityLabel={props.accessibilityLabel}
      className="flex-row items-center gap-1"
    >
      <SymbolView
        name={props.symbol}
        size={12}
        tintColorClassName={props.warning ? "accent-warning-foreground" : "accent-icon-muted"}
        type="monochrome"
      />
      <Text
        className={
          props.warning
            ? "text-xs font-t3-semibold text-warning-foreground"
            : "text-xs font-t3-semibold text-foreground-muted"
        }
      >
        {props.count}
      </Text>
    </View>
  );
}

function BoardRow(props: { readonly summary: KanbanBoardSummary; readonly onOpen: () => void }) {
  const { board, needsOwner: owner, running, unread } = props.summary;
  const name = board.name;
  const canRename = useKanbanPermission(KANBAN_WS_METHODS.boardUpdate);
  const parts = [
    name,
    ...(unread > 0 ? [`${unread} unread messages`] : []),
    ...(owner > 0 ? [`${owner} questions for you`] : []),
  ];
  const row = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={parts.join(", ")}
      accessibilityHint={canRename ? "Long-press to rename" : undefined}
      onPress={props.onOpen}
    >
      <Row className="items-center">
        <BoardIcon board={board} />
        <Title className="flex-1">{name}</Title>
        {owner === 0 && running > 0 ? <Glyph kind="ok" /> : null}
        {unread > 0 ? (
          <BoardBadge
            symbol="text.bubble"
            count={unread}
            accessibilityLabel={`${unread} unread messages`}
          />
        ) : null}
        {owner > 0 ? (
          <BoardBadge
            symbol="questionmark.bubble"
            count={owner}
            accessibilityLabel={`${owner} questions for you`}
            warning
          />
        ) : null}
      </Row>
    </Pressable>
  );
  if (!canRename) return row;
  return (
    <Menu
      shouldOpenOnLongPress
      title={name}
      actions={[{ id: "rename", title: "Rename", image: "square.and.pencil" }]}
      onPressAction={({ nativeEvent }) => {
        if (nativeEvent.event === "rename") renameBoard(board.id, name);
      }}
    >
      {row}
    </Menu>
  );
}
