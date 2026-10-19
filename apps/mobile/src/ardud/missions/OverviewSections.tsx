import type { CallId, MissionOverview, SubMissionId } from "@t3tools/contracts";
import { formatRelative } from "@t3tools/client-runtime/ardud/missions";
import {
  blockersView,
  bottomLineCaption,
  criticalPathScreenView,
  directionCheckCaption,
  type FeedItemView,
  feedView,
  healthToneLabel,
  type OverviewHeaderView,
  priorityStackView,
} from "@t3tools/client-runtime/ardud/missions/mobile";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { ActionButton, Actions, Body, Card, Meta, Section, ToneDot } from "./parts";

// Presentation for the mission overview. Every string and grouping comes from
// the shared view helpers; actions arrive as callbacks.

export function OverviewHeader(props: { readonly view: OverviewHeaderView }) {
  const { view } = props;
  return (
    <Card>
      <View className="flex-row items-center gap-2">
        <ToneDot tone={view.tone} label={view.toneLabel} />
        <Text className="text-sm font-t3-bold text-foreground">{view.toneLabel}</Text>
      </View>
      <Body>{view.goal}</Body>
      <View className="flex-row flex-wrap gap-x-5 gap-y-2">
        {view.stats.nextDay ? <Stat label={view.stats.nextDay} value={view.toneLabel} /> : null}
        {view.stats.timeLeft ? <Stat label="Time left" value={view.stats.timeLeft} /> : null}
        {view.stats.milestones ? (
          <Stat
            label="Milestones"
            value={`${view.stats.milestones.done} of ${view.stats.milestones.total}`}
            warning={view.stats.milestones.atRisk > 0}
          />
        ) : null}
        <Stat
          label="Lanes"
          value={`${view.stats.lanes.stuck} stuck of ${view.stats.lanes.total}`}
          warning={view.stats.lanes.stuck > 0}
        />
      </View>
      <Meta warning={view.usage.tone === "borrowing"}>{view.usage.label}</Meta>
      {view.focusTitle ? <Meta>Focus: {view.focusTitle}</Meta> : null}
    </Card>
  );
}

function Stat(props: {
  readonly label: string;
  readonly value: string;
  readonly warning?: boolean;
}) {
  return (
    <View className="gap-0.5">
      <Meta>{props.label}</Meta>
      <Text
        className={
          props.warning
            ? "text-sm font-t3-bold text-adaptive-amber-700-300"
            : "text-sm font-t3-bold text-foreground"
        }
      >
        {props.value}
      </Text>
    </View>
  );
}

export function BottomLine(props: { readonly overview: MissionOverview; readonly nowMs: number }) {
  const caption = bottomLineCaption(props.overview, props.nowMs);
  if (!caption) return null;
  return (
    <Section title="Bottom line" caption={caption}>
      <Card>
        <Body selectable>{props.overview.bottomLine}</Body>
      </Card>
    </Section>
  );
}

export function Blockers(props: {
  readonly overview: MissionOverview;
  readonly onOpenInbox: () => void;
}) {
  const view = blockersView(props.overview);
  return (
    <Section title="Who holds the ball" caption={view.caption}>
      {view.groups.length === 0 ? (
        <Meta>Nothing is blocked.</Meta>
      ) : (
        view.groups.map((group) => (
          <Card key={group.key}>
            <View className="flex-row items-center gap-2">
              <Text className="flex-1 text-sm font-t3-bold text-foreground">
                {group.label} · {group.items.length}
              </Text>
              {group.isOwner ? (
                <ActionButton label="Open inbox" onPress={props.onOpenInbox} />
              ) : null}
            </View>
            {group.items.map((item) => (
              <Meta key={item.key}>{item.label}</Meta>
            ))}
          </Card>
        ))
      )}
    </Section>
  );
}

export function CriticalPath(props: {
  readonly overview: MissionOverview;
  readonly nowMs: number;
}) {
  const view = criticalPathScreenView(props.overview, props.nowMs);
  const [showMilestones, setShowMilestones] = useState(false);
  return (
    <Section title={view.title} caption={view.caption}>
      <Card>
        {view.steps.length === 0 ? (
          <Meta>The master has not mapped a critical path.</Meta>
        ) : (
          view.steps.map((step, index) => (
            <View key={step.key} className="gap-0.5">
              <Text className="text-sm text-foreground">
                {index + 1}. {step.label}
              </Text>
              {step.blockedLine ? <Meta warning>{step.blockedLine}</Meta> : null}
            </View>
          ))
        )}
        {view.milestonesLine ? (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: showMilestones }}
            onPress={() => setShowMilestones((value) => !value)}
          >
            <Meta>
              {showMilestones ? "▾ " : "▸ "}
              {view.milestonesLine}
            </Meta>
          </Pressable>
        ) : null}
        {showMilestones
          ? view.milestones.map((milestone) => (
              <View key={milestone.id} className="gap-0.5">
                <Text className="text-sm text-foreground">
                  {milestone.title} · {milestone.statusLabel}
                </Text>
                {milestone.note ? <Meta>{milestone.note}</Meta> : null}
              </View>
            ))
          : null}
      </Card>
    </Section>
  );
}

export function DirectionCheck(props: {
  readonly overview: MissionOverview;
  readonly nowMs: number;
  readonly pending: boolean;
  readonly onReact: (callId: CallId, reaction: "ok" | "discuss") => void;
}) {
  const items = props.overview.directionCheck;
  return (
    <Section title="Direction check" caption={directionCheckCaption(props.overview, props.nowMs)}>
      {items.length === 0 ? (
        <Meta>No new calls to check.</Meta>
      ) : (
        items.map((item) => (
          <Card key={`${item.ref.kind}:${item.ref.id}`}>
            <Body>{item.summary}</Body>
            <Meta>
              {item.reason} · {formatRelative(item.at, props.nowMs)}
            </Meta>
            <Actions>
              <ActionButton
                label="Fine"
                disabled={props.pending}
                onPress={() => props.onReact(item.ref.id as CallId, "ok")}
              />
              <ActionButton
                label="Discuss"
                disabled={props.pending}
                onPress={() => props.onReact(item.ref.id as CallId, "discuss")}
              />
            </Actions>
          </Card>
        ))
      )}
    </Section>
  );
}

export function PriorityStack(props: {
  readonly overview: MissionOverview;
  readonly pending: boolean;
  readonly onMove: (subMissionId: SubMissionId, direction: "up" | "down") => void;
}) {
  const view = priorityStackView(props.overview);
  const last = view.rows.length - 1;
  return (
    <Section title="Priority stack" caption="Effort: master's last 24h / your intended share.">
      <Card>
        {view.rows.map((row, index) => (
          <View key={row.id} className="flex-row items-center gap-2">
            <Text className="w-5 text-xs text-foreground-muted">{row.position}</Text>
            <ToneDot tone={row.tone} label={healthToneLabel(row.tone)} />
            <View className="flex-1 gap-0.5">
              <Text className="text-sm text-foreground" numberOfLines={2}>
                {row.title}
                {row.tags.length > 0 ? ` · ${row.tags.join(" · ")}` : ""}
              </Text>
              <Text accessibilityLabel={row.effortA11y} className="text-xs text-foreground-muted">
                {row.effortLine}
                {row.drift === "over" ? " · over" : row.drift === "under" ? " · under" : ""}
              </Text>
            </View>
            <Actions>
              <ActionButton
                label="↑"
                disabled={props.pending || index === 0}
                onPress={() => props.onMove(row.id, "up")}
              />
              <ActionButton
                label="↓"
                disabled={props.pending || index === last}
                onPress={() => props.onMove(row.id, "down")}
              />
            </Actions>
          </View>
        ))}
      </Card>
      {view.note ? <Meta>{view.note}</Meta> : null}
      <Meta>
        Lower sub-missions park first when capacity is short; "fills idle" ones only take what is
        left.
      </Meta>
    </Section>
  );
}

function FeedRow(props: { readonly item: FeedItemView; readonly onReviewDraft: () => void }) {
  const { item } = props;
  return (
    <View className="gap-0.5">
      <Text className="text-sm text-foreground">
        {item.kindLabel} · {item.summary}
      </Text>
      <View className="flex-row items-center gap-2">
        <Meta>{item.at}</Meta>
        {item.opensDraft ? (
          <Pressable accessibilityRole="link" onPress={props.onReviewDraft}>
            <Text className="text-xs font-t3-bold text-primary-text">Review draft</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

export function Feed(props: {
  readonly overview: MissionOverview;
  readonly nowMs: number;
  readonly pending: boolean;
  readonly onMarkSeen: () => void;
  readonly onReviewDraft: () => void;
}) {
  const view = feedView(props.overview, props.nowMs);
  const [showEarlier, setShowEarlier] = useState(false);
  return (
    <Section
      title={view.title}
      caption={view.caption}
      trailing={
        view.canMarkSeen ? (
          <ActionButton label="Mark seen" disabled={props.pending} onPress={props.onMarkSeen} />
        ) : null
      }
    >
      {view.fresh.length === 0 && view.earlier.length === 0 ? (
        <Meta>No activity recorded yet.</Meta>
      ) : (
        <Card>
          {view.fresh.map((item) => (
            <FeedRow key={item.key} item={item} onReviewDraft={props.onReviewDraft} />
          ))}
          {view.earlier.length > 0 && !showEarlier ? (
            <Pressable accessibilityRole="button" onPress={() => setShowEarlier(true)}>
              <Text className="text-xs font-t3-bold text-primary-text">
                Show {view.earlier.length} earlier
              </Text>
            </Pressable>
          ) : null}
          {showEarlier && view.earlier.length > 0 ? (
            <>
              <Meta>Earlier</Meta>
              {view.earlier.map((item) => (
                <FeedRow key={item.key} item={item} onReviewDraft={props.onReviewDraft} />
              ))}
            </>
          ) : null}
        </Card>
      )}
    </Section>
  );
}
