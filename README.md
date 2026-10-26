# language-memory-mcp

A small remote, multi-user [MCP](https://modelcontextprotocol.io) server on Cloudflare Workers + D1 that gives an AI language tutor a long-term memory: vocabulary and grammar items, a graph of links between them, practice attempts, lessons (sessions), a server-side spaced-repetition schedule, and a "course state" note. A new chat with no history can read it and know what to repeat and which lesson comes next.

Transport: Streamable HTTP via `createMcpHandler` from the `agents` package (stateless).

Layout: `src/store.ts` (`Store` interface) · `src/d1-store.ts` (D1 backend; syllabus part in `src/d1-syllabus.ts`) · `src/planner.ts` (next topics, progress; pure) · `src/syllabus-import.ts` (plan → SQL) · `src/tools.ts` (tools; depend only on `Store`) · `src/srs.ts` (spaced repetition) · `src/config.ts` (settings) · `src/auth.ts` (token → user) · `src/users.ts` (SQL to add, rotate and revoke users) · `src/index.ts` (auth + handler).
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

Secret: `MCP_SECRET`, the owner's token (see Users and auth).

## Users and auth

Every learner has their own data (items, attempts, spaced-repetition state, lessons, course state, profile, topic progress). Only the syllabus is shared. The server knows who is calling from a personal token, given either as `Authorization: Bearer <token>` on `/mcp`, or as a path segment `/mcp/<token>` (for clients that cannot send headers, such as claude.ai custom connectors). Anything else returns 401.

- **Owner:** the user `owner` signs in with the `MCP_SECRET` worker secret, so the connector you already have keeps working. Data that existed before multi-user support (migration `0005`) belongs to `owner`.
- **Everyone else:** you create a user and send them their URL. Tokens are random 256-bit values, shown once; only the SHA-256 is stored in the `users` table.

```sh
npm run user:add -- anna                 # prints the token and URL, writes user-add.sql
npx wrangler d1 execute DB --remote --file user-add.sql
npm run user:add -- anna --rotate        # new token, the old one stops working (then execute the file again)
npm run user:add -- anna --revoke        # cuts access off, keeps the data
```

User ids are lowercase letters, digits and `-` (up to 32 characters). A new user gets their own copy of the syllabus topic items; importing a plan again does the same for every existing user. Each user sets their own profile (`set_profile`) and starts with empty progress.

A token in a URL can leak through logs and history, so treat it like a password and revoke it if it gets out. OAuth is the planned upgrade if the service should ever let people sign up on their own.

## Connect a client

- **claude.ai / Claude Desktop / mobile:** Settings → Connectors → Add custom connector → `https://<your-worker>/mcp/<your-token>` (the owner's token is `MCP_SECRET`), leave OAuth fields empty. Connectors are tied to your account, so they also appear on other devices; enable it in the chat.
- **Claude Code:** `claude mcp add --transport http language-memory https://<your-worker>/mcp/<your-token>`

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
| `get_syllabus`, `get_topic` | the curriculum with progress; one topic's lesson card (needs an imported syllabus, see below) |
| `next_topics`, `set_topic_status` | what to teach next (chosen by the server); mark a topic `current` / `introduced` |
| `progress`, `record_checkpoint` | coverage and mastery per module and level; result of a module checkpoint |
| `get_profile`, `set_profile` | ui_lang, known_langs, variety, vocabulary packs |

Item ids are deterministic: `<lang>:<type>:<lowercased label>` (e.g. `es:lemma:hablar`). Item types: `lemma`, `form`, `grammar_point`, `collocation`. Edge types: `form_of`, `requires`, `contrasts_with`, `collocates`, `part_of`. Every tool is bounded (limits and caps); none returns the whole database.

## Spaced repetition

Computed on the server by replaying an item's whole attempt history, so back-dated imports stay correct.

- Correct: `streak+1`, interval 1 → 3 → 7 → 14 → 30 days, `due_at = ts + interval`.
- Wrong: `streak=0`, interval 1, `due_at = ts + 1 day`.
- A correct answer on the same day (in `TIMEZONE`) as the previous attempt does not raise the interval.
- `known` = 3 correct in a row on 3 different days; any error returns the item to `learning`. Never attempted = `new`.

## Syllabus (curriculum)

The plan lives in `syllabus/` (YAML, validated by `syllabus/schema.json`), is immutable and versioned: ids are never changed, retired entries get `deprecated: true`. The learner's state is kept apart from it (tables `learner_*`).

```sh
npm run syllabus:validate                       # needs Node 22.18+; checks schema, references, cycles; writes build/<lang>.json and build/seed-*.json
npm run syllabus:import -- --lang es --seed example --user owner --out syllabus-import.sql   # writes SQL only; --user = who the seed belongs to (default owner)
npx wrangler d1 migrations apply DB --remote    # 0004 adds the syllabus tables and the part_of edge type, 0005 the users
npx wrangler d1 execute DB --remote --file syllabus-import.sql
```

Back up production before the last two commands. Importing again changes nothing: every statement is an upsert, `--seed` never overwrites a profile or a topic status that already exists, and existing items keep their data and attempts (only `syllabus_module` and `syllabus_kind` are merged into `data`). `build/` is committed; after editing the YAML rerun `syllabus:validate` (a test fails if `build/` is stale).

How the server decides:

- Syllabus texts are plain English; the model explains them in the learner's `ui_lang` (profile).
- A topic is the item `<lang>:grammar_point:<topic id>` (one copy per user). Items of finer grain are linked to it with `part_of`.
- Status: `planned` (no row) · `seen_via_error` · `current` · `introduced` · `assumed`. The last three count as **covered** and satisfy `requires`.
- `next_topics`: open topics whose prerequisites are all covered. `continue` = those that follow a `current` topic, `fill` = the rest in plan order.
- **Mastered** = covered, has at least one item, every item is SRS-`known`, no wrong answers in the last 14 days. A module is closed at full coverage, 80% mastery and a checkpoint passed after its last topic was introduced. Coverage and mastery are always reported separately.
- `error_type` in `log_attempt` is checked per language: `ERROR_TYPES` + the syllabus's core categories + that language's own (e.g. `por-para` is valid for `es`, not for `de`).

## Local development and tests

```sh
echo 'MCP_SECRET=dev-secret' > .dev.vars        # gitignored
npx wrangler d1 migrations apply DB --local
npx wrangler dev                                 # http://localhost:8787
npm test                                         # SRS, config, store, sessions, migrations, planner, syllabus import, users and isolation
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
