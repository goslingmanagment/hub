#!/usr/bin/env python3
"""Run one approved 5-120 second W0 probe; never a continuity experiment."""

import argparse
import os
from pathlib import Path
import re
import signal

from launcher_inputs import cancel, private_input, private_correlation_key, private_binding_receipt
from launcher_container import page_admission, run_container


def run(args) -> dict:
    bundle = private_input(args.bundle, 16 * 1024 * 1024)
    private_input(args.environment, 1024 * 1024)
    output = Path(args.output)
    output.mkdir(mode=0o700)
    with page_admission(args.page):
        with private_correlation_key(args.correlation_key_file, output) as key_path, \
                private_binding_receipt(getattr(args, "binding_receipt_file", None), output) as binding:
            args.binding_receipt_copy = binding[0] if binding else None
            return run_container(args, bundle, output, key_path, 150, "report.json")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    for option in ("bundle", "environment", "image", "network", "page", "output"):
        parser.add_argument("--" + option, required=True)
    parser.add_argument("--seconds", type=int, default=120)
    parser.add_argument("--correlation-key-file")
    parser.add_argument("--binding-receipt-file")
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
    return 0 if (result["exitCode"] == 0 and not result["timedOut"]
                 and result["cleanupConfirmed"] and result["outputSyncConfirmed"]) else 1


if __name__ == "__main__":
    raise SystemExit(main())
