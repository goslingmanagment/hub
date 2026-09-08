BEGIN READ ONLY;
SET LOCAL statement_timeout='20s';
SELECT now(),current_user,current_setting('transaction_read_only');
SELECT o.kind,o.parse_version,count(*),min(o.received_at),max(o.received_at)
FROM observations o WHERE o.source='pull' AND o.kind IN ('dm_messages','earnings_transactions','fan_earnings_stats','fan_earnings_monthly','purchase_history') AND o.parse_version<6
GROUP BY o.kind,o.parse_version ORDER BY o.kind,o.parse_version;
SELECT id,label,platform FROM pages WHERE platform='fansly' ORDER BY id;
COMMIT;
