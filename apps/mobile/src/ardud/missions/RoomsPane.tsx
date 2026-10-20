import type { MissionId, RoomId } from "@t3tools/contracts";
import type { MissionOverviewSnapshot } from "@t3tools/client-runtime/ardud/missions";
import { roomRows } from "@t3tools/client-runtime/ardud/missions/mobile";
import { Fragment, useState } from "react";
import { ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { FeedError } from "./FeedError";
import { useMissionRooms, useMissionRoomsFeed } from "./missionsStore";
import { EmptyLine, Group, Meta, Row, Separator, Title } from "./parts";
import { RoomReader } from "./RoomReader";

/**
 * A mission's rooms, unread first. On a wide screen the open room reads
 * beside the list; on a phone a row opens the room screen.
 */
export function RoomsPane(props: {
  readonly missionId: MissionId;
  readonly overview: MissionOverviewSnapshot | null | undefined;
  readonly wide: boolean;
  readonly nowMs: number;
  readonly bottomInset: number;
  readonly onOpenRoom: (roomId: RoomId) => void;
}) {
  const rooms = useMissionRooms(props.missionId);
  const feed = useMissionRoomsFeed(props.missionId);
  const [selectedId, setSelectedId] = useState<RoomId | null>(null);
  const rows = rooms ? roomRows(rooms, props.overview?.subMissions ?? []) : [];
  const selected = props.wide ? (selectedId ?? rows[0]?.id ?? null) : null;

  const list = (
    <ScrollView className="flex-1" contentContainerClassName="gap-3 px-4 pb-8 pt-3">
      <FeedError what="the rooms" feed={feed} nowMs={props.nowMs} />
      {rooms === undefined ? (
        feed.failure ? null : (
          <EmptyLine label="Loading" />
        )
      ) : rows.length === 0 ? (
        <EmptyLine label="No rooms yet." />
      ) : (
        <Group>
          {rows.map((row, index) => (
            <Fragment key={row.id}>
              {index > 0 ? <Separator /> : null}
              <Row
                accessibilityLabel={
                  row.unread > 0 ? `${row.title}, ${row.unread} unread` : row.title
                }
                selected={selected === row.id}
                onPress={() => (props.wide ? setSelectedId(row.id) : props.onOpenRoom(row.id))}
              >
                <View className="min-w-0 flex-1 gap-0.5">
                  <View className="flex-row items-start gap-3">
                    <Title className="flex-1">{row.title}</Title>
                    {row.unreadBadge ? (
                      <Text className="pt-0.5 text-[13px] font-t3-semibold text-primary-text">
                        {row.unreadBadge}
                      </Text>
                    ) : null}
                  </View>
                  <View className="flex-row items-center gap-3">
                    <Meta numberOfLines={1} className="flex-1">
                      {row.place ? `${row.place.rank}. ${row.place.title}` : row.kindLabel}
                    </Meta>
                    {row.rate ? <Meta>{row.rate}</Meta> : null}
                  </View>
                </View>
              </Row>
            </Fragment>
          ))}
        </Group>
      )}
    </ScrollView>
  );

  if (!props.wide) return list;
  return (
    <View className="flex-1 flex-row">
      <View className="w-[320px] border-r border-border">{list}</View>
      <View className="flex-1">
        {selected ? (
          <RoomReader
            key={selected}
            roomId={selected}
            masterRoleId={props.overview?.mission.masterRoleId ?? null}
            nowMs={props.nowMs}
            bottomInset={props.bottomInset}
          />
        ) : (
          <EmptyLine label="No room open." />
        )}
      </View>
    </View>
  );
}
