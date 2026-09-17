# Historical runner and staging command evidence

[runner-command-reference.json](runner-command-reference.json) preserves source paths, hashes, the first successful probe's host argument template, and exact later retained staging/runner argument vectors. **None was executed by this preparation.**

The first successful short attempt on Sep13 used the retained `launch-approved-probe.py` in `/Users/dmitriy/.codex/worktrees/hub-fansly-w0-protocol/investigations/fansly-w0-protocol-2026-09-10/evidence/same-token-20260913T220004Z/`. Its exact runner construction is at lines 50–56:

```python
command = [
    sys.executable, str(directory / "run-probe.py"),
    "--bundle", str(directory / "probe.mjs"),
    "--environment", str(environment), "--image", IMAGE,
    "--network", NETWORK, "--page", "lilly-1", "--seconds", "120",
    "--output", str(directory / "live"),
]
```

The retained upload receipt identifies directory `/tmp/hub-fansly-w0-20260913T222801Z-7d99ce14` and bundle SHA-256 `5b15c3d107641ac005f23411f38af4db3217a5779edda22de9010944a27fedae`. The wrapper identifies image `sha256:c443947a356972cd2833c10a4e728fe1890e92e76a77fc2328f00ebca0af5c85`, network `agency-hub_default`, and the run-local `probe.env`. The exact host Python executable path and outer SSH/SCP/mkdir argument vectors were **not retained** for that successful attempt. A reconstructed shell command would not be an execution receipt.

The later Sep14 `paired-preparation-20260914T202652Z/staging.json` does retain exact SSH/SCP/mkdir/checksum commands and successful exit codes. These are copied verbatim as records in the JSON reference, followed by its exact `run-probe.py` invocation with binding receipt and correlation-key options. That staging succeeded; its subsequent receiver attempt failed with `transport_error`. It must not be described as a successful WS run.

For the future follow-up, root uses the current checked short bundle/launcher hashes from `NEXT-PROBE.md`, a new run directory/key and current verified image/network. Historical bundle/image/key/output paths above are evidence only. This reference adds no environment extraction, new REST preflight, staging action or receiver attempt.
