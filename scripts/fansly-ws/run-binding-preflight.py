#!/usr/bin/env python3
"""One approved Lilly-1 REST identity request; never opens a WebSocket."""

import argparse
import os
from pathlib import Path
import re
import signal

from launcher_inputs import cancel, private_input
from launcher_container import page_admission, run_container


def run(args) -> dict:
    bundle = private_input(args.bundle, 16 * 1024 * 1024)
    private_input(args.environment, 1024 * 1024)
    output = Path(args.output)
    output.mkdir(mode=0o700)
    args.binding_preflight = True
    with page_admission(args.page):
        return run_container(args, bundle, output, None, 45, "report.json")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    for option in ("bundle", "environment", "image", "network", "page", "output"):
        parser.add_argument("--" + option, required=True)
    args = parser.parse_args()
    if args.page != "lilly-1" or not re.fullmatch(r"sha256:[a-f0-9]{64}", args.image):
        parser.error("Use lilly-1 and the verified immutable runtime image ID")
    if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}", args.network):
        parser.error("Provide the verified Docker network name")
    os.umask(0o077)
    signal.signal(signal.SIGTERM, cancel)
    try:
        result = run(args)
    except (Exception, KeyboardInterrupt):
        print("Binding preflight stopped; no environment or provider error text was exported.")
        return 1
    print("Binding preflight finished; inspect the private identity and execution receipts.")
    return 0 if (result["exitCode"] == 0 and not result["timedOut"]
                 and result["cleanupConfirmed"] and result["outputSyncConfirmed"]) else 1


if __name__ == "__main__":
    raise SystemExit(main())
