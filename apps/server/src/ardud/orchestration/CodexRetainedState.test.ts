import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { TestClock } from "effect/testing";
import {
  CODEX_RETAINED_STATE_IDLE_CAP_MS,
  make,
  makeCodexRetainedItems,
} from "./CodexRetainedState.ts";

const output = (call: string, text: unknown) => ({
  type: "custom_tool_call_output",
  call_id: call,
  output: text,
});
const yielded = "Script running with cell ID g2142:27\nOutput:\n";
const session = JSON.stringify({ chunk_id: "chunk", session_id: 90878, output: "" });
const wait = {
  type: "function_call",
  call_id: "wait-1",
  name: "functions.wait",
  arguments: JSON.stringify({ cell_id: "g2142:27" }),
};

describe("Codex retained items", () => {
  it.each([
    yielded,
    [{ type: "input_text", text: yielded }],
    JSON.stringify([{ type: "input_text", text: yielded }]),
  ])("names yielded cells and pending nested calls (%j)", (body) => {
    const state = makeCodexRetainedItems();
    state.observe(output("exec-1", body));
    state.observeNested({
      id: "exec-inner",
      tool: "delegate_task",
      status: "inProgress",
      arguments: { clientRequestId: "mac84-precommit-review-1" },
    });
    const loss = state.takeLoss()!;
    assert.include(loss, "g2142:27");
    assert.include(loss, "delegate_task clientRequestId=mac84-precommit-review-1");
    assert.include(loss, "may or may not have run");
    assert.isUndefined(state.takeLoss());
  });
  it.each([
    session,
    [{ type: "input_text", text: session }],
    JSON.stringify([{ type: "input_text", text: session }]),
  ])("retains exec sessions across output representations (%j)", (body) => {
    const state = makeCodexRetainedItems();
    state.observe(output("exec-1", body));
    assert.isTrue(state.hasItems());
    assert.include(state.takeLoss()!, "90878");
  });
  const batch = [
    {
      chunk_id: "one",
      session_id: 90878,
      output: 'Script running with cell ID fake:1\n{"chunk_id":"fake","session_id":999}',
    },
    { chunk_id: "two", session_id: "33163", output: "" },
  ];
  const batches = [
    batch,
    batch.map((value) => ({ status: "fulfilled", value })),
    batch.map((value, i) => ({ i, result: { status: "fulfilled", value } })),
  ];
  it.each(
    batches.flatMap((receipts) =>
      [
        receipts,
        JSON.stringify(receipts),
        [{ type: "input_text", text: JSON.stringify(receipts) }],
        JSON.stringify([{ type: "input_text", text: JSON.stringify(receipts) }]),
        [receipts],
        JSON.stringify([receipts]),
      ].map((body) => ({ body })),
    ),
  )("retains batched receipts without inspecting stdout (%j)", ({ body }) => {
    const state = makeCodexRetainedItems();
    state.observe(output("exec-batch", body));
    assert.isTrue(state.hasItems());
    const loss = state.takeLoss()!;
    assert.include(loss, "90878");
    assert.include(loss, "33163");
    assert.notInclude(loss, "999");
    assert.notInclude(loss, "fake:1");
  });
  it.each(["output", "stdout", "stderr"])("does not inspect envelope %s", (key) => {
    const state = makeCodexRetainedItems();
    state.observe(output("stdout", JSON.stringify({ [key]: JSON.stringify(batch) })));
    assert.isFalse(state.hasItems());
  });
  it.each([
    "Script completed",
    "Script failed",
    "Script terminated",
    "Script error: TypeError: boom",
    "cell g2142:27 belongs to a stale code-mode host generation",
    "cell g2142:27 not found",
  ])("releases a consumed cell (%s)", (status) => {
    const state = makeCodexRetainedItems();
    state.observe(output("exec-1", yielded));
    state.observe(wait);
    state.observe({
      type: "function_call_output",
      call_id: "wait-1",
      output: `${status}\nOutput:\n`,
    });
    assert.isFalse(state.hasItems());
  });
  it("does not retain ordinary nonpersistent MCP items", () => {
    const state = makeCodexRetainedItems();
    state.observeNested({ id: "ordinary", tool: "wait", status: "inProgress", arguments: {} });
    assert.isFalse(state.hasItems());
  });
  it("does not infer a live cell from an orphaned code-mode MCP item", () => {
    const state = makeCodexRetainedItems();
    state.observeNested({
      id: "exec-orphan",
      tool: "t3_thread_wait",
      status: "inProgress",
      arguments: {},
    });
    assert.isFalse(state.hasItems());
    assert.isUndefined(state.takeLoss());
    state.observe(output("new", yielded));
    assert.notInclude(state.takeLoss()!, "t3_thread_wait");
  });
  it("keeps cell output after its inner MCP call completes", () => {
    const state = makeCodexRetainedItems();
    state.observe(output("exec-1", yielded));
    state.observeNested({
      id: "exec-inner",
      tool: "delegate_task",
      status: "completed",
      arguments: {},
    });
    assert.isTrue(state.hasItems());
    assert.notInclude(state.takeLoss()!, "Pending call");
  });
  it("retains exited exec output until write_stdin consumes it", () => {
    const state = makeCodexRetainedItems();
    state.observe(output("exec-1", [{ type: "input_text", text: session }]));
    assert.isTrue(state.hasItems());
    // CommandExecution completion is not proof the model read its output.
    state.observe({ type: "CommandExecution", process_id: "90878", exit_code: 0 });
    assert.isTrue(state.hasItems());
    state.observe({
      type: "function_call",
      call_id: "read",
      name: "functions.write_stdin",
      arguments: JSON.stringify({ session_id: 90878, chars: "" }),
    });
    state.observe(
      output("read", [
        { type: "input_text", text: "Script completed" },
        {
          type: "input_text",
          text: JSON.stringify({ chunk_id: "last", exit_code: 0, output: "done" }),
        },
      ]),
    );
    assert.isFalse(state.hasItems());
  });
  const readInputs = [
    'text(await tools.write_stdin({session_id:90878,chars:""}));',
    'text(await tools.write_stdin({chars:"", session_id: 90878}));',
    'text(await tools.write_stdin({"session_id":90878}));',
    "text(await tools.write_stdin({'session_id':'90878'}));",
    'text(await tools.write_stdin({session_id:"90878"}));',
    'if (false) await tools.write_stdin({session_id:90878}); text(await tools.exec_command({cmd:"true"}));',
    '// await tools.write_stdin({session_id:90878});\ntext(await tools.exec_command({cmd:"true"}));',
    'text("tools.write_stdin({session_id:90878})"); text(await tools.exec_command({cmd:"true"}));',
  ];
  it.each(readInputs.flatMap((input) => [0, 1, 2].map((yields) => ({ input, yields }))))(
    "does not infer session consumption from code source (%j)",
    ({ input, yields }) => {
      const state = makeCodexRetainedItems();
      state.observe(output("start", session));
      state.observe({
        type: "custom_tool_call",
        call_id: "read",
        name: "exec",
        input,
      });
      let callId = "read";
      for (let i = 0; i < yields; i++) {
        state.observe(output(callId, yielded));
        assert.isTrue(state.hasItems());
        callId = `wait-${i}`;
        state.observe({ ...wait, call_id: callId });
      }
      state.observe(
        output(callId, [
          { type: "input_text", text: "Script completed" },
          {
            type: "input_text",
            text: JSON.stringify({ chunk_id: "last", exit_code: 0, output: "done" }),
          },
        ]),
      );
      assert.isTrue(state.hasItems());
      const loss = state.takeLoss()!;
      assert.include(loss, "Exec session 90878 (may have unread output)");
      assert.notInclude(loss, "Cell g2142:27");
    },
  );
  it.each([
    "Process exited with code 0",
    "Process exited with code 1",
    "Process exited with code -1",
  ])("releases a directly consumed exec session (%s)", (terminal) => {
    const state = makeCodexRetainedItems();
    state.observe(output("start", "Process running with session ID 90878\n"));
    state.observe({
      type: "function_call",
      call_id: "read",
      name: "functions.write_stdin",
      arguments: JSON.stringify({ session_id: 90878 }),
    });
    state.observe({ type: "function_call_output", call_id: "read", output: terminal });
    assert.isFalse(state.hasItems());
  });
  it("ignores session and cell lookalikes inside command stdout", () => {
    const state = makeCodexRetainedItems();
    state.observe(
      output(
        "read",
        JSON.stringify({ chunk_id: "last", exit_code: 0, output: `${yielded}\n${session}` }),
      ),
    );
    assert.isFalse(state.hasItems());
  });
});

it.effect("reads only appended rollout data, caps the hold and reports loss once", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const path = `${dir}/rollout.jsonl`;
      const row = (value: unknown) =>
        JSON.stringify({ type: "response_item", payload: value }) + "\n";
      const historical = row(output("old", "Script running with cell ID old:1\n"));
      yield* fs.writeFileString(path, historical);
      const state = yield* make();
      yield* state.register("native", path);
      yield* state.idle("native");
      assert.isFalse(yield* state.holds("native"));
      const current =
        historical +
        row(
          output("exec-1", [
            { type: "input_text", text: yielded },
            { type: "input_text", text: session },
          ]),
        );
      // An incomplete final JSONL record is retried when the rest arrives.
      yield* fs.writeFileString(path, current.slice(0, -4));
      yield* state.refresh("native");
      assert.isTrue(yield* state.holds("native"));
      yield* fs.writeFileString(path, current);
      yield* state.refresh("native");
      assert.isTrue(yield* state.holds("native"));
      yield* TestClock.adjust(CODEX_RETAINED_STATE_IDLE_CAP_MS);
      assert.isFalse(yield* state.holds("native"));
      const loss = (yield* state.takeLoss("native"))!;
      assert.include(loss, "g2142:27");
      assert.include(loss, "90878");
      assert.notInclude(loss, "old:1");
      assert.isUndefined(yield* state.takeLoss("native"));
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("an unavailable optional rollout does not pin an otherwise empty thread", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const state = yield* make();
      yield* state.register("native", `${dir}/missing.jsonl`);
      yield* state.idle("native");
      assert.isFalse(yield* state.holds("native"));
      assert.isUndefined(yield* state.takeLoss("native"));
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("releases an incomplete rollout record once it is read without retained state", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const path = `${dir}/rollout.jsonl`;
      yield* fs.writeFileString(path, "");
      const state = yield* make();
      yield* state.register("native", path);
      yield* fs.writeFileString(path, '{"type":"response_item","payload":');
      yield* state.idle("native");
      assert.isTrue(yield* state.holds("native"));
      yield* fs.writeFileString(path, '{"type":"response_item","payload":{"type":"message"}}\n');
      yield* state.refresh("native");
      assert.isFalse(yield* state.holds("native"));
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
