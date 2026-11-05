# Order tracking environment

The tracker uses the mitmproxy uv tool's Python. Install the tool with its
preview dependency recorded in the uv receipt, so upgrades retain it:

```sh
uv tool install mitmproxy --with pillow
```

Installing or changing the live environment and deploying require owner approval.
An explicit `delivery_cards.py --app APP --order ID --recover-send` can recover
a suppressed or expired enrolled card after checking the original notice and
outbox; it does not bypass a payment hold and uses the retained delivery-card key.
Ordinary `--send` still respects suppression and the six-hour expiry.
