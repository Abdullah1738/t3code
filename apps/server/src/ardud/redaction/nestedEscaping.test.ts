// @effect-diagnostics nodeBuiltinImport:off - Fixtures verify actual file bytes and native file modes.
import { it, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import { replaceText } from "./content.ts";
import { countFile, planFile, rewriteFile } from "./providerFiles.ts";

const marker = "[redacted fixture]";
it.each(["[]", "{}", "[{}]", '["quoted"]', "[", "}"])(
  "preserves quoted token boundaries around %s in unframed text",
  (container) => {
    const source = 'prefix "fixture-\\u006futput ' + container.replaceAll('"', '\\"') + '" suffix';
    const replaced = replaceText(source, ["fixture-output"], marker);
    expect(replaced.count).toBe(1);
    expect(replaced.text).toBe("prefix " + JSON.stringify(marker + " " + container) + " suffix");
    expect(replaceText(replaced.text, ["fixture-output"], marker).count).toBe(0);
  },
);
it.each(["2718281828459045", "true", "false", "null", '"eyJFAKE.quoted"'])(
  "redacts raw multiline output containing a complete %s JSON scalar",
  (scalar) => {
    const value = "before\n" + scalar + "\nafter";
    const source = value + " " + JSON.stringify({ copy: value }) + " " + value;
    const replaced = replaceText(source, [value], marker);
    expect(replaced.count).toBe(3);
    expect(replaced.text.includes(value)).toBe(false);
    expect(replaceText(replaced.text, [value], marker).count).toBe(0);
  },
);
const mixedOutputs = [
  { output: "text", value: "eyJFAKE.MIXED" },
  { output: "inline JSON fragment", value: 'before {"part":"eyJFAKE.MIXED"} after' },
  { output: "two JSON fragments", value: '{"first":"eyJFAKE.MIXED"} {"second":"eyJFAKE.MIXED"}' },
  { output: "multiline", value: "before\neyJFAKE.MIXED.after" },
  { output: "multiline JSON fragment", value: 'before\n{"part":"eyJFAKE.MIXED"}\nafter' },
  { output: "quoted", value: '"eyJFAKE.MIXED"' },
  { output: "numeric", value: "2718281828459045" },
  { output: "document", value: '{"eyJFAKE":"mixed","parts":[1,2]}' },
];
const mixedFrames = [
  { frame: "JSONL", prefix: "" },
  { frame: "native timestamp", prefix: "[2026-11-12T00:00:00.000Z] NTIVE: " },
  { frame: "BOM orchestration timestamp", prefix: "\uFEFF[2026-11-12T00:00:00.000Z] ORCH: " },
  { frame: "canonical prefix", prefix: "CANON: " },
];
const inlineLayouts = [
  { layout: "prefix", copies: 2, make: (value: string, json: string) => value + " " + json },
  { layout: "suffix", copies: 2, make: (value: string, json: string) => json + " " + value },
  {
    layout: "both",
    copies: 3,
    make: (value: string, json: string) => value + " " + json + " " + value,
  },
  {
    layout: "two records",
    copies: 4,
    make: (value: string, json: string) => value + " " + json + " next " + json + " " + value,
  },
  {
    layout: "BOM frame",
    copies: 2,
    make: (value: string, json: string) =>
      "\uFEFF[2026-11-12T00:00:00.000Z] NTIVE: " + value + " " + json,
  },
  {
    layout: "pretty document",
    copies: 3,
    make: (value: string) => value + " " + JSON.stringify({ copy: value }, null, 2) + " " + value,
  },
  {
    layout: "array",
    copies: 2,
    make: (value: string) => value + " " + JSON.stringify([{ copy: value }]),
  },
];
it.effect.each(
  mixedOutputs.flatMap((output) => inlineLayouts.map((layout) => ({ ...output, ...layout }))),
)("redacts same-line $output copies around $layout JSON", ({ value, make, copies }) =>
  Effect.gen(function* () {
    const dir = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "inline-redaction-")),
    );
    try {
      const file = NodePath.join(dir, "fixture.log");
      const unchanged = "\nunrelated bytes é stay exact\r\n";
      yield* Effect.promise(() =>
        NodeFSP.writeFile(file, make(value, JSON.stringify({ copy: value })) + unchanged),
      );
      const plan = yield* Effect.promise(() => planFile(file, [value], marker));
      const result = yield* rewriteFile(plan, [value], marker);
      const rewritten = yield* Effect.promise(() => NodeFSP.readFile(file, "utf8"));
      expect(rewritten.includes(value)).toBe(false);
      expect(rewritten.endsWith(unchanged)).toBe(true);
      expect(result).toMatchObject({ matchedBefore: copies, replaced: copies, remainingAfter: 0 });
      expect(yield* Effect.promise(() => countFile(file, [value]))).toBe(0);
    } finally {
      yield* Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true }));
    }
  }),
);
it.effect.each(
  mixedOutputs.flatMap((output) =>
    mixedFrames.flatMap((frame) =>
      [false, true].map((plainFirst) => ({ ...output, ...frame, plainFirst })),
    ),
  ),
)(
  "redacts mixed $output $frame logs, plainFirst=$plainFirst in one pass",
  ({ value, prefix, plainFirst }) =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mixed-redaction-")),
      );
      try {
        const file = NodePath.join(dir, "fixture.log");
        const json = prefix + JSON.stringify({ copy: value }) + "\n";
        const plain = "bare copy: " + value + "\n";
        const unchanged = "unrelated bytes é remain exact\r\n";
        const original = (plainFirst ? plain + json : json + plain) + unchanged;
        yield* Effect.promise(() => NodeFSP.writeFile(file, original, { mode: 0o640 }));
        const plan = yield* Effect.promise(() => planFile(file, [value], marker));
        const result = yield* rewriteFile(plan, [value], marker);
        const rewritten = yield* Effect.promise(() => NodeFSP.readFile(file, "utf8"));
        expect(rewritten.includes(value)).toBe(false);
        expect(rewritten.endsWith(unchanged)).toBe(true);
        expect(result).toMatchObject({ matchedBefore: 2, replaced: 2, remainingAfter: 0 });
        expect(yield* Effect.promise(() => countFile(file, [value]))).toBe(0);
        const jsonLine = rewritten.split("\n")[plainFirst ? 1 : 0]!;
        expect(JSON.parse(jsonLine.slice(prefix.length)).copy).toBe(marker);
        expect((yield* Effect.promise(() => NodeFSP.stat(file))).mode & 0o777).toBe(0o640);
        expect(JSON.stringify(result).includes(value)).toBe(false);
      } finally {
        yield* Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true }));
      }
    }),
);
// The same class covers raw/quoted strings, all JSON-escaped characters and stream boundaries.
const forms = [
  { form: "newline", value: "before\neyJFAKE.NESTED.after" },
  { form: "CR/tab", value: "before\r\teyJFAKE.NESTED.after" },
  { form: "quotes", value: 'before "eyJFAKE.NESTED.after"' },
  { form: "backslashes", value: "before\\eyJFAKE.NESTED.after" },
  { form: "leading slash", value: "\\eyJFAKE.NESTED.after" },
  { form: "trailing slash", value: "before.eyJFAKE.NESTED\\" },
  { form: "controls", value: "before\u0000\b\feyJFAKE.NESTED.after" },
  { form: "mixed", value: 'before\n"\\éeyJFAKE.NESTED.after' },
];
const corpus = forms.flatMap((shape) =>
  [0, 1, 2, 3, 8, 16].flatMap((depth) =>
    [false, true].map((quoted) => ({ ...shape, depth, quoted })),
  ),
);
it.effect.each(corpus)(
  "redacts $form depth=$depth quoted=$quoted in text and physical files",
  ({ value, depth, quoted }) =>
    Effect.gen(function* () {
      let encoded = value;
      for (let i = 0; i < depth; i++)
        encoded = quoted ? JSON.stringify(encoded) : JSON.stringify(encoded).slice(1, -1);
      const unchanged = "unrelated line stays byte-identical\n";
      const text = unchanged + encoded;
      const replacement = replaceText(text, [value], marker);
      expect(replacement.count).toBe(1);
      expect(replacement.text.includes("eyJFAKE.NESTED")).toBe(false);
      expect(replacement.text.startsWith(unchanged)).toBe(true);
      const dir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "nested-redaction-")),
      );
      try {
        const file = NodePath.join(dir, "fixture.log");
        yield* Effect.promise(() => NodeFSP.writeFile(file, text));
        expect(yield* Effect.promise(() => countFile(file, [value]))).toBeGreaterThan(0);
        const plan = yield* Effect.promise(() => planFile(file, [value], marker));
        const result = yield* rewriteFile(plan, [value], marker);
        expect(result).toMatchObject({ matchedBefore: 1, replaced: 1, remainingAfter: 0 });
        expect(yield* Effect.promise(() => countFile(file, [value]))).toBe(0);
        expect(yield* Effect.promise(() => NodeFSP.readFile(file, "utf8"))).toBe(replacement.text);
        expect(JSON.stringify(result).includes("eyJFAKE.NESTED")).toBe(false);
      } finally {
        yield* Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true }));
      }
    }),
);

const alternateForms = [
  {
    form: "unicode lowercase",
    value: "eyJFAKE/alternate",
    encode: (text: string) => JSON.stringify(text).replace("e", "\\u0065"),
  },
  {
    form: "unicode uppercase",
    value: "eyJFAKE/alternate",
    encode: (text: string) => JSON.stringify(text).replace("J", "\\u004A"),
  },
  {
    form: "escaped slash",
    value: "eyJFAKE/alternate",
    encode: (text: string) => JSON.stringify(text).replace("/", "\\/"),
  },
  {
    form: "unicode quote",
    value: 'eyJFAKE"alternate',
    encode: (text: string) => JSON.stringify(text).replace('\\"', "\\u0022"),
  },
  {
    form: "unicode newline",
    value: "eyJFAKE\nalternate",
    encode: (text: string) => JSON.stringify(text).replace("\\n", "\\u000a"),
  },
  {
    form: "unicode slash",
    value: "eyJFAKE\\alternate",
    encode: (text: string) => JSON.stringify(text).replace("\\\\", "\\u005c"),
  },
  {
    form: "surrogate pair",
    value: "eyJFAKE😀alternate",
    encode: (text: string) => JSON.stringify(text).replace("😀", "\\ud83d\\ude00"),
  },
  {
    form: "every character",
    value: "eyJFAKE/alternate",
    encode: (text: string) =>
      '"' +
      text
        .split("")
        .map((c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"))
        .join("") +
      '"',
  },
];
it.effect.each(
  alternateForms.flatMap((shape) =>
    [0, 1, 3].flatMap((depth) => [false, true].map((prefixed) => ({ ...shape, depth, prefixed }))),
  ),
)(
  "redacts alternate $form escaping depth=$depth prefixed=$prefixed",
  ({ value, encode, depth, prefixed }) =>
    Effect.gen(function* () {
      let nested = encode(value);
      for (let i = 0; i < depth; i++) nested = JSON.stringify(nested);
      const line = (prefixed ? "NTIVE: " : "") + '{ "summary": ' + nested + " }\n";
      const unchanged = '{ "other": "unchanged" }\n';
      const dir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "alternate-redaction-")),
      );
      try {
        const file = NodePath.join(dir, prefixed ? "fixture.log" : "fixture.jsonl");
        yield* Effect.promise(() => NodeFSP.writeFile(file, unchanged + line));
        expect(yield* Effect.promise(() => countFile(file, [value]))).toBeGreaterThan(0);
        const plan = yield* Effect.promise(() => planFile(file, [value], marker));
        const result = yield* rewriteFile(plan, [value], marker);
        expect(result.remainingAfter).toBe(0);
        expect(result.replaced).toBeGreaterThan(0);
        const rewritten = yield* Effect.promise(() => NodeFSP.readFile(file, "utf8"));
        expect(rewritten.startsWith(unchanged)).toBe(true);
        expect(
          rewritten
            .trim()
            .split("\n")
            .every((v) => JSON.parse(v.replace(/^NTIVE: /, ""))),
        ).toBe(true);
        expect(yield* Effect.promise(() => countFile(file, [value]))).toBe(0);
      } finally {
        yield* Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true }));
      }
    }),
);

it.effect("quoted output never consumes another JSON value's string delimiters", () =>
  Effect.gen(function* () {
    const value = '"eyJFAKE.quoted"';
    const dir = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "quoted-redaction-")),
    );
    try {
      const file = NodePath.join(dir, "fixture.jsonl");
      const unchanged = '{ "other": "eyJFAKE.quoted" }\n';
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          file,
          JSON.stringify({ type: "tool_result", tool_use_id: "call-fixture", content: value }) +
            "\n" +
            unchanged,
        ),
      );
      const plan = yield* Effect.promise(() => planFile(file, [value], marker));
      yield* rewriteFile(plan, [value], marker);
      const rewritten = yield* Effect.promise(() => NodeFSP.readFile(file, "utf8"));
      expect(rewritten.endsWith(unchanged)).toBe(true);
      expect(
        rewritten
          .trim()
          .split("\n")
          .every((v) => JSON.parse(v.replace(/^NTIVE: /, ""))),
      ).toBe(true);
    } finally {
      yield* Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true }));
    }
  }),
);
