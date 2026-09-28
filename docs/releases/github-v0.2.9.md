## Eggent v0.2.9 - Audio Playback and Unicode File Names

A recording the agent makes can now be played where it is named: in the answer, and on the file's own screen. Underneath that, three things had been failing silently. A file whose name used any script beyond Latin-1 could not be downloaded at all; the route answered `404 File not found`. Audio was served in a form no browser plays. And every file link in an answer was drawn again from scratch whenever the window regained focus. Nothing needs migrating.

### Highlights

- **Audio plays in the chat.** A relative path to an audio file in inline code, or a markdown link or embed pointing at one, renders as a small player: play and pause, the length and then the time played, and the path linking to the file's own screen. One recording plays at a time, so takes can be compared. Supported types: `.mp3`, `.wav`, `.ogg`, `.oga`, `.opus`, `.m4a`, `.aac` and `.flac`.
- **The file screen plays audio.** Opening an audio file from the Files panel used to say "Binary files cannot be previewed as text". It now shows the browser's own player, with seeking, volume and speed, next to the download button.
- **Files with non-Latin names download again.** The name went into `Content-Disposition` as written, the `Response` constructor threw on it, and every such file - audio or not, from the file tree, the Files page or a chat link - answered `404`. The name is now sent as `filename*=UTF-8''...` with an ASCII fallback.
- **Downloads support `Range`.** `GET /api/files/download` answers with `206 Partial Content` and streams from disk. Without ranges Safari plays nothing and no browser can seek.
- **Answers are no longer drawn again on every render.** The chat's markdown renderers were rebuilt on every render and react-markdown used them as component types, so a window regaining focus unmounted and remounted every file link in an answer.
- **Skills and Telegram.** A bundled skill can declare `launch_scope: orchestrator` in its frontmatter to launch its quick-start card in the orchestrator. The Telegram tool's `status` names the connected bot, or quotes Telegram's answer when the stored token is rejected.

### Platform Coverage

- Web UI: an audio player in answers, and audio playback on the file screen.
- API: `GET /api/files/download` supports `Range`, streams from disk, serves audio types inline and encodes non-ASCII names; `GET /api/files/content` returns a playable preview URL for audio files.
- Runtime: the `launch_scope` frontmatter key for bundled skills; the Telegram tool's status.

### Upgrade Notes

- Compatibility: download responses now carry `Accept-Ranges: bytes`, `Content-Length` and a `filename*` parameter. A client that sends no `Range` header gets the whole file, as before.
- Migration: none.
- Operational changes: none.

### Links

- Full notes: `docs/releases/0.2.9-audio-playback-and-unicode-file-names.md`
- README: `README.md`
