import { join } from "node:path";

type Result = { ok: boolean; via: string };
export const isHealthNag = (id: string) => ["meds-nag", "nutrition-nudge", "gym-nudge"].includes(id);

export async function recordHealthDelivery(id: string, run: string | undefined, result: Result): Promise<void> {
  if (!isHealthNag(id) || !run || !/^[a-f0-9]{32}$/.test(run)) return;
  // A queued wake has not sent the owner's nudge; leave it unmarked until that send is acknowledged.
  if (result.ok && result.via.startsWith("wake")) return;
  try {
    const child = Bun.spawn(["/usr/bin/python3", join(import.meta.dir, "../health_delivery.py"), id, run,
      result.ok ? "ok" : "fail"], { env: process.env, stdout: "ignore", stderr: "ignore", timeout: 2000, killSignal: "SIGKILL" });
    await child.exited;
  } catch { /* Diagnostics cannot change delivery or retries. */ }
}
