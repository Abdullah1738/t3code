// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalConsole:off preferSchemaOverJson:off - Offline synthetic benchmark controller.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { drive } from "./driver.ts";
import { appendLedger, fileHash, hash, type Run } from "./metrics.ts";
import { compare } from "./compare.ts";

const [home, baseSha, baseEntry, candidateSha, candidateEntry, directory, count = "10"] =
  process.argv.slice(2);
const pairs = Number(count);
if (
  !directory ||
  !home ||
  !baseSha ||
  !baseEntry ||
  !candidateSha ||
  !candidateEntry ||
  !Number.isInteger(pairs) ||
  pairs < 10
)
  throw new Error(
    "paired.ts FIXTURE BASE_SHA BASE_ENTRY CANDIDATE_SHA CANDIDATE_ENTRY OUTPUT [PAIRS>=10]",
  );
const output = resolve(directory);
if (
  ["base.jsonl", "candidate.jsonl", "pairs.jsonl"].some((name) => existsSync(`${output}/${name}`))
)
  throw new Error("Output already contains a paired experiment; choose a new directory");
const controllerHash = hash(
  await Promise.all(
    ["driver.ts", "sampler.ts", "network.ts", "process.ts", "host.ts", "paired.ts"].map((name) =>
      fileHash(new URL(name, import.meta.url).pathname),
    ),
  ),
);
const revisions = [
  { sha: baseSha, entry: baseEntry },
  { sha: candidateSha, entry: candidateEntry },
];
const accepted: Run[][] = [[], []];
for (let pair = 0; pair < pairs; pair++) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const pending: Run[] = [];
    let reason: string | undefined;
    for (const index of pair % 2 ? [1, 0] : [0, 1]) {
      const revision = revisions[index]!;
      const started = Date.now();
      try {
        const run = await drive(
          home,
          revision.sha,
          pair,
          `${output}/attempts-${index}.jsonl`,
          revision.entry,
          controllerHash,
        );
        pending[index] = run;
        appendLedger(`${output}/commands.jsonl`, {
          pair,
          attempt,
          ...revision,
          exit: 0,
          elapsedMs: Date.now() - started,
          host: run.host,
        });
        if (!run.host) throw new Error("Linux host counters required");
        if (run.host.stealPct > 15) reason = "steal >15%";
      } catch (error) {
        appendLedger(`${output}/commands.jsonl`, {
          pair,
          attempt,
          ...revision,
          exit: 1,
          error: String(error),
        });
        if ((error as { code?: string }).code !== "PERF_PREPARATION_FLUSH_FAILED") throw error;
        reason = "preparation flush failed";
        break;
      }
    }
    appendLedger(`${output}/pairs.jsonl`, {
      pair,
      attempt,
      dropped: reason !== undefined,
      reason: reason ?? null,
    });
    if (reason) {
      if (attempt === 4) throw new Error(`Pair ${pair} repeatedly unsuitable: ${reason}`);
      continue;
    }
    pending.forEach((run, index) => {
      accepted[index]!.push(run);
      appendLedger(`${output}/${index ? "candidate" : "base"}.jsonl`, run);
    });
    console.log(`Pair ${pair + 1}/${pairs} accepted`);
    break;
  }
}
const result = compare(
  accepted[0]!,
  accepted[1]!,
  JSON.parse(readFileSync(new URL("../budgets.json", import.meta.url), "utf8")),
  pairs,
);
writeFileSync(`${output}/comparison.json`, JSON.stringify(result, null, 2) + "\n");
console.log(result.performanceVerdict, result.budgetVerdict);
if (result.budgetVerdict !== "pass") process.exitCode = 1;
