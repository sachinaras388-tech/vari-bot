import unittest

from backend.services.commands import extract_command
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


if __name__ == "__main__":
    unittest.main()
