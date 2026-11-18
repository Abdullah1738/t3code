# Runs ON THE SERVER (read-only). Prints "<bx_id> <idle_hours> <own_GB> <name>" for stopped boxes that may be deleted:
# state archived, boatd owner exactly "ardud", not pinned, idle >= MIN_H hours, no queued/running command,
# none of its snapshots has a ZFS clone (not a base for other boxes), not the source or instance of a saved base.
# Oldest idle first. Moni's boxes and boxes without a boatd row are never listed.
import sqlite3, subprocess, sys, time
MIN_H = float(sys.argv[1]) if len(sys.argv) > 1 else 12
con = sqlite3.connect("file:/var/lib/boatd/boatd.db?mode=ro", uri=True, timeout=10)
now = time.time(); G = 2**30
saved = set()
for r in con.execute("select source, instance, pending_instance from saved"):
    saved |= {str(x) for x in r if x}
busy = {r[0] for r in con.execute("select box_id from commands where status in ('queued','running','starting')")}
sn = subprocess.run(["zfs","list","-H","-t","snapshot","-o","name,clones","-r","offbox/incus/containers"],capture_output=True,text=True,check=True).stdout
has_clone = {l.split("\t")[0].split("@")[0].rsplit("/",1)[1] for l in sn.splitlines() if l.split("\t")[1] not in ("-","")}
used = {}
for l in subprocess.run(["zfs","list","-H","-p","-o","name,used","-d","1","offbox/incus/containers"],capture_output=True,text=True,check=True).stdout.splitlines()[1:]:
    n,u = l.split("\t"); used[n.rsplit("/",1)[1]] = int(u)
rows = []
for bid, owner, state, pinned, name, created, stopped, active in con.execute(
        "select id, owner, state, pinned, name, created_at, stopped_at, last_active from boxes where deleted_at is null"):
    ct = bid.replace("_","-",1)
    if state != "archived" or owner != "ardud" or pinned: continue
    if bid in busy or ct in has_clone or bid in saved or ct in saved: continue
    idle = (now - max(x for x in (active, stopped, created) if x)) / 3600
    if idle < MIN_H or ct not in used: continue
    rows.append((idle, bid, used[ct], (name or "").replace(" ","_")[:40]))
for idle, bid, u, name in sorted(rows, reverse=True):
    print(bid, "%.1f" % idle, "%.1f" % (u/G), name)
