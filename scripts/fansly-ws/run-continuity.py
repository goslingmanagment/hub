#!/usr/bin/env python3
"""Approved Lilly-1 observation: one six-hour connection, then 30s and 240s gaps.

This is an operator experiment, not a worker, automatic replay or stage acceptance.
REST polling continues independently. Presence and recovery need external evidence.
"""

import argparse
import json
import os
from pathlib import Path
import re
import signal
import time

from launcher_container import page_admission, run_container, utc_now
from launcher_inputs import cancel, private_correlation_key, private_input, private_binding_receipt
from continuity_receipt import phase_receipt

PHASES = (("continuous", 21_600, 0), ("after_short_gap", 120, 30), ("after_long_gap", 120, 240))


def run(args) -> dict:
    bundle = private_input(args.bundle, 16 * 1024 * 1024)
    private_input(args.environment, 1024 * 1024)
    output = Path(args.output)
    output.mkdir(mode=0o700)
    result = {"schemaVersion": 1, "evidenceKind": "w0_continuity_experiment", "pageLabel": "lilly-1",
              "startedAt": utc_now(), "collectionCompleted": False, "phases": [],
              "accountBinding": "unverified", "fanOut": "unverified", "presence": "unverified",
              "recovery": "external_evidence_required", "readerLatencyMeasured": False, "restRequests": 0}
    def save_report():
        temporary = output / "report.next"
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, "w") as report:
            report.write(json.dumps(result, indent=2) + "\n")
            report.flush()
            os.fsync(report.fileno())
        temporary.replace(output / "report.json")

    started = time.monotonic()
    save_report()
    try:
        with page_admission(args.page), private_correlation_key(args.correlation_key_file, output) as key, \
                private_binding_receipt(args.binding_receipt_file, output) as binding:
            if binding is None:
                raise ValueError("binding_receipt_required")
            args.binding_receipt_copy, expected = binding
            fingerprint = None
            for phase, seconds, gap in PHASES:
                # All time, including connection setup, cleanup and gaps, fits
                # inside this host deadline. There is no resume/retry after failure.
                remaining = 22_500 - (time.monotonic() - started)
                if remaining < seconds + gap + 60:
                    raise TimeoutError("experiment_deadline")
                if gap:
                    gap_started = time.monotonic()
                    gap_at = utc_now()
                    gap_receipt = {"kind": "receiver_gap", "startedAt": gap_at,
                                   "finishedAt": None, "requestedSeconds": gap,
                                   "confirmedAbsentMs": 0, "completed": False}
                    result["phases"].append(gap_receipt)
                    save_report()
                    try:
                        time.sleep(gap)
                        gap_receipt["completed"] = True
                    finally:
                        gap_receipt["finishedAt"] = utc_now()
                        gap_receipt["confirmedAbsentMs"] = (time.monotonic() - gap_started) * 1000
                        save_report()
                args.phase = phase
                directory = output / phase
                directory.mkdir(mode=0o700)
                execution = run_container(args, bundle, directory, key, seconds + 45, "receipts.jsonl")
                phase_result = {"phase": phase, "execution": execution}
                result["phases"].append(phase_result)
                if (execution["exitCode"] != 0 or execution["timedOut"]
                        or not execution["cleanupConfirmed"] or not execution["outputSyncConfirmed"]):
                    return result
                receipt = phase_receipt(directory / "receipts.jsonl", phase)
                phase_result["receipt"] = receipt
                if (receipt["generation"] != expected
                        or (fingerprint is not None and receipt["keyFingerprint"] != fingerprint)):
                    raise ValueError("changed_experiment_identity")
                fingerprint = receipt["keyFingerprint"]
                save_report()
            result["collectionCompleted"] = True
    finally:
        result["finishedAt"] = utc_now()
        result["elapsedMs"] = (time.monotonic() - started) * 1000
        save_report()
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    for option in ("bundle", "environment", "image", "network", "page", "output", "correlation-key-file", "binding-receipt-file"):
        parser.add_argument("--" + option, required=True)
    args = parser.parse_args()
    if args.page != "lilly-1" or not re.fullmatch(r"sha256:[a-f0-9]{64}", args.image):
        parser.error("Use lilly-1 and the verified immutable runtime image ID")
    if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}", args.network):
        parser.error("Provide the verified Docker network name")
    os.umask(0o077)
    signal.signal(signal.SIGTERM, cancel)
    signal.signal(signal.SIGALRM, cancel)
    signal.alarm(22_500)
    try:
        result = run(args)
    except (Exception, KeyboardInterrupt):
        print("Observation stopped; inspect private receipts. No provider error text was exported.")
        return 1
    finally:
        signal.alarm(0)
    print("Observation finished; binding, presence and recovery still require independent evidence.")
    return 0 if result["collectionCompleted"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
