import { createHash } from "node:crypto";

export type DependencyBusy = { dependency: string; detail: string };
export const safeDependency = (value: unknown): value is string => typeof value === "string"
  && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(value) && !/\d{5}/.test(value);
export function dependencyBusy(code: number | null | undefined, stderr: string): DependencyBusy | undefined {
  if (code !== 75) return;
  const last = stderr.trimEnd().split("\n").at(-1) ?? "";
  const match = /^busy: ([a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}): (\S[^\r\n]*)$/.exec(last);
  if (!match || !safeDependency(match[1])) return;
  return { dependency: match[1]!, detail: match[2]!.slice(0, 500) };
}

// Keep these patterns and normalization in sync with helpers/toollog.py.
const patterns = [
  ["usage_error", /(?:^|\n)\s*usage:|unrecognized arguments?|unknown (?:option|argument)|invalid (?:option|choice)|argument .*required|not (?:an exact trip UUID|a bridge chat slug)|no bridge chat|unsafe display name|invalid command arguments|duplicate command option|unexpected positional arguments|--[a-z-]+ (?:is required|must be)/i],
  ["missing_file", /no such file or directory|filenotfounderror|\bENOENT\b|command not found|cannot find module|modulenotfounderror/i],
  ["permission", /permission denied|operation not permitted|permissionerror|\b(?:EACCES|EPERM)\b/i],
  ["timeout", /timed? out|timeoutexpired|timeouterror|\bETIMEDOUT\b/i],
  ["auth", /authentication[ _-]*failed|invalid credentials|invalid[_ -]grant|login failed|unauthori[sz]ed|forbidden|HTTP[ :]+(?:401|403)\b/i],
  ["connect", /connection[ _-]*(?:refused|reset|aborted)|\b(?:ECONNREFUSED|ECONNRESET|ENETUNREACH|EHOSTUNREACH|EAI_AGAIN)\b|network is (?:unreachable|down)|no route to host|temporary failure in name resolution|bridge socket is unavailable|bridge request failed/i],
  ["json", /jsondecodeerror|invalid json|json (?:parse|decode) error|unexpected (?:token|end).*json/i],
  ["python_traceback", /traceback \(most recent call last\):/i],
] as const;

/** Retains one line so the summary does not need the full stderr transcript. */
export class StderrCause {
  private line = "";
  private last = "";
  private lastNonempty = "";
  private lines = 0;
  private rank: number = patterns.length;

  add(text: string): void {
    const parts = text.split("\n");
    for (const [i, part] of parts.entries()) {
      const text = this.line + part;
      for (const [rank, [, pattern]] of patterns.entries()) if (pattern.test(text)) this.rank = Math.min(this.rank, rank);
      this.line = text;
      if (i < parts.length - 1) {
        this.lines++;
        this.last = this.line.replace(/\r$/, "");
        if (this.last.trim()) this.lastNonempty = this.last;
        this.line = "";
      }
    }
  }

  busy(code: number | null | undefined): DependencyBusy | undefined {
    return dependencyBusy(code, this.line.trim() ? this.line : this.lastNonempty);
  }

  props(timedOut = false, code?: number | null) {
    const last = this.line || this.last;
    const busy = this.busy(code);
    const normalized = last.replace(/"(?:[A-Za-z]:\\|\/|\.\.?\/|~\/)[^"]*"|'(?:[A-Za-z]:\\|\/|\.\.?\/|~\/)[^']*'|(?:[A-Za-z]:\\|\/|\.\.?\/|~\/)[^\s'"<>]*/g, "<path>")
      .replace(/\d+/g, "#");
    return {
      stderrClass: busy ? "dependency_busy" : timedOut ? "timeout" : patterns[this.rank]?.[0] ?? "unknown",
      ...(busy ? { dependency: busy.dependency } : {}),
      stderrLines: this.lines + (this.line ? 1 : 0),
      stderrHash: createHash("sha256").update(normalized).digest("hex").slice(0, 16),
    };
  }
}

export function stderrCause(text: string, timedOut = false, code?: number | null) {
  const cause = new StderrCause();
  cause.add(text);
  return cause.props(timedOut, code);
}
