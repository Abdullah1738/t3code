// Card #14: the shared bun test setup. Marks the process as a test run so the send guards refuse real
// WhatsApp, email, iMessage and Telegram sends. Child processes spawned by a test inherit this env, so an
// ordinary fixture that forgets its send stub is refused instead of reaching the live app.
process.env.ROBOB_TEST = "1";
