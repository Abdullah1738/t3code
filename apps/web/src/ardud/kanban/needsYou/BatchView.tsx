import {
  ASK_BATCH_MAX,
  askKindLabel,
  planAskBatch,
  type AskKeyAction,
} from "@t3tools/client-runtime/ardud/kanban";
import { kanbanAskResponse, type KanbanAskFeedItem } from "@t3tools/contracts";
import { useImperativeHandle, useRef, useState, type RefObject } from "react";

import { cn } from "../../../lib/utils";
import { GrowingText, Problem } from "./AnswerParts";
import type { AskReaderHandle } from "./AskReader";
import { answerAskBatch, askKey, snoozeAsks } from "./askStore";
import { SnoozeMenu, SnoozePick, SnoozeRows } from "./SnoozeMenu";
import { tomorrowMorning, type SnoozeUntil } from "./snoozeTimes";
import { HandOver } from "./HandOver";
import { Btn, Key, Label, Layer, Pill, linkClass, type PageLayout } from "./ui";

/**
 * Several asks of one shape, answered with one answer. Asks that take more
 * than that answer are listed apart and stay in the queue.
 */
export function BatchView(props: {
  batchKey: string;
  title: string;
  boardName: string;
  entries: ReadonlyArray<KanbanAskFeedItem>;
  layout: PageLayout;
  nowMs: number;
  handle: RefObject<AskReaderHandle | null>;
  onOpenAsk: (key: string) => void;
  onLeave: () => void;
}) {
  const plan = planAskBatch(props.entries);
  const offered = plan.included.slice(0, ASK_BATCH_MAX);
  const over = plan.included.length - offered.length;
  // Every ask is in until he unticks it.
  const [left, setLeft] = useState<ReadonlySet<string>>(new Set());
  const included = offered.filter((entry) => !left.has(askKey(entry)));
  const count = included.length;
  const first = offered[0];
  const response = first ? kanbanAskResponse(first.ask) : null;
  const shape = plan.shape?.split(":")[0] ?? null;
  const [optionIds, setOptionIds] = useState<ReadonlyArray<string>>([]);
  const [text, setText] = useState("");
  const [note, setNote] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const phone = props.layout === "phone";
  const [moreOpen, setMoreOpen] = useState(false);
  const [pickOpen, setPickOpen] = useState(false);
  // An evaluator can take what an owner can decide: not a notice, not one already asked of it.
  const handable =
    shape !== null && shape !== "ack" && included.every((entry) => entry.ask.to !== "evaluator");

  const labels = new Set(included.map((entry) => kanbanAskResponse(entry.ask).verdict?.approve));
  const approve = labels.size === 1 ? (response?.verdict?.approve ?? "Approve") : "Approve";
  const rejects = new Set(included.map((entry) => kanbanAskResponse(entry.ask).verdict?.reject));
  const reject = rejects.size === 1 ? (response?.verdict?.reject ?? "Reject") : "Reject";
  const all =
    count === 1
      ? "this one"
      : count < offered.length
        ? `these ${count}`
        : count === 2
          ? "both"
          : `all ${count}`;

  const send = (intent: "primary" | "refuse") => {
    if (count === 0 || shape === null) return;
    const trimmedNote = note.trim();
    const extra = shape === "ack" || trimmedNote === "" ? {} : { note: trimmedNote };
    const go = (verdict: string, label: string, more: object = {}) =>
      answerAskBatch(included, props.batchKey, { verdict, ...more, ...extra }, label, props.title);
    if (shape === "ack") return go("acknowledged", "Seen");
    if (shape === "verdict") {
      return intent === "refuse"
        ? go("rejected", reject === "Reject" ? "Rejected" : reject)
        : go("approved", approve === "Approve" ? "Approved" : approve);
    }
    if (shape === "choose") {
      const choose = response?.choose;
      const picked =
        optionIds.length > 0
          ? optionIds
          : (
              choose?.options.filter((option) => option.recommended).map((option) => option.id) ??
              []
            ).slice(0, 1);
      if (choose && (picked.length < Math.max(1, choose.min) || picked.length > choose.max)) {
        setProblem(choose.max === 1 ? "Pick one first" : `Pick ${choose.min} to ${choose.max}`);
        root.current?.querySelector<HTMLElement>("[data-ny-option]")?.focus();
        return;
      }
      return go("picked", "Answer sent", { optionIds: picked });
    }
    if (text.trim() === "") {
      setProblem("Type the answer first");
      root.current?.querySelector<HTMLElement>("[data-ny-at='text']")?.focus();
      return;
    }
    return go("answered", "Answer sent", { text: text.trim() });
  };

  const snoozeUntil = (until: SnoozeUntil) => {
    props.onLeave();
    void snoozeAsks(included.length > 0 ? included : offered, until.iso, until.label);
  };
  const snooze = () => snoozeUntil(tomorrowMorning());

  useImperativeHandle(props.handle, () => ({
    act: (action: AskKeyAction) => {
      if (action._tag === "primary") send("primary");
      else if (action._tag === "refuse" && shape === "verdict") send("refuse");
      else if (action._tag === "snooze") snooze();
      else if (action._tag === "note") {
        root.current?.querySelector<HTMLElement>("[data-ny-at='note']")?.focus();
      } else if (action._tag === "pick") {
        root.current?.querySelector<HTMLElement>(`[data-ny-option="${action.index}"]`)?.click();
      }
    },
  }));

  const primaryLabel =
    shape === "ack" ? `Seen, ${all}` : shape === "verdict" ? `${approve} ${all}` : `Send to ${all}`;

  return (
    <div ref={root} className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div
        key={props.batchKey}
        tabIndex={-1}
        data-ny-scroll
        data-ny-enter
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain outline-none"
      >
        <article
          aria-labelledby="ny-ask-title"
          className={cn(
            "flex max-w-[760px] min-w-0 flex-col gap-5 pt-6 pb-8",
            phone ? "px-4" : "px-7",
          )}
        >
          <header className="flex flex-col gap-2.5">
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-sm text-(--m-muted)">
              <span className="font-medium text-(--m-text)">{props.boardName}</span>
              {first ? <span>{askKindLabel(first.kind)}</span> : null}
            </div>
            <h2 id="ny-ask-title" className="text-xl leading-7 font-semibold text-balance">
              {props.title}
            </h2>
          </header>

          {offered.length > 0 ? (
            <section aria-label="Answered together">
              <Label className="mb-2">
                {count === 0
                  ? "Tick the ones to answer"
                  : `One answer goes to ${count === 1 ? "this one" : count === 2 ? "both" : `these ${count}`}`}
              </Label>
              <AskList
                entries={offered}
                left={left}
                onToggle={(key) =>
                  setLeft((current) => {
                    const next = new Set(current);
                    if (!next.delete(key)) next.add(key);
                    return next;
                  })
                }
                onToggleAll={() =>
                  setLeft(
                    left.size === 0 ? new Set(offered.map((entry) => askKey(entry))) : new Set(),
                  )
                }
                onOpenAsk={props.onOpenAsk}
              />
              {over > 0 ? (
                <p className="mt-2 text-sm text-(--m-muted)">
                  {over} more stay in the queue: one answer takes {ASK_BATCH_MAX} at most.
                </p>
              ) : null}
            </section>
          ) : (
            <p className="text-(--m-muted)">None of these can share an answer. Open each one.</p>
          )}

          {plan.skipped.length > 0 ? (
            <section aria-label="Not answered with the batch">
              <Label className="mb-2">Not answered with the batch</Label>
              <AskList
                entries={plan.skipped.map((entry) => entry.item)}
                why={plan.skipped.map((entry) => entry.why)}
                onOpenAsk={props.onOpenAsk}
              />
            </section>
          ) : null}

          {count > 0 && shape === "choose" && response?.choose ? (
            <section aria-label="Your answer" className="flex flex-col gap-3">
              <h3 className="text-base font-semibold">Your answer</h3>
              <div
                role={response.choose.multi ? "group" : "radiogroup"}
                aria-label="Options"
                className="grid gap-2"
              >
                {response.choose.options.map((option, index) => {
                  const checked = optionIds.includes(option.id);
                  return (
                    <button
                      key={option.id}
                      type="button"
                      role={response.choose!.multi ? "checkbox" : "radio"}
                      aria-checked={checked}
                      data-ny-option={index}
                      onClick={() => {
                        setProblem(null);
                        setOptionIds(
                          response.choose!.multi
                            ? checked
                              ? optionIds.filter((id) => id !== option.id)
                              : [...optionIds, option.id]
                            : checked
                              ? []
                              : [option.id],
                        );
                      }}
                      className={cn(
                        "grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1 rounded-xl px-3.5 py-3 text-start outline-none ring-1 ring-inset focus-visible:ring-2 focus-visible:ring-(--m-accent)",
                        checked
                          ? "bg-(--m-band) ring-2 ring-(--m-accent) focus-visible:ring-(--m-text)"
                          : "ring-(--ny-edge) hover:bg-(--m-surface)",
                      )}
                    >
                      <Key className="mt-0.5">{index + 1}</Key>
                      <span className="font-medium [overflow-wrap:anywhere]">{option.label}</span>
                      {option.recommended ? <Pill tone="accent">Recommended</Pill> : <span />}
                      {option.detail ? (
                        <span className="col-span-2 col-start-2 text-sm text-(--m-muted)">
                          {option.detail}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
              {problem ? <Problem>{problem}</Problem> : null}
            </section>
          ) : null}
          {count > 0 && shape === "text" ? (
            <section aria-label="Your answer" className="flex flex-col gap-3">
              <h3 className="text-base font-semibold">Your answer</h3>
              <GrowingText
                data-ny-at="text"
                aria-label="Your answer"
                placeholder="Type one answer for all of them…"
                value={text}
                maxLength={20_000}
                aria-invalid={problem ? true : undefined}
                onChange={(event) => {
                  setProblem(null);
                  setText(event.target.value);
                }}
              />
              {problem ? <Problem>{problem}</Problem> : null}
            </section>
          ) : null}
          {count > 0 && shape !== "ack" && shape !== null ? (
            <div>
              <label
                htmlFor="ny-batch-note"
                className="mb-1.5 flex items-baseline gap-2 text-sm font-medium"
              >
                Note <span className="font-normal text-(--m-muted)">Optional, goes with each</span>
              </label>
              <GrowingText
                id="ny-batch-note"
                data-ny-at="note"
                value={note}
                maxLength={4_000}
                onChange={(event) => setNote(event.target.value)}
              />
            </div>
          ) : null}
          {count > 0 && handable ? (
            <HandOver
              entries={included}
              focusKey={props.batchKey}
              title={props.title}
              phone={phone}
              onLeave={props.onLeave}
            />
          ) : null}
        </article>
      </div>
      {count > 0 && shape !== null ? (
        <div className="shrink-0 border-t border-(--m-rule) pb-safe">
          <div className="flex min-w-0 items-center gap-2 px-5 py-3 max-sm:gap-1.5 max-sm:px-3">
            {phone ? (
              <Btn onClick={() => setMoreOpen(true)} className="px-3.5">
                More
              </Btn>
            ) : null}
            <Btn
              tone="primary"
              onClick={() => send("primary")}
              className={phone ? "min-w-0 flex-1" : undefined}
            >
              <span className="truncate">{primaryLabel}</span>
              <Key className="text-(--m-accent-ink) ring-(--m-accent-ink)/40">A</Key>
            </Btn>
            {phone ? null : <SnoozeMenu label={`Snooze ${all}`} onSnooze={snoozeUntil} />}
            {/* The "no" is last, as under a single ask. */}
            {shape === "verdict" && !phone ? (
              <Btn tone="ghost" onClick={() => send("refuse")}>
                {reject} {all}
                <Key>X</Key>
              </Btn>
            ) : null}
          </div>
        </div>
      ) : null}
      {phone ? (
        <>
          <Layer
            open={moreOpen}
            onClose={() => setMoreOpen(false)}
            title="More"
            side="bottom"
            bodyClassName="flex flex-col gap-1 p-3"
          >
            {shape === "verdict" ? (
              <button
                type="button"
                className={moreRow}
                onClick={() => {
                  setMoreOpen(false);
                  send("refuse");
                }}
              >
                {reject} {all}
              </button>
            ) : null}
            <SnoozeRows
              nowMs={props.nowMs}
              onSnooze={(until) => {
                setMoreOpen(false);
                snoozeUntil(until);
              }}
              onPick={() => {
                setMoreOpen(false);
                setPickOpen(true);
              }}
            />
          </Layer>
          <SnoozePick
            open={pickOpen}
            phone
            onClose={() => setPickOpen(false)}
            onSnooze={snoozeUntil}
          />
        </>
      ) : null}
    </div>
  );
}

const moreRow =
  "flex min-h-11 items-center rounded-xl px-3 text-start text-base outline-none hover:bg-(--m-surface) focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--m-accent)";

const tick =
  "size-4 shrink-0 translate-y-0.5 accent-(--m-accent) outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--m-accent)";

function AskList(props: {
  entries: ReadonlyArray<KanbanAskFeedItem>;
  why?: ReadonlyArray<string>;
  /** With these, each row has a tick box: the asks he took out of the answer. */
  left?: ReadonlySet<string>;
  onToggle?: (key: string) => void;
  onToggleAll?: () => void;
  onOpenAsk: (key: string) => void;
}) {
  const { left, onToggle } = props;
  return (
    <ul className="flex flex-col divide-y divide-(--m-rule) rounded-xl ring-1 ring-(--m-rule)">
      {left && props.onToggleAll && props.entries.length > 1 ? (
        <li className="px-3.5 py-2 text-sm">
          <label className="flex items-baseline gap-3 pointer-coarse:min-h-8">
            <input
              type="checkbox"
              className={tick}
              checked={left.size === 0}
              onChange={props.onToggleAll}
            />
            Select all
          </label>
        </li>
      ) : null}
      {props.entries.map((entry, index) => (
        <li key={askKey(entry)} className="flex min-w-0 items-baseline gap-3 px-3.5 py-2.5 text-sm">
          {left && onToggle ? (
            <input
              type="checkbox"
              className={tick}
              aria-label={`Answer #${entry.cardNumber} with the rest`}
              checked={!left.has(askKey(entry))}
              onChange={() => onToggle(askKey(entry))}
            />
          ) : null}
          <button
            type="button"
            onClick={() => props.onOpenAsk(askKey(entry))}
            className={cn(linkClass, "shrink-0 tabular-nums")}
          >
            #{entry.cardNumber}
          </button>
          <span className="min-w-0 flex-1">
            <span className="block [overflow-wrap:anywhere]">
              {entry.ask.title ?? entry.ask.text}
            </span>
            {entry.ask.action?.command ? (
              <code
                translate="no"
                className="mt-0.5 block font-mono text-xs text-(--m-muted) [overflow-wrap:anywhere]"
              >
                {entry.ask.action.command}
              </code>
            ) : null}
            {props.why?.[index] ? (
              <span className="block text-(--m-muted)">{props.why[index]}</span>
            ) : null}
          </span>
        </li>
      ))}
    </ul>
  );
}
