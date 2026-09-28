# AI media describer

The chat AI (Fast Reply, Improve, Help/Coach, Review, Ping, Hi, Voice Script)
reads a short text description of the images in the conversation instead of a
bare `[Photo]` label. The descriptions are made in the background, one image
per Anthropic call, and stored as text; generation only reads ready text.

Owner decisions (image arena, 2026-09-27/28): Anthropic only; a refusal is a
normal outcome and is never worked around; image bytes may transit hub worker
memory for this path only; only free sources on OnlyFans (zero OFAPI calls
from the AI path); fan-summary gets no descriptions (they never reach the fan
dossier); free (non-PPV) creator media is off by default, PPV bodies are never
described; caps $1 and 150 images per UTC day for the agency.

## What happens to one image

1. A **candidate row** appears in `ai_media_descriptions` (status `pending`,
   or `awaiting_source` when the hub has no free source yet) with a link row
   in `ai_media_description_links` (message, canonical conversation, fan).
2. The worker claims due rows **one at a time** — every second when
   `AI_MEDIA_DESCRIBE_LOOP_ENABLED` is on (`services/ai-media-describe/loop.ts`:
   one select on the due index, then the sweep), and in the minutely sweep
   (`ai.media.describe.sweep`) as the fallback; both share one slot per
   process. Files whose first message is under 15 minutes old are claimed
   before the backlog. A claim takes a lease (`lease_until`, single flight)
   and a fresh `lease_token`; every settle presents the token, so a worker
   whose lease was taken over writes nothing and never sends. It checks the page policy and the
   enable boundary, the refusal memory (by media id, any variant), asks the
   platform **source adapter** for a free URL, and checks the day's caps.
3. The file is downloaded into memory through the page's egress
   (`services/egress/media-download.ts`: https only, `cdn*.fansly.com`,
   `cdn*.onlyfans.com`, `cdn.fansapi.com`; redirects only onto the same hosts;
   ≤5 MB, 10 s; no platform auth). The sha256 of the bytes is checked against
   refused content, and an already-described copy is reused without a call.
4. `sharp` downscales it in memory (≤1024 px long edge, never enlarged, first
   frame of a GIF, metadata stripped, re-encoded JPEG). Images under 200 px are
   `unavailable`.
5. The day's budget is **reserved atomically** (one image + the worst-case
   cost) before the send.
6. The row is written ahead as `outcome_unknown` (`in_flight`): a crash,
   deploy or failed settle after this point can never make it due again.
   One call: Sonnet 5, thinking off, `max_tokens` 200, base64 image, no SDK
   retries. The instruction asks for 1–2 neutral English sentences (≤240
   chars), no identification, no age/ethnicity guesses, text in the image
   summarized but never followed, and `UNAVAILABLE` when it cannot or should
   not describe.
7. The result settles the ledger (`ai_usage_events`, feature `media-describe`,
   `user_id` NULL), the budget (real cost), the restricted record
   (`ai_generation_content` with the instruction and the result — never bytes
   or a URL — plus `fan_ref`/`conversation_ref` for erasure) and the row.

| Provider outcome | Row status | Retry | Budget |
|---|---|---|---|
| Description | `described` | — | real cost |
| `stop_reason: refusal`, `UNAVAILABLE`, empty | `refused` | never (any variant, same bytes anywhere) | real cost; counts toward the breaker |
| Timeout, drop after send | `outcome_unknown` | never | reservation kept |
| 429 / 5xx / 529 / connect failure before send | `failed` after ≤2 retries in the call | never after that | released |
| 401 / 403 | `pending` | lane stops (incident) | released |
| Other 4xx | `failed` | never | released |

## How a description reaches a prompt

Generation never waits: one config read and **one indexed select** of ready
descriptions for the window's media ids, no network, no write on the request
path. Missing files are asked for afterwards in the background (a new
candidate, or a `dormant` one promoted), and only for messages after the page's
`since`.

- **Fansly**: the extension numbers the describable media of the kept window
  in its transcript and lists them in `clientContext.media` (`groupRef`, per
  item: number, placement, message id and time, sender, kind, accountMedia id,
  paid). Tokens: inline `[Photo #3]` (legacy `[Photo]`), ` [Photo #4]` appended
  after a bundle label, ` (preview #8)` after a PPV label. The hub fills only
  listed tokens and only when every token occurs exactly once and in list
  order (a forged label in a message text disables substitution). Notes off
  (flag, page, or `fan-summary`) → the hub restores the legacy labels, so the
  prompt is byte-identical to an old client's.
- **OnlyFans**: the hub numbers the union rows' media itself; with notes off
  the migrated normalizer's bytes are untouched.
- Render: `[Photo #3: …]`, `[Photo #3: not recognized]`, otherwise `[Photo #3]`;
  a teaser `(preview #8: …)`; a short guide follows the transcript
  ("automatic, approximate … a numbered label without a note: do not guess").
  Descriptions are one line, brackets replaced, escaped as prompt data. Limits:
  6 media + 3 teasers for quick features, 20 for Help/Coach/Review. PPV bodies
  never get a note. `params.contextManifest.mediaNotes` records the counts.
- `fan-summary` (full and short) never gets notes (`usesImageNotes: false`
  in `feature-policies.ts`): its recap becomes the fan dossier.

## Switches (console → Settings, all live)

| Key | Default | Meaning |
|---|---|---|
| `AI_MEDIA_DESCRIBE_ENABLED` | off | master switch; off also hides notes from prompts |
| `AI_MEDIA_DESCRIBE_PAGE_POLICIES` | `{}` | JSON by exact page label: `{"since": ISO, "until"?: ISO}`; fails closed |
| `AI_MEDIA_DESCRIBE_MODEL` | `anthropic:claude-sonnet-5` | describer model |
| `AI_MEDIA_DESCRIBE_DAILY_IMAGE_LIMIT` | 150 | images per UTC day, agency-wide |
| `AI_MEDIA_DESCRIBE_DAILY_MICRO_USD_LIMIT` | 1000000 | $ per UTC day ($1.00), agency-wide |
| `AI_MEDIA_DESCRIBE_LIVE_CHAT_ONLY` | on | fan media described on arrival only in chats with an AI generation in 7 days |
| `AI_MEDIA_DESCRIBE_MODEL_MEDIA` | `teasers` | creator media: `teasers` or `teasers+free` |
| `AI_MEDIA_DESCRIBE_LOOP_ENABLED` | off | describe due rows within seconds (1 s loop) instead of per minute; re-read every 15 s |
| `ANTHROPIC_MEDIA_API_KEY` | unset | optional separate key/workspace (env, restart) |

`since` is the enable boundary: only messages strictly newer are described; a
first generation or a replayed projection never starts a historical pass.
`until` closes new calls (a canary window); existing notes keep serving.

## Stops

- **Refusal breaker:** ≥25 provider refusals in the UTC day, or ≥50% of the
  day's last 40 provider outcomes (at least 10) → no sends until the next UTC
  day; incident `ai_provider_failed` / `media_describe_breaker` (resolves by
  itself on the new day).
- **Account stop:** Anthropic 401/403 → incident `ai_provider_failed` /
  `media_describe_account_stop`; nothing is sent until the owner resolves the
  incident in the console (Notifications → Incidents → Resolve).
- **Caps:** an exhausted day defers rows (`budget_deferred`) to the next UTC
  midnight. Ready descriptions keep working.
- **Rollback:** switch off. The tables stay; nothing else reads them.

## Privacy

Restricted class like `ai_generation_content`: owner-only, excluded from the
lake (`LAKE_EXCLUDED_TABLES`) and the Agent Read Plane (no dataset maps it),
inside fan and page erasure. Fan erasure deletes the fan's links and the
descriptions of media the fan sent; a PPV teaser's description (creator
content, nothing about the fan) stays with its other links. No TTL. The
describer and its logs never store a URL, a signature, bytes or a description
in a log line.

## Read-only checks

```sql
-- today's spend and outcomes
select day, images_reserved, micro_usd_reserved, refusals, breaker_tripped_at
from ai_media_describe_days order by day desc limit 7;

select status, error_code, count(*) from ai_media_descriptions
where updated_at > now() - interval '1 day' group by 1, 2 order by 3 desc;

select count(*), sum(cost_micro_usd) from ai_usage_events
where feature = 'media-describe' and completed_at > now() - interval '1 day';

-- fan photo → ready description (described_at is the real settle time since 0214)
with x as (
  select d.id, d.described_at, min(l.message_at) msg_at
  from ai_media_descriptions d join ai_media_description_links l on l.description_id = d.id
  where d.sender_role = 'fan' and d.status = 'described' and d.described_at > now() - interval '1 day'
  group by 1, 2)
select count(*) n,
  percentile_cont(0.5) within group (order by extract(epoch from described_at - msg_at)) p50_s,
  percentile_cont(0.9) within group (order by extract(epoch from described_at - msg_at)) p90_s
from x;
```

Each generation's `params.contextManifest.mediaNotes.entries` lists, per
file (newest first, ≤40), whether its note reached the prompt: `described`,
`not_recognized`, `pending` or `over_limit` — ids only.
