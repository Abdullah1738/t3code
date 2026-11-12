// @effect-diagnostics nodeBuiltinImport:off - Fixtures verify actual file bytes and native file modes.
import { it, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import { replaceText } from "./content.ts";
import { countFile, planFile, rewriteFile } from "./providerFiles.ts";

const marker = "[redacted fixture]";
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
