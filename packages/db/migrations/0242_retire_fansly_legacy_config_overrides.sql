-- 0242_retire_fansly_legacy_config_overrides.sql
--
-- Fansly Sync Engine, step 4 (design S4-26 [E15], plan §14): the config keys of
-- the legacy Fansly engine are removed from the registry in this release —
-- the legacy lanes' switches, page allowlists and daily budgets, the WebSocket
-- receiver's capture and hint keys, the DM bounded scan, head catch-up, shadow
-- and deep backfill, the fan-earnings recovery, targets and roster age, the
-- followers settlement reuse, the AI media accelerator and fast lane, the
-- hydration autopilot, the shared rate limiter, the transaction windows, the
-- follower health age, the three endpoint pauses and the two pause aliases.
-- Nothing has read any of them since the release before this one.
--
-- A stored override of a key the registry no longer names is a row no process
-- applies and every process reports as skipped at boot, and `config clear`
-- refuses a key it does not know. So the overrides of these keys go here, in
-- the same release as their descriptors, and not silently: every removed row
-- leaves one `config_audit_log` row, written the way a clear writes it (old
-- value and version, new value and version null, no user), all under one
-- `group_id`.
--
-- Data only: one statement, no DDL. Overrides of every other key, and the
-- audit rows these keys already have, are untouched. A database with none of
-- these rows (a new one, or this migration applied before) changes nothing
-- and gets no audit row.
--
-- (Production, 2026-10-04: 77 overrides, 42 of them of these keys.)
--
-- After the deploy (read-only): no override is left without a descriptor —
-- the Configuration tab lists no skipped override, and
--   select key, old_value, old_version from config_audit_log
--    where note like 'step 4: retired with the legacy Fansly engine%';
-- shows what was removed.
--
-- Rollback-compatible: the previous image still registers these keys but
-- reads none of them, so with the rows gone it shows their env defaults and
-- runs unchanged.
with retired (key) as (
  values
    ('agentHydrationAutoApproveMode'),
    ('agentHydrationAutoDailyCallBudget'),
    ('aiMediaDescribeFanslyAcceleratorDailyLimit'),
    ('aiMediaDescribeFanslyAcceleratorEnabled'),
    ('aiMediaDescribeFanslyFastLaneMode'),
    ('aiMediaDescribeFanslyFastLanePages'),
    ('fanslyAccountLookupDelayMs'),
    ('fanslyBackfillContinuationDelayMs'),
    ('fanslyCatalogDailyCallBudget'),
    ('fanslyCatalogPageAllowlist'),
    ('fanslyCatalogSyncEnabled'),
    ('fanslyDeepBackfillIgnoreRetentionLimit'),
    ('fanslyDmBoundedEnabled'),
    ('fanslyDmBoundedPageAllowlist'),
    ('fanslyDmBoundedPolicies'),
    ('fanslyDmConversationsDelayMs'),
    ('fanslyDmDeepBackfillContinuationDelayMs'),
    ('fanslyDmDeepBackfillContinuationJitterMs'),
    ('fanslyDmDeepBackfillEnabled'),
    ('fanslyDmDeepBackfillLiveRequestsPerDeep'),
    ('fanslyDmDeepBackfillMaxRequestsPerRun'),
    ('fanslyDmHeadCatchupPageAllowlist'),
    ('fanslyDmMessagesDelayMs'),
    ('fanslyDmShadowPageAllowlist'),
    ('fanslyFanEarningsRecoveryEnabled'),
    ('fanslyFanEarningsRecoveryPageAllowlist'),
    ('fanslyFanEarningsRosterMaxAgeHours'),
    ('fanslyFanEarningsShadowPageAllowlist'),
    ('fanslyFanEarningsSyncEnabled'),
    ('fanslyFanEarningsTargetsDailyAttemptLimit'),
    ('fanslyFanEarningsTargetsEnabled'),
    ('fanslyFanEarningsTargetsPageAllowlist'),
    ('fanslyFollowersSettlementReuseEnabled'),
    ('fanslyFollowersSettlementReusePageAllowlist'),
    ('fanslyGlobalDelayMs'),
    ('fanslyMediaStatsDailyCallBudget'),
    ('fanslyMediaStatsLongTailCycleDays'),
    ('fanslyMediaStatsPageAllowlist'),
    ('fanslyMediaStatsSyncEnabled'),
    ('fanslyNewStreamPageAllowlist'),
    ('fanslyNotificationsDailyCallBudget'),
    ('fanslyNotificationsPageAllowlist'),
    ('fanslyNotificationsSyncEnabled'),
    ('fanslyPayoutsDailyCallBudget'),
    ('fanslyPayoutsPageAllowlist'),
    ('fanslyPayoutsSyncEnabled'),
    ('fanslyPostEngagementDailyCallBudget'),
    ('fanslyPostEngagementRefreshEnabled'),
    ('fanslyPostRepliesPageAllowlist'),
    ('fanslyPostRepliesSyncEnabled'),
    ('fanslyPurchaseHistorySyncEnabled'),
    ('fanslyRepliesDailyCallBudget'),
    ('fanslyStatsHourlyBackfillMaxDays'),
    ('fanslyStatsHourlyEnabled'),
    ('fanslyStatsSnapshotDailyCallBudget'),
    ('fanslyStatsSnapshotPageAllowlist'),
    ('fanslyStatsSnapshotSyncEnabled'),
    ('fanslyWsCaptureEnabled'),
    ('fanslyWsCapturePageAllowlist'),
    ('fanslyWsHintsEnabled'),
    ('fanslyWsHintsPageAllowlist'),
    ('fanslyWsHintsPolicies'),
    ('fanslyWsHintsTypeAllowlist'),
    ('followerPageDelayMs'),
    ('healthSyncFollowerMaxAgeMinutes'),
    ('syncSharedRateLimitEnabled'),
    ('transactionLookbackDays'),
    ('transactionRescanCapDays')
),
batch as materialized (
  select gen_random_uuid() as group_id
),
removed as (
  delete from config_settings cs
   using retired r
   where cs.key = r.key
  returning cs.scope_type, cs.scope_id, cs.key, cs.value, cs.version
)
insert into config_audit_log
  (group_id, user_id, scope_type, scope_id, key, old_value, new_value, old_version, new_version, note)
select b.group_id, null, d.scope_type, d.scope_id, d.key, d.value, null, d.version, null,
       'step 4: retired with the legacy Fansly engine (migration retire_fansly_legacy_config_overrides)'
  from removed d
 cross join batch b
 order by d.key;
