import { LegendList } from "@legendapp/list/react-native";
import { useNavigation } from "@react-navigation/native";
import {
  formatBoardAge,
  groupBoardLanes,
  settleBoardTasks,
  statusLabel,
} from "@t3tools/client-runtime/ardud/board";
import type { ArdudBoardEntry, ArdudBoardLane, EnvironmentId } from "@t3tools/contracts";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Platform, Pressable, RefreshControl, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView, type AppSymbolName } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { MaterialScreenContent } from "../../components/MaterialScreenContent";
import { ScreenHeader } from "../../components/ScreenHeader";
import { SegmentedControl } from "../../components/SegmentedControl";
import { StatusPill } from "../../components/StatusPill";
import { useProjects } from "../../state/entities";
import {
  useRemoteConnectionStatus,
  useSavedRemoteConnections,
} from "../../state/use-remote-environment-registry";
import { useBoard, useBoardProbe, type BoardCandidate } from "./useBoard";

const LANES: ReadonlyArray<{ lane: ArdudBoardLane; title: string; empty: string }> = [
  { lane: "running", title: "Running", empty: "No threads running." },
  { lane: "waiting", title: "Review", empty: "Nothing waiting for review." },
  { lane: "backlog", title: "Later", empty: "Nothing saved for later." },
  { lane: "scheduled", title: "Auto", empty: "No scheduled threads." },
];

const UNDO_MS = 5_000;

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Something went wrong.";

interface Notice {
  readonly title: string;
  readonly detail?: string;
  readonly tone: "info" | "error";
  readonly undo?: () => Promise<unknown>;
}

/** The fork's session board for one paired Robob environment. */
export function BoardRouteScreen() {
  const navigation = useNavigation();
  const { connectedEnvironments } = useRemoteConnectionStatus();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const candidates = useMemo<ReadonlyArray<BoardCandidate>>(
    () =>
      connectedEnvironments.flatMap((environment) => {
        const saved = savedConnectionsById[environment.environmentId];
        if (
          !environment.isEnabled ||
          saved === undefined ||
          saved.authenticationMethod === "dpop" ||
          saved.bearerToken === null
        ) {
          return [];
        }
        return [
          {
            environmentId: environment.environmentId,
            label: environment.environmentLabel,
            httpBaseUrl: saved.httpBaseUrl,
            bearerToken: saved.bearerToken,
          },
        ];
      }),
    [connectedEnvironments, savedConnectionsById],
  );
  const probe = useBoardProbe(candidates);
  const [chosenId, setChosenId] = useState<EnvironmentId | null>(null);

  const chosen = candidates.find((candidate) => candidate.environmentId === chosenId);
  const automatic = chosen === undefined ? pickBoardCandidate(candidates, probe) : null;
  const selected = chosen ?? automatic?.candidate;
  const probing = automatic?.probing ?? false;

  return (
    <View collapsable={false} className="flex-1 bg-screen android:bg-header">
      <ScreenHeader
        title="Board"
        subtitle={candidates.length > 1 ? selected?.label : undefined}
        sidebar={false}
        onBack={() => navigation.goBack()}
        optionsVersion={[selected?.environmentId, candidates.length]}
        menus={
          candidates.length > 1
            ? [
                {
                  title: "Environment",
                  icon: "desktopcomputer",
                  items: candidates.map((candidate) => ({
                    id: `environment:${candidate.environmentId}`,
                    title: candidate.label,
                    subtitle:
                      probe.get(candidate.environmentId) === "none" ? "No board" : undefined,
                    selected: candidate.environmentId === selected?.environmentId,
                    onPress: () => setChosenId(candidate.environmentId),
                  })),
                },
              ]
            : undefined
        }
      />
      <MaterialScreenContent>
        {selected !== undefined ? (
          <BoardContent key={selected.environmentId} candidate={selected} />
        ) : probing ? (
          <CenteredLoading label="Finding the board" />
        ) : (
          <View className="flex-1 justify-center px-4">
            <EmptyState
              title="No environment connected"
              detail="Pair a Robob server to see its session board."
            />
          </View>
        )}
      </MaterialScreenContent>
    </View>
  );
}

/** The first environment, in list order, that answered 200; waits on earlier pending probes. */
function pickBoardCandidate(
  candidates: ReadonlyArray<BoardCandidate>,
  probe: ReturnType<typeof useBoardProbe>,
): { readonly candidate: BoardCandidate | undefined; readonly probing: boolean } {
  if (candidates.length < 2) return { candidate: candidates[0], probing: false };
  for (const candidate of candidates) {
    const result = probe.get(candidate.environmentId);
    if (result === undefined) return { candidate: undefined, probing: true };
    if (result === "board") return { candidate, probing: false };
  }
  return { candidate: candidates[0], probing: false };
}

function CenteredLoading(props: { readonly label: string }) {
  return (
    <View className="flex-1 items-center justify-center gap-3">
      <ActivityIndicator colorClassName="accent-icon-muted" />
      <Text className="text-sm text-foreground-muted">{props.label}</Text>
    </View>
  );
}

function BoardContent(props: { readonly candidate: BoardCandidate }) {
  const { candidate } = props;
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { state, actions, refresh, refreshing } = useBoard(candidate);
  const projects = useProjects();
  const [lane, setLane] = useState<ArdudBoardLane>("waiting");
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [clearing, setClearing] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  // Source of truth for the in-flight guard; `busy` mirrors it for rendering.
  const busyRef = useRef(new Set<string>());

  useEffect(() => {
    if (notice === null) return;
    const timer = setTimeout(() => setNotice(null), UNDO_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  const lanes = useMemo(() => groupBoardLanes(state.entries.values()), [state.entries]);
  const entries = lanes[lane];
  const projectTitles = useMemo(
    () =>
      new Map(
        projects
          .filter((project) => project.environmentId === candidate.environmentId)
          .map((project) => [project.id as string, project.title]),
      ),
    [candidate.environmentId, projects],
  );

  const withBusy = useCallback(async (key: string, task: () => Promise<unknown>) => {
    if (busyRef.current.has(key)) return;
    busyRef.current.add(key);
    setBusy(new Set(busyRef.current));
    try {
      await task();
    } finally {
      busyRef.current.delete(key);
      setBusy(new Set(busyRef.current));
    }
  }, []);

  const runUndo = useCallback(async (undo: () => Promise<unknown>) => {
    setNotice(null);
    try {
      await undo();
    } catch (error) {
      setNotice({ title: "Could not undo", detail: errorMessage(error), tone: "error" });
    }
  }, []);

  const complete = useCallback(
    (entry: ArdudBoardEntry, destination: "review" | "backlog") =>
      void withBusy(entry.threadId, async () => {
        try {
          await (destination === "backlog" ? actions.backlog(entry) : actions.review(entry));
          setNotice({
            title: destination === "backlog" ? "Saved for later" : "Marked done",
            detail: entry.title.trim() || "Untitled thread",
            tone: "info",
            undo: () => actions.restore(entry),
          });
        } catch (error) {
          setNotice({ title: errorMessage(error), tone: "error" });
        }
      }),
    [actions, withBusy],
  );

  const restore = useCallback(
    (entry: ArdudBoardEntry) =>
      void withBusy(entry.threadId, async () => {
        try {
          await actions.restore(entry);
          setNotice({ title: "Returned to review", tone: "info" });
        } catch (error) {
          setNotice({ title: errorMessage(error), tone: "error" });
        }
      }),
    [actions, withBusy],
  );

  // Clears exactly the cards on screen, never whatever lands after.
  const clearLane = useCallback(
    async (target: "waiting" | "scheduled") => {
      const targets = lanes[target].filter((entry) => !busyRef.current.has(entry.threadId));
      if (targets.length === 0 || clearing) return;
      setClearing(true);
      try {
        const result = await actions.clear(target, targets);
        const cleared = new Set<string>(result.cleared);
        const restorable = targets.filter((entry) => cleared.has(entry.threadId));
        const skipped = result.skipped.length;
        const detail =
          skipped > 0 ? `${skipped} skipped because they changed or are still running.` : undefined;
        if (restorable.length === 0) {
          setNotice({ title: "Nothing was cleared", detail, tone: "error" });
          return;
        }
        setNotice({
          title: `Cleared ${restorable.length}`,
          detail,
          tone: "info",
          undo: async () => {
            const ok = await settleBoardTasks(restorable, (entry) => actions.restore(entry));
            if (!ok) throw new Error("Some cards could not be restored.");
          },
        });
      } catch (error) {
        setNotice({ title: errorMessage(error), tone: "error" });
      } finally {
        setClearing(false);
      }
    },
    [actions, clearing, lanes],
  );

  const open = useCallback(
    (entry: ArdudBoardEntry) =>
      navigation.navigate("Thread", {
        environmentId: candidate.environmentId,
        threadId: entry.threadId,
      }),
    [candidate.environmentId, navigation],
  );

  const renderItem = useCallback(
    ({ item }: { item: ArdudBoardEntry }) => (
      <BoardCard
        entry={item}
        projectTitle={item.projectId ? (projectTitles.get(item.projectId) ?? null) : null}
        busy={busy.has(item.threadId) || (clearing && item.state === lane)}
        onOpen={open}
        onComplete={(entry) => complete(entry, "review")}
        onBacklog={(entry) => complete(entry, "backlog")}
        onRestore={restore}
      />
    ),
    [busy, clearing, complete, lane, open, projectTitles, restore],
  );

  if (state.availability === "missing") {
    return (
      <View className="flex-1 justify-center px-4">
        <EmptyState
          title="This server has no board"
          detail={`${candidate.label} doesn't serve the Robob session board.`}
        />
      </View>
    );
  }

  const loading = state.revision < 0 && state.connection !== "offline" && state.error === null;
  const banner = state.error ?? state.syncError;
  const laneInfo = LANES.find((item) => item.lane === lane)!;
  const clearable = (lane === "waiting" || lane === "scheduled") && entries.length > 0;

  const header = (
    <View className="gap-3 pb-3">
      <SegmentedControl
        role="tab"
        selected={lane}
        onSelect={setLane}
        options={LANES.map((item) => ({
          value: item.lane,
          label: `${item.title} ${lanes[item.lane].length}`,
          accessibilityLabel: `${item.title}, ${lanes[item.lane].length}`,
        }))}
      />
      {banner ? (
        <View className="rounded-2xl border border-warning-border bg-warning px-3.5 py-3">
          <Text className="font-t3-medium text-sm text-warning-foreground">{banner}</Text>
        </View>
      ) : null}
      {state.connection !== "live" && !loading ? (
        <Text className="text-xs text-foreground-tertiary">
          {state.connection === "offline" ? "Offline. Pull to refresh." : "Reconnecting…"}
        </Text>
      ) : null}
      {clearable ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Clear all ${Math.min(entries.length, 500)} cards in ${laneInfo.title}`}
          disabled={clearing}
          onPress={() => void clearLane(lane as "waiting" | "scheduled")}
          className="flex-row items-center gap-1.5 self-end rounded-full bg-subtle px-3 py-1.5 active:opacity-70"
        >
          {clearing ? (
            <ActivityIndicator size="small" colorClassName="accent-icon-muted" />
          ) : (
            <SymbolView name="checkmark" size={12} tintColorClassName="accent-foreground-muted" />
          )}
          <Text className="text-xs font-t3-medium text-foreground-muted">Clear all</Text>
        </Pressable>
      ) : null}
    </View>
  );

  return (
    <View className="flex-1">
      {loading ? (
        <CenteredLoading label="Loading the board" />
      ) : (
        <LegendList
          className="flex-1"
          contentContainerStyle={{
            paddingHorizontal: 16,
            paddingTop: 8,
            paddingBottom: (notice ? 96 : 32) + (Platform.OS === "ios" ? 0 : insets.bottom),
          }}
          contentInsetAdjustmentBehavior="automatic"
          data={entries}
          extraData={busy}
          estimatedItemSize={104}
          keyExtractor={(item) => item.threadId}
          ListHeaderComponent={header}
          ListEmptyComponent={
            <View className="items-center rounded-[20px] border border-dashed border-border px-4 py-8">
              <Text className="text-center text-sm text-foreground-muted">{laneInfo.empty}</Text>
            </View>
          }
          refreshControl={
            <RefreshControl
              onRefresh={() => void refresh()}
              refreshing={refreshing}
              tintColorClassName={String("accent-icon")}
            />
          }
          renderItem={renderItem}
          showsVerticalScrollIndicator={false}
        />
      )}
      {notice ? (
        <View
          className="absolute inset-x-4 flex-row items-center gap-3 rounded-2xl border border-border bg-card px-4 py-3"
          style={{ bottom: Math.max(insets.bottom, 12) + 4 }}
          accessibilityLiveRegion="polite"
        >
          <View className="min-w-0 flex-1">
            <Text
              className={
                notice.tone === "error"
                  ? "text-sm font-t3-bold text-danger-foreground"
                  : "text-sm font-t3-bold text-foreground"
              }
              numberOfLines={2}
            >
              {notice.title}
            </Text>
            {notice.detail ? (
              <Text className="text-xs text-foreground-muted" numberOfLines={2}>
                {notice.detail}
              </Text>
            ) : null}
          </View>
          {notice.undo ? (
            <Pressable
              accessibilityRole="button"
              hitSlop={8}
              onPress={() => void runUndo(notice.undo!)}
              className="rounded-full bg-subtle px-3 py-1.5 active:opacity-70"
            >
              <Text className="text-sm font-t3-bold text-foreground">Undo</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

interface CardAction {
  readonly label: string;
  readonly icon: AppSymbolName;
  readonly run: () => void;
}

const BoardCard = memo(function BoardCard(props: {
  readonly entry: ArdudBoardEntry;
  readonly projectTitle: string | null;
  readonly busy: boolean;
  readonly onOpen: (entry: ArdudBoardEntry) => void;
  readonly onComplete: (entry: ArdudBoardEntry) => void;
  readonly onBacklog: (entry: ArdudBoardEntry) => void;
  readonly onRestore: (entry: ArdudBoardEntry) => void;
}) {
  const { entry, busy } = props;
  const title = entry.title.trim() || "Untitled thread";
  const done: CardAction = {
    label: `Mark ${title} done`,
    icon: "checkmark",
    run: () => props.onComplete(entry),
  };
  const cardActions: ReadonlyArray<CardAction> =
    entry.state === "waiting"
      ? [
          {
            label: `Save ${title} for later`,
            icon: "archivebox",
            run: () => props.onBacklog(entry),
          },
          done,
        ]
      : entry.state === "backlog"
        ? [
            {
              label: `Return ${title} to review`,
              icon: "arrow.uturn.backward",
              run: () => props.onRestore(entry),
            },
            done,
          ]
        : entry.state === "scheduled"
          ? [done]
          : [];
  const attention = entry.attention;
  const location = `${props.projectTitle ?? "Unknown project"}${entry.branch ? ` / ${entry.branch}` : ""}`;

  return (
    <View className="mb-2 flex-row overflow-hidden rounded-[20px] bg-grouped-card">
      <Pressable
        accessibilityRole="button"
        accessibilityHint="Opens the thread"
        onPress={() => props.onOpen(entry)}
        className="min-w-0 flex-1 gap-1 px-4 py-3 active:opacity-70"
      >
        <Text className="text-base font-t3-bold leading-snug text-foreground" numberOfLines={3}>
          {title}
        </Text>
        <View className="flex-row items-center gap-1.5">
          <SymbolView
            name={entry.branch ? "arrow.triangle.branch" : "folder"}
            size={10}
            tintColorClassName="accent-icon-subtle"
            type="monochrome"
          />
          <Text className="min-w-0 flex-1 text-xs text-foreground-muted" numberOfLines={1}>
            {location}
          </Text>
        </View>
        {entry.model ? (
          <Text className="text-xs text-foreground-tertiary" numberOfLines={1}>
            {entry.model}
          </Text>
        ) : null}
        <Text className="text-xs text-foreground-tertiary">
          {statusLabel(entry)}
          {entry.updatedAt > 0 ? `  ·  ${formatBoardAge(entry.updatedAt)}` : ""}
        </Text>
        {attention ? (
          <View className="mt-1 self-start">
            <StatusPill
              size="compact"
              label={`${attention.kind === "question" ? "Question" : "Approval"}${attention.count > 1 ? ` (${attention.count})` : ""}`}
              pillClassName="bg-warning"
              textClassName="text-warning-foreground"
            />
          </View>
        ) : null}
      </Pressable>
      {cardActions.length > 0 ? (
        <View className="flex-row items-start gap-1 pt-2 pr-2">
          {cardActions.map((action) => (
            <Pressable
              key={action.label}
              accessibilityRole="button"
              accessibilityLabel={action.label}
              accessibilityState={{ disabled: busy, busy }}
              disabled={busy}
              hitSlop={4}
              onPress={action.run}
              className="size-10 items-center justify-center rounded-full bg-subtle active:opacity-70"
            >
              {busy ? (
                <ActivityIndicator size="small" colorClassName="accent-icon-muted" />
              ) : (
                <SymbolView
                  name={action.icon}
                  size={16}
                  tintColorClassName="accent-icon"
                  type="monochrome"
                />
              )}
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
});
