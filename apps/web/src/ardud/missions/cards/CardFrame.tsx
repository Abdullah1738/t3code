import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { CheckIcon, MessagesSquareIcon } from "lucide-react";

import type { Approver, MissionId, SubMissionId } from "@t3tools/contracts";
import { ageView } from "@t3tools/client-runtime/ardud/missions";

import { Button } from "../../../components/ui/button";
import { cn } from "../../../lib/utils";
import { AgeElement, ApproverChip, Avatar } from "./chips";

// The fixed card frame every inbox card and template card renders through:
// head row (kicker, provenance, sub-mission, age), title, body slot, a footer
// of actions with the approver chip, and a done row once decided.
// Props are documented in tmp/memory/missions-build/notes/ui-web.md.

/** The fixed action list. Labels can be overridden for a state (Edit and approve). */
export type CardActionKey =
  | "answer"
  | "approve"
  | "reject"
  | "send"
  | "rewrite"
  | "drop"
  | "forward"
  | "dismiss"
  | "accept"
  | "dismiss-suggestion"
  | "ack"
  | "comment"
  | "discuss"
  | "open"
  | "reply"
  | "settle"
  | "reopen"
  /** UI only: move a draft or approval to the other approver. */
  | "move"
  /** UI only: leave an open editor or reason field. */
  | "cancel"
  /** UI only: open the text editor (a draft, a knock, a suggestion). */
  | "edit";

export const CARD_ACTION_LABEL: Record<CardActionKey, string> = {
  answer: "Answer",
  approve: "Approve",
  reject: "Reject",
  send: "Approve",
  rewrite: "Rewrite",
  drop: "Drop",
  forward: "Forward",
  dismiss: "Drop",
  accept: "Accept",
  "dismiss-suggestion": "Dismiss",
  ack: "Got it",
  comment: "Comment",
  discuss: "Discuss",
  open: "Open",
  reply: "Reply",
  settle: "Settle",
  reopen: "Reopen",
  move: "Move",
  cancel: "Cancel",
  edit: "Edit",
};

export interface CardAction {
  readonly key: CardActionKey;
  /** Defaults to `CARD_ACTION_LABEL[key]`. */
  readonly label?: string;
  /** One primary per card: the decision that settles it. */
  readonly primary?: boolean;
  readonly disabled?: boolean;
  readonly onRun: () => void;
}

export interface CardSubMission {
  readonly missionId: MissionId;
  readonly subMissionId: SubMissionId;
  /** 1-based priority rank. */
  readonly rank: number;
  readonly title: string;
}

export interface CardDone {
  /** "Answered", "Approved", "Forwarded". */
  readonly verb: string;
  /** What was chosen, shown after the verb. */
  readonly detail?: string;
  /** Chips after the verb (who it went to, the PR it landed in). */
  readonly chips?: ReactNode;
}

export interface CardFrameProps {
  /** DOM id, so keyboard selection can scroll to it. */
  readonly domId?: string;
  readonly selected?: boolean;
  readonly onSelect?: () => void;
  /** One short word or two (24 characters at most): Decision, Review feedback, Knock. */
  readonly kicker: string;
  /** Who made the card's template. Built-in kinds have none; master-made ones show the master. */
  readonly madeBy?: "master" | null;
  readonly subMission?: CardSubMission | null;
  /** When it started waiting. */
  readonly since?: string | null;
  readonly nowMs: number;
  readonly title: string;
  /** "list" (14px title) or "pane" (16px title, reading pane). */
  readonly size?: "list" | "pane";
  /** Body blocks. Hidden once the card is done. */
  readonly children?: ReactNode;
  /** Footer actions in order; Discuss always renders last before the approver chip. */
  readonly actions?: ReadonlyArray<CardAction>;
  /** Who decides it. `null` for cards nobody decides (notes). */
  readonly approver?: Approver | null;
  /** Set once decided: replaces body and footer with a done row. */
  readonly done?: CardDone | null;
  /** Discuss on the done row, when the card can still be talked about. */
  readonly onDiscuss?: (() => void) | null;
}

export function CardFrame(props: CardFrameProps) {
  const age = props.since ? ageView(props.since, props.nowMs) : null;
  const done = props.done ?? null;
  const actions = props.actions ?? [];
  const decisions = actions.filter((action) => action.key !== "discuss");
  const discuss = actions.find((action) => action.key === "discuss") ?? null;
  return (
    <article
      id={props.domId}
      data-selected={props.selected || undefined}
      data-state={done ? "done" : undefined}
      onClickCapture={props.onSelect}
      onFocusCapture={props.onSelect}
      className="group/card relative grid min-w-0 gap-2.5 text-sm"
    >
      {/* Keyboard selection marker; sits in the gutter so nothing shifts. */}
      <span
        aria-hidden
        className="absolute inset-y-0 -start-3 w-0.5 rounded-full group-data-selected/card:bg-ring"
      />
      <div className="flex min-h-5 min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        <span className="font-medium whitespace-nowrap">{props.kicker}</span>
        {props.madeBy === "master" ? (
          <span role="img" aria-label="Made by the master">
            <Avatar kind="master" small />
          </span>
        ) : null}
        {props.subMission ? <SubMissionLink subMission={props.subMission} /> : null}
        {age && props.since ? (
          <span className="ms-auto">
            <AgeElement age={age} at={props.since} prefix={done ? "" : "waiting "} />
          </span>
        ) : null}
      </div>
      <h3
        className={cn(
          "-mt-1.5 text-pretty",
          props.size === "pane" ? "text-base leading-6" : "text-sm leading-5.5",
          done ? "font-medium text-muted-foreground" : "font-semibold text-foreground",
        )}
      >
        {props.title}
      </h3>
      {done ? (
        <div role="status" className="flex min-h-7 min-w-0 items-center gap-2">
          <span className="inline-flex min-w-0 items-center gap-1.5 font-medium text-success-foreground">
            <CheckIcon aria-hidden className="size-3.5 shrink-0" />
            {done.verb}
            {done.detail ? (
              <span className="min-w-0 truncate font-normal text-foreground">{done.detail}</span>
            ) : null}
          </span>
          {done.chips}
          {props.onDiscuss ? (
            <span className="ms-auto">
              <DiscussButton onRun={props.onDiscuss} />
            </span>
          ) : null}
        </div>
      ) : (
        <>
          {props.children}
          {decisions.length > 0 || discuss || props.approver ? (
            <div className="flex min-w-0 flex-wrap items-center gap-1.5 pt-0.5">
              {decisions.map((action) => (
                <Button
                  key={action.key}
                  size="sm"
                  variant={action.primary ? "default" : "ghost-muted"}
                  className={action.primary ? "min-w-21" : undefined}
                  disabled={action.disabled}
                  onClick={action.onRun}
                >
                  {action.label ?? CARD_ACTION_LABEL[action.key]}
                </Button>
              ))}
              {discuss ? (
                <DiscussButton
                  onRun={discuss.onRun}
                  disabled={discuss.disabled}
                  label={discuss.label}
                />
              ) : null}
              {props.approver ? (
                <span className="ms-auto">
                  <ApproverChip approver={props.approver} />
                </span>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </article>
  );
}

function DiscussButton(props: {
  onRun: () => void;
  disabled?: boolean | undefined;
  /** "Discussing" while a request about the record is open. */
  label?: string | undefined;
}) {
  return (
    <Button size="sm" variant="ghost-muted" disabled={props.disabled} onClick={props.onRun}>
      <MessagesSquareIcon aria-hidden />
      {props.label ?? CARD_ACTION_LABEL.discuss}
    </Button>
  );
}

function SubMissionLink(props: { subMission: CardSubMission }) {
  const { subMission } = props;
  return (
    <Link
      to="/missions/$missionId"
      params={{ missionId: subMission.missionId }}
      search={{ sub: subMission.subMissionId }}
      className="ms-1 inline-flex min-w-0 items-center gap-1.25 rounded-sm outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      <span className="font-medium tabular-nums">
        <span className="sr-only">Sub-mission </span>
        {subMission.rank}
      </span>
      <span className="min-w-0 truncate">{subMission.title}</span>
    </Link>
  );
}

/** Cards in a list: spaced and divided by a soft rule, no boxes. */
export function CardList(props: { children: ReactNode; label?: string }) {
  return (
    <ul aria-label={props.label} className="flex min-w-0 flex-col">
      {props.children}
    </ul>
  );
}

export function CardListItem(props: { children: ReactNode }) {
  return (
    <li className="min-w-0 border-border/60 not-first:mt-5.5 not-first:border-t not-first:pt-5.5">
      {props.children}
    </li>
  );
}
