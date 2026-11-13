import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const python = "/usr/bin/python3";
const macros = join(root, "sources/macros.py");
const board = join(root, "sources/board_progress.py");
const fixtures = ["ROBOB_WIDGETS_MACROS_FIXTURE", "ROBOB_WIDGETS_BOARD_FIXTURE"];

function cleanEnv(extra = {}) {
  const env = { ...process.env, PYTHONDONTWRITEBYTECODE: "1", ...extra };
  for (const name of fixtures) if (!(name in extra)) delete env[name];
  return env;
}

async function withFixture(value, fn) {
  const dir = await mkdtemp(join(tmpdir(), "robob-widget-source-test-"));
  const file = join(dir, "fixture.json");
  try {
    await writeFile(file, JSON.stringify(value));
    return await fn(file, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function run(source, args, env = {}) {
  return spawnSync(python, [source, ...args], {
    encoding: "utf8",
    env: cleanEnv(env),
    timeout: 10000,
  });
}

function success(result) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  return JSON.parse(result.stdout);
}

const nutrition = {
  date: "2026-11-04",
  total: { kcal: 1972, protein_g: 186.2, carbs_g: 209.1, fat_g: 41.2 },
  target: { kcal: 1900, protein_g: 170, carbs_g: 115, fat_g: 85 },
  remaining: { kcal: -72, protein_g: -16, carbs_g: -94, fat_g: 44 },
};

test("macros render current totals, targets and signed remaining numbers", async () => {
  await withFixture(nutrition, (path) => {
    const actual = success(run(macros, [], { ROBOB_WIDGETS_MACROS_FIXTURE: path }));
    assert.deepEqual(actual, {
      blocks: [
        {
          type: "rings",
          items: [
            { label: "kcal", value: 1972, max: 1900, unit: "" },
            { label: "P", value: 186.2, max: 170, unit: "g" },
            { label: "C", value: 209.1, max: 115, unit: "g" },
            { label: "F", value: 41.2, max: 85, unit: "g" },
          ],
        },
        { type: "stat", label: "Left", value: "-72 kcal", delta: "P -16 · C -94 · F 44 left" },
      ],
    });
  });
});

test("macros without targets render totals only", async () => {
  await withFixture({ date: "2026-11-04", total: nutrition.total }, (path) => {
    assert.deepEqual(success(run(macros, [], { ROBOB_WIDGETS_MACROS_FIXTURE: path })), {
      blocks: [
        {
          type: "list",
          rows: [
            { label: "kcal", value: "1972 kcal" },
            { label: "P", value: "186.2 g" },
            { label: "C", value: "209.1 g" },
            { label: "F", value: "41.2 g" },
          ],
        },
      ],
    });
  });
});

test("macros retain untargeted totals when only some targets exist", async () => {
  await withFixture(
    {
      total: nutrition.total,
      target: { kcal: 1900, protein_g: 170, carbs_g: null, fat_g: 85 },
      remaining: { kcal: -72, protein_g: -16, fat_g: 44 },
    },
    (path) => {
      const { blocks } = success(run(macros, [], { ROBOB_WIDGETS_MACROS_FIXTURE: path }));
      assert.deepEqual(
        blocks[0].items.map((item) => item.label),
        ["kcal", "P", "F"],
      );
      assert.equal(blocks[1].delta, "P -16 · F 44 left");
      assert.deepEqual(blocks[2], { type: "list", rows: [{ label: "C", value: "209.1 g" }] });
    },
  );
});

test("malformed totals and missing remaining values fail rather than fabricate output", async () => {
  for (const value of [
    {
      total: { ...nutrition.total, kcal: null },
      target: nutrition.target,
      remaining: nutrition.remaining,
    },
    { ...nutrition, remaining: {} },
    { ...nutrition, target: [] },
  ]) {
    await withFixture(value, (path) => {
      const result = run(macros, [], { ROBOB_WIDGETS_MACROS_FIXTURE: path });
      assert.notEqual(result.status, 0);
      assert.equal(result.stdout, "");
    });
  }
});

test("escaped SQLite URI opens the intended file read-only and reads committed WAL data", async () => {
  // WAL readers may update -shm coordination metadata. Database and WAL
  // bytes must not change; the reader must see a writer's uncheckpointed row.
  await withFixture(null, async (_path, dir) => {
    const probe = `
import hashlib, importlib.util, json, os, pathlib, sqlite3, sys
spec = importlib.util.spec_from_file_location("widget_macros", sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
path = pathlib.Path(sys.argv[2]) / "nutrition #%?.db"
writer = sqlite3.connect(path)
writer.execute("PRAGMA journal_mode=WAL")
writer.execute("PRAGMA wal_autocheckpoint=0")
writer.execute("CREATE TABLE samples (value TEXT)")
writer.execute("INSERT INTO samples VALUES ('fresh WAL row')")
writer.commit()
wal = pathlib.Path(str(path) + "-wal")
def sig(p):
    data = p.read_bytes()
    return [len(data), hashlib.sha256(data).hexdigest()]
before = [sig(path), sig(wal)]
uri = "file:" + mod.read_only_uri_path(path)
reader = sqlite3.connect(uri, uri=True)
value = reader.execute("SELECT value FROM samples").fetchone()[0]
try:
    reader.execute("INSERT INTO samples VALUES ('not allowed')")
except sqlite3.OperationalError as exc:
    blocked = "readonly" in str(exc).lower() or "read-only" in str(exc).lower()
else:
    blocked = False
reader.close()
after = [sig(path), sig(wal)]
print(json.dumps({"uri": uri, "value": value, "blocked": blocked, "before": before, "after": after}))
writer.close()
`;
    const result = spawnSync(python, ["-c", probe, macros, dir], {
      encoding: "utf8",
      env: cleanEnv(),
      timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr);
    const value = JSON.parse(result.stdout);
    assert.match(value.uri, /nutrition%20%23%25%3F\.db\?mode=ro$/);
    assert.equal(value.value, "fresh WAL row");
    assert.equal(value.blocked, true);
    assert.deepEqual(value.before, value.after);
  });
});

const stages = [
  "todo",
  "working",
  "needs_review",
  "in_review",
  "completed",
  "deployed",
  "verified",
  "needs_owner",
];
const goal = "goal-native";
const boardSnapshot = {
  board: { id: "board-crpko", slug: "crpko" },
  goals: [{ id: goal, name: "Native v1 rebuild" }, { id: "goal-other" }],
  cards: [
    ...stages.map((stage) => ({ stage, priority: 3, goalId: goal })),
    { stage: "verified", priority: 1, goalId: goal },
    ...stages.map((stage) => ({ stage, priority: 5, goalId: goal })),
    { stage: "completed", priority: 4, goalId: "goal-other" },
    { stage: "todo", priority: 1, goalId: null },
  ],
};

test("board progress filters goal and priority-5 backlog in every stage", async () => {
  await withFixture(boardSnapshot, (path) => {
    const result = success(
      run(board, ["board-crpko", "--goal", goal], { ROBOB_WIDGETS_BOARD_FIXTURE: path }),
    );
    assert.deepEqual(result, {
      blocks: [
        { type: "progress", label: "Done", value: 4, max: 9 },
        {
          type: "list",
          rows: [
            { label: "Todo", value: "1" },
            { label: "Working", value: "1" },
            { label: "Needs review", value: "1" },
            { label: "In review", value: "1" },
            { label: "Completed", value: "1" },
            { label: "Deployed", value: "1" },
            { label: "Verified", value: "2" },
            { label: "Needs owner", value: "1" },
          ],
        },
      ],
    });
    const wholeBoard = success(run(board, ["crpko"], { ROBOB_WIDGETS_BOARD_FIXTURE: path }));
    assert.deepEqual(wholeBoard.blocks[0], { type: "progress", label: "Done", value: 5, max: 11 });
  });
});

test("zero cards, future stages, missing goals, and bad responses are not miscounted", async () => {
  await withFixture({ ...boardSnapshot, cards: [] }, (path) => {
    const empty = success(
      run(board, ["crpko", "--goal", goal], { ROBOB_WIDGETS_BOARD_FIXTURE: path }),
    );
    assert.deepEqual(empty.blocks[0], { type: "progress", label: "Done", value: 0, max: 0 });
    assert.ok(empty.blocks[1].rows.every((row) => row.value === "0"));
    assert.notEqual(
      run(board, ["crpko", "--goal", "goal-missing"], { ROBOB_WIDGETS_BOARD_FIXTURE: path }).status,
      0,
    );
    assert.notEqual(run(board, ["another-board"], { ROBOB_WIDGETS_BOARD_FIXTURE: path }).status, 0);
  });
  await withFixture(
    { ...boardSnapshot, cards: [{ stage: "new_stage", priority: 2, goalId: goal }] },
    (path) => {
      const result = success(run(board, ["crpko"], { ROBOB_WIDGETS_BOARD_FIXTURE: path }));
      assert.deepEqual(result.blocks[0], { type: "progress", label: "Done", value: 0, max: 1 });
      assert.deepEqual(result.blocks[1].rows.at(-1), { label: "New stage", value: "1" });
    },
  );
  await withFixture({ board: { id: "board-crpko", slug: "crpko" } }, (path) => {
    const result = run(board, ["crpko"], { ROBOB_WIDGETS_BOARD_FIXTURE: path });
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
  });
});

test("live board request uses local credential, encoded path and GET only", async () => {
  await withFixture(null, async (_path, dir) => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(dir, ".robob", "components"), { recursive: true });
    let request;
    const server = createServer((req, res) => {
      request = { path: req.url, auth: req.headers.authorization, method: req.method };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ...boardSnapshot, board: { id: "board #1", slug: "slug" } }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      await writeFile(
        join(dir, ".robob", "components", "t3ctl.json"),
        JSON.stringify({
          url: `http://127.0.0.1:${server.address().port}`,
          token: "test-secret-only",
        }),
      );
      const result = await new Promise((resolve, reject) => {
        const child = spawn(python, [board, "board #1", "--goal", goal], {
          env: cleanEnv({ HOME: dir }),
        });
        let stdout = "",
          stderr = "";
        child.stdout.on("data", (data) => {
          stdout += data;
        });
        child.stderr.on("data", (data) => {
          stderr += data;
        });
        child.on("error", reject);
        child.on("close", (status) => resolve({ status, stdout, stderr }));
      });
      assert.equal(success(result).blocks[0].value, 4);
      assert.deepEqual(request, {
        path: "/api/ardud/kanban/boards/board%20%231",
        auth: "Bearer test-secret-only",
        method: "GET",
      });
      assert.doesNotMatch(result.stdout + result.stderr, /test-secret-only/);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

test("board source will not forward its bearer credential to redirect destinations", async () => {
  await withFixture(null, async (_path, dir) => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(dir, ".robob", "components"), { recursive: true });
    let redirectsReached = 0;
    const server = createServer((req, res) => {
      if (req.url === "/redirect-destination") {
        redirectsReached++;
        res.end("not allowed");
      } else {
        res.writeHead(302, { location: "/redirect-destination" });
        res.end();
      }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      await writeFile(
        join(dir, ".robob", "components", "t3ctl.json"),
        JSON.stringify({
          url: `http://127.0.0.1:${server.address().port}`,
          token: "test-secret-only",
        }),
      );
      const result = await new Promise((resolve, reject) => {
        const child = spawn(python, [board, "board-crpko"], { env: cleanEnv({ HOME: dir }) });
        let stdout = "",
          stderr = "";
        child.stdout.on("data", (data) => {
          stdout += data;
        });
        child.stderr.on("data", (data) => {
          stderr += data;
        });
        child.on("error", reject);
        child.on("close", (status) => resolve({ status, stdout, stderr }));
      });
      assert.notEqual(result.status, 0);
      assert.equal(result.stdout, "");
      assert.equal(redirectsReached, 0);
      assert.doesNotMatch(result.stderr, /test-secret-only/);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

test("board progress follows every compact page, including active cards after the oldest 200", async () => {
  await withFixture(null, async (_path, dir) => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(dir, ".robob", "components"), { recursive: true });
    const paths = [];
    const server = createServer((req, res) => {
      paths.push(req.url);
      const next = req.url.includes("after=200");
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          board: { id: "board-big", slug: "big" },
          goals: [],
          cards: Array.from({ length: next ? 10 : 200 }, () => ({
            priority: 2,
            stage: next ? "working" : "verified",
          })),
          page: { nextAfter: next ? null : 200 },
        }),
      );
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      await writeFile(
        join(dir, ".robob", "components", "t3ctl.json"),
        JSON.stringify({ url: `http://127.0.0.1:${server.address().port}`, token: "test-only" }),
      );
      const result = await new Promise((resolve, reject) => {
        const child = spawn(python, [board, "big"], { env: cleanEnv({ HOME: dir }) });
        let stdout = "",
          stderr = "";
        child.stdout.on("data", (data) => {
          stdout += data;
        });
        child.stderr.on("data", (data) => {
          stderr += data;
        });
        child.on("error", reject);
        child.on("close", (status) => resolve({ status, stdout, stderr }));
      });
      assert.deepEqual(success(result).blocks[0], {
        type: "progress",
        label: "Done",
        value: 200,
        max: 210,
      });
      assert.deepEqual(paths, [
        "/api/ardud/kanban/boards/big",
        "/api/ardud/kanban/boards/big?after=200",
      ]);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

test("shipped definitions match IDs and point to installed source files", async () => {
  const families = [
    "systemSmall",
    "systemMedium",
    "systemLarge",
    "accessoryCircular",
    "accessoryRectangular",
    "accessoryInline",
  ];
  for (const [id, file] of [
    ["macros", "macros.py"],
    ["crpko-native-v1", "board_progress.py"],
  ]) {
    const def = JSON.parse(await readFile(join(root, "widgets", `${id}.json`), "utf8"));
    assert.equal(def.id, id);
    assert.deepEqual(def.families, families);
    assert.equal(def.refreshMinutes, 15);
    assert.deepEqual(def.source.command.slice(0, 2), [
      python,
      `/Users/ardud/.local/share/robob-widgets/sources/${file}`,
    ]);
    assert.deepEqual(def.actions, [{ id: "refresh", label: "Refresh", symbol: "arrow.clockwise" }]);
    if (id === "crpko-native-v1")
      assert.deepEqual(def.source.command.slice(2), [
        "board-crpko",
        "--goal",
        "goal-579c2439-725c-4a9f-9c23-b8419324c414",
      ]);
  }
});
