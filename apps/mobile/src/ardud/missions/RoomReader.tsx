import type { MissionMessage, RoomId } from "@t3tools/contracts";
import {
  COMPOSER_TARGET_LABEL,
  MESSAGE_KIND_LABEL,
  receiptNudgeLanes,
  receiptView,
  type ComposerTarget,
  type TimelineRow,
} from "@t3tools/client-runtime/ardud/missions";
import { clockLabel } from "@t3tools/client-runtime/ardud/missions/mobile";
import { type ComponentRef, useRef } from "react";
import { ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { FeedError, LoadingLine } from "./FeedError";
import { useRoomPageFeed } from "./missionsStore";
import { useRoomScreen } from "./recordLogic";
import {
  ActionBar,
  ActionButton,
  Body,
  Chip,
  ChoiceRow,
  EmptyLine,
  LinkButton,
  Meta,
  TextField,
} from "./parts";

const TARGETS: ReadonlyArray<ComposerTarget["kind"]> = ["room", "lane", "correction"];
// Kinds worth a chip; requests and status read fine as plain lines.
const CHIP_KINDS = new Set<MissionMessage["kind"]>(["decision", "blocker", "control"]);

/**
 * One room, oldest to newest. It opens at the teal "N new" line, folds status
 * runs, and keeps the composer pinned at the foot.
 */
export function RoomReader(props: {
  readonly roomId: RoomId;
  readonly masterRoleId: string | null;
  readonly nowMs: number;
  readonly bottomInset: number;
}) {
  const room = useRoomScreen(props.roomId, props.masterRoleId);
  const feed = useRoomPageFeed(props.roomId);
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const placed = useRef<string | null>(null);

  if (room.found === undefined)
    return feed.failure ? (
      <FeedError what="the room" feed={feed} nowMs={props.nowMs} />
    ) : (
      <LoadingLine />
    );
  if (room.found === false || room.view === null) return <EmptyLine label="This room is gone." />;

  const view = room.view;
  const laneTarget = room.target.kind === "lane" ? room.target.member : null;
  const scrollOnce = (y: number | null) => {
    if (placed.current === props.roomId) return;
    placed.current = props.roomId;
    if (y === null) scroll.current?.scrollToEnd({ animated: false });
    else scroll.current?.scrollTo({ y: Math.max(0, y - 12), animated: false });
  };
  const hasMarker = view.rows.some((row) => row.kind === "read-marker");

  return (
    <View className="flex-1">
      <ScrollView
        ref={scroll}
        className="flex-1"
        contentContainerClassName="gap-1 px-4 pb-6 pt-3"
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        onContentSizeChange={() => {
          if (!hasMarker) scrollOnce(null);
        }}
      >
        <FeedError what="the room" feed={feed} nowMs={props.nowMs} />
        {view.hasOlder ? (
          <View className="items-center py-2">
            <LinkButton
              label={room.loadingOlder ? "Loading" : "Load earlier"}
              disabled={room.loadingOlder}
              onPress={room.loadOlder}
            />
          </View>
        ) : null}
        {view.rows.length === 0 ? <EmptyLine label="No messages yet." /> : null}
        {view.rows.map((row) => (
          <TimelineLine
            key={row.key}
            row={row}
            nowMs={props.nowMs}
            nameOf={room.nameOf}
            nudged={room.nudged}
            onNudge={room.pending ? null : room.nudge}
            onToggleRun={room.expandRun}
            onMarkerLayout={(y) => scrollOnce(y)}
          />
        ))}
      </ScrollView>
      {room.ruleOffer ? (
        <View className="flex-row items-center gap-2 border-t border-border bg-screen px-4 py-2.5">
          <Meta className="flex-1" numberOfLines={2}>
            {room.ruleOffer.summary}
          </Meta>
          <ActionButton
            label="Save as a rule"
            primary
            disabled={room.pending}
            onPress={() => room.ruleOffer && room.saveRule(room.ruleOffer)}
          />
          <ActionButton
            label="Not now"
            onPress={() => room.ruleOffer && room.skipRule(room.ruleOffer)}
          />
        </View>
      ) : null}
      <ActionBar bottomInset={props.bottomInset}>
        <View className="w-full gap-2">
          <ChoiceRow
            accessibilityLabel="Send to"
            options={TARGETS.filter((kind) => kind !== "lane" || room.members.length > 0).map(
              (kind) => ({ value: kind, label: COMPOSER_TARGET_LABEL[kind] }),
            )}
            selected={room.target.kind}
            onSelect={(kind) => {
              if (kind === "lane") {
                const first = room.members[0];
                if (first) room.setTarget({ kind: "lane", member: first });
                return;
              }
              room.setTarget(kind === "room" ? { kind: "room" } : { kind: "correction" });
            }}
          />
          {laneTarget ? (
            <ChoiceRow
              accessibilityLabel="Lane"
              options={room.members.map((member) => ({ value: member.key, label: member.label }))}
              selected={room.members.find((member) => member.label === laneTarget.label)?.key ?? ""}
              onSelect={(key) => {
                const member = room.members.find((candidate) => candidate.key === key);
                if (member) room.setTarget({ kind: "lane", member });
              }}
            />
          ) : null}
          <View className="flex-row items-end gap-2">
            <View className="flex-1">
              <TextField
                value={room.text}
                onChangeText={room.setText}
                placeholder={
                  room.target.kind === "correction" ? "Correct the master" : "Write to the room"
                }
              />
            </View>
            <ActionButton
              label="Send"
              primary
              disabled={room.pending || room.text.trim().length === 0}
              onPress={room.send}
            />
          </View>
        </View>
      </ActionBar>
    </View>
  );
}

function TimelineLine(props: {
  readonly row: TimelineRow;
  readonly nowMs: number;
  readonly nameOf: (actor: MissionMessage["author"]) => string;
  readonly nudged: ReadonlySet<string>;
  readonly onNudge: ((message: MissionMessage) => void) | null;
  readonly onToggleRun: (key: string) => void;
  readonly onMarkerLayout: (y: number) => void;
}) {
  const { row } = props;
  switch (row.kind) {
    case "day":
      return <Text className="pb-1 pt-4 text-center text-xs text-foreground-muted">{row.day}</Text>;
    case "read-marker":
      return (
        <View
          className="flex-row items-center gap-2 py-2"
          onLayout={(event) => props.onMarkerLayout(event.nativeEvent.layout.y)}
        >
          <View className="h-px flex-1 bg-primary" />
          <Text className="text-xs font-t3-semibold text-primary-text">{row.unread} new</Text>
          <View className="h-px flex-1 bg-primary" />
        </View>
      );
    case "status-run":
      return row.expanded ? (
        <View className="gap-1">
          {row.messages.map((message) => (
            <MessageLine
              key={message.id}
              message={message}
              nowMs={props.nowMs}
              nameOf={props.nameOf}
              nudged={props.nudged}
              onNudge={props.onNudge}
            />
          ))}
          <LinkButton label="Fold status" onPress={() => props.onToggleRun(row.key)} />
        </View>
      ) : (
        <View className="py-1">
          <LinkButton
            label={`${row.messages.length} status posts`}
            onPress={() => props.onToggleRun(row.key)}
          />
        </View>
      );
    case "message":
      return (
        <MessageLine
          message={row.message}
          nowMs={props.nowMs}
          nameOf={props.nameOf}
          nudged={props.nudged}
          onNudge={props.onNudge}
        />
      );
  }
}

function MessageLine(props: {
  readonly message: MissionMessage;
  readonly nowMs: number;
  readonly nameOf: (actor: MissionMessage["author"]) => string;
  readonly nudged: ReadonlySet<string>;
  readonly onNudge: ((message: MissionMessage) => void) | null;
}) {
  const { message } = props;
  const receipt = receiptView(message.receipt);
  const canNudge = receiptNudgeLanes(message.receipt).length > 0;
  const nudged = props.nudged.has(message.id);
  const chip = message.isCorrection
    ? "Correction"
    : CHIP_KINDS.has(message.kind)
      ? MESSAGE_KIND_LABEL[message.kind]
      : null;
  return (
    <View className="gap-1 py-2">
      <View className="flex-row items-center gap-2">
        <Text className="flex-1 text-[13px] font-t3-semibold" numberOfLines={1}>
          {props.nameOf(message.author)}
        </Text>
        {chip ? <Chip label={chip} tone={message.isCorrection ? "accent" : "plain"} /> : null}
        <Meta>{clockLabel(message.createdAt, props.nowMs)}</Meta>
      </View>
      <Body>{message.summary}</Body>
      {receipt ? (
        <View className="flex-row items-center gap-3">
          <Meta className="flex-1">
            {receipt.pending ? `${receipt.label}, ${receipt.pending}` : receipt.label}
          </Meta>
          {canNudge ? (
            <LinkButton
              label={nudged ? "Nudged" : "Nudge"}
              accessibilityLabel={nudged ? "Nudged" : "Nudge the lanes still waiting"}
              disabled={nudged || props.onNudge === null}
              onPress={() => props.onNudge?.(message)}
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
