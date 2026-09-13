# Paired W0 diagnostics — validation only

The `synthetic-*` reports contain fabricated fixtures, with declared fixture
times. They demonstrate one candidate entity match, repeated-reference ambiguity
and one unmatched reference on either side. They establish no live fan-out.

The implementing agent ran `pnpm check` (3462 passed, 9 existing skips), serial
Docker-Postgres (37 passed) and the mocked Python launcher suite (10 passed).
Independent static review and source hashes are retained separately. The earlier
targeted run's Node-loader warning assertion failed and was corrected; the final
full run passes. Compressed logs preserve their original bytes.

No provider call, socket connection, production configuration change or paired
browser observation was made to validate these changes. The previous 120-second
live probe belongs to the separately dated same-token evidence packet.
