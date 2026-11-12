// @effect-diagnostics nodeBuiltinImport:off globalConsole:off preferSchemaOverJson:off
import { SourceMap } from "node:module";
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
interface Frame { functionName: string; url: string; lineNumber: number; columnNumber: number }
interface Profile { nodes: { id: number; callFrame: Frame; children?: number[] }[]; samples: number[]; timeDeltas: number[] }
// Attribute each sampled microsecond once, to its nearest project frame.
export function rank(profile: Profile, locate: (frame: Frame) => string | undefined) {
  const nodes = new Map(profile.nodes.map(n => [n.id, n]));
  const parents = new Map(profile.nodes.flatMap(n => (n.children ?? []).map(id => [id, n.id] as const)));
  const totals = new Map<string, number>();
  let totalUs = 0;
  for (let i = 0; i < profile.samples.length; i++) {
    let node = nodes.get(profile.samples[i]!);
    const leaf = node?.callFrame;
    let location: string | undefined;
    while (node) {
      location = locate(node.callFrame);
      if (location) break;
      node = nodes.get(parents.get(node.id)!);
    }
    location ??= `${leaf?.functionName ?? "unknown"} (${leaf?.url || "runtime"})`;
    const us = profile.timeDeltas[i] ?? 0;
    totalUs += us;
    totals.set(location, (totals.get(location) ?? 0) + us);
  }
  return { totalMs: totalUs / 1000, blockers: [...totals].sort((a,b) => b[1]-a[1]).map(([location,us]) => ({ location, ms: us / 1000, elapsedSharePct: totalUs ? us / totalUs * 100 : 0 })) };
}
export function sourceLocator(projectOnly = true) {
  const maps = new Map<string, SourceMap | null>();
  return (frame: Frame) => {
    if (!frame.url.startsWith("file:")) return undefined;
    const file = fileURLToPath(frame.url);
    if (!maps.has(file)) {
      if (!existsSync(file + ".map")) maps.set(file, null);
      else {
        const payload = JSON.parse(readFileSync(file + ".map", "utf8"));
        const root = new URL(payload.sourceRoot ? payload.sourceRoot.replace(/\/?$/, "/") : ".", pathToFileURL(file + ".map"));
        payload.sources = payload.sources.map((source: string) => new URL(source, root).href);
        delete payload.sourceRoot;
        maps.set(file, new SourceMap(payload));
      }
    }
    const found = maps.get(file)?.findEntry(frame.lineNumber, frame.columnNumber);
    const entry = found && "originalSource" in found ? found : undefined;
    const source = entry?.originalSource
      ? fileURLToPath(new URL(entry.originalSource, pathToFileURL(file + ".map")))
      : file;
    if (projectOnly && (source.includes("/perf-harness/src/sampler.ts") || !/\/(apps|packages)\/[^/]+\/src\//.test(source) || source.includes("node_modules"))) return undefined;
    return `${source.replace(/^.*?\/(apps|packages)\//, "$1/")}:${(entry?.originalLine ?? frame.lineNumber) + 1} ${frame.functionName}`;
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [directory, output] = process.argv.slice(2);
  const files = readdirSync(directory!, { recursive: true }).map(String).filter(f => f.endsWith(".cpuprofile"));
  const locate = sourceLocator();
  const leafLocate = sourceLocator(false);
  const results = files.map(file => {
    const profile = JSON.parse(readFileSync(resolve(directory!, file), "utf8"));
    return { file, samples: JSON.parse(readFileSync(resolve(directory!, file.slice(0, -11)), "utf8")), ...rank(profile, locate), leafFrames: rank(profile, leafLocate).blockers.slice(0, 30) };
  });
  writeFileSync(output!, JSON.stringify(results, null, 2) + "\n");
}
