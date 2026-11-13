import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("installer preserves existing definitions and copies files without loading anything", async () => {
  const root = await mkdtemp(join(tmpdir(), "robob-widgets-install-test-"));
  const pkg = join(root, "package"), home = join(root, "home"), live = join(home, "custom-widgets");
  try {
    for (const sub of ["bin", "lib", "sources", "widgets", "launchd"]) await mkdir(join(pkg, sub), { recursive: true });
    await mkdir(join(live, "widgets"), { recursive: true });
    await copyFile(new URL("../install.zsh", import.meta.url), join(pkg, "install.zsh"));
    for (const [file, data] of Object.entries({
      "bin/robob-widgets": "entry", "lib/server.mjs": "lib-v1", "sources/macros.py": "source-v1",
      "widgets/macros.json": "packaged", "widgets/crpko-native-v1.json": "board",
      "launchd/com.ardud.robob-widgets.plist": "plist",
    })) await writeFile(join(pkg, file), data);
    await writeFile(join(live, "widgets", "macros.json"), "customised");
    await writeFile(join(live, "widgets", "extra.json"), "agent-added");
    const env = { ...process.env, HOME: home, ROBOB_WIDGETS_HOME: live };
    const script = join(pkg, "install.zsh");
    execFileSync("/bin/zsh", [script, "--dry-run"], { env });
    await assert.rejects(stat(join(live, "bin", "robob-widgets")), { code: "ENOENT" });
    execFileSync("/bin/zsh", [script], { env });
    assert.equal(await readFile(join(live, "widgets", "macros.json"), "utf8"), "customised");
    assert.equal(await readFile(join(live, "widgets", "extra.json"), "utf8"), "agent-added");
    assert.equal(await readFile(join(live, "widgets", "crpko-native-v1.json"), "utf8"), "board");
    assert.equal(await readFile(join(home, "Library/LaunchAgents/com.ardud.robob-widgets.plist"), "utf8"), "plist");
    assert.ok((await stat(join(home, "Library/Logs/robob-widgets"))).isDirectory());
    await writeFile(join(pkg, "widgets", "crpko-native-v1.json"), "new-package");
    await writeFile(join(pkg, "lib", "server.mjs"), "lib-v2");
    execFileSync("/bin/zsh", [script], { env });
    assert.equal(await readFile(join(live, "widgets", "crpko-native-v1.json"), "utf8"), "board");
    assert.equal(await readFile(join(live, "lib", "server.mjs"), "utf8"), "lib-v2");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
