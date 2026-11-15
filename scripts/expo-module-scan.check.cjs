const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");

const repo = path.resolve(__dirname, "..");
const expo = path.dirname(
  require.resolve("expo/package.json", { paths: [path.join(repo, "apps/mobile")] }),
);
const autolinking = path.dirname(
  require.resolve("expo-modules-autolinking/package.json", { paths: [expo] }),
);
const { scanExpoModulesAsync } = require(
  path.join(autolinking, "build/platforms/apple/moduleScanner.js"),
);

test("the installed built scanner waits for a six-second scan by default", async () => {
  const previous = process.env.EXPO_MODULE_SCAN_TIMEOUT_MS;
  delete process.env.EXPO_MODULE_SCAN_TIMEOUT_MS;
  try {
    const output = { schemaVersion: 1, modules: [], warnings: [], stats: {} };
    const started = Date.now();
    const result = await scanExpoModulesAsync(
      {
        scanModules: (_, { timeout }) =>
          new Promise((resolve, reject) => {
            const deadline = setTimeout(
              () => reject(new Error(`timed out after ${timeout} ms`)),
              timeout,
            );
            setTimeout(() => {
              clearTimeout(deadline);
              resolve(output);
            }, 6000);
          }),
      },
      { example: "/example" },
    );
    assert.equal(result, output);
    console.log(`Six-second fake scan passed in ${Date.now() - started} ms`);
  } finally {
    if (previous === undefined) delete process.env.EXPO_MODULE_SCAN_TIMEOUT_MS;
    else process.env.EXPO_MODULE_SCAN_TIMEOUT_MS = previous;
  }
});

test("timeout override accepts positive timer integers and safely defaults for invalid inputs", async () => {
  const previous = process.env.EXPO_MODULE_SCAN_TIMEOUT_MS;
  try {
    for (const [value, expected] of [
      [undefined, 120000],
      ["", 120000],
      ["60000", 60000],
      ["240000", 240000],
      ["1", 1],
      ["2147483647", 2147483647],
      [" 60000 ", 60000],
      ["1e5", 100000],
      ["0", 120000],
      ["-1", 120000],
      ["NaN", 120000],
      ["Infinity", 120000],
      ["1.5", 120000],
      ["2147483648", 120000],
      ["garbage", 120000],
    ]) {
      if (value === undefined) delete process.env.EXPO_MODULE_SCAN_TIMEOUT_MS;
      else process.env.EXPO_MODULE_SCAN_TIMEOUT_MS = value;
      let observedTimeout;
      const output = { warnings: [] };
      const result = await scanExpoModulesAsync(
        {
          scanModules: async (_, { timeout }) => {
            observedTimeout = timeout;
            return output;
          },
        },
        { example: "/example" },
      );
      assert.equal(result, output);
      assert.equal(observedTimeout, expected, `override: ${JSON.stringify(value)}`);
    }
  } finally {
    if (previous === undefined) delete process.env.EXPO_MODULE_SCAN_TIMEOUT_MS;
    else process.env.EXPO_MODULE_SCAN_TIMEOUT_MS = previous;
  }
});

test("device build refuses success for scan diagnostics from pod install or Xcode, tool failures, and log-read failures", () => {
  // Run the whole script with inert build tools; the production guard is never extracted or copied.
  for (const [
    name,
    log,
    podExit,
    grepExit,
    passes,
    xcodeLog = "",
    xcodeExit = 0,
    compiled = passes,
  ] of [
    [
      "warning",
      "warning: Scanning for Expo modules failed, only config modules linked",
      0,
      null,
      false,
    ],
    ["error", "error: Scanning for @ExpoModule classes didn't complete", 0, null, false],
    [
      "both",
      "Scanning for Expo modules failed\nScanning for @ExpoModule classes didn't complete",
      0,
      null,
      false,
    ],
    ["pod-failure", "", 7, null, false],
    ["unreadable-log", "", 0, 2, false],
    ["xcode-warning", "", 0, null, false, "warning: Scanning for Expo modules failed", 0, true],
    [
      "xcode-error",
      "",
      0,
      null,
      false,
      "error: Scanning for @ExpoModule classes didn't complete",
      0,
      true,
    ],
    [
      "xcode-both",
      "",
      0,
      null,
      false,
      "Scanning for Expo modules failed\nScanning for @ExpoModule classes didn't complete",
      0,
      true,
    ],
    ["xcode-failure", "", 0, null, false, "", 65, true],
    ["xcode-unreadable-log", "", 0, "xcode", false, "", 0, true],
    ["clean", "Pod installation complete!", 0, null, true],
    ["empty-log", "", 0, null, true],
  ]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "expo-build-guard-"));
    try {
      const write = (file, text) => {
        fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        fs.writeFileSync(path.join(root, file), text, { mode: 0o755 });
      };
      write(".nvm/nvm.sh", "nvm() { return 0; }\n");
      write("node_modules/.bin/vp", "#!/bin/sh\nexit 0\n");
      write("bin/pod", '#!/bin/sh\nprintf "%s\\n" "$FIXTURE_LOG"\nexit "$POD_EXIT"\n');
      write(
        "bin/xcodebuild",
        '#!/bin/sh\ntouch "$HOME/compiled"\nprintf "%s\\n" "$XCODE_LOG"\nexit "$XCODE_EXIT"\n',
      );
      if (grepExit === "xcode")
        write(
          "bin/grep",
          '#!/bin/sh\nif [ "$3" = "tmp/build/logs/xcodebuild.log" ]; then exit 2; fi\nexec /usr/bin/grep "$@"\n',
        );
      else if (grepExit !== null) write("bin/grep", `#!/bin/sh\nexit ${grepExit}\n`);
      fs.mkdirSync(path.join(root, "apps/mobile/ios/Robob.xcworkspace"), { recursive: true });
      const result = spawnSync(
        "zsh",
        [
          "-f",
          process.env.IOS_DEVICE_BUILD_SCRIPT || path.join(repo, "scripts/build-ios-device.zsh"),
          "fork",
        ],
        {
          cwd: root,
          encoding: "utf8",
          env: {
            ...process.env,
            HOME: root,
            ZDOTDIR: root,
            PATH: `${root}/bin:${process.env.PATH}`,
            FIXTURE_LOG: log,
            POD_EXIT: String(podExit),
            XCODE_LOG: xcodeLog,
            XCODE_EXIT: String(xcodeExit),
          },
        },
      );
      assert.equal(result.status === 0, passes, `${name}: ${result.stderr}`);
      assert.equal(result.stdout.includes("BUILD-OK"), passes, name);
      assert.equal(fs.existsSync(path.join(root, "compiled")), compiled, name);
      if (podExit === 0 && xcodeExit === 0 && !passes)
        assert.match(result.stderr, /ERROR:.*refusing/);
      console.log(`${name}: exit ${result.status}, xcodebuild ${compiled ? "reached" : "blocked"}`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});
