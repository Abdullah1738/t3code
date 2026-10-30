"""Card #14: the shared pytest setup. Marks the run as a test so the send guards refuse real WhatsApp,
email, iMessage and Telegram sends. Child processes inherit the marker, so an ordinary fixture that forgets its
send stub is refused instead of reaching the live app. Sets it at import, before any test starts."""
import os

os.environ.setdefault("ROBOB_TEST", "1")
