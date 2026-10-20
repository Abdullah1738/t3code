import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { CheckIcon } from "lucide-react";

import type { Approver, MissionId, SubMissionId } from "@t3tools/contracts";
import { ageView } from "@t3tools/client-runtime/ardud/missions";

import { Button } from "../../../components/ui/button";
import { cn } from "../../../lib/utils";
import { AgeElement, ApproverChip, Avatar, Chip } from "./chips";

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
  /** The record's discussion symbol and unread count, beside the kicker. */
  readonly discussion?: ReactNode;
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
  /** After the age in the head row: the item's Snooze control. */
  readonly end?: ReactNode;
  /** The owner's comments on the item, under its body. */
  readonly comments?: ReactNode;
}

export function CardFrame(props: CardFrameProps) {
  const age = props.since ? ageView(props.since, props.nowMs) : null;
  const done = props.done ?? null;
  const actions = props.actions ?? [];
  // Comment and Discuss decide nothing, so they sit after the decisions.
  const decisions = actions.filter(
    (action) => action.key !== "discuss" && action.key !== "comment",
  );
  const comment = actions.find((action) => action.key === "comment") ?? null;
  const discuss = actions.find((action) => action.key === "discuss") ?? null;
  const pane = props.size === "pane";
  // The reading card sits right under the page's h1; list cards under a section's h2.
  const Title = pane ? "h2" : "h3";
  return (
    <article
      id={props.domId}
      data-selected={props.selected || undefined}
      data-state={done ? "done" : undefined}
      onClickCapture={props.onSelect}
      onFocusCapture={props.onSelect}
      className={cn(
        "group/card relative grid min-w-0 gap-3 text-sm text-(--m-text)",
        // The reading card: one surface, its decisions on a bar pinned to its foot.
        pane && "rounded-3xl bg-(--m-surface) px-4.5 pt-4.5 pb-5.5 sm:px-8 sm:pt-6.5 sm:pb-8",
      )}
    >
      {/* Keyboard selection marker; sits in the gutter so nothing shifts. */}
      <span
        aria-hidden
        className="absolute inset-y-0 -start-3 w-0.5 rounded-full group-data-selected/card:bg-(--m-accent)"
      />
      <div className="flex min-h-6 min-w-0 items-center gap-2.5 text-xs text-(--m-muted)">
        <Chip>{props.kicker}</Chip>
        {props.discussion}
        {props.madeBy === "master" ? (
          <span role="img" aria-label="Made by the master">
            <Avatar kind="master" small />
          </span>
        ) : null}
        {props.subMission ? <SubMissionLink subMission={props.subMission} /> : null}
        {(age && props.since) || props.end ? (
          <span className="ms-auto inline-flex min-w-0 items-center gap-2">
            {age && props.since ? (
              <AgeElement age={age} at={props.since} prefix={done ? "" : "waiting "} />
            ) : null}
            {done ? null : props.end}
          </span>
        ) : null}
      </div>
      <Title
        className={cn(
          "text-pretty",
          pane
            ? "mt-1.5 max-w-[34ch] text-xl leading-tight font-normal sm:text-2xl"
            : "text-sm leading-5.5 font-semibold",
          done && "text-(--m-muted)",
        )}
      >
        {props.title}
      </Title>
      {done ? (
        <div role="status" className="flex min-h-8 min-w-0 items-center gap-2">
          <span className="inline-flex min-w-0 items-center gap-1.5 font-medium text-(--m-accent-text)">
            <CheckIcon aria-hidden className="size-3.5 shrink-0" />
            {done.verb}
            {done.detail ? (
              <span className="min-w-0 truncate font-normal text-(--m-text)">{done.detail}</span>
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
          {props.comments}
          {decisions.length > 0 || comment || discuss || props.approver ? (
            <div
              role="group"
              aria-label="Decide"
              className={cn(
                "flex min-w-0 flex-wrap items-center gap-2",
                pane
                  ? "sticky bottom-0 -mx-4.5 mt-2.5 -mb-5.5 rounded-b-3xl border-t border-(--m-rule) bg-(--m-surface) px-4.5 pt-3 pb-4 sm:-mx-8 sm:-mb-8 sm:px-8 sm:pt-3.5 sm:pb-4.5"
                  : "pt-1",
              )}
            >
              {decisions.map((action) => (
                <Button
                  key={action.key}
                  variant={action.primary ? "default" : "secondary"}
                  className={action.primary ? "min-w-26" : undefined}
                  disabled={action.disabled}
                  onClick={action.onRun}
                >
                  {action.label ?? CARD_ACTION_LABEL[action.key]}
                </Button>
              ))}
              {comment ? (
                <Button variant="ghost-muted" disabled={comment.disabled} onClick={comment.onRun}>
                  {comment.label ?? CARD_ACTION_LABEL.comment}
                </Button>
              ) : null}
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
    <Button variant="ghost-muted" disabled={props.disabled} onClick={props.onRun}>
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
      className="inline-flex min-w-0 items-center gap-1.25 rounded-sm outline-none hover:text-(--m-text) focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      <span className="font-medium tabular-nums">
        <span className="sr-only">Sub-mission </span>
        {subMission.rank}
      </span>
      <span className="min-w-0 truncate">{subMission.title}</span>
    </Link>
  );
}

/** Cards in a list: rows on a 1px rule, no boxes. */
export function CardList(props: { children: ReactNode; label?: string }) {
  return (
    <ul aria-label={props.label} className="flex min-w-0 flex-col">
      {props.children}
    </ul>
  );
}

export function CardListItem(props: { children: ReactNode }) {
  return (
    <li className="min-w-0 py-4 not-first:border-t not-first:border-(--m-rule) first:pt-2.5">
      {props.children}
    </li>
  );
}
