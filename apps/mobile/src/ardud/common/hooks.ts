import { useFocusEffect } from "@react-navigation/native";
import { errorMessage } from "@t3tools/client-runtime/ardud/common";
import { useCallback, useRef, useState } from "react";
import { Alert, AppState, Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useNativeColumnLayoutMetrics } from "../../native/native-layout-metrics";

/**
 * The iOS v5 column extends behind the solid header, so plain scroll views
 * start under it. UIKit reports zero here once it has inset the body itself.
 */
export function useHeaderInset(): number {
  const insets = useSafeAreaInsets();
  const columnMetrics = useNativeColumnLayoutMetrics();
  return Platform.OS === "ios" ? (columnMetrics?.safeArea.top ?? insets.top) : 0;
}

/**
 * Wall clock for relative labels ("3h ago"). Ticks once a minute while the
 * screen is focused and refreshes when the app returns to the foreground.
 */
export function useNowMs(): number {
  const [now, setNow] = useState(Date.now);
  useFocusEffect(
    useCallback(() => {
      const update = () => setNow(Date.now());
      update();
      const timer = setInterval(update, 60_000);
      const subscription = AppState.addEventListener("change", (state) => {
        if (state === "active") update();
      });
      return () => {
        clearInterval(timer);
        subscription.remove();
      };
    }, []),
  );
  return now;
}

export interface BoardAction {
  readonly pending: boolean;
  /** Runs one mutation; resolves true on success, alerts and resolves false on failure. */
  readonly run: (failureTitle: string, action: () => Promise<void>) => Promise<boolean>;
}

/** One in-flight mutation at a time per card, with failures shown as an alert. */
export function useBoardAction(): BoardAction {
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const run = useCallback(async (failureTitle: string, action: () => Promise<void>) => {
    if (pendingRef.current) return false;
    pendingRef.current = true;
    setPending(true);
    try {
      await action();
      return true;
    } catch (error) {
      Alert.alert(failureTitle, errorMessage(error));
      return false;
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }, []);
  return { pending, run };
}

/** Destructive or hard-to-undo actions ask first. */
export function confirmAction(input: {
  readonly title: string;
  readonly message: string;
  readonly confirmLabel: string;
  readonly destructive?: boolean;
  readonly onConfirm: () => void;
}): void {
  Alert.alert(input.title, input.message, [
    { text: "Cancel", style: "cancel" },
    {
      text: input.confirmLabel,
      style: input.destructive ? "destructive" : "default",
      onPress: input.onConfirm,
    },
  ]);
}
