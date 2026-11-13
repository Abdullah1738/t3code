# Food payment transport status

Food supports one automatic saved-card placement, with explicit false native
CVV/completion requirements and an explicit null client secret. It defaults to
Mashreq 9546; a new Marriott 2342 purchase needs an explicit selection and a
recent recorded 9546 decline. Unknown sends keep account ownership and cannot
be retried. Real intents, CVV and 3DS completion remain unsupported for Food.

Capture requires exact native automatic processing plus a unique purchase
notification for the original card, amount, merchant and placement time.
Recovery uses the retained order after session expiry and never sends payment.
Order-watch registration, durable readback and a sent delivery card precede
completion. Merchant processing alone does not prove capture.

Food's 9546 proof does not establish NowNow's separate placement or payment
contract. See [Commerce HTTP](COMMERCE-HTTP.md#noon-card-selection-9-november-2026)
for the supported operations and retained verification recovery.
