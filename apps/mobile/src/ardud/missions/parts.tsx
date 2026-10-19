import type { HealthTone } from "@t3tools/client-runtime/ardud/missions/mobile";
import type { ReactNode } from "react";
import { View } from "react-native";

import { AppText as Text, AppTextInput } from "../../components/AppText";
import { ControlPill } from "../../components/ControlPill";
import { cn } from "../../lib/cn";

// Plain building blocks for the missions screens. Presentation only: no state,
// no source calls. The design pass restyles these without touching the logic.

const TONE_CLASS = {
  green: "bg-adaptive-emerald-600-400",
  amber: "bg-adaptive-amber-700-400",
  red: "bg-adaptive-rose-600-400",
  unknown: "bg-foreground-muted",
  paused: "bg-foreground-muted",
} as const satisfies Record<HealthTone, string>;

export function ToneDot(props: { readonly tone: HealthTone; readonly label: string }) {
  return (
    <View
      accessibilityLabel={props.label}
      className={cn("h-2 w-2 shrink-0 rounded-full", TONE_CLASS[props.tone])}
    />
  );
}

export function Card(props: { readonly children: ReactNode }) {
  return (
    <View className="gap-3 rounded-[22px] border border-border bg-card p-4">{props.children}</View>
  );
}

export function Section(props: {
  readonly title: string;
  readonly caption?: string | null;
  readonly trailing?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <View className="gap-2">
      <View className="flex-row items-center gap-2 px-2">
        <View className="flex-1 gap-0.5">
          <Text className="text-sm font-t3-bold text-foreground">{props.title}</Text>
          {props.caption ? (
            <Text className="text-xs text-foreground-muted">{props.caption}</Text>
          ) : null}
        </View>
        {props.trailing}
      </View>
      {props.children}
    </View>
  );
}

export function Title(props: { readonly children: ReactNode }) {
  return <Text className="text-base font-t3-bold text-foreground">{props.children}</Text>;
}

export function Body(props: { readonly children: ReactNode; readonly selectable?: boolean }) {
  return (
    <Text selectable={props.selectable} className="text-sm leading-relaxed text-foreground">
      {props.children}
    </Text>
  );
}

export function Meta(props: { readonly children: ReactNode; readonly warning?: boolean }) {
  return (
    <Text
      className={cn(
        "text-xs",
        props.warning ? "text-adaptive-amber-700-300" : "text-foreground-muted",
      )}
    >
      {props.children}
    </Text>
  );
}

export function Mono(props: { readonly children: ReactNode }) {
  return (
    <Text selectable className="rounded-xl bg-subtle p-3 font-mono text-xs text-foreground">
      {props.children}
    </Text>
  );
}

export function Actions(props: { readonly children: ReactNode }) {
  return <View className="flex-row flex-wrap gap-2">{props.children}</View>;
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
      onPress={props.disabled ? undefined : props.onPress}
    />
  );
}

export function TextField(props: {
  readonly value: string;
  readonly onChangeText: (text: string) => void;
  readonly placeholder: string;
  readonly accessibilityLabel: string;
  readonly mono?: boolean;
  readonly autoFocus?: boolean;
}) {
  return (
    <AppTextInput
      multiline
      autoFocus={props.autoFocus}
      value={props.value}
      onChangeText={props.onChangeText}
      placeholder={props.placeholder}
      accessibilityLabel={props.accessibilityLabel}
      autoCorrect={!props.mono}
      autoCapitalize={props.mono ? "none" : "sentences"}
      textAlignVertical="top"
      className={cn("min-h-24", props.mono ? "font-mono text-sm" : undefined)}
    />
  );
}

export function PrototypeNote(props: { readonly children: ReactNode }) {
  return <Text className="px-2 text-xs text-foreground-muted">{props.children}</Text>;
}
