#!/usr/bin/env node
// robob-watch check for a dead coord pump (watcher `coord-pump-heartbeat`, notify mode, every 5 min).
// `coord attention` marks the pump stale after 5 min without a heartbeat. The check alerts on Telegram only
// after a second stale sighting (a watcher run right after the Mac wakes can beat the pump's first tick),
// repeats every 6 h while it stays stale, and sends one note when it ticks again. It prints nothing, so the
// watcher itself never texts; a failed `coord attention` or notify exits 1 and the runner's own failure
// alert takes over. State lives in $WATCH_DIR.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

const CONFIRM_S = 240;
const REPEAT_S = 6 * 3600;
const BUN = '/Users/ardud/.bun/bin/bun';
const TELEGRAM = '/Users/ardud/.local/share/telegram-bridge/src/cli.ts';

const dubai = s => new Date(s * 1000).toLocaleString('en-GB', { timeZone: 'Asia/Dubai', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

// One check. `attention()` returns `coord attention` JSON, `notify(alert)` sends it or throws.
// Returns the newest alert sent, if any. What the pump did is recorded first and its alerts go into an
// outbox, sent in order and kept until each send succeeds, so a Telegram outage never changes what was
// seen. Alert text is fixed when queued: the bridge refuses a reused key with different text. Only the
// head can have been tried, so it never changes; behind it only the newest alert is kept, which keeps the
// outbox at two entries however often the pump flaps during an outage, and the last one sent is current.
export function heartbeatCheck({ attention, notify, now, load, save }) {
  const pump = attention().pump;
  if (!pump || typeof pump.stale !== 'boolean') throw new Error('coord attention has no pump field');
  const { outbox = [], ...s } = load();
  const queue = alert => outbox.splice(1, Infinity, alert);
  if (!pump.stale) {
    if (s.alerts) queue({ severity: 'info', key: `coord-pump-heartbeat:${s.staleSince}:ok`,
      text: `The coord pump is ticking again (last tick ${dubai(pump.last_tick)} Dubai).` });
    delete s.staleSince; delete s.alerts; delete s.alertedAt;
  } else {
    s.staleSince ??= now;
    const n = s.alerts ?? 0;
    // No reminder while the last alert is still waiting to go out.
    if (now - s.staleSince >= CONFIRM_S && (!n || (!outbox.length && now - s.alertedAt >= REPEAT_S))) {
      const tick = pump.last_tick == null ? 'has never written a heartbeat' : `has not ticked since ${dubai(pump.last_tick)} Dubai`;
      queue({ severity: 'attention', key: `coord-pump-heartbeat:${s.staleSince}:${n + 1}`,
        text: `The coord pump ${tick}, so coord deliveries and release checks are stopped. `
          + 'Check `launchctl print gui/$(id -u)/com.ardud.coord-pump` and ~/Library/Logs/coord-pump.log.' });
      s.alerts = n + 1;
      s.alertedAt = now;
    }
  }
  const keep = () => save(outbox.length ? { ...s, outbox } : s);
  keep();
  // A new outage that isn't confirmed yet holds the queue, so an old recovery note never goes out last
  // while the pump is down again. It drains once the outage is confirmed or the pump ticks.
  if (pump.stale && !s.alerts) return null;
  let last = null;
  while (outbox.length) {
    notify(outbox[0]);
    last = outbox.shift();
    // The 6 h repeat counts from when this episode's alert went out, not from when it was queued.
    if (s.alerts && last.key === `coord-pump-heartbeat:${s.staleSince}:${s.alerts}`) s.alertedAt = now;
    keep();
  }
  return last;
}

if (import.meta.main) {
  const statePath = join(process.env.WATCH_DIR ?? process.cwd(), 'pump-heartbeat.json');
  const env = { ...process.env };
  delete env.BUN_INSPECT;
  try {
    heartbeatCheck({
      now: Math.floor(Date.now() / 1000),
      attention: () => JSON.parse(execFileSync(process.env.COORD_BIN ?? 'coord', ['attention'], { encoding: 'utf8', timeout: 20_000 })),
      notify: a => execFileSync(BUN, [TELEGRAM, 'notify', '--source', 'coord pump', '--severity', a.severity, '--text', a.text, '--key', a.key],
        { env, stdio: ['ignore', 'ignore', 'inherit'], timeout: 20_000 }),
      load: () => { try { return JSON.parse(readFileSync(statePath, 'utf8')); } catch { return {}; } },
      save: v => { writeFileSync(`${statePath}.tmp`, JSON.stringify(v)); renameSync(`${statePath}.tmp`, statePath); },
    });
  } catch (e) {
    console.error(`coord-pump-heartbeat: ${e.message}`);
    process.exit(1);
  }
}
