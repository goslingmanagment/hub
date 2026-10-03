# A local hub for client development

How a client developer (chat-extension, desktop, Fansly extension) runs the hub
on their own machine with believable OnlyFans data, no OFAPI key and no AI
spend. Everything here touches only a local Docker database; the seed refuses
any other.

## 1. Run the hub

Docker and Node 22 with corepack (`pnpm@10.33.1`), as in CI:

```bash
pnpm install
pnpm dev
```

`pnpm dev` creates `.env` from `.env.example` (with a fresh
`APP_ENCRYPTION_KEY`), starts the compose `postgres` service on
`localhost:5432`, applies the migrations, then runs the API, the worker and
the dashboard in one terminal (Ctrl+C stops them; `docker compose down -v`
drops the database).

| What | Where |
|---|---|
| API | `http://localhost:3000/api/v1` — `API_PORT` in `.env`; when 3000 is taken, `pnpm dev` uses the next free port and prints it |
| Health | `GET /api/v1/health` (public; carries `contractHash`) |
| OpenAPI UI | `http://localhost:3000/documentation` |
| Dashboard | `http://localhost:5173` (Vite, proxied to the API) |

Without the worker and the dashboard: `pnpm dev:db && pnpm db:migrate && pnpm api`.

## 2. Seed it

In a second terminal, from the same checkout (it reads the same `.env`):

```bash
pnpm dev:seed-client
```

It prints what it made, once:

| | |
|---|---|
| Users | `dev-owner` / `dev-owner-password` (owner), `dev-chatter` / `dev-chatter-password` (chatter, granted both pages). `DEV_SEED_OWNER_PASSWORD` / `DEV_SEED_CHATTER_PASSWORD` override them |
| Model | `dev-lora` "Dev Lora" |
| Pages | `dev-lora-of` (free, `platformAccountId` 990000001) and `dev-lora-vip-of` ($9.99, 990000002): OnlyFans pages shaped like `lora-of` / `lora-vip-of`, with synthetic ids and no OFAPI binding |
| Personas | the bundled default catalog (`builtin:lora`) |
| Fans | seven synthetic fans (ids 990100001–990100007): a $600+ whale waiting for a reply, a regular answered yesterday, a fan silent for 12 days after a ping, a 5-hour-old subscriber with only the welcome message, an expired one; on VIP the same whale, a fan with two unanswered messages and a 2-hour-old subscriber with no chat |
| Per fan | subscription, settled ledger rows (tips, PPV, renewals), the DM thread and its messages in both the archive and the hot store |
| Recap | a stored full + short `fan-summary` for the whale on `dev-lora-of` |

OnlyFans chat id = fan id, so `conversationRef` for the whale is `990100001`.
Only the whale's chat on `dev-lora-of` (33 messages) clears the 30-message
minimum of Recap (`fan-summary`) and Review (`chat-review`); the shorter chats
show that refusal (400 `gate_min_messages`). The real `lora-of` /
`lora-vip-of` ids never appear in a dev database.

Re-running is safe: the same rows are updated in place and every time is
re-anchored to "now". Passwords are set only when the user is created
(`--reset-passwords` sets the dev values again). After the seed's fixtures
change in a later commit, start from an empty database (`docker compose down
-v`, then `pnpm dev` and the seed): rows the new fixtures no longer name are not
removed.

## 3. Smoke it

```bash
HUB=http://localhost:3000
TOKEN=$(curl -s -X POST $HUB/api/v1/auth/device-tokens/password \
  -H 'content-type: application/json' -H 'x-client-version: chat-extension/0.0.0-dev' \
  -d '{"username":"dev-chatter","password":"dev-chatter-password","label":"dev","mode":"active"}' \
  | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')
curl -s $HUB/api/v1/auth/me -H "authorization: Bearer $TOKEN"
curl -s $HUB/api/v1/ai/persona-catalog -H "authorization: Bearer $TOKEN"
curl -s "$HUB/api/v2/spenders?scope=page&pageLabel=dev-lora-of&period=lifetime" -H "authorization: Bearer $TOKEN"
```

The owner signs in to the dashboard as `dev-owner`.

## 4. AI without a provider bill

By default `CHATMUSE_AI_GATEWAY_ENABLED=false`, and every AI route answers
503 "ChatMuse AI gateway is disabled". To exercise the real gateway, prompts and
SSE frames against a fake provider:

```bash
pnpm dev:fake-ai     # 127.0.0.1:8787; --port, --capture-dir, --reply to change
```

and add to `.env`, then restart the API:

```
CHATMUSE_AI_GATEWAY_ENABLED=true
ANTHROPIC_API_KEY=dev-fake
ANTHROPIC_BASE_URL=http://127.0.0.1:8787
```

The gateway reaches its provider only through the page's egress proxy; the
seed stores `http://127.0.0.1:8787` as that proxy on both pages
(`--ai-proxy-url <url>` for another, `--no-ai-proxy` removes it). The fake is
both the proxy and the Anthropic Messages API: it writes every request — the
exact system and user blocks the hub assembled — to a JSON file in its capture
directory (printed at start, under the OS temp dir by default) and streams back
a short canned reply with a usage frame. Nothing leaves the machine.

```bash
curl -N -X POST $HUB/api/v1/ai/features/fast-reply -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"clientRequestId":"'$(uuidgen | tr A-Z a-z)'","pageLabel":"dev-lora-of","platform":"onlyfans","conversationRef":"990100001"}'
```

Every feature gets the same canned line (`--reply` changes it); a generated
Recap is stored like a real one and becomes the freshest. A real provider needs
a real key and a real page proxy (set in the dashboard), and spends money.

## What is not there

- No OFAPI: no sync, no webhooks, no sends, no media. The archive coverage
  plane holds no proofs, so coverage reads as unknown/partial.
- With `AI_TRANSCRIPT_FRESH_UNION_MODE=off` (the default) the AI transcript
  shows PPV purchase state as unknown, exactly as the hub does for archive rows.
- Nothing is journaled in `observations`: the rows are written straight into
  the tables the OFAPI pipeline fills. A message-archive rebuild from the
  journal drops the archive rows; re-run the seed.

## Guards

The seed exits with `Refused: …` and writes nothing when:

- `NODE_ENV` is `production`;
- the `DATABASE_URL` host is not `localhost`, `127.0.0.1`, `::1` or the dev
  compose service `postgres`, or a `?host=` / `?hostaddr=` parameter overrides
  it;
- the database already holds a page the seed did not create — what an SSH
  tunnel to a real hub looks like from here. `--allow-existing-pages` seeds next
  to them; use it only on your own scratch database;
- `dev-owner` / `dev-chatter` exist with another role or deactivated, or
  `dev-lora-of` / `dev-lora-vip-of` exist as something other than active
  OnlyFans pages of the `dev-lora` model.

All of these are read on a bare database connection before the seed builds
its app context or writes a row. The seed also ignores the vendor keys in
`.env` (`OFAPI_API_KEY`, `ANTHROPIC_API_KEY`, `ANTHROPIC_MEDIA_API_KEY`,
`OPENROUTER_API_KEY`, `ELEVENLABS_API_KEY`, `TELEGRAM_BOT_TOKEN`): with an OFAPI
key set, building the app context would already run the OFAPI credential
preflight. A run that fails for any other reason prints `Failed: …` and may
have written part of the seed; fix the cause and re-run.

Code: `scripts/dev-seed-client.ts`, `scripts/dev-fake-ai-provider.mjs`. Tests:
`tests/client-dev-seed-guards.test.ts`, `tests/client-dev-seed.integration.test.ts`.
