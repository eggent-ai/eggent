## Eggent v0.2.2 - Document Toolbelt and Project Routing

The agent can now open the files people actually send it, and it stops being silent about where things went.

### Highlights

- **A document toolbelt ships in the image.** Pillow, pandas, openpyxl, python-docx, python-pptx, pypdf, pdfplumber, beautifulsoup4, lxml, oletools and psycopg2, plus `unzip`, `pdftotext`, `file`, `strings`, `xxd`, `make`, `wget`, `ps` and `host`. No more `ModuleNotFoundError` on the obvious library, and no more installing it by hand only to lose it on the next container recreate.
- **The terminal runtime no longer starts a login shell**, which on Debian assigned `PATH` outright and hid the interpreter the image ships. The `bash` tool and `execute_code` now see the same thing; before, the same import could fail in one and work in the other.
- **A saved provider key that did not become the active model says so.** Saving the key and switching onto it are two steps, and the second could fail without a word - a key that took effect and one that did not looked identical from the outside.
- **A quick-start card starts the work** in a project of its own instead of asking where to put it, and **the new project announces itself** in the workspace context file so the agent can move there on its own when a message belongs to it.

### Platform Coverage

- Dashboard: the settings screen reports whether a saved key became the model that answers; quick-start cards launch straight into their own project.
- Runtime: one `PATH` for every shell the agent uses; document, spreadsheet, PDF and database libraries present.
- API: `POST /api/skills/launch` decides the scope when none is given, and refuses an explicit target that does not exist.

### Upgrade Notes

- Compatibility: no data migration is required.
- Migration: none. Existing projects and installed skills are untouched.
- Operational changes: the image grows by roughly 286 MB, so the first pull is longer; unchanged layers stay cached. Nothing needs configuring for the toolbelt. Docker still binds `127.0.0.1` by default.

### Links

- Full notes: `docs/releases/0.2.2-document-toolbelt-and-project-routing.md`
- README: `README.md`
