# W0 session choice — 13 September 2026

The owner replied in the implementation chat:

> да давай использовать его же

Context: the immediately preceding proposal was to use the same Fansly session
token that Hub already uses for its REST API access. The approval refers to that
existing provider credential, stored encrypted in Hub, not a Hub administrative
API token. This note records the supplied chat context; it is not a provider
receipt, credential export or timestamped proof of a live connection.

This replaces the 8 September Management-only choice and its prohibition on
using the existing owner session for WS. It does not create a new credential or
grant permission to revoke or rotate the working REST token. No raw token may
appear in CLI arguments, environment exports, logs, exceptions, clipboard, chat
or diagnostic artifacts. The trusted process must use the existing credential
path without exporting its value.

The first limited probe candidate is `lilly-1`. The bounded executable and
its validation are recorded in [STATUS.md](STATUS.md); no live result is
established by this note. A live run still needs the
page/account and credential-generation evidence required by the runbook.
This owner-choice note alone proves neither compatibility nor account binding.

Remaining W0 gates are unchanged: type-1 verification distinct from pong;
binding and capability evidence; fan-out without session conflict; independently
observed presence; and six-hour continuity with receiver-only gaps and REST
recovery receipts. The first probe does not pass these gates or begin B0/B1.
No polling suppression, business write or test message follows from reuse.
Stop the test receiver on conflict or failed WS auth, preserving healthy REST;
never call logout or revoke a working session to test recovery.

This note records authorization, not a live execution receipt. Historical Decision 288 and
reviews remain intact; [Decision 321](../../docs/decisions.md#decision-321-reuse-the-existing-fansly-rest-session-for-w0-2026-09-13)
and the [runbook](../../docs/runbooks/fansly-ws-protocol-check.md) record the
current choice and its boundaries.
