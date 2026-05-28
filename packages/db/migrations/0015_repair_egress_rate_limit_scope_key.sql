CREATE OR REPLACE FUNCTION pg_temp.canonical_proxy_host(raw_host text)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  normalized text;
  dotted text[];
  left_hex text;
  right_hex text;
BEGIN
  raw_host := lower(nullif(raw_host, ''));
  IF raw_host IS NULL THEN
    RETURN NULL;
  END IF;

  IF position(':' in raw_host) > 0 THEN
    normalized := host(raw_host::inet);
    dotted := regexp_match(normalized, '^(.*:)([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$');
    IF dotted IS NOT NULL THEN
      left_hex := coalesce(nullif(ltrim(to_hex(dotted[2]::int * 256 + dotted[3]::int), '0'), ''), '0');
      right_hex := coalesce(nullif(ltrim(to_hex(dotted[4]::int * 256 + dotted[5]::int), '0'), ''), '0');
      normalized := dotted[1] || left_hex || ':' || right_hex;
    END IF;

    RETURN '[' || normalized || ']';
  END IF;

  IF raw_host ~ '^[a-z0-9.-]+$' THEN
    RETURN raw_host;
  END IF;

  RETURN NULL;
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$$;

WITH parsed AS (
  SELECT id,
         lower(split_part(url, '://', 1)) AS protocol,
         rate_limit_scope_key,
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
  WHERE kind = 'proxy'
    AND (
      rate_limit_scope_key IS NULL OR
      rate_limit_scope_key ~ '^(http|https|socks5)://'
    )
),
authority_parts AS (
  SELECT parsed.id,
         parsed.protocol,
         parsed.rate_limit_scope_key,
         (matched.parts)[1] AS raw_host,
         (matched.parts)[2] AS raw_port
  FROM parsed
  CROSS JOIN LATERAL (
    SELECT CASE
      WHEN parsed.authority LIKE '[%' THEN regexp_match(parsed.authority, '^\[([^\]]+)\](?::([^:]+))?$')
      ELSE regexp_match(parsed.authority, '^([^:]+)(?::([^:]+))?$')
    END AS parts
  ) AS matched
  WHERE parsed.protocol IN ('http', 'https', 'socks5')
    AND matched.parts IS NOT NULL
),
canonical AS (
  SELECT id,
         protocol,
         rate_limit_scope_key,
         pg_temp.canonical_proxy_host(raw_host) AS host,
         COALESCE(
           NULLIF(raw_port, ''),
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
         rate_limit_scope_key,
         host,
         CASE
           WHEN port_text ~ '^[0-9]{1,5}$' THEN port_text::integer
           ELSE NULL
         END AS port
  FROM canonical
)
UPDATE egress_endpoints AS e
SET rate_limit_scope_key = validated.protocol || '://' || validated.host || ':' || validated.port::text
FROM validated
WHERE e.id = validated.id
  AND validated.host <> ''
  AND validated.port BETWEEN 1 AND 65535
  AND validated.rate_limit_scope_key IS DISTINCT FROM
    validated.protocol || '://' || validated.host || ':' || validated.port::text;
