WITH parsed AS (
  SELECT id,
         lower(split_part(url, '://', 1)) AS protocol,
         regexp_replace(
           split_part(regexp_replace(url, '^[^:]+://', ''), '/', 1),
           '^.*@',
           ''
         ) AS authority
  FROM egress_endpoints
  WHERE rate_limit_scope_key IS NULL
),
canonical AS (
  SELECT id,
         protocol,
         lower(
           CASE
             WHEN authority LIKE '[%' THEN split_part(authority, ']', 1) || ']'
             ELSE split_part(authority, ':', 1)
           END
         ) AS host,
         COALESCE(
           NULLIF(
             CASE
               WHEN authority LIKE '[%' THEN split_part(split_part(authority, ']', 2), ':', 2)
               ELSE split_part(authority, ':', 2)
             END,
             ''
           ),
           CASE protocol
             WHEN 'http' THEN '80'
             WHEN 'https' THEN '443'
             WHEN 'socks5' THEN '1080'
             ELSE NULL
           END
         ) AS port
  FROM parsed
  WHERE protocol IN ('http', 'https', 'socks5')
)
UPDATE egress_endpoints AS e
SET rate_limit_scope_key = canonical.protocol || '://' || canonical.host || ':' || canonical.port
FROM canonical
WHERE e.id = canonical.id
  AND canonical.host <> ''
  AND canonical.port IS NOT NULL;
