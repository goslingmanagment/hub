"""Offline only: real private files/host admission, mocked Docker and six-hour clock."""

import argparse
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

scripts = Path(__file__).parents[1] / "scripts/fansly-ws"
sys.path.insert(0, str(scripts))
import launcher_container as containers
from launcher_inputs import container_command

spec = importlib.util.spec_from_file_location("continuity", scripts / "run-continuity.py")
continuity = importlib.util.module_from_spec(spec)
spec.loader.exec_module(continuity)


class ContinuityLauncherTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        for name, content in (("bundle", b"fixture"), ("environment", b"private"), ("key", b"k" * 32)):
            target = self.root / name
            target.write_bytes(content)
            target.chmod(0o600)
        self.args = argparse.Namespace(
            page="lilly-1", bundle=str(self.root / "bundle"), environment=str(self.root / "environment"),
            correlation_key_file=str(self.root / "key"), image="sha256:" + "a" * 64,
            network="fixture", output=str(self.root / "output"), run_id="fixture-run",
            binding_receipt_file=str(self.root / "binding.json"),
        )
        binding = {"evidenceKind": "w0_rest_identity_preflight", "identityMatched": True,
                   "credentialRouteGeneration": "a" * 64}
        (self.root / "binding.json").write_text(json.dumps(binding))
        (self.root / "binding.json").chmod(0o600)
        lock = patch.object(containers, "LOCK_DIRECTORY", self.root / "locks")
        lock.start()
        self.addCleanup(lock.stop)
        self.clock = 0
        self.phases = []

    def sleep(self, seconds):
        self.clock += seconds

    def phase(self, args, bundle, output, key, timeout, filename):
        self.assertEqual(bundle, b"fixture")
        self.assertEqual(key.read_bytes(), b"k" * 32)
        binding = json.loads(args.binding_receipt_copy.read_text())
        self.phases.append((args.phase, binding["credentialRouteGeneration"]))
        seconds = 21_600 if args.phase == "continuous" else 120
        self.assertEqual(timeout, seconds + 45)
        self.clock += seconds
        first = {"kind": "started", "schemaVersion": 1, "ordinal": 1, "elapsedMs": 0,
                 "pageLabel": "lilly-1", "phase": args.phase,
                 "credentialRouteGeneration": "a" * 64, "correlationKeyFingerprint": "b" * 64}
        last = {"kind": "finished", "ordinal": 2, "elapsedMs": seconds * 1000,
                "collectionCompleted": True, "finalGeneration": {"state": "unchanged"},
                "observation": {"sessionObservedMs": seconds * 1000, "stopReason": "deadline",
                                "sessionFrameSeen": True, "framesReceived": 0, "framesRetained": 0}}
        (output / filename).write_text(json.dumps(first) + "\n" + json.dumps(last) + "\n")
        return {"exitCode": 0, "timedOut": False, "cleanupConfirmed": True, "outputSyncConfirmed": True}

    def run_observation(self, runner=None):
        with patch.object(continuity.time, "monotonic", side_effect=lambda: self.clock):
            with patch.object(continuity.time, "sleep", side_effect=self.sleep):
                with patch.object(continuity, "run_container", side_effect=runner or self.phase):
                    return continuity.run(self.args)

    def test_one_six_hour_phase_then_only_two_planned_reconnections(self):
        result = self.run_observation()
        self.assertTrue(result["collectionCompleted"])
        self.assertEqual(self.phases, [("continuous", "a" * 64), ("after_short_gap", "a" * 64), ("after_long_gap", "a" * 64)])
        gaps = [item for item in result["phases"] if item.get("kind") == "receiver_gap"]
        self.assertEqual([item["confirmedAbsentMs"] for item in gaps], [30_000, 240_000])
        self.assertEqual(result["elapsedMs"], (21_600 + 120 + 120 + 30 + 240) * 1000)
        self.assertEqual(result["presence"], "unverified")
        self.assertEqual(result["recovery"], "external_evidence_required")
        self.assertFalse((self.root / "output/correlation.key").exists())
        self.assertTrue((self.root / "key").exists())
        self.assertFalse((self.root / "output/binding-receipt.json").exists())
        self.assertTrue((self.root / "binding.json").exists())

    def test_failed_cleanup_never_starts_a_gap_or_another_receiver(self):
        def failed(*args):
            receipt = self.phase(*args)
            return {**receipt, "cleanupConfirmed": False}
        result = self.run_observation(failed)
        self.assertFalse(result["collectionCompleted"])
        self.assertEqual(len(self.phases), 1)
        self.assertEqual(len(result["phases"]), 1)

    def test_cancel_during_gap_retains_partial_report_and_removes_only_private_key_copy(self):
        def cancel(_seconds):
            raise KeyboardInterrupt
        with patch.object(continuity.time, "monotonic", side_effect=lambda: self.clock):
            with patch.object(continuity.time, "sleep", side_effect=cancel):
                with patch.object(continuity, "run_container", side_effect=self.phase):
                    with self.assertRaises(KeyboardInterrupt):
                        continuity.run(self.args)
        report = json.loads((self.root / "output/report.json").read_text())
        self.assertFalse(report["collectionCompleted"])
        self.assertEqual(len(self.phases), 1)
        self.assertFalse((self.root / "output/correlation.key").exists())
        self.assertEqual(report["phases"][-1]["kind"], "receiver_gap")
        self.assertFalse(report["phases"][-1]["completed"])

    def test_shared_host_admission_refuses_same_page_and_releases_after_cancel(self):
        with containers.page_admission("lilly-1"):
            with self.assertRaises(BlockingIOError):
                with containers.page_admission("lilly-1"):
                    self.fail("Second owner")
            with containers.page_admission("ari-1"):
                pass
        with containers.page_admission("lilly-1"):
            pass

    def test_incomplete_or_inconsistent_receipts_cannot_start_the_next_phase(self):
        for defect in ("ordinal", "missing_final", "short_duration", "changed_generation"):
            with self.subTest(defect=defect):
                self.args.output = str(self.root / defect)
                self.phases = []
                self.clock = 0

                def corrupt(args, bundle, output, key, timeout, filename):
                    execution = self.phase(args, bundle, output, key, timeout, filename)
                    path = output / filename
                    records = [json.loads(line) for line in path.read_text().splitlines()]
                    if defect == "ordinal":
                        records[-1]["ordinal"] = 1
                    if defect == "missing_final":
                        records.pop()
                    if defect == "short_duration":
                        records[-1]["observation"]["sessionObservedMs"] = 120_000
                    if defect == "changed_generation":
                        records[-1]["finalGeneration"]["state"] = "changed"
                    path.write_text("".join(json.dumps(item) + "\n" for item in records))
                    return execution

                with self.assertRaises(ValueError):
                    self.run_observation(corrupt)
                self.assertEqual(len(self.phases), 1)
                report = json.loads((Path(self.args.output) / "report.json").read_text())
                self.assertFalse(report["collectionCompleted"])

    def test_short_and_long_commands_use_same_name_admission_and_no_provider_secret_argument(self):
        self.args.seconds = 120
        short = container_command(self.args, "hub-fansly-w0-lilly-1")
        self.args.phase = "continuous"
        long = container_command(self.args, "hub-fansly-w0-lilly-1", self.root / "key")
        for command in (short, long):
            self.assertEqual(command[command.index("--name") + 1], "hub-fansly-w0-lilly-1")
            self.assertIn("--log-driver=none", command)
            self.assertIn("--memory=256m", command)
            self.assertNotIn("private", command)
        self.assertIn("--phase", long)
        self.assertNotIn("--seconds", long)

    def test_cleanup_never_removes_an_existing_container_owned_by_another_run(self):
        foreign = subprocess.CompletedProcess([], 0, stdout=("a" * 64 + " foreign").encode(), stderr=b"")
        with patch.object(containers.subprocess, "run", return_value=foreign) as docker:
            result = containers.remove_owned_container("hub-fansly-w0-lilly-1", "owned")
        self.assertFalse(result["cleanupConfirmed"])
        self.assertEqual(docker.call_count, 1)

    def test_cleanup_accepts_docker_absence_forms_including_live_lowercase(self):
        for stderr in (
            b"error: no such object: hub-fansly-w0-lilly-1\n",
            b"Error: No such object: hub-fansly-w0-lilly-1\n",
            b"Error response from daemon: No such container: hub-fansly-w0-lilly-1\r\n",
            b"No such object: hub-fansly-w0-lilly-1",
        ):
            with self.subTest(stderr=stderr):
                absent = subprocess.CompletedProcess([], 1, stdout=b"", stderr=stderr)
                with patch.object(containers.subprocess, "run", return_value=absent) as docker:
                    result = containers.remove_owned_container("hub-fansly-w0-lilly-1", "owned")
                self.assertEqual(result, {"cleanupConfirmed": True, "cleanupExitCode": 1})
                self.assertEqual(docker.call_count, 1)

    def test_cleanup_refuses_other_identifiers_and_ambiguous_or_daemon_errors(self):
        for stderr in (
            b"error: no such object: hub-fansly-w0-lilly-10\n",
            b"error: no such object: hub-fansly-w0-lilly-1-other\n",
            b"error: no such object: other-hub-fansly-w0-lilly-1\n",
            b"error: no such object: hub-fansly-w0-lilly\n",
            b"error: no such object: HUB-FANSLY-W0-LILLY-1\n",
            b"error: no such object: hub-fansly-w0-ari-1\n",
            b"Cannot connect to the Docker daemon at unix:///var/run/docker.sock\n",
            b"Error response from daemon: permission denied\n",
            b"error: no such object: hub-fansly-w0-lilly-1\npermission denied\n",
            b"permission denied\nerror: no such object: hub-fansly-w0-lilly-1\n",
            b"unexpected error: no such object: hub-fansly-w0-lilly-1\n",
            b"",
        ):
            with self.subTest(stderr=stderr):
                failed = subprocess.CompletedProcess([], 1, stdout=b"", stderr=stderr)
                with patch.object(containers.subprocess, "run", return_value=failed) as docker:
                    result = containers.remove_owned_container("hub-fansly-w0-lilly-1", "owned")
                self.assertEqual(result, {"cleanupConfirmed": False, "cleanupExitCode": 1})
                self.assertEqual(docker.call_count, 1)

    def test_owned_cleanup_accepts_auto_remove_race_only_for_exact_immutable_id(self):
        identifier = "a" * 64
        owned = subprocess.CompletedProcess([], 0, stdout=(identifier + " owned").encode(), stderr=b"")
        for stderr, confirmed in (
            (f"Error response from daemon: No such container: {identifier}\n", True),
            (f"error response from daemon: no such container: {identifier}\n", True),
            (f"No such container: {identifier}", True),
            (f"Error: No such container: {identifier}\r\n", True),
            (f"Error response from daemon: No such container: {identifier}b\n", False),
            (f"Error response from daemon: No such container: {identifier[:12]}\n", False),
            (f"Error response from daemon: No such container: {'b' * 64}\n", False),
            ("Error response from daemon: No such container: hub-fansly-w0-lilly-1\n", False),
            ("Error response from daemon: permission denied\n", False),
            (f"Error: No such container: {identifier}\nCannot connect to the Docker daemon\n", False),
        ):
            with self.subTest(stderr=stderr):
                removed = subprocess.CompletedProcess([], 1, stdout=b"", stderr=stderr.encode())
                with patch.object(containers.subprocess, "run", side_effect=[owned, removed]) as docker:
                    result = containers.remove_owned_container("hub-fansly-w0-lilly-1", "owned")
                self.assertEqual(result, {"cleanupConfirmed": confirmed, "cleanupExitCode": 1})
                self.assertEqual(docker.call_count, 2)
                self.assertEqual(docker.call_args.args[0], ["docker", "rm", "--force", identifier])

    def test_owned_cleanup_removes_immutable_id_and_retains_timeout_failure(self):
        owned = subprocess.CompletedProcess([], 0, stdout=("a" * 64 + " owned").encode(), stderr=b"")
        removed = subprocess.CompletedProcess([], 0, stdout=b"", stderr=b"")
        with patch.object(containers.subprocess, "run", side_effect=[owned, removed]) as docker:
            self.assertTrue(containers.remove_owned_container("hub-fansly-w0-lilly-1", "owned")["cleanupConfirmed"])
        self.assertEqual(docker.call_args.args[0], ["docker", "rm", "--force", "a" * 64])
        with patch.object(containers.subprocess, "run", side_effect=subprocess.TimeoutExpired("docker", 5)):
            self.assertFalse(containers.remove_owned_container("hub-fansly-w0-lilly-1", "owned")["cleanupConfirmed"])


if __name__ == "__main__":
    unittest.main()
