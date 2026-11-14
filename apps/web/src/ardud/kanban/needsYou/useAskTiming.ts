import { useEffect, type RefObject } from "react";
import { isElectron } from "../../../env";
import { askApi } from "./askApi";

/** A mounted offscreen row or a background tab is not an owner impression. */
function observeVisible(element: HTMLElement, report: () => void) {
  let visible = false;
  const check = () => {
    if (visible && document.visibilityState === "visible") report();
  };
  const observer = new IntersectionObserver(([entry]) => {
    visible = entry?.isIntersecting === true;
    check();
  });
  observer.observe(element);
  document.addEventListener("visibilitychange", check);
  return () => {
    observer.disconnect();
    document.removeEventListener("visibilitychange", check);
  };
}

export const askNotificationsRef =
  (entries: ReadonlyArray<{ cardId: string; ask: { id: string } }>) =>
  (element: HTMLElement | null) => {
    if (!element || entries.length === 0) return;
    return observeVisible(element, () => {
      for (const entry of entries)
        void askApi.notified?.(entry.cardId, entry.ask.id).catch(() => undefined);
    });
  };

export const askTimingRef = (cardId: string, askId: string) => (element: HTMLElement | null) => {
  if (!element) return;
  return observeVisible(element, () => {
    void askApi.seen?.(cardId, askId, isElectron ? "desktop" : "web").catch(() => undefined);
  });
};

export function useAskTiming(cardId: string, askId: string, target: RefObject<HTMLElement | null>) {
  useEffect(() => askTimingRef(cardId, askId)(target.current), [cardId, askId, target]);
}
