import { useNavigation } from "@react-navigation/native";
import {
  imessageChatLabel,
  type IMessageChatSummary,
} from "@t3tools/client-runtime/ardud/imessage";
import { Fragment, useMemo } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import {
  useAtomValueWhileVisible,
  useHomeRouteVisible,
} from "../../features/home/home-route-visibility";
import { threadHasUnseenCompletion } from "../../features/threads/threadListV2";
import { cn } from "../../lib/cn";
import { environmentThreadShells } from "../../state/threads";
import { Group, Meta, Row, SectionHead, Separator } from "../missions/parts";
import { IMessageAvatar } from "./IMessageAvatar";
import { useIMessagePalette } from "./palette";
import { useIMessageChats } from "./useIMessageChat";

/**
 * The iMessage chats on Home, one row per person or group. Their threads are left out
 * of the normal list; each chat opens as a Messages-style transcript.
 */
export function IMessageThreadGroup() {
  const navigation = useNavigation();
  const visible = useHomeRouteVisible();
  const threads = useAtomValueWhileVisible(environmentThreadShells.threadShellsAtom, visible);
  const chats = useIMessageChats(threads);
  const unread = useMemo(() => {
    const unseen = new Set(
      threads.filter(threadHasUnseenCompletion).map((thread) => thread.id as string),
    );
    return new Set(
      chats.filter((chat) => chat.threadIds.some((id) => unseen.has(id))).map((chat) => chat.slug),
    );
  }, [chats, threads]);
  if (chats.length === 0) return null;
  return (
    <View className="gap-1.5 px-4 pb-1 pt-3">
      <SectionHead title="iMessage" />
      <Group>
        {chats.map((chat, index) => (
          <Fragment key={chat.slug}>
            {index > 0 ? <Separator /> : null}
            <ChatRow
              chat={chat}
              unread={unread.has(chat.slug)}
              onOpen={() => navigation.navigate("IMessageChat", { chatSlug: chat.slug })}
            />
          </Fragment>
        ))}
      </Group>
    </View>
  );
}

function ChatRow(props: {
  readonly chat: IMessageChatSummary;
  readonly unread: boolean;
  readonly onOpen: () => void;
}) {
  const palette = useIMessagePalette();
  const label = imessageChatLabel(props.chat.slug, props.chat.latestTitle);
  return (
    <Row
      accessibilityLabel={props.unread ? `${label}, has new replies` : label}
      onPress={props.onOpen}
      className="items-center"
    >
      <IMessageAvatar label={label} size="row" />
      <Text
        numberOfLines={1}
        className={cn(
          "min-w-0 flex-1 text-[15px] text-foreground",
          props.chat.running ? "font-t3-semibold" : "font-t3-medium",
        )}
      >
        {label}
      </Text>
      {/* Static on purpose: a pulsing mark would repaint every frame. */}
      {props.chat.running ? <Meta>working</Meta> : null}
      {props.unread ? (
        <View className="size-2 rounded-full" style={{ backgroundColor: palette.dot }} />
      ) : null}
    </Row>
  );
}
