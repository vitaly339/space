import os
import unittest

os.environ.setdefault("BOT_TOKEN", "123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
os.environ.setdefault("ADMIN_CHAT_ID", "0")

import bot


class BotHelpersTest(unittest.TestCase):
    def test_phone_normalization(self) -> None:
        self.assertEqual(bot.normalize_phone("8 (999) 123-45-67"), "+79991234567")
        self.assertEqual(bot.normalize_phone("+7 999 123 45 67"), "+79991234567")
        self.assertIsNone(bot.normalize_phone("123"))

    def test_date_formatting(self) -> None:
        self.assertEqual(bot.format_date_display("2026-08-09"), "9 августа 2026")

    def test_summary_escapes_user_text(self) -> None:
        summary = bot.booking_summary(
            {
                "visit_type_label": "Свободные прыжки",
                "visit_date_display": "9 августа 2026",
                "visit_time": "15:30",
                "duration": "60",
                "people": "3",
                "phone": "+79991234567",
                "comment": "<проверка>",
            }
        )
        self.assertIn("&lt;проверка&gt;", summary)


if __name__ == "__main__":
    unittest.main()
