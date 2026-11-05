import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { ArdudHarnessMigrationSettings, DEFAULT_SERVER_SETTINGS } from "../settings.ts";

describe("compact harness switch settings", () => {
  const decode = Schema.decodeUnknownSync(ArdudHarnessMigrationSettings);

  it("leaves old settings off and accepts a thread-scoped pilot", () => {
    expect(DEFAULT_SERVER_SETTINGS.ardudHarnessMigration).toBeUndefined();
    expect(decode({})).toEqual({});
    expect(
      decode({
        selections: "off",
        threadIds: ["thread:pilot"],
        transcript: { enabled: true, lastTurns: 8 },
      }),
    ).toEqual({
      selections: "off",
      threadIds: ["thread:pilot"],
      transcript: { enabled: true, lastTurns: 8 },
    });
  });

  it.each([0, -1, 1.5, 33])("refuses an unbounded/invalid lastTurns %s", (lastTurns) => {
    expect(() => decode({ transcript: { enabled: true, lastTurns } })).toThrow();
  });
});
