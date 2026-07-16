-- A webhook secret candidate is durable before the remote create/update call,
-- so an applied request with a lost response cannot make every delivery fail
-- signature verification.

ALTER TABLE ofapi_webhook_config
  ADD COLUMN registration_state text NOT NULL DEFAULT 'stable',
  ADD COLUMN pending_registration jsonb,
  ADD COLUMN pending_encrypted_signing_secret text,
  ADD COLUMN registration_error text;

ALTER TABLE ofapi_webhook_config
  ADD CONSTRAINT ofapi_webhook_config_registration_state_check
  CHECK (registration_state IN (
    'stable',
    'create_prepared', 'create_dispatching', 'create_indeterminate', 'create_failed',
    'update_prepared', 'update_dispatching', 'update_indeterminate'
  )),
  ADD CONSTRAINT ofapi_webhook_config_pending_registration_check
  CHECK (
    (registration_state IN ('stable', 'create_failed')
      AND pending_registration IS NULL
      AND pending_encrypted_signing_secret IS NULL)
    OR
    (registration_state NOT IN ('stable', 'create_failed')
      AND jsonb_typeof(pending_registration) = 'object'
      AND pending_encrypted_signing_secret IS NOT NULL)
  );

-- A legacy singleton without an external id is not proof that the historical
-- POST failed. Park it rather than silently issuing a duplicate create.
UPDATE ofapi_webhook_config
SET registration_state = 'create_indeterminate',
    pending_registration = jsonb_build_object(
      'operationId', 'legacy-unknown',
      'operation', 'create',
      'externalWebhookId', null,
      'endpointUrl', endpoint_url,
      'accountScope', account_scope,
      'events', events,
      'preparedAt', updated_at
    ),
    pending_encrypted_signing_secret = encrypted_signing_secret,
    registration_error = 'legacy config has no external webhook id; reconcile before create'
WHERE external_webhook_id IS NULL;
