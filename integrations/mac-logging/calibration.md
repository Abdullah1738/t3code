# Sustained-overload calibration (#157)

The sensitivity-first candidate thresholds are retained. **The ≤2 notifications/day target fails** on three of the four baseline days. The six incidents fall inside two long replay episodes, rather than six independent onsets. The last three are in an episode whose onset is deliberately muted by the requested cooldown. This is not evidence of six delivered warnings or a guarantee of a warning ten minutes before each human report.

## Reproduce

From the repository root, with the original artifacts available:

```sh
/usr/bin/python3 -I integrations/mac-logging/replay_overload.py \
  --logs /Users/ardud/.robob/logs/tools/mac \
  --timeline /Users/ardud/.robob/board-artifacts/mac-swap-storm-1120/timeline.csv \
  --pressure /Users/ardud/.robob/board-artifacts/imessage-loop-stall/pressure-split.json
```

`dayFiles` reads 8,991 cpu.sample/memory.sample rows, streaming the six files. It merges fields by their actual timestamps and replays evaluate on a 30-second grid. Each field expires after 360 seconds; ncpu is hardware configuration and persists. Missing/error/null readings invalidate the corresponding hold and cannot prove recovery. No lookahead or interpolation across blind periods is used. The 360-second carry is an assumption necessitated by the old five-minute memory cadence, not an observed 30-second signal. First-row and hold crossings are quantized to that grid (≤30 seconds). Memory readings were collected over a window before their event timestamp, adding unmeasured collection uncertainty.

The separate `timeline` replay reads all 503 five-minute aggregate rows from #151. It uses load1Max and the memory snapshot, not invented raw readings; bucket maxima can advance onset within a bucket. Its times cannot establish exact notification lead. Legacy cadence is **never** supplied as sampler self-lag. The real-row fixture is a reduced cpu/memory slice of 19 Nov 07:50–08:20Z, retaining source line numbers and the fields used by replay. It produces onset 08:03:53.834Z (pressure); the full history grid produces 08:04:18.722Z.

## Baseline 15–18 Nov

Every onset on these days is counted against the requested false-alert budget. These are candidate false alerts, not adjudicated harmless incidents (16 Nov includes a real memory failure/reboot). Counts retain cooldown state across days.

| UTC day | Logged onsets | Queued onset notifications | Target ≤2/day |
|---|---:|---:|---|
| 15 Nov | 8 | 4 | fail |
| 16 Nov | 5 | 1 | pass |
| 17 Nov | 4 | 3 | fail |
| 18 Nov | 6 | 3 | fail |

There are also one recovery notification per notified episode; these are not included as onset alerts. A hold sweep (swap/pressure seconds → queued notifications on 15/16/17/18 Nov) gave 300/600 → 3/1/4/2, 600/600 → 3/1/4/2, 300/900 → 3/1/4/1, 600/900 → 3/1/4/1. Reproduce a sweep row with `--swap-hold <seconds> --pressure-hold <seconds>` on the command above. Longer holds do not meet both targets and would delay pressure-only detection beyond ten minutes. No threshold was tuned to synthetic data to claim the blind episodes were observed.

## Failed-probe input class

Every form below is tested. A memory row invalidates its attempted memory probes while a CPU-only row invalidates its load reading and leaves memory on its separate freshness clock. Errors override a field even when it still contains an older numeric value.

| Probe | Failed forms | Invalidated fields |
|---|---|---|
| swap | absent, null, missing used, missing total, error with old values, nonnumeric used | swapUsedBytes / swapTotalBytes as applicable |
| VM | absent, null, empty object, error with old values, nonnumeric free | freePages |
| pressure | absent, null, error with old value, nonnumeric level | pressureLevel |
| load | absent, null, error with old values, nonfinite number, wrong array length | load |
| CSV memory snapshot | blank used/total/free columns | respective memory fields |

Regression: a bad reading at 0s followed by any failed probe form at 270s must not produce a 300s onset. Load uses a 570s failure before its 600s hold. The complete input table runs with every test invocation.

## Incident lead times and missing ground truth

Times in this table are UTC. The card packet does not supply exact first-human-report timestamps for all six. Its measured/report bounds are kept distinct from the first time the owner felt a stall. Recall did not recover additional exact reports. Card creation times are not substituted for human reports.

| Incident | Day-file episode onset | Human report / observed bound | Replay lead to that bound | Interpretation |
|---|---|---|---:|---|
| 19 Nov ~13:37 (#147/#152 comparison) | 19 Nov 08:04:18.722 | exact human time unavailable; first global pause 13:37:50.176 in pressure-split.json | 333.52 min to pause | Episode already active; onset notified. Lead is to the instrumented pause, not a proven first-human report. |
| 19 Nov ~18Z (#145) | 19 Nov 08:04:18.722 | #145 packet measurements begin 18:03 | 598.69 min to measurement | Same open episode. Actual first report unavailable. |
| 20 Nov 06:15–06:35 (#151/iMessage #105) | 19 Nov 08:04:18.722 | #151 packet: owner failures begin ~06:15 | 1330.69 min to window | Same open episode. Actual first report unavailable. |
| 20 Nov 12:41–13:45 (#152) | 20 Nov 08:59:48.722 | #152 packet: reporter measurement 13:37 | 277.19 min to measurement | New onset **log-only**; only 25.5 min after previous end. No fresh notification. |
| 20 Nov 19:27–20:30 (#154) | 20 Nov 08:59:48.722 | #154 packet: Crpko #4795 report about 20:31 | ~691.19 min to report | Same log-only episode; legacy samples cannot establish its state during the blind peak. |
| 20 Nov 22:00–22:30 (#157/#151 sighting) | 20 Nov 08:59:48.722 | #157 packet and #151 sighting: evaluator report 22:50 | 830.19 min to report | Same log-only episode; no cpu/memory rows at peak. |

The first day-file episode ends at 20 Nov 08:34:18.722, the second at 23:07:18.722. Unknown readings keep an existing episode open; they do not prove continuing pressure, and do not justify calling the arithmetic above a continuously measured warning lead. The CSV replay produces onsets 19 Nov 08:00 and 20 Nov 09:10; the latter is also log-only. Its first episode ends 20 Nov 08:30; its second remains open at CSV EOF.

The supplied pressure-split ground truth covers only 19 Nov 04:24:22 through 20 Nov 04:30. Of 1,205 recorded stall windows, 1,168 start inside replay-active episodes, totaling 8,907,597.975 stall-ms. That overlap shows broad sensitivity, not precision, causation, or coverage of the later 20 Nov incidents. In particular it cannot validate 06:15, 12:41, 19:27 or 22:00 on 20 Nov.

## Blindness and self-lag

The old cpu/memory samplers went blind before the noon and evening peaks (#152/#157). Their missing rows and ps timeouts do not measure how the new no-fork process would have been scheduled. No host.vitals clock existed on 15–20 Nov, so a historical self-lag detection time is **unobservable**.

The self-lag test explicitly replays real evaluation times 0, 90, 180 seconds: the second delayed tick produces onset at 180s, inside three minutes. Applied conditionally at 12:41, 19:27 or 22:00, that schedule would produce 12:44, 19:30 or 22:03, respectively. These are conditional examples, not historical observations. One gap alone does not alert; if the process is entirely descheduled, it cannot alert until it runs again. The ten-minute end-to-end goal therefore needs a future incident with actual host.vitals and bridge acceptance timestamps.

## Final thresholds and behavior

- Swap used / allocated total ≥80% **and** free pages <40,000 for 300s.
- kern.memorystatus_vm_pressure_level ≥2 for 300s (1 normal, 2 warn, 4 critical). vm.memory_pressure and memorystatusLevel are not interpreted as pressure levels.
- Load1 ≥10×ncpu for 600s (160 on this 16-CPU host).
- At least two inter-tick gaps ≥90s whose end times fall in the last 300s.
- Clear only after all three numeric conditions are known and below threshold and all lag marks have expired, continuously for 600s. This is conservative while readings fail; it never invents recovery from missing data.
- Emit onset/end, and a changed accumulated peak no more than once per 600s. All episodes, including muted ones, are logged. Keep one episode at a time.
- Queue at most one onset per 3600s; any new onset less than 3600s after the previous end is log-only, with no orphan recovery alert. Cooldowns, pending payloads and the evaluator state persist across process restarts.

This keeps the card's sensitive starting thresholds and publishes the failed false-alert target. Raising load misses the lower-load memory incidents; swap ratio alone is noisy because macOS grows swap files, so it always requires low free pages. Longer holds tested above did not solve baseline notification counts. No new watcher/daemon or other alerts are added. The separate #161 consumer must use host.overload phase=onset and its conditions; it must not infer that notified=false means no overload.

## Source identities (SHA-256)

- `/Users/ardud/.robob/logs/tools/mac/2026-11-15.ndjson`: `8aa0aec3cb140b1effe6f2cacb9127b48b74cb07462ce4406795941196f6dbc6`
- `/Users/ardud/.robob/logs/tools/mac/2026-11-16.ndjson`: `6b77ee0b39479b4d83978b15bd5a0880320a0a2e1d3b4f29e602a9ce0e142e0a`
- `/Users/ardud/.robob/logs/tools/mac/2026-11-17.ndjson`: `f39e97bb22568d8f583de8a6e3b3d6a546ec14b7131479b68f4252714044744f`
- `/Users/ardud/.robob/logs/tools/mac/2026-11-18.ndjson`: `8d561bf8ef3aa3259cbfa971e29fa4ad32331467d5d0a5eacd42483c389421f9`
- `/Users/ardud/.robob/logs/tools/mac/2026-11-19.ndjson`: `6e00238627567686923e88fec2338423490ee128b43f9939687881610ddb5406`
- `/Users/ardud/.robob/logs/tools/mac/2026-11-20.ndjson`: `833744d75aa4f4622361fadcaa3ae7123c6dda1f0993d77440662791aa9bd69d`
- `/Users/ardud/.robob/board-artifacts/mac-swap-storm-1120/timeline.csv`: `5e69defda87550b7d5a535eb7f7fc9db3cefd741cf59f5348dbcb94950667b2e`
- `/Users/ardud/.robob/board-artifacts/imessage-loop-stall/pressure-split.json`: `2e9bb892ac8287db6e41beb07fe4554c25f9ba28ab84b27ef6afe7590952d8c0`
