import unittest

from backend.ai.chat import normalize_history_for_gemini


class GeminiHistoryNormalizationTests(unittest.TestCase):
    def test_normalizes_openai_style_roles_and_drops_system_entries(self) -> None:
        history = [
            {"role": "system", "parts": ["ignore me"]},
            {"role": "assistant", "parts": ["hi there"]},
            {"role": "user", "parts": ["hello"]},
        ]

        normalized = normalize_history_for_gemini(history)

        self.assertEqual(len(normalized), 2)
        self.assertEqual(normalized[0]["role"], "model")
        self.assertEqual(normalized[0]["parts"], ["hi there"])
        self.assertEqual(normalized[1]["role"], "user")
        self.assertEqual(normalized[1]["parts"], ["hello"])


if __name__ == "__main__":
    unittest.main()
