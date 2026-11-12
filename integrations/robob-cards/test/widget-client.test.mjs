import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("Swift widget JSON models and client", { skip: process.platform !== "darwin" }, () => {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const paths = [
    "../ios/Widgets/Model.swift",
    "../ios/Widgets/Client.swift",
    "../ios/Widgets/WidgetSchedule.swift",
    "./widget-client/WidgetClientTests.swift",
  ];
  const source = paths.map((path) => readFileSync(new URL(path, import.meta.url), "utf8")).join("\n");
  execFileSync("/usr/bin/swift", ["-"], { cwd: here, input: source, stdio: ["pipe", "inherit", "inherit"], timeout: 120_000 });
});
