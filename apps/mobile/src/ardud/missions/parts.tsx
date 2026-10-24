import type { LaneStatus, MissionLink } from "@t3tools/contracts";
import type { ReplyContextView } from "@t3tools/client-runtime/ardud/missions";
import type { HealthTone } from "@t3tools/client-runtime/ardud/missions/mobile";
import { useState, type ReactNode } from "react";
import { Linking, Pressable, ScrollView, View, type TextLayoutEvent } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import { ControlPill } from "../../components/ui/ControlPill";
import { cn } from "../../lib/cn";

// Desk building blocks for the phone and iPad Missions screens. Colour only
// carries state: teal for working and new, amber for waiting, red for stuck.

/** 10px health or lane glyph. Shape and colour both say the state. */
export function StateGlyph(props: { readonly state: HealthTone | LaneStatus }) {
  switch (props.state) {
    case "green":
    case "working":
      return <View className="size-2.5 rounded-full bg-primary" />;
    case "amber":
    case "waiting":
      return (
        <SymbolView
          name="exclamationmark.triangle"
          size={11}
          tintColorClassName="accent-warning-foreground"
          type="monochrome"
        />
      );
    case "red":
    case "stuck":
      return <View className="size-2.5 rounded-[3px] bg-danger-foreground" />;
    case "paused":
    case "parked":
    case "retired":
      return (
        <View className="h-2.5 w-2.5 flex-row justify-between px-px">
          <View className="h-2.5 w-[3px] rounded-sm bg-foreground-muted" />
          <View className="h-2.5 w-[3px] rounded-sm bg-foreground-muted" />
        </View>
      );
    case "idle":
      return <View className="size-2.5 rounded-full border border-foreground-muted" />;
    case "unknown":
      return (
        <View className="size-2.5 rounded-full border border-dashed border-foreground-muted" />
      );
  }
}

/** One surface group of rows, the Desk 22px card on the muted tone. */
export function Group(props: { readonly children: ReactNode; readonly className?: string }) {
  return (
    <View className={cn("overflow-hidden rounded-[22px] bg-grouped-card", props.className)}>
      {props.children}
    </View>
  );
}

/** Section heading with an optional right-hand link or meta. */
export function SectionHead(props: {
  readonly title: string;
  readonly trailing?: ReactNode;
  readonly className?: string;
}) {
  return (
    <View
      className={cn("min-h-8 flex-row items-center justify-between gap-3 px-1", props.className)}
    >
      <Text accessibilityRole="header" className="text-sm font-t3-semibold text-foreground">
        {props.title}
      </Text>
      {props.trailing}
    </View>
  );
}

/** A quiet text button for section links such as "All 12" or "Mark seen". */
export function LinkButton(props: {
  readonly label: string;
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly accessibilityLabel?: string;
  /** For a show/hide toggle. */
  readonly expanded?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      {...(props.expanded === undefined
        ? {}
        : { accessibilityState: { expanded: props.expanded } })}
      disabled={props.disabled}
      hitSlop={10}
      onPress={props.onPress}
      className="min-h-8 justify-center"
    >
      <Text
        className={cn(
          "text-[13px] font-t3-semibold",
          props.disabled ? "text-foreground-muted" : "text-primary-text",
        )}
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

/** A pressable row inside a Group. */
export function Row(props: {
  readonly children: ReactNode;
  readonly onPress?: (() => void) | undefined;
  readonly onPressIn?: (() => void) | undefined;
  readonly accessibilityLabel?: string;
  readonly selected?: boolean;
  readonly className?: string;
}) {
  const className = cn(
    "min-h-11 flex-row items-start gap-3 px-3.5 py-3",
    props.selected && "bg-card-alt",
    props.className,
  );
  if (!props.onPress) return <View className={className}>{props.children}</View>;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel}
      accessibilityState={{ selected: props.selected ?? false }}
      onPress={props.onPress}
      onPressIn={props.onPressIn}
      className={className}
    >
      {props.children}
    </Pressable>
  );
}

export function Chip(props: { readonly label: string; readonly tone?: "plain" | "accent" }) {
  return (
    <View
      className={cn(
        "self-start rounded-full px-2.5 py-1",
        props.tone === "accent" ? "bg-update" : "bg-secondary",
      )}
    >
      <Text
        className={cn(
          "text-xs font-t3-medium",
          props.tone === "accent" ? "text-update-foreground" : "text-secondary-foreground",
        )}
      >
        {props.label}
      </Text>
    </View>
  );
}

/** Filled ink pill for what needs the owner. */
export function CountPill(props: { readonly label: string }) {
  return (
    <View className="h-[22px] min-w-[22px] items-center justify-center rounded-full bg-foreground px-1.5">
      <Text className="text-xs font-t3-bold text-screen">{props.label}</Text>
    </View>
  );
}

/** Teal count with a dot before it: answered or new, waiting to be read. */
export function NewCount(props: { readonly count: number; readonly accessibilityLabel: string }) {
  if (props.count <= 0) return null;
  return (
    <View
      accessible
      accessibilityLabel={props.accessibilityLabel}
      className="flex-row items-center gap-1"
    >
      <View className="size-1.5 rounded-full bg-primary" />
      <Text className="text-xs font-t3-semibold text-primary-text">{props.count}</Text>
    </View>
  );
}

/** The discussion symbol on an item, with its own unread counter. */
export function DiscussionMark(props: { readonly unread: number }) {
  return (
    <View
      accessible
      accessibilityLabel={props.unread > 0 ? `Discussion, ${props.unread} unread` : "Discussion"}
      className="flex-row items-center gap-1"
    >
      <SymbolView
        name="bubble.left"
        size={13}
        tintColorClassName={props.unread > 0 ? "accent-primary-text" : "accent-icon-muted"}
        type="monochrome"
      />
      {props.unread > 0 ? (
        <Text className="text-xs font-t3-semibold text-primary-text">{props.unread}</Text>
      ) : null}
    </View>
  );
}

export function Title(props: { readonly children: ReactNode; readonly className?: string }) {
  return (
    <Text
      numberOfLines={2}
      className={cn("text-[15px] font-t3-semibold text-foreground", props.className)}
    >
      {props.children}
    </Text>
  );
}

export function Meta(props: {
  readonly children: ReactNode;
  readonly numberOfLines?: number;
  readonly className?: string;
}) {
  return (
    <Text
      numberOfLines={props.numberOfLines}
      className={cn("text-xs text-foreground-muted", props.className)}
    >
      {props.children}
    </Text>
  );
}

export function Body(props: { readonly children: ReactNode; readonly className?: string }) {
  return (
    <Text selectable className={cn("text-[15px] leading-6 text-foreground", props.className)}>
      {props.children}
    </Text>
  );
}

/** Label and value in two columns: "Channel  Slack". */
export function Facts(props: {
  readonly facts: ReadonlyArray<{ readonly label: string; readonly value: string }>;
}) {
  if (props.facts.length === 0) return null;
  return (
    <View className="gap-1.5">
      {props.facts.map((fact) => (
        <View key={fact.label} className="flex-row gap-3">
          <Text className="w-28 text-[13px] text-foreground-muted">{fact.label}</Text>
          <Text selectable className="flex-1 text-[13px] text-foreground">
            {fact.value}
          </Text>
        </View>
      ))}
    </View>
  );
}

const REPLY_LINES = 3;

/** An invisible unclamped copy of a text at the same width, for its line count. */
function MeasureText(props: {
  readonly text: string;
  readonly onTextLayout: (event: TextLayoutEvent) => void;
  /** The shown text's type classes, so both lay out the same lines. */
  readonly className?: string;
}) {
  return (
    <Text
      aria-hidden
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      onTextLayout={props.onTextLayout}
      className={cn(
        "absolute inset-x-0 top-0 opacity-0",
        props.className ?? "text-[13px] leading-5",
      )}
    >
      {props.text}
    </Text>
  );
}

/** Text clamped to `lines` that opens in place with Show all, only when the clamp cuts it. */
export function FoldText(props: {
  readonly text: string;
  readonly lines: number;
  readonly className: string;
}) {
  const [open, setOpen] = useState(false);
  // The hidden copy stays laid out while open, so a rotation that makes it fit drops the toggle.
  const [cut, setCut] = useState(false);
  const { lines } = props;
  const measure = (event: TextLayoutEvent) => setCut(event.nativeEvent.lines.length > lines);
  return (
    <View className="gap-1">
      <View>
        <Text selectable numberOfLines={open ? undefined : lines} className={props.className}>
          {props.text}
        </Text>
        <MeasureText text={props.text} className={props.className} onTextLayout={measure} />
      </View>
      {cut ? (
        <View className="items-start">
          <LinkButton
            label={open ? "Show less" : "Show all"}
            expanded={open}
            onPress={() => setOpen(!open)}
          />
        </View>
      ) : null}
    </View>
  );
}

/** What a draft answers, above its text: who and when, the quote clamped, the summary. */
export function ReplyContext(props: { readonly reply: ReplyContextView }) {
  const { reply } = props;
  const [open, setOpen] = useState(false);
  // Laid out unclamped once, hidden, to learn whether the clamp cuts anything.
  const [cut, setCut] = useState({ quote: false, summary: false });
  const foldable = cut.quote || cut.summary;
  const lines = open ? undefined : REPLY_LINES;
  const measure = (key: "quote" | "summary") => (event: TextLayoutEvent) => {
    const over = event.nativeEvent.lines.length > REPLY_LINES;
    setCut((previous) => (previous[key] === over ? previous : { ...previous, [key]: over }));
  };
  return (
    <View className="gap-1.5" accessibilityLabel={reply.label}>
      <View className="flex-row flex-wrap items-center gap-x-2 gap-y-1">
        <Text className="text-xs text-foreground-muted">{reply.label}</Text>
        {reply.author ? (
          <Text numberOfLines={1} className="text-xs font-t3-semibold text-foreground">
            {reply.author}
          </Text>
        ) : null}
        {reply.when ? <Text className="text-xs text-foreground-muted">{reply.when}</Text> : null}
      </View>
      {reply.link ? <LinkChips links={[reply.link]} /> : null}
      {reply.quote ? (
        <View className="flex-row gap-2.5">
          <View className="w-[2px] rounded-full bg-border" />
          <View className="flex-1">
            <Text
              selectable
              numberOfLines={lines}
              className="text-[13px] leading-5 text-foreground-muted"
            >
              {reply.quote}
            </Text>
            <MeasureText text={reply.quote} onTextLayout={measure("quote")} />
          </View>
        </View>
      ) : null}
      <View>
        <Text selectable numberOfLines={lines} className="text-[13px] leading-5 text-foreground">
          {reply.summary}
        </Text>
        <MeasureText text={reply.summary} onTextLayout={measure("summary")} />
      </View>
      {foldable ? (
        <View className="items-start">
          <LinkButton
            label={open ? "Show less" : "Show all"}
            expanded={open}
            onPress={() => setOpen(!open)}
          />
        </View>
      ) : null}
    </View>
  );
}

/** The owner's own words the master acted on. */
export function ConditionQuote(props: { readonly quote: string }) {
  return (
    <View className="flex-row gap-2.5">
      <View className="w-[3px] rounded-full bg-primary" />
      <Text selectable className="flex-1 text-[13px] italic leading-5 text-foreground-secondary">
        {props.quote}
      </Text>
    </View>
  );
}

export function ActionButton(props: {
  readonly label: string;
  readonly onPress: () => void;
  readonly primary?: boolean;
  readonly disabled?: boolean;
}) {
  return (
    <ControlPill
      label={props.label}
      variant={props.primary ? "primary" : "pill"}
      disabled={props.disabled}
      onPress={props.onPress}
    />
  );
}

/** The decide bar pinned under a record: one teal primary, the rest plain. */
export function ActionBar(props: { readonly children: ReactNode; readonly bottomInset: number }) {
  return (
    <View
      className="flex-row flex-wrap gap-2 border-t border-border bg-screen px-4 pt-3"
      style={{ paddingBottom: props.bottomInset + 12 }}
    >
      {props.children}
    </View>
  );
}

export function TextField(props: {
  readonly value: string;
  readonly onChangeText: (value: string) => void;
  readonly placeholder: string;
  readonly autoFocus?: boolean;
  readonly editable?: boolean;
  readonly minHeight?: "one" | "few";
  /**
   * Keeps the box one height whatever it holds; longer text scrolls inside.
   * For a composer that clears itself after sending: iOS doesn't shrink a
   * grown multiline input when its value is reset, and a box that changes
   * height on send shoves everything around it.
   */
  readonly fixedHeight?: boolean;
}) {
  return (
    <AppTextInput
      multiline
      accessibilityLabel={props.placeholder}
      autoFocus={props.autoFocus}
      editable={props.editable ?? true}
      value={props.value}
      onChangeText={props.onChangeText}
      placeholder={props.placeholder}
      placeholderTextColorClassName="accent-foreground-muted"
      textAlignVertical="top"
      className={cn(
        "rounded-[18px] border-border bg-card-alt text-[15px]",
        props.fixedHeight ? "h-28" : props.minHeight === "few" ? "min-h-24" : "max-h-36",
      )}
    />
  );
}

/** One message: the owner's raised on the right, the master's on the left. */
export function Bubble(props: {
  readonly fromOwner: boolean;
  readonly author: string;
  readonly time: string;
  /** Words, or words with inline parts such as image chips. */
  readonly text: ReactNode;
}) {
  return (
    <View className={cn("max-w-[86%] gap-1", props.fromOwner ? "self-end" : "self-start")}>
      <View
        className={cn(
          "rounded-[18px] px-3.5 py-2.5",
          props.fromOwner ? "bg-card-alt" : "bg-grouped-card",
        )}
      >
        <Text selectable className="text-[15px] leading-[22px] text-foreground">
          {props.text}
        </Text>
      </View>
      <Meta className={props.fromOwner ? "self-end px-1" : "px-1"}>
        {props.author} {props.time}
      </Meta>
    </View>
  );
}

export function EmptyLine(props: { readonly label: string }) {
  return <Meta className="px-3.5 py-3">{props.label}</Meta>;
}

/** Hairline between rows of one group. */
export function Separator() {
  return <View className="ml-3.5 h-px bg-border" />;
}

/**
 * One row of choices that scrolls sideways: inbox kinds with their counts, the
 * mission's pages. The selected one is ink on the ground, the rest muted.
 */
export function ChoiceRow<Value extends string>(props: {
  readonly accessibilityLabel: string;
  readonly options: ReadonlyArray<{
    readonly value: Value;
    readonly label: string;
    readonly count?: number;
  }>;
  readonly selected: Value;
  readonly onSelect: (value: Value) => void;
}) {
  return (
    <ScrollView
      horizontal
      accessibilityLabel={props.accessibilityLabel}
      accessibilityRole="tablist"
      showsHorizontalScrollIndicator={false}
      // A horizontal ScrollView grows by default, so in a column it would take
      // any spare height and stretch the chips.
      className="grow-0"
      contentContainerClassName="gap-1.5"
    >
      {props.options.map((option) => {
        const selected = option.value === props.selected;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            onPress={() => props.onSelect(option.value)}
            className={cn(
              "min-h-9 flex-row items-center gap-1.5 rounded-full px-3.5",
              selected ? "bg-foreground" : "bg-grouped-card",
            )}
          >
            <Text
              className={cn(
                "text-[13px] font-t3-semibold",
                selected ? "text-screen" : "text-foreground",
              )}
            >
              {option.label}
            </Text>
            {option.count ? (
              <Text
                className={cn(
                  "text-[13px] font-t3-medium",
                  selected ? "text-screen" : "text-foreground-muted",
                )}
              >
                {option.count}
              </Text>
            ) : null}
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

/** Links on a record (PR, ticket, commit). Ones with a URL open it. */
export function LinkChips(props: { readonly links: ReadonlyArray<MissionLink> }) {
  if (props.links.length === 0) return null;
  return (
    <View className="flex-row flex-wrap gap-1.5">
      {props.links.map((link) => {
        const url = link.url;
        const chip = <Chip label={link.label} />;
        const key = `${link.kind}:${link.ref ?? link.url ?? link.label}`;
        return url ? (
          <Pressable
            key={key}
            accessibilityRole="link"
            accessibilityLabel={link.label}
            onPress={() => void Linking.openURL(url)}
          >
            {chip}
          </Pressable>
        ) : (
          <View key={key}>{chip}</View>
        );
      })}
    </View>
  );
}
