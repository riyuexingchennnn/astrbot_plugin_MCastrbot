import unittest

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
