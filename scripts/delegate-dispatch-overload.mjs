import * as NodeModule from "node:module";
const once = (source, needle, replacement) => {
  if (source.split(needle).length !== 2) throw Error(`Harness hook mismatch: ${needle}`);
  return source.replace(needle, replacement);
};
NodeModule.registerHooks({
  load(url, context, next) {
    let result = next(url, context);
    if (!url.endsWith("/apps/server/scripts/overload-harness.ts")) return result;
    let source =
      typeof result.source === "string" ? result.source : new TextDecoder().decode(result.source);
    source = 'import * as DelegateLoad from "./delegate-dispatch-load.mjs";\n' + source;
    source = once(
      source,
      "const layer = KanbanService.layer.pipe(",
      "const layer = KanbanService.layer.pipe(",
    );
    source = once(
      source,
      "Layer.provideMerge(threads),",
      "Layer.provideMerge(threads),\nLayer.provideMerge(DelegateLoad.layer(persistence)),\nLayer.provideMerge(sinkLayer),",
    );
    source = once(
      source,
      'yield* Effect.forkScoped(drive("providerEvent", 284, write("providerEvent")));',
      'yield* DelegateLoad.start(() => measuring);\n yield* Effect.forkScoped(drive("providerEvent", 284, write("providerEvent")));',
    );
    source = once(
      source,
      'fidelity: "UNVALIDATED",',
      'mcpLoad: DelegateLoad.samples,\n fidelity: "UNVALIDATED",',
    );
    return { ...result, source };
  },
});
await import("./overload-harness/run.mjs");
