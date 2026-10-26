# language-memory-mcp

A small remote [MCP](https://modelcontextprotocol.io) server on Cloudflare Workers + D1 that gives an AI language tutor a long-term memory: vocabulary and grammar items, a graph of links between them, practice attempts, lessons (sessions), a server-side spaced-repetition schedule, and a "course state" note. A new chat with no history can read it and know what to repeat and which lesson comes next.

Transport: Streamable HTTP via `createMcpHandler` from the `agents` package (stateless).

Layout: `src/store.ts` (`Store` interface) · `src/d1-store.ts` (D1 backend) · `src/tools.ts` (tools; depend only on `Store`) · `src/srs.ts` (spaced repetition) · `src/config.ts` (settings) · `src/index.ts` (auth + handler).
To use another backend, implement `Store` and change the one line in `src/index.ts` that constructs `D1Store`.

## Quick start

Requires Node 20+ and a Cloudflare account.

```sh
npm install
npx wrangler login
npx wrangler d1 create language-memory          # prints database_id
cp wrangler.example.jsonc wrangler.jsonc        # gitignored; paste database_id, adjust vars (see Settings)
npx wrangler d1 migrations apply DB --remote
openssl rand -hex 32 | npx wrangler secret put MCP_SECRET    # save this value, it is part of your connector URL
npx wrangler deploy
```

Deploy prints `https://language-memory-mcp.<your-subdomain>.workers.dev`.

## Settings

Worker vars in `wrangler.jsonc` (`vars`); all optional:

| Var | Default | Meaning |
|---|---|---|
| `LANGS` | `en,es,de,fr,it,pt,nl` | language codes the tools accept; also the first part of item ids |
| `ERROR_TYPES` | `gender,agreement,conjugation,tense,preposition,word-order,vocab,spelling,article,other` | allowed `error_type` values (`other` is always allowed); add categories specific to your language |
| `TIMEZONE` | `UTC` | IANA zone defining "the same day" for the spaced-repetition rules |

Secret: `MCP_SECRET` (see Auth).

## Auth (temporary)

A shared secret, accepted as either `Authorization: Bearer <secret>` on `/mcp`, or as a path segment `/mcp/<secret>` (for clients that cannot send headers, such as claude.ai custom connectors). Anything else returns 401.
This is an MVP stopgap: a secret in a URL can leak through logs and history. OAuth is the planned upgrade.

## Connect a client

- **claude.ai / Claude Desktop / mobile:** Settings → Connectors → Add custom connector → `https://<your-worker>/mcp/<MCP_SECRET>`, leave OAuth fields empty. Connectors are tied to your account, so they also appear on other devices; enable it in the chat.
- **Claude Code:** `claude mcp add --transport http language-memory https://<your-worker>/mcp/<MCP_SECRET>`

## Tools

| Tool | When to call |
|---|---|
| `get_course_state` / `set_course_state` | first thing in a chat / end of a lesson (set replaces the whole object) |
| `list_sessions`, `get_session` | start of a chat: recent lessons; `status: open` = started but never ended |
| `start_session` → `end_session` | around each lesson |
| `due_items` | plan the lesson: what to repeat (errors in the last 3 days first, then oldest due) |
| `find_items`, `weak_items`, `stats` | pick new material, drill weak spots, overview |
| `get_context` | read one item: data, SRS state, neighbors, last N attempts |
| `log_attempt` | after every answer (pass `session_id`; `ts` only when importing history) |
| `upsert_item`, `link` | create/update items and edges (`data` is merged; `replace: true` overwrites) |

Item ids are deterministic: `<lang>:<type>:<lowercased label>` (e.g. `es:lemma:hablar`). Item types: `lemma`, `form`, `grammar_point`, `collocation`. Edge types: `form_of`, `requires`, `contrasts_with`, `collocates`. Every tool is bounded (limits and caps); none returns the whole database.

## Spaced repetition

Computed on the server by replaying an item's whole attempt history, so back-dated imports stay correct.

- Correct: `streak+1`, interval 1 → 3 → 7 → 14 → 30 days, `due_at = ts + interval`.
- Wrong: `streak=0`, interval 1, `due_at = ts + 1 day`.
- A correct answer on the same day (in `TIMEZONE`) as the previous attempt does not raise the interval.
- `known` = 3 correct in a row on 3 different days; any error returns the item to `learning`. Never attempted = `new`.

## Local development and tests

```sh
echo 'MCP_SECRET=dev-secret' > .dev.vars        # gitignored
npx wrangler d1 migrations apply DB --local
npx wrangler dev                                 # http://localhost:8787
npm test                                         # SRS, config, store, sessions, migrations
npm run typecheck
```

Try it with [MCP Inspector](https://github.com/modelcontextprotocol/inspector): `npx @modelcontextprotocol/inspector`, transport "Streamable HTTP", URL `http://localhost:8787/mcp/dev-secret`. Or from the CLI:

```sh
npx @modelcontextprotocol/inspector --cli http://localhost:8787/mcp/dev-secret --transport http --method tools/list
```

## Backups

```sh
npx wrangler d1 export DB --remote --output backups/db-$(date +%F).sql     # backups/ is gitignored
```
