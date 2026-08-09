import test from "node:test";
import assert from "node:assert/strict";

import {
  bookingId,
  bookingSummary,
  dateKeyboard,
  formatDateDisplay,
  isValidVisitTime,
  normalizePhone,
} from "../src/helpers.js";

test("normalizes Russian phone numbers", () => {
  assert.equal(normalizePhone("8 (999) 123-45-67"), "+79991234567");
  assert.equal(normalizePhone("+7 999 123 45 67"), "+79991234567");
  assert.equal(normalizePhone("123"), null);
});

test("validates visit time after opening", () => {
  assert.equal(isValidVisitTime("10:00"), true);
  assert.equal(isValidVisitTime("23:59"), true);
  assert.equal(isValidVisitTime("09:59"), false);
  assert.equal(isValidVisitTime("25:00"), false);
});

test("builds fourteen safe date callbacks", () => {
  const keyboard = dateKeyboard(14, new Date("2026-08-09T10:00:00Z"));
  const dateButtons = keyboard.inline_keyboard.flat().filter((button) =>
    button.callback_data.startsWith("date:"),
  );
  assert.equal(dateButtons.length, 14);
  assert.equal(dateButtons[0].callback_data, "date:2026-08-09");
  assert.ok(dateButtons.every((button) => button.callback_data.length <= 64));
});

test("formats booking text and escapes customer input", () => {
  assert.equal(formatDateDisplay("2026-08-09"), "9 августа 2026");
  const summary = bookingSummary({
    visit_type_label: "Свободные прыжки",
    visit_date_display: "9 августа 2026",
    visit_time: "15:30",
    duration: "60",
    people: "2",
    phone: "+79991234567",
    comment: "<script>alert(1)</script>",
  });
  assert.match(summary, /&lt;script&gt;/);
  assert.doesNotMatch(summary, /<script>/);
});

test("keeps admin callback identifiers below Telegram limit", () => {
  const id = bookingId(1234567890, 1_786_260_000_000);
  const callback = `admin:approve:${id}:1234567890`;
  assert.ok(callback.length <= 64);
});
