import os
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from backend.services.gemini_service import GeminiService
from backend.services.openrouter_service import OpenRouterService

from backend.services.commands import extract_command
from backend.services.gemini_service import GeminiService
from backend.services.nezuko import sanitize_text, should_trigger_nezuko, build_help_text, is_authorized_admin


class NezukoServiceTests(unittest.TestCase):
    def test_sanitize_text_removes_control_chars(self) -> None:
        self.assertEqual(sanitize_text("  Hello\nWorld\x00  "), "Hello World")

    def test_should_trigger_nezuko_is_case_insensitive(self) -> None:
        self.assertTrue(should_trigger_nezuko("Hello Nezuko how are you?"))
        self.assertTrue(should_trigger_nezuko("hello nezuko"))
        self.assertFalse(should_trigger_nezuko("hello there friend"))

    def test_help_text_contains_core_commands(self) -> None:
        help_text = build_help_text()
        self.assertIn("help", help_text.lower())
        self.assertIn("summary", help_text.lower())
        self.assertIn("admin", help_text.lower())

    def test_extract_command_strips_wake_word(self) -> None:
        self.assertEqual(extract_command("Nezuko status"), "status")
        self.assertEqual(extract_command("hello nezuko broadcast hi"), "broadcast hi")
        self.assertEqual(extract_command("please help me"), "please help me")

    def test_owner_number_is_treated_as_admin(self) -> None:
        self.assertTrue(is_authorized_admin("918660108587"))

    def test_formatted_phone_numbers_are_treated_as_admin(self) -> None:
        self.assertTrue(is_authorized_admin("+91 8660 108587"))

    def test_gemini_service_uses_ai_api_key_fallback(self) -> None:
        with patch.dict(os.environ, {"AI_API_KEY": "shared-key"}, clear=False):
            os.environ.pop("GEMINI_API_KEY", None)
            service = GeminiService()
            self.assertEqual(service.api_key, "shared-key")

    def test_gemini_service_uses_keyword_sdk_call(self) -> None:
        service = GeminiService(api_key="test-key")

        class DummyModels:
            def __init__(self) -> None:
                self.calls: list[dict[str, object]] = []

            def generate_content(self, *, model: str, contents: list[object], config: object) -> dict[str, object]:
                self.calls.append({"model": model, "contents": contents, "config": config})
                return {"text": "ok"}

        class DummyClient:
            def __init__(self) -> None:
                self.models = DummyModels()

        client = DummyClient()
        response = service._invoke_generate_content(client, "test-model", ["hello"], object())
        self.assertEqual(response, {"text": "ok"})
        self.assertEqual(client.models.calls[0]["model"], "test-model")

    def test_openrouter_service_uses_configured_key(self) -> None:
        with patch("backend.services.openrouter_service.get_settings", return_value=SimpleNamespace(OPENROUTER_API_KEY="or-key", AI_API_KEY=None)):
            service = OpenRouterService()
            self.assertEqual(service.api_key, "or-key")


if __name__ == "__main__":
    unittest.main()
