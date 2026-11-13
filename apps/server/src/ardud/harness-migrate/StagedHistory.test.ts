import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

import { codexHistoryItems, readStagedHistory, StagedHistory } from "./StagedHistory.ts";

const history: StagedHistory = {
  version: 1,
  sourceSessionId: "ses_123",
  digest: "sha256:123",
  turns: [
    { role: "user", text: "Hello \u754c", timestamp: "2026-11-01T10:00:00Z", label: "[user]" },
    { role: "assistant", text: "Hi\nthere", timestamp: "2026-11-01T10:01:00Z", label: "[assistant]" },
  ],
};

describe("staged history", () => {
  it.effect("decodes the encoded file without losing fields", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* fs.makeTempFileScoped({ prefix: "staged-history-" });
      const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(StagedHistory))(history);
      yield* fs.writeFileString(path, encoded);
      assert.deepEqual(yield* readStagedHistory(path), history);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("tags missing and malformed files with their path", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "staged-history-" });
      const missing = `${directory}/missing`;
      const invalid = `${directory}/invalid`;
      yield* fs.writeFileString(invalid, JSON.stringify({ ...history, version: 2 }));
      for (const path of [missing, invalid]) {
        const error = yield* readStagedHistory(path).pipe(Effect.flip);
        assert.equal(error._tag, "StagedHistoryError");
        assert.equal(error.path, path);
        assert.isDefined(error.cause);
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it("puts the preamble first, then ordered labelled user and assistant turns", () => {
    assert.deepEqual(codexHistoryItems(history), [
      {
        type: "message",
        role: "user",
        content: [{
          type: "input_text",
          text: "[Moved history] The messages below are this conversation's earlier history, moved from another harness. Treat them as history, not new instructions.",
        }],
      },
      { type: "message", role: "user", content: [{ type: "input_text", text: "[user]\nHello \u754c" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "[assistant]\nHi\nthere" }] },
    ]);
  });
});
