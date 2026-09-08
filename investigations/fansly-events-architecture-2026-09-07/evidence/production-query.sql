BEGIN READ ONLY;
SET LOCAL statement_timeout='20s';
SELECT now() AS checked_at, current_user;
SELECT p.id,p.label,p.platform FROM pages p WHERE p.platform='fansly' ORDER BY p.id;
SELECT p.label,o.producer,o.kind,count(*) AS observations_24h,max(o.received_at) AS latest,min(o.parse_version) AS min_parse,max(o.parse_version) AS max_parse
FROM observations o JOIN pages p ON p.id=o.account_id
WHERE o.received_at>=now()-interval '24 hours' AND p.platform='fansly'
GROUP BY p.label,o.producer,o.kind ORDER BY p.label,observations_24h DESC;
COMMIT;
