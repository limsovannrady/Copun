# Telegram KHQR Bot

Bot Telegram សម្រាប់លក់ coupon/account ដោយប្រើ KhPay payment API — 100% JavaScript (Telegraf v4).

## Run

```
node bot.js
```

Replit Workflow: **Telegram Bot** → `node bot.js`

## Stack

- Node.js 24, ES Modules
- Telegraf v4 (Telegram Bot API)
- qrcode (QR generation)
- Single JSON file persistence (db.json)

## Files

```
workspace/
  bot.js      ← main bot (single file, root level)
  db.json     ← all data: accounts, sessions, settings, users, purchases
  package.json
```

## Environment

- `TELEGRAM_BOT_TOKEN` — required (set in Replit Secrets)

## Admin

- Admin ID: `5002402843` (hardcoded in bot.js)
- Admin sees `⚙️កំណត់` button in keyboard
- All settings stored in `db.json`

## Payment

- KhPay API (`https://www.khpay.site/api/v1`)
- Auth: `Authorization: Bearer ak_...`
- QR expires in 180s (bot polls every 5s, timeout 175s)

## User preferences

- Bot must be 100% JavaScript (no Python, no Pyrogram)
- No database — single db.json only
- Single file: bot.js at root (no subfolders)
- No slash commands — keyboard buttons only
