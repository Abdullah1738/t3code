import type { ReactNode } from "react";
import { Pressable, ScrollView, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { ControlPill } from "../../components/ui/ControlPill";
import { cn } from "../../lib/cn";

// Desk building blocks for the phone and iPad board and iMessage screens.
// Colour only carries state: teal for working and new, amber for waiting, red
// for stuck.

/** 10px feed-state glyph: amber triangle for waiting, red square for stuck. */
export function StateGlyph(props: { readonly state: "waiting" | "stuck" }) {
  if (props.state === "stuck") {
    return <View className="size-2.5 rounded-[3px] bg-danger-foreground" />;
  }
  return (
    <SymbolView
      name="exclamationmark.triangle"
      size={11}
      tintColorClassName="accent-warning-foreground"
      type="monochrome"
    />
  );
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
  /** "user" inside the owner's bubble, whose fill can be the primary colour. */
  readonly tone?: "screen" | "user";
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
          props.disabled
            ? "text-foreground-muted"
            : props.tone === "user"
              ? "text-user-bubble-foreground"
              : "text-primary-text",
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

export function EmptyLine(props: { readonly label: string }) {
  return <Meta className="px-3.5 py-3">{props.label}</Meta>;
}

/** Hairline between rows of one group. */
export function Separator() {
  return <View className="ml-3.5 h-px bg-border" />;
}

/**
 * One row of choices that scrolls sideways, such as a board's pages. The selected one is ink on the ground, the rest muted.
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
