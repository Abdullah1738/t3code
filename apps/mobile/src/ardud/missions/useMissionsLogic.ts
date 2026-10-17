import { useFocusEffect } from "@react-navigation/native";
import { missionErrorMessage } from "@t3tools/client-runtime/ardud/missions/mobile";
import { useCallback, useRef, useState } from "react";
import { Alert, AppState } from "react-native";

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

export interface MissionAction {
  readonly pending: boolean;
  /** Runs one mutation; resolves true on success, alerts and resolves false on failure. */
  readonly run: (failureTitle: string, action: () => Promise<void>) => Promise<boolean>;
}

/** One in-flight mutation at a time per card, with failures shown as an alert. */
export function useMissionAction(): MissionAction {
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
      Alert.alert(failureTitle, missionErrorMessage(error));
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
