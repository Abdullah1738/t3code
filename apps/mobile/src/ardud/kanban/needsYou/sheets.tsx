/**
 * The two things an ask asks for in a sheet of their own: his words for a
 * standing hand-over, and a time to snooze until. Both sit over the screen in
 * the app's own dialog, above the keyboard.
 */
import { DateTimePicker } from "@expo/ui/community/datetime-picker";
import {
  HAND_WORDS_MAX,
  askKey,
  shortWhen,
  snoozeChoices,
  type SnoozeUntil,
} from "@t3tools/client-runtime/ardud/kanban";
import type { KanbanAskFeedItem } from "@t3tools/contracts";
import { type ReactNode, useState } from "react";
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, View } from "react-native";

import type { AppBarMenuItem } from "../../../components/ui/AppBar.types";
import { AppText as Text } from "../../../components/ui/AppText";
import { Button } from "../../../components/ui/Button";
import { useAsks } from "./askStore";
import { GrowingInput, Label, Problem, tapProblem } from "./ui";

function Dialog(props: {
  readonly title: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
}) {
  return (
    <Modal visible transparent animationType="fade" onRequestClose={props.onClose}>
      <KeyboardAvoidingView
        className="flex-1 items-center justify-center bg-backdrop px-5"
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          accessibilityViewIsModal
          className="max-h-[86%] w-full max-w-md grow-0 rounded-3xl bg-screen"
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ padding: 20, gap: 14 }}
        >
          <Text accessibilityRole="header" className="text-xl font-t3-semibold text-foreground">
            {props.title}
          </Text>
          {props.children}
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

/**
 * "…and ones like this from now on": his own words, sent with the ask (or the
 * asks of a batch) to the board's evaluator. Nothing is stored as a rule.
 */
export function HandOverSheet(props: {
  readonly entries: ReadonlyArray<KanbanAskFeedItem>;
  /** What Undo goes back to: the batch, when it is not the ask itself. */
  readonly focusKey?: string | undefined;
  /** What the hand-over is called in History, for a batch. */
  readonly title?: string | undefined;
  readonly onClose: () => void;
  /** The asks left the queue. */
  readonly onLeave: () => void;
}) {
  const asks = useAsks();
  const { entries } = props;
  const first = entries[0];
  const many = entries.length > 1;
  const [words, setWords] = useState("");
  const [tried, setTried] = useState(false);
  const missing = words.trim() === "";
  if (!first) return null;
  const send = () => {
    if (missing) {
      setTried(true);
      tapProblem();
      return;
    }
    props.onClose();
    props.onLeave();
    asks.handAsks(entries, props.focusKey ?? askKey(first), words.trim(), props.title);
  };
  return (
    <Dialog
      title={many ? "Hand these to the evaluator" : "Hand asks like this to the evaluator"}
      onClose={props.onClose}
    >
      <View className="gap-1.5">
        <Label>Say it in your own words</Label>
        <GrowingInput
          autoFocus
          accessibilityLabel="Say it in your own words"
          placeholder="Deploys of reviewed, merged work: handle these yourself. Tell me after."
          maxLength={HAND_WORDS_MAX}
          invalid={tried && missing}
          value={words}
          onChangeText={setWords}
          className="min-h-[120px]"
        />
        {tried && missing ? (
          <Problem>Say which asks it should take.</Problem>
        ) : (
          <Text className="text-sm text-foreground-muted">
            {many
              ? `Starts one thread with the ${first.boardName} evaluator, with your words and these ${entries.length} asks.`
              : `Starts a thread with the ${first.boardName} evaluator, with your words and this ask.`}
          </Text>
        )}
      </View>
      <View className="flex-row justify-end gap-2">
        <Button label="Cancel" tone="text" onPress={props.onClose} />
        <Button label="Send to the evaluator" tone="primary" onPress={send} />
      </View>
    </Dialog>
  );
}

/** "Pick a time": any time ahead of now, in his own zone. */
export function SnoozePickSheet(props: {
  readonly onClose: () => void;
  readonly onSnooze: (until: SnoozeUntil) => void;
}) {
  // Each opening starts from tomorrow morning.
  const [at, setAt] = useState(() => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(9, 0, 0, 0);
    return tomorrow;
  });
  const [picker, setPicker] = useState<"date" | "time" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const send = () => {
    const now = Date.now();
    if (at.getTime() <= now) {
      setProblem("Pick a time ahead of now.");
      tapProblem();
      return;
    }
    props.onClose();
    props.onSnooze({ iso: at.toISOString(), label: shortWhen(at.toISOString(), now) });
  };
  return (
    <Dialog title="Snooze until" onClose={props.onClose}>
      <View className="gap-2">
        {(["date", "time"] as const).map((part) => (
          <Pressable
            key={part}
            accessibilityRole="button"
            accessibilityLabel={part === "date" ? "Choose the date" : "Choose the time"}
            accessibilityState={{ expanded: picker === part }}
            onPress={() => setPicker(picker === part ? null : part)}
            className="min-h-12 flex-row items-center justify-between rounded-xl bg-card px-3.5 active:bg-card-alt"
          >
            <Text className="text-base text-foreground">{part === "date" ? "Date" : "Time"}</Text>
            <Text className="text-base text-foreground" style={{ fontVariant: ["tabular-nums"] }}>
              {part === "date"
                ? at.toLocaleDateString(undefined, {
                    weekday: "short",
                    day: "numeric",
                    month: "short",
                  })
                : at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
            </Text>
          </Pressable>
        ))}
        {picker !== null ? (
          <DateTimePicker
            value={at}
            mode={picker}
            display={Platform.OS === "ios" ? "spinner" : "default"}
            onDismiss={() => setPicker(null)}
            onValueChange={(_, selected) => {
              const next = new Date(at);
              if (picker === "date") {
                next.setFullYear(selected.getFullYear(), selected.getMonth(), selected.getDate());
              } else {
                next.setHours(selected.getHours(), selected.getMinutes(), 0, 0);
              }
              setAt(next);
              setProblem(null);
              if (Platform.OS !== "ios") setPicker(null);
            }}
          />
        ) : null}
        {problem ? <Problem>{problem}</Problem> : null}
      </View>
      <View className="flex-row justify-end gap-2">
        <Button label="Cancel" tone="text" onPress={props.onClose} />
        <Button label="Snooze" tone="primary" onPress={send} />
      </View>
    </Dialog>
  );
}

/** The snooze times as one group of a header menu: the presets, then "Pick a time". */
export function snoozeMenuItem(input: {
  readonly nowMs: number;
  readonly title?: string;
  readonly onSnooze: (until: SnoozeUntil) => void;
  readonly onPick: () => void;
}): AppBarMenuItem {
  return {
    id: "snooze",
    title: input.title ?? "Snooze until",
    icon: "clock",
    items: [
      ...snoozeChoices(input.nowMs).map((choice) => ({
        id: `snooze-${choice.id}`,
        title: `${choice.name}, ${choice.when}`,
        onPress: () => input.onSnooze(choice),
      })),
      { id: "snooze-pick", title: "Pick a time…", onPress: input.onPick },
    ],
  };
}
