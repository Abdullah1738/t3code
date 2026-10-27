import { cpSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  addStop, ARCHIVE, contactKey, deliver, ensureDirs, family, iso, listIds, loadState, loadWatcher, log, normalize, relayCheck, runCheck,
  saveState, sendNotes, type State, type Stop, stopFor, unscopedSender, validId, type Watcher, watcherDir, WATCHERS, withRelayLock, writeJson,
} from "./lib.ts";

const USAGE = `robob-watch: durable watchers that wake the iMessage agent (Robob) when something happens.

  robob-watch add --id ID --title TEXT --check CMD [--interval 30] [--mode wake|notify]
                  (--context TEXT | --context-file PATH) [--expires 14d|ISO] [--max-fires 1] [--serial]
                  [--session CURRENT_SESSION_ID] [--trigger FILE]... [--replace] [--no-prime] [--owner-only]
  robob-watch add --json FILE|-          same fields as watcher.json (id, title, check, interval_s, mode, context,
                                         expires_at, max_fires, serial, triggers, quiet, trip, relays, created_by_session)
  robob-watch list                       all watchers with status
  robob-watch show ID                    definition, state and recent log
  robob-watch logs ID [-n 40]
  robob-watch test ID                    run the check once on a scratch copy of its state; no delivery
  robob-watch fire-test ID               deliver a clearly-marked test event through the watcher's mode
  robob-watch pause ID | resume ID [--expires ...]   (resume also re-arms a done/expired watcher)
  robob-watch remove ID                  archive and stop it
  robob-watch relay-ok ID --to JID [--eta ISO]   may this fire message JID now? "ok" (exit 0) counts it; "no" exits 3
  robob-watch relays-off ID [--to JID] --quote TEXT   the owner stopped updates to JID (default everyone), on every
                                         watcher sharing ID's trip
  robob-watch unscoped                   watchers whose text mentions wa draft/send but lists no relays (info only)
  robob-watch runner                     LaunchAgent status

Check contract: a zsh command run in the watcher dir with WATCH_DIR set. Print nothing when there is nothing new;
print the event text on stdout (exit 0) when it fires. Non-zero exit = failure (backoff; alert after 5 in a row).
Keep your own state in $WATCH_DIR. Helpers on PATH: whatsapp-new-message, output-changed, email-new-message.
Default interval 15s (min 5s). --trigger FILE runs the check within ~1s of FILE changing (push instead of poll),
e.g. --trigger ~/Library/Messages/chat.db-wal for iMessage; the interval stays as the fallback.`;

class CliError extends Error {}

function duration(value: string): string {
  const match = /^(\d+)\s*([mhdw])$/.exec(value.trim());
  if (match) {
    const unit = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[match[2] as "m" | "h" | "d" | "w"];
    return iso(Date.now() + Number(match[1]) * unit);
  }
  if (Number.isNaN(Date.parse(value))) throw new CliError("--expires must be like 90m, 6h, 14d, 2w or an ISO date");
  return new Date(value).toISOString();
}

function need(id: string | undefined): Watcher {
  if (!validId(id)) throw new CliError("A valid watcher id is required");
  const watcher = loadWatcher(id);
  if (!watcher) throw new CliError(`No watcher ${id}`);
  return watcher;
}

function tail(id: string, lines: number): string {
  const path = join(watcherDir(id), "log");
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf8").trimEnd().split("\n").slice(-lines).join("\n");
}

const ago = (value?: string) => {
  if (!value) return "-";
  const s = Math.round((Date.now() - Date.parse(value)) / 1000);
  return s < 120 ? `${s}s ago` : s < 7200 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
};

async function scratchRun(watcher: Watcher) {
  const scratch = mkdtempSync(join(tmpdir(), `robob-watch-${watcher.id}-`));
  try {
    cpSync(watcherDir(watcher.id), scratch, { recursive: true });
    return await runCheck(watcher, scratch);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: rest, allowPositionals: true, strict: true,
    options: {
      id: { type: "string" }, title: { type: "string" }, check: { type: "string" }, interval: { type: "string" },
      mode: { type: "string" }, context: { type: "string" }, "context-file": { type: "string" }, expires: { type: "string" },
      "max-fires": { type: "string" }, serial: { type: "boolean" }, session: { type: "string" }, replace: { type: "boolean" },
      "no-prime": { type: "boolean" }, trigger: { type: "string", multiple: true }, json: { type: "string" }, n: { type: "string" }, help: { type: "boolean", short: "h" },
      to: { type: "string" }, eta: { type: "string" }, quote: { type: "string" }, "owner-only": { type: "boolean" },
    },
  });
  ensureDirs();
  switch (command) {
    case "add": {
      let input: Record<string, unknown>;
      if (values.json !== undefined) {
        input = JSON.parse(values.json === "-" ? await new Response(Bun.stdin.stream()).text() : readFileSync(values.json, "utf8"));
        if (typeof input.expires_at === "string" && /^\d+\s*[mhdw]$/.test(input.expires_at)) input.expires_at = duration(input.expires_at);
      } else {
        const context = values["context-file"] !== undefined ? readFileSync(values["context-file"], "utf8") : values.context;
        input = {
          id: values.id, title: values.title, check: values.check, context,
          ...(values.interval === undefined ? {} : { interval_s: Number(values.interval) }),
          ...(values.mode === undefined ? {} : { mode: values.mode }),
          ...(values["max-fires"] === undefined ? {} : { max_fires: Number(values["max-fires"]) }),
          ...(values.serial ? { serial: true } : {}),
          ...(values.trigger?.length ? { triggers: values.trigger } : {}),
          ...(values.session === undefined ? {} : { created_by_session: values.session }),
          // Third parties can only be listed with --json; this says the fires tell nobody but the owner.
          ...(values["owner-only"] ? { relays: [] } : {}),
        };
      }
      if (values.expires !== undefined) input.expires_at = duration(values.expires);
      if (input.expires_at === undefined) input.expires_at = duration("14d");
      if (values["owner-only"]) input.relays = [];
      const previous = values.replace && validId(input.id) ? loadWatcher(input.id as string) : undefined;
      // Flags can't express relays, so a flag --replace keeps the ones the owner already allowed. Stops live
      // outside watcher.json, so no replace can lift one.
      if (values.json === undefined && previous?.relays && !values["owner-only"]) input.relays = previous.relays;
      if (values.json === undefined && previous?.trip) input.trip = previous.trip;
      let watcher: Watcher;
      try { watcher = normalize(input as Partial<Watcher> & Record<string, unknown>); } catch (error) { throw new CliError((error as Error).message); }
      const dir = watcherDir(watcher.id);
      const replacingExisting = existsSync(join(dir, "watcher.json"));
      if (replacingExisting) {
        if (!values.replace) throw new CliError(`Watcher ${watcher.id} exists; use --replace to overwrite its definition (state is kept)`);
        const existing = loadWatcher(watcher.id)!;
        watcher.created_at = existing.created_at;
        if (existing.headsup && values.json === undefined) watcher.headsup = true;
        if (existing.quiet && values.json === undefined) watcher.quiet = existing.quiet;
      }
      Bun.spawnSync(["/bin/mkdir", "-p", dir]);
      writeJson(join(dir, "watcher.json"), watcher);
      const state = loadState(watcher.id);
      state.next_at = 0;
      saveState(watcher.id, state);
      log(watcher.id, `${values.replace ? "replaced" : "added"} by ${watcher.created_by_session ?? "unknown session"}`);
      for (const note of sendNotes(watcher)) process.stderr.write(`Note for ${watcher.id}: ${note}.\n`);
      let prime = "";
      // --replace keeps the existing baseline, so don't prime: a real reply landing during a prime run would be
      // recorded as "seen" and never delivered (Dynamic reply swallowed 1 Oct 2026 16:18). New watchers still prime.
      if (replacingExisting) prime = "replace: existing state kept, prime skipped";
      else if (!values["no-prime"]) {
        // Priming runs the real check once, so baseline-style helpers record "now" and old items never fire.
        // The prime's run id is never acked, so helpers with an outbox (whatsapp-new-message) replay whatever they
        // reported here on the first real run instead of it being swallowed as baseline.
        const result = await runCheck(watcher, dir, { WATCH_RUN: `prime-${Date.now().toString(36)}` });
        prime = result.timedOut ? "prime run timed out" : result.code !== 0 ? `prime run failed (exit ${result.code}): ${result.stderr.trim().slice(-300)}`
          : result.stdout.trim() ? `prime run printed (NOT delivered): ${result.stdout.trim().slice(0, 1000)}` : "prime run: nothing new (baseline recorded)";
        log(watcher.id, prime);
      }
      console.log(JSON.stringify({ added: watcher.id, mode: watcher.mode, interval_s: watcher.interval_s, expires_at: watcher.expires_at,
        max_fires: watcher.max_fires, serial: watcher.serial, dir, prime }, null, 2));
      return;
    }
    case "list": {
      const ids = listIds();
      if (!ids.length) { console.log("No watchers."); return; }
      for (const id of ids) {
        const w = loadWatcher(id)!;
        const s = loadState(id);
        const status = w.paused ? "paused" : s.status;
        console.log(`${id}  [${status}] ${w.mode} every ${w.interval_s}s${w.triggers?.length ? "+trigger" : ""}  fires ${s.fires}/${w.max_fires || "inf"}  expires ${w.expires_at?.slice(0, 16) ?? "never"}  last run ${ago(s.last_run_at)}${s.last_run_ms !== undefined ? ` (${(s.last_run_ms / 1000).toFixed(1)}s)` : ""}${s.pending ? "  UNDELIVERED EVENT" : ""}${s.consecutive_failures ? `  failing x${s.consecutive_failures}` : ""}\n    ${w.title}`);
      }
      return;
    }
    case "show": {
      const w = need(positionals[0]);
      console.log(JSON.stringify({ watcher: w, state: loadState(w.id), dir: watcherDir(w.id) }, null, 2));
      console.log(`--- log (last 20)\n${tail(w.id, 20)}`);
      return;
    }
    case "logs": {
      const w = need(positionals[0]);
      console.log(tail(w.id, Number(values.n ?? 40)));
      return;
    }
    case "test": {
      const w = need(positionals[0]);
      const result = await scratchRun(w);
      console.log(JSON.stringify({ id: w.id, exit: result.code, timedOut: result.timedOut, seconds: Math.round(result.ms / 100) / 10, fires: !!result.stdout.trim() && result.code === 0,
        stdout: result.stdout.trim(), stderr: result.stderr.trim().slice(-1000) }, null, 2));
      if (result.code !== 0 || result.timedOut) process.exitCode = 1;
      return;
    }
    case "fire-test": {
      const w = need(positionals[0]);
      const key = `robob-watch:${w.id}:test:${Date.now()}`;
      const result = await deliver(w, "This is a test fire of the watcher. No real event happened.", key, loadState(w.id), true);
      log(w.id, `fire-test ok=${result.ok} via=${result.via} ${result.detail}`);
      console.log(JSON.stringify(result, null, 2));
      if (!result.ok) process.exitCode = 1;
      return;
    }
    case "pause":
    case "resume": {
      const w = need(positionals[0]);
      w.paused = command === "pause";
      if (command === "resume" && values.expires !== undefined) w.expires_at = duration(values.expires);
      writeJson(join(watcherDir(w.id), "watcher.json"), w);
      const s: State = loadState(w.id);
      if (command === "resume" && s.status !== "active") {
        if (w.expires_at && Date.parse(w.expires_at) <= Date.now()) throw new CliError("Watcher is expired; pass --expires to re-arm it");
        s.status = "active";
        s.fires = 0;
      }
      s.next_at = 0;
      saveState(w.id, s);
      log(w.id, command);
      console.log(JSON.stringify({ id: w.id, paused: w.paused, status: s.status }));
      return;
    }
    case "relay-ok": {
      const w = need(positionals[0]);
      if (!values.to) throw new CliError("relay-ok needs --to");
      const eta = values.eta === undefined ? undefined : Date.parse(values.eta);
      if (eta !== undefined && Number.isNaN(eta)) throw new CliError("--eta must be an ISO time");
      const verdict = relayCheck(w, values.to, eta);
      log(w.id, `relay-ok ${values.to}${values.eta ? ` eta=${values.eta}` : ""}: ${verdict.ok ? "ok" : "no"} (${verdict.reason})`);
      console.log(`${verdict.ok ? "ok" : "no"}: ${verdict.reason}`);
      if (!verdict.ok) process.exitCode = 3;
      return;
    }
    case "relays-off": {
      const w = need(positionals[0]);
      if (!values.quote?.trim()) throw new CliError("relays-off needs --quote with the owner's words");
      const key = values.to === undefined ? undefined : contactKey(values.to);
      // An @lid wacli can't map to a phone would match no grant, so say so instead of reporting a stop.
      if (key !== undefined && /@lid$/.test(key)) throw new CliError(`can't find the phone number behind ${values.to}; stop it by phone jid (wa-db resolve)`);
      // Names every sibling it reaches now, so a later replace that drops or changes `trip` doesn't slip out of it.
      const covered = withRelayLock(() => {
        const siblings = family(loadWatcher(w.id) ?? w);
        const stop: Stop = { ...(w.trip ? { trip: w.trip } : {}), watchers: siblings.map(sibling => sibling.id),
          ...(values.to !== undefined ? { to: values.to, key } : {}), at: iso(), quote: values.quote!.trim() };
        addStop(stop);
        return siblings.filter(sibling => (sibling.relays ?? []).some(relay => stopFor([stop], sibling, relay)));
      });
      for (const sibling of covered) log(sibling.id, `relays-off ${values.to ?? "everyone"} via ${w.id}`);
      console.log(JSON.stringify({ stopped: values.to ?? "everyone", trip: w.trip ?? null, watchers: covered.map(sibling => sibling.id) }));
      // Kept for grants added later, but nothing listed matched: don't tell the owner it's done.
      if (!covered.length) process.exitCode = 3;
      return;
    }
    case "remove": {
      const w = need(positionals[0]);
      log(w.id, "removed");
      const target = join(ARCHIVE, `${w.id}-${Date.now()}`);
      renameSync(watcherDir(w.id), target);
      console.log(JSON.stringify({ removed: w.id, archived: target }));
      return;
    }
    case "unscoped": {
      const found = listIds().map(id => loadWatcher(id)).filter((w): w is Watcher => !!w && unscopedSender(w));
      if (!found.length) { console.log("No watchers mention wa draft/send without relays."); return; }
      for (const w of found) {
        const s = loadState(w.id);
        console.log(`${w.id}  [${w.paused ? "paused" : s.status}] expires ${w.expires_at?.slice(0, 16) ?? "never"}  created ${w.created_at.slice(0, 16)}${w.trip ? `  trip ${w.trip}` : ""}\n    ${w.title}`);
      }
      console.log("These list no relays, so their fires tell only the owner. To let one message someone, add it again with relays (the owner's words for each).");
      return;
    }
    case "runner": {
      const uid = process.getuid?.();
      const out = Bun.spawnSync(["/bin/launchctl", "print", `gui/${uid}/com.ardud.robob-watch`]).stdout.toString();
      const pick = out.split("\n").filter(line => /^\s*(state|pid|last exit code|runs) =/.test(line)).map(line => line.trim());
      console.log(pick.length ? pick.join("\n") : "com.ardud.robob-watch is not loaded");
      console.log(`watchers dir: ${WATCHERS}`);
      return;
    }
    default:
      console.log(USAGE);
      if (command && command !== "help" && !values.help) process.exitCode = 2;
  }
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error(`robob-watch: ${error instanceof CliError ? error.message : String((error as Error)?.message ?? error)}`);
  process.exitCode = 1;
}
