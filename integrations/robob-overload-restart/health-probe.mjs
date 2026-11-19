import { ControlClient } from "./control/client.mjs";
import { deepHealth, healthLine } from "./control/deep-health.mjs";

// No detached helper: this whole probe belongs to the supervised restart group.
const report = await deepHealth({ client: new ControlClient({ component: "t3ctl" }), timeoutMs: 30_000 });
process.stdout.write(`${healthLine(report)}\n${JSON.stringify(report)}\n`, () => process.exit(report.exitCode ?? 2));
