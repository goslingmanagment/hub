-- 0119: hydration auto-approve policy — decision provenance (decision #202).
--
-- The owner may delegate approval of BOUNDED Fansly thread-deepening requests
-- to a versioned in-kernel policy. A decision row must therefore say WHO
-- decided it — the owner, or the policy. Substituting a fictitious owner id
-- is exactly the confusion the actor model exists to prevent, so the policy
-- becomes a first-class decision source and journal actor instead.

ALTER TABLE "agent_hydration_requests"
  ADD COLUMN "decision_source" text,
  ADD COLUMN "decision_policy_version" integer;

-- Every decision recorded before this migration was made by the owner.
UPDATE "agent_hydration_requests"
  SET "decision_source" = 'owner'
  WHERE "decision_approved" IS NOT NULL;

ALTER TABLE "agent_hydration_requests"
  ADD CONSTRAINT "agent_hydration_requests_decision_source_check" CHECK (
    "decision_source" IS NULL OR "decision_source" IN ('owner', 'auto_policy')
  ),
  -- A decided row names its source; an undecided row has none.
  ADD CONSTRAINT "agent_hydration_requests_decision_source_presence_check" CHECK (
    ("decision_approved" IS NULL) = ("decision_source" IS NULL)
  ),
  -- The policy version travels with policy decisions and ONLY with them.
  ADD CONSTRAINT "agent_hydration_requests_policy_version_check" CHECK (
    ("decision_source" = 'auto_policy' AND "decision_policy_version" IS NOT NULL)
    OR ("decision_source" IS DISTINCT FROM 'auto_policy' AND "decision_policy_version" IS NULL)
  );

ALTER TABLE "agent_hydration_events"
  DROP CONSTRAINT "agent_hydration_events_actor_check";
ALTER TABLE "agent_hydration_events"
  ADD CONSTRAINT "agent_hydration_events_actor_check" CHECK ("actor" IN (
    'agent_key', 'owner_session', 'executor', 'sweeper', 'auto_policy'
  ));
