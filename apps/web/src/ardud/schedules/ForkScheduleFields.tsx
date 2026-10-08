import { cronScheduleProblem } from "@t3tools/contracts";
import { useId, useMemo } from "react";

import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import {
  supportedTimeZones,
  type ForkScheduleDraft,
  type ForkScheduleMode,
} from "@t3tools/client-runtime/ardud/schedule-draft";

export function TimeZoneInput(props: {
  readonly value: string;
  readonly onChange: (timeZone: string) => void;
  readonly id?: string;
}) {
  const listId = useId();
  const zones = useMemo(() => supportedTimeZones(), []);
  return (
    <>
      <Input
        id={props.id}
        className="w-56"
        list={listId}
        value={props.value}
        placeholder="Asia/Dubai"
        spellCheck={false}
        onChange={(event) => props.onChange(event.target.value)}
      />
      <datalist id={listId}>
        {zones.map((zone) => (
          <option key={zone} value={zone} />
        ))}
      </datalist>
    </>
  );
}

/** Editor rows for cron and one-time schedules. */
export function ForkScheduleFields(props: {
  readonly mode: ForkScheduleMode;
  readonly draft: ForkScheduleDraft;
  readonly onChange: (draft: ForkScheduleDraft) => void;
}) {
  const { mode, draft, onChange } = props;
  const cronProblem =
    mode === "cron" && draft.cronExpression.trim()
      ? cronScheduleProblem(draft.cronExpression, draft.timeZone.trim())
      : undefined;
  return (
    <div className="space-y-3">
      {mode === "cron" ? (
        <div className="flex flex-wrap items-center gap-2">
          <Label htmlFor="scheduled-task-cron">Cron</Label>
          <Input
            id="scheduled-task-cron"
            className="w-48"
            font="mono"
            value={draft.cronExpression}
            placeholder="0 9 * * 1-5"
            spellCheck={false}
            onChange={(event) => onChange({ ...draft, cronExpression: event.target.value })}
          />
          <span className="text-xs text-muted-foreground">minute hour day month weekday</span>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Label htmlFor="scheduled-task-once">Run on</Label>
          <Input
            type="datetime-local"
            id="scheduled-task-once"
            nativeInput
            className="w-56"
            value={draft.onceLocal}
            onChange={(event) => onChange({ ...draft, onceLocal: event.target.value })}
          />
          <span className="text-xs text-muted-foreground">Disables itself after it runs.</span>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Label htmlFor="scheduled-task-zone">Time zone</Label>
        <TimeZoneInput
          id="scheduled-task-zone"
          value={draft.timeZone}
          onChange={(timeZone) => onChange({ ...draft, timeZone })}
        />
      </div>
      {cronProblem ? (
        <p className="text-xs text-destructive" role="status">
          {cronProblem}
        </p>
      ) : null}
    </div>
  );
}
