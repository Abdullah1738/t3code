import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import guard, { createGuardHook } from "../plugin/codemode-guard";
import { neverSettles } from "../lib/codemode-never-settles.mjs";
import { neverSettles as stallNeverSettles } from "../../stream-recovery/lib/codemode-never-settles.mjs";

const blocked = [
  "new Promise(r=>r)", "new Promise(r => r)", "new Promise((r)=>r)",
  "new Promise(()=>{})", "new Promise(function(){})", "new Promise(res => {})",
  "await tools.dia.dia_navigate({}); await new Promise(r=>r)",
  "new Promise((res, rej) => { console.log('waiting'); })",
  "new Promise(function wait(resolve, reject) { return 1; })",
  "new /* wait */ Promise((resolve) => { /* nothing */ })",
  "new Promise(r => { return r; })", "new Promise(r => ((r)))",
  "new Promise(r => { r; })", "new Promise(function(r) { return r; })",
  "new Promise(res => { console.log('res'); })",
  "new Promise((res, rej) => rej)", "new Promise((res,) => {})",
  "new Promise(r => { console.log(1); return; })",
  "new\nPromise\n((r)\n=>\n{ })",
  "new Promise(r => { /* r() */ })",
  "new Promise(r => { const constructor = 1; })",
  "new Promise(() => { const x = {nested: [1, 2]}; })",
  "new Promise(r => r); new Promise(r => r())",
];
const allowed = [
  "new Promise(r => setTimeout(r, 10))",
  'new Promise((res, rej) => x.on("done", res))',
  "new Promise(r => { cb(r) })", "new Promise(r => r())",
  "new Promise((r, reject) => reject(new Error('no')))",
  "new Promise((res, rej) => { throw 'no'; })", "new Promise(function(r) { r(); })",
  "new Promise(r => { return (r()); })", "new Promise((res, rej) => { cb(rej) })",
  "new Promise(() => { throw new Error('rejected') })",
  'const example = "new Promise(r=>r)";',
  "// new Promise(r=>r)\nreturn 1", "/* new Promise(()=>{}) */ return 1",
  "const example = `new Promise(r=>r)`;", "new Promise(r => `done: ${r()}`)",
  'const example = /new Promise\\(r=>r\\)/;',
  "new Promise(r => r(1 / 2))",
  "new Promise(({resolve}) => cb(resolve))", "new Promise(async r => r())",
  "new Promise(handler)", "Promise.resolve(1)", "return 1", "new Promise(",
  "await new Promise((res, rej) => { save = res; })",
  "await new Promise(resolve => { listeners.push(resolve); })",
];

const implicitCallbackForms = [
  ["resolve index", "return await new Promise(function() { arguments[0](42); });"],
  ["reject index", "return await new Promise(function() { arguments[1]('no'); });"],
  ["unused formal", "return await new Promise(function(res) { arguments[0](42); });"],
  ["named executor", "return await new Promise(function done() { arguments[0](42); });"],
  ["string index", "return await new Promise(function() { arguments['0'](42); });"],
  ["alias", "return await new Promise(function() { const resolve = arguments[0]; resolve(42); });"],
  ["callback handoff", "return await new Promise(function() { cb(arguments[0]); });"],
  ["lexical arguments", "return await new Promise(function() { (() => arguments[0](42))(); });"],
];
const slashContexts = [
  ["if", 'if (true) /new Promise(r=>r)/.test("test"); return 1;'],
  ["nested condition", 'if ((true)) /new Promise(r=>r)/.test("test"); return 1;'],
  ["while", 'while (false) /new Promise(r=>r)/.test("test"); return 1;'],
  ["for", 'for (; false;) /new Promise(r=>r)/.test("test"); return 1;'],
  ["for of", 'for (const x of []) /new Promise(r=>r)/.test(x); return 1;'],
  ["block", 'if (true) {} /new Promise(r=>r)/.test("test"); return 1;'],
  ["else", 'if (false) {} else /new Promise(r=>r)/.test("test"); return 1;'],
  ["do", 'do /new Promise(r=>r)/.test("test"); while (false); return 1;'],
  ["label", 'label: /new Promise(r=>r)/.test("test"); return 1;'],
  ["escaped slash and class", 'if (true) /[/]new Promise(r=>r)\\//.test("test"); return 1;'],
  ["division ambiguity", 'const half = value / 2; return await new Promise(r=>r);'],
];

describe("neverSettles", () => {
  for (const code of blocked) test(`blocks ${code}`, () => {
    expect(neverSettles(code)).toBe(true);
    expect(stallNeverSettles(code)).toBe(true);
  });
  for (const code of allowed) test(`allows ${code}`, () => {
    expect(neverSettles(code)).toBe(false);
    expect(stallNeverSettles(code)).toBe(false);
  });
  for (const [shape, code] of [...implicitCallbackForms, ...slashContexts]) test(`allows uncertain ${shape}`, () => {
    expect(neverSettles(code)).toBe(false);
    expect(stallNeverSettles(code)).toBe(false);
  });
  test("non-string input is clean", () => {
    for (const code of [undefined, null, 4, {}, []]) expect(neverSettles(code)).toBe(false);
  });
  test("the separately deployed detector copies stay identical", () => {
    expect(readFileSync(new URL("../lib/codemode-never-settles.mjs", import.meta.url), "utf8"))
      .toBe(readFileSync(new URL("../../stream-recovery/lib/codemode-never-settles.mjs", import.meta.url), "utf8"));
  });
});

type Event = { tool: string; sessionID?: string; input: { code?: string; [key: string]: unknown } };

test("the registered hook rewrites only execute, preserving the rest of its input", async () => {
  const hooks = new Map<string, (e: Event) => Promise<void>>();
  // Probe the real registration with a non-execute tool so no live log is written.
  await guard.setup({ tool: { hook: async (name, fn) => { hooks.set(name, fn); } } });
  for (const tool of ["shell", "bash", "read", "dia_evaluate"]) {
    const other: Event = { tool, input: { code: "new Promise(r=>r)" } };
    const input = other.input;
    await hooks.get("execute.before")!(other);
    expect(other.input).toBe(input);
  }

  const records: Record<string, unknown>[] = [];
  const hook = createGuardHook({ mode: () => "enforce", log: record => { records.push(record); } });
  const clean: Event = { tool: "execute", input: { code: "return 1" } };
  const original = clean.input;
  await hook(clean);
  expect(clean.input).toBe(original);
  const bad: Event = { tool: "execute", sessionID: "ses_test", input: { code: "new Promise(r=>r)" + " ".repeat(400), extra: 1 } };
  await hook(bad);
  expect(bad.input.extra).toBe(1);
  expect(bad.input.code).toContain('throw new Error("codemode-guard:');
  expect(() => new Function(bad.input.code!)()).toThrow("Code Mode has no timers");
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({ event: "deny", session: "ses_test" });
  expect(String(records[0].code)).toHaveLength(300);
});

test("off mode leaves invalid waits alone", async () => {
  const e: Event = { tool: "execute", input: { code: "new Promise(()=>{})" } };
  await createGuardHook({ mode: () => "off", log: () => { throw new Error("should not log"); } })(e);
  expect(e.input.code).toBe("new Promise(()=>{})");
});

test("implicit callbacks and ambiguous regexp contexts are not rewritten", async () => {
  const records: Record<string, unknown>[] = [];
  const hook = createGuardHook({ mode: () => "enforce", log: record => { records.push(record); } });
  for (const [, code] of [...implicitCallbackForms, ...slashContexts]) {
    const input = { code };
    const e = { tool: "execute", input };
    await hook(e);
    expect(e.input).toBe(input);
  }
  expect(records).toHaveLength(0);
});

test("missing or non-string code inputs stay untouched", async () => {
  const hook = createGuardHook({ mode: () => "enforce", log: () => { throw new Error("should not log"); } });
  for (const input of [undefined, {}, { code: null }, { code: 1 }]) {
    const e = { tool: "execute", input };
    await hook(e);
    expect(e.input).toBe(input);
  }
});

test("errors in the hook fail open even if logging also throws", async () => {
  const e: Event = { tool: "execute", input: { code: "new Promise(()=>{})" } };
  const input = e.input;
  await createGuardHook({ mode: () => { throw new Error("config broke"); }, log: () => { throw new Error("disk broke"); } })(e);
  expect(e.input).toBe(input);
  await createGuardHook({ mode: () => "enforce", log: () => { throw new Error("log broke"); } })(e);
  expect(e.input).toBe(input);
  const broken = { tool: "execute", get input(): Event["input"] { throw new Error("bad input"); } };
  await createGuardHook({ mode: () => "enforce", log: () => {} })(broken);
});

test("hook registration failures do not break plugin setup", async () => {
  await guard.setup({ tool: { hook: async () => { throw new Error("hook unavailable"); } } });
});
