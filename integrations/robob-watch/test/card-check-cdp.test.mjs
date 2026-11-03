import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { findChrome } from "../helpers/card-check/cdp.mjs";

test("findChrome uses its override or Robob, never the old Playwright cache", () => {
  const home = mkdtempSync(join(tmpdir(), "card-check-test-"));
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  const touch = (path, executable = true) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "");
    chmodSync(path, executable ? 0o755 : 0o644);
    return path;
  };
  try {
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
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
});
