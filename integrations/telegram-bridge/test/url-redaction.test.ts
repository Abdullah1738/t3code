import { expect, test } from "bun:test";
import { join } from "node:path";
import { redact } from "../src/redact.ts";
import { urlRedactionCases } from "./url-redaction-cases.ts";

test.each(urlRedactionCases)("redacts $label in both layouts", ({ input, expected }) => {
  expect(redact(input)).toBe(expected);
  expect(redact(redact(input))).toBe(expected);
  const legacy = redact(input, true);
  expect(Array.from(legacy)).toHaveLength(Array.from(input).length);
  expect(legacy).not.toContain("SECRET");
  expect(redact(legacy, true)).toBe(legacy);
});

test("URL matrix stays masked through CLI, API, delivery, and the final Telegram transport", () => {
  // Isolate the grammY mock so no other test can restore a real Bot underneath this transport.
  const result = Bun.spawnSync([process.execPath, join(import.meta.dir, "url-redaction-fixture.ts")], {
    env: { PATH: "/usr/bin:/bin", ROBOB_TEST: "1" },
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(JSON.parse(result.stdout.toString()).cases).toBe(urlRedactionCases.length);
});
