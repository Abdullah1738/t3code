"""robob-watch check: detect newly installed known delivery/shopping packages."""
import json
import os
import subprocess
from pathlib import Path

KNOWN = {'com.deliveroo.orderapp': 'Deliveroo', 'com.instashop': 'InstaShop',
         'com.instashop.app': 'InstaShop', 'com.maf.carrefour': 'Carrefour',
         'com.lulu.luluonline': 'Lulu', 'com.unioncoop.ucs': 'Union Coop',
         'com.elgrocer.shopper': 'elGrocer', 'com.kibsons': 'Kibsons',
         'com.blinkit.customer': 'Blinkit', 'com.swiggy.android': 'Swiggy',
         'com.application.zomato': 'Zomato', 'com.hungerstation.android.web': 'HungerStation'}
EXCLUDED = {'com.amazon.mShop.android.shopping', 'com.noon.buyerapp', 'com.talabat', 'com.careem.acma'}


def detect(packages, seen):
    return sorted((set(packages) & KNOWN.keys()) - set(seen) - EXCLUDED)


def main():
    if (Path.home()/'.local/share/phone-lock/priority-hold').exists():
        return
    state = Path(os.environ['WATCH_DIR'])/'delivery-packages.json'
    p = subprocess.run(['/opt/homebrew/bin/adb', '-s', '002473611000997', 'shell', 'pm', 'list', 'packages', '-3'],
                       capture_output=True, text=True, timeout=12, check=True)
    packages = sorted(line.removeprefix('package:').strip() for line in p.stdout.splitlines() if line.startswith('package:'))
    if not packages:
        raise RuntimeError('Package inventory unavailable')
    old = json.loads(state.read_text()) if state.exists() else None
    state.write_text(json.dumps(packages))
    if old is not None:
        for package in detect(packages, old):
            print(f'New delivery app: {KNOWN[package]} ({package}). Build its read-only catalog CLI in background on opus/gpt-6-astra; preserve logins, yield phone to owner requests. Amazon excluded.')


if __name__ == '__main__':
    main()
