#!/usr/bin/env python3
"""Generate an image via local 9router (Codex sub). Usage: genimg.py "prompt" OUT.png [--size 1024x1024] [--n 1]"""
import argparse, base64, json, sys, urllib.request
p = argparse.ArgumentParser()
p.add_argument("prompt"); p.add_argument("out")
p.add_argument("--size", default="1024x1024")
p.add_argument("--model", default="cx/gpt-image-2")
p.add_argument("--n", type=int, default=1)
a = p.parse_args()
body = json.dumps({"model": a.model, "prompt": a.prompt, "size": a.size, "n": a.n}).encode()
req = urllib.request.Request("http://localhost:20128/v1/images/generations", body, {"content-type": "application/json"})
try:
    d = json.load(urllib.request.urlopen(req, timeout=300))
except urllib.error.HTTPError as e:
    sys.exit(f"error {e.code}: {e.read().decode()[:500]}")
outs = []
for i, item in enumerate(d.get("data", [])):
    path = a.out if i == 0 else a.out.replace(".png", f"-{i+1}.png")
    if item.get("b64_json"):
        open(path, "wb").write(base64.b64decode(item["b64_json"]))
    elif item.get("url"):
        urllib.request.urlretrieve(item["url"], path)
    outs.append(path)
if not outs: sys.exit(f"no image returned: {json.dumps(d)[:500]}")
print("\n".join(outs))
