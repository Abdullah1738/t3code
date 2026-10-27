import { Link } from "@tanstack/react-router";
import { XIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import {
  askViews,
  cardView,
  modelName,
  modelVariant,
  STAGE_LABELS,
  SUBTASK_OWNER_LABELS,
  subtaskSteps,
  type KanbanBoardState,
} from "@t3tools/client-runtime/ardud/kanban";
import { ageView, formatDayLabel, formatTimeOfDay } from "@t3tools/client-runtime/ardud/common";
import {
  KANBAN_WS_METHODS,
  type KanbanCard,
  type KanbanCardEvent,
  type KanbanStage,
} from "@t3tools/contracts";

import {
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "../../components/ui/menu";
import { useStableCallback } from "../../hooks/useStableCallback";
import { cn } from "../../lib/utils";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useNowMs } from "./useNowMs";
import { CardDescription } from "./CardDescription";
import { PrGlyph } from "./CardTile";
import { Chat, Composer } from "./Chat";
import {
  kanban,
  kanbanErrorMessage,
  runAction,
  useCardDetail,
  useFeed,
  useKanbanPermission,
} from "./kanbanStore";
import { CopyLinkButton, KanbanMarkdown } from "./links";
import { Chip, Glyph, LinkChip, Pri, priorityLabel, stageGlyph, Tabs } from "./parts";

type DrawerTab = "details" | "discussion" | "threads" | "comments";

/** Stages the owner can move a card to; Working and In Review belong to the dispatcher. */
const OWNER_STAGES: ReadonlyArray<KanbanStage> = [
  "todo",
  "needs_review",
  "completed",
  "deployed",
  "verified",
  "needs_owner",
];

// Where focus goes when the drawer closes. Module state because opening a
// card from inside the drawer remounts it (keyed by card).
let drawerOpener: HTMLElement | null = null;

/**
 * Remembers what opened the drawer. Called at click time: once the drawer
 * renders, the page behind it is inert and focus has already moved.
 */
export function noteDrawerOpener() {
  if (document.querySelector("[data-kanban-drawer]")) return;
  const active = document.activeElement;
  drawerOpener = active instanceof HTMLElement && active !== document.body ? active : null;
}

export function CardDrawer(props: {
  boardId: string;
  cardId: string;
  state: KanbanBoardState;
  onClose: () => void;
  onOpenCard: (cardId: string) => void;
}) {
  const { boardId, state } = props;
  const card = state.cards.get(props.cardId);
  const detail = useCardDetail(boardId, props.cardId);
  const detailFeed = useFeed(kanban.card(boardId, props.cardId));
  const nowMs = useNowMs();
  const [tab, setTab] = useState<DrawerTab>("details");
  const panelRef = useRef<HTMLElement>(null);

  const onClose = useStableCallback(props.onClose);
  const canStop = useKanbanPermission(KANBAN_WS_METHODS.cardStop);
  const canSettle = useKanbanPermission(KANBAN_WS_METHODS.cardSettle);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented && !event.isComposing) {
        onClose();
        return;
      }
      // Tab stays inside the drawer; the page behind it is out of reach.
      const panel = panelRef.current;
      if (event.key !== "Tab" || panel === null) return;
      const stops = [
        ...panel.querySelectorAll<HTMLElement>(
          "a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])",
        ),
      ].filter((element) => element.getClientRects().length > 0);
      const first = stops[0];
      const last = stops.at(-1);
      if (first === undefined || last === undefined) return;
      const active = document.activeElement;
      if (!panel.contains(active)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && (active === first || active === panel)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // The drawer is keyed by card, so this runs once per opened card. Focus
  // goes back to what opened the first card of this drawer session.
  useEffect(() => {
    panelRef.current?.focus();
    return () => {
      // Another card replacing this one keeps the opener; closing returns to it.
      queueMicrotask(() => {
        if (document.querySelector("[data-kanban-drawer]")) return;
        if (drawerOpener?.isConnected) drawerOpener.focus();
        drawerOpener = null;
      });
    };
  }, []);

  if (!card) return null;
  const view = cardView(card, state, nowMs);
  const comments = (detail?.events ?? []).filter((event) => event.kind === "comment");
  const threads = detail?.threads ?? [];
  const linear = card.links.find((link) => link.kind === "linear");

  return (
    <>
      <div
        aria-hidden
        className="absolute inset-0 z-10 bg-(--m-ground)/55"
        onClick={props.onClose}
      />
      <aside
        ref={panelRef}
        tabIndex={-1}
        data-kanban-drawer
        role="dialog"
        aria-modal="true"
        aria-label={`Card ${card.number}`}
        className="absolute inset-y-0 right-0 z-20 flex w-full max-w-[540px] flex-col bg-(--m-raised) px-5.5 pt-4 shadow-xl ring-1 ring-(--m-rule) outline-none"
      >
        {/* Header scrolls and shrinks first on short windows, so the tabs and tab content stay in the drawer. */}
        <div className="flex min-h-0 shrink flex-col overflow-y-auto">
          <div className="flex items-center gap-2.5 text-sm text-(--m-muted)">
            <Pri priority={card.priority} />
            <span className="tabular-nums">#{card.number}</span>
            <span className="flex-1" />
            <CopyLinkButton
              kind="kanban-card"
              id={card.id}
              label={`#${card.number} ${card.title}`}
            />
            {card.activeThreadId ? (
              <ThreadLink threadId={card.activeThreadId}>Open</ThreadLink>
            ) : null}
            {card.activeThreadId ? (
              <QuietButton
                disabled={!canStop}
                title={canStop ? undefined : "Your connection can't stop cards"}
                onClick={() =>
                  void runAction("Couldn't stop the card", () => kanban.stopCard(card.id))
                }
              >
                Stop
              </QuietButton>
            ) : null}
            {card.stage === "verified" && card.settledAt === null ? (
              <button
                type="button"
                disabled={!canSettle}
                title={canSettle ? undefined : "Your connection can't settle cards"}
                onClick={() =>
                  void runAction("Couldn't settle the card", () => kanban.settleCard(card.id)).then(
                    (ok) => ok && props.onClose(),
                  )
                }
                className="h-7.5 rounded-full bg-(--m-chip) px-3 text-sm font-medium text-(--m-text) outline-none hover:bg-(--m-active) focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--m-accent)"
              >
                Settle
              </button>
            ) : null}
            <button
              type="button"
              onClick={props.onClose}
              aria-label="Close"
              className="grid size-7.5 place-items-center rounded-full text-(--m-muted) outline-none hover:bg-(--m-chip) hover:text-(--m-text) focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--m-accent)"
            >
              <XIcon className="size-4" />
            </button>
          </div>
          <h2 className="mt-2.5 mb-1.5 text-xl leading-tight font-semibold tracking-tight text-balance">
            {card.title}
          </h2>
          {card.description ? (
            <CardDescription key={card.description} text={card.description} />
          ) : null}
          <div className="mt-3 mb-3.5 flex flex-wrap gap-1.5">
            <Chip>
              <Glyph kind={stageGlyph(card.stage)} />
              {view.stageLabel}
            </Chip>
            {view.goal ? <Chip>{view.goal.name}</Chip> : null}
            {view.pr ? (
              <LinkChip href={view.pr.url}>
                <PrGlyph state={view.pr.state} />
                {view.pr.label}
              </LinkChip>
            ) : null}
            {linear ? <LinkChip href={linear.url}>{linear.label ?? "Linear"}</LinkChip> : null}
            <Chip>{view.model.name}</Chip>
          </div>
          <OwnerAsks card={card} nowMs={nowMs} onAnswer={() => setTab("discussion")} />
        </div>
        <Tabs
          label="Card"
          value={tab}
          onChange={setTab}
          options={[
            { value: "details", label: "Details" },
            { value: "discussion", label: "Discussion" },
            { value: "threads", label: "Threads", count: threads.length },
            { value: "comments", label: "Comments", count: comments.length },
          ]}
        />
        {detailFeed.failure ? (
          <p role="status" className="mt-2 flex items-center gap-3 text-sm text-(--m-muted)">
            <span className="min-w-0 flex-1 truncate">
              Couldn't load threads and comments. {kanbanErrorMessage(detailFeed.failure.error)}
            </span>
            <button
              type="button"
              onClick={detailFeed.retry}
              className="h-7 shrink-0 rounded-full bg-(--m-chip) px-3 font-medium text-(--m-text) outline-none hover:bg-(--m-active) focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--m-accent)"
            >
              Retry
            </button>
          </p>
        ) : null}
        {/* The asks list gives way so the tab content, and Answer's Discussion, stay on screen. */}
        <div className="flex min-h-48 flex-1 flex-col">
          {tab === "discussion" ? (
            <CardDiscussion
              boardId={boardId}
              card={card}
              state={state}
              onOpenCard={props.onOpenCard}
            />
          ) : tab === "details" ? (
            <Details card={card} state={state} events={detail?.events ?? []} nowMs={nowMs} />
          ) : tab === "threads" ? (
            <ThreadList threads={threads} state={state} nowMs={nowMs} />
          ) : (
            <Comments cardId={card.id} comments={comments} />
          )}
        </div>
      </aside>
    </>
  );
}

function CardDiscussion(props: {
  boardId: string;
  card: KanbanCard;
  state: KanbanBoardState;
  onOpenCard: (cardId: string) => void;
}) {
  const { boardId, card, state } = props;
  const discussion = card.discussionId ? state.discussions.get(card.discussionId) : undefined;
  const canPost = useKanbanPermission(KANBAN_WS_METHODS.messagePost);

  useEffect(() => {
    // The id is known but the list hasn't loaded it yet; the call returns the existing room.
    if (card.discussionId && !discussion && state.discussionsLoaded) {
      void kanban.cardDiscussion(boardId, card.id).catch(() => undefined);
    }
  }, [boardId, card.id, card.discussionId, discussion, state.discussionsLoaded]);

  // The first post creates the room and posts into it. This composer stays
  // mounted for that whole send, so a failed post keeps its draft in place and
  // the room switch to Chat happens only after a successful post.
  const [firstPosting, setFirstPosting] = useState(false);
  if (discussion && !firstPosting) {
    return (
      <Chat
        boardId={boardId}
        discussion={discussion}
        state={state}
        onOpenCard={props.onOpenCard}
        className="pt-2"
      />
    );
  }
  if (card.discussionId && !firstPosting) return <div className="flex-1" />;
  return (
    <div className="flex min-h-0 flex-1 flex-col justify-end">
      <Composer
        placeholder="Message"
        attachments
        blockedReason={canPost ? null : "Your connection can't post here"}
        onSend={async (blocks) => {
          setFirstPosting(true);
          const room = await kanban.cardDiscussion(boardId, card.id);
          // A rejected post throws before the next line, so the first-post
          // composer and its text and files stay on screen for a retry.
          await kanban.post(boardId, room.id, blocks);
          setFirstPosting(false);
        }}
      />
    </div>
  );
}

function Details(props: {
  card: KanbanCard;
  state: KanbanBoardState;
  events: ReadonlyArray<KanbanCardEvent>;
  nowMs: number;
}) {
  const { card, state } = props;
  const board = state.board;
  const goals = [...state.goals.values()].filter((goal) => goal.status === "active");
  const chainName = card.reviewChain ?? board.defaultReviewChain;
  const chain = board.reviewChains.find((entry) => entry.name === chainName);
  const blockers = card.blockedBy.flatMap((id) => {
    const blocker = state.cards.get(id);
    return blocker ? [blocker] : [];
  });
  const patch = (input: Omit<Parameters<typeof kanban.patchCard>[0], "cardId">) =>
    void runAction("Couldn't update the card", () =>
      kanban.patchCard({ cardId: card.id as never, ...input }),
    );
  const moves = props.events
    .filter((event) => event.kind === "moved")
    .slice(-6)
    .toReversed();

  return (
    <div className="min-h-0 flex-1 overflow-y-auto py-4">
      <dl className="grid grid-cols-[112px_1fr] items-center gap-x-4 gap-y-3 text-sm">
        <Fact label="Stage">
          <Menu>
            <MenuTrigger render={<FactButton />}>
              <Glyph kind={stageGlyph(card.stage)} />
              {STAGE_LABELS[card.stage]}
            </MenuTrigger>
            <MenuPopup align="start" side="bottom">
              <MenuRadioGroup
                value={card.stage}
                onValueChange={(stage) => patch({ stage: stage as KanbanStage })}
              >
                {OWNER_STAGES.map((stage) => (
                  <MenuRadioItem key={stage} value={stage}>
                    {STAGE_LABELS[stage]}
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuPopup>
          </Menu>
        </Fact>
        <Fact label="Priority">
          <Menu>
            <MenuTrigger render={<FactButton />}>
              <Pri priority={card.priority} />
              {priorityLabel(card.priority)}
            </MenuTrigger>
            <MenuPopup align="start" side="bottom">
              <MenuRadioGroup
                value={String(card.priority)}
                onValueChange={(value) => patch({ priority: Number(value) })}
              >
                {[1, 2, 3, 4, 5].map((priority) => (
                  <MenuRadioItem key={priority} value={String(priority)}>
                    {priorityLabel(priority)}
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuPopup>
          </Menu>
        </Fact>
        <Fact label="Goal">
          <Menu>
            <MenuTrigger render={<FactButton />}>
              {card.goalId ? (state.goals.get(card.goalId)?.name ?? "Goal") : "None"}
            </MenuTrigger>
            <MenuPopup align="start" side="bottom">
              <MenuRadioGroup
                value={card.goalId ?? ""}
                onValueChange={(value) => patch({ goalId: value ? (value as never) : null })}
              >
                <MenuRadioItem value="">None</MenuRadioItem>
                {goals.map((goal) => (
                  <MenuRadioItem key={goal.id} value={goal.id}>
                    {goal.name}
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuPopup>
          </Menu>
        </Fact>
        {card.projects.length > 0 ? (
          <Fact label="Projects">
            <span className="flex flex-wrap gap-1.5">
              {card.projects.map((project) => (
                <Chip key={project}>{project}</Chip>
              ))}
            </span>
          </Fact>
        ) : null}
        {card.models.length > 1 && card.workThreadId === null ? (
          // Not started yet: it goes to the highest weight with room.
          <Fact label="Models">
            <span className="flex flex-wrap items-center gap-1.5">
              {card.models.map((entry) => (
                <Chip key={`${entry.model.instanceId}/${entry.model.model}`}>
                  {modelName(entry.model)}
                  <span className="text-(--m-muted) tabular-nums">{entry.weight}</span>
                </Chip>
              ))}
            </span>
          </Fact>
        ) : (
          <Fact label="Model">
            <Chip>
              {modelName(card.model)}
              {modelVariant(card.model) ? (
                <span className="text-(--m-muted)">{modelVariant(card.model)}</span>
              ) : null}
            </Chip>
          </Fact>
        )}
        {card.links.length > 0 ? (
          <Fact label="Links">
            <span className="flex flex-wrap gap-1.5">
              {card.links.map((link) => (
                <LinkChip key={link.url} href={link.url}>
                  {link.kind === "pr" ? <PrGlyph state={link.state} /> : null}
                  {link.label ?? link.kind}
                </LinkChip>
              ))}
            </span>
          </Fact>
        ) : null}
        {blockers.length > 0 ? (
          <Fact label="Blocked by">
            <span className="flex flex-wrap gap-1.5">
              {blockers.map((blocker) => (
                <Chip key={blocker.id}>
                  <Glyph kind={stageGlyph(blocker.stage)} />#{blocker.number}
                </Chip>
              ))}
            </span>
          </Fact>
        ) : null}
        {chain ? (
          <Fact label="Review">
            <span className="flex flex-wrap items-center gap-1.5">
              {chain.steps.map((step, index) => (
                <span key={`${step.model}:${index}`} className="flex items-center gap-1.5">
                  {index > 0 ? <span className="text-(--m-muted)">→</span> : null}
                  <Chip>{modelName(step)}</Chip>
                </span>
              ))}
              {card.reviewRound > 0 ? (
                <span className="text-xs text-(--m-muted) tabular-nums">
                  Round {card.reviewRound}
                </span>
              ) : null}
            </span>
          </Fact>
        ) : null}
        {card.stalled ? (
          <Fact label="Stalled">
            <span className="flex items-center gap-2">
              <span className="text-(--m-negative)">{card.stalled.reason}</span>
              <QuietButton onClick={() => patch({ stalled: false })}>Clear</QuietButton>
            </span>
          </Fact>
        ) : null}
      </dl>
      <Subtasks card={card} />
      {moves.length > 0 ? (
        <ol className="mt-6 flex flex-col gap-2 text-sm">
          {moves.map((event) => (
            <li key={event.id} className="grid grid-cols-[64px_1fr] gap-3">
              <span className="text-xs text-(--m-muted) tabular-nums">
                {ageView(event.at, props.nowMs)?.label ?? ""}
              </span>
              <span>
                {event.fromStage ? STAGE_LABELS[event.fromStage] : "New"} →{" "}
                {event.toStage ? STAGE_LABELS[event.toStage] : ""}
              </span>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

const SUBTASK_GLYPH = { open: "idle", done: "done", skipped: "idle" } as const;

/** The card's plan, step by step. The evaluator and the card's threads mark it; the owner reads it. */
function Subtasks(props: { card: KanbanCard }) {
  const steps = subtaskSteps(props.card);
  if (steps.length === 0) return null;
  return (
    <section aria-label="Subtasks" className="mt-6">
      <h3 className="mb-2 text-sm font-medium">Subtasks</h3>
      <ol className="flex flex-col gap-3">
        {steps.map((step) => (
          <li key={step.step} className="grid grid-cols-[24px_1fr] gap-x-2">
            <span
              className={cn(
                "pt-0.5 text-xs tabular-nums",
                step.when === "now" ? "font-semibold text-(--m-text)" : "text-(--m-muted)",
              )}
            >
              {step.step}
            </span>
            <ul className="flex flex-col gap-1.5">
              {step.subtasks.map((subtask) => (
                <li key={subtask.id} className="flex min-w-0 items-start gap-2 text-sm">
                  <Glyph
                    kind={
                      subtask.state === "open" && step.when === "now"
                        ? "ok"
                        : SUBTASK_GLYPH[subtask.state]
                    }
                    className="mt-1.25"
                  />
                  <span className="min-w-0 flex-1">
                    <span
                      className={cn(
                        subtask.state === "skipped" && "text-(--m-muted) line-through",
                        step.when === "later" && "text-(--m-muted)",
                      )}
                    >
                      {subtask.text}
                    </span>
                    <span className="block text-xs text-(--m-muted)">
                      {SUBTASK_OWNER_LABELS[subtask.owner]}
                      {subtask.note ? ` · ${subtask.note}` : ""}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Fact(props: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-(--m-muted)">{props.label}</dt>
      <dd className="flex min-w-0 items-center">{props.children}</dd>
    </>
  );
}

function FactButton(props: React.ComponentProps<"button">) {
  return (
    <button
      type="button"
      {...props}
      className="-ms-2 inline-flex h-7.5 items-center gap-2 rounded-full px-2 font-medium text-(--m-text) outline-none hover:bg-(--m-chip) focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--m-accent) data-popup-open:bg-(--m-chip)"
    />
  );
}

/** Open questions for the owner. Answers go in the card's discussion. */
function OwnerAsks(props: { card: KanbanCard; nowMs: number; onAnswer: () => void }) {
  const { card } = props;
  const asks = askViews(card, props.nowMs);
  // Cards from before asks were kept only carry the question.
  if (asks.length === 0) {
    return card.question && card.stage === "needs_owner" ? (
      <p className="mb-3.5 flex items-start gap-2 rounded-xl bg-(--m-warnband) px-3 py-2.5 text-sm leading-snug">
        <Glyph kind="wait" className="mt-1" />
        <span>{card.question}</span>
      </p>
    ) : null;
  }
  return (
    <ul className="mb-3.5 flex max-h-[30vh] shrink-0 flex-col gap-1 overflow-y-auto overscroll-contain rounded-xl bg-(--m-warnband) py-1.5">
      {asks.map((ask) => (
        <li key={ask.id} className="flex items-start gap-2 px-3 py-1 text-sm leading-snug">
          <Glyph kind={ask.blocking ? "wait" : "ask"} className="mt-1" />
          <span className="min-w-0 flex-1">
            <span className="line-clamp-3 break-words">{ask.text}</span>
            <span className="text-xs text-(--m-muted)">
              {ask.by} · {ask.age} · {ask.blocking ? "Card waits" : "Work goes on"}
            </span>
          </span>
          <span className="-me-1.5 flex shrink-0 items-center">
            <QuietButton onClick={props.onAnswer}>Answer</QuietButton>
            {ask.blocking ? null : (
              <QuietButton
                onClick={() =>
                  void runAction("Couldn't make it blocking", () =>
                    kanban.changeAsk(card.id, ask.id, "block"),
                  )
                }
              >
                Block
              </QuietButton>
            )}
            <QuietButton
              onClick={() =>
                void runAction("Couldn't drop the question", () =>
                  kanban.changeAsk(card.id, ask.id, "drop"),
                )
              }
            >
              Drop
            </QuietButton>
          </span>
        </li>
      ))}
    </ul>
  );
}

function QuietButton(props: {
  onClick: () => void;
  children: ReactNode;
  disabled?: boolean;
  title?: string | undefined;
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      disabled={props.disabled}
      title={props.title}
      className="h-7.5 rounded-full px-2 text-sm font-medium text-(--m-muted) outline-none hover:text-(--m-text) focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--m-accent) disabled:opacity-40"
    >
      {props.children}
    </button>
  );
}

function ThreadLink(props: { threadId: string; children: ReactNode; className?: string }) {
  const environmentId = usePrimaryEnvironmentId();
  if (!environmentId) return null;
  return (
    <Link
      to="/$environmentId/$threadId"
      params={{ environmentId, threadId: props.threadId }}
      className={cn(
        "inline-flex h-7.5 items-center rounded-full px-2 text-sm font-medium text-(--m-muted) outline-none hover:text-(--m-text) focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--m-accent)",
        props.className,
      )}
    >
      {props.children}
    </Link>
  );
}

const ROLE_LABELS = { work: "Worker", review: "Reviewer", evaluator: "Evaluator" } as const;

function ThreadList(props: {
  threads: ReadonlyArray<{
    threadId: string;
    role: "work" | "review" | "evaluator";
    model: KanbanCard["model"] | null;
    startedAt: string;
    endedAt: string | null;
  }>;
  state: KanbanBoardState;
  nowMs: number;
}) {
  if (props.threads.length === 0)
    return <p className="py-4 text-sm text-(--m-muted)">No threads yet.</p>;
  const list = [...props.threads].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return (
    <ul className="min-h-0 flex-1 overflow-y-auto py-3">
      {list.map((thread) => {
        const live = props.state.threads.get(thread.threadId);
        const running = live?.running ?? false;
        return (
          <li key={thread.threadId} className="flex items-center gap-1">
            <ThreadLink
              threadId={thread.threadId}
              className="-ms-2 flex h-11 min-w-0 flex-1 gap-2.5 rounded-xl px-2 text-sm text-(--m-text) hover:bg-(--m-chip)"
            >
              <Glyph kind={running ? "ok" : thread.endedAt ? "done" : "idle"} />
              <span className="min-w-0 flex-1 truncate">
                {live?.title ?? ROLE_LABELS[thread.role]}
              </span>
              <span className="text-xs font-normal text-(--m-muted)">
                {ROLE_LABELS[thread.role]}
                {thread.model ? ` · ${modelName(thread.model)}` : ""}
              </span>
              <span className="w-12 text-right text-xs font-normal text-(--m-muted) tabular-nums">
                {ageView(thread.startedAt, props.nowMs)?.label ?? ""}
              </span>
            </ThreadLink>
            <CopyLinkButton
              kind="thread"
              id={thread.threadId}
              label={live?.title || ROLE_LABELS[thread.role]}
            />
          </li>
        );
      })}
    </ul>
  );
}

function Comments(props: { cardId: string; comments: ReadonlyArray<KanbanCardEvent> }) {
  const canComment = useKanbanPermission(KANBAN_WS_METHODS.cardPatch);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ol className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto py-4">
        {props.comments.length === 0 ? (
          <li className="text-sm text-(--m-muted)">No comments.</li>
        ) : null}
        {props.comments.map((event) => (
          <li key={event.id} className="flex flex-col gap-0.5 text-sm">
            <span className="text-xs text-(--m-muted) tabular-nums">
              {actorName(event.actor)} · {formatDayLabel(event.at)} {formatTimeOfDay(event.at)}
            </span>
            <div className="min-w-0">
              <KanbanMarkdown text={event.body ?? ""} />
            </div>
          </li>
        ))}
      </ol>
      <Composer
        placeholder="Comment"
        blockedReason={canComment ? null : "Your connection can't comment on cards"}
        onSend={(blocks) => {
          const text = blocks.find((block) => block._tag === "md")?.text ?? "";
          return kanban.patchCard({ cardId: props.cardId as never, comment: text });
        }}
      />
    </div>
  );
}

function actorName(actor: KanbanCardEvent["actor"]) {
  switch (actor._tag) {
    case "owner":
      return "You";
    case "thread":
      return "Worker";
    case "evaluator":
      return "Evaluator";
    case "script":
      return "Script";
    case "system":
      return "Board";
  }
}
