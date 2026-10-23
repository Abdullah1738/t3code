import { requestPlainText, type MissionId, type MissionRecordRef } from "@t3tools/contracts";
import {
  looseDiscussions,
  refLabel,
  requestPreview,
  type OwnerRequestMessage,
} from "@t3tools/client-runtime/ardud/missions";
import { clockLabel } from "@t3tools/client-runtime/ardud/missions/mobile";
import { Fragment, useState } from "react";
import { View } from "react-native";

import { FilePreviewModal } from "../../components/FilePreviewModal";
import type { FilePreviewSource } from "../../components/FilePreviewModal.types";
import { useMissionsEnvironmentId, useOwnerRequests } from "./missionsStore";
import {
  ActionButton,
  Bubble,
  DiscussionMark,
  Group,
  LinkButton,
  Meta,
  SectionHead,
  Separator,
  Title,
} from "./parts";
import { useDiscussion } from "./recordLogic";
import { RequestEditor } from "./RequestEditor";
import { requestImagePreview, requestInline } from "./RequestText";

/** A request's messages, oldest first: the owner's on the right. */
export function Conversation(props: {
  readonly messages: ReadonlyArray<OwnerRequestMessage>;
  readonly nowMs: number;
}) {
  const environmentId = useMissionsEnvironmentId();
  const [preview, setPreview] = useState<FilePreviewSource | null>(null);
  return (
    <View className="gap-3">
      {props.messages.map((message) => (
        <Bubble
          key={message.id}
          fromOwner={message.author === "owner"}
          author={message.author === "owner" ? "You" : "Master"}
          time={clockLabel(message.at, props.nowMs)}
          text={
            environmentId === null
              ? requestPlainText(message.text)
              : requestInline(message.text, (position) =>
                  setPreview(requestImagePreview(message.text, environmentId, position)),
                )
          }
        />
      ))}
      <FilePreviewModal source={preview} onRequestClose={() => setPreview(null)} />
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
      <RequestEditor
        draft={discussion.draft}
        placeholder={request ? "Reply to the master" : "Discuss with the master"}
      >
        <ActionButton
          label="Send"
          primary
          disabled={discussion.pending || discussion.draft.empty}
          onPress={discussion.send}
        />
        {request && request.status !== "settled" ? (
          <ActionButton label="Settle" disabled={discussion.pending} onPress={discussion.settle} />
        ) : null}
        {props.open ? null : <ActionButton label="Close" onPress={() => setExpanded(false)} />}
      </RequestEditor>
    </View>
  );
}

/**
 * Open discussions whose record has no card on the board (acked, superseded,
 * aged out of the feed). It empties as the owner or the master settles each one.
 */
export function OpenDiscussions(props: {
  readonly missionId: MissionId;
  readonly shown: ReadonlyArray<Pick<MissionRecordRef, "kind" | "id">>;
  readonly nowMs: number;
}) {
  const requests = useOwnerRequests(props.missionId);
  const loose = requests ? looseDiscussions(requests, props.shown) : [];
  if (loose.length === 0) return null;
  return (
    <>
      <SectionHead className="pt-3" title={`Open discussions ${loose.length}`} />
      <Group>
        {loose.map((request, index) => (
          <Fragment key={request.id}>
            {index > 0 ? <Separator /> : null}
            <View className="gap-2 px-3.5 py-3">
              <Title>{refLabel(request.subject)}</Title>
              <Meta numberOfLines={2}>{requestPreview(request)}</Meta>
              <DiscussionPanel
                missionId={props.missionId}
                subject={request.subject}
                nowMs={props.nowMs}
              />
            </View>
          </Fragment>
        ))}
      </Group>
    </>
  );
}
