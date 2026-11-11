import { useId, useRef, useState } from "react";

import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../../../components/ui/menu";
import { cn } from "../../../lib/utils";
import {
  localInputValue,
  shortWhen,
  snoozeChoices,
  type SnoozeChoice,
  type SnoozeUntil,
} from "./snoozeTimes";
import { Btn, Key, Layer, fieldClass } from "./ui";

/**
 * The Snooze button on a wide screen: it opens the times to choose from. The
 * S key still snoozes to tomorrow morning without opening anything.
 */
export function SnoozeMenu(props: {
  /** "Snooze", or "Snooze all 4" on a batch. */
  label: string;
  onSnooze: (until: SnoozeUntil) => void;
}) {
  // Read when the menu opens, so "Later today" is three hours from the click.
  const [choices, setChoices] = useState<ReadonlyArray<SnoozeChoice>>([]);
  const [picking, setPicking] = useState(false);
  return (
    <>
      <Menu onOpenChange={(open) => open && setChoices(snoozeChoices(Date.now()))}>
        <MenuTrigger render={<Btn tone="ghost" />}>
          {props.label}
          <Key>S</Key>
        </MenuTrigger>
        <MenuPopup align="start" side="top" className="min-w-52">
          {choices.map((choice) => (
            <MenuItem key={choice.id} onClick={() => props.onSnooze(choice)}>
              {choice.name}
              <span className="ms-auto ps-6 text-muted-foreground tabular-nums">{choice.when}</span>
            </MenuItem>
          ))}
          <MenuSeparator />
          <MenuItem onClick={() => setPicking(true)}>Pick a time…</MenuItem>
        </MenuPopup>
      </Menu>
      <SnoozePick
        open={picking}
        phone={false}
        onClose={() => setPicking(false)}
        onSnooze={props.onSnooze}
      />
    </>
  );
}

const row =
  "flex min-h-11 items-center gap-3 rounded-xl px-3 text-start text-base outline-none hover:bg-(--m-surface) focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--m-accent)";

/** The same times as rows, for the More sheet on a phone or a tablet. */
export function SnoozeRows(props: {
  nowMs: number;
  onSnooze: (until: SnoozeUntil) => void;
  onPick: () => void;
}) {
  return (
    <div role="group" aria-label="Snooze until" className="flex flex-col gap-1">
      <div className="px-3 pt-2 text-xs text-(--m-muted)">Snooze until</div>
      {snoozeChoices(props.nowMs).map((choice) => (
        <button
          key={choice.id}
          type="button"
          className={row}
          onClick={() => props.onSnooze(choice)}
        >
          <span className="min-w-0 flex-1">{choice.name}</span>
          <span className="text-(--m-muted) tabular-nums">{choice.when}</span>
        </button>
      ))}
      <button type="button" className={row} onClick={props.onPick}>
        Pick a time…
      </button>
    </div>
  );
}

/** "Pick a time": any time ahead of now, in his own zone. */
export function SnoozePick(props: {
  open: boolean;
  phone: boolean;
  onClose: () => void;
  onSnooze: (until: SnoozeUntil) => void;
}) {
  return (
    <Layer
      open={props.open}
      onClose={props.onClose}
      title="Snooze until"
      side={props.phone ? "bottom" : "center"}
      bare
      bodyClassName="p-0"
    >
      {/* Mounted with the sheet, so each opening starts from tomorrow morning. */}
      <PickForm onClose={props.onClose} onSnooze={props.onSnooze} />
    </Layer>
  );
}

function PickForm(props: { onClose: () => void; onSnooze: (until: SnoozeUntil) => void }) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [start] = useState(() => {
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(9, 0, 0, 0);
    return { min: localInputValue(now), value: localInputValue(tomorrow) };
  });
  const [value, setValue] = useState(start.value);
  const [problem, setProblem] = useState<string | null>(null);
  const send = () => {
    const at = new Date(value);
    const now = Date.now();
    if (Number.isNaN(at.getTime()) || at.getTime() <= now) {
      setProblem("Pick a time ahead of now.");
      input.current?.focus();
      return;
    }
    props.onClose();
    props.onSnooze({ iso: at.toISOString(), label: shortWhen(at.toISOString(), now) });
  };
  return (
    <form
      className="flex flex-col gap-4 p-5"
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
    >
      <div>
        <label htmlFor={id} className="mb-1.5 block text-base font-semibold">
          Snooze until
        </label>
        <input
          ref={input}
          id={id}
          type="datetime-local"
          required
          min={start.min}
          value={value}
          aria-invalid={problem ? true : undefined}
          aria-describedby={problem ? `${id}-problem` : undefined}
          onChange={(event) => {
            setProblem(null);
            setValue(event.target.value);
          }}
          className={cn(fieldClass, "tabular-nums")}
        />
        {problem ? (
          <p id={`${id}-problem`} role="alert" className="mt-1.5 text-sm text-(--m-negative)">
            {problem}
          </p>
        ) : null}
      </div>
      <div className="flex justify-end gap-2">
        <Btn onClick={props.onClose}>Cancel</Btn>
        <Btn tone="primary" type="submit">
          Snooze
        </Btn>
      </div>
    </form>
  );
}
