import { useCallback, useEffect, useRef, type ComponentRef, type RefObject } from "react";
import { useIsFocused } from "@react-navigation/native";
import { AppState, View, useWindowDimensions } from "react-native";
import { useAskScope, useOwnerStanding } from "./askStore";
import { measureAskView, useAskViewports } from "./AskTimingScrollView";
import { askInViewport } from "./askViewport";

function useAskTiming(
  cardId: string,
  askId: string,
  ref: RefObject<ComponentRef<typeof View> | null>,
) {
  const { api } = useAskScope();
  const { sends } = useOwnerStanding();
  const focused = useIsFocused();
  const viewports = useAskViewports();
  const { width, height } = useWindowDimensions();
  const refresh = useRef(() => {});
  useEffect(() => {
    let alive = true;
    let sent = false;
    let frame: number | undefined;
    let revision = 0;
    const active = () => focused && sends === "owner" && AppState.currentState === "active";
    const schedule = () => {
      revision++;
      if (sent || !active() || viewports.length === 0 || frame !== undefined) return;
      frame = requestAnimationFrame(() => {
        frame = undefined;
        const version = revision;
        void Promise.all([
          measureAskView(ref),
          ...viewports.map((viewport) => viewport.measure()),
        ]).then(([row, ...clips]) => {
          if (
            !alive ||
            sent ||
            version !== revision ||
            !active() ||
            !askInViewport(row ?? null, [...clips, { x: 0, y: 0, width, height }])
          )
            return;
          sent = true;
          void api.seen?.(cardId, askId, "mobile").catch(() => {
            sent = false;
          });
        });
      });
    };
    refresh.current = schedule;
    const stop = viewports.at(-1)?.subscribe(schedule);
    const listener = AppState.addEventListener("change", schedule);
    schedule();
    return () => {
      alive = false;
      refresh.current = () => {};
      if (frame !== undefined) cancelAnimationFrame(frame);
      stop?.();
      listener.remove();
    };
  }, [api, cardId, askId, sends, focused, viewports, width, height, ref]);
  return useCallback(() => refresh.current(), []);
}

/** A transparent measurement anchor fills the existing row without participating in its layout. */
export function AskTiming(props: { cardId: string; askId: string }) {
  const ref = useRef<ComponentRef<typeof View>>(null);
  const onLayout = useAskTiming(props.cardId, props.askId, ref);
  return (
    <View
      ref={ref}
      collapsable={false}
      pointerEvents="none"
      accessible={false}
      style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0 }}
      onLayout={onLayout}
    />
  );
}

export function useAskNotifications(
  entries: ReadonlyArray<{ cardId: string; ask: { id: string } }>,
) {
  const { api } = useAskScope();
  const { sends } = useOwnerStanding();
  const focused = useIsFocused();
  const refs = JSON.stringify(entries.map((entry) => [entry.cardId, entry.ask.id]));
  useEffect(() => {
    if (!focused || sends !== "owner") return;
    const report = () => {
      if (AppState.currentState !== "active") return;
      for (const [cardId, askId] of JSON.parse(refs) as [string, string][])
        void api.notified?.(cardId, askId).catch(() => undefined);
    };
    report();
    const listener = AppState.addEventListener("change", report);
    return () => listener.remove();
  }, [api, refs, focused, sends]);
}
