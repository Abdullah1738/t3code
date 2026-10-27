import type { AvatarKind, CardView, GoalProgress } from "@t3tools/client-runtime/ardud/kanban";
import type { ReactNode } from "react";
import { Pressable, ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";
import { cardGlyph, type GlyphKind, prGlyph, priorityFill } from "./logic";

// Board building blocks on the Desk tokens. Colour only carries state: teal
// for running, ink for shipped, amber for the owner, red for stalled.

/** 10px state glyph; shape and colour both say the state. */
export function Glyph(props: { readonly kind: GlyphKind }) {
  switch (props.kind) {
    case "ok":
      return <View className="size-2.5 rounded-full bg-primary" />;
    case "done":
      return <View className="size-2.5 rounded-full bg-foreground" />;
    case "stuck":
      return <View className="size-2.5 rounded-[2px] bg-danger-foreground" />;
    case "wait":
      return (
        <View className="size-2.5 overflow-hidden rounded-full border-[1.5px] border-warning-foreground">
          <View className="absolute inset-y-0 left-0 w-[3.5px] bg-warning-foreground" />
        </View>
      );
    case "ask":
      return <View className="size-2.5 rounded-full border-[1.5px] border-warning-foreground" />;
    case "idle":
      return <View className="size-2.5 rounded-full border-[1.5px] border-foreground-muted" />;
  }
}

const BAR_HEIGHTS = [5, 8, 11] as const;

/** Three rising bars: P1 fills all, P4 none. */
export function PriorityBars(props: { readonly priority: number }) {
  const filled = priorityFill(props.priority);
  return (
    <View
      accessible
      accessibilityLabel={props.priority === 5 ? "Backlog" : `P${props.priority}`}
      className="h-[11px] flex-row items-end gap-[2px]"
    >
      {BAR_HEIGHTS.map((height, index) => (
        <View
          key={height}
          style={{ height }}
          className={cn(
            "w-[3px] rounded-[1px]",
            index < filled ? "bg-foreground" : "bg-input-border",
          )}
        />
      ))}
    </View>
  );
}

/** The card's model as one letter in a ring. */
export function ModelMark(props: { readonly letter: string; readonly name: string }) {
  if (!props.letter) return null;
  return (
    <View
      accessible
      accessibilityLabel={props.name}
      className="size-[22px] items-center justify-center rounded-full border-[1.5px] border-input-border"
    >
      <Text className="text-[11px] font-t3-bold text-foreground-muted">{props.letter}</Text>
    </View>
  );
}

/** Metadata chip: goal, PR, stage, model. */
export function KChip(props: {
  readonly label: string;
  readonly glyph?: GlyphKind | null;
  readonly size?: "small" | "large";
}) {
  const large = props.size === "large";
  return (
    <View
      className={cn(
        "flex-none flex-row items-center gap-1.5 self-start rounded-full bg-secondary",
        large ? "h-[30px] px-3" : "h-[22px] px-2",
      )}
    >
      {props.glyph ? <Glyph kind={props.glyph} /> : null}
      <Text
        numberOfLines={1}
        className={cn("font-t3-medium text-foreground", large ? "text-[13px]" : "text-[12px]")}
      >
        {props.label}
      </Text>
    </View>
  );
}

/** A pressable chip; plain when there is nothing to open. */
export function ChipLink(props: {
  readonly label: string;
  readonly glyph?: GlyphKind | null;
  readonly size?: "small" | "large";
  readonly accessibilityLabel?: string;
  readonly onPress?: (() => void) | undefined;
}) {
  const chip = <KChip label={props.label} glyph={props.glyph} size={props.size} />;
  if (!props.onPress) return chip;
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      hitSlop={6}
      onPress={props.onPress}
    >
      {chip}
    </Pressable>
  );
}

/** A participant's letter: evaluator teal ring, agent ink ring, script square, you filled. */
export function Avatar(props: {
  readonly kind: AvatarKind;
  readonly letter: string;
  readonly size?: "small" | "normal";
  readonly label?: string;
}) {
  const small = props.size === "small";
  return (
    <View
      accessible={props.label !== undefined}
      accessibilityLabel={props.label}
      className={cn(
        "items-center justify-center",
        small ? "size-[18px]" : "size-6",
        props.kind === "script" || props.kind === "system" ? "rounded-[6px]" : "rounded-full",
        props.kind === "owner" && "bg-foreground",
        props.kind === "evaluator" && "border-[1.5px] border-primary",
        props.kind === "agent" && "border-[1.5px] border-foreground",
        (props.kind === "script" || props.kind === "system") && "bg-secondary",
      )}
    >
      <Text
        className={cn(
          "font-t3-bold",
          small ? "text-[10px]" : "text-[11px]",
          props.kind === "owner" && "text-screen",
          props.kind === "evaluator" && "text-primary-text",
          props.kind === "agent" && "text-foreground",
          (props.kind === "script" || props.kind === "system") && "text-foreground-muted",
        )}
      >
        {props.letter}
      </Text>
    </View>
  );
}

/** Verified, shipped, active and to-do as one segmented track. */
export function GoalBar(props: { readonly progress: GoalProgress; readonly tall?: boolean }) {
  const { progress } = props;
  const parts = [
    { key: "verified", count: progress.verified, className: "bg-foreground" },
    { key: "shipped", count: progress.shipped, className: "bg-icon-muted" },
    { key: "active", count: progress.active, className: "bg-primary" },
    { key: "todo", count: progress.todo, className: "bg-secondary" },
  ].filter((part) => part.count > 0);
  return (
    <View
      accessible
      accessibilityLabel={`${progress.verified} of ${progress.total} verified`}
      className={cn("flex-1 flex-row gap-[2px]", props.tall ? "h-2" : "h-1.5")}
    >
      {parts.length === 0 ? <View className="flex-1 rounded-[2px] bg-secondary" /> : null}
      {parts.map((part) => (
        <View
          key={part.key}
          style={{ flexGrow: part.count }}
          className={cn("rounded-[2px]", part.className)}
        />
      ))}
    </View>
  );
}

/** The flag under a card title: stalled, waiting on another card, or the owner's question. */
export function FlagLine(props: { readonly flag: CardView["flag"]; readonly lines?: number }) {
  const { flag } = props;
  if (flag === null) return null;
  const glyph: GlyphKind =
    flag.kind === "stalled"
      ? "stuck"
      : flag.kind === "ask"
        ? flag.blocking
          ? "wait"
          : "ask"
        : "idle";
  return (
    <View className="flex-row items-start gap-1.5">
      <View className="pt-[3px]">
        <Glyph kind={glyph} />
      </View>
      <Text
        numberOfLines={props.lines ?? 2}
        className={cn(
          "flex-1 text-[13px] leading-[17px]",
          flag.kind === "stalled" && "font-t3-medium text-danger-foreground",
          flag.kind === "blocked" && "text-foreground-muted",
          flag.kind === "ask" && (flag.blocking ? "text-foreground" : "text-foreground-muted"),
        )}
      >
        {flag.label}
      </Text>
    </View>
  );
}

/** One card on the board. */
export function CardTile(props: {
  readonly view: CardView;
  readonly onOpen: (cardId: string) => void;
  readonly selected?: boolean;
  /**
   * `owner` is a Needs Owner card on its own (warm); `band` one on the warm
   * Needs Owner column, where it sits on the ground.
   */
  readonly tone?: "plain" | "owner" | "band";
  readonly hideGoal?: boolean;
}) {
  const { view } = props;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${view.number}, ${view.title}`}
      accessibilityState={{ selected: props.selected ?? false }}
      onPress={() => props.onOpen(view.id)}
      className={cn(
        "gap-1.5 rounded-[14px] px-3 pb-2.5 pt-2.5",
        props.tone === "owner" ? "bg-warning" : props.tone === "band" ? "bg-screen" : "bg-card",
        props.selected && "bg-secondary",
      )}
    >
      <View className="flex-row items-center gap-2">
        <PriorityBars priority={view.priority} />
        <Text className="text-[12px] text-foreground-muted">{view.number}</Text>
        {view.card.settledAt !== null ? (
          <Text className="text-[12px] text-foreground-muted">Settled</Text>
        ) : null}
        <View className="flex-1" />
        {view.unread > 0 ? (
          <View className="flex-row items-center gap-1">
            <View className="size-1.5 rounded-full bg-primary" />
            <Text className="text-[12px] font-t3-bold text-primary-text">{view.unread}</Text>
          </View>
        ) : null}
        {view.age ? <Text className="text-[12px] text-foreground-muted">{view.age}</Text> : null}
      </View>
      <Text numberOfLines={2} className="text-[15px] font-t3-medium leading-5 text-foreground">
        {view.title}
      </Text>
      <FlagLine flag={view.flag} />
      {(view.goal && !props.hideGoal) || view.pr || view.model.letter ? (
        <View className="flex-row flex-wrap items-center gap-1.5">
          {view.goal && !props.hideGoal ? <KChip label={view.goal.name} /> : null}
          {view.pr ? <KChip label={view.pr.label} glyph={prGlyph(view.pr.state)} /> : null}
          <View className="flex-1" />
          <ModelMark letter={view.model.letter} name={view.model.name} />
        </View>
      ) : null}
    </Pressable>
  );
}

/** A shipped card as one quiet line. */
export function ShippedRow(props: {
  readonly view: CardView;
  readonly onOpen: (cardId: string) => void;
  readonly selected?: boolean;
}) {
  const { view } = props;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${view.number}, ${view.title}, ${view.stageLabel}`}
      accessibilityState={{ selected: props.selected ?? false }}
      onPress={() => props.onOpen(view.id)}
      className={cn(
        "min-h-10 flex-row items-center gap-2.5 rounded-[10px] px-3 py-2",
        props.selected ? "bg-secondary" : "bg-card",
      )}
    >
      <Glyph kind={cardGlyph(view.card)} />
      <Text numberOfLines={1} className="flex-1 text-[14px] text-foreground-muted">
        {view.title}
      </Text>
      {view.age ? <Text className="text-[12px] text-foreground-muted">{view.age}</Text> : null}
    </Pressable>
  );
}

/** Column or section heading: label left, count right. */
export function StageHead(props: {
  readonly label: string;
  readonly count: number;
  readonly owner?: boolean;
  readonly className?: string;
}) {
  return (
    <View
      accessibilityRole="header"
      className={cn("h-7 flex-row items-center justify-between px-1", props.className)}
    >
      <Text
        className={cn(
          "text-[13px] font-t3-medium",
          props.owner ? "text-warning-foreground" : "text-foreground-muted",
        )}
      >
        {props.label}
      </Text>
      <Text
        className={cn(
          "text-[13px] font-t3-medium",
          props.owner ? "text-warning-foreground" : "text-foreground-muted",
        )}
      >
        {props.count}
      </Text>
    </View>
  );
}

/** Underline tabs on a full-width rule; they scroll sideways when they don't fit. */
export function UnderlineTabs<Value extends string>(props: {
  readonly accessibilityLabel: string;
  readonly tabs: ReadonlyArray<{
    readonly value: Value;
    readonly label: string;
    readonly count?: number;
  }>;
  readonly selected: Value;
  readonly onSelect: (value: Value) => void;
  readonly className?: string;
}) {
  return (
    <View className={cn("border-b border-border bg-screen", props.className)}>
      <ScrollView
        horizontal
        accessibilityLabel={props.accessibilityLabel}
        accessibilityRole="tablist"
        showsHorizontalScrollIndicator={false}
        className="grow-0"
        contentContainerClassName="gap-5 px-4"
      >
        {props.tabs.map((tab) => {
          const selected = tab.value === props.selected;
          return (
            <Pressable
              key={tab.value}
              accessibilityRole="tab"
              accessibilityState={{ selected }}
              accessibilityLabel={
                tab.count === undefined ? tab.label : `${tab.label}, ${tab.count}`
              }
              onPress={() => props.onSelect(tab.value)}
              className="h-11 justify-center"
            >
              <View className="flex-row items-center gap-1.5">
                <Text
                  className={cn(
                    "text-[14px] font-t3-medium",
                    selected ? "text-foreground" : "text-foreground-muted",
                  )}
                >
                  {tab.label}
                </Text>
                {tab.count !== undefined ? (
                  <Text className="text-[14px] font-t3-medium text-foreground-muted">
                    {tab.count}
                  </Text>
                ) : null}
              </View>
              <View
                className={cn(
                  "absolute inset-x-0 bottom-0 h-[2px] rounded-full",
                  selected ? "bg-foreground" : "bg-transparent",
                )}
              />
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

/** Label and value rows for card details; the value may be chips. */
export function DetailRow(props: { readonly label: string; readonly children: ReactNode }) {
  return (
    <View className="min-h-10 flex-row items-start gap-3 py-2">
      <Text className="w-24 pt-[3px] text-[13px] text-foreground-muted">{props.label}</Text>
      <View className="min-w-0 flex-1 flex-row flex-wrap items-center gap-1.5">
        {props.children}
      </View>
    </View>
  );
}
