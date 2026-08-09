import {
  VISIT_TYPES,
  bookingId,
  bookingSummary,
  commentKeyboard,
  confirmationKeyboard,
  contactKeyboard,
  dateKeyboard,
  durationKeyboard,
  escapeHtml,
  formatDateDisplay,
  isValidVisitTime,
  mainMenu,
  moscowIsoDate,
  normalizePhone,
  pricesText,
  visitTypeKeyboard,
} from "./helpers.js";

const STATES = {
  DATE: "visit_date",
  TIME: "visit_time",
  DURATION: "duration",
  PEOPLE: "people",
  CONTACT: "contact",
  COMMENT: "comment",
  CONFIRMATION: "confirmation",
};

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function requireBindings(env) {
  const missing = [];
  if (!env.BOT_TOKEN) missing.push("BOT_TOKEN");
  if (!env.WEBHOOK_SECRET) missing.push("WEBHOOK_SECRET");
  if (!env.BOOKINGS_DB) missing.push("BOOKINGS_DB");
  if (missing.length) throw new Error(`Missing bindings: ${missing.join(", ")}`);
}

async function ensureSchema(env) {
  await env.BOOKINGS_DB.batch([
    env.BOOKINGS_DB.prepare(
      `CREATE TABLE IF NOT EXISTS sessions (
        chat_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        state TEXT NOT NULL,
        data TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL
      )`,
    ),
    env.BOOKINGS_DB.prepare(
      `CREATE TABLE IF NOT EXISTS bookings (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        admin_chat_id TEXT NOT NULL,
        status TEXT NOT NULL,
        data TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
    ),
    env.BOOKINGS_DB.prepare(
      `CREATE TABLE IF NOT EXISTS processed_updates (
        update_id INTEGER PRIMARY KEY,
        processed_at TEXT NOT NULL
      )`,
    ),
  ]);
}

async function claimUpdate(env, updateId) {
  if (!Number.isInteger(updateId)) return true;
  const result = await env.BOOKINGS_DB.prepare(
    "INSERT OR IGNORE INTO processed_updates (update_id, processed_at) VALUES (?, ?)",
  )
    .bind(updateId, new Date().toISOString())
    .run();
  return Number(result?.meta?.changes ?? 1) > 0;
}

async function getSession(env, chatId) {
  const row = await env.BOOKINGS_DB.prepare(
    "SELECT state, data FROM sessions WHERE chat_id = ?",
  )
    .bind(String(chatId))
    .first();
  if (!row) return { state: "", data: {} };
  try {
    return { state: String(row.state || ""), data: JSON.parse(row.data || "{}") };
  } catch {
    return { state: "", data: {} };
  }
}

async function setSession(env, chatId, userId, state, data) {
  await env.BOOKINGS_DB.prepare(
    `INSERT INTO sessions (chat_id, user_id, state, data, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(chat_id) DO UPDATE SET
       user_id = excluded.user_id,
       state = excluded.state,
       data = excluded.data,
       updated_at = excluded.updated_at`,
  )
    .bind(
      String(chatId),
      String(userId),
      state,
      JSON.stringify(data),
      new Date().toISOString(),
    )
    .run();
}

async function clearSession(env, chatId) {
  await env.BOOKINGS_DB.prepare("DELETE FROM sessions WHERE chat_id = ?")
    .bind(String(chatId))
    .run();
}

async function telegram(env, method, payload) {
  const response = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(payload),
  });
  const result = await response.json();
  if (!response.ok || !result.ok) {
    throw new Error(`Telegram ${method} failed: ${result.description || response.status}`);
  }
  return result.result;
}

async function sendMessage(env, chatId, text, replyMarkup = undefined) {
  const payload = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  return telegram(env, "sendMessage", payload);
}

async function answerCallback(env, callbackId, text = undefined, showAlert = false) {
  const payload = { callback_query_id: callbackId, show_alert: showAlert };
  if (text) payload.text = text;
  return telegram(env, "answerCallbackQuery", payload);
}

async function beginBooking(env, chatId, userId, visitType = null) {
  await clearSession(env, chatId);
  if (!visitType) {
    await sendMessage(env, chatId, "Что хотите забронировать?", visitTypeKeyboard());
    return;
  }
  const data = {
    visit_type: visitType,
    visit_type_label: VISIT_TYPES[visitType],
  };
  await setSession(env, chatId, userId, STATES.DATE, data);
  await sendMessage(env, chatId, "Выберите желаемую дату:", dateKeyboard());
}

async function showConfirmation(env, chatId, userId, session, comment) {
  const data = { ...session.data, comment };
  await setSession(env, chatId, userId, STATES.CONFIRMATION, data);
  await sendMessage(env, chatId, bookingSummary(data), confirmationKeyboard());
}

function commandOf(message) {
  const text = String(message.text || "").trim();
  if (!text.startsWith("/")) return "";
  return text.split(/\s+/, 1)[0].split("@", 1)[0].toLowerCase();
}

async function handleCommand(env, message, command) {
  const chatId = message.chat.id;
  const userId = message.from.id;
  if (command === "/start") {
    await clearSession(env, chatId);
    await sendMessage(
      env,
      chatId,
      "🚀 <b>Добро пожаловать в батутный парк «Космос»!</b>\n\n" +
        "Здесь можно выбрать дату и время, а администратор подтвердит свободное место.",
      mainMenu(),
    );
    return true;
  }
  if (command === "/menu") {
    await clearSession(env, chatId);
    await sendMessage(env, chatId, "Главное меню:", mainMenu());
    return true;
  }
  if (command === "/cancel") {
    await clearSession(env, chatId);
    await sendMessage(env, chatId, "Бронирование отменено.", { remove_keyboard: true });
    await sendMessage(env, chatId, "Выберите действие:", mainMenu());
    return true;
  }
  if (command === "/myid") {
    await sendMessage(
      env,
      chatId,
      `ID этого чата: <code>${escapeHtml(chatId)}</code>\n` +
        `Ваш личный ID: <code>${escapeHtml(userId)}</code>`,
    );
    return true;
  }
  return false;
}

async function handleMessage(env, message) {
  if (!message?.chat?.id || !message?.from?.id) return;
  const chatId = message.chat.id;
  const userId = message.from.id;
  const command = commandOf(message);
  if (command && (await handleCommand(env, message, command))) return;

  const session = await getSession(env, chatId);
  const text = String(message.text || "").trim();

  if (session.state === STATES.TIME) {
    if (!isValidVisitTime(text)) {
      await sendMessage(
        env,
        chatId,
        /^\d{2}:\d{2}$/.test(text)
          ? "Парк открывается в 10:00. Выберите корректное время после 10:00."
          : "Напишите время цифрами, например <b>15:30</b>.",
      );
      return;
    }
    const data = { ...session.data, visit_time: text };
    await setSession(env, chatId, userId, STATES.DURATION, data);
    await sendMessage(env, chatId, "На сколько минут бронируем?", durationKeyboard());
    return;
  }

  if (session.state === STATES.PEOPLE) {
    if (!/^\d{1,3}$/.test(text) || Number(text) < 1 || Number(text) > 100) {
      await sendMessage(env, chatId, "Напишите количество гостей числом от 1 до 100.");
      return;
    }
    const data = { ...session.data, people: text };
    await setSession(env, chatId, userId, STATES.CONTACT, data);
    await sendMessage(
      env,
      chatId,
      "Оставьте номер телефона для подтверждения брони.",
      contactKeyboard(),
    );
    return;
  }

  if (session.state === STATES.CONTACT) {
    if (text === "✖️ Отменить бронирование") {
      await clearSession(env, chatId);
      await sendMessage(env, chatId, "Бронирование отменено.", { remove_keyboard: true });
      await sendMessage(env, chatId, "Выберите действие:", mainMenu());
      return;
    }
    const phone = normalizePhone(message.contact?.phone_number || text);
    if (!phone) {
      await sendMessage(env, chatId, "Проверьте номер. Пример: <b>+7 999 123-45-67</b>.");
      return;
    }
    const data = { ...session.data, phone };
    await setSession(env, chatId, userId, STATES.COMMENT, data);
    await sendMessage(env, chatId, "Если есть пожелания, напишите их одним сообщением.", {
      remove_keyboard: true,
    });
    await sendMessage(env, chatId, "Или пропустите этот шаг:", commentKeyboard());
    return;
  }

  if (session.state === STATES.COMMENT) {
    if (text.length > 500) {
      await sendMessage(env, chatId, "Комментарий слишком длинный. Сократите его до 500 символов.");
      return;
    }
    await showConfirmation(env, chatId, userId, session, text);
    return;
  }

  await sendMessage(
    env,
    chatId,
    "Я помогу забронировать посещение. Нажмите кнопку ниже.",
    mainMenu(),
  );
}

async function saveBooking(env, id, userId, chatId, adminChatId, data) {
  const now = new Date().toISOString();
  await env.BOOKINGS_DB.prepare(
    `INSERT INTO bookings
      (id, user_id, chat_id, admin_chat_id, status, data, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`,
  )
    .bind(
      id,
      String(userId),
      String(chatId),
      String(adminChatId),
      JSON.stringify(data),
      now,
      now,
    )
    .run();
}

async function handleBookingConfirmation(env, query, session) {
  const chatId = query.message.chat.id;
  const userId = query.from.id;
  const adminChatId = String(env.ADMIN_CHAT_ID || "0").trim();
  if (!adminChatId || adminChatId === "0") {
    await answerCallback(env, query.id, "Приём заявок ещё настраивается", true);
    await sendMessage(
      env,
      chatId,
      "Администраторский чат пока не подключён. Попробуйте немного позже.",
    );
    return;
  }

  const id = bookingId(userId);
  const username = query.from.username ? `@${query.from.username}` : "не указан";
  const fullName = [query.from.first_name, query.from.last_name].filter(Boolean).join(" ");
  const data = session.data;
  const adminText =
    `🆕 <b>Новая заявка #${escapeHtml(id)}</b>\n\n` +
    `👤 Клиент: <b>${escapeHtml(fullName)}</b>\n` +
    `💬 Telegram: ${escapeHtml(username)}\n` +
    `🆔 User ID: <code>${escapeHtml(userId)}</code>\n\n` +
    `🎟 Формат: <b>${escapeHtml(data.visit_type_label)}</b>\n` +
    `📅 Дата: <b>${escapeHtml(data.visit_date_display)}</b>\n` +
    `🕐 Время: <b>${escapeHtml(data.visit_time)}</b>\n` +
    `⏱ Продолжительность: <b>${escapeHtml(data.duration)} минут</b>\n` +
    `👥 Гостей: <b>${escapeHtml(data.people)}</b>\n` +
    `📱 Телефон: <b>${escapeHtml(data.phone)}</b>\n` +
    `💬 Комментарий: ${escapeHtml(data.comment || "нет")}`;
  const adminKeyboard = {
    inline_keyboard: [
      [
        { text: "✅ Подтвердить", callback_data: `admin:approve:${id}:${userId}` },
        { text: "❌ Отклонить", callback_data: `admin:decline:${id}:${userId}` },
      ],
    ],
  };

  await answerCallback(env, query.id);
  try {
    await sendMessage(env, adminChatId, adminText, adminKeyboard);
    await saveBooking(env, id, userId, chatId, adminChatId, data);
  } catch (error) {
    console.error("Failed to send booking to admin", error);
    await sendMessage(
      env,
      chatId,
      "Не удалось отправить заявку администратору. Попробуйте позже.",
    );
    return;
  }

  await clearSession(env, chatId);
  await sendMessage(
    env,
    chatId,
    `✅ <b>Заявка #${escapeHtml(id)} отправлена!</b>\n\n` +
      "Администратор проверит выбранное время. Подтверждение придёт сюда, в Telegram.",
    mainMenu(),
  );
}

async function handleAdminDecision(env, query, parts) {
  const adminChatId = String(env.ADMIN_CHAT_ID || "0").trim();
  if (String(query.message?.chat?.id) !== adminChatId) {
    await answerCallback(env, query.id, "Эта кнопка доступна только администратору", true);
    return;
  }
  if (parts.length !== 4 || !["approve", "decline"].includes(parts[1])) {
    await answerCallback(env, query.id, "Некорректная команда", true);
    return;
  }
  const [, action, id, userId] = parts;
  if (!/^\d+$/.test(userId)) {
    await answerCallback(env, query.id, "Некорректный пользователь", true);
    return;
  }
  const approved = action === "approve";
  const customerText = approved
    ? `✅ <b>Заявка #${escapeHtml(id)} подтверждена!</b>\n\n` +
      "Ждём вас в батутном парке «Космос» по адресу: Будённовск, ул. Ленинская, 82."
    : `❌ <b>Заявка #${escapeHtml(id)} пока не подтверждена.</b>\n\n` +
      "Выбранное время оказалось недоступно. Откройте меню, чтобы выбрать другое время.";

  try {
    await sendMessage(env, userId, customerText, mainMenu());
    await env.BOOKINGS_DB.prepare(
      "UPDATE bookings SET status = ?, updated_at = ? WHERE id = ?",
    )
      .bind(approved ? "approved" : "declined", new Date().toISOString(), id)
      .run();
    await telegram(env, "editMessageReplyMarkup", {
      chat_id: query.message.chat.id,
      message_id: query.message.message_id,
      reply_markup: { inline_keyboard: [] },
    });
    await sendMessage(
      env,
      query.message.chat.id,
      `Заявка <b>#${escapeHtml(id)}</b> ${approved ? "подтверждена" : "отклонена"}. ` +
        "Решение отправлено клиенту.",
    );
    await answerCallback(env, query.id, "Готово");
  } catch (error) {
    console.error("Failed to notify customer", error);
    await answerCallback(env, query.id, "Не удалось уведомить клиента", true);
  }
}

async function handleCallback(env, query) {
  if (!query?.id || !query?.from?.id || !query?.message?.chat?.id) return;
  const chatId = query.message.chat.id;
  const userId = query.from.id;
  const data = String(query.data || "");
  const session = await getSession(env, chatId);

  if (data === "menu:book") {
    await answerCallback(env, query.id);
    await beginBooking(env, chatId, userId);
    return;
  }
  if (data === "menu:prices") {
    await answerCallback(env, query.id);
    await sendMessage(env, chatId, pricesText(), mainMenu());
    return;
  }
  if (data === "menu:contacts") {
    await answerCallback(env, query.id);
    await sendMessage(
      env,
      chatId,
      "📍 <b>Будённовск, ул. Ленинская, 82</b>\n" +
        "🕙 Работаем ежедневно с 10:00.\n\n" +
        "Точное время посещения подтвердит администратор.",
      mainMenu(),
    );
    return;
  }
  if (data.startsWith("type:")) {
    const visitType = data.slice("type:".length);
    if (!VISIT_TYPES[visitType]) {
      await answerCallback(env, query.id, "Неизвестный формат", true);
      return;
    }
    await answerCallback(env, query.id);
    await beginBooking(env, chatId, userId, visitType);
    return;
  }
  if (data === "booking:cancel") {
    await answerCallback(env, query.id, "Бронирование отменено");
    await clearSession(env, chatId);
    await sendMessage(env, chatId, "Выберите действие:", mainMenu());
    return;
  }
  if (data === "booking:restart") {
    await answerCallback(env, query.id);
    await beginBooking(env, chatId, userId);
    return;
  }
  if (data.startsWith("date:")) {
    const isoDate = data.slice("date:".length);
    if (session.state !== STATES.DATE || !/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) {
      await answerCallback(env, query.id, "Сначала начните бронирование заново", true);
      return;
    }
    if (isoDate < moscowIsoDate()) {
      await answerCallback(env, query.id, "Эта дата уже прошла", true);
      return;
    }
    const nextData = {
      ...session.data,
      visit_date: isoDate,
      visit_date_display: formatDateDisplay(isoDate),
    };
    await setSession(env, chatId, userId, STATES.TIME, nextData);
    await answerCallback(env, query.id);
    await sendMessage(
      env,
      chatId,
      "Напишите желаемое время после 10:00 в формате <b>15:30</b>.\n" +
        "Администратор проверит, свободно ли оно.",
    );
    return;
  }
  if (data.startsWith("duration:")) {
    const duration = data.slice("duration:".length);
    if (session.state !== STATES.DURATION || !["30", "60", "120"].includes(duration)) {
      await answerCallback(env, query.id, "Сначала начните бронирование заново", true);
      return;
    }
    await setSession(env, chatId, userId, STATES.PEOPLE, {
      ...session.data,
      duration,
    });
    await answerCallback(env, query.id);
    await sendMessage(env, chatId, "Сколько всего будет гостей? Напишите число.");
    return;
  }
  if (data === "booking:skip_comment") {
    if (session.state !== STATES.COMMENT) {
      await answerCallback(env, query.id, "Сначала начните бронирование заново", true);
      return;
    }
    await answerCallback(env, query.id);
    await showConfirmation(env, chatId, userId, session, "");
    return;
  }
  if (data === "booking:confirm") {
    if (session.state !== STATES.CONFIRMATION) {
      await answerCallback(env, query.id, "Сначала начните бронирование заново", true);
      return;
    }
    await handleBookingConfirmation(env, query, session);
    return;
  }
  if (data.startsWith("admin:")) {
    await handleAdminDecision(env, query, data.split(":"));
    return;
  }
  await answerCallback(env, query.id, "Команда устарела. Откройте меню заново.", true);
}

async function processUpdate(env, update) {
  if (!(await claimUpdate(env, update.update_id))) return;
  if (update.message) {
    await handleMessage(env, update.message);
  } else if (update.callback_query) {
    await handleCallback(env, update.callback_query);
  }
}

async function configureTelegram(env, request) {
  const origin = new URL(request.url).origin;
  await telegram(env, "setMyCommands", {
    commands: [
      { command: "start", description: "Открыть главное меню" },
      { command: "menu", description: "Показать меню" },
      { command: "cancel", description: "Отменить бронирование" },
      { command: "myid", description: "Показать ID для настройки" },
    ],
  });
  const webhook = await telegram(env, "setWebhook", {
    url: `${origin}/telegram/webhook`,
    secret_token: env.WEBHOOK_SECRET,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: false,
  });
  return jsonResponse({ ok: Boolean(webhook), webhook: `${origin}/telegram/webhook` });
}

export default {
  async fetch(request, env, ctx) {
    try {
      requireBindings(env);
      await ensureSchema(env);
      const url = new URL(request.url);

      if (request.method === "GET" && ["/", "/health"].includes(url.pathname)) {
        return jsonResponse({ status: "ok", service: "kosmos-booking-bot" });
      }
      if (request.method === "GET" && url.pathname === "/setup") {
        return await configureTelegram(env, request);
      }
      if (request.method === "POST" && url.pathname === "/telegram/webhook") {
        const suppliedSecret = request.headers.get("x-telegram-bot-api-secret-token") || "";
        if (suppliedSecret !== env.WEBHOOK_SECRET) {
          return jsonResponse({ error: "forbidden" }, 403);
        }
        const update = await request.json();
        ctx.waitUntil(
          processUpdate(env, update).catch((error) => {
            console.error("Update processing failed", error);
          }),
        );
        return jsonResponse({ ok: true });
      }
      return jsonResponse({ error: "not_found" }, 404);
    } catch (error) {
      console.error("Worker request failed", error);
      return jsonResponse({ error: "internal_error" }, 500);
    }
  },
};
