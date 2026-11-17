import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, readdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { assertMacWatcher } from "../src/person-box.ts";
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })));
function setup() {
  const root = mkdtempSync(join(tmpdir(), "moni-watch-guard-")); roots.push(root);
  const config = join(root, "bridge.json"); writeFileSync(config, JSON.stringify({ chatBackends: { moni: { kind: "remote-box" } } }));
  return { root, config };
}
function content(root: string): string { return readdirSync(root, { withFileTypes: true }).map(e => e.isDirectory() ? content(join(root, e.name)) : readFileSync(join(root, e.name)).toString()).join(""); }
test("Moni destination refuses while remote, preserves other chats and rollback", () => {
  const s = setup(); expect(() => assertMacWatcher("moni", s.config)).toThrow("on her box");
  expect(() => assertMacWatcher("owner", s.config)).not.toThrow();
  writeFileSync(s.config, '{"chatBackends":{"moni":{"kind":"robob"}}}'); expect(() => assertMacWatcher("moni", s.config)).not.toThrow();
});
test("CLI refuses before saving definition, context, prime output or logs", async () => {
  const s = setup(), canary = randomUUID();
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli.ts"), "add", "--id", "moni-private", "--title", canary,
    "--check", `printf '${canary}'`, "--context", canary, "--chat", "moni"], { env: { ...process.env,
      ROBOB_WATCH_ROOT: join(s.root, "watch"), SPECTRUM_BRIDGE_CONFIG: s.config, TOOLLOG_DIR: join(s.root, "logs"), ROBOB_WATCH_LOG_DIR: join(s.root, "logs") }, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  expect(code).not.toBe(0); expect(out + err).toContain("on her box"); expect(out + err).not.toContain(canary);
  expect(content(s.root)).not.toContain(canary); expect(existsSync(join(s.root, "watch/watchers/moni-private/watcher.json"))).toBe(false);
});
