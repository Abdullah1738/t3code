import { type StaticScreenProps, useNavigation } from "@react-navigation/native";
import type { MissionId, RoomId } from "@t3tools/contracts";
import { markOf, roomName } from "@t3tools/client-runtime/ardud/missions";
import { findEntry } from "@t3tools/client-runtime/ardud/missions/mobile";
import { type ReactNode, useEffect, useRef } from "react";
import { View } from "react-native";
import { KeyboardAvoidingView, useKeyboardState } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ScreenHeader } from "../../components/ScreenHeader";
import { ItemReader } from "./ItemReader";
import { FeedError } from "./FeedError";
import {
  useMissionInbox,
  useMissionInboxFeed,
  useMissionOverview,
  useRoomPage,
} from "./missionsStore";
import { EmptyLine } from "./parts";
import { RequestReader } from "./RequestReader";
import { RoomReader } from "./RoomReader";
import { missionRecordState, type MissionRecordParams } from "./routeParams";
import { useNowMs } from "./useMissionsLogic";

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
  return (
    <View collapsable={false} className="flex-1 bg-screen">
      <ScreenHeader title={props.title} sidebar={false} onBack={props.onBack} />
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
      <EmptyLine label="Loading" />
    );
  }
  if (entry === null) return <EmptyLine label="Already decided." />;
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
