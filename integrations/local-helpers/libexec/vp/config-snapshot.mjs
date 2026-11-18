import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

// Copy only the local module graph. Symlinking the sources would make Node resolve
// their bare imports back in the dependencyless worktree instead of the borrowed install.
export async function configSnapshot(root, main) {
  const requireVp = createRequire(
    fs.realpathSync(path.join(main, "node_modules/vite-plus/package.json")),
  );
  const { rolldown } = await import(pathToFileURL(requireVp.resolve("rolldown")));
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vp-config-")));
  const inside = (file) => {
    const relative = path.relative(root, file);
    if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      throw new Error(`config import outside this worktree: ${file}`);
    return relative;
  };
  function copy(file) {
    const relative = inside(file);
    const destination = path.join(directory, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(file, destination);
    let parent = path.dirname(file);
    while (parent === root || parent.startsWith(`${root}${path.sep}`)) {
      const target = path.join(directory, inside(parent));
      const manifest = path.join(parent, "package.json");
      if (fs.existsSync(manifest)) {
        fs.mkdirSync(target, { recursive: true });
        fs.copyFileSync(manifest, path.join(target, "package.json"));
      }
      const modules = path.join(main, inside(parent), "node_modules");
      const borrowed = path.join(target, "node_modules");
      if (fs.existsSync(modules) && !fs.existsSync(borrowed)) {
        // Vite writes .vite-temp beside packages. Keep that cache in our snapshot,
        // rather than following a node_modules symlink into the shared install.
        fs.mkdirSync(borrowed, { recursive: true });
        for (const name of fs.readdirSync(modules)) {
          if (!name.startsWith("."))
            fs.symlinkSync(fs.realpathSync(path.join(modules, name)), path.join(borrowed, name));
        }
      }
      parent = path.dirname(parent);
    }
  }
  async function stage(file) {
    copy(file);
    const bundle = await rolldown({
      input: file,
      platform: "node",
      tsconfig: false,
      treeshake: false,
      external: (id) => !id.startsWith(".") && !path.isAbsolute(id),
      plugins: [
        {
          name: "worktree-config-snapshot",
          load(id) {
            copy(id);
          },
        },
      ],
    });
    try {
      await bundle.generate({ format: "esm" });
    } finally {
      await bundle.close();
    }
    return path.join(directory, inside(file));
  }
  try {
    await stage(path.join(root, "vite.config.ts"));
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  return { directory, stage };
}
