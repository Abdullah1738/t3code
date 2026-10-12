import { ASSISTANT_CITATION_MAX_COMMENT_LENGTH, type AssistantCitation } from "@t3tools/contracts";
import { useRef, useState } from "react";
import { Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppSheet } from "./AppSheet";
import { AppText as Text, AppTextInput as TextInput } from "./AppText";

/** A quoted assistant reply in the draft. Closing the sheet keeps the comment as typed. */
export function AssistantCitationSheet(props: {
  readonly citation: AssistantCitation;
  /** Restores a comment the draft could not take, so it can be shortened. */
  readonly initialComment?: string | undefined;
  /** Focuses the comment field, for a quote that was just cited. */
  readonly autoFocus?: boolean;
  readonly onClose: (comment: string) => void;
  /** Omitted when the draft is read-only. */
  readonly onRemove?: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [comment, setComment] = useState(props.initialComment ?? props.citation.comment ?? "");
  const removedRef = useRef(false);
  return (
    <AppSheet
      title="Assistant quote"
      onClose={() => {
        if (!removedRef.current) props.onClose(comment);
      }}
    >
      <ScrollView
        contentInsetAdjustmentBehavior={Platform.OS === "ios" ? "automatic" : undefined}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{
          paddingHorizontal: 20,
          paddingTop: 12,
          gap: 16,
          paddingBottom: Math.max(20, insets.bottom),
        }}
      >
        {props.onRemove ? (
          <TextInput
            autoFocus={props.autoFocus}
            multiline
            scrollEnabled={false}
            textAlignVertical="top"
            value={comment}
            onChangeText={setComment}
            maxLength={ASSISTANT_CITATION_MAX_COMMENT_LENGTH}
            placeholder="Add an optional comment..."
            accessibilityLabel="Comment on selected text"
            className="min-h-24"
          />
        ) : comment ? (
          <View className="gap-1">
            <Text className="text-xs text-foreground-muted">Comment</Text>
            <Text selectable className="text-base text-foreground">
              {comment}
            </Text>
          </View>
        ) : null}
        <View className="border-l-2 border-border pl-3">
          <Text selectable className="text-base text-foreground-muted">
            {props.citation.text}
          </Text>
        </View>
        {props.onRemove ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              removedRef.current = true;
              props.onRemove?.();
            }}
            className="rounded-xl bg-subtle p-4"
          >
            <Text className="text-foreground">Remove from draft</Text>
          </Pressable>
        ) : null}
      </ScrollView>
    </AppSheet>
  );
}
