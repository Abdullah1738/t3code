import { createHash } from "node:crypto";

// Keep these patterns and normalization in sync with helpers/toollog.py.
const patterns = [
  ["usage_error", /(?:^|\n)\s*usage:|unrecognized arguments?|unknown (?:option|argument)|invalid (?:option|choice)|argument .*required|not (?:an exact trip UUID|a bridge chat slug)|no bridge chat|unsafe display name/i],
  ["missing_file", /no such file or directory|filenotfounderror|\bENOENT\b/i],
  ["permission", /permission denied|operation not permitted|permissionerror|\b(?:EACCES|EPERM)\b/i],
  ["timeout", /timed? out|timeoutexpired|timeouterror|\bETIMEDOUT\b/i],
  ["python_traceback", /traceback \(most recent call last\):/i],
] as const;

/** Retains one line so the summary does not need the full stderr transcript. */
export class StderrCause {
  private line = "";
  private last = "";
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
        this.line = "";
      }
    }
  }

  props(timedOut = false) {
    const last = this.line || this.last;
    const normalized = last.replace(/"(?:[A-Za-z]:\\|\/|\.\.?\/|~\/)[^"]*"|'(?:[A-Za-z]:\\|\/|\.\.?\/|~\/)[^']*'|(?:[A-Za-z]:\\|\/|\.\.?\/|~\/)[^\s'"<>]*/g, "<path>")
      .replace(/\d+/g, "#");
    return {
      stderrClass: timedOut ? "timeout" : patterns[this.rank]?.[0] ?? "unknown",
      stderrLines: this.lines + (this.line ? 1 : 0),
      stderrHash: createHash("sha256").update(normalized).digest("hex").slice(0, 16),
    };
  }
}

export function stderrCause(text: string, timedOut = false) {
  const cause = new StderrCause();
  cause.add(text);
  return cause.props(timedOut);
}
