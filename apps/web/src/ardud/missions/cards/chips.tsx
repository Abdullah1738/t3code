import type { ReactNode, SVGProps } from "react";
import {
  ClockIcon,
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

/** 16px round avatar: the owner's diamond, the master's hexagon, or an initial. */
export function Avatar(props: { kind: AvatarKind; name?: string; small?: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full text-xs font-semibold",
        props.small ? "size-3.5" : "size-4",
        props.kind === "you"
          ? "bg-update/14 text-update-foreground"
          : "bg-foreground/10 text-foreground",
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

/** A person chip: avatar plus name. `prefix` is read out but not shown ("Approver: "). */
export function PersonChip(props: { kind: AvatarKind; name: string; prefix?: string }) {
  return (
    <span className="inline-flex h-5 max-w-full min-w-0 shrink-0 items-center gap-1.5 rounded-full bg-foreground/6 ps-0.5 pe-2 text-xs font-medium text-foreground dark:bg-foreground/8">
      <Avatar kind={props.kind} name={props.name} />
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
  "inline-flex h-5 max-w-full min-w-0 shrink-0 items-center gap-1 rounded-md bg-foreground/6 px-1.5 font-mono text-xs text-foreground dark:bg-foreground/8";

/** A link chip: kind glyph plus the link's label; an anchor when it has a URL. */
export function LinkChip(props: { link: MissionLink }) {
  const { link } = props;
  const Icon = LINK_ICON[link.kind];
  const body = (
    <>
      <Icon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
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
        "outline-none hover:bg-foreground/12 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
      )}
    >
      {body}
    </a>
  );
}

/** A chip for a record inside the mission (an ask, a rule, a work item). */
export function RefChip(props: { record: MissionRecordRef }) {
  return (
    <span className={cn(CHIP_CLASS, "font-sans")}>
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

/**
 * How long something has waited: clock glyph plus "52m" or "1d 14h". Quiet
 * under an hour, stronger from an hour, strongest past a day.
 */
export function AgeElement(props: { age: AgeView; at: string; prefix?: string }) {
  return (
    <time
      dateTime={props.at}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 text-xs whitespace-nowrap tabular-nums",
        props.age.tier === "minutes" && "text-muted-foreground",
        props.age.tier === "hours" && "font-medium text-foreground",
        props.age.tier === "days" && "font-semibold text-foreground",
      )}
    >
      <ClockIcon aria-hidden className="size-3" />
      {props.prefix ? <span className="sr-only">{props.prefix}</span> : null}
      {props.age.label}
    </time>
  );
}

/** A row of chips, wrapping. */
export function ChipRow(props: { children: ReactNode }) {
  return <div className="flex min-w-0 flex-wrap items-center gap-1.5">{props.children}</div>;
}

export type StateGlyphKind = "ok" | "done" | "risk" | "bad" | "wait" | "idle" | "park" | "unknown";

const STATE_GLYPH_CLASS: Record<StateGlyphKind, string> = {
  ok: "text-success-foreground",
  done: "text-success-foreground",
  risk: "text-warning-foreground",
  bad: "text-error-foreground",
  wait: "text-muted-foreground",
  idle: "text-muted-foreground",
  park: "text-muted-foreground",
  unknown: "text-muted-foreground",
};

/**
 * 12px state glyph from the sprite: shape and colour both carry the state.
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
      className={cn("size-3 shrink-0", STATE_GLYPH_CLASS[props.tone ?? props.kind])}
    >
      {props.kind === "ok" ? <circle cx="6" cy="6" r="4.5" fill="currentColor" /> : null}
      {props.kind === "done" ? (
        <>
          <circle cx="6" cy="6" r="5.25" fill="currentColor" />
          <path
            d="M3.6 6.2 5.3 7.9 8.5 4.4"
            fill="none"
            className="stroke-background"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
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

/** Health glyph plus its word ("At risk"), both in the state's colour. */
export function HealthStatus(props: { health: MissionHealth; paused?: boolean }) {
  const kind = props.paused ? "park" : HEALTH_GLYPH[props.health];
  return (
    <span className={cn("inline-flex items-center gap-1", STATE_GLYPH_CLASS[kind])}>
      <StateGlyph kind={kind} />
      {props.paused ? "Paused" : healthLabel(props.health)}
    </span>
  );
}

/** Update-tinted count: things waiting on the owner. */
export function CountBadge(props: { count: number; label: string }) {
  return (
    <span className="inline-flex h-4.5 min-w-4.5 shrink-0 items-center justify-center rounded-sm bg-update/14 px-1 text-xs leading-none font-medium text-update-foreground tabular-nums">
      <span aria-hidden>{badgeCount(props.count)}</span>
      <span className="sr-only">{props.label}</span>
    </span>
  );
}

/** A state glyph and its count, both in the state's colour ("2 stuck"). */
export function GlyphCount(props: {
  kind: StateGlyphKind;
  tone?: StateGlyphKind;
  count: number;
  label: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 tabular-nums",
        STATE_GLYPH_CLASS[props.tone ?? props.kind],
      )}
    >
      <StateGlyph kind={props.kind} {...(props.tone ? { tone: props.tone } : {})} />
      <span aria-hidden>{props.count}</span>
      <span className="sr-only">{props.label}</span>
    </span>
  );
}

/** Tiny update-coloured dot: something new the owner has not opened. */
export function UnreadDot(props: { label?: string }) {
  return (
    <span
      {...(props.label ? { role: "img", "aria-label": props.label } : { "aria-hidden": true })}
      className="size-1.5 shrink-0 rounded-full bg-update"
    />
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
