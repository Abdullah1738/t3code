python3 - <<'PY'
from pathlib import Path
p=Path('tmp/escrow-settlement/edit.py')
s=p.read_text().replace('BONEXP-064', 'BONEXP-order').replace('BONEXP-065','BONEXP-064').replace('BONEXP-order','BONEXP-065')
s=s.replace('while CROSS uses the same fill\\\'s positive realized PnL, then wallet cash `AVAILABLE`, and only the remaining shortfall uses insurance.', 'while CROSS uses the same fill\\\'s positive realized PnL, then wallet cash `AVAILABLE` subject to the existing Cross episode lock rule, and only the remaining shortfall uses insurance.')
s=s.replace('house escrow pays `8` and proceeds pay `1`.', 'house escrow pays `8` and proceeds pay `1`. For a SELL, or any child whose price bound is a floor, the excess is fee bps times price improvement, paid from the extra proceeds that improvement produced.')
# Add fee-chain cross-reference without replacing GST/position/debit restrictions.
s=s.replace("snapshot('C')", '''replace(lc,
    '5) Conservation for every valid user fill:',
    '   - for fees in items 2 through 4, an expired order source contributes only its exact-attempt escrow fee component after the live allocation or order fee sources and before the profit, `AVAILABLE`, or position-backstop step, in the lot order of [§4.6.3](#s4_6_3). GST and realized-loss source rules and the Cross episode lock restriction are unchanged.\\n5) Conservation for every valid user fill:')
snapshot('C')''')
s=s.replace("snapshot('D')", '''replace(tdd,
    'debit `HOUSE:BONUS_BUDGET` by at most the exact escrow amount, exclude escrow from position equity, and never debit unreserved user cash',
    'debit `HOUSE:BONUS_BUDGET` by at most the exact escrow amount, exclude escrow from position equity, and use no user cash to replace the expired source; ordinary fee excess follows its existing cash/proceeds chain')
replace(tdd,
    '- BONEXP-014: Ensures that unavoidable settlement above exact escrow meets deficit-ownership constraints: spot fee deficit to `HOUSE:BONUS_BUDGET`; perps opening-quantity fee deficit to `HOUSE:LIQUIDATION_INSURANCE`; perps reducing-quantity fee, GST, or realized loss paid first from the closing position under Lifecycle §2.7.6 with only a bankrupt-position remainder to `HOUSE:LIQUIDATION_INSURANCE`; ISOLATED opening-margin shortage recorded as non-collateral position shortfall without unreserved user cash',
    '- BONEXP-014: Ensures that unavoidable settlement above live fee sources plus exact escrow meets ordinary-excess constraints: spot SELL fee from proceeds with the existing spot fee cap and no extra house fee deficit; perps opening fee from wallet AVAILABLE then ordinary insurance shortfall; perps reducing fee through the existing ISOLATED or CROSS chain of [Lifecycle §2.7.6](Lifecycle.md#s2_7_6), including its Cross episode lock rule; GST and realized loss keep their existing sources, and ISOLATED opening-margin shortage remains non-collateral position shortfall without unreserved user cash')
replace('shared/Ledger.md',
    '  - any fee or realized-loss amount beyond the bound escrow follows the deficit ownership of [§2.2.3](#s2_2_3) item 1 and 2: a spot fee deficit is booked to `HOUSE:BONUS_BUDGET`; a perps opening-quantity fee deficit is booked to `HOUSE:LIQUIDATION_INSURANCE`; a perps reducing-quantity fee, GST, or realized loss is paid first by the closing position ([Trading Core §2.7.6](../binaries/trading-core/Lifecycle.md#s2_7_6)), and only the remainder of a bankrupt position is booked to `HOUSE:LIQUIDATION_INSURANCE`; opening-margin shortage follows the durable position shortfall path instead.',
    '  - expired-source house fee backing stops at the bound escrow. Fees consume live sources first, then exact-attempt escrow fee components in ascending bonus_lot_id, then follow the ordinary excess chain of [Trading Core §4.6.3](../binaries/trading-core/Lifecycle.md#s4_6_3): spot SELL uses proceeds, perps opening uses wallet AVAILABLE then ordinary insurance shortfall, and reducing quantity keeps the existing ISOLATED or CROSS backstop of [Trading Core §2.7.6](../binaries/trading-core/Lifecycle.md#s2_7_6), including the Cross episode lock rule. No additional expiry-attributable fee deficit is booked. GST and realized loss retain their existing rules, and opening-margin shortage follows the durable position shortfall path instead.')
subprocess.run(['ruby', 'tmp/scripts/changelog_add.rb', '--file', 'shared/Ledger.md', '--change', 'Cap expired-source house fee backing at escrow and use the ordinary fee-excess chain, preserving opening-margin shortfall and other debit rules.'], check=True, env={**os.environ, 'LC_ALL':'en_US.UTF-8'})
# Fold the corrections to the existing tests into the one D entry.
p = Path('tmp/changelog/pending.yml')
p.write_text(p.read_text().replace('Add: BONEXP-064; Change: N/A; Remove: N/A', 'Add: BONEXP-064; Change: BONEXP-013, BONEXP-014; Remove: N/A'))
snapshot('D')''')
p.write_text(s)
# Restore only this task's edited tracked files, then regenerate its incremental patches.
import subprocess
for name in ['binaries/trading-core/Data Models.md','binaries/trading-core/Lifecycle.md','binaries/trading-core/TDD.md','tmp/changelog/pending.yml','shared/Ledger.md']:
    Path(name).write_bytes(subprocess.check_output(['git','show','c441481b:'+name]))
PY
python3 tmp/escrow-settlement/edit.py
git diff --check