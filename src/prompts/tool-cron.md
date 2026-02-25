Use this tool for any delayed or scheduled action.

When the user asks to "remind later", "через N минут/секунд", "по расписанию", or "every day/week", prefer `cron` instead of `code_execution`.

Rules:
- For one-time reminders: use `action="add"` with `schedule.kind="at"` and ISO timestamp.
- For recurring reminders: use `schedule.kind="every"` or `schedule.kind="cron"`.
- Put the actual reminder text/instruction in `payload.message`.
- Do not send raw natural-language text as the job definition; always send structured fields (`schedule` + `payload` or `delaySeconds` + `message`).
- If cron returns a preflight validation error, immediately retry once with normalized args (`action="add"`, explicit `schedule`, explicit `payload.message`) and do not repeat identical invalid arguments.
- After creating a job, report `id`, schedule, and expected next run time.
- For management requests, use:
  - `status` for scheduler state
  - `list` for jobs
  - `update` to enable/disable or edit
  - `run` to trigger immediately
  - `runs` to show execution history
  - `remove` to delete

Do not emulate scheduling with terminal `at`, `cron` shell files, or `time.sleep`.

Examples:
- One-shot in 65 seconds:
  - `action="add"`
  - `delaySeconds=65`
  - `message="Отправь пользователю: 😊"`
- One-shot absolute time:
  - `action="add"`
  - `schedule={ "kind":"at", "at":"2026-02-20T15:23:30Z" }`
  - `payload={ "kind":"agentTurn", "message":"Отправь пользователю: 😊" }`
- Daily at specific time:
  - `action="add"`
  - `schedule={ "kind":"cron", "expr":"47 19 * * *" }`
  - `payload={ "kind":"agentTurn", "message":"Отправь пользователю: прогноз погоды в Москве" }`
