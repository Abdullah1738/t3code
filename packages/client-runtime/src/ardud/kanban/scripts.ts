import type { KanbanScript, KanbanScriptRun, KanbanScriptTrigger } from "@t3tools/contracts";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const EVENT_LABELS = {
  "card.created": "When a card is added",
  "card.moved": "When a card moves",
  "message.posted": "When someone posts",
} as const;

function everyLabel(ms: number): string {
  if (ms % DAY_MS === 0) return ms === DAY_MS ? "Every day" : `Every ${ms / DAY_MS} days`;
  if (ms % HOUR_MS === 0) return ms === HOUR_MS ? "Every hour" : `Every ${ms / HOUR_MS} h`;
  const minutes = Math.round(ms / MINUTE_MS);
  return minutes <= 1 ? "Every minute" : `Every ${minutes} min`;
}

const pad = (value: string) => value.padStart(2, "0");

/** The common cron shapes in words; anything else shows the line itself. */
function cronLabel(cron: string): string {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return `Cron ${cron}`;
  const [minute, hour, dayOfMonth, month, weekday] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];
  const step = /^\*\/(\d+)$/.exec(minute);
  if (step && hour === "*" && dayOfMonth === "*" && month === "*" && weekday === "*") {
    return everyLabel(Number(step[1]) * MINUTE_MS);
  }
  if (!/^\d+$/.test(minute) || !/^\d+$/.test(hour) || dayOfMonth !== "*" || month !== "*") {
    return `Cron ${cron}`;
  }
  const at = `${pad(hour)}:${pad(minute)}`;
  if (weekday === "*") return `Daily ${at}`;
  if (weekday === "1-5") return `Weekdays ${at}`;
  return `Cron ${cron}`;
}

/**
 * When a script runs, in a few words: "Every 15 min", "Daily 09:00 · Asia/Dubai",
 * "When a card moves". Cron times get the zone the server runs them in, since
 * the browser's zone can differ.
 */
export function scriptTriggerLabel(trigger: KanbanScriptTrigger): string {
  switch (trigger._tag) {
    case "schedule":
      if (trigger.everyMs !== null) return everyLabel(trigger.everyMs);
      if (trigger.cron === null) return "On a schedule";
      return trigger.timeZone
        ? `${cronLabel(trigger.cron)} · ${trigger.timeZone}`
        : cronLabel(trigger.cron);
    case "event":
      return EVENT_LABELS[trigger.event];
    case "webhook":
      return "When its webhook is called";
    case "manual":
      return "When you run it";
  }
}

export type ScriptRunTone = "idle" | "running" | "ok" | "failed";

export interface ScriptRunState {
  readonly tone: ScriptRunTone;
  /** "Running", "Done", "Failed (exit 3)", "Didn't finish", "Not run yet". */
  readonly label: string;
}

/** How a run ended, in words. A run with no exit code never finished on its own. */
export function runState(
  run: Pick<KanbanScriptRun, "endedAt" | "exitCode"> | null,
): ScriptRunState {
  if (run === null) return { tone: "idle", label: "Not run yet" };
  if (run.endedAt === null) return { tone: "running", label: "Running" };
  if (run.exitCode === 0) return { tone: "ok", label: "Done" };
  if (run.exitCode === null) return { tone: "failed", label: "Didn't finish" };
  return { tone: "failed", label: `Failed (exit ${run.exitCode})` };
}

export const scriptState = (script: KanbanScript) => runState(script.lastRun);

/** The file name of a script's path, for a compact row. */
export const scriptFileName = (script: KanbanScript) => script.path.split("/").pop() || script.path;

/** Run duration: "4s", "2m 10s", or null while it runs. */
export function runDuration(run: Pick<KanbanScriptRun, "startedAt" | "endedAt">): string | null {
  if (run.endedAt === null) return null;
  const ms = Date.parse(run.endedAt) - Date.parse(run.startedAt);
  if (!Number.isFinite(ms) || ms < 0) return null;
  if (ms < MINUTE_MS) return `${Math.max(0, Math.round(ms / 1000))}s`;
  const minutes = Math.floor(ms / MINUTE_MS);
  const seconds = Math.round((ms % MINUTE_MS) / 1000);
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

/** Scripts on, then off; newest first within each. */
export function sortScripts(scripts: ReadonlyArray<KanbanScript>): KanbanScript[] {
  return [...scripts].sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
    return b.createdAt.localeCompare(a.createdAt);
  });
}
