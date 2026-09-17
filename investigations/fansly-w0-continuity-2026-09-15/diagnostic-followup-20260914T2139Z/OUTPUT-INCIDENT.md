# Native UI output incident

Provenance: **operator-reported by root**, recorded at 2026-09-14T21:47:07.937148+00:00.
This note uses only root's incident message. It is not an independent inspection
of the browser, conversation logs or the absence of other disclosures.

While reading a native Received `t=1` Raw frame, the UI formatter emitted a
nested token into a tool response. Its redaction removed text only after
`Value:`, while this accessibility text-entry placed the payload immediately
after `(settable)`. Root reported the mistake to the user.

At the time of that report, no new Hub receiver, remote staging or correlation
key had been created. The session and proxy had not been changed.

Root is correcting the output path to serialize only the allowlisted result of
the pure `diagnoseReceivedRecord` function, without accessibility strings or raw
payloads. This note records the correction in progress; it does not certify its
implementation or claim that the earlier tool response was removed.

The token value is intentionally absent from this packet. This note did not
extract, repeat or search for it, read browser/session logs, or modify source.
Local reports must use the approved redactor. The follow-up review will check
that the incident remains explicitly disclosed.
