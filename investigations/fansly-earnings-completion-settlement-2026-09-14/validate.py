import datetime
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time

name, *command = sys.argv[1:]
root = Path(__file__).resolve().parents[2]
evidence = Path(__file__).resolve().parent / 'evidence'
paths = [
    'apps/runtime/src/services/sync/fan-earnings.ts',
    'tests/fan-earnings-completion-settlement.integration.test.ts',
    'docs/decisions.md',
    'docs/runbooks/fansly-earnings-shadow.md',
]
def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()
hashes = {p: sha(root / p) for p in paths}
started = datetime.datetime.now(datetime.timezone.utc)
clock = time.monotonic()
log = evidence / f'{name}.log'
if log.exists():
    raise SystemExit(f'Refusing to replace existing receipt: {log}')
env = os.environ.copy()
env['ALLOW_MISSING_TEST_PREREQUISITES'] = '0'
with log.open('wb') as output:
    result = subprocess.run(command, cwd=root, env=env, stdout=output, stderr=subprocess.STDOUT)
receipt = {
    'command': command,
    'environment': {'ALLOW_MISSING_TEST_PREREQUISITES': '0'},
    'baseCommit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root).decode().strip(),
    'startedAt': started.isoformat(),
    'endedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'seconds': round(time.monotonic() - clock, 3),
    'exitCode': result.returncode,
    'sourceSha256': hashes,
    'sourceUnchanged': all(sha(root / p) == h for p, h in hashes.items()),
    'logSha256': sha(log),
}
(evidence / f'{name}.json').write_text(json.dumps(receipt, indent=2) + '\n')
print(json.dumps(receipt, indent=2))
print(log.read_text()[-9000:])
sys.exit(result.returncode)
