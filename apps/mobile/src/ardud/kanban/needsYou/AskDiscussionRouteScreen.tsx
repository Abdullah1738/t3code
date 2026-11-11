import type { StaticScreenProps } from "@react-navigation/native";
import {
  askAsker,
  askKey,
  askReplyProblem,
  askRepliedOnCard,
  askThread,
} from "@t3tools/client-runtime/ardud/kanban";
import type { KanbanAskFeedItem, KanbanMessage } from "@t3tools/contracts";
import { type ComponentRef, useRef, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";

import { SymbolView } from "../../../components/ui/AppSymbol";
import { AppText as Text } from "../../../components/ui/AppText";
import { LoadingLine } from "../../common/FeedError";
import { useNowMs } from "../../common/hooks";
import { Composer, MessageView } from "../Chat";
import { asks, useAsk, useOwnerStanding, useWatchAsks } from "./askStore";
import { askKeyFromParams, askTurn, type NeedsYouAskParams } from "./logic";
import { useNeedsYouNav } from "./nav";
import { Screen, useBottomInset } from "./Screen";
import { NotOwnerBand, OfflineBand } from "./ui";
import { useQueue } from "./useQueue";

/**
 * The talk under one ask, in the board's own message and composer parts. A
 * reply does not answer the ask: it hands the turn to its agent.
 */
export function AskDiscussionRouteScreen({
  route,
}: StaticScreenProps<NeedsYouAskParams | undefined>) {
  const nav = useNeedsYouNav();
  const nowMs = useNowMs();
  const bottomInset = useBottomInset();
  useWatchAsks(true);
  useOwnerStanding();
  const queue = useQueue(nowMs);
  const key = askKeyFromParams(route.params);
  const entry = key === null ? undefined : queue.entries.get(key);
  const item = key === null ? undefined : queue.items.get(key);
  if (entry === undefined || item === undefined) {
    return (
      <Screen title="Discussion" onBack={nav.back}>
        <View className="gap-2 px-4 pt-4">
          {queue.read ? (
            <Text className="text-base text-foreground-muted">This ask is closed.</Text>
          ) : (
            <LoadingLine />
          )}
        </View>
      </Screen>
    );
  }
  return (
    <Screen
      title="Discussion"
      subtitle={`${entry.boardName} #${entry.cardNumber}`}
      onBack={nav.back}
      actions={[
        {
          accessibilityLabel: `Open card #${entry.cardNumber}`,
          icon: "doc.text",
          onPress: () => nav.openCard(entry.boardId, entry.cardId),
        },
      ]}
    >
      <Talk
        key={askKey(entry)}
        entry={entry}
        waiting={askTurn(entry, item) === "agent" && !askRepliedOnCard(entry)}
        nowMs={nowMs}
        bottomInset={bottomInset}
        onOpenCard={(cardId) => nav.openCard(entry.boardId, cardId)}
      />
    </Screen>
  );
}

function Talk(props: {
  readonly entry: KanbanAskFeedItem;
  /** The ask waits on its agent after his reply. */
  readonly waiting: boolean;
  readonly nowMs: number;
  readonly bottomInset: number;
  readonly onOpenCard: (cardId: string) => void;
}) {
  const { entry } = props;
  const readOnly = useAsk((state) => state.notOwner !== null);
  // What was said counts; older versions of the ask sit between, folded away.
  const thread = askThread(entry);
  // A reply over a limit is told here, beside the composer that still holds it.
  const [problem, setProblem] = useState<string | null>(null);
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  return (
    <View className="flex-1">
      <ScrollView
        ref={scroll}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        contentContainerClassName="gap-3 px-4 pb-4 pt-4"
        onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: false })}
      >
        <NotOwnerBand />
        <OfflineBand />
        {thread.length === 0 ? (
          <Text className="text-base text-foreground-muted">Nothing said yet.</Text>
        ) : (
          thread.map(({ message, earlier }) =>
            earlier ? (
              <EarlierVersion
                key={message.seq}
                boardId={entry.boardId}
                message={message}
                nowMs={props.nowMs}
                onOpenCard={props.onOpenCard}
              />
            ) : (
              <MessageView
                key={message.seq}
                boardId={entry.boardId}
                discussionId={null}
                message={message}
                nowMs={props.nowMs}
                onOpenCard={props.onOpenCard}
              />
            ),
          )
        )}
        {props.waiting ? (
          <Text accessibilityLiveRegion="polite" className="text-sm text-foreground-muted">
            Waiting on {askAsker(entry)}.
          </Text>
        ) : null}
      </ScrollView>
      {readOnly ? (
        <Text
          className="px-4 pt-2 text-sm text-foreground-muted"
          style={{ paddingBottom: props.bottomInset }}
        >
          This phone can read asks, not reply to them.
        </Text>
      ) : (
        <View className="border-t border-border">
          {problem ? (
            <Text accessibilityRole="alert" className="px-4 pt-2 text-sm text-danger-foreground">
              {problem}
            </Text>
          ) : (
            <Text className="px-4 pt-2 text-2xs text-foreground-muted">
              Replying doesn't answer the ask.
            </Text>
          )}
          <Composer
            boardId={entry.boardId}
            discussionId={null}
            ensureDiscussion={() => Promise.resolve("")}
            bottomInset={props.bottomInset}
            placeholder="Ask the agent anything"
            onSent={() => scroll.current?.scrollToEnd({ animated: true })}
            post={(blocks) => {
              setProblem(askReplyProblem(blocks));
              return asks.replyOnAsk(entry, blocks);
            }}
          />
        </View>
      )}
    </View>
  );
}

/** What the ask said before its agent edited it, to read: its buttons no longer answer anything. */
function EarlierVersion(props: {
  readonly boardId: string;
  readonly message: KanbanMessage;
  readonly nowMs: number;
  readonly onOpenCard: (cardId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <View className="overflow-hidden rounded-2xl border border-border">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Earlier version of the ask"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
        className="min-h-11 flex-row items-center gap-2 px-3.5 active:bg-card"
      >
        <SymbolView
          name={open ? "chevron.down" : "chevron.right"}
          size={11}
          tintColorClassName="accent-icon-subtle"
          type="monochrome"
        />
        <Text className="text-sm text-foreground-muted">Earlier version</Text>
      </Pressable>
      {open ? (
        <View pointerEvents="none" className="border-t border-border px-3.5 py-3 opacity-80">
          <MessageView
            boardId={props.boardId}
            discussionId={null}
            message={props.message}
            nowMs={props.nowMs}
            onOpenCard={props.onOpenCard}
          />
        </View>
      ) : null}
    </View>
  );
}
