// @effect-diagnostics nodeBuiltinImport:off -- native worker resolver filesystem fixtures.
import { describe, expect, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import { createCommandResolver } from "./commandResolver.ts";

// oxlint-disable-next-line t3code/no-global-process-runtime -- Native POSIX fixtures are selected during test collection.
describe.skipIf(process.platform === "win32")("POSIX command resolver", () => {
  const fixture = () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "command-resolver-"));
    for (const name of ["first", "second"]) NodeFS.mkdirSync(NodePath.join(root, name));
    const first = NodePath.join(root, "first", "git");
    const second = NodePath.join(root, "second", "git");
    for (const file of [first, second]) NodeFS.writeFileSync(file, "#!/bin/sh\n", { mode: 0o755 });
    return { root, first, second, options: { env: { PATH: `${root}/first:${root}/second` } } };
  };

  it("uses the first executable and follows PATH and filesystem changes", () => {
    const f = fixture();
    const resolver = createCommandResolver(NodeFS, NodePath);
    try {
      expect(resolver.resolve("git", f.options)).toBe(f.first);
      expect(resolver.resolve("git", f.options)).toBe(f.first);
      expect(resolver.resolve("git", { env: { PATH: `${f.root}/second:${f.root}/first` } })).toBe(
        f.second,
      );
      NodeFS.unlinkSync(f.first);
      expect(resolver.resolve("git", f.options)).toBe(f.second);
    } finally {
      NodeFS.rmSync(f.root, { recursive: true, force: true });
    }
  });

  it.each(["not-executable", "directory", "dangling-symlink"])("skips %s entries", (kind) => {
    const f = fixture();
    try {
      if (kind === "not-executable") NodeFS.chmodSync(f.first, 0o644);
      else {
        NodeFS.unlinkSync(f.first);
        if (kind === "directory") NodeFS.mkdirSync(f.first);
        else NodeFS.symlinkSync(NodePath.join(f.root, "missing"), f.first);
      }
      expect(createCommandResolver(NodeFS, NodePath).resolve("git", f.options)).toBe(f.second);
    } finally {
      NodeFS.rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("resolves relative and empty PATH entries against each child cwd", () => {
    const f = fixture();
    const resolver = createCommandResolver(NodeFS, NodePath);
    try {
      expect(resolver.resolve("git", { cwd: f.root, env: { PATH: "second:first" } })).toBe(
        f.second,
      );
      expect(resolver.resolve("git", { cwd: NodePath.dirname(f.first), env: { PATH: "" } })).toBe(
        f.first,
      );
      expect(resolver.resolve("git", { cwd: NodePath.dirname(f.second), env: { PATH: "" } })).toBe(
        f.second,
      );
      const options = { cwd: f.root, env: { PATH: "" } };
      expect(resolver.resolve("git", options)).toBe("git");
      NodeFS.symlinkSync(f.first, NodePath.join(f.root, "git"));
      expect(resolver.resolve("git", options)).toBe(NodePath.join(f.root, "git"));
    } finally {
      NodeFS.rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("leaves explicit paths and shell commands to Node", () => {
    const resolver = createCommandResolver(NodeFS, NodePath);
    for (const command of ["./git", "/usr/bin/git", "nested/git", ""]) {
      expect(resolver.resolve(command, {})).toBe(command);
    }
    expect(resolver.resolve("git", { shell: true })).toBe("git");
    expect(resolver.resolve("git", { env: {} })).toBe("/usr/bin/git");
  });

  it("preserves symlink traversal before .. in PATH", () => {
    const f = fixture();
    try {
      NodeFS.mkdirSync(NodePath.join(f.root, "second", "nested"));
      NodeFS.symlinkSync(NodePath.join(f.root, "second", "nested"), NodePath.join(f.root, "link"));
      const directory = `${f.root}/link/..`;
      const resolved = createCommandResolver(NodeFS, NodePath).resolve("git", {
        env: { PATH: directory },
      });
      expect(resolved).toBe(`${directory}/git`);
      expect(NodeFS.statSync(resolved).ino).toBe(NodeFS.statSync(f.second).ino);
    } finally {
      NodeFS.rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("notices an executable installed before the previous PATH match", () => {
    const f = fixture();
    try {
      NodeFS.unlinkSync(f.first);
      const resolver = createCommandResolver(NodeFS, NodePath);
      expect(resolver.resolve("git", f.options)).toBe(f.second);
      NodeFS.writeFileSync(f.first, "#!/bin/sh\n", { mode: 0o755 });
      expect(resolver.resolve("git", f.options)).toBe(f.first);
    } finally {
      NodeFS.rmSync(f.root, { recursive: true, force: true });
    }
  });
});
