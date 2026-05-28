WITH canonical AS (
  SELECT id,
         rate_limit_scope_key,
         canonical_proxy_egress_key(url) AS canonical_key,
         canonical_proxy_egress_key(rate_limit_scope_key) AS canonical_scope_key
  FROM egress_endpoints
  WHERE kind = 'proxy'
    AND (
      rate_limit_scope_key IS NULL OR
      rate_limit_scope_key ~ '^(http|https|socks5)://'
    )
)
UPDATE egress_endpoints AS e
SET rate_limit_scope_key = canonical.canonical_key
FROM canonical
WHERE e.id = canonical.id
  AND (
    canonical.rate_limit_scope_key IS NULL OR
    canonical.canonical_scope_key IS NOT DISTINCT FROM canonical.canonical_key
  )
  AND e.rate_limit_scope_key IS DISTINCT FROM canonical.canonical_key;
