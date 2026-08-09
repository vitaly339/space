# Cloudflare Worker для Telegram-бота «Космос»

Эта версия запускается на Cloudflare Workers и хранит состояние бронирования в D1. Ей не нужен постоянно работающий Python-сервер.

## Ресурсы Cloudflare

- Worker: `kosmos-booking-bot`
- D1: `kosmos-bookings`
- D1 binding: `BOOKINGS_DB`

## Переменные и секреты

| Имя | Тип | Назначение |
| --- | --- | --- |
| `BOT_TOKEN` | secret | Токен Telegram из BotFather |
| `WEBHOOK_SECRET` | secret | Случайная строка для проверки Telegram webhook |
| `ADMIN_CHAT_ID` | variable | ID администратора; на первом запуске `0` |

После развёртывания откройте `https://<worker>.workers.dev/setup`. Этот адрес установит команды и webhook Telegram на текущий Worker.

Затем отправьте боту `/myid`, запишите число из строки «Ваш личный ID» и замените `ADMIN_CHAT_ID=0` на это число.

## Локальная проверка

```bash
npm test
```
