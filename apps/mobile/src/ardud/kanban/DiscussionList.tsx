import { discussionRows, type KanbanBoardState } from "@t3tools/client-runtime/ardud/kanban";
import { clockLabel } from "@t3tools/client-runtime/ardud/missions/mobile";
import { Fragment, useEffect } from "react";
import { Pressable, ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";
import { LoadingLine } from "../missions/FeedError";
import { EmptyLine } from "../missions/parts";
import { kanbanClient } from "./kanbanStore";

/** Board discussions, newest first: title with an unread dot, the last line under it. */
export function DiscussionList(props: {
  readonly state: KanbanBoardState;
  readonly nowMs: number;
  readonly bottomInset: number;
  readonly selectedId?: string | null;
  readonly onOpen: (discussionId: string) => void;
}) {
  const rows = discussionRows(props.state);
  const boardId = props.state.board.id;
  useEffect(() => kanbanClient().watchPreviews(boardId), [boardId]);
  if (!props.state.discussionsLoaded && rows.length === 0) return <LoadingLine />;
  return (
    <ScrollView
      className="flex-1"
      contentContainerClassName="px-3 pt-2"
      contentContainerStyle={{ paddingBottom: props.bottomInset + 16 }}
    >
      {rows.length === 0 ? <EmptyLine label="No discussions" /> : null}
      {rows.map((row, index) => {
        const selected = row.id === props.selectedId;
        return (
          <Fragment key={row.id}>
            {index > 0 && !selected ? <View className="mx-3 h-px bg-border" /> : null}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={row.unread > 0 ? `${row.title}, ${row.unread} unread` : row.title}
              accessibilityState={{ selected }}
              onPress={() => props.onOpen(row.id)}
              className={cn("min-h-16 gap-1 rounded-[12px] px-3 py-2.5", selected && "bg-card")}
            >
              <View className="flex-row items-center gap-2">
                <Text
                  numberOfLines={1}
                  className={cn(
                    "shrink text-[15px] text-foreground",
                    row.unread > 0 ? "font-t3-bold" : "font-t3-medium",
                  )}
                >
                  {row.title}
                </Text>
                {row.unread > 0 ? <View className="size-1.5 rounded-full bg-primary" /> : null}
                <View className="flex-1" />
                {row.at ? (
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
          </Fragment>
        );
      })}
    </ScrollView>
  );
}
