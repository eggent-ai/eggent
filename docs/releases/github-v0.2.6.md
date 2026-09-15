## Eggent v0.2.6 - Model Picker and Files Panel

Two controls that were in the wrong place, and one request shape the provider refuses. The model a workspace answers with could only be changed on a settings page, the file tree competed with the chat list for one column of height, and an agent turn carrying tools could not also carry reasoning.

### Highlights

- **The model is changed from the composer**, left of send, rather than on a page you have to leave the conversation for. It is not a second setting: in a project it writes that project's `model.json`, in the orchestrator the workspace default, and the Models tab shows whatever was chosen there. Grouped, searchable, and it reports what **will** answer rather than what last did.
- **A provider can offer more than one model.** A provider entry in `models.json` can carry a list, and which one answers is resolved in a single place shared by the chat, the settings screen and the project form - three callers, one rule, because a screen reporting one model while another answers is the bug this avoids. Only text models reach the picker; an image or embedding model chosen as the chat model would break every conversation, and four gates refuse it.
- **Tools and reasoning could not travel together.** `/v1/chat/completions` answers *"Function tools with reasoning_effort are not supported"*, and an agent turn always carries tools - so declaring a provider's models as reasoning ones made every message fail. Workspaces speak the Responses dialect now, where the two coexist; `EGGENT_AI_MODEL_API` pins the old one.
- **The file tree is a panel of its own**, opened from the header, instead of a third thing competing for height in the left sidebar. Closed it takes no width at all. On a phone it comes over the chat, because hiding it below `md` took the tree away from phones entirely.
- **The panel keeps its height and marks the open file.** It used to take its height from the page, so on the file view it ended mid-list, and it marked only directories - clicking a file navigated away and left nothing highlighted.
- **Runtime SDK 0.81.1 to 0.85.1**, with two tests that drive a real session against a local stub - one per dialect, no network and no credential.

### Platform Coverage

- Dashboard: the composer model picker, the files panel, the collapsed model select showing a name rather than a clipped sentence.
- Runtime: a provider with several models, one resolution rule, the Responses dialect, SDK 0.85.1.
- API: `PUT /api/projects/<id>/model` accepts a model of the current provider instead of refusing outright while a provider is fixed.

### Upgrade Notes

- Compatibility: no data migration is required. A provider entry with a single model keeps working exactly as before.
- Migration: none. A workspace whose saved model no longer resolves is moved onto the provider's default at boot.
- Operational changes: workspaces speak the Responses dialect by default; `EGGENT_AI_MODEL_API=openai-completions` restores the previous one without a rebuild. Docker still binds `127.0.0.1` by default.

### Links

- Full notes: `docs/releases/0.2.6-model-picker-and-files-panel.md`
- README: `README.md`
