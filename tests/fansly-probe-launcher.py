"""Offline launcher checks. Docker and all subprocess execution are mocked."""

import argparse
import importlib.util
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import MagicMock, patch


source = Path(__file__).parents[1] / "scripts/fansly-ws/run-probe.py"
sys.path.insert(0, str(source.parent))
import launcher_inputs as inputs
import launcher_container as containers

spec = importlib.util.spec_from_file_location("fansly_probe_launcher", source)
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)


class LauncherTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        for name in ("bundle", "environment"):
            path = self.root / name
            path.write_bytes(b"private fixture")
            path.chmod(0o600)
        self.args = argparse.Namespace(
            bundle=str(self.root / "bundle"), environment=str(self.root / "environment"),
            image="sha256:" + "a" * 64, network="fixture-network", page="lilly-1",
            seconds=120, output=str(self.root / "new-report"), correlation_key_file=None, run_id="fixture-run",
        )
        self.lock_patch = patch.object(containers, "LOCK_DIRECTORY", self.root / "locks")
        self.lock_patch.start()
        self.addCleanup(self.lock_patch.stop)

    def correlation_key(self):
        path = self.root / "experiment.key"
        path.write_bytes(b"0123456789abcdef0123456789abcdef")
        path.chmod(0o600)
        self.args.correlation_key_file = str(path)
        return path

    def test_resource_limits_and_no_secret_arguments(self):
        command = inputs.container_command(self.args, "owned-fixture")
        for option in ("--memory=256m", "--memory-swap=256m", "--cpus=0.25",
                       "--pids-limit=64", "--read-only", "--cap-drop=ALL"):
            self.assertIn(option, command)
        self.assertNotIn("private fixture", " ".join(command))
        self.assertEqual(command[-4:], ["--page", "lilly-1", "--seconds", "120"])

    def test_timeout_kills_attach_and_only_its_own_container(self):
        process = MagicMock(returncode=-9)
        process.communicate.side_effect = subprocess.TimeoutExpired("fixture", 150)
        process.poll.return_value = None
        with patch.object(containers.subprocess, "Popen", return_value=process):
            with patch.object(containers, "remove_owned_container", return_value={"cleanupConfirmed": True, "cleanupExitCode": 0}) as cleanup:
                result = launcher.run(self.args)
        self.assertTrue(result["timedOut"])
        process.communicate.assert_called_once_with(input=b"private fixture", timeout=150)
        process.terminate.assert_called_once()
        self.assertEqual(result["container"], "hub-fansly-w0-lilly-1")
        cleanup.assert_called_once_with(result["container"], result["runId"])
        self.assertEqual((self.root / "new-report").stat().st_mode & 0o077, 0)

    def test_existing_output_never_starts_a_container(self):
        Path(self.args.output).mkdir()
        with patch.object(containers.subprocess, "Popen") as start:
            with self.assertRaises(FileExistsError):
                launcher.run(self.args)
        start.assert_not_called()

    def test_cancellation_runs_owned_container_cleanup(self):
        key = self.correlation_key()
        process = MagicMock(returncode=-9)
        process.communicate.side_effect = KeyboardInterrupt
        process.poll.return_value = None
        with patch.object(containers.subprocess, "Popen", return_value=process):
            with patch.object(containers, "remove_owned_container", return_value={"cleanupConfirmed": True, "cleanupExitCode": 0}) as cleanup:
                with self.assertRaises(KeyboardInterrupt):
                    launcher.run(self.args)
        process.terminate.assert_called_once()
        self.assertEqual(cleanup.call_args.args[0], "hub-fansly-w0-lilly-1")
        self.assertEqual(cleanup.call_args.args[1], self.args.run_id)
        self.assertTrue(key.exists())
        self.assertFalse((Path(self.args.output) / "correlation.key").exists())
        with self.assertRaises(KeyboardInterrupt):
            launcher.cancel(None, None)

    def test_key_mount_uses_a_private_stable_copy_and_removes_only_the_copy(self):
        key = self.correlation_key()
        original = key.read_bytes()
        owned_copy = Path(self.args.output) / "correlation.key"
        process = MagicMock(returncode=0)
        process.poll.return_value = 0

        def start(command, **_kwargs):
            mount = command[command.index("--mount") + 1]
            self.assertEqual(mount, inputs.correlation_key_mount(owned_copy))
            self.assertTrue(mount.endswith(",readonly"))
            self.assertEqual(command[-2:], ["--correlation-key-file", inputs.CORRELATION_KEY_TARGET])
            self.assertEqual(owned_copy.stat().st_mode & 0o777, 0o600)
            self.assertNotIn(original.decode(), " ".join(command))
            key.write_bytes(b"changed after validation")
            self.assertEqual(owned_copy.read_bytes(), original)
            return process

        with patch.object(containers.subprocess, "Popen", side_effect=start):
            with patch.object(containers, "remove_owned_container", return_value={"cleanupConfirmed": True, "cleanupExitCode": 0}):
                result = launcher.run(self.args)
        self.assertTrue(result["cleanupConfirmed"])
        self.assertFalse(owned_copy.exists())
        self.assertEqual(key.read_bytes(), b"changed after validation")

    def test_invalid_key_length_never_starts_docker(self):
        key = self.correlation_key()
        for length in (0, 31, 33):
            with self.subTest(length=length):
                key.write_bytes(b"x" * length)
                self.args.output = str(self.root / f"invalid-{length}")
                with patch.object(containers.subprocess, "Popen") as start:
                    with self.assertRaises(ValueError):
                        launcher.run(self.args)
                start.assert_not_called()

    def test_mount_syntax_in_output_path_never_starts_docker(self):
        self.correlation_key()
        for name in ("bad,readonly=false", 'bad"quote'):
            with self.subTest(name=name):
                self.args.output = str(self.root / name)
                with patch.object(containers.subprocess, "Popen") as start:
                    with self.assertRaisesRegex(ValueError, "invalid_correlation_key_mount"):
                        launcher.run(self.args)
                start.assert_not_called()
                self.assertFalse((Path(self.args.output) / "correlation.key").exists())

    def test_key_copy_never_replaces_or_removes_an_existing_file(self):
        key = self.correlation_key()
        target = self.root / "correlation.key"
        target.write_bytes(b"retain this file")
        with self.assertRaises(FileExistsError):
            with inputs.private_correlation_key(str(key), self.root):
                self.fail("Existing evidence must not be replaced")
        self.assertEqual(target.read_bytes(), b"retain this file")

    def test_attach_wait_failure_cannot_skip_container_removal(self):
        process = MagicMock(returncode=None)
        process.communicate.side_effect = subprocess.TimeoutExpired("fixture", 150)
        process.poll.return_value = None
        process.wait.side_effect = subprocess.TimeoutExpired("fixture", 5)
        with patch.object(containers.subprocess, "Popen", return_value=process):
            with patch.object(containers, "remove_owned_container", return_value={"cleanupConfirmed": True, "cleanupExitCode": 0}) as cleanup:
                result = launcher.run(self.args)
        self.assertFalse(result["attachStopConfirmed"])
        cleanup.assert_called_once()
        self.assertTrue(result["cleanupConfirmed"])

    def test_refuses_public_symlink_and_oversized_inputs(self):
        path = self.root / "bundle"
        path.chmod(0o644)
        with self.assertRaises(ValueError):
            inputs.private_input(str(path), 1024)
        path.chmod(0o600)
        with self.assertRaises(ValueError):
            inputs.private_input(str(path), 2)
        link = self.root / "symlink"
        link.symlink_to(path)
        with self.assertRaises(OSError):
            inputs.private_input(str(link), 1024)


if __name__ == "__main__":
    unittest.main()
