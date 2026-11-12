import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import {
  allocateAction,
  markAction,
  setActionTelemetrySink,
  startAction,
} from "./actionTelemetry.ts";
it("observing an action cannot fail when an exporter throws or browser crypto is absent", () => {
  setActionTelemetrySink(() => {
    throw new Error("export failure");
  });
  try {
    const action = startAction("test");
    assert.isString(action.id);
    markAction(action, "state-ready");
  } finally {
    setActionTelemetrySink();
  }
});
it.effect("uses the configured cross-platform crypto service", () =>
  Effect.gen(function* () {
    const action = yield* allocateAction("test");
    assert.equal(action.id, "00000000-0000-4000-8000-000000000000");
  }).pipe(
    Effect.provideService(
      Crypto.Crypto,
      Crypto.make({
        randomBytes: (size) => new Uint8Array(size),
        digest: (_algorithm, data) => Effect.succeed(data),
      }),
    ),
  ),
);

it("carries an RPC id into a host paint callback and cancels stale renders", async () => {
  const { bindActionValue, carryActionValue, paintActionValue } = await import("./actionTelemetry.ts");
  const marks: string[] = [];
  setActionTelemetrySink(mark => marks.push(`${mark.actionId}:${mark.phase}`));
  try {
    const action = startAction("kanban.subscribe", "opaque-board-action");
    const response = {}, rendered = {};
    bindActionValue(response, action);
    carryActionValue(response, rendered);
    let callback = () => {};
    const cancel = paintActionValue(rendered, "board-painted", next => {
      callback = next;
      return () => { callback = () => {}; };
    });
    cancel();
    callback();
    assert.equal(marks.length, 1);
    paintActionValue(rendered, "board-painted", next => { next(); return () => {}; });
    assert.equal(marks[1], "opaque-board-action:board-painted");
    paintActionValue(rendered, "board-painted", next => { next(); return () => {}; });
    assert.equal(marks.length, 2);
  } finally { setActionTelemetrySink(); }
});
