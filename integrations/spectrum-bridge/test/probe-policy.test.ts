import { afterEach, expect, setSystemTime, test } from "bun:test";
import { ProbeBackoff, ProbeBudget } from "../src/probe-policy.ts";
import { Store } from "../src/store.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

afterEach(() => setSystemTime());

test("rolling retry budget is shared and survives recreation", () => {
  const store = new Store(":memory:");
  try {
    const now = 1_800_000_000_000;
    setSystemTime(now);
    const a = new ProbeBudget(store), b = new ProbeBudget(store);
    for (let i = 0; i < 60; i++) expect((i % 2 ? a : b).take()).toBe(true);
    expect(new ProbeBudget(store).take()).toBe(false);
    setSystemTime(now + 59_999); expect(a.take()).toBe(false);
    setSystemTime(now + 60_000); expect(a.take()).toBe(true);
  } finally { store.close(); }
});

test("a crash during admission read preserves an uncertainty lease", () => {
  const store = new Store(":memory:");
  try {
    const now = 1_800_000_000_000;
    setSystemTime(now);
    new ProbeBackoff(store).reserve("leader");
    const restarted = new ProbeBackoff(store);
    setSystemTime(now + 59_999); expect(restarted.cooling("leader")).toBe(true);
    setSystemTime(now + 60_000); expect(restarted.cooling("leader")).toBe(false);
  } finally { store.close(); }
});


test("shared prompt cooldown and retry classification follow every prior leader", () => {
  const store = new Store(":memory:");
  try {
    const now = 1_800_000_000_000; setSystemTime(now);
    const policy = new ProbeBackoff(store);
    policy.reserve("member", "prompt:old"); policy.release("member"); policy.clear("prompt:old");
    policy.reserve("leader", "prompt:old"); policy.failed("leader"); policy.failed("prompt:old");
    const restarted = new ProbeBackoff(store);
    expect(restarted.cooling("member")).toBe(true);
    expect(restarted.retry("member")).toBe(true);
    setSystemTime(now + 60_000);
    expect(restarted.cooling("member")).toBe(false);
    expect(restarted.retry("member")).toBe(true);
  } finally { store.close(); }
});

test("split members retain cooldown and retry step across a store restart and independent settlement", () => {
  const root = mkdtempSync(join(tmpdir(), "split-probe-"));
  let store = new Store(join(root, "state.sqlite"));
  try {
    const now = 1_800_000_000_000; setSystemTime(now);
    const policy = new ProbeBackoff(store);
    const lease = policy.reserve("leader", "prompt:old");
    policy.failed("leader"); policy.failed("leader");
    policy.split("leader", ["leader", "member"]);
    expect(policy.get("leader")?.token).not.toBe(lease.token);
    expect(policy.get("member")?.token).not.toBe(policy.get("leader")?.token);
    policy.clear("leader"); policy.clear("prompt:old");
    store.close(); store = new Store(join(root, "state.sqlite"));
    const restarted = new ProbeBackoff(store);
    setSystemTime(now + 119_999);
    expect(restarted.cooling("member")).toBe(true);
    expect(restarted.retry("member")).toBe(true);
    setSystemTime(now + 120_000);
    expect(restarted.cooling("member")).toBe(false);
    expect(restarted.retry("member")).toBe(true);
    restarted.reserve("member", "prompt:old");
    expect(restarted.failed("member").delay).toBe(240_000);
    restarted.clear("member"); restarted.failed("leader");
    expect(restarted.cooling("member")).toBe(false);
    expect(restarted.retry("member")).toBe(false);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
