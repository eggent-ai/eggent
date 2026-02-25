Use this tool to add **optional** files to a skill. Only SKILL.md is required; everything else (scripts, references, assets) is optional. When the user asks to add a script, reference document, template, or other file to a skill, use this tool.

**Paths (relative to the skill directory):**
- **scripts/** — executable code (e.g. `scripts/extract.py`, `scripts/run.sh`)
- **references/** — extra docs (e.g. `references/REFERENCE.md`, `references/API.md`)
- **assets/** — templates, data, images (e.g. `assets/template.json`)

Use forward slashes. The skill must already exist (create it with create_skill first if needed). You cannot overwrite SKILL.md with this tool.

Example: after creating a skill "pdf-table-parsing", if the user wants a Python script, call write_skill_file with skill_name="pdf-table-parsing", relative_path="scripts/extract_tables.py", content="...".
