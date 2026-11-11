/**
 * The parts of an answer, drawn from what the ask takes back
 * (`kanbanAskResponse`), never from its kind.
 */
import {
  askRefusal,
  askWordsForReply,
  type AskForm,
  type AskProblemKey,
} from "@t3tools/client-runtime/ardud/kanban";
import type { KanbanAskFeedItem, KanbanAskResponse, KanbanAskTaskStep } from "@t3tools/contracts";
import { CheckIcon, CornerDownRightIcon, ExternalLinkIcon } from "lucide-react";
import { useId, useState, type ReactNode } from "react";

import { cn } from "../../../lib/utils";
import { patchAskForm } from "./askStore";
import { Key, Pill, fieldClass, linkClass } from "./ui";

export type AskProblems = Readonly<Partial<Record<AskProblemKey, string>>>;

export function Problem(props: { id?: string; children: ReactNode }) {
  return (
    <p id={props.id} role="alert" className="mt-1.5 text-sm text-(--m-negative)">
      {props.children}
    </p>
  );
}

/** A textarea that is as tall as what is typed in it. */
export function GrowingText({
  className,
  ...props
}: React.ComponentProps<"textarea"> & { value: string }) {
  return (
    <div className="grid">
      <textarea
        rows={2}
        {...props}
        className={cn(fieldClass, "col-start-1 row-start-1 resize-none overflow-hidden", className)}
      />
      <div
        aria-hidden
        className={cn(
          fieldClass,
          "invisible col-start-1 row-start-1 min-h-[3.75rem] whitespace-pre-wrap [overflow-wrap:anywhere]",
          className,
        )}
      >
        {props.value}{" "}
      </div>
    </div>
  );
}

/** Whether "Your own answer" is offered beside the options. */
export const askOffersOwnWords = (response: KanbanAskResponse): boolean =>
  response.choose !== null && !response.choose.multi && response.verdict === null;

/** Options to pick from: one, or several within the ask's limits. */
export function OptionList(props: {
  entry: KanbanAskFeedItem;
  choose: NonNullable<KanbanAskResponse["choose"]>;
  ownWords: boolean;
  form: AskForm;
  problem: string | undefined;
  disabled: boolean;
  /** A picture or chart an option points at, drawn inside it. */
  renderBlock?: (index: number) => ReactNode;
}) {
  const { entry, choose, form } = props;
  const [ownOpen, setOwnOpen] = useState(false);
  const own = props.ownWords && (ownOpen || form.ownWords !== "");
  const problemId = useId();
  const pictures = choose.options.some((option) => option.block !== undefined) && props.renderBlock;

  const toggle = (id: string) => {
    if (props.disabled) return;
    if (!choose.multi) {
      setOwnOpen(false);
      patchAskForm(entry, { optionIds: form.optionIds[0] === id ? [] : [id], ownWords: "" });
      return;
    }
    const picked = form.optionIds.includes(id);
    if (!picked && form.optionIds.length >= choose.max) return;
    patchAskForm(entry, {
      optionIds: picked ? form.optionIds.filter((entry) => entry !== id) : [...form.optionIds, id],
    });
  };
  const full = choose.multi && form.optionIds.length >= choose.max;

  return (
    // Picture options go two abreast by the room the reader has, not by the window's width.
    <div className="@container">
      {choose.multi ? (
        <p className="mb-2 text-sm text-(--m-muted)">
          {choose.min === choose.max
            ? `Pick ${choose.max}`
            : choose.min > 0
              ? `Pick ${choose.min} to ${choose.max}`
              : `Pick up to ${choose.max}`}
        </p>
      ) : null}
      <div
        role={choose.multi ? "group" : "radiogroup"}
        aria-label="Options"
        aria-describedby={props.problem ? problemId : undefined}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          const options = [
            ...event.currentTarget.querySelectorAll<HTMLElement>("[data-ny-option]"),
          ];
          const at = options.indexOf(document.activeElement as HTMLElement);
          if (at === -1) return;
          event.preventDefault();
          const step = event.key === "ArrowDown" ? 1 : -1;
          options[(at + step + options.length) % options.length]?.focus();
        }}
        className={cn(
          "grid gap-2",
          pictures && "@md:grid-cols-2",
          pictures && choose.options.length % 3 === 0 && "@3xl:grid-cols-3",
        )}
      >
        {choose.options.map((option, index) => {
          const checked = !own && form.optionIds.includes(option.id);
          const blocked = props.disabled || (full && !checked);
          return (
            <button
              key={option.id}
              type="button"
              role={choose.multi ? "checkbox" : "radio"}
              aria-checked={checked}
              aria-disabled={blocked || undefined}
              data-ny-at={index === 0 ? "choose" : undefined}
              data-ny-option={index}
              onClick={() => toggle(option.id)}
              className={cn(
                "grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1 rounded-xl px-3.5 py-3 text-start outline-none ring-1 ring-inset focus-visible:ring-2 focus-visible:ring-(--m-accent)",
                checked
                  ? "bg-(--m-band) ring-2 ring-(--m-accent) focus-visible:ring-(--m-text)"
                  : "ring-(--ny-edge) hover:bg-(--m-surface)",
                blocked && !checked && "opacity-50",
              )}
            >
              {pictures && option.block !== undefined ? (
                <span className="col-span-3 mb-1.5 block overflow-hidden rounded-lg">
                  {props.renderBlock!(option.block)}
                </span>
              ) : null}
              <Key className="mt-0.5">{index + 1}</Key>
              <span className="font-medium [overflow-wrap:anywhere]">{option.label}</span>
              <span className="flex items-center gap-2">
                {option.recommended ? <Pill tone="accent">Recommended</Pill> : null}
                {checked ? (
                  <CheckIcon aria-hidden className="size-4 text-(--m-accent-text)" />
                ) : null}
              </span>
              {option.detail ? (
                <span className="col-span-2 col-start-2 text-sm text-(--m-muted) [overflow-wrap:anywhere] pointer-coarse:col-span-3 pointer-coarse:col-start-1">
                  {option.detail}
                </span>
              ) : null}
              {checked && option.consequence ? (
                <span className="col-span-2 col-start-2 flex gap-1.5 text-sm [overflow-wrap:anywhere] pointer-coarse:col-span-3 pointer-coarse:col-start-1">
                  <CornerDownRightIcon
                    aria-hidden
                    className="mt-0.5 size-3.5 shrink-0 text-(--m-muted)"
                  />
                  {option.consequence}
                </span>
              ) : null}
            </button>
          );
        })}
        {props.ownWords ? (
          <div
            className={cn(
              "relative grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-2 rounded-xl px-3.5 py-3 ring-1 ring-inset",
              own
                ? "bg-(--m-band) ring-2 ring-(--m-accent)"
                : "ring-(--ny-edge) hover:bg-(--m-surface)",
            )}
          >
            <Key className="mt-0.5">{choose.options.length + 1}</Key>
            <button
              type="button"
              role="radio"
              aria-checked={own}
              data-ny-option={choose.options.length}
              disabled={props.disabled}
              onClick={() => {
                if (own) {
                  setOwnOpen(false);
                  patchAskForm(entry, { ownWords: "" });
                } else {
                  setOwnOpen(true);
                  patchAskForm(entry, { optionIds: [] });
                }
              }}
              className={cn(
                "rounded text-start font-medium outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--m-accent)",
                // The whole card picks it until the text box is open; then a finger still gets a full target.
                own
                  ? "relative pointer-coarse:after:absolute pointer-coarse:after:-inset-x-2 pointer-coarse:after:-inset-y-2.5"
                  : "after:absolute after:inset-0 after:rounded-xl",
              )}
            >
              Your own answer
            </button>
            {own ? (
              <div className="col-start-2 pointer-coarse:col-span-2 pointer-coarse:col-start-1">
                <GrowingText
                  autoFocus={ownOpen && form.ownWords === ""}
                  data-ny-at="own"
                  aria-label="Your own answer"
                  placeholder="Type your answer…"
                  value={form.ownWords}
                  maxLength={20_000}
                  onChange={(event) => patchAskForm(entry, { ownWords: event.target.value })}
                />
                {askWordsForReply(entry.ask, form) !== null ? (
                  <p className="mt-1.5 text-xs text-(--m-muted)">
                    Words alone don't answer this one. They go to the agent as a reply and the ask
                    stays open.
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
      {props.problem ? <Problem id={problemId}>{props.problem}</Problem> : null}
    </div>
  );
}

/** After a "no": what is wrong, in his words. */
export function WhyField(props: {
  entry: KanbanAskFeedItem;
  response: KanbanAskResponse;
  form: AskForm;
  problem: string | undefined;
}) {
  const refusal = askRefusal(props.response);
  const id = useId();
  if (refusal === null) return null;
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 flex items-baseline gap-2 text-sm font-medium">
        {refusal.prompt}
        {refusal.why === "optional" ? (
          <span className="font-normal text-(--m-muted)">Optional</span>
        ) : null}
      </label>
      <GrowingText
        id={id}
        data-ny-at="why"
        autoFocus
        aria-invalid={props.problem ? true : undefined}
        aria-describedby={props.problem ? `${id}-problem` : undefined}
        value={props.form.why}
        maxLength={20_000}
        onChange={(event) => patchAskForm(props.entry, { why: event.target.value })}
      />
      {props.problem ? <Problem id={`${id}-problem`}>{props.problem}</Problem> : null}
    </div>
  );
}

/** A note that rides along with the answer to the agent that acts on it. */
export function NoteField(props: {
  entry: KanbanAskFeedItem;
  form: AskForm;
  problem: string | undefined;
  disabled: boolean;
}) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 flex items-baseline gap-2 text-sm font-medium">
        Note for the agent
        <span className="font-normal text-(--m-muted)">Goes with your answer</span>
      </label>
      <GrowingText
        id={id}
        data-ny-at="note"
        disabled={props.disabled}
        aria-invalid={props.problem ? true : undefined}
        aria-describedby={props.problem ? `${id}-problem` : undefined}
        value={props.form.note}
        onChange={(event) => patchAskForm(props.entry, { note: event.target.value })}
      />
      {props.problem ? <Problem id={`${id}-problem`}>{props.problem}</Problem> : null}
    </div>
  );
}

const linkHost = (link: string): string => {
  try {
    return new URL(link).host.replace(/^www\./, "");
  } catch {
    return "the link";
  }
};

/** Steps he does himself. Ticking them is for his own count; nothing is sent until Done. */
export function TaskSteps(props: {
  entry: KanbanAskFeedItem;
  steps: ReadonlyArray<KanbanAskTaskStep>;
  form: AskForm;
  disabled: boolean;
}) {
  const { entry, form } = props;
  return (
    <ol className="flex flex-col gap-1">
      {props.steps.map((step, index) => {
        const done = form.steps.includes(index);
        return (
          // oxlint-disable-next-line react/no-array-index-key -- Steps have no id; their order is fixed for one revision.
          <li key={index} className="flex min-w-0 flex-col items-start">
            <button
              type="button"
              role="checkbox"
              aria-checked={done}
              disabled={props.disabled}
              onClick={() =>
                patchAskForm(entry, {
                  steps: done
                    ? form.steps.filter((entry) => entry !== index)
                    : [...form.steps, index],
                })
              }
              className="group flex w-full min-w-0 items-start gap-3 rounded-lg py-1.5 text-start outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--m-accent) pointer-coarse:py-2.5"
            >
              <span
                aria-hidden
                className={cn(
                  "mt-0.5 grid size-5 shrink-0 place-items-center rounded-md ring-1 ring-inset",
                  done
                    ? "bg-(--m-accent) text-(--m-accent-ink) ring-(--m-accent)"
                    : "ring-(--ny-edge) group-hover:bg-(--m-surface)",
                )}
              >
                {done ? <CheckIcon className="size-3.5" /> : null}
              </span>
              <span className={cn("min-w-0 [overflow-wrap:anywhere]", done && "text-(--m-muted)")}>
                {step.text}
              </span>
            </button>
            {step.link ? (
              <a
                href={step.link}
                target="_blank"
                rel="noreferrer"
                className={cn(linkClass, "ms-8 mb-1 inline-flex items-center gap-1.5 text-sm")}
              >
                <ExternalLinkIcon aria-hidden className="size-3.5" />
                Open {linkHost(step.link)}
              </a>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
