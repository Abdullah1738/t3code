// Where each card family's renderer lives and how it writes its own acceptance set.
// The renderers own their samples; this file only knows how to ask for them.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const home = homedir();
const first = (...paths) => paths.find((p) => p && existsSync(p)) || null;

export function locate(env = process.env) {
  return {
    // helpers/card-check sits next to helpers/ride-card in the fork and in the deployed copy.
    ride: first(env.CARD_CHECK_RIDE, join(here, "../ride-card/ride_card.py")),
    // Fork layout first (integrations/robob-watch/helpers/card-check -> integrations/app-api-cli),
    // then the deployed package.
    delivery: first(
      env.CARD_CHECK_DELIVERY,
      join(here, "../../../app-api-cli/delivery_card_samples.py"),
      join(home, ".local/share/app-api-cli/delivery_card_samples.py"),
    ),
    deliveryPython: first(env.CARD_CHECK_PYTHON, join(home, ".local/share/uv/tools/mitmproxy/bin/python"), "/opt/homebrew/bin/python3", "/usr/bin/python3"),
    qcard: first(env.CARD_CHECK_QCARD, join(home, ".local/bin/qcard")),
  };
}

const lines = (stdout) =>
  stdout
    .split("\n")
    .filter((l) => l.trim().startsWith("{"))
    .map((l) => JSON.parse(l));

// Renderers start their own Chrome (cardpreview, qcard's og shot). Each one runs in its
// own process group so a stop takes the whole tree, and with TMPDIR pointed at a scratch
// dir the run owns, so profiles left by a killed renderer are removed with it.
const kids = new Set();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const groupAlive = (pgid) => {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
};
async function reap(pgid, ms = 3000) {
  for (const [sig, wait] of [["SIGTERM", ms], ["SIGKILL", 2000]]) {
    if (!groupAlive(pgid)) return true;
    try {
      process.kill(-pgid, sig);
    } catch {}
    for (let t = 0; t < wait && groupAlive(pgid); t += 100) await sleep(100);
  }
  return !groupAlive(pgid);
}

// Stops every renderer still running (and anything it started), then waits for them.
export async function stopBuilders() {
  const live = [...kids];
  await Promise.all(live.map((k) => reap(k.pid)));
  await Promise.all(live.map((k) => Promise.race([k.closed, sleep(2000)])));
}

function exec(cmd, args, { signal, env, input, timeout = 180000 }) {
  return new Promise((ok, fail) => {
    if (signal?.aborted) return fail(new Error("stopped"));
    const p = spawn(cmd, args, { detached: true, stdio: ["pipe", "pipe", "pipe"], env });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr = (stderr + d).slice(-4000)));
    const kid = { pid: p.pid, closed: new Promise((r) => p.once("close", r)) };
    if (p.pid) kids.add(kid);
    const stop = () => p.pid && reap(p.pid);
    const timer = setTimeout(stop, timeout);
    signal?.addEventListener("abort", stop, { once: true });
    p.once("error", (err) => fail(new Error(`${basename(cmd)}: ${err.message}`)));
    p.once("close", (code, sig) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      // Whatever it left behind in its group goes too.
      Promise.resolve(p.pid && groupAlive(p.pid) ? reap(p.pid) : true).finally(() => {
        kids.delete(kid);
        if (code === 0) ok(stdout);
        else fail(new Error(`${basename(cmd)} ${args[0] || ""} failed (${code ?? sig}): ${stderr.trim().split("\n").at(-1) || "no output"}`));
      });
    });
    p.stdin.on("error", () => {});
    p.stdin.end(input ?? "");
  });
}

// Every builder takes the run's AbortSignal and scratch dir.
async function buildRide(out, where, signal, scratch) {
  if (!where.ride) throw new Error("ride_card.py not found (set CARD_CHECK_RIDE)");
  const stdout = await exec("/usr/bin/python3", [where.ride, "sample", "--acceptance", "--out", out], { signal, env: { ...process.env, TMPDIR: scratch } });
  return lines(stdout).map((r) => ({ name: r.state.toLowerCase(), dir: r.dir }));
}

async function buildDelivery(out, where, signal, scratch) {
  if (!where.delivery) throw new Error("delivery_card_samples.py not found (set CARD_CHECK_DELIVERY)");
  const stdout = await exec(where.deliveryPython, [where.delivery, "--out", out], {
    signal,
    env: { ...process.env, TMPDIR: scratch, PYTHONDONTWRITEBYTECODE: "1" },
  });
  return lines(stdout).map((r) => ({ name: r.state, dir: r.dir }));
}

const qspec = (where, spec, dir, signal, scratch) =>
  exec(where.qcard, ["spec", "-", "--out", dir], { signal, env: { ...process.env, TMPDIR: scratch }, input: JSON.stringify(spec) }).catch((err) => {
    throw new Error(`qcard ${spec.template}: ${err.message}`);
  });

async function buildQcard(out, where, signal, scratch) {
  if (!where.qcard) throw new Error("qcard not found (set CARD_CHECK_QCARD)");
  const stdout = await exec(where.qcard, ["templates"], { signal, env: { ...process.env, TMPDIR: scratch } });
  const specs = { ...JSON.parse(stdout), ...QCARD_HARD };
  mkdirSync(out, { recursive: true });
  const names = Object.keys(specs);
  const done = [];
  for (let i = 0; i < names.length; i += 4) {
    await Promise.all(
      names.slice(i, i + 4).map(async (name) => {
        const dir = join(out, name);
        await qspec(where, specs[name], dir, signal, scratch);
        done.push({ name, dir });
      }),
    );
  }
  return names.map((n) => done.find((d) => d.name === n));
}

export const BUILDERS = { ride: buildRide, delivery: buildDelivery, qcard: buildQcard };

// A finished card directory tells us which family drew it.
export function familyOf(dir) {
  const read = (f) => {
    try {
      return JSON.parse(readFileSync(join(dir, f), "utf8"));
    } catch {
      return null;
    }
  };
  const ride = read("data.json");
  if (ride && "step" in ride && "pickup" in ride) return "ride";
  const delivery = read("status.json");
  if (delivery && delivery.app && delivery.stage) return "delivery";
  const q = read("spec.json");
  if (q && q.template) return "qcard";
  return "page";
}

export const pageDir = (p) => {
  const abs = resolve(p);
  return abs.endsWith(".html") ? { dir: dirname(abs), file: abs } : { dir: abs, file: join(abs, "index.html") };
};

// qcard's own samples cover the happy path; these push length, count and value width.
const T0 = 1792700000;
const series = (n, step, base, swing) =>
  Array.from({ length: n }, (_, i) => [T0 - (n - 1 - i) * step, +(base + swing * Math.sin(i / 3) + (i * swing) / n).toFixed(2)]);

export const QCARD_HARD = {
  price: {
    template: "price",
    title: "Gold",
    sub: "XAU/USD spot",
    value: 4012.35,
    currency: "USD",
    decimals: 2,
    range: "1D",
    series: {
      "1D": { points: series(24, 3600, 3990, 14), prev: 3988.1 },
      "1W": { points: series(28, 21600, 3950, 30) },
      "1M": { points: series(30, 86400, 3850, 60) },
    },
    rows_title: "In Dubai",
    rows: [
      { label: "24K", value: "AED 473.75", note: "per gram, spot equivalent" },
      { label: "22K", value: "AED 434.27", note: "per gram, spot equivalent" },
      { label: "21K", value: "AED 414.53", note: "per gram, spot equivalent" },
    ],
    note: "Shop boards add a making premium on top of these.",
  },
  "stat-long": {
    template: "stat",
    title: "Average daily protein across every logged day this month",
    sub: "Nutrition tracker, last 30 days, fasting days left out",
    value: "Unchanged since last week",
    change: "Flat",
    change_note: "against the previous 30 days",
    stats: [
      { label: "Highest day", value: "212 g" },
      { label: "Lowest day", value: "96 g" },
      { label: "Days over target", value: "19 of 30" },
    ],
  },
  "stat-big": {
    template: "stat",
    title: "Portfolio",
    value: 12345678.9,
    currency: "AED",
    decimals: 2,
    change: 12.4,
    change_note: "since January",
    points: [9.1, 9.8, 10.4, 10.1, 11.2, 11.9, 12.3],
  },
  "compare-six": {
    template: "compare",
    title: "Weekend hotels in Abu Dhabi, two nights",
    sub: "Two adults, breakfast included, free cancellation",
    best_by: "Price",
    best_dir: "min",
    fields: ["Price", "Distance", "Rating", "Pool"],
    options: [
      { name: "Emirates Palace Mandarin Oriental", values: { Price: "AED 3,450", Distance: "12 km", Rating: "9.4", Pool: "Yes" }, note: "Beach access, late checkout on request" },
      { name: "Shangri-La Qaryat Al Beri", values: { Price: "AED 1,980", Distance: "18 km", Rating: "9.1", Pool: "Yes" } },
      { name: "Park Hyatt Saadiyat Island", values: { Price: "AED 2,640", Distance: "9 km", Rating: "9.2", Pool: "Yes" } },
      { name: "Jumeirah at Saadiyat Island Resort", values: { Price: "AED 2,890", Distance: "10 km", Rating: "9.0", Pool: "Yes" } },
      { name: "Rosewood Abu Dhabi", values: { Price: "AED 1,760", Distance: "4 km", Rating: "9.3", Pool: "Yes" } },
      { name: "The St. Regis Abu Dhabi", values: { Price: "AED 2,150", Distance: "6 km", Rating: "8.9", Pool: "Yes" } },
    ],
  },
  "list-long": {
    template: "list",
    title: "Things to sort before the move to the new flat",
    sub: "Shared with Moni",
    items: [
      { text: "Book the movers for Saturday morning and confirm the parking permit", done: true },
      { text: "DEWA transfer", done: true, note: "Final reading booked for the 28th" },
      { text: "Internet installation at the new address", value: "Thu 9-12" },
      { text: "Pack the kitchen" },
      { text: "Take Booby and Bia to the sitter for the weekend", note: "Bring their food and the blue lead" },
      { text: "Return the old access cards and the parking sticker to building management" },
      { text: "Change the delivery address on every app" },
      { text: "Deep clean the old flat before the handover inspection", value: "AED 450" },
      { text: "Keys" },
    ],
  },
  "timeline-long": {
    template: "timeline",
    title: "Passport renewal for the trip in December",
    sub: "Consulate appointment, courier return",
    events: [
      { when: "2 Oct", text: "Forms filled and photos taken at the studio near the mall", state: "done" },
      { when: "6 Oct", text: "Appointment at the consulate", state: "done", note: "Fingerprints and the signature page" },
      { when: "This week", text: "Waiting on the printing centre", state: "now", note: "They quoted three to five working days from the appointment" },
      { when: "Next week", text: "Courier brings the new passport home" },
      { when: "Then", text: "Move the residence visa to the new passport at the visa centre" },
      { when: "December", text: "Travel" },
    ],
  },
  "breakdown-bar": {
    template: "breakdown",
    title: "Where the September grocery money went",
    currency: "AED",
    kind: "bar",
    items: [
      { label: "Meat, poultry and fish from the butcher", value: 1840 },
      { label: "Fruit and vegetables", value: 920 },
      { label: "Dairy and eggs", value: 610 },
      { label: "Protein bars and shakes", value: 540 },
      { label: "Cleaning supplies", value: 310 },
      { label: "Dog food and treats for Booby and Bia", value: 480 },
      { label: "Delivery fees", value: 95 },
      { label: "Other", value: 130 },
    ],
  },
};
