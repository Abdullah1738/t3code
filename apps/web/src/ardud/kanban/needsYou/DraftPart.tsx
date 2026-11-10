import { askDraftEdited, askDraftText, type AskForm } from "@t3tools/client-runtime/ardud/kanban";
import type { KanbanAskDraft, KanbanAskFeedItem } from "@t3tools/contracts";
import { PencilIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "../../../lib/utils";
import { KanbanMarkdown } from "../links";
import { GrowingText, Problem } from "./AnswerParts";
import { patchAskForm } from "./askStore";
import { Label, linkClass } from "./ui";

/**
 * A text the agent wants to send, shown as it will read. Where the ask lets
 * him edit it, the text itself is the way in: click it, or press E.
 */
export function DraftPart(props: {
  entry: KanbanAskFeedItem;
  draft: KanbanAskDraft;
  form: AskForm;
  editable: boolean;
  problem: string | undefined;
}) {
  const { entry, draft, form } = props;
  const [editing, setEditing] = useState(false);
  const text = askDraftText({ draft }, form);
  const edited = askDraftEdited({ draft }, form);
  const open = props.editable && (editing || props.problem !== undefined);

  return (
    <section aria-label="Draft" className="rounded-2xl bg-(--m-surface) p-4">
      <Label className="mb-2.5">
        As it will appear
        {draft.target ? ` · ${draft.target}` : ""}
        {props.editable && !open ? " · click the text to edit" : ""}
      </Label>
      {open ? (
        <GrowingText
          autoFocus
          data-ny-at="draft"
          aria-label="Draft text"
          aria-invalid={props.problem ? true : undefined}
          value={text}
          maxLength={20_000}
          onChange={(event) => patchAskForm(entry, { draft: event.target.value })}
          onBlur={() => setEditing(false)}
          className={cn("p-4 leading-6", draft.format === "markdown" && "font-mono text-sm")}
        />
      ) : (
        <div
          className={cn(
            "relative rounded-xl bg-(--m-ground) p-4 ring-1 ring-inset ring-(--m-rule) [overflow-wrap:anywhere]",
            props.editable && "hover:ring-(--m-control)",
          )}
        >
          {draft.format === "markdown" ? (
            <KanbanMarkdown text={text} />
          ) : (
            <p className="whitespace-pre-wrap">{text}</p>
          )}
          {props.editable ? (
            <button
              type="button"
              data-ny-at="draft"
              data-ny-edit
              aria-label="Edit the draft"
              onClick={() => setEditing(true)}
              className="absolute inset-0 cursor-text rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--m-accent)"
            />
          ) : null}
        </div>
      )}
      {props.problem ? <Problem>{props.problem}</Problem> : null}
      {edited ? (
        <p className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-(--m-warning)">
          <span className="inline-flex items-center gap-1.5">
            <PencilIcon aria-hidden className="size-3.5" />
            Edited. Your text is what gets sent.
          </span>
          <button
            type="button"
            onClick={() => {
              setEditing(false);
              patchAskForm(entry, { draft: null });
            }}
            className={linkClass}
          >
            Revert to the agent's text
          </button>
        </p>
      ) : null}
    </section>
  );
}
