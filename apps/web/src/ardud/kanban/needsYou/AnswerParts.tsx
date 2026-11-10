/**
 * The parts of an answer, drawn from what the ask takes back
 * (`kanbanAskResponse`), never from its kind.
 */
import {
  askFieldKind,
  askRefusal,
  type AskForm,
  type AskProblemKey,
} from "@t3tools/client-runtime/ardud/kanban";
import type { KanbanAskField, KanbanAskFeedItem, KanbanAskResponse } from "@t3tools/contracts";
import { CornerDownRightIcon } from "lucide-react";
import { useId, useState, type ReactNode } from "react";

import { cn } from "../../../lib/utils";
import { patchAskForm, setAskValue } from "./askStore";
import { Key, Pill, fieldClass } from "./ui";

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
    <div>
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
        className={cn("grid gap-2", pictures && "sm:grid-cols-2")}
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
                  ? "bg-(--m-band) ring-2 ring-(--m-accent)"
                  : "ring-(--m-control) hover:bg-(--m-surface)",
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
              {option.recommended ? <Pill tone="accent">Recommended</Pill> : <span />}
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
              "grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-2 rounded-xl px-3.5 py-3 ring-1 ring-inset",
              own
                ? "bg-(--m-band) ring-2 ring-(--m-accent)"
                : "ring-(--m-control) hover:bg-(--m-surface)",
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
              className="rounded text-start font-medium outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--m-accent)"
            >
              Your own answer
            </button>
            {own ? (
              <div className="col-start-2 pointer-coarse:col-span-2 pointer-coarse:col-start-1">
                <GrowingText
                  autoFocus={ownOpen && form.ownWords === ""}
                  data-ny-at="own"
                  aria-label="Your own answer"
                  placeholder="Type your answer"
                  value={form.ownWords}
                  maxLength={20_000}
                  onChange={(event) => patchAskForm(entry, { ownWords: event.target.value })}
                />
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
      {props.problem ? <Problem id={problemId}>{props.problem}</Problem> : null}
    </div>
  );
}

/** One value to fill in, with its label, hint and what is wrong with it. */
export function FieldRow(props: {
  entry: KanbanAskFeedItem;
  field: KanbanAskField;
  value: unknown;
  /** Shown as required even when the field itself is not (a task's proof). */
  required: boolean;
  problem: string | undefined;
  /** The only field of a plain question: its label is the section's heading. */
  bare?: boolean;
  disabled: boolean;
}) {
  const { entry, field, value } = props;
  const id = useId();
  const kind = askFieldKind(field);
  const describedBy =
    [field.hint ? `${id}-hint` : null, props.problem ? `${id}-problem` : null]
      .filter(Boolean)
      .join(" ") || undefined;
  const common = {
    id,
    "data-ny-at": `field:${field.id}`,
    "aria-invalid": props.problem ? true : undefined,
    "aria-describedby": describedBy,
    "aria-required": props.required || undefined,
    disabled: props.disabled,
  } as const;
  const text = typeof value === "string" ? value : "";

  let control: ReactNode;
  switch (kind) {
    case "longtext":
      control = (
        <GrowingText
          {...common}
          aria-label={props.bare ? "Your answer" : undefined}
          placeholder={props.bare ? "Type your answer" : undefined}
          value={text}
          onChange={(event) => setAskValue(entry, field.id, event.target.value)}
        />
      );
      break;
    default:
      control = (
        <input
          {...common}
          type="text"
          autoComplete="off"
          value={text}
          onChange={(event) => setAskValue(entry, field.id, event.target.value)}
          className={fieldClass}
        />
      );
  }

  return (
    <div className="min-w-0">
      {props.bare ? null : (
        <label htmlFor={id} className="mb-1.5 flex items-baseline gap-2 text-sm font-medium">
          {field.label || field.id}
          {props.required ? null : <span className="font-normal text-(--m-muted)">Optional</span>}
        </label>
      )}
      {control}
      {field.hint ? (
        <p id={`${id}-hint`} className="mt-1.5 text-sm text-(--m-muted)">
          {field.hint}
        </p>
      ) : null}
      {props.problem ? <Problem id={`${id}-problem`}>{props.problem}</Problem> : null}
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
