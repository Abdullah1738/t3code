import { describe, expect, test } from "bun:test";
import { localTarget, parseServeStatus, publish, tailscaleExec, unpublish, type Exec } from "../src/publish.ts";

const HOST = "abdullahs-macbook-pro.tailcca332.ts.net";
type Web = Record<string, string>;

/** A fake tailscale whose serve state changes only through the commands publish issues. */
function fakeTailscale(initial: Web, options: { failServe?: boolean; ignoreServe?: boolean } = {}) {
  const web: Web = { ...initial };
  const calls: string[][] = [];
  const exec: Exec = async args => {
    calls.push(args);
    const key = args.join(" ");
    if (key === "serve status --json") {
      const TCP = Object.fromEntries(Object.keys(web).map(port => [port, { HTTPS: true }]));
      const Web = Object.fromEntries(Object.entries(web).map(([port, proxy]) => [`${HOST}:${port}`, { Handlers: { "/": { Proxy: proxy } } }]));
      return { code: 0, stdout: JSON.stringify({ TCP, Web }), stderr: "" };
    }
    if (key === "status --json") return { code: 0, stdout: JSON.stringify({ Self: { DNSName: `${HOST}.` } }), stderr: "" };
    const on = key.match(/^serve --bg --https=(\d+) (http:\/\/127\.0\.0\.1:\d+)$/);
    if (on) {
      if (options.failServe) return { code: 1, stdout: "", stderr: "PRIVATE detail" };
      if (!options.ignoreServe) web[on[1]!] = on[2]!;
      return { code: 0, stdout: "", stderr: "" };
    }
    const off = key.match(/^serve --https=(\d+) off$/);
    if (off) { delete web[off[1]!]; return { code: 0, stdout: "", stderr: "" }; }
    return { code: 1, stdout: "", stderr: "unexpected" };
  };
  const mutations = () => calls.filter(args => !args.includes("--json"));
  return { exec, calls, mutations, web };
}

const LIVE: Web = { "443": "http://127.0.0.1:57123", "8443": "http://127.0.0.1:8090", "10000": "http://127.0.0.1:8091" };

describe("publish", () => {
  test("reuses an existing handler for the same local port without mutating anything", async () => {
    for (const proxy of ["http://127.0.0.1:18791", "http://localhost:18791"]) {
      const ts = fakeTailscale({ ...LIVE, "18403": proxy });
      expect(await publish(18791, { exec: ts.exec })).toEqual({ url: `https://${HOST}:18403`, port: 18403, created: false });
      expect(ts.mutations()).toEqual([]);
    }
    // Existing mappings outside the reserved range are reused but never modified.
    const ts = fakeTailscale(LIVE);
    expect(await publish(8090, { exec: ts.exec })).toEqual({ url: `https://${HOST}:8443`, port: 8443, created: false });
    expect(ts.mutations()).toEqual([]);
  });

  test("picks the first free port in 18400-18499, verifies, and returns the https URL", async () => {
    const ts = fakeTailscale({ ...LIVE, "18400": "http://127.0.0.1:1111", "18401": "http://127.0.0.1:2222" });
    expect(await publish(18791, { exec: ts.exec })).toEqual({ url: `https://${HOST}:18402`, port: 18402, created: true });
    expect(ts.mutations()).toEqual([["serve", "--bg", "--https=18402", "http://127.0.0.1:18791"]]);
    expect(ts.web["18402"]).toBe("http://127.0.0.1:18791");
    // A second call reuses the new mapping.
    expect((await publish(18791, { exec: ts.exec })).created).toBe(false);
    expect(ts.mutations()).toHaveLength(1);
  });

  test("never touches 443, 8443, or 10000", async () => {
    const ts = fakeTailscale(LIVE);
    await publish(3000, { exec: ts.exec });
    await publish(3001, { exec: ts.exec });
    for (const args of ts.mutations()) {
      expect(args.join(" ")).not.toMatch(/--https=(443|8443|10000)\b/);
    }
    expect(ts.web).toMatchObject(LIVE);
    for (const port of [443, 8443, 10000]) {
      await expect(unpublish(port, { exec: ts.exec })).rejects.toThrow("18400-18499");
    }
    expect(ts.web).toMatchObject(LIVE);
  });

  test("refuses the tailnet root port, invalid local ports, and a full range", async () => {
    const ts = fakeTailscale(LIVE);
    await expect(publish(57123, { exec: ts.exec })).rejects.toThrow("tailnet root");
    for (const port of [0, -1, 65536, 1.5, NaN]) await expect(publish(port, { exec: ts.exec })).rejects.toThrow("1-65535");
    const full = fakeTailscale(Object.fromEntries(Array.from({ length: 100 }, (_, i) => [String(18400 + i), `http://127.0.0.1:${2000 + i}`])));
    await expect(publish(18791, { exec: full.exec })).rejects.toThrow("No free tailnet port");
    expect(ts.mutations()).toEqual([]);
    expect(full.mutations()).toEqual([]);
  });

  test("fails without leaking tailscale output when serve fails or cannot be verified", async () => {
    const failing = fakeTailscale(LIVE, { failServe: true });
    await expect(publish(18791, { exec: failing.exec })).rejects.toThrow(/^tailscale serve failed$/);
    await expect(publish(18791, { exec: fakeTailscale(LIVE, { ignoreServe: true }).exec })).rejects.toThrow("could not be verified");
  });

  test("unpublish only removes served ports in range", async () => {
    const ts = fakeTailscale({ ...LIVE, "18405": "http://127.0.0.1:18791" });
    for (const port of [18399, 18500, 0, 65536]) await expect(unpublish(port, { exec: ts.exec })).rejects.toThrow("18400-18499");
    await expect(unpublish(18406, { exec: ts.exec })).rejects.toThrow("not published");
    expect(ts.mutations()).toEqual([]);
    expect(await unpublish(18405, { exec: ts.exec })).toEqual({ port: 18405, removed: true });
    expect(ts.mutations()).toEqual([["serve", "--https=18405", "off"]]);
    expect(ts.web).toEqual(LIVE);
  });
});

test("localTarget accepts only plain loopback http proxies", () => {
  expect(localTarget("http://127.0.0.1:8080")).toBe(8080);
  expect(localTarget("http://localhost:8080/")).toBe(8080);
  for (const proxy of ["https://127.0.0.1:8080", "http://10.0.0.1:8080", "http://127.0.0.1", "http://127.0.0.1:8080/x",
    "http://u:p@127.0.0.1:8080", "tcp://127.0.0.1:8080", "", undefined, 8080]) {
    expect(localTarget(proxy)).toBeUndefined();
  }
});

test("parseServeStatus tolerates empty state and rejects garbage", () => {
  expect(parseServeStatus("").ports.size).toBe(0);
  expect(parseServeStatus("{}").handlers).toEqual([]);
  expect(() => parseServeStatus("not json")).toThrow("invalid serve status");
});

test("tailscaleExec requires an absolute binary path", () => {
  expect(() => tailscaleExec("tailscale")).toThrow("absolute");
  expect(typeof tailscaleExec("/usr/local/bin/tailscale")).toBe("function");
});
