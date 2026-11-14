import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]


class PluginMetadataTests(unittest.TestCase):
    def test_manifest_and_marketplace_are_consistent(self):
        plugin = json.loads((ROOT / ".claude-plugin/plugin.json").read_text())
        marketplace = json.loads((ROOT / ".claude-plugin/marketplace.json").read_text())
        self.assertEqual(plugin["name"], "storm")
        self.assertTrue(plugin["version"])
        self.assertIn(plugin["name"], [p["name"] for p in marketplace["plugins"]])

    def test_plugin_runtime_and_tests_exist(self):
        self.assertTrue((ROOT / "hooks/register.tsx").is_file())
        self.assertTrue((ROOT / "hooks/storm.test.tsx").is_file())
        self.assertTrue((ROOT / "types/index.d.ts").is_file())


if __name__ == "__main__":
    unittest.main()
