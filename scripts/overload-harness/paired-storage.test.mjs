import { describe, expect, it } from "vite-plus/test";
import { mountForPath } from "./paired-storage.mjs";

const root = "1 0 0:1 / / rw - zfs pool/root rw";
describe("actual database mount identity", () => {
  it.each([
    ["/data/statev2.sqlite", "/data", "/data"],
    ["/data space/statev2.sqlite", "/data\\040space", "/data space"],
    ["/data\ttab/boards.sqlite", "/data\\011tab", "/data\ttab"],
    ["/data\nline/boards.sqlite", "/data\\012line", "/data\nline"],
    ["/data\\slash/boards.sqlite", "/data\\134slash", "/data\\slash"],
  ])("resolves mountinfo escapes for %s", (path, encoded, expected) => {
    const result = mountForPath(path, `${root}\n2 1 0:2 / ${encoded} rw - tmpfs tmpfs rw`);
    expect(result).toMatchObject({ mountPoint: expected, device: "0:2", fsType: "tmpfs" });
  });
  it("uses the deepest component prefix, including bind mounts", () => {
    const mounts = `${root}\n2 1 0:2 / /data rw - tmpfs tmpfs rw\n3 2 0:3 /sub /data/nested rw - ext4 /dev/vdb rw`;
    expect(mountForPath("/data/nested/statev2.sqlite", mounts)).toMatchObject({
      mountId: "3",
      root: "/sub",
      fsType: "ext4",
    });
    expect(mountForPath("/database/statev2.sqlite", mounts)).toMatchObject({ mountId: "1" });
  });
  it.each(["broken", "2 1 0:2 - tmpfs", "2 1 0:2 / /data rw - tmpfs"])(
    "rejects malformed mount records %s",
    (text) => {
      expect(() => mountForPath("/data/statev2.sqlite", text)).toThrow();
    },
  );
});
