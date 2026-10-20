import type { ReactNode, SVGProps } from "react";
import {
  FileTextIcon,
  GitCommitHorizontalIcon,
  LinkIcon,
  PlayIcon,
  RocketIcon,
  ScrollTextIcon,
  TicketIcon,
} from "lucide-react";

import type { Approver, MissionHealth, MissionLink, MissionRecordRef } from "@t3tools/contracts";
import {
  badgeCount,
  healthLabel,
  refLabel,
  type AgeView,
} from "@t3tools/client-runtime/ardud/missions";

import { PullRequestGlyph } from "../../../components/pullRequest/pullRequestIcons";
import { cn } from "../../../lib/utils";

// Small metadata elements shared by cards and sections: avatars, person
// chips, link chips and the age element. Pure presentation.

/** The master's glyph: a filled hexagon. */
export function MasterGlyph(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 12 12" fill="currentColor" aria-hidden {...props}>
      <path d="M6 .8l4.6 2.65v5.1L6 11.2 1.4 8.55v-5.1z" />
    </svg>
  );
}

/** The owner's glyph: a filled diamond. */
export function YouGlyph(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 12 12" fill="currentColor" aria-hidden {...props}>
      <path d="M6 .9l5.1 5.1L6 11.1.9 6z" />
    </svg>
  );
}

export type AvatarKind = "you" | "master" | "person";

/** 22px round avatar (16px small): the owner's diamond, the master's hexagon, or an initial. */
export function Avatar(props: { kind: AvatarKind; name?: string; small?: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full font-semibold",
        props.small ? "size-4 text-2xs" : "size-5.5 text-2xs",
        props.kind === "you" && "bg-(--m-text) text-(--m-ground)",
        props.kind === "master" &&
          "bg-(--m-raised) text-(--m-text) ring-1 ring-(--m-text) ring-inset",
        props.kind === "person" && "bg-(--m-chip) text-(--m-text)",
      )}
    >
      {props.kind === "you" ? (
        <YouGlyph className={props.small ? "size-2" : "size-2.5"} />
      ) : props.kind === "master" ? (
        <MasterGlyph className={props.small ? "size-2" : "size-2.5"} />
      ) : (
        (props.name?.trim().charAt(0).toUpperCase() ?? "")
      )}
    </span>
  );
}

/** A person: avatar plus name. `prefix` is read out but not shown ("Approver: "). */
export function PersonChip(props: { kind: AvatarKind; name: string; prefix?: string }) {
  return (
    <span className="inline-flex max-w-full min-w-0 shrink-0 items-center gap-2 text-xs text-(--m-muted)">
      <Avatar kind={props.kind} name={props.name} small />
      {props.prefix ? <span className="sr-only">{props.prefix}</span> : null}
      <span className="min-w-0 truncate">{props.name}</span>
    </span>
  );
}

export const APPROVER_NAME: Record<Approver, string> = { owner: "You", master: "Master" };

/** Who decides this card. Always shown in the card footer. */
export function ApproverChip(props: { approver: Approver }) {
  return (
    <PersonChip
      kind={props.approver === "owner" ? "you" : "master"}
      name={APPROVER_NAME[props.approver]}
      prefix="Approver: "
    />
  );
}

const LINK_ICON = {
  "pull-request": PullRequestGlyph.pullRequest,
  commit: GitCommitHorizontalIcon,
  "ci-run": PlayIcon,
  ticket: TicketIcon,
  deploy: RocketIcon,
  transcript: ScrollTextIcon,
  file: FileTextIcon,
  url: LinkIcon,
} as const;

const CHIP_CLASS =
  "inline-flex h-6 max-w-full min-w-0 shrink-0 items-center gap-1.5 rounded-full bg-(--m-raised) px-2.5 text-xs font-medium text-(--m-text)";

/** A plain 24px chip: an item's kind ("Merge", "Question"). */
export function Chip(props: { children: ReactNode }) {
  return (
    <span className={CHIP_CLASS}>
      <span className="min-w-0 truncate">{props.children}</span>
    </span>
  );
}

/** A link chip: kind glyph plus the link's label; an anchor when it has a URL. */
export function LinkChip(props: { link: MissionLink }) {
  const { link } = props;
  const Icon = LINK_ICON[link.kind];
  const body = (
    <>
      <Icon aria-hidden className="size-3 shrink-0 text-(--m-muted)" />
      <span className="min-w-0 truncate">{link.label}</span>
    </>
  );
  if (link.url === null) return <span className={CHIP_CLASS}>{body}</span>;
  return (
    <a
      href={link.url}
      target="_blank"
      rel="noreferrer"
      className={cn(
        CHIP_CLASS,
        "outline-none hover:bg-(--m-active) focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
      )}
    >
      {body}
    </a>
  );
}

/** A chip for a record inside the mission (an ask, a rule, a work item). */
export function RefChip(props: { record: MissionRecordRef }) {
  return (
    <span className={CHIP_CLASS}>
      <span className="min-w-0 truncate">{refLabel(props.record)}</span>
    </span>
  );
}

/** A record link or an outside link, whichever it is. */
export function AnyLinkChip(props: { link: MissionLink | MissionRecordRef }) {
  return "id" in props.link ? <RefChip record={props.link} /> : <LinkChip link={props.link} />;
}

export function linkKey(link: MissionLink | MissionRecordRef): string {
  return "id" in link
    ? `${link.kind}:${link.id}`
    : `${link.kind}:${link.url ?? link.ref ?? link.label}`;
}

/** How long something has waited ("52m", "1d 14h"): muted, ink once past a day. */
export function AgeElement(props: { age: AgeView; at: string; prefix?: string }) {
  return (
    <time
      dateTime={props.at}
      className={cn(
        "inline-flex shrink-0 items-center text-xs whitespace-nowrap tabular-nums",
        props.age.tier === "days" ? "font-medium text-(--m-text)" : "text-(--m-muted)",
      )}
    >
      {props.prefix ? <span className="sr-only">{props.prefix}</span> : null}
      {props.age.label}
    </time>
  );
}

/** A row of chips, wrapping. */
export function ChipRow(props: { children: ReactNode }) {
  return <div className="flex min-w-0 flex-wrap items-center gap-1.5">{props.children}</div>;
}

/** Metadata as separate elements spaced apart, never dot-chained. One child per item. */
export function MetaRow(props: { children: ReactNode }) {
  return (
    <span className="inline-flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5">
      {props.children}
    </span>
  );
}

export type StateGlyphKind = "ok" | "done" | "risk" | "bad" | "wait" | "idle" | "park" | "unknown";

const STATE_GLYPH_CLASS: Record<StateGlyphKind, string> = {
  ok: "text-(--m-accent)",
  done: "text-(--m-text)",
  risk: "text-(--m-warning)",
  bad: "text-(--m-negative)",
  wait: "text-(--m-warning)",
  idle: "text-(--m-muted)",
  park: "text-(--m-muted)",
  unknown: "text-(--m-muted)",
};

/**
 * 10px state glyph: shape and colour both carry the state.
 * `tone` borrows another kind's colour (a waiting lane counts as a risk).
 */
export function StateGlyph(props: { kind: StateGlyphKind; label?: string; tone?: StateGlyphKind }) {
  const a11y = props.label
    ? ({ role: "img", "aria-label": props.label } as const)
    : ({ "aria-hidden": true } as const);
  return (
    <svg
      viewBox="0 0 12 12"
      {...a11y}
      className={cn("size-2.5 shrink-0", STATE_GLYPH_CLASS[props.tone ?? props.kind])}
    >
      {props.kind === "ok" || props.kind === "done" ? (
        <circle cx="6" cy="6" r="5" fill="currentColor" />
      ) : null}
      {props.kind === "risk" ? <path d="M6 1.2l5.2 9.3H.8z" fill="currentColor" /> : null}
      {props.kind === "bad" ? (
        <rect x="1.5" y="1.5" width="9" height="9" rx="1.5" fill="currentColor" />
      ) : null}
      {props.kind === "wait" ? (
        <>
          <circle cx="6" cy="6" r="4.6" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M6 1.4a4.6 4.6 0 0 1 0 9.2z" fill="currentColor" />
        </>
      ) : null}
      {props.kind === "idle" ? (
        <circle cx="6" cy="6" r="4.4" fill="none" stroke="currentColor" strokeWidth="1.5" />
      ) : null}
      {props.kind === "park" ? (
        <>
          <rect x="2.6" y="2" width="2.4" height="8" rx=".8" fill="currentColor" />
          <rect x="7" y="2" width="2.4" height="8" rx=".8" fill="currentColor" />
        </>
      ) : null}
      {props.kind === "unknown" ? (
        <circle
          cx="6"
          cy="6"
          r="4.4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeDasharray="2 1.6"
        />
      ) : null}
    </svg>
  );
}

const HEALTH_GLYPH = {
  green: "ok",
  amber: "risk",
  red: "bad",
  unknown: "unknown",
} as const satisfies Record<MissionHealth, StateGlyphKind>;

/** A mission or sub-mission's health glyph; paused shows the park glyph. */
export function HealthGlyph(props: { health: MissionHealth; paused?: boolean }) {
  return props.paused ? (
    <StateGlyph kind="park" label="Paused" />
  ) : (
    <StateGlyph kind={HEALTH_GLYPH[props.health]} label={healthLabel(props.health)} />
  );
}

/** "1 needs you" / "3 need you": the spoken form of a needs-you count. */
export function needsYouLabel(count: number) {
  return `${count} need${count === 1 ? "s" : ""} you`;
}

/** Filled ink pill: things waiting on the owner. */
export function CountBadge(props: { count: number; label: string }) {
  return (
    <span className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-(--m-text) px-1.5 text-xs leading-none font-medium text-(--m-ground) tabular-nums">
      <span aria-hidden>{badgeCount(props.count)}</span>
      <span className="sr-only">{props.label}</span>
    </span>
  );
}

/** 6px teal dot: something new the owner has not opened. */
export function UnreadDot(props: { label?: string }) {
  return (
    <span
      {...(props.label ? { role: "img", "aria-label": props.label } : { "aria-hidden": true })}
      className="size-1.5 shrink-0 rounded-full bg-(--m-accent)"
    />
  );
}

/** Teal dot plus count: answered requests he has not read yet. */
export function AnsweredMark(props: { count: number; label: string }) {
  if (props.count <= 0) return null;
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 text-xs font-medium text-(--m-accent-text) tabular-nums">
      <UnreadDot />
      <span aria-hidden>{badgeCount(props.count)}</span>
      <span className="sr-only">{props.label}</span>
    </span>
  );
}

/**
 * An item's discussion symbol: a speech mark, plus a teal count of the master's
 * unread replies. The only place a discussion reply is counted.
 */
export function DiscussionSymbol(props: { unread: number }) {
  return (
    <span
      role="img"
      aria-label={props.unread > 0 ? `Discussion, ${props.unread} unread` : "Discussion"}
      className="inline-flex shrink-0 items-center gap-1 text-(--m-muted)"
    >
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
        aria-hidden
        className="size-3.75"
      >
        <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" />
      </svg>
      {props.unread > 0 ? (
        <span
          aria-hidden
          className="h-4 min-w-4 rounded-full bg-(--m-accent) px-1.25 text-center text-2xs leading-4 font-semibold text-(--m-accent-ink) tabular-nums"
        >
          {badgeCount(props.unread)}
        </span>
      ) : null}
    </span>
  );
}

/** "by you" / "by master" provenance marker: the author's 14px avatar. */
export function ByMarker(props: { by: "owner" | "master"; label?: string }) {
  return (
    <span
      role="img"
      aria-label={props.label ?? (props.by === "owner" ? "By you" : "By the master")}
    >
      <Avatar kind={props.by === "owner" ? "you" : "master"} small />
    </span>
  );
}
