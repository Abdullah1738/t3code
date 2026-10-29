import { useEffect, useId, useRef, useState } from "react";

import { observeResize } from "../../lib/observeResize";

export function CardDescription(props: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const ref = useRef<HTMLParagraphElement>(null);
  const id = useId();

  // Measured only while collapsed: the clamp is what makes the text overflow, and
  // once it is lifted the measurement would read "fits" and hide the toggle.
  useEffect(() => {
    const element = ref.current;
    if (!element || expanded) return;
    const measure = () => setOverflowing(element.scrollHeight > element.clientHeight + 1);
    measure();
    return observeResize(element, measure);
  }, [expanded]);

  return (
    <div className="flex flex-col items-start">
      <p
        ref={ref}
        id={id}
        className={
          expanded
            ? "max-h-[40vh] w-full overflow-y-auto text-sm leading-normal break-words whitespace-pre-wrap text-(--m-text)"
            : "line-clamp-4 w-full text-sm leading-normal break-words whitespace-pre-wrap text-(--m-text)"
        }
      >
        {props.text}
      </p>
      {overflowing || expanded ? (
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => setExpanded((value) => !value)}
          className="mt-1 self-start rounded-full text-sm font-medium text-(--m-muted) outline-none hover:text-(--m-text) focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--m-accent)"
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      ) : null}
    </div>
  );
}
