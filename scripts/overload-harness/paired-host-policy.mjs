import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";

const auditedForms = new Set([
  "date -u",
  "date",
  "pwd",
  "true",
  "git status --short",
  "git rev-parse HEAD",
  "git diff --stat",
]);
export const classifyCommand = (command) => {
  if (typeof command !== "string") return "unclassified";
  const text = command.trim();
  if (auditedForms.has(text) || /^sleep [0-9]+(?:\.[0-9]+)?$/.test(text)) return "light";
  if (
    [
      "matched-command.sh",
      "/overload-harness/run.mjs",
      "/overload-harness/paired-run.mjs",
      "/overload-harness/latency-run.mjs",
      "--cpu-prof",
      "Profiler.start",
      "sqlite-disk-wait",
    ].some((value) => text.includes(value))
  )
    return "benchmark/sqlite/disk/profiling";
  return "unclassified";
};
if (process.argv[1] === NodeURL.fileURLToPath(import.meta.url)) {
  const commands = JSON.parse(NodeFS.readFileSync(0, "utf8"));
  process.stdout.write(JSON.stringify(commands.map(classifyCommand)) + "\n");
}
