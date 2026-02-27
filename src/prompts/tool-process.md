# Process Tool

Manage background sessions created by `code_execution`.

## Actions

- `list` — list running and finished managed sessions.
- `poll` — check current status/output of one session (optionally wait with `timeout_ms`).
- `log` — read session log output with optional line window (`offset`, `limit`).
- `kill` — terminate a running session.
- `remove` — remove one finished session from history.
- `clear` — clear all finished sessions.

## Usage Rules

1. Use `process` only after `code_execution` returned a managed session id.
2. For `poll`/`log`/`kill`/`remove`, always pass `session_id`.
3. If `poll` returns `retryInMs`, wait roughly that long before the next poll.
4. If status is `completed`/`failed`/`killed`, stop polling and report outcome.
5. Do not call `kill` unless the user explicitly asked to stop/cancel/terminate the running process.
