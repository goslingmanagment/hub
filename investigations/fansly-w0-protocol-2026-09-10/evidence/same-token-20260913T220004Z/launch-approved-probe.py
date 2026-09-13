#!/usr/bin/env python3
"""One approved Lilly-1 W0 run; executes only on the trusted Hub host."""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys

IMAGE = "sha256:c443947a356972cd2833c10a4e728fe1890e92e76a77fc2328f00ebca0af5c85"
NETWORK = "agency-hub_default"
ENV_NAMES = {
    "DATABASE_URL", "APP_ENCRYPTION_KEY",
    "APP_ENCRYPTION_KEY_RING", "APP_ENCRYPTION_KEY_VERSION",
}


def cancel(_signum, _frame):
    raise KeyboardInterrupt


def main():
    os.umask(0o077)
    directory = Path(__file__).resolve().parent
    inspected = subprocess.run(
        ["docker", "inspect", "agency-hub-api-1"],
        check=True, capture_output=True, timeout=10,
    )
    api = json.loads(inspected.stdout)[0]
    if (api["Image"] != IMAGE or api["State"]["Health"]["Status"] != "healthy"
            or NETWORK not in api["NetworkSettings"]["Networks"]):
        raise ValueError("runtime_preflight_changed")
    selected = {}
    for entry in api["Config"]["Env"]:
        name, separator, value = entry.partition("=")
        if separator and name in ENV_NAMES:
            if "\n" in value or "\r" in value:
                raise ValueError("invalid_environment_value")
            selected[name] = value
    if not all(selected.get(key) for key in ["DATABASE_URL", "APP_ENCRYPTION_KEY"]):
        raise ValueError("runtime_configuration_missing")
    environment = directory / "probe.env"
    created_environment = False
    process = None
    try:
        with environment.open("x") as output:
            created_environment = True
            output.write("NODE_ENV=production\nTZ=UTC\n")
            output.writelines(f"{key}={value}\n" for key, value in sorted(selected.items()))
        command = [
            sys.executable, str(directory / "run-probe.py"),
            "--bundle", str(directory / "probe.mjs"),
            "--environment", str(environment), "--image", IMAGE,
            "--network", NETWORK, "--page", "lilly-1", "--seconds", "120",
            "--output", str(directory / "live"),
        ]
        process = subprocess.Popen(command)
        return process.wait(timeout=180)
    finally:
        try:
            if process is not None and process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=25)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
        finally:
            if created_environment:
                environment.unlink(missing_ok=True)


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, cancel)
    try:
        raise SystemExit(main())
    except (Exception, KeyboardInterrupt):
        print("Approved probe stopped; configuration and error details remain private.")
        raise SystemExit(1)
