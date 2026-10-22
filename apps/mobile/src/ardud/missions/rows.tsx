import type { MissionId } from "@t3tools/contracts";
import {
  ageView,
  isRequestUnread,
  type OwnerRequest,
  REQUEST_STATUS_LABEL,
  requestPreview,
} from "@t3tools/client-runtime/ardud/missions";
import type { InboxRowView, MissionGroupRow } from "@t3tools/client-runtime/ardud/missions/mobile";
import { Fragment } from "react";
import { View } from "react-native";

import {
  CountPill,
  DiscussionMark,
  Group,
  Meta,
  NewCount,
  Row,
  Separator,
  StateGlyph,
  Title,
} from "./parts";

// Rows shared by the thread list's Missions group and the Missions area.

export function MissionRows(props: {
  readonly rows: ReadonlyArray<MissionGroupRow>;
  readonly selectedId?: MissionId | null;
  readonly onOpen: (missionId: MissionId) => void;
  /** Called as a row is pressed, before it opens. */
  readonly onPressIn?: (missionId: MissionId) => void;
}) {
  const { onPressIn } = props;
  return (
    <Group>
      {props.rows.map((row, index) => (
        <Fragment key={row.id}>
          {index > 0 ? <Separator /> : null}
          <Row
            accessibilityLabel={`${row.title}, ${row.statusLine}`}
            selected={props.selectedId === row.id}
            onPress={() => props.onOpen(row.id)}
            onPressIn={onPressIn && (() => onPressIn(row.id))}
          >
            <View className="pt-1.5">
              <StateGlyph state={row.tone} />
            </View>
            <View className="min-w-0 flex-1 gap-0.5">
              <Title>{row.title}</Title>
              <Meta numberOfLines={1}>{row.statusLine}</Meta>
            </View>
            <View className="flex-row items-center gap-2 self-center">
              <NewCount count={row.answered} accessibilityLabel={`${row.answered} answered`} />
              {row.needsYou ? <CountPill label={row.needsYou} /> : <Meta>Nothing needs you</Meta>}
            </View>
          </Row>
        </Fragment>
      ))}
    </Group>
  );
}

/** One inbox row: title and age, then the kind and place, with the discussion symbol. */
export function InboxRowLine(props: {
  readonly row: InboxRowView;
  readonly selected?: boolean;
  readonly onOpen: (key: string) => void;
}) {
  const { row } = props;
  return (
    <Row
      accessibilityLabel={row.title}
      selected={props.selected === true}
      onPress={() => props.onOpen(row.key)}
    >
      <View className="min-w-0 flex-1 gap-1">
        <View className="flex-row items-start gap-3">
          <Title className="flex-1">{row.title}</Title>
          {row.age ? <Meta className="pt-0.5">{row.age}</Meta> : null}
        </View>
        <View className="flex-row items-center gap-3">
          <Meta
            numberOfLines={1}
            className={row.urgent ? "flex-1 text-warning-foreground" : "flex-1"}
          >
            {row.place ? `${row.tag}, ${row.place.title}` : row.tag}
          </Meta>
          {row.discussion ? <DiscussionMark unread={row.discussion.unread} /> : null}
        </View>
      </View>
    </Row>
  );
}

export function RequestRows(props: {
  readonly requests: ReadonlyArray<OwnerRequest>;
  readonly nowMs: number;
  readonly selectedId?: string | null;
  readonly onOpen: (requestId: string) => void;
}) {
  return (
    <Group>
      {props.requests.map((request, index) => {
        const unread = isRequestUnread(request);
        const preview = requestPreview(request);
        return (
          <Fragment key={request.id}>
            {index > 0 ? <Separator /> : null}
            <Row
              accessibilityLabel={`${request.title}, ${REQUEST_STATUS_LABEL[request.status]}`}
              selected={props.selectedId === request.id}
              onPress={() => props.onOpen(request.id)}
            >
              <View className="w-1.5 pt-2">
                {unread ? <View className="size-1.5 rounded-full bg-primary" /> : null}
              </View>
              <View className="min-w-0 flex-1 gap-0.5">
                <View className="flex-row items-start gap-3">
                  <Title className="flex-1">{request.title}</Title>
                  <Meta className="pt-0.5">{ageView(request.updatedAt, props.nowMs)?.label}</Meta>
                </View>
                <Meta className={unread ? "text-primary-text" : undefined}>
                  {REQUEST_STATUS_LABEL[request.status]}
                </Meta>
                {preview ? <Meta numberOfLines={1}>{preview}</Meta> : null}
              </View>
            </Row>
          </Fragment>
        );
      })}
    </Group>
  );
}
