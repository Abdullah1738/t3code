import {
  askAfterAnswer,
  askAsker,
  askHistoryFacts,
  avatarOf,
  shortWhen,
  type AskOutcome,
  type AskSend,
} from "@t3tools/client-runtime/ardud/kanban";
import type { KanbanAskFeedItem } from "@t3tools/contracts";
import { type ReactNode, useEffect, useState } from "react";
import { Pressable, RefreshControl, ScrollView, View } from "react-native";

import { AppText as Text } from "../../../components/ui/AppText";
import { LoadingLine } from "../../common/FeedError";
import { useNowMs } from "../../common/hooks";
import { MarkdownText } from "../../common/MarkdownText";
import { resolveKanbanLinkFor } from "../Chat";
import { Avatar } from "../parts";
import { DiffText } from "./AskParts";
import { useAsk, useAsks, useOwnerStanding, useWatchAsks } from "./askStore";
import { historyRows } from "./logic";
import { useNeedsYouNav } from "./nav";
import { Screen, useBottomInset } from "./Screen";
import { AskToastBar, Band, BarButton, Label, OfflineBand, UnreadableLine } from "./ui";
import { useQueue } from "./useQueue";

/** What he answered in the last week, newest first, and what each agent said next. */
export function HistoryRouteScreen() {
  const asks = useAsks();
  const nav = useNeedsYouNav();
  const nowMs = useNowMs();
  const bottomInset = useBottomInset();
  useWatchAsks(false);
  useOwnerStanding();
  const queue = useQueue(nowMs);
  const closed = useAsk((state) => state.closed);
  const unreadableClosed = useAsk((state) => state.unreadableClosed);
  const status = useAsk((state) => state.closedStatus);
  const sent = useAsk((state) => state.sent);
  const heldId = useAsk((state) => state.held?.payload.id ?? null);
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => {
    void asks.loadClosedAsks();
  }, [asks]);
  const rows = historyRows(closed, sent, nowMs);
  const owed = queue.needsYou.items.filter((item) => !queue.hidden.has(item.key)).length;
  const waiting = queue.needsYou.counts.agent + queue.needsYou.counts.evaluator;
  // Closed asks that came but can't be read: History is then not the whole of it.
  const incomplete = unreadableClosed.length > 0;
  const facts = askHistoryFacts({ today: rows.today, waiting, toAnswer: owed, incomplete });
  const refresh = () => {
    setRefreshing(true);
    const done = () => setRefreshing(false);
    void asks.loadClosedAsks().then(done, done);
  };
  const undo = () => {
    // The row offers Undo for a held answer only: nothing else is ever undone from here.
    const key = asks.undoAskSend("held");
    if (key === null) return;
    const batch = /^batch:([^:]+):(.*)$/.exec(key);
    if (batch) nav.openBatch(batch[1]!, batch[2]!);
    else nav.openAsk(key);
  };
  const list = (items: typeof rows.today) =>
    items.map(({ entry, outcome }) => (
      <ClosedRow
        key={`${entry.cardId}:${entry.ask.id}`}
        entry={entry}
        outcome={outcome}
        nowMs={nowMs}
        onOpenCard={() => nav.openCard(entry.boardId, entry.cardId)}
        onOpenThread={nav.openThread}
      />
    ));
  return (
    <Screen title="History" onBack={nav.back}>
      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: bottomInset + 84, gap: 12 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
      >
        <OfflineBand />
        {/* Said first, with the cards that are known: what follows is not everything he answered. */}
        <UnreadableLine closed asks={unreadableClosed} onOpenCard={nav.openCard} />
        {closed === null && status !== "error" ? <LoadingLine /> : null}
        {closed === null && status === "error" ? (
          <Band
            tone="negative"
            action={{ label: "Retry", onPress: () => void asks.loadClosedAsks() }}
          >
            Couldn't load History.
          </Band>
        ) : null}
        {rows.session.map((send) => (
          <SessionRow
            key={send.id}
            send={send}
            held={heldId === send.id}
            onUndo={undo}
            onOpenThread={nav.openThread}
          />
        ))}
        {closed !== null ? (
          <>
            <Label className="px-1 pt-1">Today</Label>
            {rows.today.length > 0 ? (
              list(rows.today)
            ) : rows.session.length === 0 && !incomplete ? (
              // Only when all of History could be read: otherwise "nothing" is not known.
              <Text className="px-1 text-sm text-foreground-muted">
                Nothing answered yet today.
              </Text>
            ) : null}
            {rows.earlier.length > 0 ? (
              <>
                <Label className="px-1 pt-3">Earlier this week</Label>
                {list(rows.earlier)}
              </>
            ) : null}
          </>
        ) : null}
        <View className="mt-2 gap-1.5 rounded-2xl bg-card px-3.5 py-3">
          <Label>Today</Label>
          {facts.map(({ name, value, spoken }) => (
            <View
              key={name}
              accessible
              accessibilityLabel={`${name}: ${spoken}`}
              className="flex-row items-baseline justify-between gap-4"
            >
              <Text className="text-sm text-foreground">{name}</Text>
              <Text className="text-sm font-t3-medium tabular-nums text-foreground">{value}</Text>
            </View>
          ))}
        </View>
        <BarButton label="Back to Needs you" onPress={nav.openQueue} />
      </ScrollView>
      <AskToastBar bottom={bottomInset + 8} onUndo={() => undefined} onView={nav.openAsk} />
    </Screen>
  );
}

function Row(props: {
  readonly board: string;
  readonly cardNumber: number | null;
  readonly when: string;
  readonly title: string;
  readonly onOpenCard?: (() => void) | undefined;
  readonly children: ReactNode;
}) {
  return (
    <View className="gap-2.5 rounded-2xl bg-card p-3.5">
      <View className="gap-1">
        <View className="flex-row flex-wrap items-center gap-x-2.5">
          <Text className="text-sm font-t3-medium text-foreground">{props.board}</Text>
          {props.cardNumber !== null && props.onOpenCard ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Open card #${props.cardNumber}`}
              hitSlop={12}
              onPress={props.onOpenCard}
            >
              <Text className="text-sm font-t3-medium tabular-nums text-primary-text">
                #{props.cardNumber}
              </Text>
            </Pressable>
          ) : null}
          <Text className="text-sm tabular-nums text-foreground-muted">{props.when}</Text>
        </View>
        <Text accessibilityRole="header" className="text-base font-t3-semibold text-foreground">
          {props.title}
        </Text>
      </View>
      {props.children}
    </View>
  );
}

function Line(props: { readonly who: ReactNode; readonly children: ReactNode }) {
  return (
    <View className="flex-row items-start gap-2.5">
      {props.who}
      <View className="min-w-0 flex-1 gap-1 pt-0.5">{props.children}</View>
    </View>
  );
}

const You = <Avatar kind="owner" letter="Y" label="You" />;

function ThreadLink(props: { readonly onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      hitSlop={8}
      onPress={props.onPress}
      className="min-h-11 justify-center self-start"
    >
      <Text className="text-sm font-t3-medium text-primary-text">Evaluator thread</Text>
    </Pressable>
  );
}

function Outcome(props: {
  readonly outcome: AskOutcome;
  readonly onOpenThread: (threadId: string) => void;
}) {
  const { outcome } = props;
  return (
    <>
      <Text className="text-base text-foreground">
        <Text className="font-t3-semibold">{outcome.label}</Text>
        {outcome.text ? `: ${outcome.text}` : ""}
      </Text>
      {outcome.draft ? (
        <View className="gap-1">
          <Label>Your changes to the draft</Label>
          <View className="rounded-xl bg-screen p-3">
            <DiffText before={outcome.draft.before} after={outcome.draft.after} side="both" />
          </View>
        </View>
      ) : null}
      {outcome.values.length > 0 ? (
        <View className="gap-1">
          {outcome.values.map(([name, value]) => (
            <View key={name} className="flex-row items-baseline gap-3">
              <Text className="text-sm text-foreground-muted">{name}</Text>
              <Text className="min-w-0 flex-1 text-sm tabular-nums text-foreground">{value}</Text>
            </View>
          ))}
        </View>
      ) : null}
      {outcome.note ? (
        <View>
          <Label>Your note</Label>
          <Text className="text-base text-foreground">{outcome.note}</Text>
        </View>
      ) : null}
      {outcome.evaluatorThreadId ? (
        <ThreadLink onPress={() => props.onOpenThread(outcome.evaluatorThreadId!)} />
      ) : null}
    </>
  );
}

/** An answer of this session that the closed list does not carry yet, or never will (a hand-over). */
function SessionRow(props: {
  readonly send: AskSend;
  readonly held: boolean;
  readonly onUndo: () => void;
  readonly onOpenThread: (threadId: string) => void;
}) {
  const { send } = props;
  const pending = send.state !== "sent";
  const threadId = send.evaluator?.started ? send.evaluator.threadId : null;
  return (
    <Row
      board={send.boardName}
      cardNumber={null}
      when={pending ? "now" : "this session"}
      title={send.title}
    >
      <Line who={You}>
        <Text className="text-base text-foreground">
          <Text className="font-t3-semibold">{send.label}</Text>
          {send.hand?.text ? `, with: ${send.hand.text}` : ""}
          {send.body.text ? `: ${send.body.text}` : ""}
        </Text>
        {send.body.note ? (
          <View>
            <Label>Your note</Label>
            <Text className="text-base text-foreground">{send.body.note}</Text>
          </View>
        ) : null}
        {pending ? (
          <View className="flex-row items-center gap-3">
            <Text className="text-sm text-foreground-muted">
              {props.held ? "Sending. You can still undo." : "Sending."}
            </Text>
            {props.held ? (
              <Pressable
                accessibilityRole="button"
                hitSlop={8}
                onPress={props.onUndo}
                className="min-h-11 justify-center"
              >
                <Text className="text-sm font-t3-semibold text-primary-text">Undo</Text>
              </Pressable>
            ) : null}
          </View>
        ) : threadId ? (
          <ThreadLink onPress={() => props.onOpenThread(threadId)} />
        ) : send.evaluator && !send.evaluator.started ? (
          <Text className="text-sm text-danger-foreground">
            Handed over, but the evaluator thread did not start
            {send.evaluator.error ? `: ${send.evaluator.error}` : "."}
          </Text>
        ) : null}
      </Line>
    </Row>
  );
}

function ClosedRow(props: {
  readonly entry: KanbanAskFeedItem;
  readonly outcome: AskOutcome;
  readonly nowMs: number;
  readonly onOpenCard: () => void;
  readonly onOpenThread: (threadId: string) => void;
}) {
  const { entry, outcome } = props;
  const after = askAfterAnswer(entry).at(-1);
  const said = after?.blocks.find((block) => block._tag === "md");
  const face = after ? avatarOf(after.author, after.authorName) : null;
  return (
    <Row
      board={entry.boardName}
      cardNumber={entry.cardNumber}
      when={shortWhen(entry.ask.answer!.at, props.nowMs)}
      title={entry.ask.title ?? entry.cardTitle}
      onOpenCard={props.onOpenCard}
    >
      <Line who={You}>
        <Outcome outcome={outcome} onOpenThread={props.onOpenThread} />
      </Line>
      {after && face && said?._tag === "md" ? (
        <Line who={<Avatar kind={face.kind} letter={face.letter} label={after.authorName} />}>
          <MarkdownText
            text={said.text}
            maxLines={8}
            resolveKanbanLink={resolveKanbanLinkFor(entry.boardId)}
          />
        </Line>
      ) : entry.ask.answer!.by._tag === "owner" ? (
        <Text className="text-sm text-foreground-muted">Went to {askAsker(entry)}.</Text>
      ) : null}
    </Row>
  );
}
