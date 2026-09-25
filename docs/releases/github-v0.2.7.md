## Eggent v0.2.7 - Security Update and Uploads

A security update first: the Next.js version 0.2.6 shipped with has two critical advisories, one of them in an endpoint that every `next start` serves without a login. With it, a Telegram bot that no longer goes silent when the model fails, and a way to put files and folders into a workspace without dragging them, contributed by the community. **Upgrade promptly;** nothing needs migrating.

### Highlights

- **Next.js 15.5.21 to 15.5.26.** Two critical advisories covered 15.5.21: remote code execution through the image optimizer when it processes AVIF files ([GHSA-2xp9-vwfh-vxw4](https://github.com/advisories/GHSA-2xp9-vwfh-vxw4)) - the optimizer answers on every `next start` without a session - and remote code execution on Windows-hosted servers ([GHSA-p293-qw3h-jr36](https://github.com/advisories/GHSA-p293-qw3h-jr36)). `sharp` moves to 0.35.4, and `@xmldom/xmldom`, `fast-uri`, `ip-address`, `nanoid` and `postcss` are raised within their ranges; nothing else in the lockfile moves.
- **PDF parsing without eval.** The PDFs the loader reads come from uploads and fetched pages; with eval allowed this pdfjs version turns a font's drawing commands into a function (CVE-2024-4367). Text extraction needs none of it.
- **No more `pnpm-lock.yaml`.** It had not changed since March, pinned `next` below 15.5.7 and was the source of 176 of 226 open dependency alerts. Install with npm.
- **Telegram answers a turn that failed** ([#26](https://github.com/eggent-ai/eggent/issues/26)). When the model or its provider failed, the handler rethrew: polling ran the whole turn twice more and dropped it, a webhook answered 500 and was delivered again, and the person saw a silent bot. Now the runtime's own sentence is sent once, secrets cut out, and the update counts as handled. A failure to reach Telegram itself is still retried.
- **Upload files and folders without dragging them** ([#23](https://github.com/eggent-ai/eggent/pull/23), by Sergei Nevzorov). Every folder in the Files panel has a file picker and a folder picker, a folder goes up as several requests under the 100 MB limit, and `POST /api/files/upload` takes `conflict=skip|overwrite|rename`. An upload never replaces a symbolic link.
- **A model a provider marks unavailable is shown, locked.** An entry with `available: false` - and optionally a `note` and a `manage` link - is listed in the picker, the settings page and the project form, disabled, with the provider's note, and never reaches `models.json`. On the way, the agent's `use_provider` stopped landing on the provider's default when asked for one of its models while reporting success.

### Platform Coverage

- Dashboard: upload buttons and a folder picker in the Files panel; locked models in the picker, settings and project form.
- Runtime: Telegram replies to a failed turn once; PDF parsing without eval.
- API: `POST /api/files/upload` gains `conflict` and a per-file error `code`.
- Dependencies: Next.js 15.5.26, `sharp` 0.35.4, patched transitive packages, no pnpm lockfile.

### Upgrade Notes

- Compatibility: no data migration is required. An upload that does not send `conflict` behaves as before.
- Migration: none.
- Operational changes: install with npm. Behind nginx or another reverse proxy, raise its request body limit to 100 MB (`client_max_body_size 100m;`), or larger uploads fail with `413` before they reach Eggent. Docker still binds `127.0.0.1` by default.

### Links

- Full notes: `docs/releases/0.2.7-security-update-and-uploads.md`
- README: `README.md`
