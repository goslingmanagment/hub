-- Custody conflicts quarantine one account ref and open a global incident.
ALTER TYPE notification_incident_kind ADD VALUE IF NOT EXISTS 'ofapi_binding_conflict';
