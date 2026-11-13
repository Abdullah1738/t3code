#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - Standalone installer CLI.
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { main } from "../src/ardud/persistence/offlineSplit.ts";

export { main, offlineSplit, OfflineSplitError } from "../src/ardud/persistence/offlineSplit.ts";

if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(NodePath.resolve(process.argv[1])).href)
  process.exitCode = main();
