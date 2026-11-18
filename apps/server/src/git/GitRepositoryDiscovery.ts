import { GitCommandError } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";

export interface RepositoryDiscovery {
  readonly signature: string;
  readonly config: ReadonlyMap<string, string>;
  readonly remoteNames: ReadonlyArray<string>;
  readonly refs: ReadonlyMap<
    string,
    {
      readonly oid: string;
      readonly upstream: string;
      readonly remoteName: string;
      readonly remoteRef: string;
      readonly symref: string;
      readonly upstreamRef: string;
    }
  >;
}

export class GitRepositoryDiscovery extends Context.Service<
  GitRepositoryDiscovery,
  {
    readonly read: (
      cwd: string,
      branch: string,
      fresh?: boolean,
    ) => Effect.Effect<RepositoryDiscovery, GitCommandError>;
    readonly invalidate: (cwd: string) => Effect.Effect<void>;
  }
>()("t3/git/GitRepositoryDiscovery") {}

const CAPACITY = 2_048;
// Like listRefs, this scans the whole repository; seven fields exceed the
// default command budget even at 12,000 ordinary remote-tracking refs.
const REFS_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const encodeSignature = Schema.encodeSync(
  Schema.fromJsonString(Schema.Array(Schema.Array(Schema.String))),
);
const isGitCommandError = Schema.is(GitCommandError);

export const make = Effect.gen(function* () {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const fs = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;
  // Signatures are internal cache keys; use the same digest service as git identities.
  const digest = Effect.fnUntraced(function* (value: string) {
    const bytes = yield* crypto.digest("SHA-256", new TextEncoder().encode(value));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  });
  const path = yield* Path.Path;
  const environment = yield* HostProcess.Environment;
  const locks = yield* KeyedLock.make<string>();
  const configs = new Map<
    string,
    {
      readonly signature: string;
      readonly files: ReadonlyArray<string>;
      readonly values: ReadonlyMap<string, string>;
    }
  >();
  const snapshots = new Map<string, RepositoryDiscovery>();
  const rawRefs = new Map<
    string,
    { readonly signature: string; readonly refs: RepositoryDiscovery["refs"] }
  >();
  const generations = new Map<string, number>();
  let sequence = 0;

  const boundedSet = <A>(cache: Map<string, A>, key: string, value: A) => {
    cache.delete(key);
    if (cache.size >= CAPACITY) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, value);
  };
  const optionalStat = (file: string) =>
    fs.stat(file).pipe(
      Effect.map(Option.some),
      Effect.catch((error) =>
        error.reason._tag === "NotFound" ? Effect.succeed(Option.none()) : Effect.fail(error),
      ),
    );
  // Stat loops share the discovery span; individual files must not generate spans.
  const fileSignature = Effect.fnUntraced(function* (file: string) {
    const info = yield* optionalStat(file);
    return Option.isNone(info)
      ? [file, "missing"]
      : [
          file,
          info.value.type,
          String(Option.getOrNull(info.value.mtime)?.getTime()),
          String(info.value.size),
          String(Option.getOrNull(info.value.ino)),
        ];
  });
  const signature = Effect.fnUntraced(function* (files: ReadonlyArray<string>) {
    return yield* digest(
      encodeSignature(
        yield* Effect.forEach([...new Set(files)].sort(), fileSignature, { concurrency: 8 }),
      ),
    );
  });
  const locate = Effect.fn("GitRepositoryDiscovery.locate")(function* (cwd: string) {
    let directory = path.resolve(cwd);
    let gitDir = environment.GIT_DIR ? path.resolve(cwd, environment.GIT_DIR) : undefined;
    while (gitDir === undefined) {
      const dotGit = path.join(directory, ".git");
      const info = yield* optionalStat(dotGit);
      if (Option.isSome(info)) {
        gitDir =
          info.value.type === "Directory"
            ? dotGit
            : path.resolve(
                directory,
                (yield* fs.readFileString(dotGit)).trim().replace(/^gitdir:\s*/, ""),
              );
        break;
      }
      if (
        (yield* fs.exists(path.join(directory, "HEAD"))) &&
        (yield* fs.exists(path.join(directory, "objects")))
      ) {
        gitDir = directory;
        break;
      }
      const parent = path.dirname(directory);
      if (parent === directory)
        return yield* new GitCommandError({
          operation: "GitRepositoryDiscovery.read",
          cwd,
          command: "git discovery",
          detail: "Not a git repository.",
        });
      directory = parent;
    }
    gitDir = yield* fs.realPath(gitDir);
    const commonFile = path.join(gitDir, "commondir");
    const commonDir = yield* fs.realPath(
      environment.GIT_COMMON_DIR
        ? path.resolve(cwd, environment.GIT_COMMON_DIR)
        : (yield* fs.exists(commonFile))
          ? path.resolve(gitDir, (yield* fs.readFileString(commonFile)).trim())
          : gitDir,
    );
    return { gitDir, commonDir };
  });
  const configFiles = (commonDir: string) => [
    path.join(commonDir, "config"),
    environment.GIT_CONFIG_SYSTEM ?? "/etc/gitconfig",
    environment.GIT_CONFIG_GLOBAL ??
      path.join(environment.HOME ?? path.dirname(commonDir), ".gitconfig"),
    path.join(
      environment.XDG_CONFIG_HOME ?? path.join(environment.HOME ?? "", ".config"),
      "git/config",
    ),
  ];
  const readConfig = Effect.fn("GitRepositoryDiscovery.config")(function* (
    cwd: string,
    commonDir: string,
    gitDir: string,
    fresh: boolean,
  ) {
    // Conditional includes and config.worktree depend on the worktree. Ordinary
    // repositories share the config read across every linked worktree.
    const sharedKey = `${commonDir}\u0000config`;
    const worktreeKey = `${sharedKey}\u0000${gitDir}`;
    // A freshness read can finish while an older reader still owns the lock.
    // Its completed snapshot must be usable without waiting for that reader.
    const completed = configs.get(worktreeKey) ?? configs.get(sharedKey);
    if (
      !fresh &&
      completed?.signature ===
        (yield* signature([...configFiles(commonDir), ...(completed?.files ?? [])]))
    )
      return completed;
    const read = Effect.gen(function* () {
      for (let attempt = 0; ; attempt++) {
        const remembered = configs.get(worktreeKey) ?? configs.get(sharedKey);
        const files = [...configFiles(commonDir), ...(remembered?.files ?? [])];
        const before = yield* signature(files);
        if (!fresh && remembered?.signature === before) return remembered;
        const consistencyFiles = [
          ...files,
          path.join(gitDir, "HEAD"),
          path.join(gitDir, "config.worktree"),
        ];
        const beforeRead = yield* signature(consistencyFiles);
        const generation = ++sequence;
        boundedSet(generations, worktreeKey, generation);
        boundedSet(generations, sharedKey, generation);
        const output = yield* git.execute({
          operation: "GitRepositoryDiscovery.config",
          cwd,
          args: ["config", "--null", "--show-origin", "--list", "--includes"],
        });
        if (output.stdoutTruncated)
          return yield* new GitCommandError({
            operation: "GitRepositoryDiscovery.config",
            cwd,
            command: "git config",
            detail: "Repository config exceeded the discovery output limit.",
          });
        const values = new Map<string, string>();
        const origins = new Set(configFiles(commonDir));
        const fields = output.stdout.split("\u0000");
        for (let index = 0; index + 1 < fields.length; index += 2) {
          const origin = fields[index]!;
          const entry = fields[index + 1]!;
          const newline = entry.indexOf("\n");
          const key = newline < 0 ? entry : entry.slice(0, newline);
          values.set(key, newline < 0 ? "" : entry.slice(newline + 1));
          if (origin.startsWith("file:")) {
            const file = path.resolve(cwd, origin.slice(5));
            origins.add(file);
            if (key === "include.path" || /^includeif\..*\.path$/.test(key)) {
              const include = values.get(key)!;
              origins.add(
                include.startsWith("~/")
                  ? path.join(environment.HOME ?? "", include.slice(2))
                  : path.resolve(path.dirname(file), include),
              );
            }
          }
        }
        const conditional =
          [...values.keys()].some((key) => key.startsWith("includeif.")) ||
          values.has("extensions.worktreeconfig");
        if (conditional) {
          origins.add(path.join(gitDir, "HEAD"));
          origins.add(path.join(gitDir, "config.worktree"));
        }
        const entry = { signature: yield* signature([...origins]), files: [...origins], values };
        if (beforeRead !== (yield* signature(consistencyFiles))) {
          if (attempt < 2) continue;
          return yield* new GitCommandError({
            operation: "GitRepositoryDiscovery.config",
            cwd,
            command: "git config",
            detail: "Repository config kept changing during discovery.",
          });
        }
        if (
          generations.get(worktreeKey) === generation &&
          generations.get(sharedKey) === generation
        ) {
          if (conditional) configs.delete(sharedKey);
          else configs.delete(worktreeKey);
          boundedSet(configs, conditional ? worktreeKey : sharedKey, entry);
        }
        return entry;
      }
    });
    return yield* fresh ? read : locks.withLock(sharedKey, read);
  });
  const refSignature = Effect.fn("GitRepositoryDiscovery.refSignature")(function* (
    commonDir: string,
  ) {
    const files = [path.join(commonDir, "packed-refs")];
    // Include directories to notice new/deleted refs and files to notice ref
    // replacements. Packed refs and reftable backends also change atomically.
    for (const root of [path.join(commonDir, "refs"), path.join(commonDir, "reftable")]) {
      files.push(root);
      if (yield* fs.exists(root)) {
        const children = yield* fs.readDirectory(root, { recursive: true });
        files.push(
          ...children
            .filter((name) => !name.endsWith(".lock"))
            .map((name) => path.join(root, name)),
        );
      }
    }
    return yield* signature(files);
  });
  const branchSignature = Effect.fn("GitRepositoryDiscovery.branchSignature")(function* (
    commonDir: string,
    gitDir: string,
    branch: string,
    config: ReadonlyMap<string, string>,
    remoteNames: ReadonlyArray<string>,
    refs?: RepositoryDiscovery["refs"],
  ) {
    const files = [
      path.join(commonDir, "packed-refs"),
      path.join(commonDir, "shallow"),
      path.join(gitDir, "HEAD"),
      path.join(commonDir, "refs/heads", branch),
    ];
    const merge = config.get(`branch.${branch}.merge`)?.replace(/^refs\/heads\//, "");
    const savedRemote = config.get(`branch.${branch}.remote`);
    for (const remote of remoteNames) {
      files.push(
        path.join(commonDir, "refs/remotes", remote, branch),
        path.join(commonDir, "refs/remotes", remote, "HEAD"),
      );
      if (merge && savedRemote === remote)
        files.push(path.join(commonDir, "refs/remotes", remote, merge));
    }
    const local = refs?.get(`refs/heads/${branch}`);
    if (local?.symref) files.push(path.join(commonDir, local.symref));
    if (local?.upstreamRef) files.push(path.join(commonDir, local.upstreamRef));
    // Publication detection needs to know whether *any* tracking ref exists,
    // but changes to unrelated branches must not invalidate every worktree.
    const representative = refs && [...refs.keys()].find((ref) => ref.startsWith("refs/remotes/"));
    const hasRemote = representative
      ? yield* fs.exists(path.join(commonDir, representative))
      : false;
    if (!hasRemote) {
      const root = path.join(commonDir, "refs/remotes");
      files.push(root);
      if (yield* fs.exists(root))
        files.push(
          ...(yield* fs.readDirectory(root, { recursive: true })).map((name) =>
            path.join(root, name),
          ),
        );
    }
    // Reftable has no loose refs; its manifest invalidates the same snapshot.
    const reftable = path.join(commonDir, "reftable");
    if (yield* fs.exists(reftable)) files.push(reftable, path.join(reftable, "tables.list"));
    return yield* digest((hasRemote ? "remote" : "empty") + (yield* signature(files)));
  });
  const read = Effect.fn("GitRepositoryDiscovery.read")(
    function* (cwd: string, branch: string, fresh = false) {
      const { commonDir, gitDir } = yield* locate(cwd);
      const config = yield* readConfig(cwd, commonDir, gitDir, fresh);
      const remoteNames = [
        ...new Set(
          [...config.values.keys()].flatMap(
            (name) => /^remote\.(.*)\.[^.]+$/.exec(name)?.[1] ?? [],
          ),
        ),
      ].sort();
      const key = `${commonDir}\u0000${gitDir}\u0000${branch}`;
      const completed = snapshots.get(key);
      if (!fresh && completed !== undefined) {
        const current = yield* branchSignature(
          commonDir,
          gitDir,
          branch,
          config.values,
          remoteNames,
          completed.refs,
        );
        if (completed.signature === (yield* digest(config.signature + current))) return completed;
      }
      const load = Effect.gen(function* () {
        const remembered = snapshots.get(key);
        const before = yield* branchSignature(
          commonDir,
          gitDir,
          branch,
          config.values,
          remoteNames,
          remembered?.refs,
        );
        const currentSignature = yield* digest(config.signature + before);
        if (!fresh && remembered?.signature === currentSignature) return remembered;
        const generation = ++sequence;
        boundedSet(generations, key, generation);
        const rawKey = `${commonDir}\u0000refs\u0000${config.signature}`;
        const readRefs = Effect.gen(function* () {
          const beforeRefs = yield* refSignature(commonDir);
          const cached = rawRefs.get(rawKey);
          if (!fresh && cached?.signature === beforeRefs)
            return { refs: cached.refs, stable: true };
          const rawGeneration = ++sequence;
          boundedSet(generations, rawKey, rawGeneration);
          const output = yield* git.execute({
            operation: "GitRepositoryDiscovery.refs",
            cwd,
            maxOutputBytes: REFS_MAX_OUTPUT_BYTES,
            args: [
              "for-each-ref",
              "--format=%(refname)%00%(objectname)%00%(upstream:short)%00%(upstream:remotename)%00%(upstream:remoteref)%00%(symref)%00%(upstream)",
              "refs/heads",
              "refs/remotes",
            ],
          });
          if (output.stdoutTruncated)
            return yield* new GitCommandError({
              operation: "GitRepositoryDiscovery.refs",
              cwd,
              command: "git for-each-ref",
              detail: "Repository refs exceeded the discovery output limit.",
            });
          const refs = new Map<
            string,
            RepositoryDiscovery["refs"] extends ReadonlyMap<string, infer A> ? A : never
          >();
          for (const line of output.stdout.split("\n")) {
            const [
              name,
              oid = "",
              upstream = "",
              remoteName = "",
              remoteRef = "",
              symref = "",
              upstreamRef = "",
            ] = line.split("\u0000");
            if (name) refs.set(name, { oid, upstream, remoteName, remoteRef, symref, upstreamRef });
          }
          const stable = beforeRefs === (yield* refSignature(commonDir));
          if (stable && generations.get(rawKey) === rawGeneration)
            boundedSet(rawRefs, rawKey, { signature: beforeRefs, refs });
          return { refs, stable };
        });
        // Different branches share raw remote refs, retaining #1584's cold sharing.
        const raw = yield* fresh ? readRefs : locks.withLock(rawKey, readRefs);
        const after = yield* branchSignature(
          commonDir,
          gitDir,
          branch,
          config.values,
          remoteNames,
          raw.refs,
        );
        const result = {
          signature: yield* digest(config.signature + after),
          config: config.values,
          remoteNames,
          refs: raw.refs,
        };
        if (
          raw.stable &&
          generations.get(key) === generation &&
          config.signature === (yield* signature(config.files))
        )
          boundedSet(snapshots, key, result);
        return result;
      });
      return yield* fresh ? load : locks.withLock(key, load);
    },
    (effect, cwd) =>
      Effect.mapError(effect, (error) =>
        isGitCommandError(error)
          ? error
          : new GitCommandError({
              operation: "GitRepositoryDiscovery.read",
              cwd,
              command: "git discovery",
              cause: error,
              detail: "Could not read repository metadata.",
            }),
      ),
  );
  const invalidate = Effect.fn("GitRepositoryDiscovery.invalidate")(function* (cwd: string) {
    const { commonDir } = yield* locate(cwd);
    for (const cache of [configs, snapshots, rawRefs, generations]) {
      for (const key of cache.keys()) if (key.startsWith(`${commonDir}\u0000`)) cache.delete(key);
    }
  }, Effect.ignore());
  return GitRepositoryDiscovery.of({ read, invalidate });
});
