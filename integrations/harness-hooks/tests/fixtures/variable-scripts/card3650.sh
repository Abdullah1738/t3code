D=/Volumes/ExternalSSD/crpko-devops/tmp/sweep-3650; mkdir -p "$D" && cat > "$D/issues.py" <<'PY'
import json, sys

def walk(o):
    if isinstance(o, dict):
        if "identifier" in o and "title" in o:
            yield o
        for v in o.values():
            yield from walk(v)
    elif isinstance(o, list):
        for v in o:
            yield from walk(v)

def name_of(v):
    return v.get("name") if isinstance(v, dict) else v

raw = sys.stdin.read()
try:
    data = json.loads(raw)
except Exception as e:
    print("PARSE_ERROR", e, raw[:300])
    sys.exit(0)

seen = {}
for i in walk(data):
    seen.setdefault(i["identifier"], i)

for key, i in seen.items():
    print(key, "|", i.get("title"), "| state=" + str(name_of(i.get("state"))), "| project=" + str(name_of(i.get("project"))), "| assignee=" + str(name_of(i.get("assignee"))), "| created=" + str(i.get("createdAt"))[:10], "| archived=" + str(bool(i.get("archivedAt"))))
print("count", len(seen))
PY
for q in "long email" "email overflow" "verification code email" "email truncat" "OTP email"; do
  echo "== search: $q"
  linctl issue search "$q" --team CRP --newer-than all_time --include-completed --include-archived -j > "$D/s.json" 2> "$D/s.err"; echo "rc=$?"; head -c 300 "$D/s.err"
  /usr/bin/python3 -I "$D/issues.py" < "$D/s.json"
done
