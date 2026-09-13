"""Offline launcher checks. Docker and all subprocess execution are mocked."""

import argparse
import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import MagicMock, patch


source = Path(__file__).parents[1] / "scripts/fansly-ws/run-probe.py"
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
            seconds=120, output=str(self.root / "new-report"),
        )

    def test_resource_limits_and_no_secret_arguments(self):
        command = launcher.container_command(self.args, "owned-fixture")
        for option in ("--memory=256m", "--memory-swap=256m", "--cpus=0.25",
                       "--pids-limit=64", "--read-only", "--cap-drop=ALL"):
            self.assertIn(option, command)
        self.assertNotIn("private fixture", " ".join(command))
        self.assertEqual(command[-4:], ["--page", "lilly-1", "--seconds", "120"])

    def test_timeout_kills_attach_and_only_its_own_container(self):
        process = MagicMock(returncode=-9)
        process.communicate.side_effect = subprocess.TimeoutExpired("fixture", 150)
        process.poll.return_value = None
        with patch.object(launcher.subprocess, "Popen", return_value=process):
            with patch.object(launcher.subprocess, "run", return_value=MagicMock(returncode=0)) as cleanup:
                result = launcher.run(self.args)
        self.assertTrue(result["timedOut"])
        process.communicate.assert_called_once_with(input=b"private fixture", timeout=150)
        process.kill.assert_called_once()
        self.assertRegex(result["container"], r"^hub-fansly-w0-[a-f0-9]{32}$")
        cleanup.assert_called_once_with(
            ["docker", "rm", "--force", result["container"]], capture_output=True, timeout=10,
        )
        self.assertEqual((self.root / "new-report").stat().st_mode & 0o077, 0)

    def test_existing_output_never_starts_a_container(self):
        Path(self.args.output).mkdir()
        with patch.object(launcher.subprocess, "Popen") as start:
            with self.assertRaises(FileExistsError):
                launcher.run(self.args)
        start.assert_not_called()

    def test_cancellation_runs_owned_container_cleanup(self):
        process = MagicMock(returncode=-9)
        process.communicate.side_effect = KeyboardInterrupt
        process.poll.return_value = None
        with patch.object(launcher.subprocess, "Popen", return_value=process):
            with patch.object(launcher.subprocess, "run", return_value=MagicMock(returncode=0)) as cleanup:
                with self.assertRaises(KeyboardInterrupt):
                    launcher.run(self.args)
        process.kill.assert_called_once()
        self.assertEqual(cleanup.call_args.args[0][:3], ["docker", "rm", "--force"])
        self.assertRegex(cleanup.call_args.args[0][3], r"^hub-fansly-w0-[a-f0-9]{32}$")
        with self.assertRaises(KeyboardInterrupt):
            launcher.cancel(None, None)

    def test_attach_wait_failure_cannot_skip_container_removal(self):
        process = MagicMock(returncode=None)
        process.communicate.side_effect = subprocess.TimeoutExpired("fixture", 150)
        process.poll.return_value = None
        process.wait.side_effect = subprocess.TimeoutExpired("fixture", 5)
        with patch.object(launcher.subprocess, "Popen", return_value=process):
            with patch.object(launcher.subprocess, "run", return_value=MagicMock(returncode=0)) as cleanup:
                result = launcher.run(self.args)
        self.assertFalse(result["attachStopConfirmed"])
        cleanup.assert_called_once()
        self.assertTrue(result["cleanupConfirmed"])

    def test_refuses_public_symlink_and_oversized_inputs(self):
        path = self.root / "bundle"
        path.chmod(0o644)
        with self.assertRaises(ValueError):
            launcher.private_input(str(path), 1024)
        path.chmod(0o600)
        with self.assertRaises(ValueError):
            launcher.private_input(str(path), 2)
        link = self.root / "symlink"
        link.symlink_to(path)
        with self.assertRaises(OSError):
            launcher.private_input(str(link), 1024)


if __name__ == "__main__":
    unittest.main()
