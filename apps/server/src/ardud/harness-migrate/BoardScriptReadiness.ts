import type { KanbanScript } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";

export const BOARD_SCRIPT_BYTE_LIMIT = 2 * 1024 * 1024;

// Only running crw counts. Reading its database or naming it in prose/prompts does not.
const CRW_INVOCATION: ReadonlyArray<RegExp> = [
  /\bcrw\.mjs\b/,
  // reader.mjs is crw's read-only GitHub/architecture reader; it starts no agents.
  /crpko-review-workflow\/(?!reader\.mjs\b)[\w./-]*\.(?:mjs|ts|py|sh)\b/,
  /(?:^|[;&|(]\s*|\b(?:exec|execSync|execFile|spawn|spawnSync|system|run|popen|check_output|call)\s*\(?\s*\[?\s*["'`]?)(?:[\w./~-]*\/)?crw\s*["'`]?\s*,?\s*["'`]?[a-z][\w-]*/m,
];

export const boardScriptDependencyProblem = (text: string): string | null => {
  if (/\b(?:crpko-reviewer|lean-reviewer)\b/.test(text)) return "OpenCode reviewer dependency";
  const selector =
    /["'`]?\b(?:agent|subagent_type|agent_type)["'`]?\s*[=:]\s*["'`]([\w./-]+)["'`]/i.exec(text) ??
    /\b(?:agent|subagent)\s+(?:named\s+)?["'`]([\w./-]+)["'`]/i.exec(text) ??
    /\b(?:subagent_type|agent_type)\s*[=:]\s*([\w./-]+)/i.exec(text);
  if (selector) return `Unverified named-agent selector ${selector[1]}`;
  if (/(?:\.config\/opencode\/agents\/|opencode\s+(?:run|agent)\b[^\n]*--agent\b)/i.test(text))
    return "Direct OpenCode agent configuration";
  if (CRW_INVOCATION.some((pattern) => pattern.test(text)))
    return "External crw coordinator dependency has not been verified as native";
  return null;
};

export const checkBoardScripts = Effect.fn("HarnessCutover.checkBoardScripts")(function* (
  scripts: ReadonlyArray<KanbanScript>,
) {
  const fs = yield* FileSystem.FileSystem;
  const refusals: Array<{ ref: string; reason: string }> = [];
  for (const script of scripts) {
    const read = yield* Effect.gen(function* () {
      const info = yield* fs.stat(script.path);
      if (info.type !== "File" || Number(info.size) > BOARD_SCRIPT_BYTE_LIMIT)
        return { problem: "Not a regular script file within the 2 MiB scan limit" };
      // Bound the actual read too, in case the file grows after stat.
      const chunks = yield* fs
        .stream(script.path, { bytesToRead: BOARD_SCRIPT_BYTE_LIMIT + 1 })
        .pipe(Stream.runCollect);
      const bytes = Buffer.concat(chunks);
      return {
        problem:
          bytes.length > BOARD_SCRIPT_BYTE_LIMIT
            ? "Script grew beyond the 2 MiB scan limit"
            : boardScriptDependencyProblem(bytes.toString("utf8")),
      };
    }).pipe(Effect.result);
    const problem =
      read._tag === "Failure" ? "Registered script is unreadable" : read.success.problem;
    if (problem !== null)
      refusals.push({
        ref: `${script.boardId}:script:${script.id}`,
        reason: `${problem}: ${script.path}. Update or verify this coordinator source before cutover; no script source was changed. Only the registered entry file was scanned, not recursive imports.`,
      });
  }
  return refusals;
});
