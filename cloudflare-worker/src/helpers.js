export const VISIT_TYPES = {
  single: "Свободные прыжки",
  birthday: "День рождения",
  group: "Группа от 15 человек",
};

const MONTH_NAMES = [
  "января",
  "февраля",
  "марта",
  "апреля",
  "мая",
  "июня",
  "июля",
  "августа",
  "сентября",
  "октября",
  "ноября",
  "декабря",
];

const WEEKDAY_NAMES = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function normalizePhone(value) {
  const raw = String(value ?? "").trim();
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 15) return null;
  if (raw.startsWith("+")) return `+${digits}`;
  if (digits.length === 11 && digits.startsWith("8")) {
    return `+7${digits.slice(1)}`;
  }
  return `+${digits}`;
}

export function isValidVisitTime(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value ?? "").trim());
  if (!match) return false;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours >= 10 && hours <= 23 && minutes >= 0 && minutes <= 59;
}

function datePartsInMoscow(date = new Date()) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
}

export function moscowIsoDate(offsetDays = 0, now = new Date()) {
  const parts = datePartsInMoscow(now);
  const base = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day));
  return new Date(base + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

export function formatDateDisplay(isoDate) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDate ?? ""));
  if (!match) throw new Error("Invalid ISO date");
  const [, year, month, day] = match;
  const monthIndex = Number(month) - 1;
  if (monthIndex < 0 || monthIndex > 11) throw new Error("Invalid month");
  return `${Number(day)} ${MONTH_NAMES[monthIndex]} ${year}`;
}

export function mainMenu() {
  return {
    inline_keyboard: [
      [{ text: "🚀 Забронировать прыжки", callback_data: "menu:book" }],
      [{ text: "🎂 День рождения", callback_data: "type:birthday" }],
      [{ text: "💳 Цены", callback_data: "menu:prices" }],
      [{ text: "📍 Адрес и режим работы", callback_data: "menu:contacts" }],
    ],
  };
}

export function visitTypeKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "🤸 Свободные прыжки", callback_data: "type:single" }],
      [{ text: "🎂 День рождения", callback_data: "type:birthday" }],
      [{ text: "👥 Группа от 15 человек", callback_data: "type:group" }],
      [{ text: "✖️ Отмена", callback_data: "booking:cancel" }],
    ],
  };
}

export function dateKeyboard(days = 14, now = new Date()) {
  const buttons = [];
  for (let offset = 0; offset < days; offset += 1) {
    const iso = moscowIsoDate(offset, now);
    const [, month, day] = iso.split("-");
    const utcDate = new Date(`${iso}T12:00:00Z`);
    let label = `${WEEKDAY_NAMES[utcDate.getUTCDay()]}, ${day}.${month}`;
    if (offset === 0) label = `Сегодня, ${day}.${month}`;
    if (offset === 1) label = `Завтра, ${day}.${month}`;
    if (offset % 2 === 0) buttons.push([]);
    buttons.at(-1).push({ text: label, callback_data: `date:${iso}` });
  }
  buttons.push([{ text: "✖️ Отмена", callback_data: "booking:cancel" }]);
  return { inline_keyboard: buttons };
}

export function durationKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "30 минут", callback_data: "duration:30" },
        { text: "60 минут", callback_data: "duration:60" },
      ],
      [{ text: "120 минут", callback_data: "duration:120" }],
      [{ text: "✖️ Отмена", callback_data: "booking:cancel" }],
    ],
  };
}

export function contactKeyboard() {
  return {
    keyboard: [
      [{ text: "📱 Отправить мой номер", request_contact: true }],
      [{ text: "✖️ Отменить бронирование" }],
    ],
    resize_keyboard: true,
    one_time_keyboard: true,
    input_field_placeholder: "Или напишите номер вручную",
  };
}

export function commentKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "Без комментария", callback_data: "booking:skip_comment" }],
      [{ text: "✖️ Отмена", callback_data: "booking:cancel" }],
    ],
  };
}

export function confirmationKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "✅ Отправить заявку", callback_data: "booking:confirm" }],
      [{ text: "🔄 Заполнить заново", callback_data: "booking:restart" }],
      [{ text: "✖️ Отмена", callback_data: "booking:cancel" }],
    ],
  };
}

export function pricesText() {
  return (
    "<b>Цены батутного парка «Космос»</b>\n\n" +
    "<b>Будни:</b>\n" +
    "• 30 минут — 400 ₽\n" +
    "• 60 минут — 600 ₽\n" +
    "• 120 минут — 1 000 ₽\n\n" +
    "<b>Выходные:</b>\n" +
    "• 30 минут — 500 ₽\n" +
    "• 60 минут — 800 ₽\n" +
    "• 120 минут — 1 200 ₽\n\n" +
    "<b>Социальные дни — понедельник и четверг:</b>\n" +
    "30 минут — 300 ₽, 60 минут — 400 ₽, 120 минут — 700 ₽.\n\n" +
    "Именинник прыгает бесплатно. Условия акций подтвердит администратор."
  );
}

export function bookingSummary(data) {
  return (
    "<b>Проверьте данные бронирования</b>\n\n" +
    `🎟 Формат: <b>${escapeHtml(data.visit_type_label)}</b>\n` +
    `📅 Дата: <b>${escapeHtml(data.visit_date_display)}</b>\n` +
    `🕐 Время: <b>${escapeHtml(data.visit_time)}</b>\n` +
    `⏱ Продолжительность: <b>${escapeHtml(data.duration)} минут</b>\n` +
    `👥 Гостей: <b>${escapeHtml(data.people)}</b>\n` +
    `📱 Телефон: <b>${escapeHtml(data.phone)}</b>\n` +
    `💬 Комментарий: ${escapeHtml(data.comment || "нет")}\n\n` +
    "После отправки администратор проверит время и подтвердит заявку."
  );
}

export function bookingId(userId, now = Date.now()) {
  const tail = String(userId).slice(-3).padStart(3, "0");
  return `K${now.toString(36).toUpperCase()}${tail}`;
}
