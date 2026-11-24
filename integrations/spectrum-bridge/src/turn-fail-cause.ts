import type { RunDiag } from "./openchamber.ts";

/** Why a turn.end row failed (#137). Logging only: nothing reads these to decide a retry. */
export const FAIL_CAUSES = ["provider_error", "instant_fail", "run_cancelled", "robob_restart", "steer_refused", "link_down", "timeout", "undelivered", "unknown"] as const;
export type FailCause = typeof FAIL_CAUSES[number];

/** Short codes for the run's error text; the text itself never reaches the log. */
export const ROBOB_ERROR_CODES = ["selected_model", "rate_limited", "overloaded", "context_length", "auth", "refusal", "timeout", "no_detail", "other"] as const;
export type RobobErrorCode = typeof ROBOB_ERROR_CODES[number];

/** A failed run this short is the instant-failure loop of #130, not a run that worked and then broke. */
export const INSTANT_FAIL_MS = 5_000;

export interface TurnFailInfo {
  /** Set where the call site alone knows the cause (delivery expiry, a batch that never reached Robob). */
  cause?: FailCause;
  idleOutcome?: "succeeded" | "failed" | "interrupted";
  diag?: RunDiag;
  /** The provider's error, reduced to a code before logging. */
  error?: unknown;
  modelError?: boolean;
}

// toollog.ts imports this module for its enums, so it imports no runtime code (robob.ts would loop back).
const ERROR_PATTERNS: [RobobErrorCode, RegExp][] = [
  ["selected_model", /issue with the selected model/i],
  ["rate_limited", /rate.?limit|\b429\b|quota|usage limit|too many requests/i],
  ["overloaded", /overloaded|\b529\b|\b503\b|capacity|temporarily unavailable/i],
  ["context_length", /context (?:length|window)|too long|maximum context|token limit/i],
  ["auth", /\b401\b|\b403\b|unauthori[sz]ed|forbidden|api key|authenticat|not logged in|login required/i],
  ["refusal", /refus|flagged|blocked the response|content policy|safety/i],
  ["timeout", /timed? ?out|timeout|deadline/i],
];

export function robobErrorCode(error: unknown, modelError = false): RobobErrorCode | undefined {
  if (modelError) return "selected_model";
  const text = typeof error === "string" ? error
    : error && typeof error === "object" && "message" in error && typeof error.message === "string" ? error.message : undefined;
  if (text === undefined) return error === undefined || error === null ? undefined : "other";
  if (text === "Run failed without error details") return "no_detail";
  return ERROR_PATTERNS.find(([, pattern]) => pattern.test(text))?.[0] ?? "other";
}

export function turnFailCause(input: { outcome: string; endReason?: string; linkDown?: boolean; info?: TurnFailInfo; sinceTurnStartMs: number }): FailCause {
  const { outcome, endReason, linkDown, info, sinceTurnStartMs } = input;
  // The route's provider refused the turn (refusedRoute); the card's enum names it steer_refused.
  if (outcome === "refused") return "steer_refused";
  if (info?.cause) return info.cause;
  if (endReason === "expired") return "timeout";
  if (endReason === "undelivered") return linkDown ? "link_down" : "undelivered";
  const status = info?.diag?.runStatus;
  if (status === "cancelled" || status === "rolled_back") return "run_cancelled";
  if (status === "interrupted" || status === undefined && info?.idleOutcome === "interrupted") return "robob_restart";
  if (status === "failed" || info?.idleOutcome === "failed" || info?.error !== undefined || info?.modelError) {
    const runMs = info?.diag?.runMs;
    const ms = typeof runMs === "number" && Number.isFinite(runMs) && runMs >= 0 ? runMs : sinceTurnStartMs;
    return ms < INSTANT_FAIL_MS ? "instant_fail" : "provider_error";
  }
  return linkDown ? "link_down" : "unknown";
}
