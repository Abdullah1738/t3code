import type { KanbanAskFeedItem } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { BotIcon } from "lucide-react";
import { useId, useRef, useState, type ReactNode } from "react";

import { cn } from "../../../lib/utils";
import { usePrimaryEnvironmentId } from "../../../state/environments";
import { handAsk } from "./askStore";
import { Btn, Label, Layer, fieldClass, linkClass } from "./ui";

const WORDS_MAX = 4_000;

/** A link to the evaluator thread a standing hand-over started. */
export function EvaluatorThreadLink(props: {
  threadId: string;
  className?: string;
  children?: ReactNode;
}) {
  const environmentId = usePrimaryEnvironmentId();
  if (!environmentId) return null;
  return (
    <Link
      to="/$environmentId/$threadId"
      params={{ environmentId, threadId: props.threadId }}
      className={cn(linkClass, props.className)}
    >
      {props.children ?? "Evaluator thread"}
    </Link>
  );
}

const quiet =
  "flex w-full items-center gap-2 rounded-lg py-1 text-start text-sm text-(--m-muted) outline-none hover:text-(--m-text) focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--m-accent) pointer-coarse:min-h-11";

/**
 * "Fewer like this": hand one ask to the board's evaluator, or hand it over
 * with his own words so asks like it stop reaching him.
 */
export function HandOver(props: {
  entry: KanbanAskFeedItem;
  phone: boolean;
  /** It can't close without a secret from him, which an evaluator can't give. */
  needsSecret?: boolean;
  /** The ask left the queue: the page moves on. */
  onLeave: () => void;
}) {
  const { entry } = props;
  const [open, setOpen] = useState(false);
  const [words, setWords] = useState("");
  const [tried, setTried] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const id = useId();
  const missing = words.trim() === "";
  const send = () => {
    if (missing) {
      setTried(true);
      input.current?.focus();
      return;
    }
    setOpen(false);
    props.onLeave();
    handAsk(entry, words.trim());
  };
  if (props.needsSecret) {
    return (
      <div className="border-t border-(--m-rule) pt-4">
        <Label className="mb-1.5">Fewer like this</Label>
        <p className="text-sm text-(--m-muted)">
          It needs a secret only you can give, so it can't go to the evaluator.
        </p>
      </div>
    );
  }
  return (
    <div className="border-t border-(--m-rule) pt-4">
      <Label className="mb-1.5">Fewer like this</Label>
      <button
        type="button"
        className={quiet}
        onClick={() => {
          props.onLeave();
          handAsk(entry);
        }}
      >
        <BotIcon aria-hidden className="size-4 shrink-0" />
        Evaluator decides this one
      </button>
      <button type="button" className={cn(quiet, "ps-6")} onClick={() => setOpen(true)}>
        …and ones like this from now on
      </button>
      <Layer
        open={open}
        onClose={() => setOpen(false)}
        title="Hand asks like this to the evaluator"
        side={props.phone ? "bottom" : "right"}
        initialFocus={input}
        footer={
          <>
            <Btn onClick={() => setOpen(false)}>Cancel</Btn>
            <Btn tone="primary" onClick={send}>
              Send to the evaluator
            </Btn>
          </>
        }
      >
        <label htmlFor={id} className="mb-1.5 block text-sm text-(--m-muted)">
          Say it in your own words
        </label>
        <textarea
          ref={input}
          id={id}
          rows={5}
          maxLength={WORDS_MAX}
          value={words}
          aria-invalid={tried && missing ? true : undefined}
          aria-describedby={`${id}-hint`}
          onChange={(event) => setWords(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) send();
          }}
          placeholder="Deploys of reviewed, merged work: handle these yourself. Tell me after."
          className={cn(fieldClass, "resize-y")}
        />
        <p
          id={`${id}-hint`}
          aria-live="polite"
          className={cn(
            "mt-2 text-sm",
            tried && missing ? "text-(--m-negative)" : "text-(--m-muted)",
          )}
        >
          {tried && missing
            ? "Say which asks it should take."
            : `Starts a thread with the ${entry.boardName} evaluator, with your words and this ask.`}
        </p>
      </Layer>
    </div>
  );
}
