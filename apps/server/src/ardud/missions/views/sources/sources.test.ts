// @effect-diagnostics nodeBuiltinImport:off - the runner test needs a real scratch dir.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import type { MissionViewsSnapshot, ViewDataSourceId, ViewSourceFields } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  agent,
  failureCode,
  masterThread,
  missionId,
  ownerApp,
  seed,
  writerThread,
} from "../../asks/AsksService.testkit.ts";
import { fresh } from "../views.testkit.ts";
import { ViewService } from "../ViewService.ts";
import { parseSourceOutput } from "./rows.ts";
import { runScript, scriptEnv } from "./runner.ts";

const fields: ViewSourceFields = {
  title: "text",
  state: "enum",
  who: "actor",
  issue: "link",
  updated: "time",
};

const output = (rows: ReadonlyArray<unknown>) => JSON.stringify({ rows });

describe("parseSourceOutput", () => {
  it("normalizes declared fields and drops the rest", () => {
    const parsed = parseSourceOutput(
      output([
        {
          id: 7,
          title: "Fix login",
          state: "In Review",
          who: "Sam",
          issue: { url: "https://linear.app/x/issue/CRP-7", label: "CRP-7" },
          updated: "2026-10-20T10:00:00Z",
          secret: "dropped",
        },
      ]),
      fields,
    );
    assert.isTrue(parsed.ok);
    if (!parsed.ok) return;
    const [row] = parsed.rows;
    assert.equal(row?.id, "7");
    assert.deepStrictEqual(row?.who, { _tag: "person", name: "Sam" });
    assert.deepStrictEqual(row?.issue, {
      kind: "url",
      label: "CRP-7",
      url: "https://linear.app/x/issue/CRP-7",
      ref: null,
    });
    assert.equal(row?.updated, "2026-10-20T10:00:00.000Z");
    assert.isFalse(row !== undefined && Object.hasOwn(row, "secret"));
  });

  it("keeps the last chart points of a series field", () => {
    const series = { burn: "series" } as const;
    const points = Array.from({ length: 70 }, (_, index) => index);
    const parsed = parseSourceOutput(output([{ id: "a", burn: points }]), series);
    assert.isTrue(parsed.ok);
    if (!parsed.ok) return;
    assert.deepStrictEqual(parsed.rows[0]?.burn, points.slice(10));
    const bad = parseSourceOutput(output([{ id: "a", burn: [1, "2"] }]), series);
    assert.isFalse(bad.ok);
  });

  it("fails the run on bad output", () => {
    const cases = [
      ["not json", "not JSON"],
      [JSON.stringify([{ id: "a" }]), "rows"],
      [output([{ title: "no id" }]), "id"],
      [output([{ id: "a" }, { id: "a" }]), "duplicate"],
      [output([{ id: "a", issue: "http://example.com" }]), "https"],
      [output([{ id: "a", updated: "yesterday-ish" }]), "updated"],
      [output(Array.from({ length: 501 }, (_, index) => ({ id: String(index) }))), "500"],
    ] as const;
    for (const [stdout, expected] of cases) {
      const parsed = parseSourceOutput(stdout, fields);
      assert.isFalse(parsed.ok, stdout.slice(0, 40));
      if (parsed.ok) continue;
      assert.include(parsed.errors.join("\n"), expected);
    }
  });
});

describe("runner", () => {
  const dir = () => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-source-"));

  it("keeps Robob tokens out of the script env", () => {
    const env = scriptEnv({ PATH: "/bin", T3CODE_HOME: "x", ROBOB_TOKEN: "y", HOME: "/h" });
    assert.deepStrictEqual(env, { PATH: "/bin", HOME: "/h", NO_COLOR: "1" });
  });

  it.effect("runs in a scratch dir with stdin closed", () =>
    Effect.gen(function* () {
      const result = yield* runScript({
        runtime: "bash",
        code: 'read -r line || echo "stdin closed" >&2; printf \'{"rows":[{"id":"%s"}]}\' "$(basename "$PWD")"',
        dir: dir(),
        timeoutMs: 10_000,
      });
      assert.equal(result.exitCode, 0);
      assert.isFalse(result.timedOut);
      assert.include(result.stdout, '"id":"work"');
      assert.include(result.stderr, "stdin closed");
    }),
  );

  it.effect("kills a script that runs past its timeout", () =>
    Effect.gen(function* () {
      const result = yield* runScript({
        runtime: "bash",
        code: "sleep 30",
        dir: dir(),
        timeoutMs: 300,
      });
      assert.isTrue(result.timedOut);
      assert.isBelow(result.durationMs, 10_000);
    }),
  );
});

const script = (rows: ReadonlyArray<unknown>) => `cat <<'JSON'\n${output(rows)}\nJSON`;

describe("view sources", () => {
  it.effect("feeds a section, keeps the last good rows when a run fails", () =>
    fresh(
      Effect.gen(function* () {
        yield* seed;
        const views = yield* ViewService;
        const set = yield* views.setSource(ownerApp, {
          missionId,
          title: "Linear issues",
          runtime: "bash",
          code: script([
            { id: "CRP-1", title: "First", state: "Todo" },
            { id: "CRP-2", title: "Second", state: "Done" },
          ]),
          fields: { title: "text", state: "enum" },
        });
        const sourceId = set.ref.id as ViewDataSourceId;
        const ran = yield* views.runSource(ownerApp, { missionId, sourceId });
        assert.isTrue(ran.ok, ran.errors.join("; "));
        assert.equal(ran.total, 2);

        const placed = yield* views.placeSection(ownerApp, {
          missionId,
          definition: {
            key: "linear",
            title: "Linear",
            source: { _tag: "source", sourceId, where: { state: "Todo" }, limit: 5 },
            body: [{ _tag: "list", title: "row.title", meta: ["row.state"], status: null }],
          },
        });
        const rowsOf = (snapshot: MissionViewsSnapshot) =>
          snapshot.sectionData?.find((data) => data.sectionId === placed.ref.id);
        const first = yield* views.snapshot(missionId);
        assert.deepStrictEqual(
          rowsOf(first)?.rows.map((row) => row.value.title),
          ["First"],
        );
        assert.equal(first.sources?.[0]?.title, "Linear issues");
        assert.isFalse(first.sources?.[0] !== undefined && "code" in first.sources[0]);

        yield* views.setSource(ownerApp, {
          missionId,
          sourceId,
          code: 'echo "linctl: not logged in" >&2; exit 3',
        });
        const failed = yield* views.runSource(ownerApp, { missionId, sourceId });
        assert.isFalse(failed.ok);
        assert.include(failed.stderr, "not logged in");
        const after = yield* views.snapshot(missionId);
        assert.deepStrictEqual(
          rowsOf(after)?.rows.map((row) => row.value.title),
          ["First"],
        );
        const status = after.sourceRuns?.find((run) => run.sourceId === sourceId);
        assert.include(status?.error ?? "", "not logged in");
        assert.isNotNull(status?.okAt ?? null);
      }),
    ),
  );

  it.effect("checks section binds against the declared fields", () =>
    fresh(
      Effect.gen(function* () {
        yield* seed;
        const views = yield* ViewService;
        const set = yield* views.setSource(ownerApp, {
          missionId,
          title: "PRs",
          runtime: "bash",
          code: script([]),
          fields: { title: "text" },
        });
        const sourceId = set.ref.id as ViewDataSourceId;
        const place = (bind: string, where?: Record<string, string>) =>
          failureCode(
            views.placeSection(ownerApp, {
              missionId,
              definition: {
                key: "prs",
                title: "PRs",
                source: { _tag: "source", sourceId, ...(where ? { where } : {}), limit: 5 },
                body: [{ _tag: "list", title: bind, meta: [], status: null }],
              },
            }),
          );
        assert.equal(yield* place("row.author"), "invalid");
        assert.equal(yield* place("row.title", { state: "open" }), "invalid");
        assert.equal(yield* place("row.age"), "invalid");
      }),
    ),
  );

  it.effect("lets only the owner or the master define and run sources", () =>
    fresh(
      Effect.gen(function* () {
        yield* seed;
        const views = yield* ViewService;
        const input = {
          missionId,
          title: "Mine",
          runtime: "bash" as const,
          code: script([]),
          fields: { title: "text" as const },
        };
        assert.equal(yield* failureCode(views.setSource(agent(writerThread), input)), "forbidden");
        const set = yield* views.setSource(agent(masterThread), input);
        const sourceId = set.ref.id as ViewDataSourceId;
        assert.equal(
          yield* failureCode(views.runSource(agent(writerThread), { missionId, sourceId })),
          "forbidden",
        );
        yield* views.removeSource(agent(masterThread), { missionId, sourceId });
        assert.equal(
          yield* failureCode(views.runSource(ownerApp, { missionId, sourceId })),
          "conflict",
        );
        yield* views.restoreSource(ownerApp, { missionId, sourceId });
        const history = yield* views.history({
          missionId,
          target: { _tag: "source", id: sourceId },
        });
        assert.deepStrictEqual(
          history.entries.map((entry) => entry.status),
          ["active", "removed", "active"],
        );
      }),
    ),
  );
});
