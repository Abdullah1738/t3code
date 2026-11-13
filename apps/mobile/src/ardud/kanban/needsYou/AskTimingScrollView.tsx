import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  type ComponentRef,
  type ComponentPropsWithRef,
  type RefObject,
} from "react";
import { useIsFocused } from "@react-navigation/native";
import { AppState, ScrollView, useWindowDimensions, type View } from "react-native";
import { createAskViewport, type AskRect, type AskViewport } from "./askViewport";

const NO_VIEWPORTS: ReadonlyArray<AskViewport> = [];
const AskViewports = createContext(NO_VIEWPORTS);
export const useAskViewports = () => useContext(AskViewports);

export function measureAskView(
  ref: RefObject<ComponentRef<typeof View> | ComponentRef<typeof ScrollView> | null>,
): Promise<AskRect | null> {
  return new Promise<AskRect | null>((resolve) => {
    const node = ref.current;
    if (!node) return resolve(null);
    node.measureInWindow((x, y, width, height) => resolve({ x, y, width, height }));
  }).catch(() => null);
}

/** Same native scrolling; only layout/scroll events trigger receipt measurements. */
export function AskTimingScrollView({
  ref: forwardedRef,
  onLayout,
  onContentSizeChange,
  onScroll,
  scrollEventThrottle,
  ...props
}: ComponentPropsWithRef<typeof ScrollView>) {
  const ref = useRef<ComponentRef<typeof ScrollView>>(null);
  useImperativeHandle(forwardedRef, () => ref.current!, []);
  const parents = useAskViewports();
  const measure = useCallback(() => measureAskView(ref), []);
  // oxlint-disable-next-line react/refs -- The viewport retains this callback; native measurements run after layout or scroll, never during render.
  const viewport = useMemo(() => createAskViewport(measure), [measure]);
  const viewports = useMemo(() => [...parents, viewport], [parents, viewport]);
  const { width, height } = useWindowDimensions();
  const focused = useIsFocused();
  useEffect(() => {
    const stop = parents.at(-1)?.subscribe(viewport.refresh);
    const listener = AppState.addEventListener("change", viewport.refresh);
    if (focused && width > 0 && height > 0) viewport.refresh();
    return () => {
      stop?.();
      listener.remove();
    };
  }, [parents, viewport, width, height, focused]);
  return (
    <AskViewports.Provider value={viewports}>
      <ScrollView
        {...props}
        ref={ref}
        scrollEventThrottle={scrollEventThrottle ?? 100}
        onLayout={(event) => {
          viewport.refresh();
          onLayout?.(event);
        }}
        onContentSizeChange={(width, height) => {
          viewport.refresh();
          onContentSizeChange?.(width, height);
        }}
        onScroll={(event) => {
          viewport.refresh();
          onScroll?.(event);
        }}
      />
    </AskViewports.Provider>
  );
}
