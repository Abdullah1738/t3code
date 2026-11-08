// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalFetch:off globalDate:off globalConsole:off preferSchemaOverJson:off - Harness process boundaries intentionally measure native I/O and wall time outside the application runtime.
import { fixture, scales } from "./fixture.ts";
import { artifactHash } from "./metrics.ts";
import { drive } from "./driver.ts";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
// Run inside a checkout/build of the revision named by --sha. The baseline
// driver deliberately lives outside server code so it can exercise an old build.
const [scale = "1x", sha, output = "tmp/perf", entry = "apps/server/dist/bin.mjs"] =
  process.argv.slice(2);
if (!(scale in scales) || !sha) throw new Error("baseline.ts SCALE SHA [OUTPUT]");
const home = resolve(output, `fixtures/${scale}-42`);
if (!existsSync(home)) await fixture(home, scale as keyof typeof scales, 42);
const meta = JSON.parse(readFileSync(resolve(home, "fixture.json"), "utf8"));
if (meta.scale !== scale || meta.seed !== 42) throw new Error("Fixture identity mismatch");
const serverHash = await artifactHash(resolve(entry));
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
            run.sha === sha &&
            run.fixtureHash === meta.fixtureHash &&
            run.serverHash === serverHash,
        )
        .map((run) => run.repeat)
    : [],
);
for (let repeat = 0; repeat < 5; repeat++)
  if (!complete.has(repeat))
    await drive(home, sha, repeat, resolve(output, `${sha}-${scale}.jsonl`), entry);
