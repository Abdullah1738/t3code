import type { ReactNode } from "react";

import type { AvatarKind, CardFlag } from "@t3tools/client-runtime/ardud/kanban";
import type { KanbanStage } from "@t3tools/contracts";

import { cn } from "../../lib/utils";

export type GlyphKind = "ok" | "done" | "risk" | "stuck" | "wait" | "idle";

/** 10px state mark: the board's only status vocabulary. */
export function Glyph(props: {
  kind: GlyphKind;
  label?: string | undefined;
  className?: string | undefined;
}) {
  const { kind } = props;
  return (
    <svg
      viewBox="0 0 12 12"
      className={cn("size-2.5 shrink-0", props.className)}
      role={props.label ? "img" : undefined}
      aria-label={props.label}
      aria-hidden={props.label ? undefined : true}
    >
      {kind === "ok" ? <circle cx="6" cy="6" r="5" fill="var(--m-accent)" /> : null}
      {kind === "done" ? <circle cx="6" cy="6" r="5" fill="var(--m-text)" /> : null}
      {kind === "risk" ? <path d="M6 1.2l5.2 9.3H.8z" fill="var(--m-warning)" /> : null}
      {kind === "stuck" ? (
        <rect x="1.5" y="1.5" width="9" height="9" rx="1.5" fill="var(--m-negative)" />
      ) : null}
      {kind === "wait" ? (
        <>
          <circle cx="6" cy="6" r="4.6" fill="none" stroke="var(--m-warning)" strokeWidth="1.5" />
          <path d="M6 1.4a4.6 4.6 0 0 1 0 9.2z" fill="var(--m-warning)" />
        </>
      ) : null}
      {kind === "idle" ? (
        <circle cx="6" cy="6" r="4.4" fill="none" stroke="var(--m-muted)" strokeWidth="1.5" />
      ) : null}
    </svg>
  );
}

export function stageGlyph(stage: KanbanStage): GlyphKind {
  switch (stage) {
    case "verified":
      return "done";
    case "completed":
    case "deployed":
    case "working":
    case "in_review":
      return "ok";
    case "needs_owner":
      return "wait";
    default:
      return "idle";
  }
}

export function flagGlyph(flag: CardFlag): GlyphKind {
  return flag.kind === "stalled" ? "stuck" : flag.kind === "ask" ? "wait" : "idle";
}

const PRIORITY_LABELS = ["Urgent", "High", "Normal", "Low", "Backlog"] as const;

export function priorityLabel(priority: number): string {
  return PRIORITY_LABELS[priority - 1] ?? "Normal";
}

/** Three rising bars; priority 1 fills all three, 4 and backlog fill none. */
export function Pri(props: { priority: number }) {
  const filled = Math.max(0, 4 - props.priority);
  return (
    <span
      className="inline-flex h-2.75 shrink-0 items-end gap-0.5"
      role="img"
      aria-label={props.priority === 5 ? "Backlog" : `${priorityLabel(props.priority)} priority`}
    >
      {[5, 8, 11].map((height, index) => (
        <i
          key={height}
          className={cn("w-0.75 rounded-xs", index < filled ? "bg-(--m-text)" : "bg-(--m-bar-4)")}
          style={{ height }}
        />
      ))}
    </span>
  );
}

export function ModelMark(props: { name: string; letter: string }) {
  return (
    <span
      className="inline-grid size-5 shrink-0 place-items-center rounded-full text-3xs font-semibold text-(--m-muted) ring-2 ring-inset ring-(--m-bar-3)"
      role="img"
      aria-label={props.name}
    >
      {props.letter}
    </span>
  );
}

export function Avatar(props: {
  kind: AvatarKind;
  letter: string;
  name?: string;
  size?: "xs" | "sm" | "md";
}) {
  const size = props.size ?? "md";
  return (
    <span
      className={cn(
        "inline-grid shrink-0 place-items-center font-semibold not-italic",
        size === "xs" ? "size-4 text-4xs" : size === "sm" ? "size-6 text-2xs" : "size-7 text-xs",
        props.kind === "script" ? "rounded-md" : "rounded-full",
        props.kind === "owner" && "bg-(--m-text) text-(--m-ground)",
        props.kind === "evaluator" && "text-(--m-accent-text) ring-2 ring-inset ring-(--m-accent)",
        props.kind === "agent" && "text-(--m-text) ring-2 ring-inset ring-(--m-text)",
        (props.kind === "script" || props.kind === "system") && "bg-(--m-chip) text-(--m-muted)",
      )}
      role={props.name ? "img" : undefined}
      aria-label={props.name}
    >
      {props.letter}
    </span>
  );
}

export function Chip(props: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-5.5 max-w-full min-w-0 shrink-0 items-center gap-1.5 rounded-full bg-(--m-chip) px-2.25 text-xs font-medium whitespace-nowrap text-(--m-text)",
        props.className,
      )}
    >
      {props.children}
    </span>
  );
}

export function LinkChip(props: { href: string; children: ReactNode }) {
  return (
    <a
      href={props.href}
      target="_blank"
      rel="noreferrer"
      onClick={(event) => event.stopPropagation()}
      className="inline-flex h-5.5 max-w-full min-w-0 shrink-0 items-center gap-1.5 rounded-full bg-(--m-chip) px-2.25 text-xs font-medium whitespace-nowrap text-(--m-text) outline-none hover:bg-(--m-active) focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--m-accent)"
    >
      {props.children}
    </a>
  );
}

export function Count(props: { count: number; tone?: "warn"; label?: string }) {
  if (props.count <= 0) return null;
  return (
    <span
      className={cn(
        "inline-grid h-4.5 min-w-4.5 shrink-0 place-items-center rounded-full px-1.25 text-2xs font-semibold tabular-nums text-(--m-ground)",
        props.tone === "warn" ? "bg-(--m-warning)" : "bg-(--m-text)",
      )}
      aria-label={props.label}
    >
      {props.count}
    </span>
  );
}

export function UnreadDot(props: { label?: string }) {
  return (
    <span
      className="size-1.75 shrink-0 rounded-full bg-(--m-accent)"
      role={props.label ? "img" : undefined}
      aria-label={props.label}
    />
  );
}

/** Pill tabs used across the board: one pressed item on a chip ground. */
export function Seg<T extends string>(props: {
  label: string;
  value: T;
  options: ReadonlyArray<{ readonly value: T; readonly label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <div
      role="group"
      aria-label={props.label}
      className="inline-flex min-w-0 shrink gap-0.5 overflow-x-auto rounded-full bg-(--m-chip) p-0.75 [scrollbar-width:none]"
    >
      {props.options.map((option) => {
        const pressed = option.value === props.value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={pressed}
            onClick={() => props.onChange(option.value)}
            className={cn(
              "inline-flex h-6.5 shrink-0 items-center rounded-full px-2.75 text-sm font-medium whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--m-accent) focus-visible:ring-inset",
              pressed
                ? "bg-(--m-raised) text-(--m-text)"
                : "text-(--m-muted) hover:text-(--m-text)",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** Underlined tabs for the drawer and side pages. */
export function Tabs<T extends string>(props: {
  label: string;
  value: T;
  options: ReadonlyArray<{ readonly value: T; readonly label: string; readonly count?: number }>;
  onChange: (value: T) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label={props.label}
      className="flex shrink-0 gap-5 overflow-x-auto border-b border-(--m-rule) [scrollbar-width:none]"
    >
      {props.options.map((option) => {
        const selected = option.value === props.value;
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => props.onChange(option.value)}
            className={cn(
              "inline-flex h-9 shrink-0 items-center gap-1.5 border-b-2 font-medium whitespace-nowrap outline-none focus-visible:text-(--m-text)",
              selected
                ? "border-(--m-text) text-(--m-text)"
                : "border-transparent text-(--m-muted) hover:text-(--m-text)",
            )}
          >
            {option.label}
            {option.count ? (
              <span className="font-medium text-(--m-muted) tabular-nums">{option.count}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

/** Segmented goal bar: verified, shipped, active, to do. */
export function GoalBar(props: {
  progress: { verified: number; shipped: number; active: number; todo: number; total: number };
  height?: number;
}) {
  const { progress } = props;
  const parts = [
    { key: "v", count: progress.verified, className: "bg-(--m-bar-1)" },
    { key: "s", count: progress.shipped, className: "bg-(--m-bar-3)" },
    { key: "a", count: progress.active, className: "bg-(--m-accent)" },
    { key: "t", count: progress.todo, className: "bg-(--m-bar-4)" },
  ].filter((part) => part.count > 0);
  return (
    <span
      className="flex min-w-12 gap-0.5"
      style={{ height: props.height ?? 6 }}
      role="img"
      aria-label={`${progress.verified} of ${progress.total} verified`}
    >
      {parts.length === 0 ? <i className="flex-1 rounded-xs bg-(--m-bar-4)" /> : null}
      {parts.map((part) => (
        <i
          key={part.key}
          className={cn("rounded-xs", part.className)}
          style={{ flex: part.count }}
        />
      ))}
    </span>
  );
}
