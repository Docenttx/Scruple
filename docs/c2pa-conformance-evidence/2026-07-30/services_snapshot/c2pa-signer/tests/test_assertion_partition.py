"""Tests for the assertion partition — GPSA §C.2.4 TOE boundary."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from assertion_partition import (  # noqa: E402
    CREATED_ALLOWLIST,
    GATHERED_ALLOWLIST,
    _base_label,
    partition_assertions,
)


class TestBaseLabel(unittest.TestCase):
    def test_strip_v_suffix(self):
        self.assertEqual(_base_label("c2pa.actions.v2"), "c2pa.actions")
        self.assertEqual(_base_label("c2pa.thumbnail.claim.v2"), "c2pa.thumbnail.claim")

    def test_keep_when_no_suffix(self):
        self.assertEqual(_base_label("c2pa.actions"), "c2pa.actions")
        # Base-label stripping is universal — the allowlist must store the
        # base form so scruple-namespaced labels compare correctly too.
        self.assertEqual(_base_label("ai.scruple.signer-runtime.v1"),
                         "ai.scruple.signer-runtime")

    def test_empty(self):
        self.assertEqual(_base_label(""), "")


class TestPartition(unittest.TestCase):
    def test_created_only(self):
        assertions = [
            {"label": "c2pa.actions", "data": {}},
            {"label": "c2pa.thumbnail.claim", "data": {}},
            {"label": "ai.scruple.signer-runtime.v1", "data": {}},
        ]
        part, audit = partition_assertions(assertions)
        self.assertEqual(len(part["created"]), 3)
        self.assertEqual(len(part["gathered"]), 0)
        self.assertEqual(audit["created_count"], 3)
        self.assertEqual(audit["rejected_count"], 0)

    def test_gathered(self):
        assertions = [
            {"label": "stds.iptc", "data": {}},
            {"label": "c2pa.actions", "data": {}},
        ]
        part, audit = partition_assertions(assertions)
        self.assertEqual(len(part["created"]), 1)
        self.assertEqual(len(part["gathered"]), 1)
        self.assertEqual(audit["gathered_labels"], ["stds.iptc"])

    def test_rejects_unknown_label(self):
        assertions = [
            {"label": "com.thirdparty.evil", "data": {"malicious": "payload"}},
        ]
        with self.assertRaises(ValueError) as cm:
            partition_assertions(assertions)
        self.assertIn("com.thirdparty.evil", str(cm.exception))
        self.assertIn("not on Signer TOE allowlist", str(cm.exception))

    def test_rejects_missing_label(self):
        assertions = [{"data": {"anything": True}}]
        with self.assertRaises(ValueError) as cm:
            partition_assertions(assertions)
        self.assertIn("missing 'label'", str(cm.exception))

    def test_version_insensitive_match(self):
        """c2pa.actions.v2 should be treated as c2pa.actions for allowlist matching."""
        assertions = [{"label": "c2pa.actions.v2", "data": {}}]
        part, audit = partition_assertions(assertions)
        self.assertEqual(len(part["created"]), 1)
        self.assertEqual(audit["created_labels"], ["c2pa.actions.v2"])

    def test_empty(self):
        part, audit = partition_assertions([])
        self.assertEqual(part, {"created": [], "gathered": []})
        self.assertEqual(audit["created_count"], 0)
        self.assertEqual(audit["gathered_count"], 0)

    def test_scruple_runtime_labeled_correctly(self):
        """The runtime assertion the Signer injects must land in created."""
        assertions = [{
            "label": "ai.scruple.signer-runtime.v1",
            "data": {"signer_instance_id": "ocid1.instance.oc1.iad.aaa"},
        }]
        part, audit = partition_assertions(assertions)
        self.assertEqual(len(part["created"]), 1)
        self.assertEqual(part["created"][0]["label"], "ai.scruple.signer-runtime.v1")


if __name__ == "__main__":
    unittest.main()
