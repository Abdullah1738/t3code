import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMPONENT_TOKEN_FILE, discoverControlConfig } from "../src/control.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const tokenFile = (name: string, token: string, mode = 0o600) => {
  const dir = mkdtempSync(join(tmpdir(), "telegram-control-"));
  dirs.push(dir);
  const file = join(dir, name);
  writeFileSync(file, JSON.stringify({ url: "http://127.0.0.1:14033", token }));
  chmodSync(file, mode);
  return file;
};

test("control config reads the bridge's own component credential by default", () => {
  expect(COMPONENT_TOKEN_FILE.endsWith(join(".robob", "components", "telegram-bridge.json"))).toBe(true);
});

test("control config skips a missing token file and uses the next one", () => {
  const next = tokenFile("next.json", "next");
  expect(discoverControlConfig({ tokenFile: join(tmpdir(), "missing-telegram.json"), env: { T3_CONTROL_TOKEN_FILE: next } }))
    .toEqual({ url: "http://127.0.0.1:14033", token: "next" });
});

test("control config refuses a token file others can read", () => {
  const loose = tokenFile("loose.json", "loose", 0o644);
  expect(() => discoverControlConfig({ env: { T3_CONTROL_TOKEN_FILE: loose } })).toThrow("chmod 600");
});

test("control config takes env credentials before any file", () => {
  const file = tokenFile("file.json", "file");
  expect(discoverControlConfig({ env: { T3_CONTROL_URL: "http://localhost:1/", T3_CONTROL_TOKEN: "env", T3_CONTROL_TOKEN_FILE: file } }))
    .toEqual({ url: "http://localhost:1", token: "env" });
});
