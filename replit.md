# Telegram KHQR Bot

Bot Telegram សម្រាប់លក់ coupon/account ដោយប្រើ Bakong KHQR payment — 100% JavaScript (Telegraf v4).

## Run

```
cd telegram-bot && node bot.js
```

Replit Workflow: **Telegram Bot** → `cd telegram-bot && node bot.js`

## Stack

- Node.js 24, ES Modules
- Telegraf v4 (Telegram Bot API)
- qrcode (QR generation)
- JSON file persistence (no database)

## Files

```
telegram-bot/
  bot.js          ← main bot (single file)
  package.json
  data/
    accounts.json   ← coupon stock + prices
    sessions.json   ← active user sessions
    settings.json   ← bot settings (payment name, bakong token, etc.)
    users.json      ← known users
    purchases.json  ← purchase history
```

## Environment

- `TELEGRAM_BOT_TOKEN` — required (set in Replit Secrets)

## Admin

- Admin ID: `5002402843` (hardcoded in bot.js)
- Admin sees `⚙️កំណត់` button in keyboard
- All settings stored in `data/settings.json`

## User preferences

- Bot must be 100% JavaScript (no Python, no Pyrogram)
- No database — JSON files only
- Code structure mirrors original GitHub repo (shopnowkh-cloud)
- Single file: bot.js only
