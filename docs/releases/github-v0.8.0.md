## Eggent v0.8.0 - Agent Email and Google

The agent gets an email of its own and works in Google Docs, Sheets, Slides and Drive. You can say something to it while it works. A new password ends every older session, and a hole in the sign-in check is closed.

### Highlights

- **Say something while it works.** The composer sends during a turn: the agent reads it after the current step and goes on. No more Stop to correct it.
- **The agent's email.** `eggent_email` sends, lists and reads letters. On your own server it sends through your mail server (`EGGENT_SMTP_URL`, `EGGENT_EMAIL_FROM`, `EGGENT_EMAIL_OWNER`); a letter to anybody but you waits for your yes.
- **Google.** Where a deployment offers it (`EGGENT_GOOGLE_API_URL`), `eggent_google` makes and edits documents, sheets and presentations and handles Drive files and folders.
- **Calendar files.** `eggent_calendar_file` makes an `.ics` for any calendar, time zones included.
- **A new password ends older sessions**, settings are written under a lock, and the login can be an email.
- **Security:** a path ending in a dotted segment (`/api/projects/x.json`) skipped the sign-in check. Fixed.
- **Quiet scheduled checks.** A run that answers `NO_UPDATE` sends nothing.

### Upgrade Notes

- Migration: none.
- Docker: pull `ghcr.io/eggent-ai/eggent:0.8.0` (or `latest`) and recreate the container. From source: `npm install`, then rebuild.

### Links

- Full notes: `docs/releases/0.8.0-agent-email-and-google.md`
- README: `README.md`
