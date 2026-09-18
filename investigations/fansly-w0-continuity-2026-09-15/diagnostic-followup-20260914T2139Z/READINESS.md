# Observed production readiness — 2026-09-14 21:41 UTC

One read-only SSH collection completed with exit `0`, empty stderr. Local execution window: `21:41:28.014576Z–21:41:30.140186Z`; the remote collector recorded `observedAt: 21:41:30.186370Z`. These are the two recorded clock sources, not a derived ordering guarantee. Directory date is Sep15 in Europe/Moscow.

| Observed item | Result |
| --- | --- |
| API / worker / scheduler | All running and `healthy`; restart counts `0`; `OOMKilled: false` |
| Immutable image, all three roles | `sha256:ca60d6371efa39d256c929eec025f05d78edf97dba21076b82f58b1f5f8cc01d` |
| Image and role source-revision label | `ac92197ba976` |
| Existing network | `agency-hub_default`, ID `14c4fbf6cffa5ed30c88376189a5d3956dce50e9ab7b5b693de23b88aa46a531`; all three roles attached |
| Network metadata | Driver `bridge`, scope `local`, internal `false`, attachable `false`; Compose project `agency-hub`, network `default` |
| Existing W0 containers | `docker ps -a --filter name=hub-fansly-w0` returned no rows |
| Filesystem at `/opt/agency-hub` | `/dev/sda1`, 79% used; available `17,070,376 KiB` (about 16.28 GiB) |
| Memory | Available `3,965,153,280` bytes (about 3.69 GiB), total `8,305,319,936` bytes |
| Swap | Used `181,780,480` bytes; available `891,957,248` bytes |

Evidence: [host.stdout](host.stdout), [host-execution.json](host-execution.json), [host.stderr](host.stderr), [collector](read-host.py). The collector is a narrowed derivative of the retained Sep14 live-preflight collector: selected State fields and fixed revision/service labels only, selected network/image metadata, Docker ps, df and free. It excludes environment access, proxy/configuration values, full inspection objects and health log contents. It ran via SSH stdin; no remote script or staging directory was created. No container was started, changed or stopped; no Fansly request was made.

This snapshot shows no reported container health failure or restart and no W0 container at collection time. It does not reserve host/page admission or establish resource trends. Root must perform final admission and any needed freshness check at the actual start; a container can appear after this read.

Provider REST health remains **unverified**. The earlier authorized envelope read returned `503 agent_plane_disabled`; healthy roles do not replace provider outcomes. Credential/route generation, observer/native capture readiness, CI/merge and actual diagnostic launch remain root-owned checks outside this collection. Nothing here establishes a new socket connection or a W0 gate pass.
