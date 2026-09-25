## Eggent v0.2.8 - Light Chat History

A conversation in which the agent looked at pictures now opens at once. When the agent opened an image with the `read` tool, the chat kept the picture as base64, twice, and the chat page downloaded the whole conversation on every open and every background sync: a 40-message chat weighed 13 MB and showed an empty transcript for seven to eleven seconds, every time. Nothing needs migrating - chats stored before this open light as soon as the new version runs.

### Highlights

- **Stored chats keep no picture bytes.** The `read` tool returns an image as base64 so the model can see it, and the chat store kept that result on the tool message and again on the assistant's timeline. Those bytes are now dropped when a chat is saved and when it is read; the block keeps its type and roughly how large the picture was. Nothing read them back: the chat shows a tool's pictures by their file path, and the model's context lives in the runtime's own session.
- **An unchanged chat is not downloaded again.** The open chat is fetched on every background sync - every 30 seconds and whenever the window regains focus. `GET /api/chat/history?id=` now answers with a weak `ETag` and `Cache-Control: private, no-cache`, so the browser revalidates and an unchanged conversation costs a `304` with no body. Before, a chat with pictures in it pulled about a gigabyte an hour for as long as its tab stayed open.

### Platform Coverage

- Runtime: stored chats drop the picture bytes in tool results, on save and on read.
- API: `GET /api/chat/history?id=` returns an `ETag` and honours `If-None-Match`.

### Upgrade Notes

- Compatibility: a client that ignores the new headers sees the same responses as before, without the picture bytes. Anything that read a picture out of a stored chat's tool results will find `omitted: true` and a `bytes` estimate instead; the file the tool read is where the picture is.
- Migration: none. A chat file on disk keeps its old pictures until its next message, and is served without them either way.
- Operational changes: none.

### Links

- Full notes: `docs/releases/0.2.8-light-chat-history.md`
- README: `README.md`
