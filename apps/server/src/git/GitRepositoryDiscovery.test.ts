import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/process";
import { TestClock } from "effect/testing";
import { expect } from "vite-plus/test";

import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as GitRepositoryDiscovery from "./GitRepositoryDiscovery.ts";

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const cwd = yield* fs.makeTempDirectoryScoped();
  const gitDir = `${cwd}/.git`;
  yield* fs.makeDirectory(`${gitDir}/refs/heads`, { recursive: true });
  yield* fs.makeDirectory(`${gitDir}/refs/remotes/team/fork`, { recursive: true });
  yield* fs.writeFileString(`${gitDir}/HEAD`, "ref: refs/heads/main\n");
  yield* fs.writeFileString(`${gitDir}/config`, "config\n");
  yield* fs.writeFileString(`${gitDir}/refs/heads/main`, "a\n");
  yield* fs.writeFileString(`${gitDir}/refs/remotes/team/fork/main`, "a\n");
  const calls: string[] = [];
  const started = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  let gate = false;
  let config = `file:${gitDir}/config\0remote.team/fork.url\nhttps://github.com/a/repo\0`;
  const driver = Layer.mock(GitVcsDriver.GitVcsDriver)({
    execute: (input) =>
      Effect.gen(function* () {
        calls.push(input.args[0]!);
        const stdout =
          input.args[0] === "config"
            ? config
            : "refs/heads/main\0a\0team/fork/main\0team/fork\0refs/heads/main\0\n" +
              "refs/remotes/team/fork/main\0a\0\0\0\0\n";
        if (gate) {
          gate = false;
          yield* Deferred.succeed(started, undefined);
          yield* Deferred.await(release);
        }
        return {
          stdout,
          stderr: "",
          exitCode: ChildProcessSpawner.ExitCode(0),
          stdoutTruncated: false,
          stderrTruncated: false,
        };
      }),
  });
  const discovery = yield* GitRepositoryDiscovery.make.pipe(
    Effect.provide(driver),
    Effect.provideService(HostProcess.Environment, { HOME: cwd }),
  );
  return {
    fs,
    cwd,
    gitDir,
    calls,
    discovery,
    started,
    release,
    hold: () => {
      gate = true;
    },
    config: (value: string) => {
      config = value;
    },
  };
});

it.effect("concurrent cold reads share two launches; unchanged sweeps launch zero git", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    f.hold();
    const reads = yield* Effect.forEach(
      Array.from({ length: 12 }),
      () => f.discovery.read(f.cwd, "main"),
      { concurrency: "unbounded" },
    ).pipe(Effect.forkChild);
    yield* Deferred.await(f.started);
    yield* Deferred.succeed(f.release, undefined);
    const results = yield* Fiber.join(reads);
    expect(f.calls).toEqual(["config", "for-each-ref"]);
    expect(results.every((result) => result.signature === results[0]!.signature)).toBe(true);
    expect(results[0]?.remoteNames).toEqual(["team/fork"]);
    yield* TestClock.adjust("10 minutes");
    for (let i = 0; i < 3; i++) yield* f.discovery.read(f.cwd, "main");
    expect(f.calls).toEqual(["config", "for-each-ref"]);
    f.calls.length = 0;
    yield* f.fs.writeFileString(`${f.gitDir}/refs/heads/another-branch`, "unrelated commit\n");
    yield* f.discovery.read(f.cwd, "main");
    expect(f.calls).toEqual([]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "ref/config/HEAD/packed-ref changes invalidate, and forced reads bypass unchanged stats",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.discovery.read(f.cwd, "main");
      for (const file of ["refs/heads/main", "refs/remotes/team/fork/main", "packed-refs"]) {
        f.calls.length = 0;
        yield* f.fs.writeFileString(`${f.gitDir}/${file}`, "changed-content\n");
        yield* f.discovery.read(f.cwd, "main");
        expect(f.calls, file).toEqual(["for-each-ref"]);
      }
      f.calls.length = 0;
      yield* f.fs.writeFileString(`${f.gitDir}/config`, "changed-config\n");
      yield* f.discovery.read(f.cwd, "main");
      expect(f.calls).toEqual(["config", "for-each-ref"]);
      f.calls.length = 0;
      yield* f.discovery.read(f.cwd, "main", true);
      expect(f.calls).toEqual(["config", "for-each-ref"]);
      f.calls.length = 0;
      yield* f.discovery.read(f.cwd, "main");
      expect(f.calls).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "linked worktrees share config; included config, duplicate keys and newline values survive",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const included = `${f.gitDir}/extra.config`;
      yield* f.fs.writeFileString(included, "included\n");
      f.config(
        `file:${f.gitDir}/config\0include.path\nextra.config\0` +
          `file:${included}\0remote.origin.url\nfirst\0` +
          `file:${included}\0remote.origin.url\nsecond\nline\0`,
      );
      expect((yield* f.discovery.read(f.cwd, "main")).config.get("remote.origin.url")).toBe(
        "second\nline",
      );
      const worktree = `${f.cwd}/linked`;
      const worktreeGit = `${f.gitDir}/worktrees/linked`;
      yield* f.fs.makeDirectory(worktree, { recursive: true });
      yield* f.fs.makeDirectory(worktreeGit, { recursive: true });
      yield* f.fs.writeFileString(`${worktree}/.git`, `gitdir: ${worktreeGit}\n`);
      yield* f.fs.writeFileString(`${worktreeGit}/commondir`, "../..\n");
      yield* f.fs.writeFileString(`${worktreeGit}/HEAD`, "ref: refs/heads/linked\n");
      f.calls.length = 0;
      yield* f.discovery.read(worktree, "linked");
      expect(f.calls).toEqual([]);
      f.calls.length = 0;
      yield* f.fs.writeFileString(included, "changed include\n");
      yield* f.discovery.read(f.cwd, "main");
      expect(f.calls).toEqual(["config", "for-each-ref"]);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each(["true", "yes", "on", "1", ""])(
  "worktree config stays isolated for Git boolean %s",
  (boolean) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const worktree = `${f.cwd}/linked`;
      const gitDir = `${f.gitDir}/worktrees/linked`;
      yield* f.fs.makeDirectory(worktree, { recursive: true });
      yield* f.fs.makeDirectory(gitDir, { recursive: true });
      yield* f.fs.writeFileString(`${worktree}/.git`, `gitdir: ${gitDir}\n`);
      yield* f.fs.writeFileString(`${gitDir}/commondir`, "../..\n");
      yield* f.fs.writeFileString(`${gitDir}/HEAD`, "ref: refs/heads/main\n");
      const config = (directory: string, url: string) =>
        `file:${f.gitDir}/config\0extensions.worktreeconfig${boolean ? `\n${boolean}` : ""}\0` +
        `file:${directory}/config.worktree\0remote.origin.url\n${url}\0`;
      f.config(config(f.gitDir, "root"));
      expect((yield* f.discovery.read(f.cwd, "main")).config.get("remote.origin.url")).toBe("root");
      f.config(config(gitDir, "linked"));
      expect((yield* f.discovery.read(worktree, "main")).config.get("remote.origin.url")).toBe(
        "linked",
      );
      expect(f.calls.filter((command) => command === "config")).toHaveLength(2);
      f.calls.length = 0;
      expect((yield* f.discovery.read(f.cwd, "main")).config.get("remote.origin.url")).toBe("root");
      expect(f.calls).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
);
