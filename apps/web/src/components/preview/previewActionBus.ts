"use client";

export type PreviewAction =
  | "toggle-panel"
  | "refresh"
  | "focus-url"
  | "zoom-in"
  | "zoom-out"
  | "reset-zoom";

const EVENT_NAME = "t3code:preview-action";
type PreviewActionEvent = CustomEvent<PreviewAction> & { executed?: boolean };

export function dispatchPreviewAction(action: PreviewAction): boolean {
  if (typeof window === "undefined") return false;
  const event: PreviewActionEvent = new CustomEvent(EVENT_NAME, { detail: action });
  window.dispatchEvent(event);
  return event.executed === true;
}

export function subscribePreviewAction(
  listener: (action: PreviewAction) => boolean | void,
): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = (event: Event) => {
    const actionEvent = event as PreviewActionEvent;
    if (typeof actionEvent.detail === "string" && listener(actionEvent.detail) === true)
      actionEvent.executed = true;
  };
  window.addEventListener(EVENT_NAME, handler);
  return () => window.removeEventListener(EVENT_NAME, handler);
}
