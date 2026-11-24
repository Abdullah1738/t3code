import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { textingStyle } from "../../spectrum-bridge/src/texting-style.ts";
import { loadRunnerConfig } from "../src/main.ts";
import { MONI_PERSONALITY, moniSystemPrompt } from "../src/prompt.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });

const BASE = "Chat: a direct chat with Moni (slug moni).\nPreferences: read /home/user/person/prefs/moni-prefs.md.\nOnly this box; never the owner's Mac.";

function config(system: string) {
  const root = mkdtempSync(join(tmpdir(), "moni-prompt-")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const file = (name: string, value = "x") => { const path = join(root, name); writeFileSync(path, value); return path; };
  const path = file("config.json", JSON.stringify({ tokenFile: file("t"), callbackTokenFile: file("c"), privateKeyFile: file("k"),
    systemFile: file("system.txt", system), harness: "antigravity", antigravity: "/opt/agy" }));
  return loadRunnerConfig(path);
}

test("the loaded system prompt keeps the box's systemFile and adds the personality and 22 Nov texting style", () => {
  const { system } = config(`${BASE}\n`);
  expect(system.startsWith(BASE)).toBe(true);
  expect(system).toContain(MONI_PERSONALITY);
  // The runner turns final turn text into her reply, so the final-mode style applies, not imessage_send.
  expect(system).toContain(textingStyle({ replyMode: "final" }));
  expect(system).not.toContain("imessage_send");
  expect(system.endsWith(textingStyle({ replyMode: "final" }))).toBe(true);
});

test("the personality speaks of Moni, not the owner, and stays out of agent-bus messages", () => {
  expect(MONI_PERSONALITY).not.toMatch(/\b(he|him|his)\b/i);
  expect(MONI_PERSONALITY).toContain("not agent-bus messages");
});

test("an empty systemFile still gets the voice rules without a leading gap", () => {
  const system = moniSystemPrompt("  \n");
  expect(system.startsWith(MONI_PERSONALITY)).toBe(true);
  expect(system.endsWith(textingStyle({ replyMode: "final" }))).toBe(true);
});
