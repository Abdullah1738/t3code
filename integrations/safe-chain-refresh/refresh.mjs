import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { AsyncLocalStorage } from "node:async_hooks";

const root = process.argv[2];
try {
  const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
  if (pkg.name !== "@aikidosec/safe-chain") throw new Error("Unexpected package");
  const load = (file) => import(pathToFileURL(path.join(root, "src", file)).href);
  const { getRemoteList, ListType } = await load("api/remoteList.js");
  const { setVersion, getMalwareListBaseUrl, defaultMalwareListBaseUrl,
    getMinimumPackageAgeHours } = await load("config/settings.js");
  const { ui } = await load("environment/userInteraction.js");
  const duration = getMalwareListBaseUrl() !== defaultMalwareListBaseUrl ||
    getMinimumPackageAgeHours() > 48 ? "7D" : "2D";
  const types = ["SAFE_PATCHES_LIST", "NPM_MALWARE_LIST", "PYPI_MALWARE_LIST",
    `NPM_NEW_PACKAGES_LIST_${duration}`, `PYPI_NEW_PACKAGES_LIST_${duration}`];
  if (typeof getRemoteList !== "function" || types.some((key) => !ListType?.[key])) {
    throw new Error("Installed list API changed");
  }
  setVersion(pkg.version);
  const requests = new AsyncLocalStorage();
  // Count cached fallbacks without logging configured mirror URLs or exception text.
  ui.writeWarning = () => { requests.getStore().cached = true; };
  ui.writeVerbose = () => {};
  const result = { expected: types.length, refreshed: 0, cached: 0, failed: 0 };
  const progress = () => console.log(JSON.stringify(result));
  progress();
  // Independent requests keep a failed or stalled feed from starving the others.
  await Promise.all(types.map((key) => requests.run({ cached: false }, async () => {
    try {
      await getRemoteList(ListType[key]);
      result[requests.getStore().cached ? "cached" : "refreshed"]++;
    } catch {
      result.failed++;
    }
    progress();
  })));
  if (result.failed) process.exitCode = 1;
} catch {
  // The parent provides the stable actionable error and upgrade-compatibility check.
  process.exitCode = 1;
}
