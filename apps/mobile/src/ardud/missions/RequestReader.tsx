import type { MissionId } from "@t3tools/contracts";
import { refLabel, REQUEST_STATUS_LABEL } from "@t3tools/client-runtime/ardud/missions";
import { ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Conversation } from "./Discussion";
import { LoadingLine } from "./FeedError";
import { ActionBar, ActionButton, Chip, EmptyLine, Meta, TextField } from "./parts";
import { useRequestThread } from "./recordLogic";

/**
 * One of the owner's requests: the conversation with the master, the reply
 * field, and Settle (with the field's text as the note) or Reopen.
 */
export function RequestReader(props: {
  readonly missionId: MissionId;
  readonly requestId: string;
  readonly nowMs: number;
  readonly bottomInset: number;
}) {
  const thread = useRequestThread(props.missionId, props.requestId);
  const { request } = thread;
  if (request === undefined) return <LoadingLine />;
  if (request === null) return <EmptyLine label="This request is gone." />;
  const settled = request.status === "settled";
  const hasText = thread.text.trim().length > 0;

  return (
    <View className="flex-1">
      <ScrollView
        className="flex-1"
        contentContainerClassName="gap-4 px-4 pb-8 pt-4"
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
      >
        <View className="flex-row">
          <Chip
            label={REQUEST_STATUS_LABEL[request.status]}
            tone={request.status === "answered" ? "accent" : "plain"}
          />
        </View>
        <Text selectable className="text-2xl leading-8">
          {request.title}
        </Text>
        {request.links.length > 0 ? (
          <View className="flex-row flex-wrap gap-2">
            {request.links.map((link) => (
              <Chip key={`${link.kind}:${link.id}`} label={refLabel(link)} />
            ))}
          </View>
        ) : null}
        <Conversation messages={request.messages} nowMs={props.nowMs} />
        {thread.partial ? <Meta>Showing the latest messages</Meta> : null}
      </ScrollView>
      <ActionBar bottomInset={props.bottomInset}>
        <View className="w-full gap-2">
          <TextField
            value={thread.text}
            onChangeText={thread.setText}
            placeholder={settled ? "Why reopen it?" : "Reply to the master"}
          />
          <View className="flex-row flex-wrap gap-2">
            {settled ? (
              <ActionButton
                label="Reopen"
                primary
                disabled={thread.pending}
                onPress={thread.reopen}
              />
            ) : (
              <>
                <ActionButton
                  label="Send"
                  primary={hasText}
                  disabled={thread.pending || !hasText}
                  onPress={thread.reply}
                />
                <ActionButton
                  label={hasText ? "Settle with note" : "Settle"}
                  primary={!hasText}
                  disabled={thread.pending}
                  onPress={thread.settle}
                />
              </>
            )}
          </View>
        </View>
      </ActionBar>
    </View>
  );
}
