import json
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

from scripts.build_release import build_archive, version_from_tag


class ReleaseArchiveTest(unittest.TestCase):
    def test_tag_version_validation(self):
        self.assertEqual(version_from_tag("v2.3.4"), "2.3.4")
        self.assertEqual(version_from_tag("v2.3.4-rc.1"), "2.3.4-rc.1")
        for tag in ("2.3.4", "v2.3", "v02.3.4", "v2.3.4-rc.", "latest"):
            with self.assertRaises(ValueError):
                version_from_tag(tag)

    def test_archive_contains_versioned_plugin_sources_only(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "metadata.yaml").write_text("name: test\nversion: 1.0.0\n", encoding="utf-8")
            (root / "package.json").write_text('{"name":"test","version":"1.0.0"}', encoding="utf-8")
            (root / "package-lock.json").write_text(
                '{"name":"test","version":"1.0.0","packages":{"":{"version":"1.0.0"}}}',
                encoding="utf-8",
            )
            (root / "main.py").write_text("print('plugin')\n", encoding="utf-8")
            output = root / "dist" / "source.zip"
            with patch("scripts.build_release.tracked_sources", return_value=[
                "main.py", "metadata.yaml", "package-lock.json", "package.json"
            ]):
                self.assertEqual(build_archive(root, "v2.3.4", output), "2.3.4")
            with zipfile.ZipFile(output) as archive:
                prefix = "astrbot_plugin_MCastrbot/"
                self.assertEqual(set(archive.namelist()), {
                    prefix + name for name in ("main.py", "metadata.yaml", "package.json", "package-lock.json")
                })
                self.assertIn("version: 2.3.4", archive.read(prefix + "metadata.yaml").decode())
                self.assertEqual(json.loads(archive.read(prefix + "package.json"))["version"], "2.3.4")
                lock = json.loads(archive.read(prefix + "package-lock.json"))
                self.assertEqual(lock["version"], "2.3.4")
                self.assertEqual(lock["packages"][""]["version"], "2.3.4")


if __name__ == "__main__":
    unittest.main()
