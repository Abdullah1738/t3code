import type { MissionId } from "@t3tools/contracts";
import {
  healthToneLabel,
  type MissionListRow,
  roomRows,
  unreadTotal,
} from "@t3tools/client-runtime/ardud/missions/mobile";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { useMissionRooms } from "./missionsStore";
import { Card, Meta, Section, ToneDot } from "./parts";

// Presentation for the Missions and Rooms tabs. Rows come from the shared view
// helpers; navigation is passed in.

function Badge(props: { readonly text: string; readonly accessibilityLabel?: string | null }) {
  return (
    <View
      accessibilityLabel={props.accessibilityLabel ?? undefined}
      className="min-w-6 items-center rounded-full bg-adaptive-amber-500-a12-a16 px-2 py-0.5"
    >
      <Text className="text-xs font-t3-bold text-adaptive-amber-700-300">{props.text}</Text>
    </View>
  );
}

export function MissionRowCard(props: {
  readonly row: MissionListRow;
  readonly onOpen: () => void;
  readonly onOpenInbox: () => void;
}) {
  const { row } = props;
  return (
    <Card>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Open ${row.title}`}
        onPress={props.onOpen}
        className="gap-1"
      >
        <View className="flex-row items-center gap-2">
          <ToneDot tone={row.tone} label={row.toneLabel} />
          <Text className="flex-1 text-base font-t3-bold text-foreground">{row.title}</Text>
          <Meta>{row.tier}</Meta>
        </View>
        <Meta>
          {row.toneLabel} · {row.lanesLine}
        </Meta>
      </Pressable>
      {row.needsYou ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${row.needsYouLabel ?? ""}. Open inbox`}
          onPress={props.onOpenInbox}
          className="flex-row items-center gap-2"
        >
          <Badge text={row.needsYou} />
          <Meta>Needs you · open inbox</Meta>
        </Pressable>
      ) : null}
      {row.subMissions.length > 0 ? (
        <View className="gap-1.5">
          {row.subMissions.map((sub) => (
            <View key={sub.id} className="flex-row items-center gap-2">
              <Text className="w-5 text-xs text-foreground-muted">{sub.position}</Text>
              <ToneDot tone={sub.tone} label={healthToneLabel(sub.tone)} />
              <Text className="flex-1 text-sm text-foreground" numberOfLines={1}>
                {sub.title}
                {sub.paused ? " · paused" : ""}
              </Text>
              {sub.needsYou ? <Badge text={sub.needsYou} /> : null}
            </View>
          ))}
        </View>
      ) : null}
    </Card>
  );
}

export function MissionsListPanel(props: {
  readonly rows: ReadonlyArray<MissionListRow> | undefined;
  readonly onOpenMission: (id: MissionId) => void;
  readonly onOpenInbox: (id: MissionId) => void;
}) {
  if (props.rows === undefined) return <Meta>Loading missions…</Meta>;
  if (props.rows.length === 0) {
    return <EmptyState title="No missions yet" detail="Missions you start show up here." />;
  }
  return (
    <View className="gap-3">
      {props.rows.map((row) => (
        <MissionRowCard
          key={row.id}
          row={row}
          onOpen={() => props.onOpenMission(row.id)}
          onOpenInbox={() => props.onOpenInbox(row.id)}
        />
      ))}
    </View>
  );
}

function MissionRooms(props: {
  readonly missionId: MissionId;
  readonly title: string;
  readonly nowMs: number;
}) {
  const entries = useMissionRooms(props.missionId);
  if (entries === undefined) return null;
  const rows = roomRows(entries, props.nowMs);
  const unread = unreadTotal(entries);
  return (
    <Section title={props.title} caption={unread > 0 ? `${unread} unread` : "All read"}>
      {rows.length === 0 ? (
        <Meta>No rooms yet.</Meta>
      ) : (
        <Card>
          {rows.map((room) => (
            <View key={room.id} className="flex-row items-center gap-2">
              <View className="flex-1 gap-0.5">
                <Text className="text-sm font-t3-bold text-foreground">{room.title}</Text>
                <Meta>{room.meta}</Meta>
              </View>
              {room.unreadBadge ? (
                <Badge text={room.unreadBadge} accessibilityLabel={`${room.unread} unread`} />
              ) : null}
            </View>
          ))}
        </Card>
      )}
    </Section>
  );
}

/** Round 1 lists rooms with unread counts; reading and posting come next. */
export function RoomsPanel(props: {
  readonly missions: ReadonlyArray<{ readonly id: MissionId; readonly title: string }> | undefined;
  readonly nowMs: number;
}) {
  if (props.missions === undefined) return <Meta>Loading rooms…</Meta>;
  if (props.missions.length === 0) {
    return <EmptyState title="No rooms yet" detail="Each mission's rooms show up here." />;
  }
  return (
    <View className="gap-5">
      {props.missions.map((mission) => (
        <MissionRooms
          key={mission.id}
          missionId={mission.id}
          title={mission.title}
          nowMs={props.nowMs}
        />
      ))}
      <Meta>Opening a room to read and post is not built yet.</Meta>
    </View>
  );
}
