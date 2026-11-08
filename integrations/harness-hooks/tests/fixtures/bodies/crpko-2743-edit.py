from pathlib import Path
import difflib
import os
import subprocess

root = Path(__file__).resolve().parents[2]
os.chdir(root)
paths = ['binaries/trading-core/Data Models.md', 'binaries/trading-core/Lifecycle.md', 'binaries/trading-core/TDD.md', 'tmp/changelog/pending.yml', 'shared/Ledger.md', 'binaries/trading-core/Contracts.md']
before = {p: Path(p).read_text() for p in paths}

def replace(path, old, new):
    text = Path(path).read_text()
    assert text.count(old) == 1, (path, old[:100], text.count(old))
    Path(path).write_text(text.replace(old, new))

def changelog(file, change):
    subprocess.run(['ruby', 'tmp/scripts/changelog_add.rb', '--file', 'binaries/trading-core/' + file, '--change', change], check=True, env={**os.environ, 'LC_ALL':'en_US.UTF-8'})

def snapshot(item):
    global before
    after = {p: Path(p).read_text() for p in paths}
    patch = ''.join(''.join(difflib.unified_diff(before[p].splitlines(True), after[p].splitlines(True), fromfile='a/'+p, tofile='b/'+p)) for p in paths)
    Path('tmp/escrow-settlement/'+item+'.patch').write_text(patch)
    before = after

dm, lc, tdd = paths[:3]
replace(dm,
    '  - `RESERVED` requires a positive amount equal to the sum of the exact live fee-only `BonusReservationRecord` rows named by the canonical segment list; every row\'s `reservation_change_id` is this deterministic child identity',
    '  - `RESERVED` requires `spot_sell_fee_bonus_reserved_atomic > 0` and means positive fee-only bonus segments were bound to this child before submission. It remains `RESERVED` until attempt-final settlement sets `SETTLED`, even after some or all segments convert to expiry escrow; `spot_sell_fee_bonus_reserved_atomic` and the canonical segment list retain their pre-submission values until that settlement. For each listed segment ID, either the exact live fee-only `BonusReservationRecord` exists with this deterministic child identity as `reservation_change_id`, or the row is absent and `expiry_escrow_attempt_idx(order_id, attempt_id)` contains at least one escrow row whose source lot is `EXPIRED`. A missing live row without that exact-attempt escrow evidence is an invariant. Let `live_sum` be the sum of this child\'s live listed rows: `live_sum <= spot_sell_fee_bonus_reserved_atomic`, with equality required when no listed segment was converted. The child\'s converted part is `spot_sell_fee_bonus_reserved_atomic - live_sum`, derived and never stored; no segment-to-lot reconstruction is required')
replace(tdd,
    '- INVAR-001: Ensures that non-negativity',
    '- BONEXP-062: Ensures that a submitted Spot SELL child with fee-only segments on live L1 and L2 converted to expiry escrow meets "the child stays RESERVED with its pre-submission amount and segment IDs, its exact live L1 row has the child reservation_change_id, the missing L2 row is accepted only with exact-attempt escrow on an EXPIRED lot, live_sum never exceeds the stored amount and equals it when nothing converted, and the converted part is derived without storage; a missing listed row without that attempt escrow fails as an invariant" constraints per [Data Models §1.3.6](Data%20Models.md#s1_3_6)\n- INVAR-001: Ensures that non-negativity')
changelog('Data Models.md', 'Keep submitted Spot SELL fee reservations RESERVED through expiry conversion, retaining pre-submission values and checking live rows plus exact-attempt escrow evidence.')
changelog('TDD.md', 'Add: BONEXP-062; Change: N/A; Remove: N/A')
snapshot('A')

replace(dm,
    '  - the row is created only for the order\'s exact `in_flight_attempt_id` at expiry',
    '  - the row is created only for the order\'s exact `in_flight_attempt_id` at expiry; settlement of attempt `X` reads escrow only through `("bonus","expiry_escrow_attempt_idx", order_id, X, *)` (at most `64` rows), so an older or newer attempt never reads another attempt\'s escrow, and no generation-tail or retained-ledger derivation is used')
replace(lc,
    '4) An `EXPIRED` lot may settle only through a `BonusExpiryEscrowRecord` bound to the exact `(order_id, attempt_id, bonus_lot_id)`:',
    '4) An `EXPIRED` lot may settle only through a `BonusExpiryEscrowRecord` bound to the exact `(order_id, attempt_id, bonus_lot_id)`. Settlement of attempt `X` reads only `expiry_escrow_attempt_idx(order_id, X)` (at most `64` rows); creation is fenced to the order\'s exact `in_flight_attempt_id` at expiry ([Data Models §1.3.4](Data%20Models.md#s1_3_4)), so older or newer attempts never use another attempt\'s escrow and no generation-tail or ledger derivation is used:')
replace(tdd,
    '- INVAR-001: Ensures that non-negativity',
    '- BONEXP-063: Ensures that attempt A retains expiry escrow when attempt B is later claimed meets "B reads only expiry_escrow_attempt_idx(order_id, B), never reads or consumes A\'s rows even on the same order and lot, and leaves A\'s escrow unchanged; creation binds only the exact in_flight_attempt_id, no generation-tail or retained-ledger derivation is used, and a COMPLETED A replay remains a no-op" constraints per [Data Models §1.3.4](Data%20Models.md#s1_3_4) and [Lifecycle §4.6](Lifecycle.md#s4_6)\n- INVAR-001: Ensures that non-negativity')
changelog('Data Models.md', 'Fence expiry escrow settlement to the exact attempt index, without generation-tail or retained-ledger reconstruction.')
changelog('Lifecycle.md', 'Read expiry escrow only through the settling attempt index; an older or newer attempt cannot consume another attempt\'s escrow.')
changelog('TDD.md', 'Add: BONEXP-063; Change: N/A; Remove: N/A')
snapshot('B')

replace(lc,
    '       1) the order’s reserved bonus segments (`OrderRecord.reserved_bonus[]`) in `(reservation_generation,reservation_segment_index)` order\n       2) cash from the order’s reserved quote balance in `RESERVED_ORDER`',
    '       1) the order\'s live reserved bonus segments (`OrderRecord.reserved_bonus[]`) in `(reservation_generation,reservation_segment_index)` order\n       2) cash from the order\'s reserved quote balance in `RESERVED_ORDER`\n       3) the exact attempt\'s expiry escrow fee components in ascending `bonus_lot_id`, debiting `HOUSE:BONUS_BUDGET` under the expiry boundary of [§4.6](#s4_6); any remainder follows the spot fee cap of item 3')
replace(lc,
    '     - debit only the exact fee-only bonus segments durably bound to this attempt\'s submitted children by the pre-submission transaction in [§4.3.1](#s4_3_1), ordered by `child_seq` and then `(reservation_generation,reservation_segment_index)`, then net every remainder from quote proceeds. The segments are debited only for the bonus-paid part left after the spot fee cap of item 3; a forgone amount stays in the segment until the release below.',
    '     - debit first the exact live fee-only bonus segments durably bound to this attempt\'s submitted children by the pre-submission transaction in [§4.3.1](#s4_3_1), ordered by `child_seq` and then `(reservation_generation,reservation_segment_index)`, then the exact attempt\'s expiry escrow fee components in ascending `bonus_lot_id`, debiting `HOUSE:BONUS_BUDGET` under the expiry boundary of [§4.6](#s4_6), then net the remainder from quote proceeds. Plan the complete source order before any debit and apply the spot fee cap of item 3; a forgone amount remains in its live segment or house escrow until release.')
replace(lc,
    '     4) reducing quantity only: the position money of the fill, then the remaining isolated cash, as `fee_paid_position_cash_atomic`; position bonus allocations never pay a fee.',
    '     4) the exact attempt\'s expiry escrow fee components in ascending `bonus_lot_id`, debiting `HOUSE:BONUS_BUDGET` under the expiry boundary of [§4.6](#s4_6), after all live order fee sources and before any unreserved cash or position backstop.\n     5) opening quantity then uses the same wallet\'s cash `AVAILABLE` and the ordinary insurance shortfall rule; reducing quantity follows [§2.7.6](#s2_7_6): ISOLATED uses the position money of the fill, then remaining isolated cash, as `fee_paid_position_cash_atomic`, while CROSS uses the same fill\'s positive realized PnL, then wallet cash `AVAILABLE` subject to the existing Cross episode lock rule, and only the remaining shortfall uses insurance. Position bonus allocations never pay a fee.')
replace(lc,
    '   - margin escrow is a settlement bound only; it is excluded from post-fill position equity and maintenance calculations.',
    '   - margin escrow is a settlement bound only; it is excluded from post-fill position equity and maintenance calculations.\n   - fee settlement uses the live-source-then-escrow order of [§4.6.3](#s4_6_3) items 1 and 2; the spot fee cap\'s `e` is removed from the end of that source order under item 3.')
replace(lc,
    'Let `b` be the bonus-paid part item 1 would take (the order\'s reserved bonus segments for `BUY`, the attempt\'s child-bound fee-only segments for `SELL`),',
    'Let `b` be the bonus-paid part item 1 would take (live bonus plus the exact attempt\'s house expiry escrow fee components, using item 1\'s source order),')
replace(lc,
    '`e = b` always fits, because the GST of a zero fee is `0` and `L` is never negative.',
    '`e = b` always fits, because the GST of a zero fee is `0` and `L` is never negative. Remove `e` from the end of item 1\'s planned bonus/escrow source order: reduce house escrow fee components before live bonus segments, reversing their draw order within each source class.')
replace(lc,
    'settlement then debits exactly the final bonus-paid part and never debits a bonus segment for the forgone amount, which item 1\'s release returns with the rest of the unused segment.',
    'settlement then debits exactly the final bonus-paid part and never debits a live bonus segment or house escrow for the forgone amount; item 1\'s release returns unused live segments, and unused house escrow is released without a ledger posting.')
replace(tdd,
    'and the converted part is derived without storage; a missing listed row without that attempt escrow fails as an invariant',
    'and the converted part is derived without storage; settlement debits L1 first, then L2\'s escrow from HOUSE:BONUS_BUDGET, before the proceeds remainder, and finishes SETTLED with zero amount and an empty list; a missing listed row without that attempt escrow fails as an invariant')
replace(tdd,
    '- INVAR-001: Ensures that non-negativity',
    '- BONEXP-065: Ensures that mixed live and expiry escrow fee settlement meets "BUY draws live bonus then its reserved quote cash before exact-attempt escrow, SELL draws live child-bound segments by child_seq then generation/index before exact-attempt escrow, perps draws order fee cash then live bonus before exact-attempt escrow and only then AVAILABLE or the position backstop, escrow fee rows draw in ascending bonus_lot_id, and spot fee-cap e cuts escrow in reverse lot order before live bonus in reverse draw order, with no debit for the forgone amount and no margin escrow counted as equity" constraints per [Lifecycle §4.6.3](Lifecycle.md#s4_6_3)\n- INVAR-001: Ensures that non-negativity')
changelog('Lifecycle.md', 'Settle fees from existing live sources before exact-attempt expiry escrow in ascending lot order; trim the spot cap from house escrow before live bonus.')
changelog('TDD.md', 'Add: BONEXP-065; Change: BONEXP-062; Remove: N/A')
replace(lc,
    '5) Conservation for every valid user fill:',
    '   - for fees in items 2 through 4, an expired order source contributes only its exact-attempt escrow fee component after the live allocation or order fee sources and before the profit, `AVAILABLE`, or position-backstop step, in the lot order of [§4.6.3](#s4_6_3). GST and realized-loss source rules and the Cross episode lock restriction are unchanged.\n5) Conservation for every valid user fill:')
replace(lc,
    'once its segments are consumed and released, whether bonus paid all, part, or none of its fee',
    'once its live segments and the attempt-level expiry escrow have been consumed or released, whether bonus paid all, part, or none of its fee')
snapshot('C')

replace(lc,
    '   - never fall back to cash `AVAILABLE`, `BONUS_AVAILABLE`, or a reservation owned by another order.',
    '   - expired-source house backing stops at the remaining escrow component; it never selects fresh `BONUS_AVAILABLE` or a reservation owned by another order. A fee remaining after all live sources and escrow follows item 5\'s ordinary fee chain; this is not a blanket prohibition on its permitted cash `AVAILABLE` step.')
replace(lc,
    '5) This item applies only to a bonus source that expired after the attempt was submitted. If the exact user reservation or expiry escrow cannot cover a debit that the already-submitted attempt makes unavoidable:\n   - spot fee shortfall: debit `HOUSE:BONUS_BUDGET` and credit `HOUSE:FEES` for the uncovered fee.\n   - perps opening-quantity fee shortfall: use `HOUSE:LIQUIDATION_INSURANCE` under the forced-settlement deficit rule.\n   - perps reducing-quantity fee, GST, or realized loss: the position backstop of [§2.7.6](#s2_7_6) applies first (an expired bonus allocation is not a source), and only the bankrupt-position remainder uses `HOUSE:LIQUIDATION_INSURANCE`.',
    '5) For a bonus source that expired after submission, no expiry-attributable fee deficit exists beyond its escrow. Any fee above the live sources plus exact-attempt escrow is ordinary excess under [§4.6.3](#s4_6_3), with its existing spot cap and perps shortfall rules:\n   - spot SELL nets the remaining fee from quote proceeds; spot BUY keeps its reserved-cash and fee-cap rules. No extra `HOUSE:BONUS_BUDGET -> HOUSE:FEES` posting backs a fee above escrow. For example, an expired source originally reserved `10 USDT`, its capped fee escrow is `8 USDT`, and a SELL\'s actual fee is `9 USDT`: absent another live fee source, house escrow pays `8 USDT` and proceeds pay `1 USDT`. For a SELL, or any child whose price bound is a floor, the excess is fee bps times price improvement, paid from the extra proceeds that improvement produced.\n   - perps opening quantity uses the same wallet\'s cash `AVAILABLE` after live fee reservations and escrow, then books only the remaining ordinary fee shortfall to `HOUSE:LIQUIDATION_INSURANCE`.\n   - perps reducing quantity follows [§2.7.6](#s2_7_6): ISOLATED uses its position backstop, CROSS uses the same fill\'s positive realized PnL then wallet cash `AVAILABLE` subject to the existing Cross episode lock rule, and only the remaining shortfall uses `HOUSE:LIQUIDATION_INSURANCE`. GST and realized loss retain their existing rules; an expired bonus allocation is not a source.')
replace(lc,
    '   - do not manufacture a user cash debit.\n\nSpot attempt-final path:',
    '   - the opening-margin shortfall never manufactures a user cash debit; ordinary fee excess uses only the cash sources its fee chain permits.\n\nSpot attempt-final path:')
replace(lc,
    '   - when an order-reserved source lot expired after venue submission, settlement uses only the exact expiry escrow path above. Expiry escrow may settle unavoidable fees or losses but can never create isolated position collateral.',
    '   - when an order-reserved source lot expired after venue submission, its house backing uses only the exact expiry escrow path above. A fee above live sources plus that escrow follows the ordinary chain in item 2 and [§2.7.6](#s2_7_6), with no additional expiry fee deficit. Expiry escrow may settle unavoidable fees or losses but can never create isolated position collateral.')
replace(tdd,
    '- INVAR-001: Ensures that non-negativity',
    '- BONEXP-064: Ensures that fee above live sources plus expiry escrow meets "with an original expired fee reservation of 10, capped escrow of 8, actual SELL fee of 9, no live bonus and no spot cap reduction, HOUSE:BONUS_BUDGET pays 8 and proceeds pay 1, with no additional expiry fee deficit; equivalent perps opening excess uses AVAILABLE then ordinary insurance shortfall, reducing excess follows the existing ISOLATED or CROSS backstop, and the ISOLATED opening-margin shortfall remains unfunded and excluded from equity" constraints per [Lifecycle §4.6](Lifecycle.md#s4_6) and [§4.6.3](Lifecycle.md#s4_6_3)\n- INVAR-001: Ensures that non-negativity')
changelog('Lifecycle.md', 'Cap expired-source house fee backing at escrow; ordinary excess uses proceeds or the existing perps fee chain, preserving ISOLATED opening-margin shortfalls.')
changelog('TDD.md', 'Add: BONEXP-064; Change: N/A; Remove: N/A')
replace(tdd,
    'debit `HOUSE:BONUS_BUDGET` by at most the exact escrow amount, exclude escrow from position equity, and never debit unreserved user cash',
    'debit `HOUSE:BONUS_BUDGET` by at most the exact escrow amount, exclude escrow from position equity, and use no user cash to replace the expired source; ordinary fee excess follows its existing cash/proceeds chain')
replace(tdd,
    '- BONEXP-014: Ensures that unavoidable settlement above exact escrow meets deficit-ownership constraints: spot fee deficit to `HOUSE:BONUS_BUDGET`; perps opening-quantity fee deficit to `HOUSE:LIQUIDATION_INSURANCE`; perps reducing-quantity fee, GST, or realized loss paid first from the closing position under Lifecycle §2.7.6 with only a bankrupt-position remainder to `HOUSE:LIQUIDATION_INSURANCE`; ISOLATED opening-margin shortage recorded as non-collateral position shortfall without unreserved user cash',
    '- BONEXP-014: Ensures that unavoidable settlement above live fee sources plus exact escrow meets ordinary-excess constraints: spot SELL fee from proceeds with the existing spot fee cap and no extra house fee deficit; perps opening fee from wallet AVAILABLE then ordinary insurance shortfall; perps reducing fee through the existing ISOLATED or CROSS chain of [Lifecycle §2.7.6](Lifecycle.md#s2_7_6), including its Cross episode lock rule; GST and realized loss keep their existing sources, and ISOLATED opening-margin shortage remains non-collateral position shortfall without unreserved user cash')
replace('shared/Ledger.md',
    '  - any fee or realized-loss amount beyond the bound escrow follows the deficit ownership of [§2.2.3](#s2_2_3) item 1 and 2: a spot fee deficit is booked to `HOUSE:BONUS_BUDGET`; a perps opening-quantity fee deficit is booked to `HOUSE:LIQUIDATION_INSURANCE`; a perps reducing-quantity fee, GST, or realized loss is paid first by the closing position ([Trading Core §2.7.6](../binaries/trading-core/Lifecycle.md#s2_7_6)), and only the remainder of a bankrupt position is booked to `HOUSE:LIQUIDATION_INSURANCE`; opening-margin shortage follows the durable position shortfall path instead.',
    '  - expired-source house fee backing stops at the bound escrow. Fees consume live sources first, then exact-attempt escrow fee components in ascending bonus_lot_id, then follow the ordinary excess chain of [Trading Core §4.6.3](../binaries/trading-core/Lifecycle.md#s4_6_3): spot SELL uses proceeds, perps opening uses wallet AVAILABLE then ordinary insurance shortfall, and reducing quantity keeps the existing ISOLATED or CROSS backstop of [Trading Core §2.7.6](../binaries/trading-core/Lifecycle.md#s2_7_6), including the Cross episode lock rule. No additional expiry-attributable fee deficit is booked. GST and realized loss retain their existing rules, and opening-margin shortage follows the durable position shortfall path instead.')
subprocess.run(['ruby', 'tmp/scripts/changelog_add.rb', '--file', 'shared/Ledger.md', '--change', 'Cap expired-source house fee backing at escrow and use the ordinary fee-excess chain, preserving opening-margin shortfall and other debit rules.'], check=True, env={**os.environ, 'LC_ALL':'en_US.UTF-8'})
p = Path('tmp/changelog/pending.yml')
p.write_text(p.read_text().replace('Add: BONEXP-064; Change: N/A; Remove: N/A', 'Add: BONEXP-064; Change: BONEXP-013, BONEXP-014; Remove: N/A'))
p = Path(tdd)
lines = p.read_text().splitlines(True)
rows = sorted([line for line in lines if line.startswith(('- BONEXP-064:', '- BONEXP-065:'))])
lines = [line for line in lines if not line.startswith(('- BONEXP-064:', '- BONEXP-065:'))]
index = next(i for i, line in enumerate(lines) if line.startswith('- BONEXP-063:')) + 1
lines[index:index] = rows
p.write_text(''.join(lines))
replace('binaries/trading-core/Contracts.md',
    'may use only exact house-backed settlement escrow tied to that attempt.',
    'uses only exact attempt-bound house escrow for the expired source backing. Fee settlement draws live sources first, then that attempt\'s escrow, then the ordinary excess sources of [Lifecycle §4.6.3](Lifecycle.md#s4_6_3).')
changelog('Contracts.md', 'Limit expiry escrow exclusivity to the expired source backing; retain live fee sources and the ordinary excess chain.')
snapshot('D')
