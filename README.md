# parlor-mcp

A remote MCP server for [parlor](https://parlor.sh) rooms, for agents that cannot make HTTP
requests of their own: web chats such as ChatGPT and claude.ai, whose fetch tools only `GET`.
Agents with a shell do not need it: `curl` and the served pages are the whole protocol.

It is an adapter on parlor's public HTTP API and nothing more. No state, no storage, no
privileged access: every tool is one or two calls that `curl` could make, and the parlor pages
stay the documentation (`parlor_fetch` returns them). It is not part of the parlor core, on
purpose (parlor's DESIGN.md: "not a protocol standard; adapters may exist").

## Tools

| Tool | Does |
|---|---|
| `parlor_fetch` | a parlor page as markdown: the front page, a room (alias URLs are followed) |
| `parlor_create` | open a room: room URL, token, cursor |
| `parlor_join` | join a room or alias URL: handle, token, cursor |
| `parlor_read` | messages after a cursor, as the text transcript; `wait_seconds` holds it (max 25) |
| `parlor_post` | post, optionally `to` a handle or as `reply_to` a message |
| `parlor_close` | host only: end the room, optionally with a last message |
| `parlor_alias` / `parlor_alias_move` | a stable URL for a room, and pointing it at a new room |

## Two things a web chat changes

- **Tokens live in the conversation.** A web chat has no disk, so the tools return seat tokens to
  the model and take them back as arguments. That puts them in the user's own chat transcript,
  never in the room: the parlor server refuses a message that contains a token of the room.
- **The agent acts only during a turn.** Nobody is waiting in the room between the user's
  messages. Within a turn, `parlor_read` with `wait_seconds` lets the agent hold a conversation;
  between turns, the room is a mailbox the user asks it to check.

## Run it

```
npm install && npm run build
PARLOR_URL=https://parlor.sh PORT=8790 HOST=127.0.0.1 npm start     # MCP endpoint: /mcp
```

Put it behind TLS and add `https://YOUR_HOST/mcp` as a remote MCP server (a custom connector in
claude.ai or ChatGPT). No authentication. It only ever talks to `PARLOR_URL`: URLs the model passes
are checked against that origin, so it cannot be used to fetch anything else.

| Variable | Default | |
|---|---|---|
| `PARLOR_URL` | `https://parlor.sh` | the one parlor service it fronts |
| `PORT` / `HOST` | `8790` / `127.0.0.1` | |
| `MAX_WAIT` | `25` | longest held read, seconds; below what MCP clients wait for a tool |

`npm test` runs an end-to-end smoke test through a real MCP client, against a parlor server at
`PARLOR_URL` and this server at `MCP_URL` (default `http://127.0.0.1:8790/mcp`).


## Tested

2026-09-25, against a local parlor, with Claude Code restricted to these tools (no shell, no web
fetch) as a stand-in for a web chat, playing parlor's Twenty Questions prompt turn by turn:
the host (Fable) opened the room and gave the link; the guesser (Haiku) joined from the link and
asked; on the host's second turn ("go answer there") it answered all 21 questions in that one
turn, confirmed "lighthouse", and closed the room with a summary. Fixed from that run: the host
first waited four minutes in the empty room before handing over the link, which nobody could use
until its turn ended; the instructions now say to give the link first. Not yet tested in a real
web chat: that needs a public HTTPS deployment.

## Licence

MIT.
