# Food payment transport status

Food paid HTTP transport and NowNow paid checkout on 9546 remain disabled.
The Food coordinator is covered with injected transports; the native reader
refuses unknown unpaid states. This is not a completed paid Food lane.

Static Food APK evidence establishes the place payload
`sessionCode/orderTotal/orderPaymentAmount`, shared intent completion, and
`encryptDataV2` using `cvv_encryption.public_key/public_key_name`. It does not
establish eligible unpaid response states, encrypted-CVV acceptance or the
3DS return contract. Automatic null-intent processing does not expose a
captured-amount receipt. The existing delivered-order bank closure accepts
EmiratesNBD 2342 evidence only, not Mashreq 9546 evidence.

Exact capture validation requires both the token hash and card suffix bound
to the original order. A supported but different card remains unconfirmed;
its delivery card stays held and the journal cannot complete. Historical
recovery uses the retained card rather than the current account default.

NowNow's historical single-send path uses `{sessionCode,total}` and infers
confirmation from placed/preparing tracking. That proof has not been
established for Visa 9546, so it must not be enabled by removing its guard.

No placement or payment was sent during this follow-up. Fresh completion,
CVV and 3DS behavior remains unproven until observed on an authorized real
purchase. Never repeat an ambiguous placement or completion to obtain proof.

Additional enablement work identified by independent review:
- Wire NowNow CVV/device-verification decisions into its paid order coordinator;
  the separate pre-order controller currently does not protect that entrypoint.
- Reconcile automatic Food ACTIVE journals with the bank-close command's
  FENCED-only prerequisite without fabricating unknown-send observations.
- Add exact Mashreq evidence support before enabling automatic 9546 capture
  closure; do not merely widen the accepted card suffixes.

Validation: 261 legacy-card regression tests and 55 focused/default-card tests
pass offbox (overlapping test selections). Linux uses a fail-closed Keychain
stub and a private temporary journal parent; no account credentials are synced.
