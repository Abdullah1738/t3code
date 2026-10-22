import { type StaticScreenProps, useNavigation } from "@react-navigation/native";
import type { InboxComment, MissionId, RoomId } from "@t3tools/contracts";
import { commentsOf, markOf, roomName } from "@t3tools/client-runtime/ardud/missions";
import { decidedRows, findEntry } from "@t3tools/client-runtime/ardud/missions/mobile";
import { type ReactNode, useEffect, useRef } from "react";
import { ScrollView, View } from "react-native";
import { KeyboardAvoidingView, useKeyboardState } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppBar } from "../../components/ui/AppBar";
import { DecidedSummary } from "./InboxPane";
import { ItemReader } from "./ItemReader";
import { CommentList } from "./ItemMarks";
import { FeedError, LoadingLine } from "./FeedError";
import {
  useMissionInbox,
  useMissionInboxFeed,
  useMissionInboxHistory,
  useMissionOverview,
  useRoomPage,
} from "./missionsStore";
import { EmptyLine } from "./parts";
import { RequestReader } from "./RequestReader";
import { RoomReader } from "./RoomReader";
import { missionRecordState, type MissionRecordParams } from "./routeParams";
import { useHeaderInset, useNowMs } from "./useMissionsLogic";

/** A pushed record on a phone: an inbox item, one of your requests, or a room. */
export function MissionRecordRouteScreen({
  route,
}: StaticScreenProps<MissionRecordParams | undefined>) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const keyboardVisible = useKeyboardState((state) => state.isVisible);
  const bottomInset = keyboardVisible ? 8 : Math.max(insets.bottom, 12);
  const nowMs = useNowMs();
  const record = missionRecordState(route.params);
  const back = () => navigation.goBack();

  if (record?.kind === "item") {
    return (
      <Shell title="Inbox" onBack={back}>
        <ItemScreen
          itemKey={record.id}
          missionId={record.missionId}
          nowMs={nowMs}
          bottomInset={bottomInset}
          onGone={back}
        />
      </Shell>
    );
  }
  if (record?.kind === "request" && record.missionId) {
    return (
      <Shell title="Your request" onBack={back}>
        <RequestReader
          missionId={record.missionId}
          requestId={record.id}
          nowMs={nowMs}
          bottomInset={bottomInset}
        />
      </Shell>
    );
  }
  if (record?.kind === "room") {
    return (
      <RoomScreen
        roomId={record.id as RoomId}
        missionId={record.missionId}
        nowMs={nowMs}
        bottomInset={bottomInset}
        onBack={back}
      />
    );
  }
  return (
    <Shell title="Missions" onBack={back}>
      <EmptyLine label="This link does not open anything." />
    </Shell>
  );
}

function Shell(props: {
  readonly title: string;
  readonly onBack: () => void;
  readonly children: ReactNode;
}) {
  const headerInset = useHeaderInset();
  return (
    <View collapsable={false} className="flex-1 bg-screen" style={{ paddingTop: headerInset }}>
      <AppBar title={props.title} sidebar={false} onBack={props.onBack} />
      <KeyboardAvoidingView automaticOffset behavior="height" className="flex-1">
        {props.children}
      </KeyboardAvoidingView>
    </View>
  );
}

/** The item while it waits; once decided elsewhere it is gone and the screen closes. */
function ItemScreen(props: {
  readonly itemKey: string;
  readonly missionId: MissionId | null;
  readonly nowMs: number;
  readonly bottomInset: number;
  readonly onGone: () => void;
}) {
  const inbox = useMissionInbox(props.missionId);
  const feed = useMissionInboxFeed(props.missionId);
  const entry = inbox ? findEntry(inbox, props.itemKey, props.nowMs) : undefined;
  const seen = useRef(false);
  const { onGone } = props;
  useEffect(() => {
    if (entry) seen.current = true;
    else if (entry === null && seen.current) onGone();
  }, [entry, onGone]);

  if (entry === undefined) {
    return feed.failure ? (
      <FeedError what="the item" feed={feed} nowMs={props.nowMs} />
    ) : (
      <LoadingLine />
    );
  }
  if (entry === null) {
    return (
      <DecidedItem
        itemKey={props.itemKey}
        missionId={props.missionId}
        comments={commentsOf(inbox, props.itemKey)}
        nowMs={props.nowMs}
      />
    );
  }
  return (
    <ItemReader
      entry={entry}
      missionId={entry.record.missionId ?? props.missionId}
      nowMs={props.nowMs}
      bottomInset={props.bottomInset}
      mark={markOf(inbox, entry.key)}
    />
  );
}

/**
 * An item that left the inbox: how it ended, when the day's history has it,
 * and the owner's comments, which stay on it after the decision.
 */
function DecidedItem(props: {
  readonly itemKey: string;
  readonly missionId: MissionId | null;
  readonly comments: ReadonlyArray<InboxComment>;
  readonly nowMs: number;
}) {
  const history = useMissionInboxHistory(props.missionId);
  const row = history
    ? decidedRows(history, props.nowMs).find((candidate) => candidate.key === props.itemKey)
    : undefined;
  return (
    <ScrollView contentContainerClassName="gap-4 px-4 pb-8 pt-4">
      {row ? <DecidedSummary row={row} /> : <EmptyLine label="Already decided." />}
      <CommentList comments={props.comments} nowMs={props.nowMs} />
    </ScrollView>
  );
}

/** Rooms carry their own name in the header. */
function RoomScreen(props: {
  readonly roomId: RoomId;
  readonly missionId: MissionId | null;
  readonly nowMs: number;
  readonly bottomInset: number;
  readonly onBack: () => void;
}) {
  const overview = useMissionOverview(props.missionId);
  const page = useRoomPage(props.roomId);
  return (
    <Shell title={page ? roomName(page.room) : "Room"} onBack={props.onBack}>
      <RoomReader
        roomId={props.roomId}
        masterRoleId={overview?.mission.masterRoleId ?? null}
        nowMs={props.nowMs}
        bottomInset={props.bottomInset}
      />
    </Shell>
  );
}
