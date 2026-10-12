# Talabat original-app tracking

The explicit `--ui` backend reads the original, logged-in Android app. It is
not an authenticated HTTP API and does not capture or export credentials.

```sh
talabat-search orders --ui --json
talabat-search track ORDER_ID --ui --json
```

It opens the app on the physical phone and uses its native order-list and
order-tracking routes. Calls serialize with the phone plan lock and refuse
to start or continue when a request task's priority hold exists, regardless
of its age. The default deadline is 45 seconds; `--timeout` accepts 1–60.

## Evidence and limits

- Results identify their source as `android_ui`.
- Listing is limited to visible order cards, not full account history. Each
  card's own ID, status and detail control must be present together.
- Tracking checks the exact displayed order ID before reading the status,
  then checks the ID again afterward. A route launch alone proves nothing.
- Delivered status was verified on two real orders in Talabat 13.95.0:
  the `Order delivered` header and the completed early-arrival variant.
- Active-order transitions, ETA and rider fields have not been validated.
  ETA and rider remain null; unknown wording returns unknown.
- App/schema changes, mismatched identity, busy phone, low battery or timeout
  fail closed. UI evidence is subject to the app's own refresh/cache behavior;
  `checked_at` is the observation time, not a server event timestamp.
- No cart, checkout, payment, cancellation or account-change actions exist in
  this backend. It only navigates and scrolls.

Without `--ui`, tracking now uses the separately authenticated HTTP backend;
see `TALABAT-HTTP-TRACKING.md`. HTTP listing is not implemented. Unattended order
watchers remain API/email/notification-based and do not silently take the phone.

The worker is `talabat_ui_orders.py`; parser and phone-lock regression tests
are in `test/test_talabat_ui_orders.py`. UI reads use the Android automation
Python environment, isolated from the native HTTP/Keychain environment.
