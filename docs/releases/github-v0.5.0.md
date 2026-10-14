## Eggent v0.5.0 - Keyless Search and Scheduled Reports

Web search works without a key and no longer stops at the first engine that refuses. A scheduled task now sends you what it made, not a description of how it went. A public link to a project can read that project and nothing else. And a fresh self-hosted install says how to sign in, keeps the address it was given, and transcribes a `.wav`. Nothing needs migrating.

### Highlights

- **Search without a key, three engines deep.** With no search key configured, the workspace writes an ordered route into `data/pi-agent/web-search.json` at start: Parallel, then DuckDuckGo, then Exa, each tried when the one before refuses. It is written for the installed `pi-web-access` version (nothing below 0.24.0, which cannot read it) and never over a search you configured yourself. `EGGENT_WEB_SEARCH_DEFAULTS=off` turns it off.
- **A scheduled task sends its result.** The turn that reports a run is told that its reply is the result itself - the brief, the list, the draft - complete and unchanged. A run first learns today's date, so "the last 24 hours" and the heading mean today. It gets at least 12 turns: models set up tasks with 3 or 6, and a run stopped at its limit sent half the work. Tasks you already have pick this up the next time they are armed.
- **"Tomorrow at 10" inside a message is not a schedule.** "Tell the team: meeting tomorrow at 10" is said now; only a request to do something later becomes a task.
- **Public links are read-only.** A public link to a project gets `read`, `ls` and search over that project's folder and nothing else: no shell, no writing, no web, nothing outside the folder, no hidden or credential files, not the agent's memory or skills. Its prompt is the project's own instructions.
- **First run of a self-hosted install.** The installer and the README name the first sign-in (`admin` / `admin`, replaced at once); an install on a port other than 3000 gets a matching `APP_BASE_URL`; a `.wav` sent to transcription works (it was converted onto itself); the Telegram settings page shows whether polling is running, and its Start button can no longer start a second poller; the empty chat no longer promises ready-made paths where there are none.
- **Smaller fixes.** An image the agent names by its full path in the projects folder is drawn in the chat; the agent points you to **Settings -> Schedules** instead of a terminal command that does not exist here; `proxy-addr` 2.0.8 (GHSA-jqcg-44mw-7w3h).

### Platform Coverage

- Web UI: Messengers page polling status, empty chat line, images by absolute project path.
- Runtime: keyless search route, scheduled-run report guidance, run directive (date, final answer), turn floor for scheduled runs, public-link tool set.
- Install: `scripts/install-docker.sh` (`APP_BASE_URL`, first sign-in line), README.
- Optional: a client for workspace messages (`EGGENT_MAIL_API_URL`). It needs a messages service this repository does not include; without the variable nothing about it is loaded or shown.

### Upgrade Notes

- Compatibility: nothing is removed or renamed. A public link loses the tools it should not have had.
- Migration: none. Stored scheduled tasks get the new run directive and the turn floor the next time they are armed.
- New, optional: `EGGENT_WEB_SEARCH_DEFAULTS=off`.
- Known limits: the keyless engines are rate-limited per address, so many installs behind one address can still be refused at the same moment; a search key of your own in `web-search.json` avoids that.

### Links

- Full notes: `docs/releases/0.5.0-keyless-search-and-scheduled-reports.md`
- README: `README.md`
