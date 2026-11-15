import * as Cause from "effect/Cause";

export function delegationCreateFailure(cause: Cause.Cause<unknown>): string {
  const reasons = cause.reasons.map((reason) => {
    if (Cause.isInterruptReason(reason)) return "interrupt";
    const value = Cause.isFailReason(reason) ? reason.error : reason.defect;
    const kind = Cause.isFailReason(reason) ? "failure" : "defect";
    const tag =
      typeof value === "object" && value !== null && "_tag" in value
        ? String(value._tag)
        : value instanceof Error
          ? value.name
          : "";
    const message =
      value instanceof Error
        ? value.message
        : typeof value === "object" && value !== null && "message" in value
          ? String(value.message)
          : typeof value === "string"
            ? value
            : "";
    return [kind, tag, message].filter(Boolean).join(": ");
  });
  return [...new Set(reasons)].join("; ").replace(/\s+/g, " ").slice(0, 300);
}
