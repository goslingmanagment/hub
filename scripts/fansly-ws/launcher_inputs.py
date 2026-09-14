"""Shared private inputs and resource-limited W0 container command."""

from contextlib import contextmanager
import os
from pathlib import Path
import stat

CORRELATION_KEY_TARGET = "/run/fansly-w0-correlation.key"


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


def correlation_key_mount(path: Path) -> str:
    source = str(path)
    # Docker parses --mount as CSV; do not let a filename add mount options.
    if not path.is_absolute() or any(char in source for char in ',"\r\n\0'):
        raise ValueError("invalid_correlation_key_mount")
    return f"type=bind,source={source},target={CORRELATION_KEY_TARGET},readonly"


@contextmanager
def private_correlation_key(path: str | None, directory: Path):
    if path is None:
        yield None
        return
    key = private_input(path, 32)
    if len(key) != 32:
        raise ValueError("invalid_correlation_key")
    owned_copy = (directory / "correlation.key").absolute()
    correlation_key_mount(owned_copy)
    descriptor = os.open(owned_copy, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "wb") as output:
            output.write(key)
        # Bind the validated copy, so later source-file changes cannot substitute
        # another key between validation and the container's file read.
        yield owned_copy
    finally:
        owned_copy.unlink(missing_ok=True)


def container_command(args, name: str, key_path: Path | None = None) -> list[str]:
    command = [
        "docker", "run", "--rm", "--name", name,
        "--label", "io.agency-hub.w0.run=" + args.run_id,
        "--memory=256m", "--memory-swap=256m", "--cpus=0.25",
        "--pids-limit=64", "--read-only", "--cap-drop=ALL", "--log-driver=none",
        "--security-opt=no-new-privileges", "--network", args.network,
        "--env-file", args.environment, "--workdir=/app/apps/runtime",
    ]
    if key_path is not None:
        command.extend(["--mount", correlation_key_mount(key_path)])
    command.extend([
        "--interactive", "--entrypoint=node", args.image,
        "--max-old-space-size=128", "--input-type=module", "-",
    ])
    command.extend(["--page", args.page])
    phase = getattr(args, "phase", None)
    if phase is None:
        command.extend(["--seconds", str(args.seconds)])
    else:
        command.extend(["--phase", phase])
    if key_path is not None:
        command.extend(["--correlation-key-file", CORRELATION_KEY_TARGET])
    if getattr(args, "expected_generation", None) is not None:
        command.extend(["--expected-generation", args.expected_generation])
    return command
