# Saved merchant cards

`card-status merchant set "Bupa" 5542 --source "billing page" --seen 2026-11-12 --next-charge 2027-01-03`
records an observation, never changes a merchant account. Only four ASCII digits are accepted. State
lives beside `CARD_STATUS_FILE` (default `~/.local/state/card-status.merchants.json`), using the same
lock and atomic writes as card status.

`--role primary` replaces the previous primary; explicitly add the old card with `--role backup`
if it is still saved. `merchant remove MERCHANT LAST4` removes one saved card, and
`merchant set MERCHANT none` clears all saved cards for that merchant. `merchant list --json`
lists observations; `merchant dead --json` lists merchants with any cancelled or declined saved card.
A decline stays visible here until cleared, even after the checkout's 12-hour decline block expires.

`merchant seed` imports the 12 Nov observations for merchants without a record. It skips existing
merchants so a rerun cannot undo later changes. Run it only after the install is approved; it does not
seed or change card-level cancellation state. Bupa's recorded next charge is 3 Jan 2027.

Immediately before paying, read the last four on the final screen and run
`card-status assert-final MERCHANT LAST4`. Exit 0 means it matches `card_routes.json`; exit 3 refuses
an incorrect, cancelled, recently declined, or other person's card (or unreadable status/routes).
Noon defaults to 9546; 2342 needs `--fallback` after a failure/decline and safe reconciliation.
Uber/Amazon use 2342; boat.dev/ChatGPT use 7572 per card-vault. Other merchants default to 2342.
The flag records an explicit fallback choice; it does not prove the previous attempt failed or authorize a payment.
