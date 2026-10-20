import { clockLabel } from "@t3tools/client-runtime/ardud/missions/mobile";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Menu } from "../../components/ui/Menu";
import { CustomSnoozeSheet } from "../../features/threads/CustomSnoozeSheet";
import type { ItemMarksState } from "./inboxLogic";
import { ActionButton, Bubble, LinkButton, Meta, SectionHead, TextField } from "./parts";

// The owner's own marks on the reading card: Snooze (or Unsnooze) beside the
// age, and comments that note something without deciding it.

const PICK_TIME = "pick";

/** Beside the age: the snooze menu, or when it is snoozed and Unsnooze. */
export function SnoozeControl(props: { readonly marks: ItemMarksState }) {
  const { marks } = props;
  const [picking, setPicking] = useState(false);
  if (marks.snoozedLabel) {
    return (
      <View className="ml-auto flex-row items-center gap-3">
        <Meta>{marks.snoozedLabel}</Meta>
        <LinkButton label="Unsnooze" disabled={marks.pending} onPress={marks.unsnooze} />
      </View>
    );
  }
  return (
    <View className="ml-auto">
      <Menu
        actions={[
          ...marks.choices.map((choice) => ({ id: choice.key, title: choice.label })),
          { id: PICK_TIME, title: "Pick a time" },
        ]}
        onPressAction={({ nativeEvent }) => {
          if (nativeEvent.event === PICK_TIME) {
            setPicking(true);
            return;
          }
          const choice = marks.choices.find((item) => item.key === nativeEvent.event);
          if (choice) marks.snooze(choice.until);
        }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Snooze"
          disabled={marks.pending}
          hitSlop={10}
          className="min-h-8 justify-center active:opacity-70"
        >
          <Text className="text-[13px] font-t3-semibold text-primary-text">Snooze</Text>
        </Pressable>
      </Menu>
      {picking ? (
        <CustomSnoozeSheet
          onClose={() => setPicking(false)}
          onSnooze={(until) => {
            setPicking(false);
            marks.snooze(until);
          }}
        />
      ) : null}
    </View>
  );
}

/** The owner's comments on the item, and the box to add one. */
export function CommentsBlock(props: { readonly marks: ItemMarksState; readonly nowMs: number }) {
  const { marks } = props;
  return (
    <View className="gap-2">
      {marks.comments.length > 0 ? <SectionHead title="Your comments" /> : null}
      {marks.comments.map((comment) => (
        <Bubble
          key={comment.id}
          fromOwner
          author="You"
          time={clockLabel(comment.at, props.nowMs)}
          text={comment.body}
        />
      ))}
      {marks.composing ? (
        <View className="gap-2">
          <TextField
            value={marks.text}
            onChangeText={marks.setText}
            placeholder="Comment"
            autoFocus
            minHeight="few"
          />
          <View className="flex-row gap-2">
            <ActionButton
              label="Add comment"
              primary
              disabled={marks.pending || marks.text.trim() === ""}
              onPress={marks.comment}
            />
            <ActionButton
              label="Cancel"
              onPress={() => {
                marks.setText("");
                marks.setComposing(false);
              }}
            />
          </View>
        </View>
      ) : (
        <View className="flex-row">
          <LinkButton label="Comment" onPress={() => marks.setComposing(true)} />
        </View>
      )}
    </View>
  );
}
