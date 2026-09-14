"""One host/page owner, including the intervals between planned connections."""

from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import json
import os
from pathlib import Path
import re
import resource
import signal
import stat
import subprocess
import tempfile
import time
import uuid

from launcher_inputs import container_command

LOCK_DIRECTORY = Path(tempfile.gettempdir()) / f"agency-hub-fansly-w0-{os.getuid()}"
OWNER_LABEL = "io.agency-hub.w0.run"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


@contextmanager
def page_admission(page: str):
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", page):
        raise ValueError("invalid_page")
    LOCK_DIRECTORY.mkdir(mode=0o700, exist_ok=True)
    directory = LOCK_DIRECTORY.lstat()
    if not stat.S_ISDIR(directory.st_mode) or directory.st_uid != os.getuid() or directory.st_mode & 0o077:
        raise ValueError("invalid_admission_directory")
    descriptor = os.open(LOCK_DIRECTORY / f"{page}.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ValueError("invalid_admission_file")
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally:
        # Keep the inode: unlinking permits two owners to lock different files.
        os.close(descriptor)


def remove_owned_container(name: str, run_id: str) -> dict:
    try:
        found = subprocess.run([
            "docker", "inspect", "--format",
            '{{.Id}} {{index .Config.Labels "' + OWNER_LABEL + '"}}', name,
        ], capture_output=True, timeout=5)
        if found.returncode != 0:
            absent = b"No such object: " + name.encode() in found.stderr
            return {"cleanupConfirmed": absent, "cleanupExitCode": found.returncode}
        fields = found.stdout.decode("ascii").strip().split()
        if len(fields) != 2 or not re.fullmatch(r"[a-f0-9]{64}", fields[0]) or fields[1] != run_id:
            return {"cleanupConfirmed": False, "cleanupExitCode": None}
        # The immutable ID prevents removal of a replacement with the same name.
        removed = subprocess.run(["docker", "rm", "--force", fields[0]], capture_output=True, timeout=10)
        absent = b"No such container: " + fields[0].encode() in removed.stderr
        return {"cleanupConfirmed": removed.returncode == 0 or absent, "cleanupExitCode": removed.returncode}
    except (OSError, UnicodeError, subprocess.TimeoutExpired):
        return {"cleanupConfirmed": False, "cleanupExitCode": None}


def limit_attach_files():
    # Bounds each regular stdout/stderr file even if the entrypoint misbehaves.
    # Docker daemon logging is separately disabled in container_command.
    resource.setrlimit(resource.RLIMIT_FSIZE, (64 * 1024 * 1024, 64 * 1024 * 1024))


@contextmanager
def finish_cleanup():
    # A second Ctrl-C must not interrupt the already bounded owned cleanup.
    signals = (signal.SIGINT, signal.SIGTERM, signal.SIGALRM)
    previous = {item: signal.signal(item, signal.SIG_IGN) for item in signals}
    try:
        yield
    finally:
        for item, handler in previous.items():
            signal.signal(item, handler)


def run_container(args, bundle: bytes, output: Path, key_path: Path | None, timeout: int, filename: str) -> dict:
    args.run_id = uuid.uuid4().hex
    # Atomic Docker name admission also refuses a container orphaned by SIGKILL.
    # Both short and continuity launchers use exactly this name and host lock.
    name = "hub-fansly-w0-" + args.page
    command = container_command(args, name, key_path)
    result = {"container": name, "runId": args.run_id, "startedAt": utc_now(),
              "exitCode": None, "timedOut": False}
    process = None
    try:
        with (output / filename).open("xb") as report, (output / "stderr.log").open("xb") as errors:
            process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=report, stderr=errors,
                                       preexec_fn=limit_attach_files)
            try:
                process.communicate(input=bundle, timeout=timeout)
            except subprocess.TimeoutExpired:
                result["timedOut"] = True
    finally:
        with finish_cleanup():
            try:
                if process is not None and process.poll() is None:
                    # Give Node a chance to finish its sanitized receipt, then the
                    # host deadline/owned removal covers an unresponsive process.
                    process.terminate()
                    try:
                        process.wait(timeout=3)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait(timeout=5)
                result["attachStopConfirmed"] = True
            except (OSError, subprocess.TimeoutExpired):
                result["attachStopConfirmed"] = False
            if process is not None:
                result["exitCode"] = process.returncode
            result.update(remove_owned_container(name, args.run_id))
            try:
                for path in (output / filename, output / "stderr.log"):
                    with path.open("rb") as captured:
                        os.fsync(captured.fileno())
                result["outputSyncConfirmed"] = True
            except OSError:
                result["outputSyncConfirmed"] = False
            result["finishedAt"] = utc_now()
            result["finishedMonotonic"] = time.monotonic()
            (output / "execution.json").write_text(json.dumps(result, indent=2) + "\n")
    return result
