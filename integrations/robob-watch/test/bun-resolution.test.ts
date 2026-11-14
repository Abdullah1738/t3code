import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

test.each([
  { name: "explicit override wins over the home install", override: true, homeInstall: true, runtime: true, pathInstall: true, expected: "override" },
  { name: "home install wins over the running binary", override: false, homeInstall: true, runtime: true, pathInstall: true, expected: "home" },
  { name: "running Bun works without a home install or Bun on PATH", override: false, homeInstall: false, runtime: true, pathInstall: false, expected: "runtime" },
  { name: "running Bun wins over another Bun on PATH", override: false, homeInstall: false, runtime: true, pathInstall: true, expected: "runtime" },
  { name: "PATH resolves Bun when the host is not Bun", override: false, homeInstall: false, runtime: false, pathInstall: true, expected: "path" },
  { name: "missing Bun reports how to select it", override: false, homeInstall: false, runtime: false, pathInstall: false, expected: "missing" },
])("Bun resolution: $name", ({ override, homeInstall, runtime, pathInstall, expected }) => {
  const home = mkdtempSync(join(tmpdir(), "watch-bun-"));
  try {
    const homeBin = join(home, ".bun/bin/bun"), overrideBin = join(home, "custom tools/bun"), pathBin = join(home, "path/bun");
    for (const file of [homeBin, overrideBin, pathBin]) mkdirSync(dirname(file), { recursive: true });
    if (homeInstall) symlinkSync(process.execPath, homeBin);
    if (override) symlinkSync(process.execPath, overrideBin);
    if (pathInstall) symlinkSync(process.execPath, pathBin);
    const program = `
      ${runtime ? "" : "delete process.versions.bun;"}
      const { BUN, PATH } = await import(${JSON.stringify(join(import.meta.dir, "../src/lib.ts"))});
      const child = Bun.spawnSync(["bun", "--version"], { env: { HOME: process.env.HOME, PATH } });
      console.log(JSON.stringify({ bun: BUN, path: PATH, code: child.exitCode, version: child.stdout.toString().trim() }));
    `;
    const child = Bun.spawnSync([process.execPath, "-e", program], { env: {
      HOME: home, PATH: pathInstall ? dirname(pathBin) : "", ROBOB_TEST: "1",
      ROBOB_WATCH_BUN: override ? overrideBin : "",
    } });
    if (expected === "missing") {
      expect(child.exitCode).not.toBe(0);
      expect(child.stderr.toString()).toContain("ROBOB_WATCH_BUN");
      return;
    }
    expect(child.exitCode, child.stderr.toString()).toBe(0);
    const result = JSON.parse(child.stdout.toString());
    const binary = expected === "override" ? overrideBin : expected === "home" ? homeBin : expected === "path" ? pathBin : process.execPath;
    expect(result.bun).toBe(binary);
    expect(result.path.split(":")[2]).toBe(dirname(binary));
    expect(result.code).toBe(0);
    expect(result.version).toBe(Bun.version);
    if (expected === "home") expect(result.path).toBe([
      join(home, ".local/share/robob-watch/helpers"), join(home, ".local/bin"), join(home, ".bun/bin"),
      "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin",
    ].join(":"));
  } finally { rmSync(home, { recursive: true, force: true }); }
});
