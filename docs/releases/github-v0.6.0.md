## Eggent v0.6.0 - Task Board and Side-by-Side Files

Work can now be handed to the agent as cards on a board: each card runs in a chat of its own, and the board reads how the run ended instead of waiting for the agent to say it is done. A file opens beside the conversation instead of replacing it. A question the agent asks can be answered by voice or with a file, and a question nobody answers for a day no longer holds its turn for ever. Pipelines are replaced by the board.

### Highlights

- **The task board** (**Board** in the sidebar). Five columns: inbox, queue, working, waiting for you, done. Each card is carried out in a chat of its own by the same runner every other turn uses, so it can be watched live, stopped and resumed after a restart. The host moves the card from how the run ended: done (or waiting for your review), a question, a failure (retried once), a stall, a stop. A card can wait for others and starts with what they came to. The agent can propose cards; only you start them. At most 3 run at once and 1 per project, since cards in a project share its folder.
- **A question can be answered by voice or with a file.** The answer field under a question card has a microphone, and the paperclip, drop and paste work there too; the agent is told which files came with the answer. Long options wrap instead of running off the card.
- **A question nobody answers for a day ends its turn.** It used to hold the turn - and the chat - for as long as nobody came back. The stored turn keeps the question and its choices, says why it stopped, and whatever you write later is read as the answer. On a card, the question goes on the card. `EGGENT_TURN_QUESTION_WAIT_SECONDS` changes the day; `0` or `off` lets a question wait for ever.
- **A file opens beside the conversation.** Clicking a file in the tree, a path in an answer or a file in an answer's card opens it in the side panel - text to read and edit, pictures, audio - with a resizable width and a way to the full page.
- **Smaller changes.** A project can be created from the sidebar; your own messages sit in a box with their time and a copy button that stays in view on long ones; a turn's progress after an answered question is kept in the stored chat while it runs; a long brief no longer loses the terminal to the scheduling rules, and the Windows-only `powershell` tool is hidden elsewhere; a scheduled task's helper can send to Telegram and to a colleague; an API token generated in Settings no longer locks out the one set in the environment.

### Platform Coverage

- Web UI: board page and card sheet, question card (voice, files, wrapping options), file preview panel, sidebar project creation, message box.
- Runtime: board dispatcher and run tracking, the `eggent_board` tool, the question wait limit, helper tools for scheduled runs.
- Optional, off unless configured: voice transcription through a model gateway that serves `/v1/audio/transcriptions` (local whisper otherwise), and running a chat on the other side of a paired workspace and computer (`EGGENT_REMOTE_NODE`, `EGGENT_REMOTE_RELAY_URL`, `EGGENT_REMOTE_RELAY_TOKEN`; the relay is not part of this repository). Without these variables nothing about them is loaded.

### Upgrade Notes

- **Breaking: pipelines are removed.** Their pages open the board and their tools are replaced by `eggent_board`. Stored pipeline files (`data/pipelines`, `data/pipeline-runs`) are left on disk untouched and are not converted into cards.
- Migration: none otherwise. The board stores its cards in `data/board/`.
- New, optional: `EGGENT_BOARD=off`, `EGGENT_BOARD_MAX_RUNNING` (3), `EGGENT_BOARD_MAX_PER_PROJECT` (1), `EGGENT_BOARD_RETRY_SECONDS` (60), `EGGENT_TURN_QUESTION_WAIT_SECONDS` (86400).
- Known limits: a card keeps running only while the workspace process does; a question asked in a card's own chat while you watch is answered there as usual.

### Links

- Full notes: `docs/releases/0.6.0-task-board-and-side-by-side-files.md`
- README: `README.md`
