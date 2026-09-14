"""Validate a bounded, complete metadata stream without retaining its frames."""

import hashlib
import json
import math
from pathlib import Path
import re


def phase_receipt(path: Path, phase: str) -> dict:
    continuous = phase == "continuous"
    max_bytes = (56 if continuous else 4) * 1024 * 1024
    max_records = 18_000 if continuous else 1_000
    duration_ms = (21_600 if continuous else 120) * 1000
    if path.stat().st_size > max_bytes:
        raise ValueError("observation_file_limit")
    digest = hashlib.sha256()
    first = None
    last = None
    records = 0
    frames = 0
    size = 0
    elapsed = -1
    with path.open("rb") as source:
        while line := source.readline(1024 * 1024 + 1):
            records += 1
            size += len(line)
            if records > max_records or size > max_bytes or len(line) > 1024 * 1024 or not line.endswith(b"\n"):
                raise ValueError("incomplete_observation_stream")
            digest.update(line)
            item = json.loads(line)
            clock = item.get("elapsedMs")
            if (item.get("ordinal") != records or not isinstance(clock, (int, float))
                    or not math.isfinite(clock) or clock < elapsed
                    or (last is not None and last.get("kind") == "finished")):
                raise ValueError("invalid_observation_sequence")
            if item.get("kind") == "generation_check" and item.get("state") != "unchanged":
                raise ValueError("generation_not_confirmed")
            elapsed = clock
            frames += item.get("kind") == "frame"
            first = item if first is None else first
            last = item
    if not first or not last or first.get("kind") != "started" or first.get("pageLabel") != "lilly-1":
        raise ValueError("missing_observation_identity")
    observation = last.get("observation", {})
    if (first.get("schemaVersion") != 1 or first.get("phase") != phase
            or last.get("kind") != "finished" or last.get("collectionCompleted") is not True
            or observation.get("stopReason") != "deadline" or observation.get("sessionFrameSeen") is not True
            or observation.get("sessionObservedMs", -1) < duration_ms
            or observation.get("framesReceived") != frames or observation.get("framesRetained") != frames
            or last.get("finalGeneration", {}).get("state") != "unchanged"):
        raise ValueError("incomplete_observation")
    generation = first.get("credentialRouteGeneration", "")
    fingerprint = first.get("correlationKeyFingerprint", "")
    if not re.fullmatch(r"[a-f0-9]{64}", generation) or not re.fullmatch(r"[a-f0-9]{64}", fingerprint):
        raise ValueError("invalid_observation_identity")
    return {"generation": generation, "keyFingerprint": fingerprint,
            "sha256": digest.hexdigest(), "bytes": size, "records": records,
            "observation": observation}
