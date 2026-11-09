python3 - <<'PY'
from pathlib import Path
p=Path('src/lib/stores/futures-data.js')
s=p.read_text().replace('pos.margin = prevMargin + (price * qty) / (pos.lev ?? lev);','pos.margin = prevMargin + (price * qty) / lev;')
start=s.index('  function adjustMargin(id, delta) {')
end=s.index('  function setTPSL(',start)
s=s[:start]+'''  function adjustMargin(id, delta, walletDelta) {
    if (connBlocked('adjust margin')) return false;
    const pos = state.positions.find((p) => p.id === id); if (!pos) return false;
    const inr = pos.family === 'inrm';
    const fx = state.fx.rate;
    const applied = inr ? (walletDelta ?? delta * fx) : delta;
    if (inr) {
      // Held INR is authoritative; revalue the reference amount at this action's rate.
      const held = pos.marginInr ?? (pos.margin || 0) * fx;
      if (held + applied < -0.00000001) {
        if (window.TOAST) window.TOAST.error('Margin removal failed', 'Amount exceeds the position margin.');
        return false;
      }
      pos.marginInr = Math.max(0, held + applied);
      pos.margin = pos.marginInr / fx;
    } else {
      pos.margin = Math.max(0, (pos.margin || 0) + applied);
    }
    // recompute effective leverage & liq from margin
    pos.lev = pos.margin > 0 ? Math.max(1, (pos.entry * pos.qty) / pos.margin) : null;
    pos.liq = liqPrice(pos.side, pos.entry, pos.lev ?? Infinity, pos.entry * pos.qty);
    emit();
    if (window.TOAST) window.TOAST.success(applied >= 0 ? 'Margin added' : 'Margin removed',
      (inr ? tinr(Math.abs(applied)) : tnum(Math.abs(applied), 2) + ' USDT') + ' · ' + pos.symbol);
    return true;
  }
''' + s[end:]
p.write_text(s)
p=Path('src/components/organisms/adjust-margin-modal.jsx')
s=p.read_text()
s=s.replace("  const capReduce = Math.max(0, (p.margin || 0) - maintenanceFloor);","  const curMargin = isInr && p.marginInr != null ? p.marginInr / fx : (p.margin || 0);\n  const capReduce = Math.max(0, curMargin - maintenanceFloor);")
s=s.replace("  const curMargin = p.margin || 0;\n","")
s=s.replace("    window.FUT.adjustMargin(p.id, delta);\n    onClose && onClose();", """    const applied = isInr
      ? window.FUT.adjustMargin(p.id, delta, mode === 'add' ? typedWalletAmount : -typedWalletAmount)
      : window.FUT.adjustMargin(p.id, delta);
    if (applied !== false) onClose && onClose();""")
p.write_text(s)
PY
node --test tests/adjust-margin.test.mjs > /Volumes/ExternalSSD/crpko-devops/tmp/card-3041/r1-web-after.log 2>&1
tail -18 /Volumes/ExternalSSD/crpko-devops/tmp/card-3041/r1-web-after.log