import asyncio
import html
import logging
import os
import re
import secrets
from datetime import datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from aiohttp import web
from aiogram import Bot, Dispatcher, F, Router
from aiogram.client.default import DefaultBotProperties
from aiogram.enums import ParseMode
from aiogram.filters import Command, CommandStart
from aiogram.fsm.context import FSMContext
from aiogram.fsm.state import State, StatesGroup
from aiogram.types import (
    BotCommand,
    CallbackQuery,
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    KeyboardButton,
    Message,
    ReplyKeyboardMarkup,
    ReplyKeyboardRemove,
)
from aiogram.utils.keyboard import InlineKeyboardBuilder
from aiogram.webhook.aiohttp_server import SimpleRequestHandler, setup_application


logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO"),
    format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
)
logger = logging.getLogger("kosmos-booking-bot")

BOT_TOKEN = os.getenv("BOT_TOKEN", "").strip()
ADMIN_CHAT_ID_RAW = os.getenv("ADMIN_CHAT_ID", "").strip()
WEBHOOK_SECRET = os.getenv("WEBHOOK_SECRET", "").strip() or secrets.token_urlsafe(24)
WEBHOOK_PATH = "/telegram/webhook"
MOSCOW_TZ = ZoneInfo("Europe/Moscow")

if not BOT_TOKEN:
    raise RuntimeError("Не задана переменная BOT_TOKEN")


def parse_chat_id(raw: str) -> int | str | None:
    if not raw or raw == "0":
        return None
    if raw.startswith("@"):
        return raw
    try:
        return int(raw)
    except ValueError as exc:
        raise RuntimeError("ADMIN_CHAT_ID должен быть числом или @именем чата") from exc


ADMIN_CHAT_ID = parse_chat_id(ADMIN_CHAT_ID_RAW)

bot = Bot(
    token=BOT_TOKEN,
    default=DefaultBotProperties(parse_mode=ParseMode.HTML),
)
dp = Dispatcher()
router = Router(name="booking")
dp.include_router(router)


class Booking(StatesGroup):
    visit_date = State()
    visit_time = State()
    duration = State()
    people = State()
    contact = State()
    comment = State()
    confirmation = State()


VISIT_TYPES = {
    "single": "Свободные прыжки",
    "birthday": "День рождения",
    "group": "Группа от 15 человек",
}


def main_menu() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [InlineKeyboardButton(text="🚀 Забронировать прыжки", callback_data="menu:book")],
            [InlineKeyboardButton(text="🎂 День рождения", callback_data="type:birthday")],
            [InlineKeyboardButton(text="💳 Цены", callback_data="menu:prices")],
            [InlineKeyboardButton(text="📍 Адрес и режим работы", callback_data="menu:contacts")],
        ]
    )


def visit_type_keyboard() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [InlineKeyboardButton(text="🤸 Свободные прыжки", callback_data="type:single")],
            [InlineKeyboardButton(text="🎂 День рождения", callback_data="type:birthday")],
            [InlineKeyboardButton(text="👥 Группа от 15 человек", callback_data="type:group")],
            [InlineKeyboardButton(text="✖️ Отмена", callback_data="booking:cancel")],
        ]
    )


def date_keyboard(days: int = 14) -> InlineKeyboardMarkup:
    builder = InlineKeyboardBuilder()
    weekday_names = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"]
    today = datetime.now(MOSCOW_TZ).date()
    for offset in range(days):
        day = today + timedelta(days=offset)
        if offset == 0:
            label = f"Сегодня, {day:%d.%m}"
        elif offset == 1:
            label = f"Завтра, {day:%d.%m}"
        else:
            label = f"{weekday_names[day.weekday()]}, {day:%d.%m}"
        builder.button(text=label, callback_data=f"date:{day.isoformat()}")
    builder.adjust(2)
    builder.row(InlineKeyboardButton(text="✖️ Отмена", callback_data="booking:cancel"))
    return builder.as_markup()


def duration_keyboard() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [
                InlineKeyboardButton(text="30 минут", callback_data="duration:30"),
                InlineKeyboardButton(text="60 минут", callback_data="duration:60"),
            ],
            [InlineKeyboardButton(text="120 минут", callback_data="duration:120")],
            [InlineKeyboardButton(text="✖️ Отмена", callback_data="booking:cancel")],
        ]
    )


def contact_keyboard() -> ReplyKeyboardMarkup:
    return ReplyKeyboardMarkup(
        keyboard=[
            [KeyboardButton(text="📱 Отправить мой номер", request_contact=True)],
            [KeyboardButton(text="✖️ Отменить бронирование")],
        ],
        resize_keyboard=True,
        one_time_keyboard=True,
        input_field_placeholder="Или напишите номер вручную",
    )


def comment_keyboard() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [InlineKeyboardButton(text="Без комментария", callback_data="booking:skip_comment")],
            [InlineKeyboardButton(text="✖️ Отмена", callback_data="booking:cancel")],
        ]
    )


def confirmation_keyboard() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [InlineKeyboardButton(text="✅ Отправить заявку", callback_data="booking:confirm")],
            [InlineKeyboardButton(text="🔄 Заполнить заново", callback_data="booking:restart")],
            [InlineKeyboardButton(text="✖️ Отмена", callback_data="booking:cancel")],
        ]
    )


def prices_text() -> str:
    return (
        "<b>Цены батутного парка «Космос»</b>\n\n"
        "<b>Будни:</b>\n"
        "• 30 минут — 400 ₽\n"
        "• 60 минут — 600 ₽\n"
        "• 120 минут — 1 000 ₽\n\n"
        "<b>Выходные:</b>\n"
        "• 30 минут — 500 ₽\n"
        "• 60 минут — 800 ₽\n"
        "• 120 минут — 1 200 ₽\n\n"
        "<b>Социальные дни — понедельник и четверг:</b>\n"
        "30 минут — 300 ₽, 60 минут — 400 ₽, 120 минут — 700 ₽.\n\n"
        "Именинник прыгает бесплатно. Условия акций подтвердит администратор."
    )


def booking_summary(data: dict[str, Any]) -> str:
    return (
        "<b>Проверьте данные бронирования</b>\n\n"
        f"🎟 Формат: <b>{html.escape(data['visit_type_label'])}</b>\n"
        f"📅 Дата: <b>{html.escape(data['visit_date_display'])}</b>\n"
        f"🕐 Время: <b>{html.escape(data['visit_time'])}</b>\n"
        f"⏱ Продолжительность: <b>{html.escape(data['duration'])} минут</b>\n"
        f"👥 Гостей: <b>{html.escape(data['people'])}</b>\n"
        f"📱 Телефон: <b>{html.escape(data['phone'])}</b>\n"
        f"💬 Комментарий: {html.escape(data.get('comment') or 'нет')}\n\n"
        "После отправки администратор проверит время и подтвердит заявку."
    )


def format_date_display(iso_date: str) -> str:
    day = datetime.strptime(iso_date, "%Y-%m-%d").date()
    month_names = [
        "января", "февраля", "марта", "апреля", "мая", "июня",
        "июля", "августа", "сентября", "октября", "ноября", "декабря",
    ]
    return f"{day.day} {month_names[day.month - 1]} {day.year}"


def normalize_phone(value: str) -> str | None:
    compact = re.sub(r"[^\d+]", "", value)
    digits = re.sub(r"\D", "", compact)
    if not 10 <= len(digits) <= 15:
        return None
    if compact.startswith("+"):
        return f"+{digits}"
    if len(digits) == 11 and digits.startswith("8"):
        return f"+7{digits[1:]}"
    return f"+{digits}"


async def begin_booking(message: Message, state: FSMContext, visit_type: str | None = None) -> None:
    await state.clear()
    if visit_type:
        await state.update_data(
            visit_type=visit_type,
            visit_type_label=VISIT_TYPES[visit_type],
        )
        await state.set_state(Booking.visit_date)
        await message.answer("Выберите желаемую дату:", reply_markup=date_keyboard())
        return
    await message.answer("Что хотите забронировать?", reply_markup=visit_type_keyboard())


@router.message(CommandStart())
async def command_start(message: Message, state: FSMContext) -> None:
    await state.clear()
    await message.answer(
        "🚀 <b>Добро пожаловать в батутный парк «Космос»!</b>\n\n"
        "Здесь можно выбрать дату и время, а администратор подтвердит свободное место.",
        reply_markup=main_menu(),
    )


@router.message(Command("menu"))
async def command_menu(message: Message, state: FSMContext) -> None:
    await state.clear()
    await message.answer("Главное меню:", reply_markup=main_menu())


@router.message(Command("cancel"))
async def command_cancel(message: Message, state: FSMContext) -> None:
    await state.clear()
    await message.answer(
        "Бронирование отменено.",
        reply_markup=ReplyKeyboardRemove(),
    )
    await message.answer("Выберите действие:", reply_markup=main_menu())


@router.message(Command("myid"))
async def command_myid(message: Message) -> None:
    await message.answer(
        f"ID этого чата: <code>{message.chat.id}</code>\n"
        f"Ваш личный ID: <code>{message.from_user.id}</code>"
    )


@router.callback_query(F.data == "menu:book")
async def menu_book(query: CallbackQuery, state: FSMContext) -> None:
    await query.answer()
    if query.message:
        await begin_booking(query.message, state)


@router.callback_query(F.data == "menu:prices")
async def menu_prices(query: CallbackQuery) -> None:
    await query.answer()
    if query.message:
        await query.message.answer(prices_text(), reply_markup=main_menu())


@router.callback_query(F.data == "menu:contacts")
async def menu_contacts(query: CallbackQuery) -> None:
    await query.answer()
    if query.message:
        await query.message.answer(
            "📍 <b>Будённовск, ул. Ленинская, 82</b>\n"
            "🕙 Работаем ежедневно с 10:00.\n\n"
            "Точное время посещения подтвердит администратор.",
            reply_markup=main_menu(),
        )


@router.callback_query(F.data.startswith("type:"))
async def choose_visit_type(query: CallbackQuery, state: FSMContext) -> None:
    visit_type = (query.data or "").split(":", 1)[1]
    if visit_type not in VISIT_TYPES:
        await query.answer("Неизвестный формат", show_alert=True)
        return
    await query.answer()
    await state.clear()
    await state.update_data(
        visit_type=visit_type,
        visit_type_label=VISIT_TYPES[visit_type],
    )
    await state.set_state(Booking.visit_date)
    if query.message:
        await query.message.answer("Выберите желаемую дату:", reply_markup=date_keyboard())


@router.callback_query(Booking.visit_date, F.data.startswith("date:"))
async def choose_date(query: CallbackQuery, state: FSMContext) -> None:
    iso_date = (query.data or "").split(":", 1)[1]
    try:
        selected = datetime.strptime(iso_date, "%Y-%m-%d").date()
    except ValueError:
        await query.answer("Неверная дата", show_alert=True)
        return
    if selected < datetime.now(MOSCOW_TZ).date():
        await query.answer("Эта дата уже прошла", show_alert=True)
        return
    await query.answer()
    await state.update_data(
        visit_date=iso_date,
        visit_date_display=format_date_display(iso_date),
    )
    await state.set_state(Booking.visit_time)
    if query.message:
        await query.message.answer(
            "Напишите желаемое время после 10:00 в формате <b>15:30</b>.\n"
            "Администратор проверит, свободно ли оно."
        )


@router.message(Booking.visit_time)
async def choose_time(message: Message, state: FSMContext) -> None:
    value = (message.text or "").strip()
    match = re.fullmatch(r"([01]\d|2[0-3]):([0-5]\d)", value)
    if not match:
        await message.answer("Напишите время цифрами, например <b>15:30</b>.")
        return
    if int(match.group(1)) < 10:
        await message.answer("Парк открывается в 10:00. Выберите время после 10:00.")
        return
    await state.update_data(visit_time=value)
    await state.set_state(Booking.duration)
    await message.answer("На сколько минут бронируем?", reply_markup=duration_keyboard())


@router.callback_query(Booking.duration, F.data.startswith("duration:"))
async def choose_duration(query: CallbackQuery, state: FSMContext) -> None:
    duration = (query.data or "").split(":", 1)[1]
    if duration not in {"30", "60", "120"}:
        await query.answer("Неверная продолжительность", show_alert=True)
        return
    await query.answer()
    await state.update_data(duration=duration)
    await state.set_state(Booking.people)
    if query.message:
        await query.message.answer("Сколько всего будет гостей? Напишите число.")


@router.message(Booking.people)
async def choose_people(message: Message, state: FSMContext) -> None:
    value = (message.text or "").strip()
    if not value.isdigit() or not 1 <= int(value) <= 100:
        await message.answer("Напишите количество гостей числом от 1 до 100.")
        return
    await state.update_data(people=value)
    await state.set_state(Booking.contact)
    await message.answer(
        "Оставьте номер телефона для подтверждения брони.",
        reply_markup=contact_keyboard(),
    )


@router.message(Booking.contact, F.contact)
async def receive_contact(message: Message, state: FSMContext) -> None:
    if not message.contact:
        return
    phone = normalize_phone(message.contact.phone_number)
    if not phone:
        await message.answer("Не удалось распознать номер. Напишите его вручную.")
        return
    await state.update_data(phone=phone)
    await state.set_state(Booking.comment)
    await message.answer(
        "Если есть пожелания, напишите их одним сообщением.",
        reply_markup=ReplyKeyboardRemove(),
    )
    await message.answer("Или пропустите этот шаг:", reply_markup=comment_keyboard())


@router.message(Booking.contact)
async def receive_phone_text(message: Message, state: FSMContext) -> None:
    if (message.text or "").strip() == "✖️ Отменить бронирование":
        await command_cancel(message, state)
        return
    phone = normalize_phone(message.text or "")
    if not phone:
        await message.answer("Проверьте номер. Пример: <b>+7 999 123-45-67</b>.")
        return
    await state.update_data(phone=phone)
    await state.set_state(Booking.comment)
    await message.answer(
        "Если есть пожелания, напишите их одним сообщением.",
        reply_markup=ReplyKeyboardRemove(),
    )
    await message.answer("Или пропустите этот шаг:", reply_markup=comment_keyboard())


async def show_confirmation(message: Message, state: FSMContext, comment: str) -> None:
    await state.update_data(comment=comment)
    await state.set_state(Booking.confirmation)
    data = await state.get_data()
    await message.answer(booking_summary(data), reply_markup=confirmation_keyboard())


@router.callback_query(Booking.comment, F.data == "booking:skip_comment")
async def skip_comment(query: CallbackQuery, state: FSMContext) -> None:
    await query.answer()
    if query.message:
        await show_confirmation(query.message, state, "")


@router.message(Booking.comment)
async def receive_comment(message: Message, state: FSMContext) -> None:
    comment = (message.text or "").strip()
    if len(comment) > 500:
        await message.answer("Комментарий слишком длинный. Сократите его до 500 символов.")
        return
    await show_confirmation(message, state, comment)


@router.callback_query(F.data == "booking:cancel")
async def cancel_callback(query: CallbackQuery, state: FSMContext) -> None:
    await query.answer("Бронирование отменено")
    await state.clear()
    if query.message:
        await query.message.answer("Выберите действие:", reply_markup=main_menu())


@router.callback_query(F.data == "booking:restart")
async def restart_callback(query: CallbackQuery, state: FSMContext) -> None:
    await query.answer()
    if query.message:
        await begin_booking(query.message, state)


def admin_context_matches(query: CallbackQuery) -> bool:
    if not query.message or ADMIN_CHAT_ID is None:
        return False
    if isinstance(ADMIN_CHAT_ID, int):
        return query.message.chat.id == ADMIN_CHAT_ID
    expected_username = ADMIN_CHAT_ID.removeprefix("@").lower()
    actual_username = (query.message.chat.username or "").lower()
    return actual_username == expected_username


@router.callback_query(Booking.confirmation, F.data == "booking:confirm")
async def confirm_booking(query: CallbackQuery, state: FSMContext) -> None:
    if ADMIN_CHAT_ID is None:
        await query.answer("Приём заявок ещё настраивается", show_alert=True)
        if query.message:
            await query.message.answer(
                "Администраторский чат пока не подключён. Позвоните в парк или попробуйте немного позже."
            )
        return

    await query.answer()
    data = await state.get_data()
    now = datetime.now(MOSCOW_TZ)
    booking_id = f"K{now:%m%d%H%M}{query.from_user.id % 1000:03d}"
    username = f"@{query.from_user.username}" if query.from_user.username else "не указан"
    admin_text = (
        f"🆕 <b>Новая заявка #{booking_id}</b>\n\n"
        f"👤 Клиент: <b>{html.escape(query.from_user.full_name)}</b>\n"
        f"💬 Telegram: {html.escape(username)}\n"
        f"🆔 User ID: <code>{query.from_user.id}</code>\n\n"
        f"🎟 Формат: <b>{html.escape(data['visit_type_label'])}</b>\n"
        f"📅 Дата: <b>{html.escape(data['visit_date_display'])}</b>\n"
        f"🕐 Время: <b>{html.escape(data['visit_time'])}</b>\n"
        f"⏱ Продолжительность: <b>{html.escape(data['duration'])} минут</b>\n"
        f"👥 Гостей: <b>{html.escape(data['people'])}</b>\n"
        f"📱 Телефон: <b>{html.escape(data['phone'])}</b>\n"
        f"💬 Комментарий: {html.escape(data.get('comment') or 'нет')}"
    )
    admin_keyboard = InlineKeyboardMarkup(
        inline_keyboard=[
            [
                InlineKeyboardButton(
                    text="✅ Подтвердить",
                    callback_data=f"admin:approve:{booking_id}:{query.from_user.id}",
                ),
                InlineKeyboardButton(
                    text="❌ Отклонить",
                    callback_data=f"admin:decline:{booking_id}:{query.from_user.id}",
                ),
            ]
        ]
    )
    try:
        await bot.send_message(ADMIN_CHAT_ID, admin_text, reply_markup=admin_keyboard)
    except Exception:
        logger.exception("Не удалось отправить заявку в администраторский чат")
        if query.message:
            await query.message.answer(
                "Не удалось отправить заявку администратору. Попробуйте позже или свяжитесь с парком напрямую."
            )
        return

    await state.clear()
    if query.message:
        await query.message.answer(
            f"✅ <b>Заявка #{booking_id} отправлена!</b>\n\n"
            "Администратор проверит выбранное время. Подтверждение придёт сюда, в Telegram.",
            reply_markup=main_menu(),
        )


@router.callback_query(F.data.startswith("admin:"))
async def admin_decision(query: CallbackQuery) -> None:
    if not admin_context_matches(query):
        await query.answer("Эта кнопка доступна только администратору", show_alert=True)
        return
    parts = (query.data or "").split(":")
    if len(parts) != 4 or parts[1] not in {"approve", "decline"}:
        await query.answer("Некорректная команда", show_alert=True)
        return
    _, action, booking_id, user_id_raw = parts
    try:
        user_id = int(user_id_raw)
    except ValueError:
        await query.answer("Некорректный пользователь", show_alert=True)
        return

    approved = action == "approve"
    status_text = "подтверждена" if approved else "отклонена"
    customer_text = (
        f"✅ <b>Заявка #{booking_id} подтверждена!</b>\n\n"
        "Ждём вас в батутном парке «Космос» по адресу: "
        "Будённовск, ул. Ленинская, 82."
        if approved
        else f"❌ <b>Заявка #{booking_id} пока не подтверждена.</b>\n\n"
        "Выбранное время оказалось недоступно. Напишите боту ещё раз, чтобы выбрать другое время."
    )
    try:
        await bot.send_message(user_id, customer_text, reply_markup=main_menu())
    except Exception:
        logger.exception("Не удалось отправить клиенту решение по заявке %s", booking_id)
        await query.answer("Не удалось уведомить клиента", show_alert=True)
        return

    if query.message:
        await query.message.edit_reply_markup(reply_markup=None)
        await query.message.answer(
            f"Заявка <b>#{booking_id}</b> {status_text}. Решение отправлено клиенту."
        )
    await query.answer("Готово")


@router.message()
async def fallback(message: Message) -> None:
    await message.answer(
        "Я помогу забронировать посещение. Нажмите кнопку ниже.",
        reply_markup=main_menu(),
    )


async def on_startup(bot_instance: Bot) -> None:
    await bot_instance.set_my_commands(
        [
            BotCommand(command="start", description="Открыть главное меню"),
            BotCommand(command="menu", description="Показать меню"),
            BotCommand(command="cancel", description="Отменить бронирование"),
            BotCommand(command="myid", description="Показать ID для настройки"),
        ]
    )
    base_url = (
        os.getenv("WEBHOOK_BASE_URL", "").strip()
        or os.getenv("RENDER_EXTERNAL_URL", "").strip()
    )
    if base_url:
        webhook_url = f"{base_url.rstrip('/')}{WEBHOOK_PATH}"
        await bot_instance.set_webhook(
            url=webhook_url,
            secret_token=WEBHOOK_SECRET,
            allowed_updates=dp.resolve_used_update_types(),
            drop_pending_updates=True,
        )
        logger.info("Webhook настроен: %s", webhook_url)
    else:
        await bot_instance.delete_webhook(drop_pending_updates=True)
        logger.info("Запуск в режиме long polling")


async def health(_: web.Request) -> web.Response:
    return web.json_response({"status": "ok", "service": "kosmos-booking-bot"})


def webhook_base_url() -> str:
    return (
        os.getenv("WEBHOOK_BASE_URL", "").strip()
        or os.getenv("RENDER_EXTERNAL_URL", "").strip()
    )


def run_webhook() -> None:
    app = web.Application()
    app.router.add_get("/", health)
    app.router.add_get("/health", health)
    SimpleRequestHandler(
        dispatcher=dp,
        bot=bot,
        secret_token=WEBHOOK_SECRET,
    ).register(app, path=WEBHOOK_PATH)
    setup_application(app, dp, bot=bot)
    port = int(os.getenv("PORT", "10000"))
    web.run_app(app, host="0.0.0.0", port=port)


async def run_polling() -> None:
    await dp.start_polling(bot)


dp.startup.register(on_startup)


if __name__ == "__main__":
    if webhook_base_url():
        run_webhook()
    else:
        asyncio.run(run_polling())
