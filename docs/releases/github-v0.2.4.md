## Eggent v0.2.4 - Resumable Turns and Chat Addresses

Two things a conversation could not do: outlive the tab it was started in, and be linked to. Both are the same complaint from the user's side - the work was there a moment ago and now the screen has nothing on it.

### Highlights

- **A turn you can walk away from.** A run used to exist only inside the HTTP response that started it, so switching chats or closing the tab left its output going into a connection nobody was reading. The run writes into a buffer now; whoever attaches next is handed everything so far, in order, and then follows along live. `GET /api/chat/<chatId>/stream`, `204` when nothing is running.
- **The chat list marks what is working** - a slow pulse, calmed rather than stopped under `prefers-reduced-motion`.
- **A turn started from Telegram can be watched from the browser** as it happens.
- **Stopping is something you ask for.** Dropping the request used to be how a turn was stopped, which made "stop" and "I am closing this tab" the same gesture. `POST /api/chat/<chatId>/stop` winds the run down and answers only once the half-written turn is stored.
- **Every conversation has an address.** `/dashboard/<chatId>` - linkable, bookmarkable, reloadable, openable in a second tab, reachable with Back. The chat screen is a shared layout, so the address can appear mid-answer without interrupting it.
- **Reopening a working conversation shows it, every time.** Three separate causes, worst of them a turn waiting on a question: the question lives in the stream and is never stored, so it stayed invisible for as long as it waited and could not be answered.
- **The chat avatar lines up** with whatever the message opens with.

### Platform Coverage

- Dashboard: conversation addresses, live re-attachment, the working mark in the chat list.
- Runtime: a turn is owned by the conversation rather than by the request that started it.
- API: `GET /api/chat/<chatId>/stream`, `POST /api/chat/<chatId>/stop`, `GET /api/chat/active-runs`.

### Upgrade Notes

- Compatibility: no data migration is required.
- Migration: none.
- Operational changes: a turn now survives the browser tab closing. It ends when it finishes, when the stop button is pressed, or when a stop word is sent. Docker still binds `127.0.0.1` by default.

### Links

- Full notes: `docs/releases/0.2.4-resumable-turns-and-chat-addresses.md`
- README: `README.md`
