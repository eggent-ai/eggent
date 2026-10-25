## Eggent v0.7.0 - File History and Pages

Every change to a text file or a document in a project is now kept as a version you can compare and restore, and each version says who made it. A web page in a project opens as it looks: pick its blocks for the agent, change its words in place, save it as PDF. Code opens in a real editor. A turn no longer ends as an empty answer.

### Highlights

- **File history.** Text files and office documents keep their versions from their first change: who wrote each one (you, the agent and the chat it worked in, an upload, a restore, a change made outside Eggent), a comparison by words or by lines with any other version or with the file as it is now, restore and download. **History** sits in the file panel and on a file's page, and the agent reads it with `eggent-history`. It counts against the disk under a ceiling (`EGGENT_VERSIONS_MAX_TOTAL_MB`, 1024 MB); pictures, audio, archives, PDF and credential files get none. Settings → General shows its size, switches it off and clears it.
- **Pages.** An HTML file opens as it looks, in a sandboxed frame. Pick blocks on it to tell the agent which part you mean, change its words on the page (only those characters change in the source, as a version of your own), or save it as PDF. Markdown and text print too.
- **A code editor.** Code opens in an editor with highlighting for the common languages, in the file view and in the side panel.
- **The open file goes to the agent.** The file open beside the chat, the lines you selected in it and whether it has unsaved edits are told to the agent with your message; the composer says what it sees, with a cross to take it away.
- **No empty answers.** A stopped turn says so; a refusal by the model service after some work ends the answer with the service's own words; a turn whose last step wrote no text is asked once more, unseen, and says so if it still writes nothing.
- **Smaller changes.** Adding a provider records which of its models accept pictures, from the provider's own list; a question card shows on a chat whose session was restored at start for its schedules; the composer waits for a file that is still uploading; the line under a working turn counts the time since anything last appeared and says when the model is still thinking; a Telegram bot connects by webhook where `TELEGRAM_MODE` says so, and a webhook is answered at once while its turn runs behind it in a queue per chat, so a stop or `/reset` reaches the turn; voice can be transcribed by a provider of your own with an OpenAI-compatible endpoint; Settings → Models carries a short card about the hosted Eggent, which `EGGENT_CLOUD_PROMO=0` removes.

### Platform Coverage

- Web UI: file history (list, comparison, restore), page view (pick, edit words, print), code editor, the open-file note in the composer, the working line.
- Runtime: version capture on every write by the person, the agent, uploads and commands; `eggent-history`; the open-file note; the empty-answer rules; the Telegram webhook queue.
- Optional, off unless configured, each needing a service this repository does not include: the agent's browser (`EGGENT_BROWSER_API_URL`) with the Browser panel, where you take control with an address bar, Back, Forward and Reload; approvals of file versions and files shared inside a company (`EGGENT_APPROVALS_API_URL`, `EGGENT_SHARES_API_URL`); a project run on a coding program of the same computer (`EGGENT_ENGINES_MODULE`). Without these variables nothing about them is loaded.

### Upgrade Notes

- Migration: none. File history keeps its versions in `data/versions/`, outside every project folder.
- New, optional: `EGGENT_VERSIONS` (`off`), `EGGENT_VERSIONS_KEEP_DAYS` (30), `EGGENT_VERSIONS_DAILY_DAYS` (90), `EGGENT_VERSIONS_MAX_PER_FILE` (200), `EGGENT_VERSIONS_MAX_FILE_MB` (10), `EGGENT_VERSIONS_SCAN_SECONDS` (120), `EGGENT_VERSIONS_MAX_TOTAL_MB` (1024), `EGGENT_VERSIONS_DISK_SHARE` (0.25), `EGGENT_CLOUD_PROMO`.
- Known limits: the agent's shell can delete `data/versions`; a deleted file's history has no screen yet (the agent restores it with `eggent-history`).

### Links

- Full notes: `docs/releases/0.7.0-file-history-and-pages.md`
- README: `README.md`
