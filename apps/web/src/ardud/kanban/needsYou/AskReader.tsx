import {
  STAGE_LABELS,
  askAge,
  askFieldKind,
  askFormFor,
  askDiscussion,
  askFormWithSecrets,
  nextChangeView,
  askKindLabel,
  askRefusal,
  askRequiresSecret,
  askSecretAnswerInput,
  askSecretFieldIds,
  buildAskAnswer,
  isPlainAnswerField,
  needsYouMarkOf,
  diffPieces,
  wordDiff,
  type AskKeyAction,
  type AskSecretAnswerInput,
  type NeedsYouItem,
  type NeedsYouMark,
} from "@t3tools/client-runtime/ardud/kanban";
import {
  kanbanAskChanges,
  kanbanAskResponse,
  kanbanAskRevision,
  type KanbanAskFeedItem,
  type KanbanBoard,
} from "@t3tools/contracts";
import { MessageSquareIcon } from "lucide-react";
import {
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";

import { observeResize } from "../../../lib/observeResize";
import { cn } from "../../../lib/utils";
import { BoardIcon } from "../boardIcon";
import { KanbanLinksProvider, KanbanMarkdown } from "../links";
import { ActionBar, type AskTurn } from "./ActionBar";
import { ActionDetails } from "./ActionDetails";
import {
  NoteField,
  OptionList,
  TaskSteps,
  WhyField,
  askOffersOwnWords,
  type AskProblems,
} from "./AnswerParts";
import { AskBlocks, BlockPicture, useAskMedia } from "./AskBlocks";
import { AskDiscussion } from "./AskDiscussion";
import { FieldRow } from "./AskFields";
import { askApi, askFailureText } from "./askApi";
import {
  answerAsk,
  askAsker,
  askKey,
  askNeedsDetail,
  loadAskDetail,
  markAskTried,
  noteAskAnswered,
  noteAskStale,
  patchAskForm,
  replyOnAsk,
  retryAskSend,
  seeAsk,
  setAskChangeView,
  showAskToast,
  snoozeAsks,
  takeBackAsk,
  useAskStore,
} from "./askStore";
import { ChangeViewer } from "./ChangeView";
import { DraftPart } from "./DraftPart";
import { EvaluatorThreadLink, HandOver } from "./HandOver";
import { MediaViewer } from "./MediaViewer";
import { shortWhen, tomorrowMorning } from "./snoozeTimes";
import { Btn, Key, Label, Layer, Pill, linkClass, type PageLayout } from "./ui";

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
  nowMs: number;
  handle: RefObject<AskReaderHandle | null>;
  onOpenCard: () => void;
  /** Opens a card the ask links to, which may not be its own. */
  onOpenLinkedCard: (cardId: string) => void;
  /** He set the ask aside: the page moves on to the next one. */
  onLeave: () => void;
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
  const marks = useAskStore((state) => state.marks);
  const mark: NeedsYouMark | undefined = needsYouMarkOf(item, marks);
  const failed = useAskStore((state) => state.failed[key]);
  const previous = useAskStore((state) => state.previous[key]);
  const [noteOpen, setNoteOpen] = useState(false);
  const [replyOpen, setReplyOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const phone = layout === "phone";
  // On a phone the discussion is a sheet that stops above the answer bar.
  const bar = useRef<HTMLDivElement>(null);
  const [barHeight, setBarHeight] = useState(0);
  useLayoutEffect(() => {
    const element = bar.current;
    if (!element) return;
    setBarHeight(element.offsetHeight);
    return observeResize(element, () => setBarHeight(element.offsetHeight));
  }, []);
  const response = kanbanAskResponse(ask);
  const refusal = askRefusal(response);
  const locked = turn === "evaluator" || turn === "expired";
  const root = useRef<HTMLDivElement>(null);

  // The feed carries big blocks as stubs: read the ask whole once it is open.
  const needsDetail = detail === undefined && askNeedsDetail(entry.ask);
  useEffect(() => {
    if (needsDetail) void loadAskDetail(entry).catch(() => undefined);
  }, [needsDetail, entry]);

  // After an answer the old ask's button is gone: focus lands on the new ask, not on nothing.
  useEffect(() => {
    if (document.activeElement !== document.body) return;
    root.current?.querySelector<HTMLElement>("[data-ny-scroll]")?.focus({ preventScroll: true });
  }, []);

  // What was new on the ask counts as seen once he moves on from it.
  useEffect(() => () => seeAsk(key), [key]);

  // Secret values live here and nowhere else: gone when he sends, and when he leaves the ask.
  const [secrets, setSecrets] = useState<Readonly<Record<string, string>>>({});
  const [secretBusy, setSecretBusy] = useState(false);
  const [secretError, setSecretError] = useState<string | null>(null);

  const media = useAskMedia(ask);
  const [viewing, setViewing] = useState<number | null>(null);
  const changes = kanbanAskChanges(ask);
  const changeView = useAskStore((state) => state.changeView);
  const [changeIndex, setChangeIndex] = useState(0);
  const wide = layout !== "phone";
  // Blocks a field or an option already draws are not drawn a second time.
  const optionPictures = (response.choose?.options ?? []).flatMap((option) =>
    option.block !== undefined && media.indexOf.has(option.block) ? [option.block] : [],
  );
  const placed = new Set<number>([
    ...response.fields.flatMap((field) => (field.block === undefined ? [] : [field.block])),
    ...optionPictures,
  ]);

  const built = buildAskAnswer(
    ask,
    askFormWithSecrets(ask, form, secrets),
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
  // An answer that carries a secret is not held for Undo: it goes at once, over
  // the private channel, and the typed value is dropped as it leaves.
  const sendSecrets = async (input: AskSecretAnswerInput, label: string) => {
    setSecretBusy(true);
    setSecretError(null);
    setSecrets({});
    const outcome = await askApi
      .answerSecrets({ ...input, cardId: entry.cardId }, kanbanAskRevision(ask))
      .finally(() => setSecretBusy(false));
    if (outcome._tag === "sent") {
      noteAskAnswered(entry, input.answer, label);
      return;
    }
    if (outcome._tag === "interrupted") return;
    const { failure } = outcome;
    setSecretError(failure.message);
    if (failure.stale) noteAskStale(entry);
    focusAt(`field:${failure.field ?? askSecretFieldIds(ask)[0] ?? ""}`);
  };
  const send = (intent: "primary" | "refuse") => {
    if (locked || secretBusy) return;
    const now = buildAskAnswer(
      ask,
      askFormWithSecrets(ask, form, secrets),
      intent,
      kanbanAskRevision(ask),
    );
    if (!now.ok) {
      markAskTried(entry);
      focusAt(now.first);
      return;
    }
    const input = askSecretAnswerInput(entry.cardId, ask, now.body, secrets);
    if (input !== null) {
      void sendSecrets(input, now.label);
      return;
    }
    const result = answerAsk({ ...entry, ask }, intent);
    if (!result.ok) focusAt(result.first);
  };
  const snooze = () => {
    if (item.snoozed) return void snoozeAsks([entry], null, "");
    const until = tomorrowMorning();
    props.onLeave();
    return void snoozeAsks([entry], until.iso, until.label);
  };
  const primary = () => send(form.refusing ? "refuse" : "primary");
  const refuse = () => {
    if (locked || refusal === null) return;
    if (refusal.why === "none" || form.refusing) return send("refuse");
    patchAskForm(entry, { refusing: true });
    focusAt("why");
  };
  const canTalk = turn === "owner" || turn === "agent";
  const canNote = canTalk && !response.ack;
  const addNote = () => {
    if (!canNote) return;
    setNoteOpen(true);
    focusAt("note");
  };
  const reply = () => {
    setReplyOpen(true);
    // The sheet focuses its own composer once it is open.
    if (phone) return;
    requestAnimationFrame(() => {
      const editor = root.current?.querySelector<HTMLElement>(
        "[data-ny-discussion] [contenteditable='true']",
      );
      editor?.focus();
      editor?.scrollIntoView({ block: "nearest" });
    });
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
        case "snooze":
          return snooze();
        case "note":
          return addNote();
        case "reply":
          return reply();
        case "edit":
          if (response.edit === "draft") {
            root.current?.querySelector<HTMLElement>("[data-ny-edit]")?.click();
            return undefined;
          }
          return firstText ? focusAt(`field:${firstText.id}`) : undefined;
        case "view":
          return setAskChangeView(nextChangeView(changeView, wide));
        case "change":
          return setChangeIndex((current) =>
            Math.max(0, Math.min(changes.length - 1, current + action.delta)),
          );
        default:
          return undefined;
      }
    },
  }));

  const title = ask.title ?? entry.cardTitle;
  const plain = response.fields.length === 1 && isPlainAnswerField(ask, response.fields[0]!);
  const showNote = canNote && (noteOpen || form.note !== "");
  const said = askDiscussion(entry).length;
  const hasAnswerParts =
    response.choose !== null ||
    response.fields.length > 0 ||
    form.refusing ||
    showNote ||
    response.task !== null;

  const aside = (
    <AskFacts
      entry={entry}
      item={item}
      turn={turn}
      onOpenCard={props.onOpenCard}
      handOver={
        canTalk && !response.ack && ask.to !== "evaluator" ? (
          <HandOver
            entry={entry}
            phone={layout === "phone"}
            needsSecret={askRequiresSecret(ask)}
            onLeave={props.onLeave}
          />
        ) : null
      }
    />
  );

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
              <StatePills entry={entry} item={item} turn={turn} mark={mark} nowMs={props.nowMs} />
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
            {secretError ? <Banner tone="negative">{secretError}</Banner> : null}
            {mark === "back" && item.backFromSnoozeAt ? (
              <Banner tone="accent">
                Back from snooze since {shortWhen(item.backFromSnoozeAt, props.nowMs)}.
              </Banner>
            ) : null}
            {mark === "updated" ? (
              <Banner tone="accent">
                Its agent changed this ask{ask.revisionNote ? `: ${ask.revisionNote}` : "."} What
                you typed is kept.
                {previous && previous.text !== ask.text ? (
                  <span className="mt-1.5 block text-(--m-text)">
                    {diffPieces(wordDiff(previous.text, ask.text), "both").map((piece, index) =>
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
                  </span>
                ) : null}
              </Banner>
            ) : null}
            {turn === "evaluator" && ask.handedThreadId ? (
              <Banner tone="accent">
                Handed over with your words.{" "}
                <EvaluatorThreadLink threadId={ask.handedThreadId}>
                  Open the evaluator thread
                </EvaluatorThreadLink>
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

            {ask.action ? <ActionDetails action={ask.action} /> : null}
            {changes.length > 0 ? (
              <ChangeViewer
                changes={changes}
                view={changeView}
                onView={setAskChangeView}
                index={changeIndex}
                onIndex={setChangeIndex}
                wide={wide}
              />
            ) : null}
            <AskBlocks
              ask={ask}
              media={media}
              skip={placed}
              onOpenMedia={setViewing}
              onOpenCard={props.onOpenLinkedCard}
            />

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
                    renderBlock={(index) => (
                      <BlockPicture
                        bare
                        media={media}
                        index={index}
                        onOpen={setViewing}
                        className="h-40 w-full max-w-none rounded-none object-cover"
                      />
                    )}
                  />
                ) : null}
                {optionPictures.length > 0 ? (
                  <button
                    type="button"
                    onClick={() => setViewing(media.indexOf.get(optionPictures[0]!) ?? 0)}
                    className={cn(linkClass, "-mt-2 self-start text-sm")}
                  >
                    See them full size
                  </button>
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
                        disabled={locked || secretBusy}
                        secret={secrets[field.id] ?? ""}
                        onSecret={(value) => {
                          setSecretError(null);
                          setSecrets((current) => ({ ...current, [field.id]: value }));
                        }}
                      />
                    ))}
                  </div>
                ) : null}
                {form.refusing ? (
                  <WhyField entry={entry} response={response} form={form} problem={problems.why} />
                ) : null}
                {showNote ? (
                  <NoteField
                    entry={entry}
                    form={form}
                    problem={problems.note}
                    disabled={secretBusy}
                  />
                ) : null}
              </section>
            ) : null}

            {phone ? null : (
              <AskDiscussion
                entry={entry}
                waiting={turn === "agent"}
                open={canTalk}
                onOpenCard={props.onOpenLinkedCard}
              />
            )}

            {layout === "desktop" ? null : aside}
          </article>
          {layout === "desktop" ? <div className="pt-6 pb-8">{aside}</div> : null}
        </div>

        <div ref={bar} className="shrink-0 border-t border-(--m-rule)">
          <ActionBar
            ask={ask}
            form={form}
            turn={turn}
            phone={phone}
            compact={layout === "tablet"}
            more={
              <Btn tone="ghost" onClick={() => setMoreOpen(true)}>
                More
              </Btn>
            }
            busy={secretBusy}
            snoozed={item.snoozed}
            onSnooze={snooze}
            lead={
              canTalk ? (
                <>
                  <Btn
                    aria-label={`Discussion, ${said} ${said === 1 ? "message" : "messages"}`}
                    onClick={reply}
                    className="px-3"
                  >
                    <MessageSquareIcon aria-hidden />
                    {said > 0 ? <span className="tabular-nums">{said}</span> : null}
                  </Btn>
                  <Btn onClick={() => setMoreOpen(true)} className="px-3.5">
                    More
                  </Btn>
                </>
              ) : null
            }
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
              ]).catch((error: unknown) =>
                showAskToast({ text: `Couldn't ask for a refresh. ${askFailureText(error)}` }),
              )
            }
          >
            {canNote && !showNote && layout === "desktop" ? (
              <Btn onClick={addNote}>
                Add a note
                <Key>N</Key>
              </Btn>
            ) : null}
            {canTalk ? (
              <Btn onClick={reply}>
                <MessageSquareIcon aria-hidden />
                Reply
                <Key>R</Key>
              </Btn>
            ) : null}
          </ActionBar>
        </div>
        {layout === "desktop" ? null : (
          <>
            <Layer
              open={replyOpen && phone}
              onClose={() => setReplyOpen(false)}
              title={`Discussion · ${entry.boardName} #${entry.cardNumber}`}
              side="bottom"
              tall
              bottomOffset={barHeight}
              bodyClassName="flex min-h-0 flex-col p-0"
            >
              <AskDiscussion
                sheet
                entry={entry}
                waiting={turn === "agent"}
                open
                onOpenCard={props.onOpenLinkedCard}
              />
            </Layer>
            <Layer
              open={moreOpen}
              onClose={() => setMoreOpen(false)}
              title="More"
              side={phone ? "bottom" : "center"}
              bodyClassName="flex flex-col gap-1 p-3"
            >
              {canNote && !showNote ? (
                <MoreRow
                  onClick={() => {
                    setMoreOpen(false);
                    addNote();
                  }}
                >
                  Add a note for the agent
                </MoreRow>
              ) : null}
              <MoreRow
                onClick={() => {
                  setMoreOpen(false);
                  snooze();
                }}
              >
                {item.snoozed ? "Bring back" : "Snooze until tomorrow 09:00"}
              </MoreRow>
              {phone && refusal && !form.refusing ? (
                <MoreRow
                  onClick={() => {
                    setMoreOpen(false);
                    refuse();
                  }}
                >
                  {refusal.label}
                </MoreRow>
              ) : null}
              <MoreRow
                onClick={() => {
                  setMoreOpen(false);
                  props.onOpenCard();
                }}
              >
                Open the card
              </MoreRow>
            </Layer>
          </>
        )}
        {viewing !== null && media.items.length > 0 ? (
          <MediaViewer
            items={media.items}
            index={viewing}
            onIndex={setViewing}
            onClose={() => setViewing(null)}
          />
        ) : null}
      </div>
    </KanbanLinksProvider>
  );
}

function MoreRow(props: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className="flex min-h-11 items-center rounded-xl px-3 text-start text-base outline-none hover:bg-(--m-surface) focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--m-accent)"
    >
      {props.children}
    </button>
  );
}

function StatePills(props: {
  entry: KanbanAskFeedItem;
  item: NeedsYouItem;
  turn: AskTurn;
  mark: NeedsYouMark | undefined;
  nowMs: number;
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
  if (props.mark === "back") {
    pills.push(
      <Pill key="back" tone="accent">
        Back from snooze
      </Pill>,
    );
  }
  if (item.snoozed && entry.ask.snoozedUntil) {
    pills.push(
      <Pill key="snoozed">Snoozed until {shortWhen(entry.ask.snoozedUntil, props.nowMs)}</Pill>,
    );
  }
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
  handOver: ReactNode;
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
      {props.handOver}
    </aside>
  );
}
