"""Run one explicitly selected local validation and retain its exact receipt."""
from pathlib import Path
import datetime as dt
import gzip
import hashlib
import json
import os
import subprocess
import sys
import time

packet = Path(__file__).resolve().parent
workspace = packet.parents[1]
commands = {
    "check": ["pnpm", "check"],
    "postgres": ["pnpm", "exec", "vitest", "run", "--no-file-parallelism",
                 "tests/voice-notes-service.integration.test.ts",
                 "tests/voice-notes.repository.integration.test.ts"],
}
name = sys.argv[1]
command = commands[name]
manifest = json.loads((packet / "source-manifest.json").read_text())

def fingerprints():
    return {path: hashlib.sha256((workspace / path).read_bytes()).hexdigest()
            for path in manifest["files"]}

before = fingerprints()
assert before == manifest["files"], "Candidate source differs from review manifest"
environment = {"ALLOW_MISSING_TEST_PREREQUISITES": "0",
               "NODE_OPTIONS": "--max-old-space-size=4096"}
started = dt.datetime.now(dt.timezone.utc)
tick = time.monotonic()
result = subprocess.run(command, cwd=workspace, env={**os.environ, **environment},
                        stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
raw = result.stdout
(packet / f"{name}.log.gz").write_bytes(gzip.compress(raw, mtime=0))
after = fingerprints()
receipt = {"command": command, "cwd": str(workspace),
           "environmentOverrides": environment,
           "startedAt": started.isoformat(),
           "completedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
           "durationSeconds": round(time.monotonic() - tick, 3),
           "exitCode": result.returncode, "sourceBefore": before, "sourceAfter": after,
           "sourceUnchanged": before == after,
           "rawSha256": hashlib.sha256(raw).hexdigest(), "log": f"{name}.log.gz"}
(packet / f"{name}.json").write_text(json.dumps(receipt, indent=2) + "\n")
print(json.dumps(receipt, indent=2))
print(raw.decode(errors="replace")[-2500:])
assert before == after, "Source changed during validation"
raise SystemExit(result.returncode)
