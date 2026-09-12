## Eggent v0.2.5 - Light Chats and Model Settings

Two screens that asked too much. A new chat carried the entire workspace into every message before the person had typed anything, and the settings screen that decides which model answers had become a page of JSON.

### Highlights

- **A chat can be opened light.** A new chat saying one word sent **12 797** prompt tokens - 8 775 of tool schemas across 31 tools, 945 of the runtime's coding-assistant preamble, 2 990 of workspace context, and 12 for the question. Two light modes replace all of it: **plain chat** is the question and the history and nothing else, **chat and files** adds `read`, `ls` and switching between projects. Measured the same way: **255** and **712** tokens.
- **The mode belongs to the chat, not the request.** It is chosen when the chat is opened and read back from the stored conversation, so another tab cannot send the next turn with the whole workspace attached, and a light chat answered over a messenger stays light. The switch sits in the muted line under the composer and disappears where there is nothing to say.
- **Settings keeps the model up front** - provider and model, with thinking level, image generation and raw `models.json` under Advanced. Theme, language and the dashboard login moved to a General tab, and every per-project tab carries the same project switcher.
- **A project's model is a form**, not a file: the workspace model, or the project's own from a provider that can serve right now. It states the two runtime rules out loud instead of letting them surprise you.
- **One card can install a set of skills.** A bundled skill may carry a `bundle/` directory whose children are installed as siblings, reconciled on reuse as well as first install.
- **The model a workspace had saved stopped resolving.** The refreshed provider catalog was compared by file mtime, which npm sets to install time, so every freshly built image discarded it - one workspace was choosing from 271 of the 445 models its provider serves, and answered on another provider's model while both screens said none was selected.
- **An upload larger than 10 MB arrived cut in half and said nothing.** The middleware body ceiling is now 100 MB, pinned to `MAX_UPLOAD_BYTES` by a test, and both upload routes refuse by `content-length` before touching a truncated body.
- **An image the agent embedded in a chat drew as a broken box** - relative paths resolved against the page address; they go through the file API now, decoded first.
- **A conversation that is loading no longer looks like an empty one**, a card with options takes a typed answer, a file named in an answer is a link, and the workspace has a favicon.

### Platform Coverage

- Dashboard: light chat modes, the settings tabs, the project model form, openable files, chat images.
- Runtime: a light session replaces the system prompt and narrows the tool list; the model catalog refreshes at boot and every four hours.
- API: `contextMode` on `POST /api/chat`, `savedModel` beside `runtimeModel` on `GET /api/pi/models`, `projectId` on `POST /api/skills/launch`.

### Upgrade Notes

- Compatibility: no data migration is required. Chats written before this release carry no mode and are read as full.
- Migration: none.
- Operational changes: the model catalog reaches the network at boot and every four hours (`EGGENT_MODEL_CATALOG_REFRESH=0` turns it off), and the upload ceiling is 100 MB. Docker still binds `127.0.0.1` by default. The runtime SDK stays pinned at `0.81.1`.

### Links

- Full notes: `docs/releases/0.2.5-light-chats-and-model-settings.md`
- README: `README.md`
