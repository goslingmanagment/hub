WITH parsed AS (
  SELECT id,
         lower(split_part(url, '://', 1)) AS protocol,
         regexp_replace(
           split_part(
             split_part(
               split_part(regexp_replace(url, '^[^:]+://', ''), '/', 1),
               '?',
               1
             ),
             '#',
             1
           ),
           '^.*@',
           ''
         ) AS authority
  FROM egress_endpoints
  WHERE rate_limit_scope_key IS NULL
),
authority_parts AS (
  SELECT id,
         protocol,
         CASE
           WHEN authority LIKE '[%' THEN trim(leading '[' from split_part(authority, ']', 1))
           ELSE split_part(authority, ':', 1)
         END AS raw_host,
         NULLIF(
           CASE
             WHEN authority LIKE '[%' THEN split_part(split_part(authority, ']', 2), ':', 2)
             ELSE split_part(authority, ':', 2)
           END,
           ''
         ) AS raw_port
  FROM parsed
  WHERE protocol IN ('http', 'https', 'socks5')
),
canonical AS (
  SELECT id,
         protocol,
         CASE
           WHEN raw_host LIKE '%:%' THEN '[' || host(raw_host::inet) || ']'
           ELSE lower(raw_host)
         END AS host,
         COALESCE(
           raw_port,
           CASE protocol
             WHEN 'http' THEN '80'
             WHEN 'https' THEN '443'
             WHEN 'socks5' THEN '1080'
             ELSE NULL
           END
         ) AS port_text
  FROM authority_parts
),
validated AS (
  SELECT id,
         protocol,
         host,
         CASE
           WHEN port_text ~ '^[0-9]+$' THEN port_text::integer
           ELSE NULL
         END AS port
  FROM canonical
)
UPDATE egress_endpoints AS e
SET rate_limit_scope_key = validated.protocol || '://' || validated.host || ':' || validated.port::text
FROM validated
WHERE e.id = validated.id
  AND validated.host <> ''
  AND validated.port BETWEEN 1 AND 65535;
