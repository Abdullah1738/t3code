import type { MissionId, MissionRecordRef } from "@t3tools/contracts";
import type { OwnerRequestMessage } from "@t3tools/client-runtime/ardud/missions";
import { clockLabel } from "@t3tools/client-runtime/ardud/missions/mobile";
import { useState } from "react";
import { View } from "react-native";

import { ActionButton, Bubble, DiscussionMark, LinkButton, SectionHead, TextField } from "./parts";
import { useDiscussion } from "./recordLogic";

/** A request's messages, oldest first: the owner's on the right. */
export function Conversation(props: {
  readonly messages: ReadonlyArray<OwnerRequestMessage>;
  readonly nowMs: number;
}) {
  return (
    <View className="gap-3">
      {props.messages.map((message) => (
        <Bubble
          key={message.id}
          fromOwner={message.author === "owner"}
          author={message.author === "owner" ? "You" : "Master"}
          time={clockLabel(message.at, props.nowMs)}
          text={message.text}
        />
      ))}
    </View>
  );
}

/**
 * The discussion on one record, inline where the record is shown. Its unread
 * count sits on the discussion symbol only. `open` starts it expanded, as on
 * the item screen; elsewhere "Discuss" opens it in place.
 */
export function DiscussionPanel(props: {
  readonly missionId: MissionId | null;
  readonly subject: MissionRecordRef;
  readonly nowMs: number;
  readonly open?: boolean;
}) {
  const [expanded, setExpanded] = useState(props.open ?? false);
  const discussion = useDiscussion(props.missionId, props.subject, expanded);
  const { request } = discussion;
  if (!expanded) {
    return (
      <View className="flex-row items-center gap-3">
        <LinkButton label={request ? "Discussion" : "Discuss"} onPress={() => setExpanded(true)} />
        {request ? <DiscussionMark unread={discussion.unread} /> : null}
      </View>
    );
  }
  return (
    <View className="gap-3">
      <SectionHead
        title="Discussion"
        trailing={request ? <DiscussionMark unread={discussion.unread} /> : null}
      />
      {request ? <Conversation messages={request.messages} nowMs={props.nowMs} /> : null}
      <TextField
        value={discussion.text}
        onChangeText={discussion.setText}
        placeholder={request ? "Reply to the master" : "Discuss with the master"}
      />
      <View className="flex-row flex-wrap gap-2">
        <ActionButton
          label="Send"
          primary
          disabled={discussion.pending || discussion.text.trim() === ""}
          onPress={discussion.send}
        />
        {request && request.status !== "settled" ? (
          <ActionButton label="Settle" disabled={discussion.pending} onPress={discussion.settle} />
        ) : null}
        {props.open ? null : <ActionButton label="Close" onPress={() => setExpanded(false)} />}
      </View>
    </View>
  );
}
