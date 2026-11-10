import {
  askAfterAnswer,
  askOutcome,
  avatarOf,
  diffPieces,
  wordDiff,
  type AskOutcome,
} from "@t3tools/client-runtime/ardud/kanban";
import type { KanbanAskFeedItem } from "@t3tools/contracts";
import { useEffect, type ReactNode } from "react";

import { cn } from "../../../lib/utils";
import { KanbanLinksProvider, KanbanMarkdown } from "../links";
import { Avatar } from "../parts";
import { askAsker, loadClosedAsks, useAskStore, type AskSend } from "./askStore";
import { EvaluatorThreadLink } from "./HandOver";
import { sameDay, shortWhen } from "./snoozeTimes";
import { Bar, Btn, Label, linkClass, type PageLayout } from "./ui";

function Line(props: { who: ReactNode; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[24px_minmax(0,1fr)] gap-2.5">
      {props.who}
      <div className="min-w-0 pt-0.5 [overflow-wrap:anywhere]">{props.children}</div>
    </div>
  );
}

const You = <Avatar kind="owner" letter="Y" size="sm" name="You" />;

function Outcome(props: { outcome: AskOutcome }) {
  const { outcome } = props;
  return (
    <>
      <p>
        <b className="font-semibold">{outcome.label}</b>
        {outcome.text ? `: ${outcome.text}` : null}
      </p>
      {outcome.draft ? (
        <>
          <Label className="mt-2 mb-1.5">Your changes to the draft</Label>
          <p className="rounded-xl bg-(--m-ground) px-3.5 py-2.5 leading-7 whitespace-pre-wrap ring-1 ring-inset ring-(--m-rule)">
            {diffPieces(wordDiff(outcome.draft.before, outcome.draft.after), "both").map(
              (piece, index) =>
                piece.kind === "same" ? (
                  // oxlint-disable-next-line react/no-array-index-key -- Pieces of one diff have no identity but their order.
                  <span key={index}>{piece.text}</span>
                ) : piece.kind === "removed" ? (
                  // oxlint-disable-next-line react/no-array-index-key -- Pieces of one diff have no identity but their order.
                  <del key={index}>{piece.text}</del>
                ) : (
                  // oxlint-disable-next-line react/no-array-index-key -- Pieces of one diff have no identity but their order.
                  <ins key={index}>{piece.text}</ins>
                ),
            )}
          </p>
        </>
      ) : null}
      {outcome.values.length > 0 ? (
        <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
          {outcome.values.map(([name, value]) => (
            <div key={name} className="contents">
              <dt className="text-(--m-muted)">{name}</dt>
              <dd className="tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {outcome.note ? (
        <>
          <Label className="mt-2 mb-0.5">Your note</Label>
          <p>{outcome.note}</p>
        </>
      ) : null}
      {outcome.evaluatorThreadId ? (
        <p className="mt-2 text-sm">
          <EvaluatorThreadLink threadId={outcome.evaluatorThreadId} />
        </p>
      ) : null}
    </>
  );
}

function Row(props: {
  board: string;
  cardNumber: number | null;
  when: string;
  title: string;
  onOpenCard?: (() => void) | undefined;
  children: ReactNode;
}) {
  return (
    <li className="flex flex-col gap-2.5 rounded-2xl p-4 ring-1 ring-(--m-rule)">
      <div className="flex flex-col gap-1">
        <p className="flex flex-wrap items-center gap-x-2.5 text-sm text-(--m-muted)">
          <span className="font-medium text-(--m-text)">{props.board}</span>
          {props.cardNumber !== null && props.onOpenCard ? (
            <button
              type="button"
              onClick={props.onOpenCard}
              aria-label={`Open card #${props.cardNumber}`}
              className={cn(linkClass, "tabular-nums")}
            >
              #{props.cardNumber}
            </button>
          ) : null}
          <span className="tabular-nums">{props.when}</span>
        </p>
        <h3 className="font-semibold [overflow-wrap:anywhere]">{props.title}</h3>
      </div>
      {props.children}
    </li>
  );
}

/** An answer of this session that the closed list does not carry yet, or never will (a hand-over). */
function SessionRow(props: { send: AskSend; held: boolean; onUndo: () => void }) {
  const { send } = props;
  const pending = send.state !== "sent";
  return (
    <Row
      board={send.boardName}
      cardNumber={null}
      when={pending ? "now" : "this session"}
      title={send.refs.length > 1 ? `${send.refs.length} asks: ${send.title}` : send.title}
    >
      <Line who={You}>
        <p>
          <b className="font-semibold">{send.label}</b>
          {send.hand?.text ? `, with: ${send.hand.text}` : null}
          {send.body.text ? `: ${send.body.text}` : null}
        </p>
        {send.body.note ? (
          <>
            <Label className="mt-2 mb-0.5">Your note</Label>
            <p>{send.body.note}</p>
          </>
        ) : null}
        {pending ? (
          <p className="mt-1 flex items-center gap-3 text-sm text-(--m-muted)">
            {props.held ? "Sending. You can still undo." : "Sending."}
            {props.held ? (
              <button type="button" onClick={props.onUndo} className={linkClass}>
                Undo
              </button>
            ) : null}
          </p>
        ) : send.evaluator?.started && send.evaluator.threadId ? (
          <p className="mt-2 text-sm">
            <EvaluatorThreadLink threadId={send.evaluator.threadId} />
          </p>
        ) : send.evaluator && !send.evaluator.started ? (
          <p className="mt-2 text-sm text-(--m-negative)">
            Handed over, but the evaluator thread did not start
            {send.evaluator.error ? `: ${send.evaluator.error}` : "."}
          </p>
        ) : null}
      </Line>
    </Row>
  );
}

function ClosedRow(props: {
  entry: KanbanAskFeedItem;
  outcome: AskOutcome;
  nowMs: number;
  onOpenCard: () => void;
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
        <Outcome outcome={outcome} />
      </Line>
      {after && face && said?._tag === "md" ? (
        <Line
          who={<Avatar kind={face.kind} letter={face.letter} size="sm" name={after.authorName} />}
        >
          <KanbanLinksProvider boardId={entry.boardId}>
            <div className="[&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
              <KanbanMarkdown text={said.text} />
            </div>
          </KanbanLinksProvider>
        </Line>
      ) : entry.ask.answer!.by._tag === "owner" ? (
        <p className="ps-8.5 text-sm text-(--m-muted)">Went to {askAsker(entry)}.</p>
      ) : null}
    </Row>
  );
}

/** What he answered in the last week, newest first, and what each agent said next. */
export function HistoryView(props: {
  layout: PageLayout;
  nowMs: number;
  toAnswer: number;
  waiting: number;
  onBack: () => void;
  onUndo: () => void;
  onOpenCard: (entry: KanbanAskFeedItem) => void;
}) {
  const closed = useAskStore((state) => state.closed);
  const status = useAskStore((state) => state.closedStatus);
  const sent = useAskStore((state) => state.sent);
  const heldId = useAskStore((state) => state.held?.payload.id ?? null);
  useEffect(() => {
    void loadClosedAsks();
  }, []);

  const session = sent.filter((send) => send.state !== "sent" || send.kind === "hand");
  const rows = (closed ?? []).flatMap((entry) => {
    const outcome = askOutcome(entry.ask);
    return outcome === null ? [] : [{ entry, outcome }];
  });
  const today = rows.filter((row) => sameDay(row.entry.ask.answer!.at, props.nowMs));
  const earlier = rows.filter((row) => !sameDay(row.entry.ask.answer!.at, props.nowMs));
  const facts: ReadonlyArray<readonly [string, number]> = [
    ["Answered", today.length],
    ["With a note", today.filter((row) => row.outcome.note !== null).length],
    ["Drafts you edited", today.filter((row) => row.outcome.draft !== null).length],
    ["Waiting on agents", props.waiting],
    ["Still to answer", props.toAnswer],
  ];
  const list = (items: typeof rows) => (
    <ul className="flex flex-col gap-3">
      {items.map(({ entry, outcome }) => (
        <ClosedRow
          key={`${entry.cardId}:${entry.ask.id}`}
          entry={entry}
          outcome={outcome}
          nowMs={props.nowMs}
          onOpenCard={() => props.onOpenCard(entry)}
        />
      ))}
    </ul>
  );
  const aside = (
    <aside aria-label="Today" className="flex flex-col gap-4 text-sm">
      <div>
        <Label className="mb-2">Today</Label>
        <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1.5">
          {facts.map(([name, value]) => (
            <div key={name} className="contents">
              <dt>{name}</dt>
              <dd className="text-end font-medium tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>
      </div>
      <Btn size="sm" onClick={props.onBack} className="self-start">
        Back to Needs you
      </Btn>
    </aside>
  );
  return (
    <div
      data-ny-enter
      className={cn(
        "min-h-0 flex-1 overflow-y-auto overscroll-contain",
        props.layout === "phone" ? "px-4 py-5" : "px-7 py-6",
        props.layout === "desktop" && "grid grid-cols-[minmax(0,760px)_232px] items-start gap-x-8",
      )}
    >
      <div className="flex min-w-0 flex-col gap-3">
        {props.layout === "desktop" ? null : <div className="mb-3">{aside}</div>}
        {closed === null && status !== "error" ? (
          <div aria-busy className="flex flex-col gap-3">
            <Bar className="h-24 rounded-2xl" />
            <Bar className="h-24 rounded-2xl" />
          </div>
        ) : null}
        {closed === null && status === "error" ? (
          <div className="flex flex-col items-start gap-2">
            <p className="font-semibold">Couldn't load History.</p>
            <Btn size="sm" onClick={() => void loadClosedAsks()}>
              Retry
            </Btn>
          </div>
        ) : null}
        {session.length > 0 ? (
          <ul className="flex flex-col gap-3">
            {session.map((send) => (
              <SessionRow
                key={send.id}
                send={send}
                held={heldId === send.id}
                onUndo={props.onUndo}
              />
            ))}
          </ul>
        ) : null}
        {closed !== null ? (
          <>
            <Label>Today</Label>
            {today.length > 0 ? (
              list(today)
            ) : session.length === 0 ? (
              <p className="pb-2 text-sm text-(--m-muted)">Nothing answered yet today.</p>
            ) : null}
            {earlier.length > 0 ? (
              <>
                <Label className="mt-3">Earlier this week</Label>
                {list(earlier)}
              </>
            ) : null}
          </>
        ) : null}
      </div>
      {props.layout === "desktop" ? aside : null}
    </div>
  );
}
