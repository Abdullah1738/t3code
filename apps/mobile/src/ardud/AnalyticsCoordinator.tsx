import { useAtomValue } from "@effect/atom-react";
import { createNavigationContainerRef } from "@react-navigation/native";
import { useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { AsyncResult } from "effect/reactivity";
import type { EnvironmentId } from "@t3tools/contracts";
import { enabledEnvironmentIds } from "@t3tools/client-runtime/state/connections";
import { registerRuntimeAnalytics } from "@t3tools/client-runtime/state/analytics";
import {
  activeAnalytics,
  analyticsForEnvironment,
  analyticsNavigationScreen,
  sampleAnalyticsFrames,
  setActiveAnalyticsEnvironment,
  analyticsErrorTag,
  flushEnvironmentAnalytics,
} from "@t3tools/client-runtime/ardud/analytics";
import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../state/atom-registry";
import { pairedEnvironmentIdAtom } from "./common/environment";

export const analyticsNavigationRef = createNavigationContainerRef();
const navigationListeners = new Set<() => void>();
export function noteAnalyticsNavigation() {
  for (const listener of navigationListeners) listener();
}

export function AnalyticsCoordinator() {
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const paired = useAtomValue(pairedEnvironmentIdAtom);
  const [navigationVersion, setNavigationVersion] = useState(0);
  const environmentKey = JSON.stringify([...enabledEnvironmentIds(catalog)].sort());
  const registrations = useRef(new Map<string, () => void>());
  useEffect(() => {
    const environmentIds = JSON.parse(environmentKey) as EnvironmentId[];
    const desired = new Set<string>(environmentIds);
    for (const [id, cleanup] of registrations.current) {
      if (!desired.has(id)) {
        cleanup();
        registrations.current.delete(id);
      }
    }
    for (const environmentId of environmentIds) {
      if (registrations.current.has(environmentId)) continue;
      const registration = registerRuntimeAnalytics({
        runtime: connectionAtomRuntime,
        registry: appAtomRegistry,
        environmentId,
        surface: "mobile",
      });
      let connected = false;
      let started: number | undefined;
      const unsubscribe = appAtomRegistry.subscribe(
        environmentCatalog.stateAtom(environmentId),
        (result) => {
          if (!AsyncResult.isSuccess(result)) return;
          if (result.value.phase === "connected") {
            if (started !== undefined)
              registration.collector.record("connection.reconnect", {
                durationMs: performance.now() - started,
              });
            started = undefined;
            connected = true;
          } else if (connected && started === undefined) started = performance.now();
        },
        { immediate: true },
      );
      registrations.current.set(environmentId, () => {
        unsubscribe();
        registration.unregister();
      });
    }
  }, [environmentKey]);
  useEffect(
    () => () => {
      for (const cleanup of registrations.current.values()) cleanup();
      registrations.current.clear();
    },
    [],
  );
  useEffect(() => {
    const listener = () => setNavigationVersion((version) => version + 1);
    navigationListeners.add(listener);
    return () => {
      navigationListeners.delete(listener);
    };
  }, []);
  useEffect(() => {
    if (navigationVersion === 0 && !analyticsNavigationRef.isReady()) return;
    const current = analyticsNavigationRef.isReady()
      ? analyticsNavigationRef.getCurrentRoute()
      : undefined;
    if (!current) return;
    const screen = analyticsNavigationScreen(current.name, current.params);
    const environmentId = screen.environmentId ?? paired;
    setActiveAnalyticsEnvironment(environmentId);
    const enabled: ReadonlyArray<string> = JSON.parse(environmentKey);
    if (environmentId === null || !enabled.includes(environmentId)) return;
    const collector = analyticsForEnvironment(environmentId);
    if (!collector) return;
    collector.setRoute(screen.details);
    const started = performance.now();
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() =>
        collector.record("performance.route", {
          durationMs: performance.now() - started,
          props: { phase: "post-commit-paint" },
        }),
      );
    });
    const cancel = sampleAnalyticsFrames(collector, requestAnimationFrame, cancelAnimationFrame);
    return () => {
      cancelAnimationFrame(frame);
      cancel();
      collector.endRoute();
    };
  }, [navigationVersion, paired, environmentKey]);
  useEffect(() => {
    const change = AppState.addEventListener("change", (state) => {
      if (state === "active") activeAnalytics()?.foreground();
      else void flushEnvironmentAnalytics("background");
    });
    const memory = AppState.addEventListener("memoryWarning", () =>
      activeAnalytics()?.record("performance.memory", { props: { phase: "background" } }),
    );
    const errorHost = globalThis as typeof globalThis & {
      ErrorUtils?: {
        getGlobalHandler: () => (error: unknown, fatal?: boolean) => void;
        setGlobalHandler: (handler: (error: unknown, fatal?: boolean) => void) => void;
      };
    };
    const previous = errorHost.ErrorUtils?.getGlobalHandler();
    const handle = (error: unknown, fatal?: boolean) => {
      activeAnalytics()?.record("client.error", {
        props: { errorTag: analyticsErrorTag(error), phase: "uncaught" },
      });
      previous?.(error, fatal);
    };
    errorHost.ErrorUtils?.setGlobalHandler(handle);
    return () => {
      change.remove();
      memory.remove();
      if (previous && errorHost.ErrorUtils?.getGlobalHandler() === handle)
        errorHost.ErrorUtils.setGlobalHandler(previous);
      setActiveAnalyticsEnvironment(null);
    };
  }, []);
  return null;
}
