import { useState } from "react";

import {
  formatPercent,
  intendedShareLine,
  type PriorityStackRow,
} from "@t3tools/client-runtime/ardud/missions";

import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../../components/ui/popover";
import { setIntendedShare } from "./missionCommands";

// Presentation plus form state. Parsing and the source call live in
// missionCommands. Nothing locks: the owner and the master write the same
// field, and the row says who changed it last.

/** The intended share on one priority-stack row: who changed it last and an editor. */
export function IntendedShareEditor(props: { row: PriorityStackRow; masterRoleId: string | null }) {
  const { row } = props;
  const sub = row.subMission;
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const changedLine = intendedShareLine(row, props.masterRoleId);

  const submit = async () => {
    setBusy(true);
    const sent = await setIntendedShare(sub.id, text);
    setBusy(false);
    if (sent) setOpen(false);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setText(row.intended === null ? "" : String(Math.round(row.intended * 100)));
      }}
    >
      <PopoverTrigger
        render={<Button variant="ghost" size="xs" />}
        aria-label={`Intended share for ${sub.title}: ${
          row.intended === null ? "none" : formatPercent(row.intended)
        }, ${changedLine}`}
      >
        {row.intended === null ? "set share" : formatPercent(row.intended)}
        <span className="text-muted-foreground">{changedLine}</span>
      </PopoverTrigger>
      <PopoverPopup align="end" side="bottom" className="w-64">
        <PopoverTitle>Intended share for {sub.title}</PopoverTitle>
        <form
          className="mt-2 flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <Input
            size="sm"
            aria-label="Share in percent"
            inputMode="decimal"
            placeholder="e.g. 40"
            autoFocus
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            The master can change it too. Leave it empty to clear the share.
          </p>
          <div className="flex justify-end">
            <Button type="submit" size="sm" disabled={busy}>
              Save
            </Button>
          </div>
        </form>
      </PopoverPopup>
    </Popover>
  );
}
