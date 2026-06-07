#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Telegram Bot — Bakong KHQR Payments
Stack: python-telegram-bot | asyncio | JSON persistence (no database, no Pyrogram)
"""

import asyncio
import hashlib
import html
import io
import json
import logging
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import requests
from bakong_khqr import KHQR
from telegram import (
    InlineKeyboardButton, InlineKeyboardMarkup,
    KeyboardButton, ReplyKeyboardMarkup, ReplyKeyboardRemove,
    Update,
)
from telegram.constants import ParseMode
from telegram.ext import (
    Application, ApplicationBuilder, CallbackQueryHandler,
    CommandHandler, ContextTypes, MessageHandler, filters,
)

# ── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    level=logging.INFO,
    handlers=[logging.StreamHandler(sys.stdout)],
)
logger = logging.getLogger(__name__)
logging.getLogger("httpx").setLevel(logging.WARNING)

# ── Config ────────────────────────────────────────────────────────────────────
BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
if not BOT_TOKEN:
    logger.error("TELEGRAM_BOT_TOKEN is not set. Exiting.")
    sys.exit(1)

ADMIN_ID: int = 5002402843
DATA_DIR = Path(__file__).parent / "data"
DATA_DIR.mkdir(exist_ok=True)

ACCOUNTS_FILE = DATA_DIR / "accounts.json"
SESSIONS_FILE = DATA_DIR / "sessions.json"
SETTINGS_FILE = DATA_DIR / "settings.json"
USERS_FILE    = DATA_DIR / "users.json"
PURCHASES_FILE = DATA_DIR / "purchases.json"

PAYMENT_TIMEOUT_SECONDS = 60
PAYMENT_POLL_INTERVAL   = 5

# ── Runtime state (in-memory) ─────────────────────────────────────────────────
accounts_data: dict = {
    "account_types": {},
    "prices": {},
}
user_sessions: dict = {}
settings: dict = {}
known_users: dict = {}
purchase_history: list = []
_notified_users: set = set()
_data_lock = asyncio.Lock()

# ── Settings helpers (JSON-backed) ────────────────────────────────────────────
def _load_settings() -> dict:
    try:
        return json.loads(SETTINGS_FILE.read_text())
    except Exception:
        return {}

def _save_settings_sync():
    try:
        SETTINGS_FILE.write_text(json.dumps(settings, ensure_ascii=False, indent=2))
    except Exception as e:
        logger.error(f"Failed to save settings: {e}")

def get_setting(key, default=None):
    return settings.get(key, default)

def set_setting(key, value):
    settings[key] = value
    _save_settings_sync()

# ── Accounts / sessions JSON ──────────────────────────────────────────────────
def _load_accounts() -> dict:
    try:
        return json.loads(ACCOUNTS_FILE.read_text())
    except Exception:
        return {"account_types": {}, "prices": {}}

def _save_accounts_sync():
    try:
        ACCOUNTS_FILE.write_text(json.dumps(accounts_data, ensure_ascii=False, indent=2))
    except Exception as e:
        logger.error(f"Failed to save accounts: {e}")

def _load_sessions_from_disk() -> dict:
    try:
        return json.loads(SESSIONS_FILE.read_text())
    except Exception:
        return {}

def _save_sessions_sync():
    try:
        serialisable = {str(k): v for k, v in user_sessions.items()}
        SESSIONS_FILE.write_text(json.dumps(serialisable, ensure_ascii=False, indent=2))
    except Exception as e:
        logger.error(f"Failed to save sessions: {e}")

def _load_users() -> dict:
    try:
        return json.loads(USERS_FILE.read_text())
    except Exception:
        return {}

def _save_users_sync():
    try:
        USERS_FILE.write_text(json.dumps(known_users, ensure_ascii=False, indent=2))
    except Exception as e:
        logger.error(f"Failed to save users: {e}")

def _load_purchases() -> list:
    try:
        return json.loads(PURCHASES_FILE.read_text())
    except Exception:
        return []

def _save_purchases_sync():
    try:
        PURCHASES_FILE.write_text(json.dumps(purchase_history, ensure_ascii=False, indent=2))
    except Exception as e:
        logger.error(f"Failed to save purchases: {e}")

# ── KHQR / Bakong helpers ─────────────────────────────────────────────────────
def _get_bakong_token() -> str:
    return settings.get("BAKONG_TOKEN", os.environ.get("BAKONG_TOKEN", ""))

def _get_payment_name() -> str:
    return settings.get("PAYMENT_NAME", "RADY")

def _get_khqr_client():
    tok = _get_bakong_token()
    if not tok:
        return None
    try:
        return KHQR(tok)
    except Exception:
        return None

def _crc16_ccitt(data: str) -> str:
    crc = 0xFFFF
    for ch in data.encode("utf-8"):
        crc ^= ch << 8
        for _ in range(8):
            crc = (crc << 1) ^ 0x1021 if crc & 0x8000 else crc << 1
            crc &= 0xFFFF
    return format(crc, "04X")

def _tlv(tag: str, value: str) -> str:
    return f"{tag}{len(value):02d}{value}"

def _build_khqr_manual(bank_account: str, merchant_name: str, merchant_city: str, amount: float) -> str:
    mcc = "5999"
    currency = "840"
    amt_str = f"{amount:.2f}"
    country = "KH"
    name_clean = re.sub(r"[^A-Za-z0-9 ]", "", merchant_name)[:25].upper() or "MERCHANT"
    city_clean = re.sub(r"[^A-Za-z0-9 ]", "", merchant_city)[:15].upper() or "PHNOMPENH"
    merchant_info = _tlv("00", "com.bakong.nbc.gov.kh") + _tlv("01", bank_account)
    payload = (
        _tlv("00", "01")
        + _tlv("01", "12")
        + _tlv("26", merchant_info)
        + _tlv("52", mcc)
        + _tlv("53", currency)
        + _tlv("54", amt_str)
        + _tlv("58", country)
        + _tlv("59", name_clean)
        + _tlv("60", city_clean)
        + "6304"
    )
    return payload + _crc16_ccitt(payload)

def _generate_payment_qr(amount: float):
    """Returns (img_bytes | None, md5_or_error, qr_string)."""
    client = _get_khqr_client()
    pay_name = _get_payment_name()
    bank_account = settings.get("BANK_ACCOUNT", "")

    if not client and not bank_account:
        return None, "Bakong token / bank account not configured", ""

    try:
        if client:
            try:
                qr = client.create_qr(
                    bank_account or "12345678@abanka",
                    pay_name,
                    amount,
                    "USD",
                    "Phnom Penh",
                )
            except Exception:
                qr = _build_khqr_manual(
                    bank_account or "12345678@abanka",
                    pay_name,
                    "Phnom Penh",
                    amount,
                )
        else:
            qr = _build_khqr_manual(bank_account, pay_name, "Phnom Penh", amount)

        try:
            img_bytes = client.qr_image(qr, format="bytes") if client else None
        except Exception:
            img_bytes = None

        if not img_bytes:
            import qrcode
            qr_img = qrcode.make(qr)
            buf = io.BytesIO()
            qr_img.save(buf, format="PNG")
            img_bytes = buf.getvalue()

        md5 = hashlib.md5(qr.encode()).hexdigest()
        return img_bytes, md5, qr
    except Exception as e:
        return None, str(e), ""

def _check_payment_status(md5: str):
    """Returns (is_paid: bool, payment_data: dict | None)."""
    tok = _get_bakong_token()
    if not tok:
        return False, None
    base = "https://api.bakongrelay.com/v1" if tok.startswith("rbk") else "https://api-bakong.nbc.gov.kh/v1"
    url = f"{base}/check_transaction_by_md5"
    headers = {"Authorization": f"Bearer {tok}", "Content-Type": "application/json"}
    try:
        r = requests.post(url, json={"md5": md5}, headers=headers, timeout=10)
        if r.status_code == 200:
            data = r.json()
            if data.get("responseCode") == 0:
                return True, data.get("data")
    except Exception as e:
        logger.warning(f"Payment check error: {e}")
    return False, None

# ── State helpers ─────────────────────────────────────────────────────────────
def is_admin(uid) -> bool:
    extra = set(int(x) for x in settings.get("EXTRA_ADMIN_IDS", []))
    try:
        return int(uid) == ADMIN_ID or int(uid) in extra
    except (TypeError, ValueError):
        return False

def _type_callback_id(account_type: str) -> str:
    return hashlib.sha1(account_type.encode()).hexdigest()[:12]

def _account_type_from_callback_id(cid: str):
    for at in accounts_data.get("account_types", {}):
        if _type_callback_id(at) == cid:
            return at
    return None

def _main_kb(uid) -> ReplyKeyboardMarkup | ReplyKeyboardRemove:
    if is_admin(uid):
        return ReplyKeyboardMarkup([[KeyboardButton("⚙️ ការកំណត់")]], resize_keyboard=True, is_persistent=True)
    return ReplyKeyboardRemove()

def _maintenance_mode() -> bool:
    return bool(settings.get("MAINTENANCE_MODE", False))

# ── Keyboard constants ────────────────────────────────────────────────────────
BTN_ADD_ACCOUNT    = "➕ បន្ថែម គូប៉ុង"
BTN_DELETE_TYPE    = "🗑 លុបប្រភេទ"
BTN_STOCK          = "📦 ស្តុក គូប៉ុង"
BTN_USERS          = "👥 អ្នកប្រើប្រាស់"
BTN_BUYERS         = "📋 របាយការណ៍ទិញ"
BTN_PAYMENT        = "💳 ឈ្មោះ Payment"
BTN_BAKONG         = "🔑 Bakong Token"
BTN_ADMINS         = "👑 គ្រប់គ្រង Admin"
BTN_MAINTENANCE    = "🛠 Maintenance Mode"
BTN_BROADCAST      = "📢 ផ្សាយព័ត៌មាន"
BTN_BACK           = "⬅️ ត្រឡប់ទៅកំណត់"
BTN_CANCEL         = "🚫 បោះបង់"
BTN_DELETE_CONFIRM = "✅ បញ្ជាក់លុប"
BTN_DELETE_CANCEL  = "🚫 បោះបង់ការលុប"
BTN_BCAST_CONFIRM  = "✅ បញ្ជាក់ផ្សាយ"
BTN_BCAST_CANCEL   = "🚫 បោះបង់ការផ្សាយ"
BTN_MAINT_ON       = "🔴 បិទ Bot"
BTN_MAINT_OFF      = "🟢 បើក Bot"
BTN_ADMIN_ADD      = "➕ បន្ថែម Admin"
BTN_ADMIN_REMOVE   = "➖ ដក Admin"

ADMIN_SETTINGS_KB = ReplyKeyboardMarkup([
    [KeyboardButton(BTN_ADD_ACCOUNT),  KeyboardButton(BTN_DELETE_TYPE)],
    [KeyboardButton(BTN_STOCK),        KeyboardButton(BTN_BUYERS)],
    [KeyboardButton(BTN_USERS),        KeyboardButton(BTN_PAYMENT)],
    [KeyboardButton(BTN_BAKONG),       KeyboardButton(BTN_ADMINS)],
    [KeyboardButton(BTN_MAINTENANCE),  KeyboardButton(BTN_BROADCAST)],
], resize_keyboard=True, is_persistent=True)

CANCEL_KB  = ReplyKeyboardMarkup([[KeyboardButton(BTN_CANCEL)]],  resize_keyboard=True)
BACK_KB    = ReplyKeyboardMarkup([[KeyboardButton(BTN_BACK)]],    resize_keyboard=True)

CANCEL_PURCHASE_KB = InlineKeyboardMarkup([[
    InlineKeyboardButton("🚫 បោះបង់", callback_data="cancel_purchase")
]])

ADMIN_BUTTON_LABELS = {
    BTN_ADD_ACCOUNT, BTN_DELETE_TYPE, BTN_STOCK, BTN_USERS, BTN_BUYERS,
    BTN_PAYMENT, BTN_BAKONG, BTN_ADMINS, BTN_MAINTENANCE, BTN_BROADCAST,
    BTN_BACK, BTN_CANCEL, BTN_DELETE_CONFIRM, BTN_DELETE_CANCEL,
    BTN_BCAST_CONFIRM, BTN_BCAST_CANCEL,
    BTN_MAINT_ON, BTN_MAINT_OFF, BTN_ADMIN_ADD, BTN_ADMIN_REMOVE,
}

# ── Send helpers ──────────────────────────────────────────────────────────────
async def send_msg(bot, chat_id, text, reply_markup=None, parse_mode=ParseMode.HTML):
    try:
        return await bot.send_message(
            chat_id, text,
            parse_mode=parse_mode,
            reply_markup=reply_markup,
        )
    except Exception as e:
        logger.warning(f"send_msg error {chat_id}: {e}")
        return None

async def send_photo(bot, chat_id, img_bytes, caption=None, reply_markup=None):
    try:
        return await bot.send_photo(
            chat_id,
            photo=io.BytesIO(img_bytes) if isinstance(img_bytes, bytes) else img_bytes,
            caption=caption,
            parse_mode=ParseMode.HTML,
            reply_markup=reply_markup,
        )
    except Exception as e:
        logger.warning(f"send_photo error {chat_id}: {e}")
        return None

async def delete_message(bot, chat_id, message_id):
    try:
        await bot.delete_message(chat_id, message_id)
    except Exception:
        pass

# ── Notify admin new user ─────────────────────────────────────────────────────
async def notify_admin_new_user(bot, user):
    uid = user.id
    if uid == ADMIN_ID or uid in _notified_users:
        return
    if str(uid) in known_users:
        return
    _notified_users.add(uid)
    known_users[str(uid)] = {
        "first_name": user.first_name or "",
        "last_name": user.last_name or "",
        "username": user.username or "",
    }
    _save_users_sync()
    full = f"{user.first_name or ''} {user.last_name or ''}".strip() or "N/A"
    uname = f"@{user.username}" if user.username else "—"
    await send_msg(
        bot, ADMIN_ID,
        f"🆕 <b>អ្នកប្រើប្រាស់ថ្មី!</b>\n\n"
        f"👤 ឈ្មោះ: {html.escape(full)}\n"
        f"🔖 Username: {html.escape(uname)}\n"
        f"🪪 ID: <code>{uid}</code>",
    )

# ── Account selection ─────────────────────────────────────────────────────────
async def show_account_selection(bot, chat_id, uid):
    async with _data_lock:
        available = [
            (at, len(accs), accounts_data["prices"].get(at, 0))
            for at, accs in accounts_data["account_types"].items()
            if len(accs) > 0
        ]
    if not available:
        await send_msg(bot, chat_id, "😔 <i>សូមអភ័យទោស អស់ពីស្តុក</i>",
                       reply_markup=_main_kb(uid))
        return
    rows = []
    for at, count, price in available:
        label = f"{at}  [ ${price:.2f} ]  ស្តុក: {count}"
        rows.append([InlineKeyboardButton(label, callback_data=f"buy:{_type_callback_id(at)}")])
    await send_msg(
        bot, chat_id,
        "<b>🛒 ជ្រើសរើសគូប៉ុងដើម្បីទិញ៖</b>",
        reply_markup=InlineKeyboardMarkup(rows),
    )

# ── Admin settings menu ───────────────────────────────────────────────────────
async def show_admin_menu(bot, chat_id):
    await send_msg(
        bot, chat_id,
        "<b>⚙️ ការកំណត់ Admin</b>\n\nជ្រើសរើសប្រតិបត្តិការ:",
        reply_markup=ADMIN_SETTINGS_KB,
    )

# ── Payment flow ──────────────────────────────────────────────────────────────
async def start_payment(bot, chat_id, user_id, session, callback_query=None):
    """Reserve accounts, generate QR, start polling. Returns True on success."""
    account_type = session.get("account_type")
    quantity     = session.get("quantity", 1)

    async with _data_lock:
        pool = accounts_data["account_types"].get(account_type, [])
        if len(pool) < quantity:
            if callback_query:
                await callback_query.answer(
                    f"មានត្រឹមតែ {len(pool)} គូប៉ុងប៉ុណ្ណោះ", show_alert=True)
            user_sessions.pop(user_id, None)
            _save_sessions_sync()
            return False
        reserved = pool[:quantity]
        accounts_data["account_types"][account_type] = pool[quantity:]
        session["reserved_accounts"] = list(reserved)

    _save_accounts_sync()

    if callback_query:
        try:
            await callback_query.answer("កំពុងបង្កើត QR…")
        except Exception:
            pass

    session["state"] = "payment_pending"
    img_bytes, md5_or_err, _qr = _generate_payment_qr(session["total_price"])

    if not img_bytes:
        await send_msg(bot, chat_id,
                       "❌ <b>មានបញ្ហាក្នុងការបង្កើត QR Code</b>\n\nសូមព្យាយាមម្ដងទៀត។")
        await send_msg(bot, ADMIN_ID,
                       f"⚠️ QR Error (user {user_id}): <code>{html.escape(str(md5_or_err))}</code>")
        async with _data_lock:
            accs = session.get("reserved_accounts", [])
            accounts_data["account_types"].setdefault(account_type, [])
            accounts_data["account_types"][account_type] = accs + accounts_data["account_types"][account_type]
            user_sessions.pop(user_id, None)
        _save_accounts_sync()
        _save_sessions_sync()
        return False

    md5 = md5_or_err
    session["md5_hash"]  = md5
    session["qr_sent_at"] = time.time()

    caption = (
        f"💳 <b>ការទូទាត់ KHQR</b>\n\n"
        f"🛒 <b>{html.escape(account_type)}</b> × {quantity}\n"
        f"💵 <b>${session['total_price']:.2f}</b>\n\n"
        f"⏱ QR Code មានសុពលភាព {PAYMENT_TIMEOUT_SECONDS} វិនាទី\n"
        f"👆 ស្កែន​ QR ហើយ​ទូទាត់ ភ្លាមៗ"
    )
    photo_msg = await send_photo(bot, chat_id, img_bytes,
                                 caption=caption, reply_markup=CANCEL_PURCHASE_KB)
    if photo_msg:
        session["photo_message_id"] = photo_msg.message_id

    async with _data_lock:
        user_sessions[user_id] = session
    _save_sessions_sync()

    asyncio.create_task(_poll_payment(bot, chat_id, user_id, md5, session))
    return True

async def _poll_payment(bot, chat_id, user_id, md5: str, session: dict):
    """Poll Bakong until paid or timed out."""
    deadline = session.get("qr_sent_at", time.time()) + PAYMENT_TIMEOUT_SECONDS
    while time.time() < deadline:
        await asyncio.sleep(PAYMENT_POLL_INTERVAL)
        async with _data_lock:
            current = user_sessions.get(user_id, {})
        if current.get("state") != "payment_pending" or current.get("md5_hash") != md5:
            return
        is_paid, payment_data = await asyncio.get_event_loop().run_in_executor(
            None, _check_payment_status, md5)
        if is_paid:
            await deliver_accounts(bot, chat_id, user_id, session, payment_data)
            return

    async with _data_lock:
        current = user_sessions.get(user_id, {})
        if current.get("state") != "payment_pending" or current.get("md5_hash") != md5:
            return
    await _expire_payment(bot, chat_id, user_id, session)

async def _expire_payment(bot, chat_id, user_id, session):
    async with _data_lock:
        account_type = session.get("account_type")
        reserved = session.get("reserved_accounts", [])
        if reserved and account_type:
            accounts_data["account_types"].setdefault(account_type, [])
            accounts_data["account_types"][account_type] = (
                reserved + accounts_data["account_types"][account_type]
            )
        user_sessions.pop(user_id, None)
    _save_accounts_sync()
    _save_sessions_sync()

    mid = session.get("photo_message_id")
    if mid:
        await delete_message(bot, chat_id, mid)
    await send_msg(bot, chat_id,
                   "⏰ <b>QR Code ផុតកំណត់</b>\n\nការទូទាត់មិនបានទទួលក្នុងពេល​វេលា។ "
                   "ចុច /start ដើម្បីចាប់ផ្ដើមឡើងវិញ។",
                   reply_markup=_main_kb(user_id))

async def deliver_accounts(bot, chat_id, user_id, session, payment_data=None):
    async with _data_lock:
        user_sessions.pop(user_id, None)
    _save_sessions_sync()

    reserved = session.get("reserved_accounts", [])
    account_type = session.get("account_type", "")
    quantity = session.get("quantity", len(reserved))
    price = session.get("total_price", 0)

    purchase_history.append({
        "user_id": user_id,
        "account_type": account_type,
        "quantity": quantity,
        "total_price": price,
        "delivered": reserved,
        "paid_at": datetime.now(timezone.utc).isoformat(),
    })
    _save_purchases_sync()

    lines = [
        f"✅ <b>ការទូទាត់ជោគជ័យ!</b>\n",
        f"🛒 <b>{html.escape(account_type)}</b> × {quantity}",
        f"💵 បានទូទាត់: <b>${price:.2f}</b>\n",
        "━━━━━━━━━━━━━━━━━━━━━",
        "<b>🎫 គូប៉ុងរបស់អ្នក:</b>\n",
    ]
    for i, acc in enumerate(reserved, 1):
        val = acc.get("code") or acc.get("email") or str(acc)
        lines.append(f"{i}. <code>{html.escape(val)}</code>")
    lines.append("\n━━━━━━━━━━━━━━━━━━━━━")
    lines.append("🙏 <b>សូមអរគុណ!</b> ចុច /start ដើម្បីទិញបន្ថែម")

    mid = session.get("photo_message_id")
    if mid:
        await delete_message(bot, chat_id, mid)
    await send_msg(bot, chat_id, "\n".join(lines), reply_markup=_main_kb(user_id))

    await send_msg(
        bot, ADMIN_ID,
        f"💰 <b>ការលក់ថ្មី!</b>\n"
        f"👤 User: <code>{user_id}</code>\n"
        f"🛒 {html.escape(account_type)} × {quantity}\n"
        f"💵 ${price:.2f}",
    )

# ── /start ────────────────────────────────────────────────────────────────────
async def cmd_start(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    user    = update.effective_user
    chat_id = update.effective_chat.id
    uid     = user.id

    asyncio.create_task(notify_admin_new_user(ctx.bot, user))

    if _maintenance_mode() and not is_admin(uid):
        await send_msg(ctx.bot, chat_id,
                       "🔧 <b>Bot កំពុង Update សូមរង់ចាំមួយភ្លែត…</b>")
        return

    async with _data_lock:
        sess = user_sessions.get(uid)
        if sess and sess.get("state") == "payment_pending":
            await send_msg(ctx.bot, chat_id,
                           "⏳ <b>អ្នកមានការបញ្ជាទិញកំពុងដំណើរការ។</b>\n"
                           "ចុច /cancel ដើម្បីបោះបង់ ឬបញ្ចប់ការទូទាត់ជាមុនសិន។")
            return
        user_sessions.pop(uid, None)

    await show_account_selection(ctx.bot, chat_id, uid)

# ── /cancel ───────────────────────────────────────────────────────────────────
async def cmd_cancel(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    uid     = update.effective_user.id
    chat_id = update.effective_chat.id

    async with _data_lock:
        sess = user_sessions.pop(uid, None)

    if sess:
        account_type = sess.get("account_type")
        reserved = sess.get("reserved_accounts", [])
        if reserved and account_type:
            async with _data_lock:
                accounts_data["account_types"].setdefault(account_type, [])
                accounts_data["account_types"][account_type] = (
                    reserved + accounts_data["account_types"][account_type]
                )
            _save_accounts_sync()
        mid = sess.get("photo_message_id")
        if mid:
            await delete_message(ctx.bot, chat_id, mid)
        _save_sessions_sync()

    await send_msg(ctx.bot, chat_id, "🚫 <b>បានបោះបង់</b>", reply_markup=_main_kb(uid))
    await show_account_selection(ctx.bot, chat_id, uid)

# ── Callback queries ──────────────────────────────────────────────────────────
async def on_callback(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    q    = update.callback_query
    uid  = q.from_user.id
    chat_id = q.message.chat.id
    data = q.data or ""

    if data == "cancel_purchase":
        await q.answer("បោះបង់…")
        await cmd_cancel(update, ctx)
        return

    if data.startswith("buy:"):
        cid = data[4:]
        async with _data_lock:
            sess = user_sessions.get(uid)
            if sess and sess.get("state") == "payment_pending":
                await q.answer("អ្នកមានការបញ្ជាទិញដែលកំពុងដំណើរការ", show_alert=True)
                return
        at = _account_type_from_callback_id(cid)
        if not at:
            await q.answer("ប្រភេទនេះអស់ស្តុករួចហើយ", show_alert=True)
            return
        price = accounts_data["prices"].get(at, 0)
        async with _data_lock:
            user_sessions[uid] = {"state": "waiting_for_quantity", "account_type": at, "price": price}
        _save_sessions_sync()
        await q.answer()
        await send_msg(
            ctx.bot, chat_id,
            f"🛒 <b>{html.escape(at)}</b>\n"
            f"💵 តម្លៃ: <b>${price:.2f}</b> / គ្រាប់\n\n"
            f"✏️ <b>សូមបញ្ចូលចំនួនដែលចង់ទិញ:</b>",
            reply_markup=CANCEL_KB,
        )
        return

    if data.startswith("confirm_buy:"):
        qty_str = data[len("confirm_buy:"):]
        async with _data_lock:
            sess = user_sessions.get(uid, {})
        at    = sess.get("account_type")
        price = sess.get("price", 0)
        try:
            qty = int(qty_str)
        except ValueError:
            await q.answer("ចំនួនមិនត្រឹមត្រូវ", show_alert=True)
            return
        if qty < 1:
            await q.answer("ចំនួនត្រូវតែ ≥ 1", show_alert=True)
            return
        total = round(price * qty, 2)
        sess["quantity"]    = qty
        sess["total_price"] = total
        async with _data_lock:
            user_sessions[uid] = sess
        await q.answer()
        await start_payment(ctx.bot, chat_id, uid, sess, callback_query=q)
        return

    await q.answer()

# ── Message router ────────────────────────────────────────────────────────────
async def on_message(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    msg  = update.message
    if not msg or not msg.text:
        return
    uid     = msg.from_user.id
    chat_id = msg.chat.id
    text    = msg.text.strip()

    if _maintenance_mode() and not is_admin(uid):
        await send_msg(ctx.bot, chat_id, "🔧 <b>Bot កំពុង Update…</b>")
        return

    # ── Admin ⚙️ button ───────────────────────────────────────────────────────
    if text == "⚙️ ការកំណត់" and is_admin(uid):
        async with _data_lock:
            user_sessions.pop(uid, None)
        await show_admin_menu(ctx.bot, chat_id)
        return

    # ── Admin panel routing ───────────────────────────────────────────────────
    if is_admin(uid):
        async with _data_lock:
            sess = user_sessions.get(uid, {})
        state = sess.get("state", "")

        # Back / cancel from admin input
        if text in (BTN_BACK, BTN_CANCEL) and state.startswith("admin_"):
            async with _data_lock:
                user_sessions.pop(uid, None)
            _save_sessions_sync()
            await show_admin_menu(ctx.bot, chat_id)
            return

        # Admin input states
        if state.startswith("admin_input:"):
            key = state[len("admin_input:"):]
            await _handle_admin_input(ctx.bot, chat_id, uid, msg.message_id, key, text)
            return

        # Add account — waiting_for_accounts
        if state == "admin_waiting_for_accounts":
            await _handle_accounts_input(ctx.bot, chat_id, uid, text)
            return

        if state == "admin_waiting_for_type":
            await _handle_type_input(ctx.bot, chat_id, uid, text)
            return

        if state == "admin_waiting_for_price":
            await _handle_price_input(ctx.bot, chat_id, uid, text)
            return

        if state == "admin_delete_select":
            await _handle_delete_select(ctx.bot, chat_id, uid, text, sess)
            return

        if state == "admin_delete_confirm":
            await _handle_delete_confirm(ctx.bot, chat_id, uid, text, sess)
            return

        if state == "admin_broadcast_confirm":
            await _handle_broadcast_confirm(ctx.bot, chat_id, uid, text, sess)
            return

        # Main admin panel buttons
        if text == BTN_ADD_ACCOUNT:
            async with _data_lock:
                user_sessions[uid] = {"state": "admin_waiting_for_accounts"}
            _save_sessions_sync()
            await send_msg(ctx.bot, chat_id,
                           "<b>➕ បញ្ចូលកូដគូប៉ុងមួយជួរមួយ:</b>\n\n"
                           "<i>ឧ.:\nCODE-1234\nCODE-5678\nCODE-9012</i>",
                           reply_markup=CANCEL_KB)
            return

        if text == BTN_DELETE_TYPE:
            types = list(accounts_data.get("account_types", {}).keys())
            if not types:
                await send_msg(ctx.bot, chat_id, "⚠️ មិនមានប្រភេទណាទេ", reply_markup=ADMIN_SETTINGS_KB)
                return
            rows = [[KeyboardButton(t)] for t in types]
            rows.append([KeyboardButton(BTN_BACK)])
            async with _data_lock:
                user_sessions[uid] = {"state": "admin_delete_select"}
            _save_sessions_sync()
            await send_msg(ctx.bot, chat_id, "🗑 <b>ជ្រើសរើសប្រភេទដែលចង់លុប:</b>",
                           reply_markup=ReplyKeyboardMarkup(rows, resize_keyboard=True))
            return

        if text == BTN_STOCK:
            await _show_stock(ctx.bot, chat_id)
            return

        if text == BTN_BUYERS:
            await _show_buyers(ctx.bot, chat_id)
            return

        if text == BTN_USERS:
            await _show_users(ctx.bot, chat_id)
            return

        if text == BTN_PAYMENT:
            pay = _get_payment_name()
            async with _data_lock:
                user_sessions[uid] = {"state": "admin_input:payment_name"}
            _save_sessions_sync()
            await send_msg(ctx.bot, chat_id,
                           f"💳 <b>ឈ្មោះ Payment បច្ចុប្បន្ន:</b> <code>{html.escape(pay)}</code>\n\n"
                           f"សូមផ្ញើឈ្មោះថ្មី:",
                           reply_markup=CANCEL_KB)
            return

        if text == BTN_BAKONG:
            tok = _get_bakong_token()
            preview = tok[:10] + "…" if tok else "មិនទាន់មាន"
            async with _data_lock:
                user_sessions[uid] = {"state": "admin_input:bakong_token"}
            _save_sessions_sync()
            await send_msg(ctx.bot, chat_id,
                           f"🔑 <b>Bakong Token:</b> <code>{html.escape(preview)}</code>\n\n"
                           f"សូមផ្ញើ Token ថ្មី:",
                           reply_markup=CANCEL_KB)
            return

        if text == BTN_ADMINS:
            extra = settings.get("EXTRA_ADMIN_IDS", [])
            lines = [f"• <code>{x}</code>" for x in extra] or ["(មិនមី)"]
            async with _data_lock:
                user_sessions[uid] = {"state": "admin_input:admin_action"}
            _save_sessions_sync()
            kb = ReplyKeyboardMarkup([
                [KeyboardButton("➕ Add Admin")],
                [KeyboardButton("➖ Remove Admin")],
                [KeyboardButton(BTN_BACK)],
            ], resize_keyboard=True)
            await send_msg(ctx.bot, chat_id,
                           f"👑 <b>Admin IDs ផ្សេង:</b>\n" + "\n".join(lines) +
                           "\n\nជ្រើសរើស:",
                           reply_markup=kb)
            return

        if text == "➕ Add Admin" and state == "admin_input:admin_action":
            async with _data_lock:
                user_sessions[uid] = {"state": "admin_input:admin_add"}
            await send_msg(ctx.bot, chat_id,
                           "➕ ផ្ញើ <b>User ID</b> ដែលចង់បន្ថែម:", reply_markup=CANCEL_KB)
            return

        if text == "➖ Remove Admin" and state == "admin_input:admin_action":
            async with _data_lock:
                user_sessions[uid] = {"state": "admin_input:admin_remove"}
            await send_msg(ctx.bot, chat_id,
                           "➖ ផ្ញើ <b>User ID</b> ដែលចង់ដក:", reply_markup=CANCEL_KB)
            return

        if text == BTN_MAINTENANCE:
            mode = _maintenance_mode()
            status = "🔴 បិទ" if mode else "🟢 បើក"
            kb = ReplyKeyboardMarkup([
                [KeyboardButton(BTN_MAINT_ON), KeyboardButton(BTN_MAINT_OFF)],
                [KeyboardButton(BTN_BACK)],
            ], resize_keyboard=True)
            await send_msg(ctx.bot, chat_id,
                           f"🛠 <b>ស្ថានភាព Bot:</b> {status}", reply_markup=kb)
            return

        if text == BTN_MAINT_ON:
            set_setting("MAINTENANCE_MODE", True)
            await send_msg(ctx.bot, chat_id, "🔴 <b>Bot ត្រូវបានបិទ (Maintenance)</b>",
                           reply_markup=ADMIN_SETTINGS_KB)
            return

        if text == BTN_MAINT_OFF:
            set_setting("MAINTENANCE_MODE", False)
            await send_msg(ctx.bot, chat_id, "🟢 <b>Bot ត្រូវបានបើក</b>",
                           reply_markup=ADMIN_SETTINGS_KB)
            return

        if text == BTN_BROADCAST:
            async with _data_lock:
                user_sessions[uid] = {"state": "admin_input:broadcast_msg"}
            _save_sessions_sync()
            await send_msg(ctx.bot, chat_id,
                           "📢 <b>ផ្ញើ​សារ​ដែល​ចង់​ផ្សាយ​ទៅ​អ្នក​ប្រើ​ទាំង​អស់:</b>",
                           reply_markup=CANCEL_KB)
            return

        if text == BTN_BACK:
            async with _data_lock:
                user_sessions.pop(uid, None)
            _save_sessions_sync()
            await show_admin_menu(ctx.bot, chat_id)
            return

    # ── User quantity input ───────────────────────────────────────────────────
    async with _data_lock:
        sess = user_sessions.get(uid, {})
    state = sess.get("state", "")

    if state == "waiting_for_quantity":
        if text in (BTN_CANCEL, "/cancel"):
            await cmd_cancel(update, ctx)
            return
        try:
            qty = int(text)
            if qty < 1:
                raise ValueError
        except ValueError:
            await send_msg(ctx.bot, chat_id,
                           "❌ សូមបញ្ចូល<b>លេខ</b>ត្រឹមត្រូវ (ឧ. 1, 2, 3…):", reply_markup=CANCEL_KB)
            return
        at    = sess.get("account_type")
        price = sess.get("price", 0)
        total = round(price * qty, 2)
        sess["quantity"]    = qty
        sess["total_price"] = total
        async with _data_lock:
            user_sessions[uid] = sess

        kb = InlineKeyboardMarkup([[
            InlineKeyboardButton(f"✅ បញ្ជាក់ ${total:.2f}", callback_data=f"confirm_buy:{qty}"),
            InlineKeyboardButton("🚫 បោះបង់",              callback_data="cancel_purchase"),
        ]])
        await send_msg(
            ctx.bot, chat_id,
            f"📋 <b>សង្ខេបការបញ្ជាទិញ</b>\n\n"
            f"🛒 <b>{html.escape(at)}</b> × {qty}\n"
            f"💵 <b>តម្លៃសរុប: ${total:.2f}</b>\n\n"
            f"📱 ចុច <b>បញ្ជាក់</b> ដើម្បីទទួល QR Code ទូទាត់:",
            reply_markup=kb,
        )
        return

    if state == "payment_pending":
        await send_msg(ctx.bot, chat_id,
                       "⏳ <b>សូមបញ្ចប់ការទូទាត់ QR ជាមុនសិន</b>\n"
                       "ឬចុច /cancel ដើម្បីបោះបង់")
        return

    # Default — show menu
    await show_account_selection(ctx.bot, chat_id, uid)

# ── Admin input handlers ──────────────────────────────────────────────────────
async def _handle_admin_input(bot, chat_id, uid, msg_id, key, text):
    if text in (BTN_BACK, BTN_CANCEL):
        async with _data_lock:
            user_sessions.pop(uid, None)
        _save_sessions_sync()
        await show_admin_menu(bot, chat_id)
        return

    if key == "payment_name":
        if not text:
            await send_msg(bot, chat_id, "សូមផ្ញើឈ្មោះ Payment ថ្មី:")
            return
        set_setting("PAYMENT_NAME", text)
        async with _data_lock:
            user_sessions.pop(uid, None)
        _save_sessions_sync()
        await send_msg(bot, chat_id,
                       f"✅ <b>ឈ្មោះ Payment ប្តូរទៅ:</b> {html.escape(text)}",
                       reply_markup=ADMIN_SETTINGS_KB)

    elif key == "bakong_token":
        if not text:
            await send_msg(bot, chat_id, "សូមផ្ញើ Bakong Token ថ្មី:")
            return
        try:
            KHQR(text)
        except Exception as e:
            await send_msg(bot, chat_id, f"❌ Token មិនត្រឹមត្រូវ: <code>{html.escape(str(e))}</code>")
            return
        set_setting("BAKONG_TOKEN", text)
        async with _data_lock:
            user_sessions.pop(uid, None)
        _save_sessions_sync()
        await delete_message(bot, chat_id, msg_id)
        await send_msg(bot, chat_id,
                       f"✅ <b>Bakong Token ថ្មីបានកំណត់</b> (prefix: <code>{html.escape(text[:10])}…</code>)",
                       reply_markup=ADMIN_SETTINGS_KB)

    elif key == "admin_add":
        try:
            target = int(text)
        except ValueError:
            await send_msg(bot, chat_id, "❌ User ID ត្រូវតែជាលេខ")
            return
        extra = list(settings.get("EXTRA_ADMIN_IDS", []))
        if target not in extra:
            extra.append(target)
        set_setting("EXTRA_ADMIN_IDS", extra)
        async with _data_lock:
            user_sessions.pop(uid, None)
        _save_sessions_sync()
        await send_msg(bot, chat_id,
                       f"✅ <b>បន្ថែម Admin:</b> <code>{target}</code>",
                       reply_markup=ADMIN_SETTINGS_KB)

    elif key == "admin_remove":
        try:
            target = int(text)
        except ValueError:
            await send_msg(bot, chat_id, "❌ User ID ត្រូវតែជាលេខ")
            return
        extra = [x for x in settings.get("EXTRA_ADMIN_IDS", []) if x != target]
        set_setting("EXTRA_ADMIN_IDS", extra)
        async with _data_lock:
            user_sessions.pop(uid, None)
        _save_sessions_sync()
        await send_msg(bot, chat_id,
                       f"✅ <b>ដក Admin:</b> <code>{target}</code>",
                       reply_markup=ADMIN_SETTINGS_KB)

    elif key == "broadcast_msg":
        async with _data_lock:
            user_sessions[uid] = {
                "state": "admin_broadcast_confirm",
                "broadcast_text": text,
            }
        _save_sessions_sync()
        kb = ReplyKeyboardMarkup([
            [KeyboardButton(BTN_BCAST_CONFIRM)],
            [KeyboardButton(BTN_BCAST_CANCEL)],
        ], resize_keyboard=True)
        await send_msg(bot, chat_id,
                       f"📢 <b>ព្រមព្រៀងផ្សាយ:</b>\n\n{html.escape(text)}\n\n"
                       f"<i>ការផ្សាយទៅអ្នកប្រើ {len(known_users)} នាក់</i>",
                       reply_markup=kb)

async def _handle_accounts_input(bot, chat_id, uid, text):
    if text in (BTN_BACK, BTN_CANCEL):
        async with _data_lock:
            user_sessions.pop(uid, None)
        _save_sessions_sync()
        await show_admin_menu(bot, chat_id)
        return

    codes = [line.strip() for line in text.strip().splitlines() if line.strip()]
    if not codes:
        await send_msg(bot, chat_id, "❌ មិនឃើញកូដ — ផ្ញើម្ដងទៀត:")
        return

    async with _data_lock:
        user_sessions[uid] = {
            "state": "admin_waiting_for_type",
            "new_accounts": [{"code": c} for c in codes],
        }
    _save_sessions_sync()

    types = list(accounts_data.get("account_types", {}).keys())
    await send_msg(
        bot, chat_id,
        f"✅ <b>ទទួលបាន {len(codes)} គូប៉ុង</b>\n\n"
        f"📁 <b>ប្រភេទ:</b>\n"
        + ("\n".join(f"• {t}" for t in types) or "<i>(មិនទាន់មី — វាយបញ្ចូលថ្មី)</i>") +
        "\n\nសូមវាយ​ or ជ្រើស​ ប្រភេទ:",
        reply_markup=CANCEL_KB,
    )

async def _handle_type_input(bot, chat_id, uid, text):
    if text in (BTN_BACK, BTN_CANCEL):
        async with _data_lock:
            user_sessions.pop(uid, None)
        _save_sessions_sync()
        await show_admin_menu(bot, chat_id)
        return

    async with _data_lock:
        sess = user_sessions.get(uid, {})
        sess["account_type"] = text
        sess["state"] = "admin_waiting_for_price"
        user_sessions[uid] = sess
    _save_sessions_sync()

    existing_price = accounts_data["prices"].get(text)
    if existing_price is not None:
        await send_msg(bot, chat_id,
                       f"💵 <b>ប្រភេទ:</b> {html.escape(text)}\n"
                       f"តម្លៃបច្ចុប្បន្ន: <b>${existing_price:.2f}</b>\n\n"
                       f"ផ្ញើតម្លៃថ្មី ឬ <code>same</code> ដើម្បីរក្សា:",
                       reply_markup=CANCEL_KB)
    else:
        await send_msg(bot, chat_id,
                       f"💵 <b>ប្រភេទ:</b> {html.escape(text)}\n\n"
                       f"ផ្ញើ<b>តម្លៃ</b> (USD) ។ ឧ. <code>1.50</code>:",
                       reply_markup=CANCEL_KB)

async def _handle_price_input(bot, chat_id, uid, text):
    if text in (BTN_BACK, BTN_CANCEL):
        async with _data_lock:
            user_sessions.pop(uid, None)
        _save_sessions_sync()
        await show_admin_menu(bot, chat_id)
        return

    async with _data_lock:
        sess = user_sessions.get(uid, {})
    at    = sess.get("account_type", "")
    codes = sess.get("new_accounts", [])

    existing_price = accounts_data["prices"].get(at)
    if text.lower() == "same" and existing_price is not None:
        price = existing_price
    else:
        try:
            price = round(float(text.replace("$", "").strip()), 2)
            if price < 0:
                raise ValueError
        except ValueError:
            await send_msg(bot, chat_id,
                           "❌ តម្លៃមិនត្រឹមត្រូវ — ផ្ញើ​ ឧ. <code>1.50</code>:")
            return

    async with _data_lock:
        accounts_data["account_types"].setdefault(at, [])
        all_existing = {
            a.get("code", "").lower()
            for accs in accounts_data["account_types"].values()
            for a in accs
        }
        new = [c for c in codes if c.get("code", "").lower() not in all_existing]
        dupes = len(codes) - len(new)
        accounts_data["account_types"][at].extend(new)
        accounts_data["prices"][at] = price
        user_sessions.pop(uid, None)
    _save_accounts_sync()
    _save_sessions_sync()

    msg = (
        f"✅ <b>បន្ថែមជោគជ័យ!</b>\n\n"
        f"📁 ប្រភេទ: <b>{html.escape(at)}</b>\n"
        f"💵 តម្លៃ: <b>${price:.2f}</b>\n"
        f"🆕 បន្ថែម: <b>{len(new)}</b> គូប៉ុង\n"
    )
    if dupes:
        msg += f"⚠️ ដដែល (រំលង): <b>{dupes}</b>\n"
    msg += f"📦 ស្តុកសរុប: <b>{len(accounts_data['account_types'][at])}</b>"
    await send_msg(bot, chat_id, msg, reply_markup=ADMIN_SETTINGS_KB)

async def _handle_delete_select(bot, chat_id, uid, text, sess):
    if text in (BTN_BACK, BTN_CANCEL):
        async with _data_lock:
            user_sessions.pop(uid, None)
        _save_sessions_sync()
        await show_admin_menu(bot, chat_id)
        return
    types = list(accounts_data.get("account_types", {}).keys())
    if text not in types:
        await send_msg(bot, chat_id, "❌ ប្រភេទមិនត្រឹម — ជ្រើសពីបញ្ជី")
        return
    async with _data_lock:
        user_sessions[uid] = {"state": "admin_delete_confirm", "type_name": text}
    _save_sessions_sync()
    count = len(accounts_data["account_types"].get(text, []))
    price = accounts_data["prices"].get(text, 0)
    kb = ReplyKeyboardMarkup([
        [KeyboardButton(BTN_DELETE_CONFIRM)],
        [KeyboardButton(BTN_DELETE_CANCEL)],
    ], resize_keyboard=True)
    await send_msg(bot, chat_id,
                   f"⚠️ <b>លុបប្រភេទ?</b>\n\n"
                   f"📁 <b>{html.escape(text)}</b>\n"
                   f"📦 ស្តុក: {count} | 💵 ${price:.2f}\n\n"
                   f"ការលុបនឹងដក​គូប៉ុងទាំងអស់ចេញ!",
                   reply_markup=kb)

async def _handle_delete_confirm(bot, chat_id, uid, text, sess):
    type_name = sess.get("type_name")
    if text == BTN_DELETE_CONFIRM and type_name:
        async with _data_lock:
            count = len(accounts_data["account_types"].pop(type_name, []))
            accounts_data["prices"].pop(type_name, None)
            user_sessions.pop(uid, None)
        _save_accounts_sync()
        _save_sessions_sync()
        await send_msg(bot, chat_id,
                       f"✅ <b>លុបបានសម្រេច:</b> <code>{html.escape(type_name)}</code> ({count} records)",
                       reply_markup=ADMIN_SETTINGS_KB)
    else:
        async with _data_lock:
            user_sessions.pop(uid, None)
        _save_sessions_sync()
        await send_msg(bot, chat_id, "🚫 <b>បោះបង់ការលុប</b>", reply_markup=ADMIN_SETTINGS_KB)

async def _handle_broadcast_confirm(bot, chat_id, uid, text, sess):
    broadcast_text = sess.get("broadcast_text", "")
    async with _data_lock:
        user_sessions.pop(uid, None)
    _save_sessions_sync()

    if text == BTN_BCAST_CONFIRM:
        await send_msg(bot, chat_id, "📢 <b>កំពុងផ្សាយ…</b>", reply_markup=ADMIN_SETTINGS_KB)
        asyncio.create_task(_do_broadcast(bot, chat_id, broadcast_text))
    else:
        await send_msg(bot, chat_id, "🚫 <b>បោះបង់ការផ្សាយ</b>", reply_markup=ADMIN_SETTINGS_KB)

async def _do_broadcast(bot, admin_chat_id, text):
    sent = failed = 0
    for uid_str in list(known_users.keys()):
        try:
            uid = int(uid_str)
            await bot.send_message(uid, text, parse_mode=ParseMode.HTML)
            sent += 1
        except Exception:
            failed += 1
        await asyncio.sleep(0.05)
    await send_msg(bot, admin_chat_id,
                   f"📢 <b>ផ្សាយចប់!</b>\n✅ ជោគជ័យ: {sent}\n❌ បរាជ័យ: {failed}")

# ── Admin info displays ───────────────────────────────────────────────────────
async def _show_stock(bot, chat_id):
    lines = ["📦 <b>ស្តុកបច្ចុប្បន្ន:</b>\n"]
    total = 0
    for at, accs in accounts_data.get("account_types", {}).items():
        price = accounts_data["prices"].get(at, 0)
        cnt = len(accs)
        total += cnt
        lines.append(f"• <b>{html.escape(at)}</b>: {cnt} | ${price:.2f}/គ្រាប់")
    if total == 0:
        lines.append("<i>ស្តុកទទេ</i>")
    lines.append(f"\n📊 <b>សរុប: {total} គូប៉ុង</b>")
    await send_msg(bot, chat_id, "\n".join(lines), reply_markup=ADMIN_SETTINGS_KB)

async def _show_buyers(bot, chat_id):
    if not purchase_history:
        await send_msg(bot, chat_id, "📋 <b>មិនទាន់មានការទិញ</b>", reply_markup=ADMIN_SETTINGS_KB)
        return
    recent = purchase_history[-20:]
    lines = [f"📋 <b>ការទិញ ({len(purchase_history)} សរុប):</b>\n"]
    for p in reversed(recent):
        dt = p.get("paid_at", "")[:10]
        lines.append(
            f"• {html.escape(p.get('account_type', ''))} ×{p.get('quantity',1)} "
            f"${p.get('total_price',0):.2f} — user {p.get('user_id')} [{dt}]"
        )
    await send_msg(bot, chat_id, "\n".join(lines), reply_markup=ADMIN_SETTINGS_KB)

async def _show_users(bot, chat_id):
    count = len(known_users)
    lines = [f"👥 <b>អ្នកប្រើប្រាស់ ({count}):</b>\n"]
    for uid_str, info in list(known_users.items())[:30]:
        full = f"{info.get('first_name','')} {info.get('last_name','')}".strip() or "N/A"
        uname = f"@{info['username']}" if info.get("username") else "—"
        lines.append(f"• <code>{uid_str}</code> {html.escape(full)} {html.escape(uname)}")
    if count > 30:
        lines.append(f"\n<i>… និង {count - 30} ទៀត</i>")
    await send_msg(bot, chat_id, "\n".join(lines), reply_markup=ADMIN_SETTINGS_KB)

# ── Main ──────────────────────────────────────────────────────────────────────
async def post_init(app: Application):
    global accounts_data, settings, known_users, purchase_history

    settings        = _load_settings()
    loaded_accounts = _load_accounts()
    accounts_data.update(loaded_accounts)
    known_users.update(_load_users())
    purchase_history.extend(_load_purchases())

    sess = _load_sessions_from_disk()
    for k, v in sess.items():
        try:
            user_sessions[int(k)] = v
        except ValueError:
            pass

    logger.info(
        f"Loaded: {sum(len(v) for v in accounts_data['account_types'].values())} coupons, "
        f"{len(known_users)} users, {len(purchase_history)} purchases"
    )
    me = await app.bot.get_me()
    logger.info(f"Bot ready: @{me.username}")
    try:
        await app.bot.send_message(ADMIN_ID, "✅ <b>Bot ចាប់ផ្ដើម!</b>", parse_mode=ParseMode.HTML)
    except Exception:
        pass

def main():
    app = (
        ApplicationBuilder()
        .token(BOT_TOKEN)
        .post_init(post_init)
        .concurrent_updates(True)
        .build()
    )
    app.add_handler(CommandHandler("start",  cmd_start))
    app.add_handler(CommandHandler("cancel", cmd_cancel))
    app.add_handler(CallbackQueryHandler(on_callback))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, on_message))

    logger.info("Starting bot polling…")
    app.run_polling(drop_pending_updates=True, allowed_updates=["message", "callback_query"])

if __name__ == "__main__":
    main()
