import unittest
import json
from pathlib import Path

from reply import filter_reply, split_reply


class SplitReplyTest(unittest.TestCase):
    def test_sentence_boundary_and_reconstruction(self):
        original = "你好。" * 90
        pieces = split_reply(original, True, 10, "regex", r"[。！？!?；;]+")
        self.assertGreater(len(pieces), 1)
        self.assertEqual("".join(pieces), original)
        self.assertTrue(all(0 < len(piece) <= 240 for piece in pieces))

    def test_long_text_without_punctuation_is_bounded(self):
        original = "a" * 520
        pieces = split_reply(original, False, 150, "length", "")
        self.assertEqual([len(piece) for piece in pieces], [240, 240, 40])
        self.assertEqual("".join(pieces), original)

    def test_default_regex_preserves_long_unpunctuated_text(self):
        schema = json.loads((Path(__file__).resolve().parents[1] / "_conf_schema.json").read_text(encoding="utf-8"))
        pattern = schema["segmentation"]["items"]["split_regex"]["default"]
        self.assertEqual(pattern, r".*?[。？！~…\n]+|.+$")
        original = "无标点的长文本" * 100
        pieces = split_reply(original, True, 10, "regex", pattern)
        self.assertGreater(len(pieces), 1)
        self.assertTrue(all(0 < len(piece) <= 240 for piece in pieces))
        self.assertEqual("".join(pieces), original)
        print(f"无句末标点：{len(pieces)} 段，原文/重组={len(original)}/{len(''.join(pieces))} 字")

    def test_schema_groups_segmentation_without_fake_indentation(self):
        schema = json.loads((Path(__file__).resolve().parents[1] / "_conf_schema.json").read_text(encoding="utf-8"))
        self.assertEqual(schema["wake_keywords"]["default"], [])
        group = schema["segmentation"]
        self.assertEqual(group["type"], "object")
        self.assertEqual(group["condition"], {"segmented_reply": True})
        self.assertEqual(group["items"]["split_regex"]["condition"], {"split_mode": "regex"})
        for name, item in group["items"].items():
            self.assertTrue(item.get("description"), name)
            self.assertNotIn("\u3000", item["description"], name)
            hint = item.get("hint", "")
            self.assertNotIn("\u3000", hint, name)
            self.assertFalse(item["description"].startswith("分段 · "), name)

    def test_invalid_regex_falls_back(self):
        pieces = split_reply("hello world", True, 0, "regex", "[")
        self.assertEqual(pieces, ["hello world"])

    def test_private_reply_limit_and_filter(self):
        parts = split_reply("abc。" * 100, True, 0, "regex", r"[。]+", 218)
        self.assertTrue(all(len(part) <= 218 for part in parts))
        self.assertEqual("".join(parts), "abc。" * 100)
        self.assertEqual(filter_reply(["abc[skip]", "[skip]"], True, r"\[skip\]"), ["abc"])


if __name__ == "__main__":
    unittest.main()
