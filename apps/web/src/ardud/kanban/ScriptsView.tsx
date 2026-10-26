import { PlayIcon } from "lucide-react";
import { useState } from "react";

import {
  runDuration,
  runState,
  scriptFileName,
  scriptState,
  scriptTriggerLabel,
  sortScripts,
  type ScriptRunTone,
} from "@t3tools/client-runtime/ardud/kanban";
import { ageView } from "@t3tools/client-runtime/ardud/missions";
import type { KanbanScript, KanbanScriptRun } from "@t3tools/contracts";

import { Button } from "../../components/ui/button";
import { Switch } from "../../components/ui/switch";
import { cn } from "../../lib/utils";
import { kanban, runAction, useScriptRuns, useScripts } from "./kanbanStore";
import { Glyph, type GlyphKind } from "./parts";

const TONE_GLYPH: Record<ScriptRunTone, GlyphKind> = {
  idle: "idle",
  running: "ok",
  ok: "done",
  failed: "stuck",
};

const clock = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const day = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

// The time for today's runs, the date for older ones.
const startLabel = (startedAt: string, nowMs: number) => {
  const at = new Date(startedAt);
  return at.toDateString() === new Date(nowMs).toDateString() ? clock.format(at) : day.format(at);
};

function ScriptSwitch(props: { script: KanbanScript }) {
  const { script } = props;
  return (
    <Switch
      size="sm"
      checked={script.enabled}
      aria-label={`${script.name} on`}
      onCheckedChange={(enabled) =>
        void runAction("Couldn't change the script", () =>
          kanban.setScriptEnabled(script.id, enabled),
        )
      }
    />
  );
}

export function ScriptsView(props: { boardId: string; nowMs: number }) {
  const list = useScripts(props.boardId);
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  if (list === undefined) return null;
  if (list.length === 0) return <p className="text-(--m-muted)">No scripts yet.</p>;
  const scripts = sortScripts(list);
  const selected = scripts.find((script) => script.id === selectedId) ?? scripts[0];
  return (
    <div className="grid min-h-0 flex-1 content-start gap-6 lg:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
      <ul className="flex flex-col gap-0.5" aria-label="Scripts">
        {scripts.map((script) => {
          const state = scriptState(script);
          const age = script.lastRun ? ageView(script.lastRun.startedAt, props.nowMs) : null;
          const isSelected = script.id === selected?.id;
          return (
            <li
              key={script.id}
              className={cn(
                "grid h-12 grid-cols-[34px_minmax(7rem,1fr)_minmax(0,auto)_auto] items-center gap-3 rounded-xl px-2.5",
                isSelected ? "bg-(--m-surface)" : null,
              )}
            >
              <ScriptSwitch script={script} />
              <button
                type="button"
                onClick={() => setSelectedId(script.id)}
                aria-current={isSelected ? "true" : undefined}
                className="min-w-0 truncate text-left font-medium outline-none focus-visible:underline"
              >
                {script.name}
              </button>
              <span className="truncate text-sm text-(--m-muted)">
                {scriptTriggerLabel(script.trigger)}
              </span>
              <span className="inline-flex min-w-11 items-center gap-1.5 text-xs text-(--m-muted) tabular-nums">
                <Glyph kind={TONE_GLYPH[state.tone]} label={state.label} />
                {age?.label ?? ""}
              </span>
            </li>
          );
        })}
      </ul>
      {selected ? (
        <ScriptDetail
          key={selected.id}
          boardId={props.boardId}
          script={selected}
          nowMs={props.nowMs}
        />
      ) : null}
    </div>
  );
}

function ScriptDetail(props: { boardId: string; script: KanbanScript; nowMs: number }) {
  const { script } = props;
  const runs = useScriptRuns(props.boardId, script.id);
  const [runId, setRunId] = useState<number | undefined>(undefined);
  const running = scriptState(script).tone === "running";
  const shown = runs?.find((run) => run.id === runId) ?? runs?.[0];
  return (
    <section className="flex min-w-0 flex-col gap-3.5" aria-label={script.name}>
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 className="text-base font-semibold">{script.name}</h2>
        <span className="text-sm text-(--m-muted)">{scriptTriggerLabel(script.trigger)}</span>
        <span className="truncate text-sm text-(--m-muted)">{scriptFileName(script)}</span>
        <span className="flex-1" />
        <Button
          variant="outline"
          size="sm"
          disabled={running}
          onClick={() =>
            void runAction("Couldn't run the script", () => kanban.runScript(script.id))
          }
        >
          <PlayIcon />
          {running ? "Running" : "Run now"}
        </Button>
        <ScriptSwitch script={script} />
      </header>
      {runs === undefined ? null : runs.length === 0 ? (
        <p className="text-sm text-(--m-muted)">Not run yet.</p>
      ) : (
        <div className="grid gap-3.5 md:grid-cols-[200px_minmax(0,1fr)]">
          <ul className="flex flex-col gap-0.5" aria-label="Runs">
            {runs.map((run) => (
              <RunRow
                key={run.id}
                run={run}
                nowMs={props.nowMs}
                selected={run.id === shown?.id}
                onSelect={() => setRunId(run.id)}
              />
            ))}
          </ul>
          {shown ? <RunOutput run={shown} /> : null}
        </div>
      )}
    </section>
  );
}

function RunRow(props: {
  run: KanbanScriptRun;
  nowMs: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const { run } = props;
  const state = runState(run);
  const duration = runDuration(run);
  return (
    <li>
      <button
        type="button"
        onClick={props.onSelect}
        aria-current={props.selected ? "true" : undefined}
        className={cn(
          "grid h-9.5 w-full grid-cols-[14px_auto_minmax(0,1fr)] items-center gap-2 rounded-lg px-2.5 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--m-accent)",
          props.selected ? "bg-(--m-surface)" : "hover:bg-(--m-surface)",
        )}
      >
        <Glyph kind={TONE_GLYPH[state.tone]} label={state.label} />
        <span className="whitespace-nowrap tabular-nums">
          {startLabel(run.startedAt, props.nowMs)}
        </span>
        <span className="truncate text-(--m-muted)">
          {duration && state.tone !== "failed" ? duration : state.label}
        </span>
      </button>
    </li>
  );
}

function RunOutput(props: { run: KanbanScriptRun }) {
  const { run } = props;
  const text =
    run.endedAt === null
      ? "Running. The output shows here when it ends."
      : run.output.length > 0
        ? run.output
        : "No output.";
  return (
    <pre
      className={cn(
        "max-h-160 min-h-60 overflow-auto rounded-xl bg-(--m-surface) px-4 py-3.5 font-mono text-xs leading-relaxed whitespace-pre-wrap",
        run.endedAt === null || run.output.length === 0 ? "text-(--m-muted)" : null,
      )}
    >
      <code>{text}</code>
    </pre>
  );
}
