# Upstream: herdr-chat

`mods/factory-chat` is adapted from [herdr-chat](https://github.com/naruse/herdr-chat) by naruse, MIT licensed (see `LICENSE` here), at commit `05ef3ed` ("Agents list opens the chat; chats recover their loops after a reload").

## What came from where

| Here | Upstream | Changes |
|---|---|---|
| `chat/chat.js` | `mods/chat/main.js` | Reworked as a retained nested view for one ticket. See below. |
| `chat/parse.js` | `mods/chat/parse.js` | Claude Code only: the Codex reader is gone. It keeps the log's `cwd`, which the side chat asks from. |
| `chat/stream.js` | `mods/chat/stream.js` | Claude Code only: Codex's screen rules are gone. |
| `chat/prompt.js` | `mods/chat/prompt.js` | Unchanged. |
| `chat/source.js` | `mods/chat/source.js` | Only `Tail`, the log reader. The factory knows each session's transcript, so the code that finds the log from the terminal's process is gone. A log not written yet reads as empty (your session opens idle). |
| `chat/sdk.js` | `mods/chat/sdk.js` | Only `control`, `sessionOf` and `askSide`, which the side chat uses. |
| `chat/platform.js` | `mods/chat/platform.js` | Only `copyText`, `openFile` and `imageSize`. |
| `icons/` | `mods/chat/icons/` | Only copy, check, edit, search and terminal. |
| `chat/host.js`, `main.js` | (new) | The factory side: a ticket's sessions from `factory sessions <id> --json`, and the mod's own copy of the view. |

`mods/chat-file` (the editor dialog) is not vendored: it served the `/memory`, `/hooks` and `/config` cards, which are dropped.

## `chat.js` against upstream `main.js`

The chat keeps these from upstream:
- the transcript view, with its paging ("Show earlier"), scrolling and "↓ Latest";
- the reply streamed from the screen, and the card for the tool running now;
- folded tool calls;
- questions and permission prompts as buttons, and menus left on screen once idle;
- the composer, with Stop while the agent works;
- queued messages, with Send now and Edit;
- ⌘F search;
- the side chat (⌘;, `/btw`), which asks a read-only fork of the session;
- images, and Copy on replies, messages and code blocks.

These changed:
- **What it opens on.** Its props name a ticket and its sessions (`lib/ticketchat.js`). It doesn't find a terminal and its log. The transcript is the session's `transcript` (or its `claude_session`'s log). Input goes to the ticket's live terminal, and only for the live session.
- **The session switcher.** It is new: the ticket's sessions (stage · n · time), each showing its own transcript.
- **Read-only.** With no agent running, an earlier session, or sample data, the composer is replaced by a note saying why.
- **Tool calls** are drawn as the prototype draws them (`docs/prototypes/chat-v2`). A turn's calls still fold into one line. Each call is a bordered row with its name, argument and result in a few words, and the row opens to its output.
- **Its own `nextCommand` loop, `localStorage`, `props()` and mod-wide state are gone.** It is a nested view inside the Ticket page, and those belong to the page.

These were dropped:
- Codex.
- New chat (⌘N) and its form.
- Move to chat.
- The `/` command menu, its submenus and its cards (`/context`, `/status`, `/usage`, `/memory`…).
- The model, effort and permission-mode menus. The model and mode show as plain pills.
- Terminal pickers opened from the `/` menu.
- Attachments, image paste and drag and drop.
- Emoji and `:emoji` autocomplete.
- `@` file mentions.
- Hiding and showing the terminal (`backstage.js`).
- Running code blocks in a console (Play).
- Remote machines.
