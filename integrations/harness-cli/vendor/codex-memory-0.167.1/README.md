# Codex memory schema

Unmodified memory migrations from OpenAI Codex `rust-v0.167.1`, commit
`0a94398fa60c4fac0e7659e4213a0a36e613dd46`, Apache-2.0:
https://github.com/openai/codex/tree/0a94398fa60c4fac0e7659e4213a0a36e613dd46/codex-rs/state/memory_migrations

OpenAI Codex. Copyright 2025 OpenAI. See LICENSE for the Apache-2.0 terms.

SQLx 0.9.0 records the SHA-384 of each SQL file. The canary verifies these
checksums before initializing its disposable databases and installing audit triggers.
The CLI then validates the same migration records at startup.
