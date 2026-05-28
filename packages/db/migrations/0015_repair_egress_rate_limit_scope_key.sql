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

CREATE OR REPLACE FUNCTION pg_temp.canonical_proxy_egress_key(raw_url text)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  protocol text;
  authority text;
  parts text[];
  raw_host text;
  raw_port text;
  canonical_host text;
  port_text text;
  port integer;
BEGIN
  raw_url := nullif(raw_url, '');
  IF raw_url IS NULL THEN
    RETURN NULL;
  END IF;

  protocol := lower(split_part(raw_url, '://', 1));
  IF protocol NOT IN ('http', 'https', 'socks5') THEN
    RETURN NULL;
  END IF;

  authority := regexp_replace(
    split_part(
      split_part(
        split_part(regexp_replace(raw_url, '^[^:]+://', ''), '/', 1),
        '?',
        1
      ),
      '#',
      1
    ),
    '^.*@',
    ''
  );

  IF authority LIKE '[%' THEN
    parts := regexp_match(authority, '^\[([^\]]+)\](?::([^:]+))?$');
  ELSE
    parts := regexp_match(authority, '^([^:]+)(?::([^:]+))?$');
  END IF;

  IF parts IS NULL THEN
    RETURN NULL;
  END IF;

  raw_host := parts[1];
  raw_port := parts[2];
  canonical_host := pg_temp.canonical_proxy_host(raw_host);
  IF canonical_host IS NULL OR canonical_host = '' THEN
    RETURN NULL;
  END IF;

  port_text := COALESCE(
    NULLIF(raw_port, ''),
    CASE protocol
      WHEN 'http' THEN '80'
      WHEN 'https' THEN '443'
      WHEN 'socks5' THEN '1080'
      ELSE NULL
    END
  );

  IF port_text !~ '^[0-9]{1,5}$' THEN
    RETURN NULL;
  END IF;

  port := port_text::integer;
  IF port < 1 OR port > 65535 THEN
    RETURN NULL;
  END IF;

  RETURN protocol || '://' || canonical_host || ':' || port::text;
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$$;

WITH canonical AS (
  SELECT id,
         rate_limit_scope_key,
         pg_temp.canonical_proxy_egress_key(url) AS canonical_key,
         pg_temp.canonical_proxy_egress_key(rate_limit_scope_key) AS canonical_scope_key
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
