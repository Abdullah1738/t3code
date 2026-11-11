import { askPrimaryLabel, askRefusal, type AskForm } from "@t3tools/client-runtime/ardud/kanban";
import { kanbanAskResponse, type KanbanOwnerAsk } from "@t3tools/contracts";
import type { ReactNode } from "react";

import { Btn, Key } from "./ui";

export type AskTurn = "owner" | "agent" | "evaluator" | "expired";

/**
 * The bar under an ask: one filled button for the answer the form holds, and
 * the quieter ways out beside it.
 */
export function ActionBar(props: {
  ask: KanbanOwnerAsk;
  form: AskForm;
  turn: AskTurn;
  phone: boolean;
  /** A narrow reader (a tablet): Snooze moves into More. */
  compact?: boolean;
  /** The More button, shown last on a narrow reader. */
  more?: ReactNode;
  /** The answer is on its way and can't be sent twice. */
  busy?: boolean;
  /** The Snooze control: a menu of times, or "Bring back" on a snoozed ask. */
  snooze?: ReactNode;
  onPrimary: () => void;
  onRefuse: () => void;
  onBack: () => void;
  onTakeBack: () => void;
  onRefresh: () => void;
  /** Buttons between the main one and the "no": edit, note, reply. */
  children?: ReactNode;
  /** What sits before the main button on a phone: discussion, More. */
  lead?: ReactNode;
}) {
  const { ask, form, turn } = props;
  const response = kanbanAskResponse(ask);
  const refusal = askRefusal(response);

  if (turn === "evaluator") {
    return (
      <Shell>
        {props.lead}
        <span className="min-w-0 flex-1 truncate text-sm text-(--m-muted)">With the evaluator</span>
        <Btn onClick={props.onTakeBack}>Take it back</Btn>
      </Shell>
    );
  }
  if (turn === "expired") {
    return (
      <Shell>
        {props.lead}
        <span className="min-w-0 flex-1 truncate text-sm text-(--m-muted)">Out of date</span>
        <Btn tone="primary" onClick={props.onRefresh}>
          Ask for a refresh
        </Btn>
      </Shell>
    );
  }
  return (
    <Shell>
      {props.phone ? props.lead : null}
      <Btn
        tone="primary"
        disabled={props.busy}
        onClick={props.onPrimary}
        className={props.phone ? "min-w-0 flex-1" : undefined}
      >
        <span className="truncate">{props.busy ? "Sending…" : askPrimaryLabel(ask, form)}</span>
        <Key className="text-(--m-accent-ink)/80 ring-(--m-accent-ink)/40">A</Key>
      </Btn>
      {form.refusing ? (
        <Btn tone="ghost" onClick={props.onBack}>
          Back
        </Btn>
      ) : (
        <>
          {props.phone ? null : props.children}
          {props.phone || props.compact ? null : props.snooze}
          {refusal && !props.phone ? (
            <Btn tone="ghost" onClick={props.onRefuse}>
              {refusal.label}
              <Key>X</Key>
            </Btn>
          ) : null}
          {props.compact && !props.phone ? props.more : null}
        </>
      )}
    </Shell>
  );
}

function Shell(props: { children: ReactNode }) {
  return (
    <div className="pb-safe">
      <div className="flex min-w-0 flex-wrap items-center gap-2 px-5 py-3 max-sm:flex-nowrap max-sm:gap-1.5 max-sm:px-3">
        {props.children}
      </div>
    </div>
  );
}
