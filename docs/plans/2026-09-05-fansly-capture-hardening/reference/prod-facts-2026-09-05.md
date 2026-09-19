# Production facts (read-only snapshot, 2026-09-05 22:05 UTC)

Source: psql as the read_only role on the production Postgres (agency_hub_core); docker ps on the VPS.
Notes: read_only sees no config_settings/runs/domain_events; observation counts are a proxy for request volume (one pull observation ≈ one platform call; *:failed rows are failed calls). The has_proxy column below is NOT meaningful — proxies live in egress_endpoints/page_credentials rows keyed by page, not in pages.egress_endpoint_id.

Hub image: agency_hub_core/runtime:production (api, worker, scheduler up 8 h; postgres:16). Extension published on the update feed: chatgoose 1.9.11 (matches local manifest).

```
agency-hub-worker-1	agency_hub_core/runtime:production	Up 8 hours (healthy)
agency-hub-api-1	agency_hub_core/runtime:production	Up 8 hours (healthy)
agency-hub-scheduler-1	agency_hub_core/runtime:production	Up 8 hours (healthy)
agency-hub-postgres-1	postgres:16	Up 39 hours (healthy)
deploy-bot-1	deploy-bot	Up 7 weeks (healthy)
deploy-web-1	deploy-web	Up 7 weeks (healthy)
===
Timing is off.
Output format is aligned.
 id |    label    | platform |  username  |  created   | has_proxy |     last_light_sync_at     
----+-------------+----------+------------+------------+-----------+----------------------------
 10 | ari-1       | fansly   | itsaribae  | 2026-08-18 | f         | 2026-09-05 22:02:12.303+00
  4 | lilly-1     | fansly   | WetLillys  | 2026-04-04 | f         | 2026-09-05 21:26:47.981+00
  5 | lilly-2     | fansly   | WetLili    | 2026-04-04 | f         | 2026-09-05 21:42:41.702+00
  1 | lora-1      | fansly   | LoraVie    | 2026-04-04 | f         | 2026-09-05 21:38:11.981+00
  2 | lora-2      | fansly   | LoraViex   | 2026-04-04 | f         | 2026-09-05 21:54:12.08+00
  3 | lora-3      | fansly   | LoraViexx  | 2026-04-04 | f         | 2026-09-05 21:10:14.391+00
  8 | lora-of     | onlyfans | loravie    | 2026-06-18 | f         | 
  9 | lora-vip-of | onlyfans | loravievip | 2026-06-18 | f         | 
(8 rows)

                                      Table "public.page_sync_states"
        Column        |           Type           | Collation | Nullable |             Default              
----------------------+--------------------------+-----------+----------+----------------------------------
 page_id              | bigint                   |           | not null | 
 stream               | sync_stream              |           | not null | 
 status               | page_sync_status         |           | not null | 'idle'::page_sync_status
 request_seq          | bigint                   |           | not null | 0
 leased_seq           | bigint                   |           |          | 
 applied_seq          | bigint                   |           | not null | 0
 request_source       | sync_request_source      |           |          | 
 request_payload      | jsonb                    |           | not null | '{}'::jsonb
 requested_at         | timestamp with time zone |           |          | 
 enqueued_at          | timestamp with time zone |           |          | 
 started_at           | timestamp with time zone |           |          | 
 progressed_at        | timestamp with time zone |           |          | 
 finished_at          | timestamp with time zone |           |          | 
 succeeded_at         | timestamp with time zone |           |          | 
 failed_at            | timestamp with time zone |           |          | 
 retry_kind           | text                     |           |          | 
 retry_at             | timestamp with time zone |           |          | 
 blocker_kind         | text                     |           |          | 
 blocker_code         | text                     |           |          | 
 blocker_message      | text                     |           |          | 
 blocked_at           | timestamp with time zone |           |          | 
 phase                | text                     |           |          | 
 work_class           | sync_work_class          |           |          | 
 progress             | jsonb                    |           | not null | '{}'::jsonb
 cadence_seconds      | integer                  |           | not null | 
 slot_offset_seconds  | integer                  |           | not null | 
 last_scheduled_slot  | bigint                   |           | not null | '-1'::integer
 lease_owner          | text                     |           |          | 
 lease_token          | text                     |           |          | 
 lease_heartbeat_at   | timestamp with time zone |           |          | 
 lease_expires_at     | timestamp with time zone |           |          | 
 consecutive_failures | integer                  |           | not null | 0
 last_error_code      | text                     |           |          | 
 last_error_summary   | text                     |           |          | 
 created_at           | timestamp with time zone |           | not null | now()
 updated_at           | timestamp with time zone |           | not null | now()
 dispatch_source      | sync_request_source      |           | not null | 'scheduled'::sync_request_source
Indexes:
    "page_sync_states_pkey" PRIMARY KEY, btree (page_id, stream)
    "page_sync_states_freshness_idx" btree (stream, succeeded_at)
    "page_sync_states_lease_idx" btree (status, lease_expires_at)
    "page_sync_states_runnable_idx" btree (status, retry_at, page_id, stream)
    "page_sync_states_schedule_idx" btree (status, last_scheduled_slot, page_id, stream)
Foreign-key constraints:
    "page_sync_states_page_id_pages_id_fk" FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE
Triggers:
    page_sync_states_retired_onlyfans_dm_messages_guard BEFORE INSERT OR UPDATE ON page_sync_states FOR EACH ROW EXECUTE FUNCTION guard_retired_onlyfans_dm_messages()

 account_id | native_account_ref |  n7d  | per_day 
------------+--------------------+-------+---------
          5 |                    | 78393 |   11199
          1 |                    | 48818 |    6974
          2 |                    | 31619 |    4517
          3 |                    | 26523 |    3789
          4 |                    | 16393 |    2342
         10 |                    |  3158 |     451
(6 rows)

 account_id |              kind              | source |  n7d  | per_day |            last            
------------+--------------------------------+--------+-------+---------+----------------------------
          1 | dm_conversations               | pull   | 25051 |    3579 | 2026-09-05 21:49:02.072+00
          1 | fan_earnings_monthly           | pull   |  5829 |     833 | 2026-09-05 14:20:55.546+00
          1 | fan_earnings_stats             | pull   |  5829 |     833 | 2026-09-05 14:20:52.98+00
          1 | followers                      | pull   |  5580 |     797 | 2026-09-05 21:36:43.199+00
          1 | dm_messages                    | pull   |  1360 |     194 | 2026-09-05 21:18:36.536+00
          1 | account_lookup                 | pull   |   936 |     134 | 2026-09-05 22:00:24.83+00
          1 | media_offer_stats              | pull   |   850 |     121 | 2026-09-05 01:19:59.718+00
          1 | post_replies                   | pull   |   700 |     100 | 2026-09-05 00:34:34.416+00
          1 | notifications                  | pull   |   672 |      96 | 2026-09-05 00:21:25.404+00
          1 | earnings_transactions          | pull   |   480 |      69 | 2026-09-05 22:00:22.068+00
          1 | vault_media                    | pull   |   378 |      54 | 2026-09-05 00:23:15.972+00
          1 | account_me                     | pull   |   371 |      53 | 2026-09-05 21:38:11.954+00
          1 | earnings_accounts              | pull   |   160 |      23 | 2026-09-05 21:44:39.338+00
          1 | subscribers                    | pull   |   159 |      23 | 2026-09-05 21:06:15.365+00
          1 | purchase_history               | pull   |   104 |      15 | 2026-09-05 06:18:59.422+00
          1 | posts                          | pull   |    97 |      14 | 2026-09-05 19:40:26.155+00
          1 | post_tips                      | pull   |    78 |      11 | 2026-09-05 19:40:28.249+00
          1 | vault_album_walk_completed     | pull   |    24 |       3 | 2026-09-05 00:22:49.473+00
          1 | dm_conversations:failed        | pull   |    18 |       3 | 2026-09-05 14:42:34.369+00
          1 | account_stats                  | pull   |    14 |       2 | 2026-09-05 05:02:44.754+00
          1 | discovery_feed                 | pull   |    14 |       2 | 2026-09-05 05:02:56.792+00
          1 | broadcast_stats                | pull   |     7 |       1 | 2026-09-05 05:02:59.811+00
          1 | earnings_monthlystats_snapshot | pull   |     7 |       1 | 2026-09-05 05:02:49.185+00
          1 | recapstats                     | pull   |     7 |       1 | 2026-09-05 05:03:14.628+00
          1 | payout_requests                | pull   |     7 |       1 | 2026-09-05 18:36:19.755+00
          1 | automated_messages             | pull   |     7 |       1 | 2026-09-05 00:06:29.905+00
          1 | uservault_albums               | pull   |     7 |       1 | 2026-09-05 00:06:22.209+00
          1 | payout_methods                 | pull   |     7 |       1 | 2026-09-05 18:36:17.16+00
          1 | account_walls                  | pull   |     7 |       1 | 2026-09-05 00:07:07.61+00
          1 | subscription_tiers             | pull   |     7 |       1 | 2026-09-05 00:06:24.721+00
          1 | polls                          | pull   |     7 |       1 | 2026-09-05 05:03:12.164+00
          1 | vault_albums                   | pull   |     7 |       1 | 2026-09-05 00:06:19.952+00
          1 | earnings_stats_snapshot        | pull   |     7 |       1 | 2026-09-05 05:02:46.482+00
          1 | tracking_links                 | pull   |     7 |       1 | 2026-09-05 05:02:51.596+00
          1 | gift_codes                     | pull   |     7 |       1 | 2026-09-05 00:06:27.332+00
          1 | broadcast_stats_deleted        | pull   |     7 |       1 | 2026-09-05 05:03:05.023+00
          1 | broadcast_scheduled            | pull   |     7 |       1 | 2026-09-05 05:03:09.422+00
          1 | dm_messages:failed             | pull   |     2 |       0 | 2026-08-30 20:17:24.565+00
          2 | dm_conversations               | pull   | 13493 |    1928 | 2026-09-05 22:01:25.257+00
          2 | fan_earnings_monthly           | pull   |  4376 |     625 | 2026-09-05 05:21:11.014+00
          2 | fan_earnings_stats             | pull   |  4376 |     625 | 2026-09-05 05:21:08.415+00
          2 | followers                      | pull   |  4085 |     584 | 2026-09-05 21:51:06.378+00
          2 | account_lookup                 | pull   |   826 |     118 | 2026-09-05 21:49:38.691+00
          2 | media_offer_stats              | pull   |   730 |     104 | 2026-09-05 00:51:41.074+00
          2 | notifications                  | pull   |   672 |      96 | 2026-09-05 00:14:16.118+00
          2 | dm_messages                    | pull   |   570 |      81 | 2026-09-05 21:32:18.039+00
          2 | earnings_transactions          | pull   |   504 |      72 | 2026-09-05 21:16:29.458+00
          2 | post_replies                   | pull   |   468 |      67 | 2026-09-05 12:38:06.846+00
          2 | account_me                     | pull   |   427 |      61 | 2026-09-05 21:54:12.057+00
          2 | vault_media                    | pull   |   378 |      54 | 2026-09-05 00:15:44.653+00
          2 | subscribers                    | pull   |   168 |      24 | 2026-09-05 21:22:17.069+00
          2 | earnings_accounts              | pull   |   168 |      24 | 2026-09-05 22:00:37.647+00
          2 | posts                          | pull   |   110 |      16 | 2026-09-05 17:02:16.578+00
          2 | post_tips                      | pull   |    84 |      12 | 2026-09-05 16:56:55.238+00
          2 | vault_album_walk_completed     | pull   |    22 |       3 | 2026-09-05 00:08:15.764+00
          2 | purchase_history               | pull   |    20 |       3 | 2026-09-05 21:34:16.654+00
          2 | discovery_feed                 | pull   |    14 |       2 | 2026-09-05 02:18:51.719+00
          2 | account_stats                  | pull   |    14 |       2 | 2026-09-05 02:18:39.596+00
          2 | broadcast_stats_deleted        | pull   |     7 |       1 | 2026-09-05 02:19:00.662+00
          2 | tracking_links                 | pull   |     7 |       1 | 2026-09-05 02:18:46.532+00
          2 | uservault_albums               | pull   |     7 |       1 | 2026-09-05 00:05:51.855+00
          2 | subscription_tiers             | pull   |     7 |       1 | 2026-09-05 00:05:54.395+00
          2 | gift_codes                     | pull   |     7 |       1 | 2026-09-05 00:05:56.965+00
          2 | automated_messages             | pull   |     7 |       1 | 2026-09-05 00:05:59.631+00
          2 | vault_albums                   | pull   |     7 |       1 | 2026-09-05 00:05:49.708+00
          2 | earnings_stats_snapshot        | pull   |     7 |       1 | 2026-09-05 02:18:41.422+00
          2 | broadcast_stats                | pull   |     7 |       1 | 2026-09-05 02:18:54.493+00
          2 | account_walls                  | pull   |     7 |       1 | 2026-09-05 00:06:15.752+00
          2 | payout_requests                | pull   |     7 |       1 | 2026-09-05 09:46:14.044+00
          2 | earnings_monthlystats_snapshot | pull   |     7 |       1 | 2026-09-05 02:18:44.098+00
          2 | recapstats                     | pull   |     7 |       1 | 2026-09-05 02:19:09.577+00
          2 | payout_methods                 | pull   |     7 |       1 | 2026-09-05 09:46:09.575+00
          2 | polls                          | pull   |     7 |       1 | 2026-09-05 02:19:06.963+00
          2 | broadcast_scheduled            | pull   |     7 |       1 | 2026-09-05 02:19:04.355+00
          2 | dm_conversations:failed        | pull   |     2 |       0 | 2026-09-03 09:31:26.065+00
          3 | dm_conversations               | pull   | 10680 |    1526 | 2026-09-05 21:46:48.565+00
          3 | followers                      | pull   |  4694 |     671 | 2026-09-05 22:00:15.133+00
          3 | fan_earnings_stats             | pull   |  2775 |     396 | 2026-09-05 20:20:53.247+00
          3 | fan_earnings_monthly           | pull   |  2775 |     396 | 2026-09-05 20:20:55.829+00
          3 | account_lookup                 | pull   |   859 |     123 | 2026-09-05 21:45:40.896+00
          3 | media_offer_stats              | pull   |   857 |     122 | 2026-09-05 01:01:40.107+00
          3 | dm_messages                    | pull   |   680 |      97 | 2026-09-05 21:47:06.15+00
          3 | notifications                  | pull   |   672 |      96 | 2026-09-05 00:19:34.752+00
          3 | earnings_transactions          | pull   |   504 |      72 | 2026-09-05 21:32:24.753+00
          3 | account_me                     | pull   |   418 |      60 | 2026-09-05 22:00:12.795+00
          3 | post_replies                   | pull   |   410 |      59 | 2026-09-05 09:55:15.082+00
          3 | vault_media                    | pull   |   373 |      53 | 2026-09-05 00:21:47.763+00
          3 | earnings_stats_snapshot        | pull   |   175 |      25 | 2026-09-05 00:08:36.949+00
          3 | subscribers                    | pull   |   169 |      24 | 2026-09-05 21:38:11.86+00
          3 | earnings_accounts              | pull   |   168 |      24 | 2026-09-05 21:16:38.522+00
          3 | posts                          | pull   |   110 |      16 | 2026-09-05 20:23:17.891+00
          3 | post_tips                      | pull   |    84 |      12 | 2026-09-05 20:21:11.44+00
          3 | purchase_history               | pull   |    34 |       5 | 2026-09-05 08:50:16.694+00
          3 | vault_album_walk_completed     | pull   |    21 |       3 | 2026-09-05 00:11:16.987+00
          3 | payout_requests                | pull   |     7 |       1 | 2026-09-05 01:02:36.965+00
          3 | vault_albums                   | pull   |     7 |       1 | 2026-09-05 00:07:12.11+00
          3 | subscription_tiers             | pull   |     7 |       1 | 2026-09-05 00:07:16.985+00
          3 | automated_messages             | pull   |     7 |       1 | 2026-09-05 00:07:22.203+00
          3 | gift_codes                     | pull   |     7 |       1 | 2026-09-05 00:07:19.612+00
          3 | payout_methods                 | pull   |     7 |       1 | 2026-09-05 01:02:34.672+00
          3 | account_walls                  | pull   |     7 |       1 | 2026-09-05 00:09:03.922+00
          3 | uservault_albums               | pull   |     7 |       1 | 2026-09-05 00:07:14.574+00
          3 | dm_conversations:failed        | pull   |     7 |       1 | 2026-09-04 06:15:17.663+00
          3 | followers_reconcile:failed     | pull   |     2 |       0 | 2026-08-29 23:55:07.269+00
          4 | dm_conversations               | pull   |  9876 |    1411 | 2026-09-05 22:02:37.427+00
          4 | followers                      | pull   |  1489 |     213 | 2026-09-05 21:19:20.741+00
          4 | fan_earnings_stats             | pull   |   686 |      98 | 2026-09-05 10:52:50.338+00
          4 | fan_earnings_monthly           | pull   |   686 |      98 | 2026-09-05 10:52:52.937+00
          4 | account_lookup                 | pull   |   673 |      96 | 2026-09-05 21:54:14.278+00
          4 | dm_messages                    | pull   |   523 |      75 | 2026-09-05 16:32:39.86+00
          4 | earnings_transactions          | pull   |   504 |      72 | 2026-09-05 21:48:57.144+00
          4 | media_offer_stats              | pull   |   427 |      61 | 2026-09-05 00:09:43.797+00
          4 | account_me                     | pull   |   403 |      58 | 2026-09-05 21:26:47.916+00
          4 | notifications                  | pull   |   336 |      48 | 2026-09-05 21:42:43.169+00
          4 | subscribers                    | pull   |   168 |      24 | 2026-09-05 21:54:11.999+00
          4 | earnings_accounts              | pull   |   168 |      24 | 2026-09-05 21:32:18.347+00
          4 | vault_media                    | pull   |    87 |      12 | 2026-09-05 21:54:16.889+00
          4 | posts                          | pull   |    75 |      11 | 2026-09-05 17:28:21.044+00
          4 | post_replies                   | pull   |    74 |      11 | 2026-09-05 13:11:16.85+00
          4 | post_tips                      | pull   |    56 |       8 | 2026-09-05 17:28:18.371+00
          4 | vault_album_walk_completed     | pull   |    17 |       2 | 2026-09-05 21:54:16.913+00
          4 | account_stats                  | pull   |    14 |       2 | 2026-09-05 02:50:40.513+00
          4 | discovery_feed                 | pull   |    14 |       2 | 2026-09-05 02:50:53.067+00
          4 | gift_codes                     | pull   |     7 |       1 | 2026-09-05 21:34:19.334+00
          4 | polls                          | pull   |     7 |       1 | 2026-09-05 02:51:09.449+00
          4 | broadcast_scheduled            | pull   |     7 |       1 | 2026-09-05 02:51:05.697+00
          4 | broadcast_stats_deleted        | pull   |     7 |       1 | 2026-09-05 02:51:00.845+00
          4 | earnings_monthlystats_snapshot | pull   |     7 |       1 | 2026-09-05 02:50:45.369+00
          4 | vault_albums                   | pull   |     7 |       1 | 2026-09-05 21:34:13.904+00
          4 | automated_messages             | pull   |     7 |       1 | 2026-09-05 21:34:21.945+00
          4 | payout_methods                 | pull   |     7 |       1 | 2026-09-05 16:19:24.636+00
          4 | payout_requests                | pull   |     7 |       1 | 2026-09-05 16:19:27.327+00
          4 | account_walls                  | pull   |     7 |       1 | 2026-09-05 21:35:12.703+00
          4 | broadcast_stats                | pull   |     7 |       1 | 2026-09-05 02:50:55.742+00
          4 | subscription_tiers             | pull   |     7 |       1 | 2026-09-05 21:34:16.731+00
          4 | recapstats                     | pull   |     7 |       1 | 2026-09-05 02:51:10.89+00
          4 | tracking_links                 | pull   |     7 |       1 | 2026-09-05 02:50:47.98+00
          4 | uservault_albums               | pull   |     7 |       1 | 2026-09-05 21:34:14.22+00
          4 | earnings_stats_snapshot        | pull   |     7 |       1 | 2026-09-05 02:50:42.706+00
          4 | dm_conversations:failed        | pull   |     4 |       1 | 2026-09-05 03:04:16.406+00
          4 | purchase_history               | pull   |     1 |       0 | 2026-09-01 20:06:07.478+00
          5 | dm_conversations               | pull   | 45256 |    6465 | 2026-09-05 21:57:54.605+00
          5 | followers                      | pull   | 13222 |    1889 | 2026-09-05 21:32:18.858+00
          5 | fan_earnings_stats             | pull   |  7035 |    1005 | 2026-09-05 04:29:07.376+00
          5 | fan_earnings_monthly           | pull   |  7035 |    1005 | 2026-09-05 04:29:09.545+00
          5 | dm_messages                    | pull   |  1578 |     225 | 2026-09-05 12:04:42.719+00
          5 | account_lookup                 | pull   |  1107 |     158 | 2026-09-05 22:04:24.063+00
          5 | notifications                  | pull   |   669 |      96 | 2026-09-05 00:14:10.127+00
          5 | media_offer_stats              | pull   |   644 |      92 | 2026-09-05 01:13:06.1+00
          5 | earnings_transactions          | pull   |   480 |      69 | 2026-09-05 22:04:21.448+00
          5 | account_me                     | pull   |   418 |      60 | 2026-09-05 21:42:41.686+00
          5 | vault_media                    | pull   |   189 |      27 | 2026-09-05 00:36:46.452+00
          5 | earnings_accounts              | pull   |   160 |      23 | 2026-09-05 21:49:06.774+00
          5 | subscribers                    | pull   |   159 |      23 | 2026-09-05 21:10:14.716+00
          5 | post_replies                   | pull   |   103 |      15 | 2026-09-05 16:42:30.943+00
          5 | posts                          | pull   |    75 |      11 | 2026-09-05 20:44:22.206+00
          5 | post_tips                      | pull   |    56 |       8 | 2026-09-05 20:44:24.561+00
          5 | dm_conversations:failed        | pull   |    44 |       6 | 2026-09-05 11:52:01.391+00
          5 | vault_album_walk_completed     | pull   |    19 |       3 | 2026-09-05 00:31:58.089+00
          5 | discovery_feed                 | pull   |    14 |       2 | 2026-09-05 00:06:55.969+00
          5 | account_stats                  | pull   |    14 |       2 | 2026-09-05 00:06:41.854+00
          5 | polls                          | pull   |     7 |       1 | 2026-09-05 00:07:11.991+00
          5 | uservault_albums               | pull   |     7 |       1 | 2026-09-05 00:05:50.785+00
          5 | payout_methods                 | pull   |     7 |       1 | 2026-09-05 07:34:04.833+00
          5 | earnings_stats_snapshot        | pull   |     7 |       1 | 2026-09-05 00:06:43.818+00
          5 | broadcast_stats_deleted        | pull   |     7 |       1 | 2026-09-05 00:07:04.195+00
          5 | account_walls                  | pull   |     7 |       1 | 2026-09-05 00:06:15.171+00
          5 | automated_messages             | pull   |     7 |       1 | 2026-09-05 00:05:58.468+00
          5 | gift_codes                     | pull   |     7 |       1 | 2026-09-05 00:05:55.854+00
          5 | payout_requests                | pull   |     7 |       1 | 2026-09-05 07:34:07.226+00
          5 | broadcast_scheduled            | pull   |     7 |       1 | 2026-09-05 00:07:08.651+00
          5 | tracking_links                 | pull   |     7 |       1 | 2026-09-05 00:06:48.99+00
          5 | broadcast_stats                | pull   |     7 |       1 | 2026-09-05 00:06:58.712+00
          5 | recapstats                     | pull   |     7 |       1 | 2026-09-05 00:07:13.792+00
          5 | subscription_tiers             | pull   |     7 |       1 | 2026-09-05 00:05:53.259+00
          5 | vault_albums                   | pull   |     7 |       1 | 2026-09-05 00:05:48.633+00
          5 | earnings_monthlystats_snapshot | pull   |     7 |       1 | 2026-09-05 00:06:46.567+00
          5 | purchase_history               | pull   |     2 |       0 | 2026-09-02 06:05:38.855+00
          5 | dm_messages:failed             | pull   |     2 |       0 | 2026-09-02 20:30:41.858+00
         10 | media_offer_stats              | pull   |   355 |      51 | 2026-09-05 00:09:51.117+00
         10 | account_me                     | pull   |   352 |      50 | 2026-09-05 22:02:12.279+00
         10 | account_lookup                 | pull   |   351 |      50 | 2026-09-05 21:30:15.524+00
         10 | dm_conversations               | pull   |   336 |      48 | 2026-09-05 21:36:13.086+00
         10 | notifications                  | pull   |   336 |      48 | 2026-09-05 21:48:48.592+00
         10 | dm_messages                    | pull   |   283 |      40 | 2026-09-05 18:06:44.662+00
         10 | earnings_transactions          | pull   |   183 |      26 | 2026-09-05 21:24:15.828+00
         10 | followers                      | pull   |   176 |      25 | 2026-09-05 21:52:16.028+00
         10 | earnings_accounts              | pull   |   174 |      25 | 2026-09-05 21:08:14.349+00
         10 | subscribers                    | pull   |   168 |      24 | 2026-09-05 21:30:13.076+00
         10 | posts                          | pull   |    77 |      11 | 2026-09-05 19:04:21.147+00
         10 | vault_media                    | pull   |    58 |       8 | 2026-09-05 17:14:42.2+00
         10 | post_tips                      | pull   |    40 |       6 | 2026-09-05 19:04:18.493+00
         10 | fan_earnings_monthly           | pull   |    37 |       5 | 2026-09-05 06:20:32.448+00
         10 | fan_earnings_stats             | pull   |    37 |       5 | 2026-09-05 06:20:29.846+00
         10 | transactions:failed            | pull   |    22 |       3 | 2026-08-30 07:39:44.657+00
         10 | account_stats                  | pull   |    14 |       2 | 2026-09-05 04:26:41.182+00
         10 | discovery_feed                 | pull   |    14 |       2 | 2026-09-05 04:26:53.657+00
         10 | post_replies                   | pull   |    13 |       2 | 2026-09-05 20:32:23.206+00
         10 | vault_album_walk_completed     | pull   |    10 |       1 | 2026-09-05 17:14:42.224+00
         10 | purchase_history               | pull   |     9 |       1 | 2026-08-31 19:42:32.044+00
         10 | account_walls                  | pull   |     7 |       1 | 2026-09-05 17:11:09.809+00
         10 | broadcast_stats_deleted        | pull   |     7 |       1 | 2026-09-05 04:27:01.267+00
         10 | uservault_albums               | pull   |     7 |       1 | 2026-09-05 17:10:12.91+00
         10 | broadcast_stats                | pull   |     7 |       1 | 2026-09-05 04:26:56.276+00
         10 | earnings_monthlystats_snapshot | pull   |     7 |       1 | 2026-09-05 04:26:45.938+00
         10 | gift_codes                     | pull   |     7 |       1 | 2026-09-05 17:10:18.084+00
         10 | automated_messages             | pull   |     7 |       1 | 2026-09-05 17:10:20.715+00
         10 | subscription_tiers             | pull   |     7 |       1 | 2026-09-05 17:10:15.484+00
         10 | payout_methods                 | pull   |     7 |       1 | 2026-09-05 11:54:07.332+00
         10 | tracking_links                 | pull   |     7 |       1 | 2026-09-05 04:26:48.465+00
         10 | recapstats                     | pull   |     7 |       1 | 2026-09-05 04:27:11.47+00
         10 | broadcast_scheduled            | pull   |     7 |       1 | 2026-09-05 04:27:06.274+00
         10 | earnings_stats_snapshot        | pull   |     7 |       1 | 2026-09-05 04:26:43.27+00
         10 | vault_albums                   | pull   |     7 |       1 | 2026-09-05 17:10:10.717+00
         10 | payout_requests                | pull   |     7 |       1 | 2026-09-05 11:54:09.656+00
         10 | polls                          | pull   |     7 |       1 | 2026-09-05 04:27:09.375+00
         10 | purchase_history:failed        | pull   |     1 |       0 | 2026-09-02 15:42:13.246+00
(217 rows)

           h            | count 
------------------------+-------
 2026-09-03 22:00:00+00 |   864
 2026-09-03 23:00:00+00 |  1008
 2026-09-04 00:00:00+00 |  2424
 2026-09-04 01:00:00+00 |  1089
 2026-09-04 02:00:00+00 |  1565
 2026-09-04 03:00:00+00 |  1611
 2026-09-04 04:00:00+00 |  2106
 2026-09-04 05:00:00+00 |  1015
 2026-09-04 06:00:00+00 |  1069
 2026-09-04 07:00:00+00 |   939
 2026-09-04 08:00:00+00 |   829
 2026-09-04 09:00:00+00 |   803
 2026-09-04 10:00:00+00 |  1111
 2026-09-04 11:00:00+00 |  1006
 2026-09-04 12:00:00+00 |  1216
 2026-09-04 13:00:00+00 |  2173
 2026-09-04 14:00:00+00 |  1354
 2026-09-04 15:00:00+00 |   913
 2026-09-04 16:00:00+00 |  1122
 2026-09-04 17:00:00+00 |   954
 2026-09-04 18:00:00+00 |  1045
 2026-09-04 19:00:00+00 |  1533
 2026-09-04 20:00:00+00 |   989
 2026-09-04 21:00:00+00 |   950
 2026-09-04 22:00:00+00 |   835
 2026-09-04 23:00:00+00 |   888
 2026-09-05 00:00:00+00 |  2102
 2026-09-05 01:00:00+00 |   911
 2026-09-05 02:00:00+00 |  1606
 2026-09-05 03:00:00+00 |  1631
 2026-09-05 04:00:00+00 |  2268
 2026-09-05 05:00:00+00 |  1456
 2026-09-05 06:00:00+00 |   744
 2026-09-05 07:00:00+00 |   738
 2026-09-05 08:00:00+00 |  1084
 2026-09-05 09:00:00+00 |   996
 2026-09-05 10:00:00+00 |  1185
 2026-09-05 11:00:00+00 |   930
 2026-09-05 12:00:00+00 |  1031
 2026-09-05 13:00:00+00 |  1826
 2026-09-05 14:00:00+00 |  1364
 2026-09-05 15:00:00+00 |  1000
 2026-09-05 16:00:00+00 |   870
 2026-09-05 17:00:00+00 |   882
 2026-09-05 18:00:00+00 |  1129
 2026-09-05 19:00:00+00 |  1705
 2026-09-05 20:00:00+00 |  1420
 2026-09-05 21:00:00+00 |  1060
 2026-09-05 22:00:00+00 |    64
(49 rows)

ERROR:  column "account_id" does not exist
LINE 1: select account_id, stream, status, succeeded_at, updated_at ...
               ^
```

## page_sync_states (Fansly pages)
```
 page_id |       stream        | status  |        succeeded_at        |         failed_at          |   blocker_kind    | consecutive_failures 
---------+---------------------+---------+----------------------------+----------------------------+-------------------+----------------------
       1 | light               | idle    | 2026-09-05 21:38:11.989+00 | 2026-08-18 17:42:06.155+00 |                   |                    0
       1 | followers           | idle    | 2026-09-05 21:28:48.407+00 | 2026-08-28 12:28:55.703+00 |                   |                    0
       1 | transactions        | idle    | 2026-09-05 22:00:25.37+00  | 2026-08-01 21:00:43.956+00 |                   |                    0
       1 | top_spenders        | idle    | 2026-09-05 21:44:39.371+00 | 2026-07-13 14:50:11.857+00 |                   |                    0
       1 | subscribers         | idle    | 2026-09-05 22:06:14.171+00 | 2026-08-28 04:18:42.66+00  |                   |                    0
       1 | dm_conversations    | idle    | 2026-09-05 21:49:02.411+00 | 2026-09-05 14:42:34.362+00 |                   |                    0
       1 | dm_messages         | idle    | 2026-09-05 21:18:36.654+00 | 2026-08-30 20:17:24.56+00  |                   |                    0
       1 | followers_reconcile | idle    | 2026-09-05 21:36:45.922+00 | 2026-08-24 17:36:48.934+00 |                   |                    0
       1 | fan_earnings        | idle    | 2026-09-05 14:20:55.643+00 | 2026-08-12 13:15:29.665+00 |                   |                    0
       1 | purchase_history    | idle    | 2026-09-05 18:18:48.064+00 |                            |                   |                    0
       1 | posts               | idle    | 2026-09-05 19:40:28.278+00 |                            |                   |                    0
       1 | stats_snapshot      | idle    | 2026-09-05 17:02:13.502+00 |                            |                   |                    0
       1 | notifications       | pending |                            |                            |                   |                    0
       1 | catalog             | pending | 2026-08-22 07:56:40.904+00 |                            |                   |                    0
       1 | post_replies        | pending |                            |                            |                   |                    0
       1 | payouts             | idle    | 2026-09-05 18:36:19.792+00 |                            |                   |                    0
       1 | media_stats         | pending |                            |                            |                   |                    0
       2 | light               | idle    | 2026-09-05 21:54:12.085+00 | 2026-08-12 13:55:22.841+00 |                   |                    0
       2 | followers           | idle    | 2026-09-05 21:44:16.298+00 | 2026-08-28 00:45:00.293+00 |                   |                    0
       2 | transactions        | idle    | 2026-09-05 21:16:32.605+00 | 2026-08-28 04:18:05.121+00 |                   |                    0
       2 | top_spenders        | idle    | 2026-09-05 22:00:37.688+00 | 2026-07-15 12:12:17.104+00 |                   |                    0
       2 | subscribers         | idle    | 2026-09-05 21:22:19.97+00  | 2026-08-24 22:26:26.709+00 |                   |                    0
       2 | dm_conversations    | idle    | 2026-09-05 22:01:25.436+00 | 2026-09-03 09:31:26.056+00 |                   |                    0
       2 | dm_messages         | idle    | 2026-09-05 21:32:18.105+00 | 2026-08-10 23:04:04.705+00 |                   |                    0
       2 | followers_reconcile | idle    | 2026-09-05 21:51:09.137+00 | 2026-08-23 17:47:26.366+00 |                   |                    0
       2 | fan_earnings        | idle    | 2026-09-05 05:21:11.113+00 | 2026-08-28 04:40:50.595+00 |                   |                    0
       2 | purchase_history    | idle    | 2026-09-05 21:34:16.679+00 |                            |                   |                    0
       2 | posts               | idle    | 2026-09-05 17:02:16.627+00 | 2026-08-13 16:57:44.98+00  |                   |                    0
       2 | stats_snapshot      | idle    | 2026-09-05 20:18:20.438+00 |                            |                   |                    0
       2 | notifications       | pending |                            |                            |                   |                    0
       2 | catalog             | pending | 2026-09-03 00:07:10.196+00 |                            |                   |                    0
       2 | post_replies        | idle    | 2026-09-05 18:24:15.231+00 |                            |                   |                    0
       2 | payouts             | idle    | 2026-09-05 09:46:14.076+00 |                            |                   |                    0
       2 | media_stats         | pending |                            |                            |                   |                    0
       3 | light               | idle    | 2026-09-05 21:10:14.409+00 | 2026-08-28 04:15:03.816+00 |                   |                    0
       3 | followers           | idle    | 2026-09-05 22:00:15.542+00 | 2026-07-21 12:44:53.926+00 |                   |                    0
       3 | transactions        | idle    | 2026-09-05 21:32:27.731+00 | 2026-08-12 11:33:11.108+00 |                   |                    0
       3 | top_spenders        | idle    | 2026-09-05 21:16:38.556+00 | 2026-08-28 04:17:38.075+00 |                   |                    0
       3 | subscribers         | idle    | 2026-09-05 21:38:14.534+00 | 2026-08-18 17:42:08.506+00 |                   |                    0
       3 | dm_conversations    | idle    | 2026-09-05 21:46:48.654+00 | 2026-09-04 06:15:17.655+00 |                   |                    0
       3 | dm_messages         | idle    | 2026-09-05 22:06:11.043+00 | 2026-08-23 20:54:11.624+00 |                   |                    0
       3 | followers_reconcile | idle    | 2026-09-05 21:06:39.699+00 | 2026-08-29 23:55:07.257+00 |                   |                    0
       3 | fan_earnings        | idle    | 2026-09-05 20:20:55.843+00 |                            |                   |                    0
       3 | purchase_history    | idle    | 2026-09-05 20:50:19.719+00 | 2026-08-18 20:54:39.453+00 |                   |                    0
       3 | posts               | idle    | 2026-09-05 20:23:17.957+00 |                            |                   |                    0
       3 | stats_snapshot      | pending |                            | 2026-08-24 10:30:19.99+00  |                   |                    0
       3 | notifications       | pending |                            |                            |                   |                    0
       3 | catalog             | pending | 2026-09-02 06:18:09.783+00 |                            |                   |                    0
       3 | post_replies        | idle    | 2026-09-05 21:40:11.809+00 |                            |                   |                    0
       3 | payouts             | idle    | 2026-09-05 01:02:37.034+00 |                            |                   |                    0
       3 | media_stats         | pending |                            |                            |                   |                    0
       4 | light               | idle    | 2026-09-05 21:26:47.99+00  | 2026-08-12 12:27:46.71+00  |                   |                    0
       4 | followers           | idle    | 2026-09-05 21:16:22.109+00 | 2026-08-28 04:17:29.394+00 |                   |                    0
       4 | transactions        | idle    | 2026-09-05 21:49:00.168+00 | 2026-08-18 20:56:30.07+00  |                   |                    0
       4 | top_spenders        | idle    | 2026-09-05 21:32:18.364+00 | 2026-06-17 23:04:13.833+00 |                   |                    0
       4 | subscribers         | idle    | 2026-09-05 21:54:14.459+00 | 2026-08-18 20:55:32.833+00 |                   |                    0
       4 | dm_conversations    | idle    | 2026-09-05 22:02:37.479+00 | 2026-09-05 03:04:16.398+00 |                   |                    0
       4 | dm_messages         | idle    | 2026-09-05 16:32:39.902+00 | 2026-07-29 04:35:49.765+00 |                   |                    0
       4 | followers_reconcile | idle    | 2026-09-05 21:19:23.529+00 | 2026-08-22 14:19:44.791+00 |                   |                    0
       4 | fan_earnings        | idle    | 2026-09-05 10:52:53.042+00 | 2026-08-12 11:25:21.558+00 |                   |                    0
       4 | purchase_history    | idle    | 2026-09-05 20:06:15.352+00 | 2026-07-17 19:55:54.063+00 |                   |                    0
       4 | posts               | idle    | 2026-09-05 17:28:21.064+00 |                            |                   |                    0
       4 | stats_snapshot      | idle    | 2026-09-05 20:50:18.022+00 |                            |                   |                    0
       4 | notifications       | idle    | 2026-09-05 21:42:43.204+00 | 2026-08-28 04:13:37.25+00  |                   |                    0
       4 | catalog             | idle    | 2026-09-05 21:55:12.261+00 |                            |                   |                    0
       4 | post_replies        | idle    | 2026-09-05 18:56:10.05+00  |                            |                   |                    0
       4 | payouts             | idle    | 2026-09-05 16:19:27.38+00  |                            |                   |                    0
       4 | media_stats         | pending |                            |                            |                   |                    0
       5 | light               | idle    | 2026-09-05 21:42:41.707+00 | 2026-08-15 14:58:09.174+00 |                   |                    0
       5 | followers           | idle    | 2026-09-05 21:32:18.968+00 | 2026-08-25 10:33:43.244+00 |                   |                    0
       5 | transactions        | idle    | 2026-09-05 22:04:24.474+00 | 2026-08-15 14:49:20.505+00 |                   |                    0
       5 | top_spenders        | idle    | 2026-09-05 21:49:06.785+00 | 2026-08-15 15:09:16.48+00  |                   |                    0
       5 | subscribers         | idle    | 2026-09-05 21:10:17.882+00 | 2026-08-25 10:11:35.86+00  |                   |                    0
       5 | dm_conversations    | idle    | 2026-09-05 21:57:54.802+00 | 2026-09-05 11:52:01.384+00 |                   |                    0
       5 | dm_messages         | idle    | 2026-09-05 12:04:42.772+00 | 2026-09-02 20:30:41.852+00 |                   |                    0
       5 | followers_reconcile | idle    | 2026-09-05 20:22:38.219+00 | 2026-08-12 03:06:42.849+00 |                   |                    0
       5 | fan_earnings        | idle    | 2026-09-05 04:29:09.556+00 | 2026-08-15 15:16:44.744+00 |                   |                    0
       5 | purchase_history    | idle    | 2026-09-05 19:27:55.101+00 | 2026-07-06 11:27:20.672+00 |                   |                    0
       5 | posts               | idle    | 2026-09-05 20:44:24.587+00 | 2026-08-15 14:53:19.166+00 |                   |                    0
       5 | stats_snapshot      | idle    | 2026-09-05 18:06:41.788+00 |                            |                   |                    0
       5 | notifications       | pending |                            |                            |                   |                    0
       5 | catalog             | pending | 2026-09-03 12:59:19.727+00 |                            |                   |                    0
       5 | post_replies        | idle    | 2026-09-05 16:43:12.16+00  |                            |                   |                    0
       5 | payouts             | idle    | 2026-09-05 07:34:07.305+00 |                            |                   |                    0
       5 | media_stats         | pending |                            |                            |                   |                    0
      10 | light               | idle    | 2026-09-05 22:02:12.307+00 |                            |                   |                    0
      10 | followers           | idle    | 2026-09-05 21:52:16.187+00 |                            |                   |                    0
      10 | transactions        | idle    | 2026-09-05 21:24:18.43+00  | 2026-08-30 07:39:44.649+00 |                   |                    0
      10 | top_spenders        | idle    | 2026-09-05 21:08:14.378+00 |                            |                   |                    0
      10 | subscribers         | idle    | 2026-09-05 21:30:15.631+00 | 2026-08-25 10:34:40.242+00 |                   |                    0
      10 | dm_conversations    | idle    | 2026-09-05 22:06:11.968+00 |                            |                   |                    0
      10 | dm_messages         | idle    | 2026-09-05 18:06:44.713+00 |                            |                   |                    0
      10 | followers_reconcile | idle    | 2026-09-04 14:14:41.091+00 |                            |                   |                    0
      10 | fan_earnings        | idle    | 2026-09-05 06:20:32.547+00 |                            |                   |                    0
      10 | purchase_history    | blocked | 2026-09-02 11:42:09.368+00 | 2026-09-02 15:42:13.231+00 | provider_bad_data |                    1
      10 | posts               | idle    | 2026-09-05 19:04:21.166+00 |                            |                   |                    0
      10 | stats_snapshot      | idle    | 2026-09-05 16:26:11.093+00 |                            |                   |                    0
      10 | notifications       | idle    | 2026-09-05 21:48:48.619+00 | 2026-08-25 10:19:37.526+00 |                   |                    0
      10 | catalog             | idle    | 2026-09-05 17:15:13.489+00 |                            |                   |                    0
      10 | post_replies        | idle    | 2026-09-05 20:32:23.234+00 |                            |                   |                    0
      10 | payouts             | idle    | 2026-09-05 11:54:09.69+00  |                            |                   |                    0
      10 | media_stats         | pending | 2026-08-31 21:18:41.764+00 |                            |                   |                    0
(102 rows)

```
