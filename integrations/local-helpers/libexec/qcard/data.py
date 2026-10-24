"""Market data for qcard price cards. Free, keyless sources with fallbacks.

Yahoo chart API first (stocks, futures, FX, crypto), then Binance (crypto),
frankfurter (FX), gold-api.com (gold/silver spot).
"""
import json, time, urllib.request, urllib.parse
from concurrent.futures import ThreadPoolExecutor

UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) qcard"}
AED_PER_USD = 3.6725
TROY_OZ_G = 31.1034768

# range label -> (yahoo range, yahoo interval, binance interval, binance limit, days)
RANGES = {
    "1D": ("1d", "5m", "15m", 96, 1),
    "1W": ("5d", "60m", "1h", 168, 7),
    "1M": ("1mo", "1d", "1d", 31, 31),
    "1Y": ("1y", "1d", "1d", 365, 365),
    "5Y": ("5y", "1wk", "1w", 260, 1826),
}

ALIASES = {
    "gold": dict(name="Gold", sym="GC=F", spot="XAU", unit="oz", accent="#e9c46a", kind="metal"),
    "xau": "gold", "xauusd": "gold",
    "silver": dict(name="Silver", sym="SI=F", spot="XAG", unit="oz", accent="#c9ccd1", kind="metal"),
    "xag": "silver",
    "btc": dict(name="Bitcoin", sym="BTC-USD", binance="BTCUSDT", accent="#f7931a", kind="crypto"),
    "bitcoin": "btc",
    "eth": dict(name="Ethereum", sym="ETH-USD", binance="ETHUSDT", accent="#8c9eff", kind="crypto"),
    "ethereum": "eth",
    "sol": dict(name="Solana", sym="SOL-USD", binance="SOLUSDT", accent="#14f195", kind="crypto"),
    "oil": dict(name="Brent crude", sym="BZ=F", unit="bbl", accent="#2b2b26", kind="future"),
    "brent": "oil",
    "wti": dict(name="WTI crude", sym="CL=F", unit="bbl", accent="#2b2b26", kind="future"),
    "sp500": dict(name="S&P 500", sym="^GSPC", accent="#16160f", kind="index"),
    "spx": "sp500",
    "nasdaq": dict(name="Nasdaq", sym="^IXIC", accent="#16160f", kind="index"),
}


def get(url, timeout=6):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def resolve(asset):
    key = asset.strip().lower().replace("/", "").replace(" ", "")
    a = ALIASES.get(key)
    if isinstance(a, str):
        a = ALIASES[a]
    if a:
        return dict(a)
    up = asset.strip().upper().replace("/", "")
    if len(up) == 6 and up.isalpha() and up not in ("GOOGLE",):  # EURUSD style FX pair
        return dict(name=f"{up[:3]}/{up[3:]}", sym=f"{up}=X", fx=(up[:3], up[3:]), accent="#2f6fdb", kind="fx")
    if up.endswith("-USD"):
        return dict(name=up[:-4], sym=up, binance=up[:-4] + "USDT", accent="#f7931a", kind="crypto")
    return dict(name=up, sym=up, accent="#16160f", kind="stock")


def yahoo(sym, rng):
    yr, yi = RANGES[rng][:2]
    q = urllib.parse.quote(sym)
    d = get(f"https://query1.finance.yahoo.com/v8/finance/chart/{q}?range={yr}&interval={yi}")
    res = (d.get("chart") or {}).get("result")
    if not res:
        raise ValueError("yahoo: no data for " + sym)
    r = res[0]
    closes = r["indicators"]["quote"][0].get("close") or []
    pts = [[int(t), float(c)] for t, c in zip(r.get("timestamp") or [], closes) if c is not None]
    m = r["meta"]
    return dict(points=pts, price=m.get("regularMarketPrice"), prev=m.get("chartPreviousClose") or m.get("previousClose"),
                currency=m.get("currency") or "USD", name=m.get("longName") or m.get("shortName"),
                at=m.get("regularMarketTime"), source="Yahoo Finance")


def binance(pair, rng):
    _, _, bi, lim, _ = RANGES[rng]
    d = get(f"https://api.binance.com/api/v3/klines?symbol={pair}&interval={bi}&limit={lim}")
    pts = [[int(k[0] / 1000), float(k[4])] for k in d]
    return dict(points=pts, price=pts[-1][1], prev=None, currency="USD", source="Binance", at=int(time.time()))


def frankfurter(base, quote, rng):
    days = max(RANGES[rng][4], 7)
    start = time.strftime("%Y-%m-%d", time.gmtime(time.time() - days * 86400))
    d = get(f"https://api.frankfurter.dev/v1/{start}..?base={base}&symbols={quote}")
    pts = [[int(time.mktime(time.strptime(k, "%Y-%m-%d"))), float(v[quote])] for k, v in sorted(d["rates"].items())]
    return dict(points=pts, price=pts[-1][1], prev=None, currency=quote, source="ECB via Frankfurter", at=int(time.time()))


def spot(metal):
    d = get(f"https://api.gold-api.com/price/{metal}", timeout=4)
    at = d.get("updatedAt")
    ts = int(time.mktime(time.strptime(at[:19], "%Y-%m-%dT%H:%M:%S")) - time.timezone) if at else int(time.time())
    return float(d["price"]), ts


def series(a, rng):
    errs = []
    try:
        return yahoo(a["sym"], rng)
    except Exception as e:
        errs.append(str(e))
    if a.get("binance"):
        try:
            return binance(a["binance"], rng)
        except Exception as e:
            errs.append(str(e))
    if a.get("fx"):
        try:
            return frankfurter(a["fx"][0], a["fx"][1], rng)
        except Exception as e:
            errs.append(str(e))
    if a.get("spot") == "XAU":
        try:
            return binance("PAXGUSDT", rng) | {"source": "Binance PAXG"}
        except Exception as e:
            errs.append(str(e))
    raise RuntimeError("; ".join(errs))


def fmt_num(v, dec=None):
    if dec is None:
        dec = 0 if abs(v) >= 1000 else 2 if abs(v) >= 1 else 4
    return f"{v:,.{dec}f}"


def price_spec(asset, rng="1M", ranges=("1D", "1W", "1M", "1Y", "5Y")):
    """Fetch everything for one asset and return a qcard 'price' spec."""
    a = resolve(asset)
    rng = rng.upper()
    ranges = list(dict.fromkeys(list(ranges) + [rng]))
    out, spot_v = {}, None
    with ThreadPoolExecutor(max_workers=len(ranges) + 1) as ex:
        futs = {r: ex.submit(series, a, r) for r in ranges}
        sp = ex.submit(spot, a["spot"]) if a.get("spot") else None
        for r, f in futs.items():
            try:
                out[r] = f.result()
            except Exception as e:
                out[r] = e
        if sp:
            try:
                spot_v = sp.result()
            except Exception:
                spot_v = None
    good = {r: v for r, v in out.items() if not isinstance(v, Exception) and len(v["points"]) >= 2}
    if not good:
        raise SystemExit(f"qcard: no data for {asset}: {out.get(rng)}")
    main = good.get(rng) or next(iter(good.values()))
    price = main["price"] if main["price"] is not None else main["points"][-1][1]
    at = main.get("at") or int(time.time())
    source = main["source"]
    sources = sorted({v["source"] for v in good.values()})
    if spot_v:
        price, at = spot_v
        source = "gold-api.com spot" + (" · chart " + ", ".join(sources) + (" futures" if a["sym"].endswith("=F") and "Yahoo Finance" in sources else ""))
    else:
        source = ", ".join(sources)
    cur = main.get("currency", "USD")
    name = a["name"] if a["kind"] != "stock" else (main.get("name") or a["name"])
    dec = 4 if a["kind"] == "fx" else None
    spec = dict(template="price", name=a.get("name", asset).lower(), title=name,
                sub=(a["sym"] if a["kind"] in ("stock", "index") else
                     {"metal": f"{a.get('spot','')}/USD per troy ounce", "crypto": "USD", "fx": a["name"],
                      "future": f"USD per {a.get('unit','unit')}"}.get(a["kind"], "")),
                value=price, currency=(None if a["kind"] == "fx" else cur), decimals=dec, accent=a.get("accent"),
                range=rng if rng in good else next(iter(good)),
                series={r: {"points": good[r]["points"], "prev": good[r].get("prev") if r == "1D" else None} for r in ranges if r in good},
                source=source, asof=at)
    if a.get("spot") == "XAU":
        g24 = price * AED_PER_USD / TROY_OZ_G
        spec["rows"] = [
            {"label": "Dubai 24K", "value": f"AED {g24:,.2f}", "note": "per gram, spot equivalent"},
            {"label": "Dubai 22K", "value": f"AED {g24 * 22 / 24:,.2f}", "note": "per gram"},
            {"label": "Dubai 21K", "value": f"AED {g24 * 21 / 24:,.2f}", "note": "per gram"},
            {"label": "Ounce in AED", "value": f"AED {price * AED_PER_USD:,.0f}", "note": "at the 3.6725 peg"},
        ]
        spec["note"] = "Dubai shop boards add a small premium over spot."
    if a.get("spot") == "XAG":
        spec["rows"] = [{"label": "Per gram", "value": f"AED {price * AED_PER_USD / TROY_OZ_G:,.2f}", "note": "spot equivalent"}]
    return spec
