import { feedFailureLines } from "@t3tools/client-runtime/ardud/missions";

import { Button } from "../../../components/ui/button";
import { StateGlyph } from "../cards/chips";
import type { FeedState } from "../missionsStore";

/**
 * The Desk error line inside the block whose read failed: what failed, when it
 * last loaded, and Retry. Renders nothing while the feed reads fine.
 */
export function FeedError(props: { what: string; feed: FeedState; nowMs: number }) {
  const { failure, retry } = props.feed;
  if (!failure) return null;
  const lines = feedFailureLines(props.what, failure, props.nowMs);
  return (
    <div
      role="alert"
      className="grid grid-cols-[10px_minmax(0,1fr)] items-baseline gap-x-3 gap-y-0.5 pt-3 pb-1 text-sm"
    >
      <StateGlyph kind="bad" />
      <p className="font-medium">{lines.title}</p>
      {lines.detail ? <p className="col-start-2 text-(--m-muted)">{lines.detail}</p> : null}
      <Button
        variant="ghost-muted"
        size="sm"
        className="col-start-2 -ms-2.5 mt-1.5 justify-self-start"
        onClick={retry}
      >
        Retry
      </Button>
    </div>
  );
}
