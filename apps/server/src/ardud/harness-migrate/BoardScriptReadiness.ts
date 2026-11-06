import type { KanbanScript } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";

export const BOARD_SCRIPT_BYTE_LIMIT = 2 * 1024 * 1024;

// Only running crw counts. Reading its database or naming it in prose/prompts does not.
// The crw binary as an argv[0]: bare, or a path ending in /crw, optionally quoted.
const CRW_BIN = String.raw`["'\`]?(?:[\w./~-]*\/)?crw["'\`]?`;
// crw's own subcommands (crw.mjs `commands`), plus tick/status/review from its
// launcher and older docs. Prose like "crw rules apply" or "| crw state |" names
// no subcommand, so it does not read as a call.
const CRW_SUBCOMMANDS = [
  "sync",
  "dispatch",
  "candidates",
  "ingest",
  "remind",
  "titles",
  "exec",
  "models",
  "missions",
  "hold",
  "release",
  "retry",
  "cancel",
  "events",
  "pending",
  "merit",
  "unlock-pacing",
  "prioritize",
  "pace-skip",
  "mark-deployed",
  "gate-evidence",
  "redeploy",
  "dispatch-reconcile",
  "release-unblock",
  "tick",
  "status",
  "review",
].join("|");
// A subcommand after it, either as a shell word or the next (quoted) argv element.
const CRW_ARGS = String.raw`(?:\s+|["'\`]?\s*,\s*\[?\s*["'\`])(?:${CRW_SUBCOMMANDS})\b`;
const CRW_INVOCATION: ReadonlyArray<RegExp> = [
  /\bcrw\.mjs\b/,
  // crw's launcher and LaunchAgent.
  /\bcrw\/tick\.zsh\b/,
  /\bcom\.crpko\.review-workflow\b/,
  // reader.mjs is crw's read-only GitHub/architecture reader; it starts no agents. Paths into
  // the repo only count when something executes them, not when prose names a file.
  /(?:\b(?:node|bun|deno|python3?|bash|zsh|sh|tsx|npx)\s+|\b(?:import|require)\s*\(?\s*["'`])[\w./~-]*crpko-review-workflow\/(?!reader\.mjs\b)[\w./-]*\.(?:mjs|ts|py|sh|js)\b/,
  // Shell: a line or pipeline segment that starts with crw, allowing leading
  // whitespace and command prefixes (exec, timeout N, nohup, env, sudo).
  new RegExp(
    String.raw`(?:^|[;&|]|\$\(|\s-l?c\s+["'])[ \t]*(?:(?:exec|nohup|sudo|command|time|(?:\/usr\/bin\/)?env|timeout\s+\d+[smh]?)\s+)*${CRW_BIN}${CRW_ARGS}`,
    "m",
  ),
  // Process APIs: the call must open a paren (or Bun's $ template) right before crw.
  new RegExp(
    String.raw`(?:\b(?:exec|execSync|execFile|execFileSync|execa|execaSync|spawn|spawnSync|system|run|popen|Popen|check_output|check_call|call|create_subprocess_exec|create_subprocess_shell)\s*\(\s*\[?\s*|\$\`\s*)${CRW_BIN}${CRW_ARGS}`,
  ),
  // argv lists built first and run later: ["crw", "tick"].
  new RegExp(
    String.raw`\[\s*["'\`](?:[\w./~-]*\/)?crw["'\`]\s*,\s*["'\`](?:${CRW_SUBCOMMANDS})["'\`]`,
  ),
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
