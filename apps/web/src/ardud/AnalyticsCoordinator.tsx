import { useAtomValue } from "@effect/atom-react";
import { useLocation } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { AsyncResult } from "effect/reactivity";
import type { EnvironmentId } from "@t3tools/contracts";
import { enabledEnvironmentIds } from "@t3tools/client-runtime/state/connections";
import { registerRuntimeAnalytics } from "@t3tools/client-runtime/state/analytics";
import {
  activeAnalytics,
  analyticsForEnvironment,
  analyticsWebScreen,
  analyticsErrorTag,
  sampleAnalyticsFrames,
  setActiveAnalyticsEnvironment,
  flushEnvironmentAnalytics,
} from "@t3tools/client-runtime/ardud/analytics";
import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { primaryEnvironmentIdAtom } from "../state/primaryEnvironment";
import { isElectron } from "../env";

export function AnalyticsCoordinator() {
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const primary = useAtomValue(primaryEnvironmentIdAtom);
  const pathname = useLocation({ select: (value) => value.pathname });
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
        surface: isElectron ? "desktop" : "web",
      });
      let wasConnected = false;
      let reconnectStarted: number | undefined;
      const unsubscribe = appAtomRegistry.subscribe(
        environmentCatalog.stateAtom(environmentId),
        (result) => {
          if (!AsyncResult.isSuccess(result)) return;
          if (result.value.phase === "connected") {
            if (reconnectStarted !== undefined)
              registration.collector.record("connection.reconnect", {
                durationMs: performance.now() - reconnectStarted,
              });
            reconnectStarted = undefined;
            wasConnected = true;
          } else if (wasConnected && reconnectStarted === undefined)
            reconnectStarted = performance.now();
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
    const screen = analyticsWebScreen(pathname);
    const environmentId = screen.environmentId ?? primary;
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
    const cancelSample = sampleAnalyticsFrames(
      collector,
      requestAnimationFrame,
      cancelAnimationFrame,
    );
    const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
    if (memory)
      collector.record("performance.memory", { props: { memoryBytes: memory.usedJSHeapSize } });
    return () => {
      cancelAnimationFrame(frame);
      cancelSample();
      collector.endRoute();
    };
  }, [pathname, primary, environmentKey]);
  useEffect(() => {
    const visibility = () => {
      if (document.visibilityState === "hidden") void flushEnvironmentAnalytics("background");
      else activeAnalytics()?.foreground();
    };
    const close = () => {
      void flushEnvironmentAnalytics("close");
    };
    const uncaught = (event: ErrorEvent) =>
      activeAnalytics()?.record("client.error", {
        props: { errorTag: analyticsErrorTag(event.error), phase: "uncaught" },
      });
    const rejection = (event: PromiseRejectionEvent) =>
      activeAnalytics()?.record("client.error", {
        props: { errorTag: analyticsErrorTag(event.reason), phase: "unhandled-rejection" },
      });
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("pagehide", close);
    window.addEventListener("error", uncaught);
    window.addEventListener("unhandledrejection", rejection);
    let observer: PerformanceObserver | undefined;
    if (
      typeof PerformanceObserver !== "undefined" &&
      PerformanceObserver.supportedEntryTypes.includes("longtask")
    ) {
      observer = new PerformanceObserver((entries) => {
        const collector = activeAnalytics();
        for (const entry of entries.getEntries().slice(0, 20))
          collector?.record("performance.long-task", { durationMs: entry.duration });
      });
      observer.observe({ type: "longtask" });
    }
    return () => {
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("pagehide", close);
      window.removeEventListener("error", uncaught);
      window.removeEventListener("unhandledrejection", rejection);
      observer?.disconnect();
      setActiveAnalyticsEnvironment(null);
    };
  }, []);
  return null;
}
