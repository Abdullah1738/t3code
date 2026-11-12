import * as Effect from "effect/Effect";
// @effect-diagnostics nodeBuiltinImport:off - Atomic fsync/rename and byte-preserving fixture verification require native file handles.
import { describe, expect, it, vi } from "vite-plus/test";
import { it as effectIt } from "@effect/vitest";
import * as Semaphore from "effect/Semaphore";
import * as Fiber from "effect/Fiber";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { outputs } from "./content.ts";
import { planFile, providerOutputs, readNeedle, rewriteFile, countFile } from "./providerFiles.ts";

const renameControl = vi.hoisted(() => ({
  before: undefined as (() => Promise<void>) | undefined,
  after: undefined as (() => void) | undefined,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      await renameControl.before?.();
      await actual.rename(...args);
      renameControl.after?.();
    },
  };
});

const fake = "eyJFAKE.only-fixture.NO-SIGNATURE";
const marker = "[redacted 2026-11-12T00:00:00.000Z: fixture]";

describe("provider output redaction", () => {
  effectIt.effect.each(["claude", "claude-blocks", "codex"])(
    "rewrites %s output and later quotes with mode and other lines preserved",
    (driver) =>
      Effect.gen(function* () {
        const dir = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "redaction-fixture-")),
        );
        try {
          const file = NodePath.join(dir, "session.jsonl");
          const unchanged = '{ "type": "other", "value": "untouched" }\n';
          const output = driver.startsWith("claude")
            ? {
                message: {
                  content: [
                    {
                      type: "tool_result",
                      tool_use_id: "call-fixture",
                      content: driver === "claude-blocks" ? [{ type: "text", text: fake }] : fake,
                    },
                  ],
                },
              }
            : {
                type: "response_item",
                payload: { type: "function_call_output", call_id: "call-fixture", output: fake },
              };
          yield* Effect.promise(() =>
            NodeFSP.writeFile(
              file,
              unchanged +
                JSON.stringify(output) +
                "\n" +
                JSON.stringify({ summary: `quoted ${fake}` }) +
                "\n",
              { mode: 0o640 },
            ),
          );
          const needles = yield* Effect.promise(() => providerOutputs(file, "call-fixture"));
          const plan = yield* Effect.promise(() => planFile(file, needles, marker));
          const result = yield* rewriteFile(plan, needles, marker);
          const rewritten = yield* Effect.promise(() => NodeFSP.readFile(file, "utf8"));
          expect(rewritten.startsWith(unchanged)).toBe(true);
          expect(rewritten.includes(fake)).toBe(false);
          expect(
            rewritten
              .split("\n")
              .filter(Boolean)
              .every((line) => JSON.parse(line)),
          ).toBe(true);
          expect(result).toMatchObject({ matchedBefore: 2, replaced: 2, remainingAfter: 0 });
          expect(JSON.stringify(result).includes(fake)).toBe(false);
          expect((yield* Effect.promise(() => NodeFSP.stat(file))).mode & 0o777).toBe(0o640);
        } finally {
          yield* Effect.promise(() => NodeFSP.rm(dir, { recursive: true }));
        }
      }),
  );

  effectIt.effect("refuses a changed file and keeps the newer contents", () =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "redaction-race-")),
      );
      try {
        const file = NodePath.join(dir, "session.log");
        const plan = yield* Effect.promise(async () => {
          await NodeFSP.writeFile(file, fake);
          const prepared = await planFile(file, [fake], marker);
          await NodeFSP.appendFile(file, "new data");
          return prepared;
        });
        const failure = yield* rewriteFile(plan, [fake], marker).pipe(Effect.flip);
        expect(failure.message).toContain("file changed");
        expect(
          (yield* Effect.promise(() => NodeFSP.readFile(file, "utf8"))).endsWith("new data"),
        ).toBe(true);
        expect((yield* Effect.promise(() => NodeFSP.readdir(dir))).length).toBe(1);
      } finally {
        yield* Effect.promise(() => NodeFSP.rm(dir, { recursive: true }));
      }
    }),
  );

  it("accepts only owned 0600 regular needle files", async () => {
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "redaction-needle-"));
    try {
      const file = NodePath.join(dir, "needle");
      await NodeFSP.writeFile(file, fake, { mode: 0o600 });
      expect(await readNeedle(file)).toBe(fake);
      await NodeFSP.chmod(file, 0o644);
      await expect(readNeedle(file)).rejects.toThrow("0600");
      await NodeFSP.symlink(file, NodePath.join(dir, "symlink"));
      await expect(readNeedle(NodePath.join(dir, "symlink"))).rejects.toThrow("0600");
    } finally {
      await NodeFSP.rm(dir, { recursive: true });
    }
  });
});

effectIt.effect("interruption waits for native rename before releasing a writer barrier", () =>
  Effect.gen(function* () {
    const dir = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "redaction-interrupt-")),
    );
    const file = NodePath.join(dir, "fixture.log");
    let release!: () => void;
    let started!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const order: string[] = [];
    renameControl.before = async () => {
      started();
      await pending;
    };
    renameControl.after = () => {
      order.push("rename");
    };
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        release();
        renameControl.before = undefined;
        renameControl.after = undefined;
        await NodeFSP.rm(dir, { recursive: true, force: true });
      }),
    );
    yield* Effect.promise(() => NodeFSP.writeFile(file, fake));
    const plan = yield* Effect.promise(() => planFile(file, [fake], marker));
    const gate = yield* Semaphore.make(1);
    const writing = yield* Effect.forkScoped(gate.withPermit(rewriteFile(plan, [fake], marker)), {
      startImmediately: true,
    });
    yield* Effect.promise(() => entered);
    const interrupted = yield* Effect.forkScoped(Fiber.interrupt(writing), {
      startImmediately: true,
    });
    yield* Effect.yieldNow;
    const later = yield* Effect.forkScoped(
      gate.withPermit(
        Effect.promise(async () => {
          order.push("later write");
          await NodeFSP.appendFile(file, "\nunrelated later line\n");
        }),
      ),
      { startImmediately: true },
    );
    release();
    yield* Fiber.join(interrupted);
    yield* Fiber.join(later);
    expect(order).toEqual(["rename", "later write"]);
    const contents = yield* Effect.promise(() => NodeFSP.readFile(file, "utf8"));
    expect(contents.includes(fake)).toBe(false);
    expect(contents.endsWith("unrelated later line\n")).toBe(true);
  }).pipe(Effect.scoped),
);

effectIt.effect("refuses an invalid rewritten JSONL plan before replacing the original", () =>
  Effect.gen(function* () {
    const dir = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "redaction-invalid-")),
    );
    try {
      const file = NodePath.join(dir, "fixture.jsonl");
      const original = JSON.stringify({ output: fake }) + "\n";
      yield* Effect.promise(() => NodeFSP.writeFile(file, original));
      const plan = yield* Effect.promise(() => planFile(file, [fake], marker));
      const failed = yield* rewriteFile({ ...plan, after: '{"broken":' }, [fake], marker).pipe(
        Effect.flip,
      );
      expect(failed._tag).toBe("RedactionFileError");
      expect(yield* Effect.promise(() => NodeFSP.readFile(file, "utf8"))).toBe(original);
    } finally {
      yield* Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true }));
    }
  }),
);

it.each([
  { value: "null", metadata: { parentId: null } },
  { value: "3141592653589793", metadata: { ordinal: 3141592653589793 } },
])("refuses structural transcript changes for $value", async ({ value, metadata }) => {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "redaction-structure-"));
  try {
    const file = NodePath.join(dir, "fixture.jsonl");
    const original =
      JSON.stringify({ type: "tool_result", tool_use_id: "call-fixture", content: value }) +
      "\n" +
      JSON.stringify({ type: "metadata", ...metadata }) +
      "\n";
    await NodeFSP.writeFile(file, original);
    await expect(planFile(file, [value], marker)).rejects.toThrow("validation failed");
    expect(await NodeFSP.readFile(file, "utf8")).toBe(original);
  } finally {
    await NodeFSP.rm(dir, { recursive: true, force: true });
  }
});

it.each(["tool_result", "text", "tool_use"])(
  "protects native message.content discriminators from %s output",
  async (value) => {
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "redaction-native-envelope-"));
    try {
      const file = NodePath.join(dir, "fixture.jsonl");
      const original =
        JSON.stringify({
          type: "user",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "call-fixture",
                content: [{ type: "text", text: value }],
              },
              { type: "tool_use", id: "other-call", input: { command: "other" } },
            ],
          },
        }) + "\n";
      await NodeFSP.writeFile(file, original);
      await expect(planFile(file, [value], marker)).rejects.toThrow("validation failed");
      expect(await NodeFSP.readFile(file, "utf8")).toBe(original);
    } finally {
      await NodeFSP.rm(dir, { recursive: true, force: true });
    }
  },
);

effectIt.effect.each([
  { form: "number", value: 2718281828459045 },
  { form: "boolean", value: false },
  { form: "null", value: null },
  { form: "empty object", value: {} },
  { form: "empty array", value: [] },
  { form: "property only", value: { "eyJFAKE.PROPERTY-ONLY": null } },
  {
    form: "nested mixed",
    value: { "eyJFAKE.KEY": [2718281828459045, { "eyJFAKE.OTHER-KEY": false }, "eyJFAKE.TEXT"] },
  },
])("erases the complete $form output from log copies", ({ value }) =>
  Effect.gen(function* () {
    const dir = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "redaction-structured-")),
    );
    try {
      const file = NodePath.join(dir, "fixture.log");
      const source = JSON.stringify({ output: value }) + "\n" + JSON.stringify(value) + "\n";
      yield* Effect.promise(() => NodeFSP.writeFile(file, source));
      const plan = yield* Effect.promise(() => planFile(file, outputs({ output: value }), marker));
      const result = yield* rewriteFile(plan, outputs({ output: value }), marker);
      expect(result.replaced).toBeGreaterThan(0);
      expect(result.remainingAfter).toBe(0);
      const rewritten = yield* Effect.promise(() => NodeFSP.readFile(file, "utf8"));
      const lines = rewritten
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(lines).toEqual([{ output: marker }, marker]);
    } finally {
      yield* Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true }));
    }
  }),
);

effectIt.effect.each(
  ["NTIVE", "CANON", "ORCH"].flatMap((stream) =>
    ["2026-11-12T00:00:00.000Z", "00:00:00.000", "2026-11-12T04:00:00+04:00"].flatMap((timestamp) =>
      [
        { form: "exponent number", needle: "3141592653589793", copy: "3.141592653589793e15" },
        {
          form: "reordered document",
          needle: '{"eyJFAKE":"fixture","parts":[1,2]}',
          copy: '{"parts":[1,2],"eyJFAKE":"fixture"}',
        },
      ].flatMap((shape) => [false, true].map((bom) => ({ ...shape, stream, timestamp, bom }))),
    ),
  ),
)(
  "erases timestamped $stream $form copies ($timestamp BOM=$bom)",
  ({ stream, timestamp, needle, copy, bom }) =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "redaction-log-frame-")),
      );
      try {
        const file = NodePath.join(dir, "fixture.log");
        const unchanged = `[${timestamp}] ${stream}: { "other": "untouched" }\n`;
        const framed = `${bom ? "\ufeff" : ""}[${timestamp}] ${stream}: {"copy":${copy}}\n`;
        yield* Effect.promise(() => NodeFSP.writeFile(file, unchanged + framed));
        const plan = yield* Effect.promise(() => planFile(file, [needle], marker));
        const result = yield* rewriteFile(plan, [needle], marker);
        expect(result).toMatchObject({ matchedBefore: 1, replaced: 1, remainingAfter: 0 });
        const rewritten = yield* Effect.promise(() => NodeFSP.readFile(file, "utf8"));
        expect(rewritten.startsWith(unchanged)).toBe(true);
        expect(
          JSON.parse(
            rewritten
              .split("\n")[1]!
              .slice(`${bom ? "\ufeff" : ""}[${timestamp}] ${stream}: `.length),
          ),
        ).toEqual({ copy: marker });
      } finally {
        yield* Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true }));
      }
    }),
);

it.each([
  { form: "isolated continuation", bytes: [0x80] },
  { form: "truncated multibyte", bytes: [0xe2, 0x82] },
  { form: "overlong sequence", bytes: [0xc0, 0xaf] },
  { form: "surrogate sequence", bytes: [0xed, 0xa0, 0x80] },
])("refuses $form encoding before changing unrelated bytes", async ({ bytes }) => {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "redaction-invalid-encoding-"));
  try {
    const file = NodePath.join(dir, "fixture.log");
    const original = Buffer.concat([Buffer.from(bytes), Buffer.from("\n" + fake + "\n")]);
    await NodeFSP.writeFile(file, original);
    await expect(planFile(file, [fake], marker)).rejects.toThrow("valid UTF-8");
    expect(await NodeFSP.readFile(file)).toEqual(original);
    expect(await NodeFSP.readdir(dir)).toEqual(["fixture.log"]);
  } finally {
    await NodeFSP.rm(dir, { recursive: true, force: true });
  }
});

effectIt.effect("keeps unrelated valid BOM and multibyte bytes exact", () =>
  Effect.gen(function* () {
    const dir = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "redaction-valid-encoding-")),
    );
    try {
      const file = NodePath.join(dir, "fixture.log");
      const unrelated = Buffer.from("\ufeffé😀 unchanged\n");
      yield* Effect.promise(() =>
        NodeFSP.writeFile(file, Buffer.concat([unrelated, Buffer.from(fake + "\n")])),
      );
      const plan = yield* Effect.promise(() => planFile(file, [fake], marker));
      yield* rewriteFile(plan, [fake], marker);
      const rewritten = yield* Effect.promise(() => NodeFSP.readFile(file));
      expect(rewritten.subarray(0, unrelated.length)).toEqual(unrelated);
      expect(rewritten.toString("utf8").includes(fake)).toBe(false);
    } finally {
      yield* Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true }));
    }
  }),
);

effectIt.effect.each(
  [
    { form: "numeric", needle: "3141592653589793", copy: "3.141592653589793e15" },
    {
      form: "document",
      needle: '{"eyJFAKE":"duplicate-copy","parts":[1,2]}',
      copy: '{"parts":[1,2],"eyJFAKE":"duplicate-copy"}',
    },
  ].flatMap((shape) =>
    ["", "[2026-11-12T00:00:00Z] NTIVE: ", "\ufeff[2026-11-12T00:00:00Z] ORCH: "].flatMap(
      (prefix) =>
        [false, true].flatMap((escaped) =>
          [false, true].map((nested) => ({ ...shape, prefix, escaped, nested })),
        ),
    ),
  ),
)(
  "refuses overridden $form members (escaped=$escaped nested=$nested prefix=$prefix)",
  ({ needle, copy, prefix, escaped, nested }) =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "redaction-duplicate-")),
      );
      try {
        const file = NodePath.join(dir, "fixture.log");
        const duplicate = `{"copy":${copy},${escaped ? '"\\u0063opy"' : '"copy"'}:0}`;
        const original = prefix + (nested ? `{"nested":[${duplicate}]}` : duplicate) + "\n";
        yield* Effect.promise(() => NodeFSP.writeFile(file, original));
        yield* Effect.promise(async () => {
          await expect(planFile(file, [needle], marker)).rejects.toThrow("duplicate JSON");
          await expect(countFile(file, [needle])).rejects.toThrow("verification failed");
        });
        expect(yield* Effect.promise(() => NodeFSP.readFile(file, "utf8"))).toBe(original);
      } finally {
        yield* Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true }));
      }
    }),
);

it("provider discovery refuses duplicate output members", async () => {
  const dir = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "redaction-provider-duplicate-"),
  );
  try {
    const file = NodePath.join(dir, "fixture.jsonl");
    const original =
      '{"type":"function_call_output","call_id":"call-fixture","output":"eyJFAKE.OVERRIDDEN","output":"other"}\n';
    await NodeFSP.writeFile(file, original);
    await expect(providerOutputs(file, "call-fixture")).rejects.toThrow("duplicate JSON");
    expect(await NodeFSP.readFile(file, "utf8")).toBe(original);
  } finally {
    await NodeFSP.rm(dir, { recursive: true, force: true });
  }
});

it.each([
  { form: "unsafe integer", number: "9007199254740993" },
  { form: "negative unsafe integer", number: "-9007199254740993" },
  { form: "excess decimal precision", number: "0.10000000000000001" },
  { form: "overflow", number: "1e10000" },
  { form: "underflow", number: "1e-10000" },
  { form: "negative zero", number: "-0" },
])("refuses $form before rewriting unrelated numeric bytes", async ({ number }) => {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "redaction-lossy-number-"));
  try {
    const file = NodePath.join(dir, "fixture.jsonl");
    const original =
      '{"type":"response_item","payload":{"type":"function_call_output","call_id":"call-fixture","output":"3141592653589793","arguments":{"untouched":' +
      number +
      "}}}\n" +
      '{"copy":3.141592653589793e15}\n';
    await NodeFSP.writeFile(file, original);
    await expect(planFile(file, ["3141592653589793"], marker)).rejects.toThrow("lossy JSON");
    await expect(countFile(file, ["3141592653589793"])).rejects.toThrow("verification failed");
    expect(await NodeFSP.readFile(file, "utf8")).toBe(original);
  } finally {
    await NodeFSP.rm(dir, { recursive: true, force: true });
  }
});

effectIt.effect.each(["9007199254740992", "123.456", "1e300", "5e-324", "2.718281828459045e15"])(
  "keeps exactly representable JSON number %s while redacting another value",
  (number) =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "redaction-exact-number-")),
      );
      try {
        const file = NodePath.join(dir, "fixture.log");
        yield* Effect.promise(() =>
          NodeFSP.writeFile(file, '{"untouched":' + number + ',"copy":3.141592653589793e15}\n'),
        );
        const plan = yield* Effect.promise(() => planFile(file, ["3141592653589793"], marker));
        const result = yield* rewriteFile(plan, ["3141592653589793"], marker);
        expect(result.remainingAfter).toBe(0);
        const record = JSON.parse(yield* Effect.promise(() => NodeFSP.readFile(file, "utf8")));
        expect(record.untouched).toBe(Number(number));
        expect(record.copy).toBe(marker);
      } finally {
        yield* Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true }));
      }
    }),
);

effectIt.effect.each(["9007199254740993", "0.10000000000000001", "-0", "1e10000"])(
  "preserves numeric string %s without Number conversion",
  (number) =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "redaction-number-string-")),
      );
      try {
        const file = NodePath.join(dir, "fixture.log");
        yield* Effect.promise(() =>
          NodeFSP.writeFile(file, JSON.stringify({ idText: number, copy: fake }) + "\n"),
        );
        const plan = yield* Effect.promise(() => planFile(file, [fake], marker));
        const result = yield* rewriteFile(plan, [fake], marker);
        expect(result.remainingAfter).toBe(0);
        const record = JSON.parse(yield* Effect.promise(() => NodeFSP.readFile(file, "utf8")));
        expect(record.idText).toBe(number);
        expect(record.copy).toBe(marker);
      } finally {
        yield* Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true }));
      }
    }),
);
