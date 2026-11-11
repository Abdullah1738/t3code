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
import { messageReadWhole } from "../logic";
import { useAskScope, useLateStanding, useOwnerStanding, useWatchAsks } from "./askStore";
import { askKeyFromParams, askTurn, ownerStandingBarText, type NeedsYouAskParams } from "./logic";
import { useNeedsYouNav } from "./nav";
import { Screen, useBottomInset } from "./Screen";
import { OwnerBand, OfflineBand } from "./ui";
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
  const { serial } = useAskScope();
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
        // A draft typed for one server never shows under another's ask.
        key={`${serial}:${askKey(entry)}`}
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
  const { asks, api } = useAskScope();
  const late = useLateStanding();
  const { entry } = props;
  const { standing } = useOwnerStanding();
  // What was said counts; older versions of the ask sit between, folded away.
  const thread = askThread(entry);
  // The feed cuts big blocks short. "Show full" reads that one message whole,
  // from the server this ask came from, and keeps it for as long as he is here.
  const [whole, setWhole] = useState<Readonly<Record<number, KanbanMessage>>>({});
  const loadFull = async (seq: number) => {
    const message = thread.find((item) => item.message.seq === seq)?.message;
    if (message === undefined) return;
    const full = await api.message(message.discussionId, seq);
    // Read from a server that is no longer in use: it is not shown.
    if (late() === "gone") return;
    setWhole((current) => ({ ...current, [seq]: full }));
  };
  // A reply over a limit is told here, beside the composer that still holds it.
  const [problem, setProblem] = useState<string | null>(null);
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  // How many messages the list had when it last jumped to its end.
  const followed = useRef(-1);
  return (
    <View className="flex-1">
      <ScrollView
        ref={scroll}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        contentContainerClassName="gap-3 px-4 pb-4 pt-4"
        onContentSizeChange={() => {
          // Follow the talk to its newest message, but leave him where he is
          // when a message he is reading grows ("Show full", a fold opened).
          if (followed.current === thread.length) return;
          followed.current = thread.length;
          scroll.current?.scrollToEnd({ animated: false });
        }}
      >
        <OwnerBand />
        <OfflineBand />
        {thread.length === 0 ? (
          <Text className="text-base text-foreground-muted">Nothing said yet.</Text>
        ) : (
          thread.map(({ message, earlier }) =>
            earlier ? (
              <EarlierVersion
                key={message.seq}
                boardId={entry.boardId}
                message={messageReadWhole(message, whole[message.seq])}
                nowMs={props.nowMs}
                onOpenCard={props.onOpenCard}
                onLoadFull={loadFull}
              />
            ) : (
              <MessageView
                key={message.seq}
                boardId={entry.boardId}
                // No discussion feed behind it here: a pick in it is read, not answered.
                discussionId={null}
                message={messageReadWhole(message, whole[message.seq])}
                nowMs={props.nowMs}
                onOpenCard={props.onOpenCard}
                onLoadFull={loadFull}
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
      {standing !== "owner" ? (
        <Text
          className="px-4 pt-2 text-sm text-foreground-muted"
          style={{ paddingBottom: props.bottomInset }}
        >
          {ownerStandingBarText(standing, "reply")}
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

/**
 * What the ask said before its agent edited it. It can be read in full (long
 * text, folds, pages, files), but nothing in it answers anything any more: it
 * is shown outside a discussion feed, so its picks are locked.
 */
function EarlierVersion(props: {
  readonly boardId: string;
  readonly message: KanbanMessage;
  readonly nowMs: number;
  readonly onOpenCard: (cardId: string) => void;
  readonly onLoadFull: (seq: number) => Promise<void>;
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
        <View className="border-t border-border px-3.5 py-3">
          <MessageView
            boardId={props.boardId}
            discussionId={null}
            message={props.message}
            nowMs={props.nowMs}
            onOpenCard={props.onOpenCard}
            onLoadFull={props.onLoadFull}
          />
        </View>
      ) : null}
    </View>
  );
}
