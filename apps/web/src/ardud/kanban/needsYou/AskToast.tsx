import { heldSecondsLeft, type HeldSend } from "@t3tools/client-runtime/ardud/kanban";
import { XIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { dismissAskToast, retryAskSend, useAskStore, type AskSend } from "./askStore";
import { Btn, IconBtn, Key } from "./ui";

/** "sends in 4s": mounted per held answer, so its clock starts fresh each time. */
function SecondsLeft(props: { held: HeldSend<AskSend> }) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 250);
    return () => clearInterval(timer);
  }, []);
  return (
    <span className="ms-2 whitespace-nowrap opacity-70 tabular-nums">
      sends in {heldSecondsLeft(props.held, nowMs)}s
    </span>
  );
}

const onDark =
  "bg-(--m-ground)/15 text-(--m-ground) hover:bg-(--m-ground)/25 focus-visible:ring-(--m-ground)";

/**
 * The one message at the foot of the page: what was just answered with its
 * Undo while the answer is held, or what went wrong with a way to act on it.
 */
export function AskToastView(props: {
  onUndo: () => void;
  onView: (key: string) => void;
  /** Lifts it clear of the action bar under it. */
  bottom: number;
}) {
  const toast = useAskStore((state) => state.toast);
  const held = useAskStore((state) => state.held);
  const undoable = toast?.undoSendId !== undefined && held?.payload.id === toast.undoSendId;
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none absolute inset-x-0 z-20 flex justify-center px-3"
      style={{ bottom: props.bottom }}
    >
      {toast ? (
        <div
          key={toast.id}
          data-ny-toast
          className="pointer-events-auto flex max-w-full min-w-0 items-center gap-3 rounded-2xl bg-(--m-text) py-2 ps-4 pe-2 text-sm text-(--m-ground) shadow-lg"
        >
          <span className="min-w-0 py-1 [overflow-wrap:anywhere]">
            {toast.text}
            {undoable && held ? <SecondsLeft key={held.id} held={held} /> : null}
          </span>
          {undoable ? (
            <Btn size="sm" onClick={props.onUndo} className={onDark}>
              Undo
              <Key className="text-(--m-ground)/80 ring-(--m-ground)/40">Z</Key>
            </Btn>
          ) : null}
          {toast.retryKey ? (
            <Btn size="sm" onClick={() => retryAskSend(toast.retryKey!)} className={onDark}>
              Retry
            </Btn>
          ) : null}
          {toast.viewKey ? (
            <Btn
              size="sm"
              onClick={() => {
                props.onView(toast.viewKey!);
                dismissAskToast();
              }}
              className={onDark}
            >
              Show
            </Btn>
          ) : null}
          {undoable ? null : (
            <IconBtn
              label="Dismiss"
              onClick={dismissAskToast}
              className="text-(--m-ground)/70 hover:bg-(--m-ground)/15 hover:text-(--m-ground) focus-visible:ring-(--m-ground)"
            >
              <XIcon />
            </IconBtn>
          )}
        </div>
      ) : null}
    </div>
  );
}
