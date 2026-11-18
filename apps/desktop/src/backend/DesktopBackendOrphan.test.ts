import { describe, it, expect } from "vite-plus/test";
import {
  isOwnOrphan,
  type BackendListenerIdentity,
  type BackendOrphanOwner,
} from "./DesktopBackendOrphan.ts";

const owner: BackendOrphanOwner = {
  platform: "darwin",
  isPackaged: true,
  isDevelopment: false,
  executable: "/Applications/Robob Beta.app/Contents/MacOS/Robob",
  entryPath: "/app/server/bin.mjs",
  homeDir: "/Users/test/.robob",
};
const listener: BackendListenerIdentity = {
  process: { pid: 321, ppid: 1, pgid: 321, start: "123456" },
  executable: owner.executable,
  argv: [
    owner.executable,
    "--require",
    "/app/cache.cjs",
    owner.entryPath,
    "--base-dir",
    owner.homeDir,
    "--bootstrap-fd",
    "3",
  ],
};

describe("backend orphan ownership", () => {
  it("accepts the complete packaged identity with spaces in the executable", () => {
    expect(isOwnOrphan(owner, listener)).toBe(true);
    expect(
      isOwnOrphan(owner, { ...listener, argv: [owner.executable, ...listener.argv.slice(3)] }),
    ).toBe(true);
  });
  it.each([
    ["unpackaged", { ...owner, isPackaged: false }, listener],
    ["development", { ...owner, isDevelopment: true }, listener],
    ["live parent", owner, { ...listener, process: { ...listener.process, ppid: 123 } }],
    ["pid one", owner, { ...listener, process: { ...listener.process, pid: 1 } }],
    ["different executable", owner, { ...listener, executable: "/other/Robob" }],
    ["different entry", { ...owner, entryPath: "/other/bin.mjs" }, listener],
    ["different home", { ...owner, homeDir: "/other/.robob" }, listener],
    ["home prefix", { ...owner, homeDir: `${owner.homeDir}/userdata` }, listener],
    [
      "missing home",
      owner,
      { ...listener, argv: [owner.executable, owner.entryPath, "--bootstrap-fd", "3"] },
    ],
    [
      "entry is a require argument",
      owner,
      {
        ...listener,
        argv: [
          owner.executable,
          "--require",
          owner.entryPath,
          "--base-dir",
          owner.homeDir,
          "--bootstrap-fd",
          "3",
        ],
      },
    ],
    ["extra home flag", owner, { ...listener, argv: [...listener.argv, "--base-dir", "/other"] }],
    [
      "malformed flag",
      owner,
      {
        ...listener,
        argv: listener.argv.map((arg) => (arg === "--base-dir" ? "--base-dir=" : arg)),
      },
    ],
  ] satisfies [string, BackendOrphanOwner, BackendListenerIdentity][])(
    "refuses %s",
    (_label, expected, actual) => {
      expect(isOwnOrphan(expected, actual)).toBe(false);
    },
  );
});
