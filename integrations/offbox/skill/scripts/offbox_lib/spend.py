"""Billing-period spend from one account meter request, $100 alerts and the $750 cap."""

from __future__ import annotations

import json
import datetime as dt

from . import api
from .common import (CAP_PATH, OffboxError, atomic_write_json, db, event, file_lock, kv_get, kv_set, month_key, month_start_utc,
                     now, read_json, say)
from .identity import telegram

CAP_DOLLARS = 750.0
STEP_DOLLARS = 100.0


def record_final_usage(con, box_id: str) -> None:
    """Called before deleting a box: the usage endpoint 404s afterwards."""
    try:
        u = api.usage(box_id, since=month_start_utc())
    except OffboxError:
        return
    if u:
        con.execute("INSERT OR REPLACE INTO box_usage VALUES (?,?,?,?,?)",
                    (box_id, month_key(), float(u.get("dollars") or 0), int(u.get("seconds") or 0), now()))
        con.commit()


def compute() -> dict:
    """One /limits call, independent of the number of archived boxes. Never fan out usage calls."""
    con = db()
    try:
        return _compute(con)
    finally:
        con.close()


def _compute(con) -> dict:
    L = api.limits()
    if L.get('creditUsedSeconds') is None or not L.get('subscriptionCurrentPeriodEnd'):
        raise OffboxError('boat /limits missing spend meter or billing period; keeping previous cap state')
    sps = float(L.get('creditSecondsPerDollar') or 100000)
    used = float(L['creditUsedSeconds'])
    if sps <= 0 or used < 0:
        raise OffboxError('boat /limits invalid spend meter; keeping previous cap state')
    period = L['subscriptionCurrentPeriodEnd']
    quota, rem = float(L.get('subscriptionQuotaSeconds') or 0), float(L.get('subscriptionRemainingSeconds') or 0)
    plan_used = max(0, quota-rem)
    con.execute('BEGIN IMMEDIATE')
    previous = kv_get(con, 'spend_meter') or {}
    baseline = previous.get('baseline', 0)
    if previous and previous.get('period_end') != period:
        # Support both a cumulative meter and a provider-reset meter at renewal.
        baseline = max(0, used-plan_used) if used >= previous.get('used', used+1) else 0
    if used < baseline:
        baseline = 0
    seconds = max(plan_used, used-baseline)
    if previous.get('period_end') == period:
        seconds = max(seconds, previous.get('seconds', 0))
    kv_set(con, 'spend_meter', {'period_end': period, 'baseline': baseline, 'used': used, 'seconds': seconds})
    end = dt.datetime.fromisoformat(period.replace('Z','+00:00'))
    # Keep the established alert key shape, keyed to the month the billing period began.
    billing_month = (end.replace(day=1)-dt.timedelta(days=1)).strftime('%Y-%m')
    lim = {'plan': L.get('sandboxPlanKey'), 'period_end': period,
           'plan_used_dollars': round(plan_used/sps, 4), 'plan_left_dollars': round(rem/sps, 2),
           'pack_dollars': L.get('packBalanceDollars'),
           'last24h_dollars': round((L.get('last24hUsageSeconds') or 0)/sps, 4),
           'active_boxes': L.get('activeSandboxes'), 'can_start': L.get('canStart')}
    out = {'month': month_key(), 'billing_month': billing_month, 'period_end': period,
           'spend': round(seconds/sps, 4), 'per_box_sum': None, 'limits': lim,
           'cap': CAP_DOLLARS, 'cap_state': read_json(CAP_PATH, {}), 'boxes': []}
    kv_set(con, 'spend_last', {k: out[k] for k in ('month','billing_month','period_end','spend','per_box_sum')})
    return out


def stop_all(reason: str) -> int:
    from .lease import ensure_holds
    con = db()
    # A database from before prune_holds has no such table; the release below would raise on the first box and
    # abort the loop mid-stop. Create it before the loop, so every box is stopped.
    ensure_holds(con)
    n = 0
    for b in api.list_boxes():
        if b.get("state") in api.LIVE_STATES or b.get("state") in api.STARTING_STATES:
            try:
                api.stop(b["id"])
            except OffboxError as e:
                event(con, b["id"], "stop_failed", f"{reason}: {e}")
                continue
            con.execute("UPDATE leases SET state='stopped' WHERE box_id=? AND state='running'", (b["id"],))
            con.commit()
            event(con, b["id"], "stop", reason)
            n += 1
            # The hold is released only if boat confirms the box is stopped under its lock; a pending stop keeps it.
            from .lease import release_if_confirmed
            release_if_confirmed(con, b["id"])
    return n


def check(quiet: bool = False) -> dict:
    with file_lock('spend-check', timeout=30):
        con = db()
        try:
            return _check(con, quiet)
        finally:
            con.close()


def _check(con, quiet: bool) -> dict:
    out = compute()
    spend, month = out["spend"], out["month"]
    period = out['period_end']
    cap = read_json(CAP_PATH, {})
    if cap.get("capped") and cap.get('period_end', period) != period:
        atomic_write_json(CAP_PATH, {"capped": False, "month": month, "spend": spend, "cleared_at": now(),
                                     "previous": cap})
        event(con, None, "cap_cleared", f"new month {month}")
    steps = int(spend // STEP_DOLLARS)
    for step in range(1, steps + 1):
        key = f"offbox-spend-{out['billing_month']}-{step * 100}"
        if kv_get(con, f"sent:{key}"):
            continue
        sev = "attention" if step * STEP_DOLLARS >= CAP_DOLLARS else "info"
        msg = f"offbox: boat.dev spend crossed ${step * 100} this billing period (now ${spend:.2f}, cap ${CAP_DOLLARS:.0f})."
        if step * STEP_DOLLARS >= CAP_DOLLARS:
            msg += " Cap hit: new leases refused, all boxes stopped; heavy commands remain remote-only."
        if telegram(msg, key, severity=sev):
            kv_set(con, f"sent:{key}", now())
    if spend >= CAP_DOLLARS:
        was = read_json(CAP_PATH, {})
        atomic_write_json(CAP_PATH, {"capped": True, "month": month, 'period_end': period, "spend": spend, "at": now(),
                                     "cap": CAP_DOLLARS})
        if not (was.get("capped") and was.get("month") == month):
            event(con, None, "cap_hit", f"${spend:.2f}")
            key = f"offbox-cap-{out['billing_month']}-{CAP_DOLLARS:.0f}"
            if not kv_get(con, f"sent:{key}") and telegram(
                    f"offbox: spend cap ${CAP_DOLLARS:.0f} hit (now ${spend:.2f}): new leases refused, all boxes stopped.",
                    key, severity="attention"):
                kv_set(con, f"sent:{key}", now())
        n = stop_all("spend cap")
        out["stopped"] = n
    else:
        # A cap tripped in this period stays tripped unless the cap has since been raised above spend.
        # Records written before the cap was stored were all set at $500.
        same_period = cap.get('period_end', period) == period
        raised = float(cap.get('cap', 500.0)) < CAP_DOLLARS
        still_capped = bool(cap.get('capped') and same_period and not raised)
        if cap.get('capped') and same_period and raised:
            event(con, None, "cap_cleared", f"cap raised to ${CAP_DOLLARS:.0f} at ${spend:.2f}")
        atomic_write_json(CAP_PATH, {"capped": still_capped, "month": month, 'period_end': period, "spend": spend,
                                     "cap": float(cap.get('cap', 500.0)) if still_capped else CAP_DOLLARS})
    out["cap_state"] = read_json(CAP_PATH, {})
    return out


def print_report(out: dict, as_json: bool) -> None:
    if as_json:
        print(json.dumps(out, indent=1))
        return
    lim = out.get("limits") or {}
    cap = out.get("cap_state") or {}
    print(f"billing period ending {out['period_end']}: ${out['spend']:.2f} of ${out['cap']:.0f} cap"
          f"{'  ** CAPPED **' if cap.get('capped') and cap.get('month') == out['month'] else ''}")
    if lim and "error" not in lim:
        print(f"plan {lim.get('plan')}: ${lim.get('plan_used_dollars')} used this period, ${lim.get('plan_left_dollars')} left "
              f"(renews {lim.get('period_end')}), packs ${lim.get('pack_dollars')}, last 24h ${lim.get('last24h_dollars')}")
    for b in out["boxes"][:30]:
        print(f"  {b['box']:<13} {b.get('state') or '':<9} {b.get('type') or '':<8} ${b['dollars']:<8.4f} "
              f"{b.get('repo') or ''} {b.get('name') or ''}")
