#!/usr/bin/env python3
"""Run an approved W0 probe in a disposable, resource-limited container.

The private environment file must contain the existing runtime keys and
DATABASE_URL. Database access stays in READ ONLY transactions. It must never contain an exported provider token.
"""

import argparse
import json
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import uuid


def cancel(_signum, _frame):
    raise KeyboardInterrupt


def private_input(path: str, limit: int) -> bytes:
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_size > limit:
            raise ValueError("invalid_private_input")
        with os.fdopen(descriptor, "rb", closefd=False) as source:
            content = source.read(limit + 1)
        if len(content) > limit:
            raise ValueError("invalid_private_input")
        return content
    finally:
        os.close(descriptor)


def container_command(args, name: str) -> list[str]:
    return [
        "docker", "run", "--rm", "--name", name,
        "--memory=256m", "--memory-swap=256m", "--cpus=0.25",
        "--pids-limit=64", "--read-only", "--cap-drop=ALL",
        "--security-opt=no-new-privileges", "--network", args.network,
        "--env-file", args.environment, "--workdir=/app/apps/runtime",
        "--interactive", "--entrypoint=node", args.image,
        "--max-old-space-size=128", "--input-type=module", "-",
        "--page", args.page, "--seconds", str(args.seconds),
    ]


def run(args) -> dict:
    bundle = private_input(args.bundle, 16 * 1024 * 1024)
    # Check access/mode without parsing or printing configuration secrets.
    private_input(args.environment, 1024 * 1024)
    name = "hub-fansly-w0-" + uuid.uuid4().hex
    command = container_command(args, name)
    result = {"container": name, "exitCode": None, "timedOut": False}
    # An exclusive, private output directory prevents accidental overwrite.
    output = Path(args.output)
    output.mkdir(mode=0o700)
    process = None
    try:
        with (output / "report.json").open("xb") as report:
            with (output / "stderr.log").open("xb") as errors:
                process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=report, stderr=errors)
                try:
                    process.communicate(input=bundle, timeout=150)
                except subprocess.TimeoutExpired:
                    result["timedOut"] = True
                result["exitCode"] = process.returncode
    finally:
        try:
            if process is not None and process.poll() is None:
                process.kill()
                process.wait(timeout=5)
            result["attachStopConfirmed"] = True
        except (OSError, subprocess.TimeoutExpired):
            result["attachStopConfirmed"] = False
        if process is not None:
            result["exitCode"] = process.returncode
        # Killing docker attach alone does not kill the container. Remove only
        # this invocation's UUID-named container, including on keyboard interrupt.
        try:
            cleanup = subprocess.run(
                ["docker", "rm", "--force", name], capture_output=True, timeout=10,
            )
            result["cleanupExitCode"] = cleanup.returncode
            result["cleanupConfirmed"] = cleanup.returncode == 0 or (
                b"No such container: " + name.encode() in cleanup.stderr
            )
        except subprocess.TimeoutExpired:
            result["cleanupExitCode"] = None
            result["cleanupConfirmed"] = False
        (output / "execution.json").write_text(json.dumps(result, indent=2) + "\n")
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    for option in ("bundle", "environment", "image", "network", "page", "output"):
        parser.add_argument("--" + option, required=True)
    parser.add_argument("--seconds", type=int, default=120)
    args = parser.parse_args()
    if not re.fullmatch(r"sha256:[a-f0-9]{64}", args.image):
        parser.error("Use the verified runtime image ID, not a mutable tag")
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", args.page) or not 5 <= args.seconds <= 120:
        parser.error("Provide one page and 5 through 120 seconds")
    if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}", args.network):
        parser.error("Provide the verified Docker network name")
    os.umask(0o077)
    signal.signal(signal.SIGTERM, cancel)
    try:
        result = run(args)
    except (Exception, KeyboardInterrupt):
        print("Probe launch failed; no environment or provider error text was exported.")
        return 1
    print("Probe finished; inspect the private report and execution receipt.")
    return 0 if result["exitCode"] == 0 and not result["timedOut"] and result["cleanupConfirmed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
