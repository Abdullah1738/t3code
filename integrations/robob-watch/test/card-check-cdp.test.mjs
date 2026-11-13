import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";

test("findChrome uses its override or Robob, never the old Playwright cache", () => {
  const home = mkdtempSync(join(tmpdir(), "card-check-test-"));
  try {
    // Bun caches os.homedir(); the sandbox HOME must be set before the process starts.
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", `
      import assert from "node:assert/strict";
      import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
      import { dirname, join } from "node:path";
      import { findChrome } from ${JSON.stringify(new URL("../helpers/card-check/cdp.mjs", import.meta.url).href)};
      const home = process.env.HOME;
  const touch = (path, executable = true) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "");
    chmodSync(path, executable ? 0o755 : 0o644);
    return path;
  };
    touch(join(home, "Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-arm64/chrome-headless-shell"));
    assert.equal(findChrome({}), null);
    assert.equal(findChrome({ CARD_CHECK_CHROME: "/override" }), "/override");
    const robob = join(home, ".robob/tools/chrome-headless-shell/mac-arm64");
    touch(join(robob, "9.0.1/chrome-headless-shell"));
    touch(join(robob, "10.0.0/chrome-headless-shell"));
    const newest = touch(join(robob, "154.0.8037.92/chrome-headless-shell"));
    touch(join(robob, "999.0.0/chrome-headless-shell"), false);
    assert.equal(findChrome({}), newest);
    assert.equal(findChrome({ CARD_CHECK_CHROME: "/override" }), "/override");

    `], { env: { ...process.env, HOME: home }, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
