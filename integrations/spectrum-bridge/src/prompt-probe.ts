import { BoundedTimeout } from "./bounded.ts";
import type { LogLine } from "./toollog.ts";

function probeStatus(error: unknown): number | undefined {
  try {
    const status = error && typeof error === "object" ? (error as Record<string, unknown>).status : undefined;
    if (typeof status === "number" && Number.isInteger(status) && (status === 0 || status >= 100 && status <= 599)) return status;
  } catch { /* A thrown object's getters cannot change the probe's retry behavior. */ }
}

export class PromptProbeTracker {
  private prompts = new Map<string, { attempts: number; accepted: boolean; at: number }>();
  private sweptAt = 0;
  constructor(private readonly write: (line: Omit<LogLine, "ts" | "tool">) => void,
    private readonly wall = Date.now, private readonly clock = () => performance.now()) {}

  start(threadId: string, promptId: string, sentAt: number) {
    const at = this.wall();
    if (at - this.sweptAt >= 60_000) {
      for (const [key, value] of this.prompts) if (at - value.at > 6 * 3600_000) this.prompts.delete(key);
      this.sweptAt = at;
    }
    const key = JSON.stringify([threadId, promptId]);
    const state = this.prompts.get(key) ?? { attempts: 0, accepted: false, at };
    state.at = at;
    state.attempts++;
    this.prompts.set(key, state);
    if (this.prompts.size > 10_000) this.prompts.delete(this.prompts.keys().next().value!);
    const started = this.clock();
    let finished = false;
    const record = (probeOutcome: string, props: NonNullable<LogLine["props"]> = {}) => {
      if (finished) return false;
      finished = true;
      try {
        this.write({ component: "router", kind: "perf", name: "router.prompt_probe", ids: { threadId },
          props: { probeOutcome, elapsedMs: Math.max(0, this.clock() - started), ...props } });
      } catch { /* Diagnostics cannot change admission or retry. */ }
      return true;
    };
    return {
      cancel: () => {
        if (finished) return;
        finished = true;
        state.attempts--;
      },
      complete: (accepted: boolean) => {
        const first = accepted && !state.accepted;
        if (record(accepted ? "accepted" : "notAcceptedYet", first ? {
          attempt: state.attempts, msUntilAccepted: Math.max(0, this.wall() - sentAt),
        } : {})) state.accepted ||= accepted;
      },
      failure: (error: unknown): LogLine["props"] => {
        const status = probeStatus(error);
        const causeKind = error instanceof BoundedTimeout ? "timeout"
          : status !== undefined && status > 0 ? "http" : "transport";
        if (!record(causeKind, status === undefined ? {} : { status })) return;
        return { causeKind, boundMs: 10_000, elapsedMs: Math.max(0, this.clock() - started),
          attempt: state.attempts, route: "/prompt-acceptance", ...(status === undefined ? {} : { status }) };
      },
    };
  }
}
