import type { KanbanCard, KanbanThreadLink } from "@t3tools/contracts";
import {
  cardView,
  modelName,
  modelVariant,
  STAGE_LABELS,
  type KanbanBoardState,
} from "@t3tools/client-runtime/ardud/kanban";
import { clockLabel } from "@t3tools/client-runtime/ardud/missions/mobile";
import { type ReactNode, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { FeedError, LoadingLine } from "../missions/FeedError";
import { ActionButton, EmptyLine } from "../missions/parts";
import { confirmAction, useMissionAction } from "../missions/useMissionsLogic";
import { Chat } from "./Chat";
import { kanbanClient, useKanbanCard, useKanbanCardFeed } from "./kanbanStore";
import { cardGlyph, prGlyph, stageGlyph } from "./logic";
import { ChipLink, DetailRow, FlagLine, Glyph, KChip, PriorityBars, UnderlineTabs } from "./parts";

type CardTab = "discussion" | "details" | "threads";

const ROLE_LABEL: Record<KanbanThreadLink["role"], string> = {
  work: "Worker",
  review: "Reviewer",
  evaluator: "Evaluator",
};

/** One card: title and chips, then its discussion, details and threads. */
export function CardDetail(props: {
  readonly boardId: string;
  readonly state: KanbanBoardState;
  readonly cardId: string;
  readonly nowMs: number;
  readonly bottomInset: number;
  readonly onOpenCard: (cardId: string) => void;
  readonly onOpenGoal: (goalId: string) => void;
  readonly onOpenThread: (threadId: string) => void;
  /** Shown in a pane beside the board: a close button and the number in the header. */
  readonly onClose?: () => void;
}) {
  const card = props.state.cards.get(props.cardId);
  const [tab, setTab] = useState<CardTab>("discussion");
  // A discussion made by the first message, until the card's own change lands.
  const [createdId, setCreatedId] = useState<string | null>(null);
  if (card === undefined) return <EmptyLine label="This card is gone." />;

  const header = (
    <View className="gap-3 pb-1">
      <CardHeader
        card={card}
        state={props.state}
        nowMs={props.nowMs}
        onClose={props.onClose}
        onOpenGoal={props.onOpenGoal}
      />
      <UnderlineTabs
        accessibilityLabel="Card"
        className="-mx-4"
        tabs={[
          { value: "discussion", label: "Discussion" },
          { value: "details", label: "Details" },
          { value: "threads", label: "Threads" },
        ]}
        selected={tab}
        onSelect={setTab}
      />
    </View>
  );

  if (tab === "discussion") {
    const discussionId = card.discussionId ?? createdId;
    return (
      <Chat
        key={card.id}
        boardId={props.boardId}
        state={props.state}
        discussionId={discussionId}
        ensureDiscussion={async () => {
          const discussion = await kanbanClient().cardDiscussion(props.boardId, card.id);
          setCreatedId(discussion.id);
          return discussion.id;
        }}
        nowMs={props.nowMs}
        bottomInset={props.bottomInset}
        onOpenCard={props.onOpenCard}
        header={header}
        startAtEnd={false}
      />
    );
  }

  return (
    <ScrollView
      className="flex-1"
      contentContainerClassName="gap-3 px-4 pt-2"
      contentContainerStyle={{ paddingBottom: props.bottomInset + 16 }}
    >
      {header}
      {tab === "details" ? (
        <CardFacts
          card={card}
          state={props.state}
          onOpenCard={props.onOpenCard}
          onOpenGoal={props.onOpenGoal}
        />
      ) : (
        <CardThreads
          boardId={props.boardId}
          cardId={card.id}
          nowMs={props.nowMs}
          onOpenThread={props.onOpenThread}
        />
      )}
    </ScrollView>
  );
}

function CardHeader(props: {
  readonly card: KanbanCard;
  readonly state: KanbanBoardState;
  readonly nowMs: number;
  readonly onClose: (() => void) | undefined;
  readonly onOpenGoal: (goalId: string) => void;
}) {
  const { card } = props;
  const view = cardView(card, props.state, props.nowMs);
  const goal = view.goal;
  return (
    <View className="gap-2.5 pt-2">
      {props.onClose ? (
        <View className="flex-row items-center gap-2">
          <PriorityBars priority={card.priority} />
          <Text className="flex-1 text-[13px] text-foreground-muted">{card.number}</Text>
          <ActionButton label="Close" onPress={props.onClose} />
        </View>
      ) : null}
      <Text
        accessibilityRole="header"
        selectable
        className="text-[21px] font-t3-bold leading-7 text-foreground"
      >
        {card.title}
      </Text>
      <View className="flex-row flex-wrap gap-1.5">
        <KChip label={view.stageLabel} glyph={cardGlyph(card)} />
        {goal ? <ChipLink label={goal.name} onPress={() => props.onOpenGoal(goal.id)} /> : null}
        {view.pr ? (
          <ChipLink
            label={view.pr.label}
            glyph={prGlyph(view.pr.state)}
            onPress={() => void tryOpenExternalUrl(view.pr!.url, "pull-request")}
          />
        ) : null}
        {view.model.name ? <KChip label={view.model.name} /> : null}
      </View>
      <FlagLine flag={view.flag} lines={6} />
      {card.description.trim() ? (
        <Text selectable className="text-[15px] leading-[22px] text-foreground">
          {card.description}
        </Text>
      ) : null}
      <CardActions card={card} />
    </View>
  );
}

/** Settle once verified, Stop while a thread runs, back to To-Do from Needs Owner. */
function CardActions(props: { readonly card: KanbanCard }) {
  const { card } = props;
  const action = useMissionAction();
  const canSettle = card.stage === "verified" && card.settledAt === null;
  const canStop = card.activeThreadId !== null;
  const canQueue = card.stage === "needs_owner";
  if (!canSettle && !canStop && !canQueue) return null;
  return (
    <View className="flex-row flex-wrap gap-2">
      {canSettle ? (
        <ActionButton
          label="Settle"
          primary
          disabled={action.pending}
          onPress={() =>
            void action.run("Couldn't settle", () => kanbanClient().settleCard(card.id))
          }
        />
      ) : null}
      {canQueue ? (
        <ActionButton
          label="Move to To-Do"
          disabled={action.pending}
          onPress={() =>
            void action.run("Couldn't move the card", () =>
              kanbanClient().patchCard({ cardId: card.id, stage: "todo" }),
            )
          }
        />
      ) : null}
      {canStop ? (
        <ActionButton
          label="Stop"
          disabled={action.pending}
          onPress={() =>
            confirmAction({
              title: "Stop this card?",
              message: `The running thread on #${card.number} stops.`,
              confirmLabel: "Stop",
              destructive: true,
              onConfirm: () =>
                void action.run("Couldn't stop", () => kanbanClient().stopCard(card.id)),
            })
          }
        />
      ) : null}
    </View>
  );
}

function CardFacts(props: {
  readonly card: KanbanCard;
  readonly state: KanbanBoardState;
  readonly onOpenCard: (cardId: string) => void;
  readonly onOpenGoal: (goalId: string) => void;
}) {
  const { card, state } = props;
  const goal = card.goalId === null ? undefined : state.goals.get(card.goalId);
  const variant = modelVariant(card.model);
  const chainName = card.reviewChain ?? state.board.defaultReviewChain;
  const chain = state.board.reviewChains.find((entry) => entry.name === chainName);
  return (
    <View>
      <DetailRow label="Stage">
        <KChip label={STAGE_LABELS[card.stage]} glyph={cardGlyph(card)} />
      </DetailRow>
      <DetailRow label="Priority">
        <PriorityBars priority={card.priority} />
        <Text className="text-[14px] text-foreground">P{card.priority}</Text>
      </DetailRow>
      <DetailRow label="Goal">
        {goal ? <ChipLink label={goal.name} onPress={() => props.onOpenGoal(goal.id)} /> : <Dash />}
      </DetailRow>
      <DetailRow label="Projects">
        {card.projects.length > 0 ? (
          card.projects.map((project) => <KChip key={project} label={project} />)
        ) : (
          <Dash />
        )}
      </DetailRow>
      <DetailRow label="Model">
        <KChip label={modelName(card.model)} />
        {variant ? <KChip label={variant} /> : null}
      </DetailRow>
      <DetailRow label="Links">
        {card.links.length > 0 ? (
          card.links.map((link) => (
            <ChipLink
              key={link.url}
              label={link.label ?? linkLabel(link.url)}
              glyph={link.kind === "pr" ? prGlyph(link.state) : null}
              onPress={() =>
                void tryOpenExternalUrl(
                  link.url,
                  link.kind === "pr" ? "pull-request" : "markdown-link",
                )
              }
            />
          ))
        ) : (
          <Dash />
        )}
      </DetailRow>
      <DetailRow label="Blocked by">
        {card.blockedBy.length > 0 ? (
          card.blockedBy.map((id) => {
            const blocker = state.cards.get(id);
            return blocker ? (
              <ChipLink
                key={id}
                label={String(blocker.number)}
                glyph={stageGlyph(blocker.stage)}
                accessibilityLabel={`${blocker.number}, ${blocker.title}`}
                onPress={() => props.onOpenCard(id)}
              />
            ) : (
              <KChip key={id} label={id} />
            );
          })
        ) : (
          <Dash />
        )}
      </DetailRow>
      <DetailRow label="Review">
        {chain && chain.steps.length > 0 ? (
          chain.steps.map((step, index) => (
            // oxlint-disable-next-line react/no-array-index-key -- a chain may repeat a model
            <Steps key={index} first={index === 0}>
              <KChip label={modelName(step)} />
            </Steps>
          ))
        ) : (
          <Dash />
        )}
      </DetailRow>
    </View>
  );
}

function Steps(props: { readonly first: boolean; readonly children: ReactNode }) {
  return (
    <View className="flex-row items-center gap-1.5">
      {props.first ? null : (
        <SymbolView
          name="chevron.right"
          size={10}
          tintColorClassName="accent-icon-muted"
          type="monochrome"
        />
      )}
      {props.children}
    </View>
  );
}

function Dash() {
  return <Text className="text-[14px] text-foreground-muted">-</Text>;
}

function linkLabel(url: string): string {
  const pr = /github\.com\/[^/]+\/([^/]+)\/pull\/(\d+)/.exec(url);
  if (pr) return `${pr[1]}#${pr[2]}`;
  const linear = /linear\.app\/[^/]+\/issue\/([A-Z]+-\d+)/i.exec(url);
  if (linear) return linear[1]!.toUpperCase();
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function CardThreads(props: {
  readonly boardId: string;
  readonly cardId: string;
  readonly nowMs: number;
  readonly onOpenThread: (threadId: string) => void;
}) {
  const detail = useKanbanCard(props.boardId, props.cardId);
  const feed = useKanbanCardFeed(props.boardId, props.cardId);
  if (detail === undefined) {
    return feed.failure ? (
      <FeedError what="the threads" feed={feed} nowMs={props.nowMs} />
    ) : (
      <LoadingLine />
    );
  }
  const threads = [...detail.threads].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  if (threads.length === 0) return <EmptyLine label="No threads" />;
  return (
    <View className="gap-1.5">
      {threads.map((thread) => (
        <ThreadRow
          key={thread.threadId}
          thread={thread}
          nowMs={props.nowMs}
          onOpen={() => props.onOpenThread(thread.threadId)}
        />
      ))}
    </View>
  );
}

function ThreadRow(props: {
  readonly thread: KanbanThreadLink;
  readonly nowMs: number;
  readonly onOpen: () => void;
}) {
  const { thread } = props;
  const running = thread.endedAt === null;
  const started = clockLabel(thread.startedAt, props.nowMs);
  const ended = thread.endedAt ? clockLabel(thread.endedAt, props.nowMs) : null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${ROLE_LABEL[thread.role]}, ${running ? "running" : "ended"}`}
      onPress={props.onOpen}
      className="min-h-12 flex-row items-center gap-2.5 rounded-[12px] bg-card px-3 py-2.5"
    >
      <Glyph kind={running ? "ok" : "done"} />
      <Text className="text-[15px] font-t3-medium text-foreground">{ROLE_LABEL[thread.role]}</Text>
      {thread.model ? <KChip label={modelName(thread.model)} /> : null}
      <View className="flex-1" />
      <Text className="text-[12px] text-foreground-muted">
        {ended ? `${started} - ${ended}` : started}
      </Text>
      <SymbolView
        name="chevron.right"
        size={11}
        tintColorClassName="accent-icon-muted"
        type="monochrome"
      />
    </Pressable>
  );
}
