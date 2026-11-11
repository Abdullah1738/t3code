/**
 * Small parts the Needs-you screens share, on the Desk tokens the boards use.
 * Colour only carries state, and every state is said in words first.
 */
import {
  ASK_NOT_OWNER_DEVICE_TEXT,
  ASK_UNDO_MS,
  askFiguresAsOf,
  askUnreadableCard,
  askUnreadableLine,
  heldSecondsLeft,
  type AskUnreadable,
} from "@t3tools/client-runtime/ardud/kanban";
import * as Haptics from "expo-haptics";
import { type ReactNode, useEffect, useState } from "react";
import { AccessibilityInfo, Platform, Pressable, View } from "react-native";

import { SymbolView, type AppSymbolName } from "../../../components/ui/AppSymbol";
import {
  AppText as Text,
  AppTextInput,
  type AppTextInputProps,
} from "../../../components/ui/AppText";
import { cn } from "../../../lib/cn";
import { useNowMs } from "../../common/hooks";
import { useAsk, useAsks, useOwnerStanding, useQueueFigures } from "./askStore";
import { inputAccessibilityState, toastUndo, toastUndoAllowed, type Tone } from "./logic";

const TONE_SURFACE: Record<Tone, string> = {
  plain: "bg-secondary",
  accent: "bg-inline-skill-background",
  warn: "bg-warning",
  negative: "bg-danger",
};

const TONE_TEXT: Record<Tone, string> = {
  plain: "text-foreground",
  accent: "text-inline-skill-foreground",
  warn: "text-warning-foreground",
  negative: "text-danger-foreground",
};

/** A state in a word or two: "Holds #12", "Updated", "Not sent". */
export function Pill(props: { readonly label: string; readonly tone?: Tone }) {
  const tone = props.tone ?? "plain";
  return (
    <View
      className={cn("min-h-6 justify-center self-start rounded-full px-2.5", TONE_SURFACE[tone])}
    >
      <Text className={cn("text-2xs font-t3-medium", TONE_TEXT[tone])}>{props.label}</Text>
    </View>
  );
}

/** One line that says what state the ask is in, with at most one thing to do about it. */
export function Band(props: {
  readonly tone: Exclude<Tone, "plain">;
  readonly children: ReactNode;
  readonly action?: { readonly label: string; readonly onPress: () => void } | undefined;
}) {
  return (
    <View
      accessibilityRole={props.tone === "negative" ? "alert" : "text"}
      className={cn(
        "flex-row items-center gap-3 rounded-2xl px-3.5 py-2.5",
        TONE_SURFACE[props.tone],
      )}
    >
      <Text className={cn("min-w-0 flex-1 text-sm", TONE_TEXT[props.tone])}>{props.children}</Text>
      {props.action ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={props.action.label}
          hitSlop={8}
          onPress={props.action.onPress}
          className="min-h-11 justify-center rounded-full bg-screen px-3.5 active:opacity-70"
        >
          <Text className="text-sm font-t3-semibold text-foreground">{props.action.label}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** A quiet name over a block: "Runs exactly this", "Why it is here". */
export function Label(props: { readonly children: ReactNode; readonly className?: string }) {
  return (
    <Text className={cn("text-2xs text-foreground-muted", props.className)}>{props.children}</Text>
  );
}

/** A section's own heading inside an ask: "Your answer", "Discussion". */
export function Heading(props: { readonly children: ReactNode; readonly trailing?: ReactNode }) {
  return (
    <View className="flex-row items-baseline gap-2">
      <Text accessibilityRole="header" className="text-base font-t3-semibold text-foreground">
        {props.children}
      </Text>
      {props.trailing}
    </View>
  );
}

/** A block set one tone off the ground: an exhibit, a draft, the facts. */
export function Panel(props: {
  readonly children: ReactNode;
  readonly accessibilityLabel?: string;
  readonly className?: string;
}) {
  return (
    <View
      accessibilityLabel={props.accessibilityLabel}
      className={cn("gap-2.5 rounded-2xl bg-card p-4", props.className)}
    >
      {props.children}
    </View>
  );
}

/** What is wrong with what he gave, under the field it is about. */
export function Problem(props: { readonly children: ReactNode }) {
  return (
    <Text
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      className="text-sm text-danger-foreground"
    >
      {props.children}
    </Text>
  );
}

/** A field's name, with "Optional" beside it when it is. */
export function FieldLabel(props: { readonly label: string; readonly aside?: string | undefined }) {
  return (
    <View className="flex-row flex-wrap items-baseline gap-x-2">
      <Text className="text-sm font-t3-medium text-foreground">{props.label}</Text>
      {props.aside ? <Text className="text-sm text-foreground-muted">{props.aside}</Text> : null}
    </View>
  );
}

/** A text box that grows with what is typed in it. */
/**
 * The app's text field, as the Needs-you screens use it: one that takes no
 * input is also disabled for assistive tech (`inputAccessibilityState`).
 */
export function AskInput(props: AppTextInputProps) {
  return (
    <AppTextInput
      {...props}
      accessibilityState={inputAccessibilityState(props.editable, props.accessibilityState)}
    />
  );
}

export function GrowingInput(props: AppTextInputProps & { readonly invalid?: boolean }) {
  const { invalid, className, ...rest } = props;
  return (
    <AskInput
      multiline
      scrollEnabled={false}
      textAlignVertical="top"
      {...rest}
      className={cn(
        "min-h-[72px] rounded-xl bg-card px-3.5 py-3 text-base",
        invalid ? "border-danger-border" : "border-transparent",
        className,
      )}
    />
  );
}

/** A full-width row in a sheet or list: one thing to do, said in a few words. */
export function ActionRow(props: {
  readonly label: string;
  readonly detail?: string | undefined;
  readonly icon?: AppSymbolName;
  readonly destructive?: boolean;
  readonly disabled?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.detail ? `${props.label}, ${props.detail}` : props.label}
      accessibilityState={{ disabled: props.disabled ?? false }}
      disabled={props.disabled}
      onPress={props.onPress}
      className={cn(
        "min-h-12 flex-row items-center gap-3 px-3.5 py-2.5 active:bg-card-alt",
        props.disabled && "opacity-50",
      )}
    >
      {props.icon ? (
        <SymbolView
          name={props.icon}
          size={17}
          tintColorClassName={props.destructive ? "accent-danger-foreground" : "accent-icon-muted"}
          type="monochrome"
        />
      ) : null}
      <Text
        className={cn(
          "min-w-0 flex-1 text-base",
          props.destructive ? "text-danger-foreground" : "text-foreground",
        )}
      >
        {props.label}
      </Text>
      {props.detail ? (
        <Text className="text-sm tabular-nums text-foreground-muted">{props.detail}</Text>
      ) : null}
    </Pressable>
  );
}

/** A tick box drawn the same way for options, steps and batch rows. */
export function Check(props: { readonly checked: boolean; readonly round?: boolean }) {
  return (
    <View
      className={cn(
        "size-[22px] items-center justify-center",
        props.round ? "rounded-full" : "rounded-[7px]",
        props.checked ? "bg-primary" : "border-[1.5px] border-input-border",
      )}
    >
      {props.checked ? (
        <SymbolView
          name="checkmark"
          size={12}
          tintColorClassName="accent-primary-foreground"
          type="monochrome"
        />
      ) : null}
    </View>
  );
}

/** A light tap for a pick or a toggle, the way iOS marks a selection changing. */
export const tapSelection = (): void => {
  if (Platform.OS === "ios") void Haptics.selectionAsync().catch(() => undefined);
};

const notify = (type: Haptics.NotificationFeedbackType): void => {
  if (Platform.OS === "ios") void Haptics.notificationAsync(type).catch(() => undefined);
};

/** An answer was taken: the same tap iOS gives a completed action. */
export const tapDone = (): void => notify(Haptics.NotificationFeedbackType.Success);

/** Something he has to fix before it can go. */
export const tapProblem = (): void => notify(Haptics.NotificationFeedbackType.Warning);

/**
 * What just happened to an answer, at the foot of the screen: held with Undo
 * and the seconds left, sent, or not sent with Retry. `onView` opens the ask a
 * failure is about; `onUndo` gets the ask to go back to.
 */
export function AskToastBar(props: {
  readonly bottom: number;
  readonly onUndo: (key: string | null) => void;
  readonly onView?: ((key: string) => void) | undefined;
}) {
  const asks = useAsks();
  const toast = useAsk((state) => state.toast);
  const held = useAsk((state) => state.held);
  // Sending again is an answer: only for a phone known to be his.
  const { standing } = useOwnerStanding();
  const canSend = standing === "owner";
  const [now, setNow] = useState(Date.now);
  // Taking back a held answer sends nothing and is always his to do. Undoing a
  // snooze writes to the server: only for a phone known to be his, as it is now
  // (the session may have gone unchecked or been refused since the snooze).
  const undoable = toastUndoAllowed(toastUndo(toast, held?.payload.id ?? null), standing);
  const counting = toast?.undoSendId !== undefined && held?.payload.id === toast.undoSendId;
  useEffect(() => {
    if (!counting) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [counting]);
  const toastId = toast?.id;
  const toastText = toast?.text;
  const failed = toast?.retryKey !== undefined || toastText?.startsWith("Not sent") === true;
  useEffect(() => {
    if (toastId === undefined || toastText === undefined) return;
    AccessibilityInfo.announceForAccessibility(toastText);
    if (failed) notify(Haptics.NotificationFeedbackType.Error);
  }, [toastId, toastText, failed]);
  if (toast === null) return null;
  // The clock here ticks only while an answer is held, so its first reading can
  // be from before the hold began: never count from earlier than that.
  const seconds =
    counting && held ? heldSecondsLeft(held, Math.max(now, held.dueAt - ASK_UNDO_MS)) : null;
  const action = undoable
    ? {
        label: seconds === null ? "Undo" : `Undo ${seconds}`,
        accessibilityLabel: seconds === null ? "Undo" : `Undo, ${seconds} seconds left`,
        // Not known to be his: only what is held here is taken back, nothing is written.
        onPress: () => props.onUndo(asks.undoAskSend(canSend ? undefined : "held")),
      }
    : toast.retryKey !== undefined && canSend
      ? {
          label: "Retry",
          accessibilityLabel: "Send it again",
          onPress: () => asks.retryAskSend(toast.retryKey!),
        }
      : toast.viewKey !== undefined && props.onView
        ? {
            label: "View",
            accessibilityLabel: "Open the ask",
            onPress: () => {
              asks.dismissAskToast();
              props.onView?.(toast.viewKey!);
            },
          }
        : null;
  return (
    <View
      pointerEvents="box-none"
      className="absolute inset-x-0 items-center px-3"
      style={{ bottom: props.bottom }}
    >
      <View
        accessibilityRole={failed ? "alert" : "text"}
        className="w-full max-w-[520px] flex-row items-center gap-2 rounded-2xl bg-foreground py-2 pl-4 pr-2 shadow-lg"
      >
        <Text className="min-w-0 flex-1 py-1.5 text-sm text-screen">{toast.text}</Text>
        {action ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={action.accessibilityLabel}
            hitSlop={6}
            onPress={action.onPress}
            className="min-h-11 min-w-11 items-center justify-center rounded-full px-3 active:opacity-70"
          >
            <Text className="text-sm font-t3-bold tabular-nums text-screen">{action.label}</Text>
          </Pressable>
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Dismiss"
            hitSlop={6}
            onPress={asks.dismissAskToast}
            className="size-11 items-center justify-center rounded-full active:opacity-70"
          >
            <SymbolView
              name="xmark"
              size={12}
              tintColorClassName="accent-screen"
              type="monochrome"
            />
          </Pressable>
        )}
      </View>
    </View>
  );
}

/**
 * What a screen says while this phone may not answer: a quiet line while the
 * session is being read, a band with Retry when it could not be read, and the
 * pairing notice when the phone is not paired as the owner's.
 */
export function OwnerBand() {
  const { standing, recheck } = useOwnerStanding();
  const notOwner = useAsk((state) => state.notOwner);
  if (standing === "owner") return null;
  if (standing === "checking") {
    return (
      <Text accessibilityLiveRegion="polite" className="px-0.5 text-sm text-foreground-muted">
        Checking that this phone is yours. You can read meanwhile.
      </Text>
    );
  }
  if (standing === "unchecked") {
    return (
      <Band tone="warn" action={{ label: "Retry", onPress: recheck }}>
        Couldn't check that this phone is paired as yours. You can read everything here; answering
        is off until it is checked.
      </Band>
    );
  }
  return (
    <Band tone="warn">
      {notOwner?.text ?? ASK_NOT_OWNER_DEVICE_TEXT}
      {notOwner === null || notOwner.device
        ? " You can read everything here; answers from this phone are refused."
        : ""}
    </Band>
  );
}

/**
 * Asks the feed carried that this build can't read: open ones in the queue,
 * closed ones in History (`closed`). The page says how many in one quiet line
 * and names the cards to open instead, for as many as could be read that far.
 */
export function UnreadableLine(props: {
  readonly asks: ReadonlyArray<AskUnreadable>;
  readonly onOpenCard: (boardId: string, cardId: string) => void;
  /** They are closed asks: nothing here says they are still open. */
  readonly closed?: boolean;
}) {
  if (props.asks.length === 0) return null;
  const named = props.asks.flatMap((ask) => {
    const name = askUnreadableCard(ask);
    return ask.boardId !== null && ask.cardId !== null && name !== null
      ? [{ key: `${ask.cardId}:${ask.askId}`, name, boardId: ask.boardId, cardId: ask.cardId }]
      : [];
  });
  const shown = named.slice(0, 3);
  return (
    <View className="px-0.5">
      <Text className="text-sm text-foreground-muted">
        {askUnreadableLine(props.asks.length)}.{" "}
        {shown.length > 0
          ? "Open the card instead:"
          : props.closed
            ? "What you answered there is not listed here."
            : "They are still open."}
      </Text>
      {shown.length > 0 ? (
        <View className="flex-row flex-wrap items-center gap-x-4">
          {shown.map((card) => (
            <Pressable
              key={card.key}
              accessibilityRole="button"
              accessibilityLabel={`Open ${card.name}`}
              hitSlop={8}
              onPress={() => props.onOpenCard(card.boardId, card.cardId)}
              className="min-h-11 justify-center active:opacity-70"
            >
              <Text className="text-sm font-t3-semibold text-primary-text">{card.name}</Text>
            </Pressable>
          ))}
          {named.length > shown.length ? (
            <Text className="text-sm text-foreground-muted">
              and {named.length - shown.length} more
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/** The feed could not be read just now: what shows is what was last read. */
export function OfflineBand() {
  const asks = useAsks();
  const nowMs = useNowMs();
  // Held from an earlier read: what shows is not current, and the band says from when.
  const asOf = askFiguresAsOf(useQueueFigures(), nowMs);
  if (asOf === null) return null;
  return (
    <Band tone="warn" action={{ label: "Retry", onPress: () => void asks.refreshAsks() }}>
      Can't reach Robob. This is what was last read, {asOf}.
    </Band>
  );
}

/** A button of the bar under an ask: the filled answer, or a quieter way out beside it. */
export function BarButton(props: {
  readonly label: string;
  readonly accessibilityLabel?: string;
  readonly tone?: "primary" | "quiet";
  readonly icon?: AppSymbolName;
  readonly grow?: boolean;
  /** Beside the answer in a bar: it gives way so the answer keeps its room. */
  readonly limit?: boolean;
  readonly disabled?: boolean;
  readonly busy?: boolean;
  readonly onPress: () => void;
}) {
  const primary = props.tone === "primary";
  const disabled = Boolean(props.disabled || props.busy);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      accessibilityState={{ disabled, busy: Boolean(props.busy) }}
      disabled={disabled}
      onPress={props.onPress}
      className={cn(
        "min-h-12 flex-row items-center justify-center gap-2 rounded-3xl px-4 py-2 active:opacity-70",
        props.grow ? "min-w-0 flex-1" : props.limit ? "max-w-[42%] shrink" : "max-w-full shrink",
        disabled ? "bg-subtle-strong" : primary ? "bg-primary" : "bg-secondary",
      )}
    >
      {props.icon ? (
        <SymbolView
          name={props.icon}
          size={16}
          tintColorClassName={
            disabled
              ? "accent-foreground-muted"
              : primary
                ? "accent-primary-foreground"
                : "accent-icon"
          }
          type="monochrome"
        />
      ) : null}
      {props.label === "" ? null : (
        <Text
          // Two lines at the largest text sizes, so the answer's own word is never cut.
          numberOfLines={2}
          className={cn(
            "shrink text-center text-base font-t3-semibold tabular-nums",
            disabled
              ? "text-foreground-muted"
              : primary
                ? "text-primary-foreground"
                : "text-foreground",
          )}
        >
          {props.label}
        </Text>
      )}
    </Pressable>
  );
}
