import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Layer from "effect/Layer";
import * as OffMainSpawner from "./ardud/process/OffMainSpawner.ts";
import * as ProcessRunner from "./processRunner.ts";

const platform = OffMainSpawner.layer.pipe(Layer.provideMerge(NodeServices.layer));

// ProcessRunner captures its spawner during construction. Provide both outside
// Layer.unwrap so startup and the returned application share the worker-backed runner.
export const provide = Layer.provide(ProcessRunner.layer.pipe(Layer.provideMerge(platform)));
