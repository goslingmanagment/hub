# Read-only production snapshot after the final merge

Captured September 14, 2026, 02:14:57–02:14:59 UTC. Commands, observation
intervals, exit codes and stdout/stderr SHA-256 hashes are retained alongside
their raw output. These are two bounded SSH reads; neither changes production.

- API, worker and scheduler are running and healthy, with zero restarts.
- All three retain source label `380326368fe3` and image
  `sha256:c443947a356972cd2833c10a4e728fe1890e92e76a77fc2328f00ebca0af5c85`.
- Root filesystem: 79G size, 60G used, 18G available, 78% used (`df -h` units).

The exact runtime output hash equals the earlier 01:32 snapshot. No deployment,
flag change, provider request, socket probe, recovery or cleanup was performed.
This does not prove business-event delivery, reader latency or migration gates.
