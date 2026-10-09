## Eggent v0.3.0 - Terminal and Helpers

You can now run commands from the chat and keep a real terminal open beside it. Helpers the agent starts report back inside the turn that started them and show their work as they go. Telegram answers appear as they are written. Deleting one scheduled task no longer deletes the rest. Nothing needs migrating.

### Highlights

- **Run a command from the chat.** A **Run** button appears under a finished shell code block (`bash`, `sh`, `zsh`, or a `console` block where every line is a `$` prompt). A message that starts with `!` runs as a command too, also while a turn is working. Output streams into a card under the message. Nothing reaches the agent unless you press **Show to the agent**.
- **A terminal in a side panel.** One terminal per project, opened from the header, resizable, with light and dark palettes. It survives moving between pages and reconnecting; a dropped connection resumes from where it stopped.
- **Helpers belong to the turn that started them.** Every helper the agent starts now finishes before the turn does, and the parent continues with all results in the same turn. Each helper has a row in the chat with what it is doing now, steps, time, the task and the result, and a reload shows the same cards. At most six run at once per turn.
- **Telegram answers are written into a draft** while they are generated, and until the answer starts the draft says what is happening (searching, reading a page, running a command). A reply goes to the chat it answers, `/chats` lists conversations, and every scheduled run reports into a chat of its own.
- **Schedules.** Deleting one task, from the agent or from the Schedules page, deletes only that task. Stopping a chat keeps its schedules, and a reload re-arms them.
- **Questions.** A turn waiting on a question is stored while it waits and can be stopped; a card with buttons takes a typed answer, and a confirm card's first button now means yes.
- **Faster first start.** The default pi packages are installed once into the image and copied into a new workspace: about 2.4 s instead of about 25 s of installs. Their versions are pinned.
- **One-time sign-in links.** `POST /api/auth/handoff` issues a link that signs in once and expires.
- **Smaller fixes.** The file tree keeps its open folders when a file is opened from the chat; the files panel stays beside the settings tabs; the agent asks before a large install and puts tools where the Files panel can see them.

### Platform Coverage

- Web UI: Run cards, `!` commands, terminal panel, helper rows, files panel and file tree fixes.
- API: `/api/terminal/jobs/**` (create, stream by offset, input, resize, stop), `/api/auth/handoff`; external routes can stream server-sent events.
- Runtime: helper policy extension, scheduled-run chats, Telegram draft streaming and conversation routing, `eggent_manage_chats`.

### Upgrade Notes

- Compatibility: the terminal panel needs `python3` in the container. The image has it; on a bare host without it the panel says so and commands still run from the chat. There is no Windows terminal yet.
- Migration: none.
- Operational changes: terminals close after 30 minutes with no input and no output, or with no reader (`EGGENT_TERMINAL_IDLE_MINUTES`, `EGGENT_TERMINAL_DETACH_MINUTES`); a run stops after 60 minutes (`EGGENT_TERMINAL_RUN_MAX_MINUTES`). Limits: 8 runs and 3 terminals. Every terminal route requires a signed-in session that is not the default login, and a same-site origin.

### Links

- Full notes: `docs/releases/0.3.0-terminal-and-helpers.md`
- README: `README.md`
