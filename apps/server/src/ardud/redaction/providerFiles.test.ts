import * as Effect from "effect/Effect";
// @effect-diagnostics nodeBuiltinImport:off - Atomic fsync/rename and byte-preserving fixture verification require native file handles.
import { describe, expect, it, vi } from "vite-plus/test";
import { it as effectIt } from "@effect/vitest";
import * as Semaphore from "effect/Semaphore";
import * as Fiber from "effect/Fiber";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";
import { outputs, replaceValue, replaceText, replaceScalarText } from "./content.ts";
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

effectIt.effect.each(
  ["session.log", "session.jsonl", "server.trace.ndjson.1.gz"].flatMap((name) =>
    ["contents", "needles", "marker"].map((change) => ({ name, change })),
  ),
)("refuses changed $change after preflight for $name", ({ name, change }) =>
  Effect.gen(function* () {
    const dir = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "redaction-proof-")),
    );
    try {
      const file = NodePath.join(dir, name);
      const encode = (text: string) =>
        name.endsWith(".gz") ? NodeZlib.gzipSync(text) : Buffer.from(text);
      const source = JSON.stringify({ output: fake }) + "\n";
      const fixedTime = 1_700_000_000;
      const { plan, before } = yield* Effect.promise(async () => {
        await NodeFSP.writeFile(file, encode(source));
        await NodeFSP.utimes(file, fixedTime, fixedTime);
        const plan = await planFile(file, [fake], marker);
        if (change === "contents") {
          await NodeFSP.writeFile(file, encode(source.replace("FAKE", "SAFE")));
          // Same inode, timestamp and text length: the content proof must detect this edit.
          await NodeFSP.utimes(file, fixedTime, fixedTime);
        }
        return { plan, before: await NodeFSP.readFile(file) };
      });
      const result = yield* rewriteFile(
        plan,
        change === "needles" ? ["unrelated"] : [fake],
        change === "marker" ? "[different]" : marker,
      ).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      expect(yield* Effect.promise(() => NodeFSP.readFile(file))).toEqual(before);
      expect(yield* Effect.promise(() => NodeFSP.readdir(dir))).toEqual([name]);
    } finally {
      yield* Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true }));
    }
  }),
);

it.each(
  ["NTIVE", "CANON", "ORCH"].flatMap((stream) =>
    [false, true].flatMap((bom) =>
      [
        '"fixture-\\u006futput []',
        '{"copy":"fixture-\\u006futput []',
        '["fixture-\\u006futput {}',
        '"fixture-\\u006futput \\\\',
        '"[{}] fixture-\\u006futput',
        '"fixture-\\u006futput \\\"quoted',
      ].map((body) => ({ stream, bom, body })),
    ),
  ),
)("refuses incomplete encoded $stream string BOM=$bom ($body)", async ({ stream, bom, body }) => {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "incomplete-frame-"));
  try {
    const file = NodePath.join(dir, "fixture.log");
    const source =
      (bom ? "\uFEFF" : "") + "[2026-11-12T00:00:00.000Z] " + stream + ": " + body + "\n";
    await NodeFSP.writeFile(file, source);
    await expect(planFile(file, ["fixture-output"], marker)).rejects.toThrow(
      "incomplete encoded JSON",
    );
    expect(await NodeFSP.readFile(file, "utf8")).toBe(source);
    expect(await NodeFSP.readdir(dir)).toEqual(["fixture.log"]);
  } finally {
    await NodeFSP.rm(dir, { recursive: true, force: true });
  }
});

const incompleteEscapes = [
  { form: "solidus", value: "fixture/output", body: String.raw`"fixture\/output` },
  { form: "reverse solidus", value: "fixture\\output", body: String.raw`"fixture\\output` },
  { form: "quotation mark", value: 'fixture"output', body: String.raw`"fixture\"output` },
  { form: "backspace", value: "fixture\boutput", body: String.raw`"fixture\boutput` },
  { form: "form feed", value: "fixture\foutput", body: String.raw`"fixture\foutput` },
  { form: "line feed", value: "fixture\noutput", body: String.raw`"fixture\noutput` },
  { form: "carriage return", value: "fixture\routput", body: String.raw`"fixture\routput` },
  { form: "tab", value: "fixture\toutput", body: String.raw`"fixture\toutput` },
  { form: "Unicode lowercase", value: "fixture/output", body: String.raw`"fixture\u002foutput` },
  { form: "Unicode uppercase", value: "fixture/output", body: String.raw`"fixture\u002Foutput` },
  { form: "partial Unicode", value: "fixture/output", body: String.raw`"fixture/output\u00` },
  { form: "invalid escape", value: "fixture/output", body: String.raw`"fixture\/output\q` },
  { form: "dangling escape", value: "fixture/output", body: '"fixture\\/output\\' },
];
it.each(
  incompleteEscapes.flatMap((escape) =>
    ["NTIVE", "CANON", "ORCH"].flatMap((stream) =>
      ["", "[2026-11-12T00:00:00.000Z] ", "[00:00:00.000] "].flatMap((timestamp) =>
        [false, true].map((bom) => ({ ...escape, stream, timestamp, bom })),
      ),
    ),
  ),
)(
  "refuses incomplete $form in $stream timestamp=$timestamp BOM=$bom",
  async ({ value, body, stream, timestamp, bom }) => {
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "incomplete-escape-"));
    try {
      const file = NodePath.join(dir, "fixture.log");
      const source = (bom ? "\uFEFF" : "") + timestamp + stream + ": " + body + "\n";
      await NodeFSP.writeFile(file, source);
      await expect(planFile(file, [value], marker)).rejects.toThrow("incomplete encoded JSON");
      await expect(countFile(file, [value])).rejects.toThrow("Redaction file verification failed.");
      expect(await NodeFSP.readFile(file, "utf8")).toBe(source);
      expect(await NodeFSP.readdir(dir)).toEqual(["fixture.log"]);
    } finally {
      await NodeFSP.rm(dir, { recursive: true, force: true });
    }
  },
);

it.each([" ", "\n"].flatMap((separator) => [false, true].map((first) => ({ separator, first }))))(
  "known raw output does not hide another escaped copy (separator=$separator first=$first)",
  async ({ separator, first }) => {
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "incomplete-residual-"));
    try {
      const file = NodePath.join(dir, "fixture.log");
      const known = 'before "fixture\\path';
      const incomplete = String.raw`NTIVE: "fixture\/output`;
      const source = (first ? [known, incomplete] : [incomplete, known]).join(separator);
      await NodeFSP.writeFile(file, source);
      await expect(planFile(file, [known, "fixture/output"], marker)).rejects.toThrow(
        "incomplete encoded JSON",
      );
      await expect(countFile(file, [known, "fixture/output"])).rejects.toThrow(
        "Redaction file verification failed.",
      );
      expect(await NodeFSP.readFile(file, "utf8")).toBe(source);
    } finally {
      await NodeFSP.rm(dir, { recursive: true, force: true });
    }
  },
);

const bareEscapes = [
  { form: "solidus", value: "fixture/output", body: String.raw`fixture\/output` },
  { form: "Unicode solidus", value: "fixture/output", body: String.raw`fixture\u002foutput` },
  { form: "reverse solidus", value: "fixture\\output", body: String.raw`fixture\u005Coutput` },
  { form: "quotation mark", value: 'fixture"output', body: String.raw`fixture\u0022output` },
  { form: "backspace", value: "fixture\boutput", body: String.raw`fixture\u0008output` },
  { form: "form feed", value: "fixture\foutput", body: String.raw`fixture\u000Coutput` },
  { form: "line feed", value: "fixture\noutput", body: String.raw`fixture\u000aoutput` },
  { form: "carriage return", value: "fixture\routput", body: String.raw`fixture\u000Doutput` },
  { form: "tab", value: "fixture\toutput", body: String.raw`fixture\u0009output` },
  { form: "ASCII Unicode", value: "fixture-output", body: String.raw`fixture-\u006futput` },
  { form: "surrogate pair", value: "fixture😀output", body: String.raw`fixture\ud83d\uDE00output` },
  { form: "numeric equivalent", value: "1000000000000000000000", body: String.raw`\u0031e+21` },
  {
    form: "reordered document",
    value: '{"a":1,"b":2}',
    body: String.raw`\u007b\u0022b\u0022:2,\u0022a\u0022:1\u007d`,
  },
];
it.each(
  bareEscapes.flatMap((escape) =>
    [0, 1, 3].flatMap((depth) =>
      ["", "NTIVE: ", "[00:00:00.000] CANON: ", "\uFEFF[2026-11-12T00:00:00.000Z] ORCH: "].map(
        (frame) => ({ ...escape, depth, frame }),
      ),
    ),
  ),
)(
  "refuses unquoted alternate $form depth=$depth frame=$frame",
  async ({ value, body, depth, frame }) => {
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "bare-escape-"));
    try {
      const file = NodePath.join(dir, "fixture.log");
      let encoded = body;
      for (let i = 0; i < depth; i++) encoded = JSON.stringify(encoded).slice(1, -1);
      const source = frame + encoded + "\n";
      await NodeFSP.writeFile(file, source);
      await expect(planFile(file, [value], marker)).rejects.toThrow("incomplete encoded JSON");
      await expect(countFile(file, [value])).rejects.toThrow("Redaction file verification failed.");
      expect(await NodeFSP.readFile(file, "utf8")).toBe(source);
      expect(await NodeFSP.readdir(dir)).toEqual(["fixture.log"]);
    } finally {
      await NodeFSP.rm(dir, { recursive: true, force: true });
    }
  },
);

const malformedContainers = [
  { form: "truncated object", needle: "3141592653589793", body: '{"copy":3.141592653589793e15' },
  { form: "truncated array", needle: "3141592653589793", body: "[3.141592653589793e15" },
  {
    form: "object trailing comma",
    needle: "3141592653589793",
    body: '{"copy":3.141592653589793e15,}',
  },
  { form: "array trailing comma", needle: "3141592653589793", body: "[3.141592653589793e15,]" },
  { form: "mismatched close", needle: "3141592653589793", body: '{"copy":3.141592653589793e15]' },
  { form: "unquoted key", needle: "3141592653589793", body: "{copy:3.141592653589793e15}" },
  {
    form: "nested truncation",
    needle: "3141592653589793",
    body: '{"copy":[3.141592653589793e15,{"x":true',
  },
  { form: "reordered document", needle: '{"a":1,"b":2}', body: '{"copy":{"b":2,"a":1}' },
  { form: "boolean", needle: "true", body: '{"copy":true' },
  { form: "null", needle: "null", body: '{"copy":null' },
];
it.each(
  malformedContainers.flatMap((row) => [
    { ...row, frame: "" },
    ...["NTIVE", "CANON", "ORCH"].flatMap((stream) =>
      ["", "[00:00:00.000] ", "[2026-11-12T00:00:00.000Z] "].flatMap((timestamp) =>
        ["", "\uFEFF"].map((bom) => ({ ...row, frame: bom + timestamp + stream + ": " })),
      ),
    ),
  ]),
)(
  "refuses malformed $form frame=$frame before preparation or verification",
  async ({ needle, body, frame }) => {
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "malformed-container-"));
    try {
      const file = NodePath.join(dir, "fixture.log");
      const before = frame + body + "\n";
      await NodeFSP.writeFile(file, before);
      await expect(planFile(file, [needle], marker)).rejects.toThrow("incomplete encoded JSON");
      await expect(countFile(file, [needle])).rejects.toThrow(
        "Redaction file verification failed.",
      );
      expect(await NodeFSP.readFile(file, "utf8")).toBe(before);
      expect(await NodeFSP.readdir(dir)).toEqual(["fixture.log"]);
    } finally {
      await NodeFSP.rm(dir, { recursive: true, force: true });
    }
  },
);

it.each([
  { form: "positive boundary", needle: "1e1000000", copy: "10e999999" },
  { form: "negative boundary", needle: "1e-1000000", copy: "10e-1000001" },
  { form: "explicit positive sign", needle: "1e+1000000", copy: "10e999999" },
  { form: "leading zeros", needle: "1e0001000000", copy: "10e999999" },
  { form: "larger exponent", needle: "1e10000000", copy: "10e9999999" },
  { form: "negative sign and whitespace", needle: " -1e-0001000000 ", copy: "-10e-1000001" },
])("refuses numeric $form beyond exact comparison before any rewrite", async ({ needle, copy }) => {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "numeric-bound-"));
  try {
    const file = NodePath.join(dir, "fixture.log");
    const before = "amount " + copy + " total";
    await NodeFSP.writeFile(file, before);
    expect(() => replaceText(before, [needle], marker)).toThrow("lossy JSON numeric");
    expect(() => replaceScalarText(needle, [needle], marker)).toThrow("lossy JSON numeric");
    await expect(planFile(file, [needle], marker)).rejects.toThrow("lossy JSON numeric");
    await expect(countFile(file, [needle])).rejects.toThrow("Redaction file verification failed.");
    expect(await NodeFSP.readFile(file, "utf8")).toBe(before);
    expect(await NodeFSP.readdir(dir)).toEqual(["fixture.log"]);
  } finally {
    await NodeFSP.rm(dir, { recursive: true, force: true });
  }
});
it.each(
  [
    { form: "positive boundary", needle: "1e999999", copy: "0.1e1000000" },
    { form: "negative exponent boundary", needle: "1e-999999", copy: "10e-1000000" },
    { form: "negative value", needle: "-1e999999", copy: "-0.1e1000000" },
    { form: "negative value and exponent", needle: "-1e-999999", copy: "-10e-1000000" },
    { form: "explicit positive sign", needle: "1e999999", copy: "0.1e+1000000" },
    { form: "leading zeros", needle: "1e999999", copy: "0.1e0001000000" },
    { form: "unverifiable neighbor", needle: "1e999999", copy: "0.2e1000000" },
  ].flatMap((value) =>
    ["raw", "quoted", "object string", "object number", "array number", "scalar"].flatMap((shape) =>
      ["", "NTIVE: ", "[00:00:00.000] CANON: ", "\uFEFF[2026-11-12T00:00:00.000Z] ORCH: "].map(
        (frame) => ({ ...value, shape, frame }),
      ),
    ),
  ),
)(
  "refuses unverifiable source numeric $form shape=$shape frame=$frame",
  async ({ needle, copy, shape, frame }) => {
    const body =
      shape === "raw"
        ? "amount " + copy + " total"
        : shape === "quoted"
          ? JSON.stringify(copy)
          : shape === "object string"
            ? JSON.stringify({ copy })
            : shape === "object number"
              ? '{"copy":' + copy + "}"
              : shape === "array number"
                ? "[" + copy + "]"
                : copy;
    const before = frame + body + "\n";
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "numeric-source-bound-"));
    try {
      const file = NodePath.join(dir, "fixture.log");
      await NodeFSP.writeFile(file, before);
      expect(() => replaceText(before, [needle], marker)).toThrow("lossy JSON numeric");
      expect(() => replaceScalarText(before, [needle], marker)).toThrow("lossy JSON numeric");
      await expect(planFile(file, [needle], marker)).rejects.toThrow("lossy JSON numeric");
      await expect(countFile(file, [needle])).rejects.toThrow(
        "Redaction file verification failed.",
      );
      expect(await NodeFSP.readFile(file, "utf8")).toBe(before);
      expect(await NodeFSP.readdir(dir)).toEqual(["fixture.log"]);
    } finally {
      await NodeFSP.rm(dir, { recursive: true, force: true });
    }
  },
);
effectIt.effect.each([
  { form: "positive supported limit", needle: "1e999999", copy: "10e999998", matches: true },
  { form: "negative supported limit", needle: "1e-999999", copy: "0.1e-999998", matches: true },
  {
    form: "supported sign and leading zeros",
    needle: "1e+000999999",
    copy: "10e999998",
    matches: true,
  },
  { form: "positive zero", needle: "0e10000000", copy: "0e99999999", matches: true },
  { form: "negative zero", needle: "-0e10000000", copy: "-0e99999999", matches: true },
  { form: "different neighboring value", needle: "1e999999", copy: "10e999997", matches: false },
])("retains exact numeric comparison for $form", ({ needle, copy, matches }) =>
  Effect.gen(function* () {
    const dir = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "numeric-bound-control-")),
    );
    try {
      const file = NodePath.join(dir, "fixture.log");
      const before = "amount " + copy + " total";
      yield* Effect.promise(() => NodeFSP.writeFile(file, before));
      const plan = yield* Effect.promise(() => planFile(file, [needle], marker));
      const result = yield* rewriteFile(plan, [needle], marker);
      expect(result).toMatchObject({
        matchedBefore: matches ? 1 : 0,
        replaced: matches ? 1 : 0,
        remainingAfter: 0,
      });
      expect(yield* Effect.promise(() => NodeFSP.readFile(file, "utf8"))).toBe(
        matches ? before.replace(copy, marker) : before,
      );
    } finally {
      yield* Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true }));
    }
  }),
);

effectIt.effect.each(
  [
    {
      full: "3141592653589793",
      short: "3.",
      source: "amount 3.141592653589793e15 total",
      after: "amount MARKER total",
    },
    {
      full: "heading 3 end",
      short: "3",
      source: "amount heading 3 end total",
      after: "amount MARKER total",
    },
  ].flatMap((row) => [false, true].map((reversed) => ({ ...row, reversed }))),
)(
  "longer raw numeric/literal copy wins over $short reversed=$reversed",
  ({ full, short, source, after, reversed }) =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "numeric-overlap-")),
      );
      try {
        const file = NodePath.join(dir, "fixture.log");
        const needles = reversed ? [short, full] : [full, short];
        yield* Effect.promise(() => NodeFSP.writeFile(file, source));
        const plan = yield* Effect.promise(() => planFile(file, needles, marker));
        const result = yield* rewriteFile(plan, needles, marker);
        expect(result).toMatchObject({ matchedBefore: 1, replaced: 1, remainingAfter: 0 });
        expect(yield* Effect.promise(() => NodeFSP.readFile(file, "utf8"))).toBe(
          after.replace("MARKER", marker),
        );
      } finally {
        yield* Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true }));
      }
    }),
);

effectIt.effect.each(
  [
    { needle: "3141592653589793", copy: "3.141592653589793e15", matches: true },
    { needle: "-3141592653589793", copy: "-3.141592653589793e15", matches: true },
    { needle: "1000000000000000000000", copy: "1e+21", matches: true },
    { needle: "0.0000001", copy: "1e-7", matches: true },
    { needle: "1.2500", copy: "1.25", matches: true },
    { needle: "3141592653589793", copy: "3.141592653589794e15", matches: false },
    { needle: "3141592653589793", copy: "item3.141592653589793e15", matches: false },
    { needle: "3141592653589793", copy: "3.141592653589793e15suffix", matches: false },
  ].flatMap((row) =>
    ["plain", "framed suffix", "after JSON", "before JSON"].map((layout) => ({ ...row, layout })),
  ),
)(
  "recognizes numeric token $copy in $layout matches=$matches",
  ({ needle, copy, matches, layout }) =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "raw-number-")),
      );
      try {
        const file = NodePath.join(dir, "fixture.log");
        const before =
          layout === "plain"
            ? "amount " + copy + " total"
            : layout === "framed suffix"
              ? "[00:00:00.000] NTIVE: " + copy + " total"
              : layout === "after JSON"
                ? '{"unrelated":"kept"} ' + copy
                : copy + ' {"unrelated":"kept"}';
        yield* Effect.promise(() => NodeFSP.writeFile(file, before));
        const plan = yield* Effect.promise(() => planFile(file, [needle], marker));
        const result = yield* rewriteFile(plan, [needle], marker);
        expect(result).toMatchObject({
          matchedBefore: matches ? 1 : 0,
          replaced: matches ? 1 : 0,
          remainingAfter: 0,
        });
        const after = yield* Effect.promise(() => NodeFSP.readFile(file, "utf8"));
        expect(after).toBe(matches ? before.replace(copy, marker) : before);
      } finally {
        yield* Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true }));
      }
    }),
);

effectIt.effect.each([
  "{copy:3.141592653589793e15}",
  "[1,]",
  '{"copy":3.141592653589793e15',
  "[unrelated progress]",
])("literal text does not require parsing unrelated record %s", (unrelated) =>
  Effect.gen(function* () {
    const dir = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "unrelated-record-")),
    );
    try {
      const file = NodePath.join(dir, "fixture.log");
      const unchanged = "unrelated: " + unrelated + "\n";
      yield* Effect.promise(() => NodeFSP.writeFile(file, unchanged + "selected: fixture/output"));
      const plan = yield* Effect.promise(() => planFile(file, ["fixture/output"], marker));
      const result = yield* rewriteFile(plan, ["fixture/output"], marker);
      expect(result).toMatchObject({ matchedBefore: 1, replaced: 1, remainingAfter: 0 });
      expect(yield* Effect.promise(() => NodeFSP.readFile(file, "utf8"))).toBe(
        unchanged + "selected: " + marker,
      );
    } finally {
      yield* Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true }));
    }
  }),
);

effectIt.effect.each(
  [false, true].flatMap((reversed) =>
    ["\\/", "\\u002f"].flatMap((escape) =>
      [false, true].map((quoted) => ({ reversed, escape, quoted })),
    ),
  ),
)(
  "whole fragment overlap stays verifiable reversed=$reversed escape=$escape quoted=$quoted",
  ({ reversed, escape, quoted }) =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "fragment-overlap-")),
      );
      try {
        const file = NodePath.join(dir, "fixture.log");
        const short = 'heading {"part":"fixture"} ';
        const full = short + "fixture/output";
        const needles = reversed ? [short, full] : [full, short];
        const before = quoted
          ? "prefix " + JSON.stringify(full).replace("/", escape) + " suffix"
          : short + "fixture" + escape + "output";
        yield* Effect.promise(() => NodeFSP.writeFile(file, before));
        if (!quoted) {
          yield* Effect.promise(() =>
            expect(planFile(file, needles, marker)).rejects.toThrow("incomplete encoded JSON"),
          );
          expect(yield* Effect.promise(() => NodeFSP.readFile(file, "utf8"))).toBe(before);
        } else {
          const plan = yield* Effect.promise(() => planFile(file, needles, marker));
          const result = yield* rewriteFile(plan, needles, marker);
          expect(result).toMatchObject({ matchedBefore: 1, replaced: 1, remainingAfter: 0 });
          expect(yield* Effect.promise(() => countFile(file, needles))).toBe(0);
        }
      } finally {
        yield* Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true }));
      }
    }),
);

effectIt.effect.each(
  ["heading ", " tail", "fixture/"].flatMap((overlap) =>
    ["slash", "Unicode"].flatMap((spelling) =>
      [false, true].flatMap((quoted) =>
        [false, true].flatMap((reversed) =>
          [0, 1, 3].map((depth) => ({ overlap, spelling, quoted, reversed, depth })),
        ),
      ),
    ),
  ),
)(
  "overlapping $overlap cannot hide $spelling quoted=$quoted reversed=$reversed depth=$depth",
  ({ overlap, spelling, quoted, reversed, depth }) =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "overlap-escape-")),
      );
      try {
        const file = NodePath.join(dir, "fixture.log");
        const value = "heading fixture/output tail";
        const needles = reversed ? [overlap, value] : [value, overlap];
        let encoded = JSON.stringify(value).replace("/", spelling === "slash" ? "\\/" : "\\u002f");
        if (!quoted) encoded = encoded.slice(1, -1);
        for (let i = 0; i < depth; i++)
          encoded = quoted ? JSON.stringify(encoded) : JSON.stringify(encoded).slice(1, -1);
        const source = "prefix " + encoded + " suffix\n";
        yield* Effect.promise(() => NodeFSP.writeFile(file, source));
        if (!quoted) {
          yield* Effect.promise(() =>
            expect(planFile(file, needles, marker)).rejects.toThrow("incomplete encoded JSON"),
          );
          yield* Effect.promise(() =>
            expect(countFile(file, needles)).rejects.toThrow("Redaction file verification failed."),
          );
          expect(yield* Effect.promise(() => NodeFSP.readFile(file, "utf8"))).toBe(source);
        } else {
          const plan = yield* Effect.promise(() => planFile(file, needles, marker));
          const result = yield* rewriteFile(plan, needles, marker);
          expect(result).toMatchObject({ matchedBefore: 1, replaced: 1, remainingAfter: 0 });
          expect(yield* Effect.promise(() => countFile(file, needles))).toBe(0);
          const after = yield* Effect.promise(() => NodeFSP.readFile(file, "utf8"));
          expect(after.startsWith("prefix ")).toBe(true);
          expect(after.endsWith(" suffix\n")).toBe(true);
          expect(after.includes("fixture/output")).toBe(false);
          expect(after.includes(String.raw`fixture\/output`)).toBe(false);
          expect(after.includes(String.raw`fixture\u002foutput`)).toBe(false);
        }
      } finally {
        yield* Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true }));
      }
    }),
);

effectIt.effect.each(
  ["NTIVE", "CANON", "ORCH"].flatMap((stream) =>
    [false, true].flatMap((bom) =>
      [
        "fixture-output []",
        "fixture-output {}",
        "[] fixture-output {}",
        'fixture-output ["quoted"]',
        "fixture-output [",
        "fixture-output }",
      ].map((value) => ({ stream, bom, value })),
    ),
  ),
)("redacts escaped quoted containers in $stream BOM=$bom ($value)", ({ stream, bom, value }) =>
  Effect.gen(function* () {
    const dir = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "quoted-region-")),
    );
    try {
      const file = NodePath.join(dir, "fixture.log");
      const header = (bom ? "\uFEFF" : "") + "[2026-11-12T00:00:00.000Z] " + stream + ": ";
      const source = header + JSON.stringify(value).replace("output", "\\u006futput") + "\n";
      yield* Effect.promise(() => NodeFSP.writeFile(file, source));
      const plan = yield* Effect.promise(() => planFile(file, ["fixture-output"], marker));
      const result = yield* rewriteFile(plan, ["fixture-output"], marker);
      const rewritten = yield* Effect.promise(() => NodeFSP.readFile(file, "utf8"));
      expect(rewritten).toBe(
        header + JSON.stringify(value.replace("fixture-output", marker)) + "\n",
      );
      expect(result).toMatchObject({ matchedBefore: 1, replaced: 1, remainingAfter: 0 });
      expect(yield* Effect.promise(() => countFile(file, ["fixture-output"]))).toBe(0);
      expect(JSON.stringify(result).includes("fixture-output")).toBe(false);
    } finally {
      yield* Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true }));
    }
  }),
);

effectIt.effect.each(
  ["NTIVE", "CANON", "ORCH"].flatMap((stream) =>
    ["", "[2026-11-12T00:00:00.000Z] ", "[00:00:00.000] "].flatMap((timestamp) =>
      [false, true].flatMap((bom) =>
        [
          {
            form: "positive exponent",
            needle: "1000000000000000000000",
            copy: "1e+21",
            changed: true,
          },
          {
            form: "negative exponent",
            needle: "-1000000000000000000000",
            copy: "-1e+21",
            changed: true,
          },
          { form: "small exponent", needle: "0.0000001", copy: "1e-7", changed: true },
          {
            form: "quoted number",
            needle: "1000000000000000000000",
            copy: '"1000000000000000000000"',
            changed: true,
          },
          {
            form: "quoted delimiter",
            needle: '"eyJFAKE.quoted"',
            copy: '"eyJFAKE.quoted"',
            changed: false,
          },
          {
            form: "quoted inner content",
            needle: "eyJFAKE.quoted",
            copy: '"eyJFAKE.quoted"',
            changed: true,
          },
          {
            form: "nonmatching neighbor",
            needle: "1000000000000000000000",
            copy: "1.000000000000001e+21",
            changed: false,
          },
        ].map((shape) => ({ ...shape, stream, timestamp, bom })),
      ),
    ),
  ),
)(
  "handles framed scalar $stream $form ($timestamp BOM=$bom)",
  ({ needle, copy, changed, stream, timestamp, bom }) =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "framed-scalar-")),
      );
      try {
        const file = NodePath.join(dir, "fixture.log");
        const header = (bom ? "\uFEFF" : "") + timestamp + stream + ": ";
        const source = header + copy + "\n";
        yield* Effect.promise(() => NodeFSP.writeFile(file, source));
        const plan = yield* Effect.promise(() => planFile(file, [needle], marker));
        const result = yield* rewriteFile(plan, [needle], marker);
        const rewritten = yield* Effect.promise(() => NodeFSP.readFile(file, "utf8"));
        expect(result).toMatchObject({
          matchedBefore: changed ? 1 : 0,
          replaced: changed ? 1 : 0,
          remainingAfter: 0,
        });
        expect(rewritten).toBe(changed ? header + JSON.stringify(marker) + "\n" : source);
        expect(JSON.parse(rewritten.slice(header.length))).toBe(
          changed ? marker : JSON.parse(copy),
        );
        expect(yield* Effect.promise(() => countFile(file, [needle]))).toBe(0);
      } finally {
        yield* Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true }));
      }
    }),
);

const keyCollisions = [
  { form: "root", json: '{"fixtureAlpha":1,"fixtureBeta":2,"keep":3}' },
  { form: "nested", json: '{"copy":{"fixtureAlpha":1,"fixtureBeta":2,"keep":3}}' },
  { form: "array", json: '[{"fixtureAlpha":1,"fixtureBeta":2,"keep":3}]' },
  { form: "escaped key", json: '{"fixtureAlpha":1,"\\u0066ixtureBeta":2,"keep":3}' },
  { form: "existing marker key", json: JSON.stringify({ fixtureAlpha: 1, [marker]: 2, keep: 3 }) },
];
it.each(
  keyCollisions.flatMap((row) => ["log", "jsonl"].map((extension) => ({ ...row, extension }))),
)("refuses $form key collisions in .$extension during preparation", async ({ json, extension }) => {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "key-collision-"));
  try {
    const file = NodePath.join(dir, "fixture." + extension);
    const source = extension === "log" ? "before " + json + " after\n" : json + "\n";
    await NodeFSP.writeFile(file, source);
    await expect(planFile(file, ["fixtureAlpha", "fixtureBeta"], marker)).rejects.toThrow(
      "duplicate JSON object keys",
    );
    expect(await NodeFSP.readFile(file, "utf8")).toBe(source);
    expect(await NodeFSP.readdir(dir)).toEqual(["fixture." + extension]);
    expect(() => replaceValue(JSON.parse(json), ["fixtureAlpha", "fixtureBeta"], marker)).toThrow(
      "duplicate JSON object keys",
    );
  } finally {
    await NodeFSP.rm(dir, { recursive: true, force: true });
  }
});

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

effectIt.effect("refuses a changed rewrite proof before replacing the original JSONL", () =>
  Effect.gen(function* () {
    const dir = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "redaction-invalid-")),
    );
    try {
      const file = NodePath.join(dir, "fixture.jsonl");
      const original = JSON.stringify({ output: fake }) + "\n";
      yield* Effect.promise(() => NodeFSP.writeFile(file, original));
      const plan = yield* Effect.promise(() => planFile(file, [fake], marker));
      const failed = yield* rewriteFile(
        { ...plan, afterHash: "invalid-proof" },
        [fake],
        marker,
      ).pipe(Effect.flip);
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
