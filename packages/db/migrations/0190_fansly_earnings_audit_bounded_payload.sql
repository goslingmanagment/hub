-- PostgreSQL 16's byteaoctetlen reads the raw varlena length without detoasting.
-- JSONB shares that container layout. Keep this alias private to the audit reader.
DO $$ BEGIN
  IF current_setting('server_version_num')::integer / 10000 <> 16 THEN
    RAISE EXCEPTION 'earnings_audit_raw_length_requires_postgresql_16';
  END IF;
END $$;
CREATE FUNCTION public.fansly_earnings_audit_raw_bytes(jsonb)
RETURNS integer LANGUAGE internal IMMUTABLE STRICT AS 'byteaoctetlen';
REVOKE ALL ON FUNCTION public.fansly_earnings_audit_raw_bytes(jsonb) FROM PUBLIC;

-- Bound decimal expansion before serializing any numeric. JSONB stores a large
-- exponent compactly; bounding the binary datum alone does not bound its text.
CREATE FUNCTION public.fansly_earnings_audit_scalar(value jsonb, keep_string boolean)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE STRICT
SET search_path = pg_catalog, public AS $$
BEGIN
  CASE jsonb_typeof(value)
    WHEN 'number' THEN
      IF abs(value::numeric) > 1e100::numeric OR scale(value::numeric) > 100 THEN
        RETURN NULL;
      END IF;
    WHEN 'string' THEN
      IF NOT keep_string THEN RETURN '""'::jsonb; END IF;
      IF octet_length(value #>> '{}') > 256 THEN RETURN NULL; END IF;
    WHEN 'object' THEN RETURN '{}'::jsonb;
    WHEN 'array' THEN RETURN '[]'::jsonb;
    ELSE NULL;
  END CASE;
  RETURN value;
END;
$$;
REVOKE ALL ON FUNCTION public.fansly_earnings_audit_scalar(jsonb, boolean) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.fansly_earnings_audit_payload(body jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog, public AS $$
DECLARE
  row jsonb;
  field text;
  value jsonb;
  selected jsonb;
  result jsonb := '[]'::jsonb;
BEGIN
  IF public.fansly_earnings_audit_raw_bytes(body) > 65536 THEN RETURN NULL; END IF;
  IF jsonb_typeof(body) <> 'array' THEN
    RETURN public.fansly_earnings_audit_scalar(body, false);
  END IF;
  IF jsonb_array_length(body) > 512 THEN RETURN NULL; END IF;
  FOR row IN SELECT r.value FROM jsonb_array_elements(body) WITH ORDINALITY r(value, ordinal)
    ORDER BY r.ordinal LOOP
    IF jsonb_typeof(row) = 'object' THEN
      selected := '{}'::jsonb;
      FOREACH field IN ARRAY ARRAY[
        'correlationAccountId', 'year', 'month', 'type', 'totalGross', 'totalNet'
      ] LOOP
        IF NOT row ? field THEN CONTINUE; END IF;
        value := public.fansly_earnings_audit_scalar(row->field, field = 'correlationAccountId');
        IF value IS NULL THEN RETURN NULL; END IF;
        selected := selected || jsonb_build_object(field, value);
      END LOOP;
    ELSE
      selected := public.fansly_earnings_audit_scalar(row, false);
      IF selected IS NULL THEN RETURN NULL; END IF;
    END IF;
    result := result || jsonb_build_array(selected);
  END LOOP;
  -- At most 512 rows, six bounded scalars each: this conversion is bounded even
  -- when the result exceeds the stricter per-observation export limit.
  IF octet_length(result::text) > 65536 THEN RETURN NULL; END IF;
  RETURN result;
END;
$$;
