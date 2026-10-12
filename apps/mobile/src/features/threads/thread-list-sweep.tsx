import type { LegendListRef } from "@legendapp/list/react-native";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { AuthOrchestrationOperateScope, type EnvironmentId } from "@t3tools/contracts";
import {
  use,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from "react";
import { Pressable, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { ControlPillMenuPressGate } from "../../components/ControlPillMenuPressGate";
import { RowHoverContext } from "../../components/RowPressable";
import { cn } from "../../lib/cn";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { readEnvironmentScope } from "../../state/session";
import type { ThreadListV2ThreadListItem } from "./threadListV2";
import {
  THREAD_LIST_SWEEP_DRAG_DISTANCE,
  isThreadListSweepRow,
  resolveThreadListSweepItems,
  threadListSweepActionFor,
  threadListSweepSection,
  threadListSweepTargetKey,
  type ThreadListSweepAction,
} from "./threadListSweep";

/*
 * Pointer sweep for thread lists, matching the web sidebar: hovering a row
 * with a trackpad, mouse or pencil swaps its trailing label for the row's
 * lifecycle action. Pressing that button applies it to the row; dragging it
 * up or down applies it to every row in the section between the press and
 * the release. Touch input never sees the button, so swipe actions keep
 * working as before.
 */

const SWEEP_BADGE = {
  settle: { icon: "checkmark", label: "Settle" },
  unsettle: { icon: "arrow.uturn.backward", label: "Un-settle" },
  unsnooze: { icon: "clock", label: "Wake" },
} as const;

interface SweptRows {
  readonly action: ThreadListSweepAction;
  readonly identities: ReadonlySet<string>;
}

export interface ThreadListSweepController {
  readonly subscribe: (listener: () => void) => () => void;
  readonly sweptAction: (identity: string) => ThreadListSweepAction | null;
  readonly begin: (
    thread: EnvironmentThreadShell,
    action: ThreadListSweepAction,
    absoluteY: number,
  ) => void;
  readonly move: (absoluteY: number) => void;
  readonly end: (commit: boolean) => void;
}

const subscribeNever = () => () => {};

/** The sweep action shown on a row while a drag covers it, or null. */
export function useThreadListSweptAction(
  controller: ThreadListSweepController | undefined,
  thread: EnvironmentThreadShell,
): ThreadListSweepAction | null {
  const identity = scopedThreadKey(thread.environmentId, thread.id);
  return useSyncExternalStore(
    controller?.subscribe ?? subscribeNever,
    () => controller?.sweptAction(identity) ?? null,
  );
}

function rowIdentity(item: ThreadListV2ThreadListItem): string {
  return scopedThreadKey(item.item.thread.environmentId, item.item.thread.id);
}

interface SweepSession {
  readonly originKey: string;
  readonly originSection: string;
  readonly action: ThreadListSweepAction;
  targetKey: string;
  pointerY: number;
  /** Maps a window Y plus the current scroll offset to list content Y. */
  contentOffset: number | null;
}

interface ThreadListSweepInput {
  readonly listRef: RefObject<LegendListRef | null>;
  readonly settlementEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly snoozeEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly onSettleThread: (thread: EnvironmentThreadShell) => unknown;
  readonly onUnsettleThread: (thread: EnvironmentThreadShell) => unknown;
  readonly onUnsnoozeThread: (thread: EnvironmentThreadShell) => unknown;
}

/**
 * One sweep controller per list. Hit-testing reads the list's own layout, so
 * the rows stay free of measurement work until a drag starts.
 */
export function useThreadListSweepController(
  input: ThreadListSweepInput,
): ThreadListSweepController {
  const latest = useRef(input);
  useLayoutEffect(() => {
    latest.current = input;
  });
  const [controller] = useState(() => createThreadListSweepController(latest));
  return controller;
}

function createThreadListSweepController(
  latest: RefObject<ThreadListSweepInput>,
): ThreadListSweepController {
  let swept: SweptRows | null = null;
  let session: SweepSession | null = null;
  const listeners = new Set<() => void>();

  const publish = (next: SweptRows | null) => {
    if (swept === next) return;
    swept = next;
    for (const listener of listeners) listener();
  };

  const canApply = (item: ThreadListV2ThreadListItem, action: ThreadListSweepAction) => {
    const { settlementEnvironmentIds, snoozeEnvironmentIds } = latest.current;
    const { environmentId } = item.item.thread;
    return (
      threadListSweepActionFor({
        variant: item.item.variant,
        snoozed: item.item.snoozed,
        settlementSupported: settlementEnvironmentIds.has(environmentId),
        snoozeSupported: snoozeEnvironmentIds.has(environmentId),
      }) === action && readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)
    );
  };

  const listData = (): ReadonlyArray<{ readonly type: string; readonly key: string }> =>
    latest.current.listRef.current?.getState().data ?? [];

  const resolve = (current: SweepSession) =>
    resolveThreadListSweepItems(listData(), current, (item) => canApply(item, current.action));

  const sweepTo = (current: SweepSession, targetKey: string) => {
    current.targetKey = targetKey;
    publish({ action: current.action, identities: new Set(resolve(current).map(rowIdentity)) });
  };

  const controller: ThreadListSweepController = {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    sweptAction: (identity) =>
      swept !== null && swept.identities.has(identity) ? swept.action : null,
    begin: (thread, action, absoluteY) => {
      const state = latest.current.listRef.current?.getState();
      if (state === undefined) return;
      const originIndex = state.data.findIndex(
        (item: { readonly type: string }) =>
          isThreadListSweepRow(item) &&
          item.item.thread.environmentId === thread.environmentId &&
          item.item.thread.id === thread.id,
      );
      const origin: ThreadListV2ThreadListItem | undefined = state.data[originIndex];
      const originSection = threadListSweepSection(state.data, originIndex);
      if (origin === undefined || originSection === null) return;
      const current: SweepSession = {
        originKey: origin.key,
        originSection,
        action,
        targetKey: origin.key,
        pointerY: absoluteY,
        contentOffset: null,
      };
      session = current;
      sweepTo(current, origin.key);
      // Anchor list content to the window through the pressed row, whose
      // content position the list already knows.
      const contentTop = state.positionAtIndex(originIndex);
      const scroll = state.scroll;
      state.elementAtIndex(originIndex)?.measureInWindow((_x: number, windowTop: number) => {
        if (session !== current) return;
        current.contentOffset = contentTop - windowTop - scroll;
        controller.move(current.pointerY);
      });
    },
    move: (absoluteY) => {
      const current = session;
      if (current === null) return;
      current.pointerY = absoluteY;
      if (current.contentOffset === null) return;
      const state = latest.current.listRef.current?.getState();
      if (state === undefined) return;
      const y = absoluteY + state.scroll + current.contentOffset;
      const rows: { key: string; top: number }[] = [];
      const last = Math.min(state.end, state.data.length - 1);
      for (let index = Math.max(0, state.start); index <= last; index += 1) {
        const item = state.data[index];
        if (isThreadListSweepRow(item)) {
          rows.push({ key: item.key, top: state.positionAtIndex(index) });
        }
      }
      const targetKey = threadListSweepTargetKey(rows, y);
      if (targetKey !== null && targetKey !== current.targetKey) sweepTo(current, targetKey);
    },
    end: (commit) => {
      const current = session;
      const rows = swept;
      session = null;
      publish(null);
      if (!commit || current === null || rows === null) return;
      const { onSettleThread, onUnsettleThread, onUnsnoozeThread } = latest.current;
      const apply =
        current.action === "settle"
          ? onSettleThread
          : current.action === "unsettle"
            ? onUnsettleThread
            : onUnsnoozeThread;
      // Rows can change while the pointer is down. Apply only to rows that
      // were shown as swept and still sit in the range, in the origin's
      // section, with the same action.
      for (const item of resolve(current)) {
        if (rows.identities.has(rowIdentity(item))) void apply(item.item.thread);
      }
    },
  };
  return controller;
}

const BUTTON_LABEL = {
  settle: "Settle thread",
  unsettle: "Un-settle thread",
  unsnooze: "Wake thread now",
} as const;

// Kept mounted so a press that outlives the hover, or a sweep that hides the
// button, stays connected to its gesture.
const HIDDEN_STYLE = { position: "absolute", right: 0, opacity: 0 } as const;

/**
 * Trailing slot of a thread row. Shows `children` (the status or time label)
 * until a pointer hovers the row, then the row's action button; while a sweep
 * covers the row it shows what the sweep will do instead.
 */
export function ThreadListRowActionSlot(props: {
  /** Absent for lists without sweeps; the button then only acts on its row. */
  readonly controller: ThreadListSweepController | undefined;
  readonly thread: EnvironmentThreadShell;
  /** The row's own action, or null when the row has none to offer. */
  readonly action: ThreadListSweepAction | null;
  /** The action a sweep in progress will apply to this row. */
  readonly swept: ThreadListSweepAction | null;
  readonly variant: "card" | "slim";
  readonly foregroundClassName: string;
  readonly iconTintClassName: string;
  readonly onPress: () => void;
  readonly children: ReactNode;
}) {
  const hovered = use(RowHoverContext);
  const gatePress = use(ControlPillMenuPressGate);
  const { controller } = props;
  // Rows mount no gesture until a pointer first hovers them, so touch-only
  // devices pay nothing for this.
  const [armed, setArmed] = useState(false);
  if (hovered && !armed) setArmed(true);
  const [engaged, setEngaged] = useState(false);

  const latest = useRef({ controller, thread: props.thread, action: props.action });
  useLayoutEffect(() => {
    latest.current = { controller, thread: props.thread, action: props.action };
  });
  const sweeping = useRef(false);
  const gesture = useMemo(
    () =>
      Gesture.Pan()
        .minDistance(THREAD_LIST_SWEEP_DRAG_DISTANCE)
        .shouldCancelWhenOutside(false)
        .runOnJS(true)
        .onBegin(() => setEngaged(true))
        .onStart((event) => {
          const { controller: sweep, thread, action } = latest.current;
          if (sweep === undefined || action === null) return;
          sweeping.current = true;
          sweep.begin(thread, action, event.absoluteY);
        })
        .onUpdate((event) => {
          if (sweeping.current) latest.current.controller?.move(event.absoluteY);
        })
        .onFinalize((_event, success) => {
          setEngaged(false);
          if (!sweeping.current) return;
          sweeping.current = false;
          latest.current.controller?.end(success);
        }),
    [],
  );

  // A row can lose its action mid-drag (live updates); its gesture detaches
  // without finalizing, so cancel the sweep it started.
  const hasButton = armed && props.action !== null;
  useEffect(() => {
    if (!hasButton) return;
    return () => {
      if (!sweeping.current) return;
      sweeping.current = false;
      latest.current.controller?.end(false);
    };
  }, [hasButton]);

  const showButton = props.action !== null && props.swept === null && (hovered || engaged);
  const covered = showButton || props.swept !== null;

  return (
    <View className="flex-row items-center">
      <View
        accessibilityElementsHidden={covered}
        importantForAccessibility={covered ? "no-hide-descendants" : "auto"}
        style={covered ? HIDDEN_STYLE : undefined}
      >
        {props.children}
      </View>
      {hasButton && props.action !== null ? (
        <GestureDetector gesture={gesture}>
          <Pressable
            accessibilityElementsHidden={!showButton}
            accessibilityLabel={BUTTON_LABEL[props.action]}
            accessibilityRole="button"
            className={cn(
              "flex-row items-center gap-1 rounded-md",
              props.variant === "card" ? "-my-0.5 px-1.5 py-0.5" : "p-0.5",
            )}
            // Android keeps transparent views focusable and hit-testable; a
            // hidden button must not take a key press or tap meant for the row.
            focusable={showButton}
            hitSlop={4}
            importantForAccessibility={showButton ? "auto" : "no-hide-descendants"}
            // The row's long-press menu decides whether a release that races
            // its presentation still counts.
            onPress={(event) =>
              gatePress === null ? props.onPress() : gatePress(event, () => props.onPress())
            }
            pointerEvents={showButton || engaged ? "auto" : "none"}
            style={showButton ? undefined : HIDDEN_STYLE}
          >
            <SymbolView
              name={SWEEP_BADGE[props.action].icon}
              size={props.variant === "card" ? 12 : 13}
              tintColorClassName={props.iconTintClassName}
              type="monochrome"
              weight="semibold"
            />
            {props.variant === "card" ? (
              <Text className={cn("text-xs font-t3-medium", props.foregroundClassName)}>
                {SWEEP_BADGE[props.action].label}
              </Text>
            ) : null}
          </Pressable>
        </GestureDetector>
      ) : null}
      {props.swept !== null ? (
        <View
          accessibilityRole="text"
          className="flex-row items-center gap-1 rounded-md border border-primary/40 bg-primary/10 px-1.5 py-0.5"
        >
          <SymbolView
            name={SWEEP_BADGE[props.swept].icon}
            size={11}
            tintColorClassName="accent-primary-text"
            type="monochrome"
            weight="semibold"
          />
          <Text className="text-2xs font-t3-bold text-primary-text">
            {SWEEP_BADGE[props.swept].label}
          </Text>
        </View>
      ) : null}
    </View>
  );
}
