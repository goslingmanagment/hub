"""Offline admission and immutable receipt handoff; never runs Docker."""

import argparse
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

scripts = Path(__file__).parents[1] / "scripts/fansly-ws"
sys.path.insert(0, str(scripts))
import launcher_inputs as inputs
import launcher_container as containers

spec = importlib.util.spec_from_file_location("binding_launcher", scripts / "run-binding-preflight.py")
preflight = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preflight)


class BindingLauncherTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.receipt = self.root / "receipt.json"
        self.receipt.write_text(json.dumps({"identityMatched": True,
            "evidenceKind": "w0_rest_identity_preflight", "credentialRouteGeneration": "a" * 64}))
        self.receipt.chmod(0o600)
        for name in ("bundle", "environment"):
            path = self.root / name
            path.write_bytes(b"private fixture")
            path.chmod(0o600)
        self.args = argparse.Namespace(bundle=str(self.root / "bundle"),
            environment=str(self.root / "environment"), output=str(self.root / "output"),
            page="lilly-1", image="sha256:" + "a" * 64, network="fixture", run_id="fixture")
        lock = patch.object(containers, "LOCK_DIRECTORY", self.root / "locks")
        lock.start()
        self.addCleanup(lock.stop)

    def test_preflight_has_its_own_deadline_and_no_receiver_arguments(self):
        def run(args, bundle, output, key, timeout, filename):
            self.assertEqual(timeout, 45)
            self.assertEqual(filename, "report.json")
            self.assertIsNone(key)
            command = inputs.container_command(args, "hub-fansly-w0-lilly-1")
            self.assertEqual(command[-2:], ["--page", "lilly-1"])
            self.assertNotIn("--seconds", command)
            self.assertNotIn("--phase", command)
            self.assertNotIn("--token", command)
            self.assertIn("--read-only", command)
            self.assertEqual(bundle, b"private fixture")
            return {"exitCode": 0}
        with patch.object(preflight, "run_container", side_effect=run) as run_container:
            self.assertEqual(preflight.run(self.args), {"exitCode": 0})
        run_container.assert_called_once()

    def test_receipt_copy_is_immutable_for_this_run_and_removed_on_cancellation(self):
        output = self.root / "private-output"
        output.mkdir(mode=0o700)
        copied = None
        with self.assertRaises(KeyboardInterrupt):
            with inputs.private_binding_receipt(str(self.receipt), output) as binding:
                copied, generation = binding
                self.assertEqual(generation, "a" * 64)
                self.assertEqual(copied.stat().st_mode & 0o777, 0o600)
                before = copied.read_bytes()
                self.receipt.write_text("changed source")
                self.assertEqual(copied.read_bytes(), before)
                self.args.binding_receipt_copy = copied
                self.args.seconds = 120
                command = inputs.container_command(self.args, "owned")
                self.assertIn("--binding-receipt-file", command)
                self.assertEqual(command[-1], inputs.BINDING_RECEIPT_TARGET)
                self.assertIn("readonly", command[command.index("--mount") + 1])
                raise KeyboardInterrupt
        self.assertFalse(copied.exists())
        self.assertTrue(self.receipt.exists())

    def test_invalid_receipts_and_unsafe_mount_paths_refuse_before_container(self):
        output = self.root / "private-output"
        output.mkdir(mode=0o700)
        self.receipt.write_text('{"identityMatched": false}')
        with self.assertRaises(ValueError):
            with inputs.private_binding_receipt(str(self.receipt), output):
                self.fail("Invalid receipt admitted")
        with self.assertRaises(ValueError):
            inputs.private_mount(self.root / "name,readonly=false", inputs.BINDING_RECEIPT_TARGET)

    def test_preflight_and_receiver_share_admission(self):
        with containers.page_admission("lilly-1"), patch.object(preflight, "run_container") as run:
            with self.assertRaises(BlockingIOError):
                preflight.run(self.args)
            run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
