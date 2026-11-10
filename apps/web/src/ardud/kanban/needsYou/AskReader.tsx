import {
  STAGE_LABELS,
  askAge,
  askFieldKind,
  askFormFor,
  askKindLabel,
  askRefusal,
  buildAskAnswer,
  isPlainAnswerField,
  type AskKeyAction,
  type NeedsYouItem,
  type NeedsYouMark,
} from "@t3tools/client-runtime/ardud/kanban";
import {
  kanbanAskResponse,
  kanbanAskRevision,
  type KanbanAskFeedItem,
  type KanbanBoard,
} from "@t3tools/contracts";
import { useEffect, useImperativeHandle, useRef, type ReactNode, type RefObject } from "react";

import { cn } from "../../../lib/utils";
import { BoardIcon } from "../boardIcon";
import { KanbanLinksProvider, KanbanMarkdown } from "../links";
import { ActionBar, type AskTurn } from "./ActionBar";
import {
  OptionList,
  TaskSteps,
  WhyField,
  askOffersOwnWords,
  type AskProblems,
} from "./AnswerParts";
import { FieldRow } from "./AskFields";
import {
  answerAsk,
  askAsker,
  askKey,
  askNeedsDetail,
  loadAskDetail,
  patchAskForm,
  replyOnAsk,
  retryAskSend,
  seeAsk,
  takeBackAsk,
  useAskStore,
} from "./askStore";
import { DraftPart } from "./DraftPart";
import { Btn, Label, Pill, linkClass, type PageLayout } from "./ui";

export interface AskReaderHandle {
  /** Runs a key's action on the ask in focus. */
  readonly act: (action: AskKeyAction) => void;
}

export const askTurn = (entry: KanbanAskFeedItem, item: NeedsYouItem): AskTurn =>
  entry.waitsOn === "evaluator"
    ? "evaluator"
    : entry.waitsOn === "owner" && item.expired
      ? "expired"
      : entry.waitsOn === "agent"
        ? "agent"
        : "owner";

/** One ask, whole: what it says, what it shows, his answer, and the bar to send it. */
export function AskReader(props: {
  entry: KanbanAskFeedItem;
  item: NeedsYouItem;
  board: KanbanBoard | undefined;
  layout: PageLayout;
  handle: RefObject<AskReaderHandle | null>;
  onOpenCard: () => void;
}) {
  const { entry, item, layout } = props;
  const key = askKey(entry);
  const turn = askTurn(entry, item);
  const detail = useAskStore((state) => state.details[`${key}@${entry.revision}`]);
  const ask = detail ?? entry.ask;
  // The stored form, or a fresh one: a selector must not build a new object per read.
  const storedForm = useAskStore((state) => state.forms[key]);
  const form = storedForm ?? askFormFor(entry.ask);
  const tried = useAskStore((state) => state.tried[key] === true);
  const refused = useAskStore((state) => state.refused[key]);
  const mark = useAskStore((state) => state.marks[key]) as NeedsYouMark | undefined;
  const failed = useAskStore((state) => state.failed[key]);
  const response = kanbanAskResponse(ask);
  const refusal = askRefusal(response);
  const locked = turn === "evaluator" || turn === "expired";
  const root = useRef<HTMLDivElement>(null);

  // The feed carries big blocks as stubs: read the ask whole once it is open.
  const needsDetail = detail === undefined && askNeedsDetail(entry.ask);
  useEffect(() => {
    if (needsDetail) void loadAskDetail(entry).catch(() => undefined);
  }, [needsDetail, entry]);

  // What was new on the ask counts as seen once he moves on from it.
  useEffect(() => () => seeAsk(key), [key]);

  const built = buildAskAnswer(
    ask,
    form,
    form.refusing ? "refuse" : "primary",
    kanbanAskRevision(ask),
  );
  const problems: AskProblems = {
    ...(tried && !built.ok ? built.problems : {}),
    ...refused,
  };

  const focusAt = (at: string) => {
    requestAnimationFrame(() => {
      const target = root.current?.querySelector<HTMLElement>(`[data-ny-at="${CSS.escape(at)}"]`);
      target?.focus();
      target?.scrollIntoView({ block: "nearest" });
    });
  };
  const send = (intent: "primary" | "refuse") => {
    if (locked) return;
    const result = answerAsk({ ...entry, ask }, intent);
    if (!result.ok) focusAt(result.first);
  };
  const primary = () => send(form.refusing ? "refuse" : "primary");
  const refuse = () => {
    if (locked || refusal === null) return;
    if (refusal.why === "none" || form.refusing) return send("refuse");
    patchAskForm(entry, { refusing: true });
    focusAt("why");
  };
  const pick = (index: number) => {
    root.current?.querySelector<HTMLElement>(`[data-ny-option="${index}"]`)?.click();
  };
  const firstText = response.fields.find((field) => {
    const kind = askFieldKind(field);
    return kind === "text" || kind === "longtext";
  });

  useImperativeHandle(props.handle, () => ({
    act: (action) => {
      switch (action._tag) {
        case "primary":
          return primary();
        case "refuse":
          return refuse();
        case "pick":
          return pick(action.index);
        case "edit":
          if (response.edit === "draft") {
            root.current?.querySelector<HTMLElement>("[data-ny-edit]")?.click();
            return undefined;
          }
          return firstText ? focusAt(`field:${firstText.id}`) : undefined;
        default:
          return undefined;
      }
    },
  }));

  const title = ask.title ?? entry.cardTitle;
  const plain = response.fields.length === 1 && isPlainAnswerField(ask, response.fields[0]!);
  const hasAnswerParts =
    response.choose !== null ||
    response.fields.length > 0 ||
    form.refusing ||
    response.task !== null;

  const aside = <AskFacts entry={entry} item={item} turn={turn} onOpenCard={props.onOpenCard} />;

  return (
    <KanbanLinksProvider boardId={entry.boardId}>
      <div ref={root} className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div
          key={key}
          tabIndex={-1}
          data-ny-scroll
          data-ny-enter
          className={cn(
            "min-h-0 flex-1 overflow-y-auto overscroll-contain outline-none",
            layout === "desktop" && "grid grid-cols-[minmax(0,1fr)_232px] gap-x-7 pe-7",
          )}
        >
          <article
            aria-labelledby="ny-ask-title"
            className={cn(
              "flex min-w-0 flex-col gap-5 pt-6 pb-8",
              layout === "phone" ? "px-4" : layout === "tablet" ? "px-6" : "ps-7",
            )}
          >
            <header className="flex flex-col gap-2.5">
              <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 text-sm text-(--m-muted)">
                <span className="inline-flex min-w-0 items-center gap-1.5 font-medium text-(--m-text)">
                  {props.board ? (
                    <BoardIcon board={props.board} className="text-(--m-muted)" />
                  ) : null}
                  <span className="truncate">{entry.boardName}</span>
                </span>
                <button
                  type="button"
                  onClick={props.onOpenCard}
                  aria-label={`Open card #${entry.cardNumber}`}
                  className={cn(linkClass, "tabular-nums")}
                >
                  #{entry.cardNumber}
                </button>
                <span>{askKindLabel(entry.kind)}</span>
                <span>
                  {askAsker(entry).replace(/^the /, "")} · {askAge(item.ageMs)}
                </span>
              </div>
              <StatePills entry={entry} item={item} turn={turn} mark={mark} />
              <h2
                id="ny-ask-title"
                className="text-xl leading-7 font-semibold text-balance [overflow-wrap:anywhere]"
              >
                {title}
              </h2>
            </header>

            {failed ? (
              <Banner
                tone="negative"
                action={
                  <Btn size="sm" onClick={() => retryAskSend(key)}>
                    Retry
                  </Btn>
                }
              >
                Not sent. {failed.message}
              </Banner>
            ) : null}
            {mark === "updated" ? (
              <Banner tone="accent">
                Its agent changed this ask{ask.revisionNote ? `: ${ask.revisionNote}` : "."} What
                you typed is kept.
              </Banner>
            ) : null}
            {turn === "expired" ? (
              <Banner tone="warn">
                The facts changed since this was asked
                {ask.basis ? ` (${ask.basis})` : ""}. Its agent has to refresh it first.
              </Banner>
            ) : null}

            {ask.title !== undefined && ask.text.trim() !== "" && ask.text !== ask.title ? (
              <p className="font-medium [overflow-wrap:anywhere]">{ask.text}</p>
            ) : ask.title === undefined ? (
              <p className="font-medium [overflow-wrap:anywhere]">{ask.text}</p>
            ) : null}
            {ask.context ? (
              <div className="-mt-2 text-(--m-muted) [overflow-wrap:anywhere]">
                <KanbanMarkdown text={ask.context} />
              </div>
            ) : null}

            {ask.draft ? (
              <DraftPart
                entry={entry}
                draft={ask.draft}
                form={form}
                editable={response.edit === "draft" && !locked && !form.refusing}
                problem={problems.draft}
              />
            ) : null}

            {hasAnswerParts ? (
              <section aria-label="Your answer" className="flex flex-col gap-4">
                <h3 className="text-base font-semibold">
                  {response.task ? "Your part" : "Your answer"}
                </h3>
                {response.task && response.task.steps.length > 0 ? (
                  <TaskSteps
                    entry={entry}
                    steps={response.task.steps}
                    form={form}
                    disabled={locked}
                  />
                ) : null}
                {response.choose ? (
                  <OptionList
                    entry={entry}
                    choose={response.choose}
                    ownWords={askOffersOwnWords(response)}
                    form={form}
                    problem={problems.choose}
                    disabled={locked || form.refusing}
                  />
                ) : null}
                {response.fields.length > 0 && !form.refusing ? (
                  <div className="flex flex-col gap-4">
                    {response.fields.map((field) => (
                      <FieldRow
                        key={field.id}
                        entry={entry}
                        ask={ask}
                        field={field}
                        value={form.values[field.id]}
                        required={field.required === true || response.task?.proof === field.id}
                        problem={problems[`field:${field.id}`]}
                        bare={plain}
                        disabled={locked}
                      />
                    ))}
                  </div>
                ) : null}
                {form.refusing ? (
                  <WhyField entry={entry} response={response} form={form} problem={problems.why} />
                ) : null}
              </section>
            ) : null}

            {layout === "desktop" ? null : aside}
          </article>
          {layout === "desktop" ? <div className="pt-6 pb-8">{aside}</div> : null}
        </div>

        <div className="shrink-0 border-t border-(--m-rule)">
          <ActionBar
            ask={ask}
            form={form}
            turn={turn}
            phone={layout === "phone"}
            onPrimary={primary}
            onRefuse={refuse}
            onBack={() => patchAskForm(entry, { refusing: false })}
            onTakeBack={() => void takeBackAsk(entry)}
            onRefresh={() =>
              void replyOnAsk(entry, [
                {
                  _tag: "md",
                  text: "This ask is out of date. Please refresh it with the current facts.",
                },
              ]).catch(() => undefined)
            }
          />
        </div>
      </div>
    </KanbanLinksProvider>
  );
}

function StatePills(props: {
  entry: KanbanAskFeedItem;
  item: NeedsYouItem;
  turn: AskTurn;
  mark: NeedsYouMark | undefined;
}) {
  const { entry, item, turn } = props;
  const pills: Array<ReactNode> = [];
  if (props.mark === "failed")
    pills.push(
      <Pill key="failed" tone="negative">
        Not sent
      </Pill>,
    );
  if (props.mark === "updated")
    pills.push(
      <Pill key="updated" tone="accent">
        Updated
      </Pill>,
    );
  if (props.mark === "reply")
    pills.push(
      <Pill key="reply" tone="accent">
        New reply
      </Pill>,
    );
  if (turn === "agent") pills.push(<Pill key="agent">Waiting on the agent</Pill>);
  if (turn === "evaluator") pills.push(<Pill key="evaluator">With the evaluator</Pill>);
  if (turn === "expired")
    pills.push(
      <Pill key="expired" tone="warn">
        Out of date
      </Pill>,
    );
  if (item.notice) pills.push(<Pill key="notice">Nothing needed</Pill>);
  else if (item.blocking) {
    pills.push(
      <Pill key="holds" tone="warn">
        Holds #{entry.cardNumber}
      </Pill>,
    );
  }
  if (item.unblocks > 0) {
    pills.push(
      <Pill key="unblocks">
        {item.unblocks} {item.unblocks === 1 ? "card waits" : "cards wait"} behind it
      </Pill>,
    );
  }
  if (pills.length === 0) return null;
  return <div className="flex flex-wrap gap-1.5">{pills}</div>;
}

function Banner(props: {
  tone: "negative" | "accent" | "warn";
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      role={props.tone === "negative" ? "alert" : "status"}
      className={cn(
        "flex items-center gap-3 rounded-xl px-3.5 py-2.5 text-sm [overflow-wrap:anywhere]",
        props.tone === "negative" && "bg-(--ny-negband) text-(--m-negative)",
        props.tone === "accent" && "bg-(--m-band) text-(--m-accent-text)",
        props.tone === "warn" && "bg-(--ny-warnband) text-(--m-warning)",
      )}
    >
      <span className="min-w-0 flex-1">{props.children}</span>
      {props.action}
    </div>
  );
}

/** Beside the ask: its card, and why it sits in the queue. */
function AskFacts(props: {
  entry: KanbanAskFeedItem;
  item: NeedsYouItem;
  turn: AskTurn;
  onOpenCard: () => void;
}) {
  const { entry, item } = props;
  const ask = entry.ask;
  const facts: Array<readonly [string, string]> = [["Waiting", askAge(item.ageMs)]];
  if (!item.notice) facts.push(["Holds a card", item.blocking ? "Yes" : "No"]);
  if (item.unblocks > 0) facts.push(["Cards behind it", String(item.unblocks)]);
  if (ask.basis) facts.push(["Rests on", ask.basis]);
  if (ask.expiresAt) {
    const left = Date.parse(ask.expiresAt) - (Date.parse(ask.at) + item.ageMs);
    facts.push(["Good for", left > 0 ? askAge(left) : "Out of date"]);
  }
  if (entry.revision > 0) {
    facts.push(["Edited", entry.revision === 1 ? "Once" : `${entry.revision} times`]);
  }
  return (
    <aside aria-label="About this ask" className="flex min-w-0 flex-col gap-4 text-sm">
      <div>
        <Label className="mb-2">Card</Label>
        <button
          type="button"
          onClick={props.onOpenCard}
          className="flex w-full min-w-0 flex-col gap-0.5 rounded-xl bg-(--m-surface) px-3 py-2.5 text-start outline-none hover:bg-(--m-chip) focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--m-accent)"
        >
          <span className="font-medium">
            {entry.boardName} #{entry.cardNumber}
          </span>
          <span className="text-(--m-muted) [overflow-wrap:anywhere]">
            {STAGE_LABELS[entry.stage]} · {entry.cardTitle}
          </span>
        </button>
      </div>
      <div className="border-t border-(--m-rule) pt-4">
        <Label className="mb-2">Why it is here</Label>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5">
          {facts.map(([name, value]) => (
            <div key={name} className="contents">
              <dt>{name}</dt>
              <dd className="text-end font-medium tabular-nums [overflow-wrap:anywhere]">
                {value}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </aside>
  );
}
