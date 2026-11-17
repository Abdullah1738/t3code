import * as NodeFS from "node:fs";

const unescapeMount = (value) =>
  value.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(Number.parseInt(octal, 8)));

export const mountForPath = (path, mountinfo) =>
  mountinfo
    .split("\n")
    .flatMap((line) => {
      if (!line) return [];
      const [left, right] = line.split(" - ");
      if (!right) throw new Error("Malformed mountinfo record");
      const fields = left.split(" "),
        filesystem = right.split(" ");
      if (fields.length < 6 || filesystem.length < 3)
        throw new Error("Incomplete mountinfo record");
      const mountPoint = unescapeMount(fields[4]);
      if (mountPoint !== "/" && path !== mountPoint && !path.startsWith(mountPoint + "/"))
        return [];
      return [
        {
          mountId: fields[0],
          parentMountId: fields[1],
          device: fields[2],
          root: unescapeMount(fields[3]),
          mountPoint,
          fsType: filesystem[0],
          source: unescapeMount(filesystem[1]),
        },
      ];
    })
    .sort((a, b) => b.mountPoint.length - a.mountPoint.length)[0];

export const captureFilesystems = (paths) => {
  let mountinfo;
  try {
    mountinfo = NodeFS.readFileSync("/proc/self/mountinfo", "utf8");
  } catch (cause) {
    return Object.entries(paths).map(([name, path]) => ({ name, path, error: String(cause) }));
  }
  return Object.entries(paths).map(([name, path]) => {
    try {
      const actualPath = NodeFS.realpathSync(path);
      const stat = NodeFS.statSync(actualPath, { bigint: true });
      const filesystem = NodeFS.statfsSync(actualPath, { bigint: true });
      const mount = mountForPath(actualPath, mountinfo);
      if (!mount) throw new Error("No mount covers the actual database path");
      return {
        name,
        path,
        actualPath,
        deviceId: stat.dev.toString(),
        inode: stat.ino.toString(),
        statfsType: "0x" + filesystem.type.toString(16),
        fsType: mount.fsType,
        tmpfs: filesystem.type === 0x01021994n && mount.fsType === "tmpfs",
        mount,
      };
    } catch (cause) {
      return { name, path, error: String(cause) };
    }
  });
};
