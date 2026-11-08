// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalFetch:off globalDate:off globalConsole:off preferSchemaOverJson:off - Harness process boundaries intentionally measure native I/O and wall time outside the application runtime.
import { fixture, scales } from "./fixture.ts";
import { artifactHash, appendLedger, hash, fileHash } from "./metrics.ts";
import { drive } from "./driver.ts";
import { existsSync, readFileSync } from "node:fs";
import { cpus, totalmem, platform, arch } from "node:os";
import { resolve } from "node:path";
// Run inside a checkout/build of the revision named by --sha. The baseline
// driver deliberately lives outside server code so it can exercise an old build.
const [
  scale = "1x",
  sha,
  output = "tmp/perf",
  entry = "apps/server/dist/bin.mjs",
  fixtureDirectory,
] = process.argv.slice(2);
if (!(scale in scales) || !sha) throw new Error("baseline.ts SCALE SHA [OUTPUT]");
if (!existsSync(entry)) throw new Error(`Missing server artifact: ${entry}`);
const home = fixtureDirectory ? resolve(fixtureDirectory) : resolve(output, `fixtures/${scale}-42`);
if (!existsSync(home)) await fixture(home, scale as keyof typeof scales, 42);
const meta = JSON.parse(readFileSync(resolve(home, "fixture.json"), "utf8"));
if (meta.scale !== scale || meta.seed !== 42) throw new Error("Fixture identity mismatch");
const serverHash = await artifactHash(resolve(entry));
const harnessHash = hash([
  process.env.ROBOB_PERF_LEGACY_BURST === "1" ? "legacy-burst" : "steady",
  await Promise.all(
    ["driver.ts", "sampler.ts", "network.ts", "process.ts"].map((name) =>
      fileHash(resolve("packages/perf-harness/src", name)),
    ),
  ),
]);
const runtimeHash = hash({ node: process.version, sqlite: process.versions.sqlite });
const hardwareHash = hash({
  cpu: cpus()[0]?.model,
  count: cpus().length,
  totalmem: totalmem(),
  platform: platform(),
  arch: arch(),
});
const ledger = resolve(output, `${sha}-${scale}.jsonl`);
const complete = new Set(
  existsSync(ledger)
    ? readFileSync(ledger, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter(
          (run) =>
            run.status !== "failed" &&
            run.harnessHash === harnessHash &&
            run.runtimeHash === runtimeHash &&
            run.hardwareHash === hardwareHash &&
            run.sha === sha &&
            run.fixtureHash === meta.fixtureHash &&
            run.serverHash === serverHash,
        )
        .map((run) => run.repeat)
    : [],
);
let failures = 0;
for (let repeat = 0; repeat < 10; repeat++)
  if (!complete.has(repeat)) {
    try {
      await drive(home, sha, repeat, ledger, entry, harnessHash);
    } catch (error) {
      failures++;
      console.error(`Repeat ${repeat} failed:`, error);
      appendLedger(ledger, {
        sha,
        serverHash,
        harnessHash,
        repeat,
        fixtureHash: meta.fixtureHash,
        seed: 42,
        scale,
        agents: meta.agents,
        runtimeHash: hash({ node: process.version, sqlite: process.versions.sqlite }),
        hardwareHash: hash({
          cpu: cpus()[0]?.model,
          count: cpus().length,
          totalmem: totalmem(),
          platform: platform(),
          arch: arch(),
        }),
        correctness: "unmeasured",
        status: "failed",
        metrics: {},
        gaps: [String(error)],
      });
    }
  }

if (failures) process.exitCode = 1;
