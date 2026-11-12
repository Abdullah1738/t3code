import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("Swift widget action executor, journal and HTTP client", { skip: process.platform !== "darwin" }, () => {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const paths = [
    "../ios/Widgets/Model.swift",
    "../ios/Widgets/ActionJournal.swift",
    "../ios/Widgets/Client.swift",
    "../ios/Widgets/ActionExecutor.swift",
    "./widget-client/ActionExecutorTests.swift",
  ];
  const source = paths.map((path) => readFileSync(new URL(path, import.meta.url), "utf8")).join("\n");
  execFileSync("/usr/bin/swift", ["-"], {
    cwd: here,
    input: source,
    stdio: ["pipe", "inherit", "inherit"],
    timeout: 120_000,
  });
});
