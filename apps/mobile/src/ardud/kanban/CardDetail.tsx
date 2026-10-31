import type { KanbanCard, KanbanThreadLink } from "@t3tools/contracts";
import {
  askViews,
  cardView,
  modelName,
  modelVariant,
  STAGE_LABELS,
  subtaskOwnerLabel,
  subtaskSteps,
  type CardSteps,
  type KanbanBoardState,
} from "@t3tools/client-runtime/ardud/kanban";
import { clockLabel } from "@t3tools/client-runtime/ardud/common";
import { type ReactNode, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { ControlPill } from "../../components/ui/ControlPill";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { FeedError, LoadingLine } from "../common/FeedError";
import { ActionButton, EmptyLine } from "../common/parts";
import { confirmAction, useBoardAction } from "../common/hooks";
import { Chat } from "./Chat";
import { copyLinkAction } from "./copyLink";
import { kanbanClient, useKanbanCard, useKanbanCardFeed } from "./kanbanStore";
import { cardGlyph, prGlyph, stageGlyph } from "./logic";
import { ChipLink, DetailRow, FlagLine, Glyph, KChip, PriorityBars, UnderlineTabs } from "./parts";

type CardTab = "details" | "discussion" | "threads";

const ROLE_LABEL: Record<KanbanThreadLink["role"], string> = {
  work: "Worker",
  review: "Reviewer",
  evaluator: "Evaluator",
};

/** Neighbours on the board and what Settle opens next, for the card's stepper. */
export interface CardStepper {
  readonly steps: CardSteps;
  readonly onStep: (cardId: string) => void;
  /** Settle left nothing to open: close the card. */
  readonly onDone: () => void;
}

/** One card: title and chips, then its details, discussion and threads. */
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
  /** Up and down between neighbours, and Settle's next card. Omit when not over the board. */
  readonly stepper?: CardStepper;
}) {
  const card = props.state.cards.get(props.cardId);
  const [tab, setTab] = useState<CardTab>("details");
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
        stepper={props.stepper}
        onOpenGoal={props.onOpenGoal}
        onAnswer={() => setTab("discussion")}
      />
      <UnderlineTabs
        accessibilityLabel="Card"
        className="-mx-4"
        tabs={[
          { value: "details", label: "Details" },
          { value: "discussion", label: "Discussion" },
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
  readonly stepper: CardStepper | undefined;
  readonly onOpenGoal: (goalId: string) => void;
  readonly onAnswer: () => void;
}) {
  const { card, stepper } = props;
  const view = cardView(card, props.state, props.nowMs);
  const asks = askViews(card, props.nowMs);
  const goal = view.goal;
  return (
    <View className="gap-2.5 pt-2">
      {props.onClose ? (
        <View className="flex-row items-center gap-2">
          <PriorityBars priority={card.priority} />
          <Text className="flex-1 text-[13px] text-foreground-muted">{card.number}</Text>
          {stepper ? (
            <>
              <ControlPill
                icon="chevron.up"
                accessibilityLabel="Previous card"
                disabled={stepper.steps.previous === null}
                onPress={() => stepper.steps.previous && stepper.onStep(stepper.steps.previous)}
              />
              <ControlPill
                icon="chevron.down"
                accessibilityLabel="Next card"
                disabled={stepper.steps.next === null}
                onPress={() => stepper.steps.next && stepper.onStep(stepper.steps.next)}
              />
            </>
          ) : null}
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
      {view.flag?.kind === "ask" && asks.length > 0 ? null : (
        <FlagLine flag={view.flag} lines={6} />
      )}
      <OwnerAsks card={card} asks={asks} onAnswer={props.onAnswer} />
      {card.description.trim() ? (
        <Text selectable className="text-[15px] leading-[22px] text-foreground">
          {card.description}
        </Text>
      ) : null}
      <View className="flex-row flex-wrap gap-2">
        <ActionButton
          label="Copy link"
          onPress={copyLinkAction("kanban-card", card.id, `#${card.number} ${card.title}`).onPress}
        />
        <CardActions card={card} stepper={stepper} />
      </View>
    </View>
  );
}

/** Open questions for the owner; Answer opens the card's discussion. */
function OwnerAsks(props: {
  readonly card: KanbanCard;
  readonly asks: ReturnType<typeof askViews>;
  readonly onAnswer: () => void;
}) {
  const { card } = props;
  const action = useBoardAction();
  if (props.asks.length === 0) return null;
  return (
    <View className="gap-3 rounded-2xl bg-warning px-3.5 py-3">
      {props.asks.map((ask) => (
        <View key={ask.id} className="gap-2">
          <View className="flex-row items-start gap-2">
            <View className="pt-[5px]">
              <Glyph kind={ask.blocking ? "wait" : "ask"} />
            </View>
            <View className="flex-1 gap-0.5">
              <Text selectable className="text-[15px] leading-[21px] text-foreground">
                {ask.text}
              </Text>
              <Text className="text-[13px] text-foreground-muted">
                {ask.by} · {ask.age} · {ask.blocking ? "Card waits" : "Work goes on"}
              </Text>
            </View>
          </View>
          <View className="flex-row flex-wrap gap-2 ps-[18px]">
            <ActionButton label="Answer" onPress={props.onAnswer} />
            {ask.blocking ? null : (
              <ActionButton
                label="Make blocking"
                disabled={action.pending}
                onPress={() =>
                  void action.run("Couldn't make it blocking", () =>
                    kanbanClient().changeAsk(card.id, ask.id, "block"),
                  )
                }
              />
            )}
            <ActionButton
              label="Drop"
              disabled={action.pending}
              onPress={() =>
                void action.run("Couldn't drop the question", () =>
                  kanbanClient().changeAsk(card.id, ask.id, "drop"),
                )
              }
            />
          </View>
        </View>
      ))}
    </View>
  );
}

/** Settle once verified, Stop while a thread runs, back to To-Do from Needs Owner. */
function CardActions(props: {
  readonly card: KanbanCard;
  readonly stepper: CardStepper | undefined;
}) {
  const { card, stepper } = props;
  const action = useBoardAction();
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
          onPress={() => {
            // Read before settling: once settled, the card leaves the Verified list.
            const after = stepper?.steps.afterSettle ?? null;
            void action
              .run("Couldn't settle", () => kanbanClient().settleCard(card.id))
              .then((ok) => {
                if (!ok || !stepper) return;
                if (after !== null) stepper.onStep(after);
                else stepper.onDone();
              });
          }}
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
  const action = useBoardAction();
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
        <Text className="text-[14px] text-foreground">
          {card.priority === 5 ? "Backlog" : `P${card.priority}`}
        </Text>
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
      {card.models.length > 1 && card.workThreadId === null ? (
        // Not started yet: it goes to the highest weight with room.
        <DetailRow label="Models">
          {card.models.map((entry) => (
            <KChip
              key={`${entry.model.instanceId}/${entry.model.model}#${modelVariant(entry.model) ?? ""}`}
              label={`${modelName(entry.model)} ${entry.weight}`}
            />
          ))}
        </DetailRow>
      ) : (
        <DetailRow label="Model">
          <KChip label={modelName(card.model)} />
          {variant ? <KChip label={variant} /> : null}
        </DetailRow>
      )}
      <DetailRow label="Links">
        {card.links.length > 0 ? (
          card.links.map((link) => (
            <ChipLink
              key={link.url}
              label={link.label ?? linkLabel(link.url)}
              glyph={link.kind === "pr" ? prGlyph(link.state) : null}
              accessibilityHint="Long-press to remove"
              onPress={() =>
                void tryOpenExternalUrl(
                  link.url,
                  link.kind === "pr" ? "pull-request" : "markdown-link",
                )
              }
              onLongPress={() =>
                confirmAction({
                  title: "Remove this link?",
                  message: link.label ?? link.url,
                  confirmLabel: "Remove",
                  destructive: true,
                  onConfirm: () =>
                    void action.run("Couldn't remove the link", () =>
                      kanbanClient().patchCard({ cardId: card.id, removeLinks: [link.url] }),
                    ),
                })
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
      <CardSubtasks card={card} />
    </View>
  );
}

/** The card's plan, step by step. Agents mark it; the owner reads it here. */
function CardSubtasks(props: { readonly card: KanbanCard }) {
  const steps = subtaskSteps(props.card);
  if (steps.length === 0) return null;
  return (
    <View className="gap-3 pt-3">
      <Text className="text-[13px] text-foreground-muted">Subtasks</Text>
      {steps.map((step) => (
        <View key={step.step} className="flex-row gap-2">
          <Text
            className={
              step.when === "now"
                ? "w-5 text-[13px] font-semibold text-foreground"
                : "w-5 text-[13px] text-foreground-muted"
            }
          >
            {step.step}
          </Text>
          <View className="min-w-0 flex-1 gap-2">
            {step.subtasks.map((subtask) => (
              <View key={subtask.id} className="flex-row items-start gap-2">
                <View className="pt-[5px]">
                  <Glyph
                    kind={
                      subtask.state === "done"
                        ? "done"
                        : subtask.state === "open" && step.when === "now"
                          ? "ok"
                          : "idle"
                    }
                  />
                </View>
                <View className="min-w-0 flex-1">
                  <Text
                    className={
                      subtask.state === "skipped"
                        ? "text-[14px] text-foreground-muted line-through"
                        : step.when === "later"
                          ? "text-[14px] text-foreground-muted"
                          : "text-[14px] text-foreground"
                    }
                  >
                    {subtask.text}
                  </Text>
                  <Text className="text-[12px] text-foreground-muted">
                    {subtaskOwnerLabel(subtask)}
                    {subtask.note ? ` · ${subtask.note}` : ""}
                  </Text>
                </View>
              </View>
            ))}
          </View>
        </View>
      ))}
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
