## Eggent v0.4.0 - Learning, Projects and Files

The agent can now keep short notes and write skills from what you tell it and what it does. A project can be asked for help by name. A folder, or the files an answer made, comes down in one click. A turn that goes quiet is stopped instead of waiting for ever, a scheduled task that cannot run is paused instead of firing for ever, and credentials you paste are hidden in stored chats. Nothing needs migrating.

### Highlights

- **The agent learns.** After a turn that gives a reason - you asked it to remember, you corrected it, it got past an error, it did a long piece of real work - a short look-back may keep a note in `learned.md` or write a skill. Every write is checked first: no credentials, no instructions that override the assistant, no orders to send something to an address. What was kept is quoted under the answer, **Settings -> Memory** lists it, removes it and switches learning off, and a learned skill unused for 30 days is marked stale and archived at 90. The agent changes only skills it wrote itself.
- **Upload and delete skills.** **Settings -> Skills -> Upload skill** takes a `SKILL.md`, or a `.zip` / `.skill` archive, several at once. Everything is checked before a byte is written, a name that already exists asks before it replaces (the old copy is kept), and every installed skill has a delete button.
- **Ask a project.** `@shop how many orders came back?` has the project `shop` do the work with its own files, skills, MCP servers, instructions and model, in a chat of its own, and the answer comes back in the same turn. It works in the web composer (typing `@` opens the list), in Telegram and through the external API. Only your own `@` starts a visit, and a project cannot start another.
- **A stuck turn is stopped.** A turn can be stopped from its first moment. After 90 s with no sign of life Telegram says so and offers `/reset`; a turn that stays silent is stopped on its own after 3 minutes while starting, 6 with the model silent and 20 inside a tool, and says why. `/reset` stops the turn, drops a question nobody can answer and keeps the conversation. A run with nobody to ask (the external API, a schedule) no longer waits for an answer.
- **A task that cannot run is paused.** After repeated failures - five in a row, three when the model endpoint reports a refused request - a scheduled task is paused and you are told once. The Schedules page shows why and has Pause and Play. A scheduled run can no longer create, change or delete tasks itself.
- **Files.** Every folder in the file tree downloads as one streamed `.zip`; files that hold credentials and credential folders are left out and counted. The files an answer made are listed under it with Open, Download and Send to Telegram, and in Telegram `/files` sends them.
- **Credentials in chats.** A message that looks like a key, token, password or private key shows a notice before it is sent (**Send anyway** / **Edit**). Stored chats hide such values (`[hidden key]`, `[hidden token]`), also when an older chat is read, and older chats are cleaned once at start. The agent's own working memory is untouched, so a key you gave it for a task keeps working.
- **Hardening.** A shared (public-mode) chat is no longer handed the workspace's tools; an archive and the files under an answer hold up against a folder that changes while they are read; the scheduler's state is one per process; a stop can no longer be lost while a turn is starting; and the credential patterns cost time in proportion to the text they read.

### Platform Coverage

- Web UI: `@` project menu and card, learned-note quotes and Settings -> Memory, Upload skill and delete, file cards and folder download, credential notice, Pause and Play on the Schedules page.
- API: `/api/files/zip`, `/api/files/stat`, `/api/files/telegram`, `/api/learning`, `POST /api/projects/:id/skills/upload`, `DELETE /api/projects/:id/skills`, `pause` and `resume` on `/api/pi-schedules`; the external message route gains `controlOnly` and answers `stopped`.
- Telegram: `/reset`, `/files`, `@project`, and a hint under an answer that made files.
- Runtime: learning look-backs, turn watchdog, project visits, schedule health, credential masking in the chat store.

### Upgrade Notes

- Compatibility: nothing is removed or renamed. `yaml` 2.9.0 is now a direct dependency (the version the SDK already pins).
- Migration: none. The first start after the update scans stored chats once; `learned.md` appears when the agent first keeps something.
- Operational changes, all optional: `EGGENT_LEARNING=off`, `EGGENT_LEARNING_MODEL`; `EGGENT_TURN_WATCHDOG=off` and `EGGENT_TURN_SILENCE_{SOFT,START,MODEL,TOOL}_SECONDS`; `EGGENT_VISITS_MAX`, `EGGENT_VISIT_TIMEOUT_MINUTES`; `EGGENT_ZIP_MAX_MB`, `EGGENT_ZIP_MAX_FILES`, `EGGENT_ZIP_IDLE_SECONDS`; `EGGENT_SCHEDULE_PAUSE_AFTER_REFUSED`, `EGGENT_SCHEDULE_PAUSE_AFTER_FAILED`.
- Known limits: a bot connected by long polling (a server without a public HTTPS address) reads Telegram messages one after another, so `/reset` or "stop" sent during a long turn is read when the turn ends - with a webhook it is read at once, and the watchdog stops a quiet turn either way. A project is a place to work, not a sandbox: the agent's built-in shell and file tools can reach other paths.

### Links

- Full notes: `docs/releases/0.4.0-learning-projects-and-files.md`
- README: `README.md`
