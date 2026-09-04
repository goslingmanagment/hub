# Desktop reads during a kernel outage

The desktop has no Direct-OFAPI mode or recoverable team-wide OFAPI credential
(Decisions #95 and #111). During a kernel outage it can read only its local
SQLite cache; nothing refreshes until Core returns. Sends remain Hub-custodied
and must not fall back to a direct client write.

## Break-glass procedure

1. Restore Core first: restart the affected container or use the guarded
   production deploy rollback when schema compatibility permits it.
2. If Core cannot be restored and an owner urgently needs a fresh OFAPI read,
   create a temporary key in the OnlyFansAPI owner dashboard and use it only in
   an owner-controlled curl/console session.
3. Never copy that key to a chatter machine, desktop settings, logs, or repo
   files.
4. Rotate/revoke the temporary key immediately after the incident.
5. Record the outage and any owner-side reads in the incident evidence. Do not
   describe cached client data as fresh.

There is no client flag, older binary, or version rollback that restores direct
read or Direct AI credentials. Reintroducing either path requires a new owner
decision and custody review.
