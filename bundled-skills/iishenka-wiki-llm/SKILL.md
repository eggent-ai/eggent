---
name: iishenka-wiki-llm
description: 'Bootstrap an LLM-maintained wiki inside an Obsidian vault and wire the vault to use it. Creates a `wiki/` folder (index, scheme, log, raw/, its own CLAUDE.md), asks one questionnaire to scope the wiki to a single topic, patches the root CLAUDE.md registry so the assistant consults the wiki only for complex, on-topic questions, then explains how to use it. Supports multiple wikis on different topics: re-running adds another wiki (new folder + new registry row) without overwriting existing ones. All user-facing questions are in Russian. Use when the user says "set up a wiki", "wiki llm", "knowledge base", "another wiki", "сделай вики", "ещё одну вики", "вики для llm", "база знаний", or runs /iishenka-wiki-llm.'
---

# iishenka Wiki-LLM — Setup + Usage

USE WHEN the user runs `/iishenka-wiki-llm` or asks to set up an LLM-maintained wiki / knowledge base inside their vault.

> [!important] Язык общения
> Всё, что видит пользователь, должно быть **на русском** — опросник, подтверждения, гайд по использованию. Внутренние инструкции этого SKILL.md, имена файлов, frontmatter-ключи, плейсхолдеры `{{...}}` и содержимое шаблонов остаются как есть. Английский текст вопроса без русского варианта — переводи на естественный русский при показе.

This skill, like the other iishenka skills, **sets up a new sub-system, then explains how to use it.** Concept:

- A wiki folder is an LLM-maintained, single-topic knowledge base. The human curates sources; Claude maintains interlinked pages.
- The wiki is a **deep store for hard, on-topic questions**, not general memory. The root `CLAUDE.md` is patched so the assistant opens the wiki **only when the question is complex AND about the wiki's topic**.
- **Multiple wikis are supported.** The vault can hold several wikis on different topics, each in its own folder. The root `CLAUDE.md` keeps a registry table (topic → folder) so the assistant knows which wiki to open for which topic. Re-running this skill adds a wiki; it never overwrites an existing one.

Phases:
- **Phase 0**: Pre-flight — verify it's a vault, detect existing wikis, offer to add another.
- **Phase 1**: Questionnaire — scope the wiki to one topic.
- **Phase 2**: Bootstrap — create the `wiki/` structure and patch the root `CLAUDE.md`.
- **Phase 3**: Usage guide — explain how to feed and query the wiki.

## Reference files

Every `references/<file>.md` lives next to **this SKILL.md**, not in the user's vault. Read paths resolve relative to this SKILL.md; write paths resolve relative to the user's cwd (the vault root). If a `references/...` path won't open directly, discover it once:

```bash
find / -type d -path '*iishenka-wiki-llm/references' 2>/dev/null | head -1
```

- `references/wiki-claude-md.md` — the wiki folder's own `CLAUDE.md` (behavior + workflow).
- `references/wiki-scheme-template.md` — `wiki/scheme.md` (the page data schema).
- `references/wiki-index-template.md` — `wiki/index.md` (table of contents).
- `references/wiki-log-template.md` — `wiki/log.md` (append-only log).
- `references/root-claude-md-snippet.md` — the block + rules for patching the root `CLAUDE.md`.

---

## Phase 0 — Pre-flight

1. **Verify the cwd is a vault.** `claude.md` or `CLAUDE.md` must exist at the cwd root. If not, ask the user to `cd` into their vault and re-run. Do not proceed.
2. **Detect existing wikis.** Scan top-level folders for any `CLAUDE.md` whose frontmatter has `type: wiki-config`. Build a list of existing wikis as `{folder, topic}` pairs (the topic comes from that file's `topic:` frontmatter). The vault can hold several wikis on different topics.

   ```bash
   grep -rl 'type: wiki-config' --include=CLAUDE.md . 2>/dev/null
   ```

3. **If at least one wiki already exists**, ask via **`AskUserQuestion`** (header `Wiki`, на русском, options):
   - `Создать дополнительную wiki` — new topic, new folder, added alongside the existing ones (root `CLAUDE.md` gets a new row, old wikis untouched). **This is the multi-wiki case.**
   - `Обновить существующую` — pick which existing wiki to refresh (topic/scope in its `CLAUDE.md` + its row in root). No new folder.
   - `Пересоздать существующую` — pick which one; rewrite its scaffold files. Don't touch its `raw/` sources or its pages without confirming.
   - `Отмена` — ничего не делать.

   If the user picks "Обновить" / "Пересоздать" and there is more than one wiki, fire a second `AskUserQuestion` listing the existing wikis (one option per `{folder} — {topic}`) so they pick which.

   Never silently overwrite an existing wiki's folder or its row in the root registry.

4. **If no wiki exists**, proceed straight to Phase 1 (first wiki).

---

## Phase 1 — Questionnaire (scope the wiki)

The whole point of the wiki is to be **scoped to one topic** so the root `CLAUDE.md` can route only on-topic complex questions to it. Run this as a **wizard via `AskUserQuestion`** (the same question-master UI the other iishenka skills use), not as plain chat messages.

Fire **one `AskUserQuestion` call with two questions** (на русском):

**Question 1 — header `Тема`** (required):
- Question: `На какую тему эта wiki? По этой теме нейронка будет ходить в хранилище на сложных вопросах. Если ничего не подходит — выбери «Свой вариант» и впиши свою тему.`
- Options (illustrative — most users type their own via «Свой вариант»):
  - `Предметная область` — `Например: машинное обучение, налоговое право, медицина`
  - `Продукт / компания` — `История, решения и контекст одного продукта или компании`
  - `Личное исследование` — `Тема, в которую ты глубоко копаешь`

  The user's chosen option **or** their «Свой вариант» free text becomes `{{WIKI_TOPIC}}` verbatim. If they pick one of the three category-style options without typing a concrete topic, ask one short follow-up to get the actual topic phrase. Don't store the category label as the topic.

**Question 2 — header `Рамки`** (optional):
- Question: `Уточнить, что входит в тему, а что нет? (можно пропустить)`
- Options:
  - `Тема и так понятна` — `Пропустить уточнение рамок`
  - `Впишу рамки` — `Опиши через «Свой вариант», что входит и что не входит`

  If they choose «Впишу рамки» / type via «Свой вариант», save that as `{{WIKI_SCOPE}}`. If they pick `Тема и так понятна`, set `{{WIKI_SCOPE}}` to a one-line restatement of `{{WIKI_TOPIC}}`.

After the call: derive `{{WIKI_TOPIC_TAG}}` = kebab-case slug of `{{WIKI_TOPIC}}` (for page frontmatter tags).

### Folder name

The folder must be unique per wiki so multiple wikis coexist:

- **First / only wiki** (no existing wiki, `wiki/` is free): default `{{WIKI_DIR}}` = `wiki`.
- **Additional wiki** (one or more wikis already exist, or `wiki/` is taken): default `{{WIKI_DIR}}` = `wiki-{topic-slug}` (e.g. topic "налоговое право" → `wiki-nalogovoe-pravo`). Keep it short; trim the slug if long.

Only ask for a custom folder name if the user wants one. Always ensure the chosen `{{WIKI_DIR}}` does not collide with an existing wiki folder.

Set `{{TODAY}}` to today's date (`YYYY-MM-DD`).

---

## Phase 2 — Bootstrap

Work mostly silently; summarize at the end.

### Step 2.1 — Create the structure

```bash
mkdir -p {{WIKI_DIR}}/raw
```

(`{{WIKI_DIR}}` is a new top-level folder, like `Context/` or `Projects/`. This is allowed: the "no files/folders in vault root" rule forbids loose files at root, not new top-level folders.)

### Step 2.2 — Write the wiki files from references

For each: read the reference, **replace every `{{PLACEHOLDER}}`** with the captured value, write to the local path.

| Reference | Write to |
|---|---|
| `references/wiki-claude-md.md` | `./{{WIKI_DIR}}/CLAUDE.md` |
| `references/wiki-scheme-template.md` | `./{{WIKI_DIR}}/scheme.md` |
| `references/wiki-index-template.md` | `./{{WIKI_DIR}}/index.md` |
| `references/wiki-log-template.md` | `./{{WIKI_DIR}}/log.md` |

Placeholders to fill: `{{WIKI_TOPIC}}`, `{{WIKI_SCOPE}}`, `{{WIKI_TOPIC_TAG}}`, `{{WIKI_DIR}}`, `{{TODAY}}`. After writing, scan each file for leftover `{{` and fix before continuing.

Add a `.gitkeep` to `{{WIKI_DIR}}/raw/` so the empty sources folder persists.

### Step 2.3 — Patch the root CLAUDE.md (add to the wiki registry)

Read `references/root-claude-md-snippet.md` and follow it exactly. The root holds **one**
`## Wikis (LLM knowledge bases)` section with a registry **table** — one row per wiki. In short:

1. Read the vault's root `CLAUDE.md`.
2. **No registry section yet** → create it with a single row for this wiki.
3. **Registry section exists** → **add a new row** for `{{WIKI_DIR}}/` + `{{WIKI_TOPIC}}`. If a row for this exact folder already exists, update it in place. **Never overwrite or remove another wiki's row** — additional wikis are added, not substituted.
4. Optional: if the vault has a separate top-level routing table, add/refresh one row there too.
5. **Surgical + idempotent:** exactly one registry section; touch only it (and the optional routing row); preserve everything else. No em dashes; match the vault's heading style.

This is the single sanctioned edit to the root `CLAUDE.md`. Show the user the exact diff (the added/updated row, and the new section if first time) before saving, and confirm.

---

## Phase 3 — Usage guide

After bootstrap, tell the user (на русском, кратко) how to use the wiki:

- **Добавить источник:** положи документ в `{{WIKI_DIR}}/raw/` и скажи «прозинджесть это» (ingest). Claude прочитает, обсудит с тобой ключевое, создаст страницы, свяжет их `[[вики-ссылками]]`, обновит `index.md` и `log.md`.
- **Задать вопрос:** просто спрашивай по теме. На **сложных** вопросах по теме «{{WIKI_TOPIC}}» нейронка сама пойдёт в `{{WIKI_DIR}}` (так прописано в root `CLAUDE.md`). Простые или не по теме вопросы туда не ходят.
- **Зафиксировать ответ:** если получился ценный ответ, скажи «сохрани в вики» — он станет страницей и будет накапливаться.
- **Аудит:** скажи «залинтуй вики» — Claude найдёт противоречия, страницы-сироты, устаревшие факты, расхождения с `scheme.md`.
- **Источники неприкосновенны:** всё в `{{WIKI_DIR}}/raw/` нельзя менять или удалять.

Then suggest a concrete first step: «Закинь первый документ в `{{WIKI_DIR}}/raw/` и скажи, чтобы я его прозинджестил.»

---

## Guidelines

- One topic per wiki. The scoping is what makes the root routing gate work.
- `scheme.md` defines page shape; `wiki/CLAUDE.md` defines behavior. Keep them distinct.
- The root patch must stay surgical and idempotent. Re-running the skill must not duplicate sections.
- Templates are scaffolds: fill every placeholder, leave no `{{...}}` in written files.
- User-facing text in Russian; internal structure and filenames unchanged.
