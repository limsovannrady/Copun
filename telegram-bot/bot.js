import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import QRCode from "qrcode";
import { Telegraf, Markup } from "telegraf";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Config ────────────────────────────────────────────────────────────────────
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error("[ERROR] TELEGRAM_BOT_TOKEN is not set. Exiting.");
  process.exit(1);
}

const ADMIN_ID = 5002402843;
const PAYMENT_TIMEOUT_SEC = 60;
const PAYMENT_POLL_INTERVAL_SEC = 5;

// ── Data directory ────────────────────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const FILES = {
  accounts: path.join(DATA_DIR, "accounts.json"),
  sessions: path.join(DATA_DIR, "sessions.json"),
  settings: path.join(DATA_DIR, "settings.json"),
  users:    path.join(DATA_DIR, "users.json"),
  purchases: path.join(DATA_DIR, "purchases.json"),
};

// ── In-memory state ───────────────────────────────────────────────────────────
let accounts  = { account_types: {}, prices: {} };
let sessions  = {};   // { [userId]: sessionObj }
let settings  = {};
let users     = {};   // { [userId]: { first_name, last_name, username } }
let purchases = [];
const notifiedUsers = new Set();

// ── JSON helpers ──────────────────────────────────────────────────────────────
function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return fallback; }
}
function writeJSON(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8"); }
  catch (e) { console.error(`[WARN] writeJSON ${file}: ${e.message}`); }
}
const saveAccounts  = () => writeJSON(FILES.accounts, accounts);
const saveSessions  = () => writeJSON(FILES.sessions, sessions);
const saveSettings  = () => writeJSON(FILES.settings, settings);
const saveUsers     = () => writeJSON(FILES.users, users);
const savePurchases = () => writeJSON(FILES.purchases, purchases);

function getSetting(key, def = null) { return settings[key] ?? def; }
function setSetting(key, value) { settings[key] = value; saveSettings(); }

// ── KHQR helpers ──────────────────────────────────────────────────────────────
function crc16(str) {
  let crc = 0xffff;
  for (const ch of Buffer.from(str, "utf8")) {
    crc ^= ch << 8;
    for (let i = 0; i < 8; i++)
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

function tlv(tag, value) {
  return `${tag}${String(value.length).padStart(2, "0")}${value}`;
}

function buildKHQR(bankAccount, merchantName, amount) {
  const name = merchantName.replace(/[^A-Za-z0-9 ]/g, "").substring(0, 25).toUpperCase() || "MERCHANT";
  const city = "PHNOMPENH";
  const merchantInfo = tlv("00", "com.bakong.nbc.gov.kh") + tlv("01", bankAccount);
  const payload =
    tlv("00", "01") +
    tlv("01", "12") +
    tlv("26", merchantInfo) +
    tlv("52", "5999") +
    tlv("53", "840") +
    tlv("54", amount.toFixed(2)) +
    tlv("58", "KH") +
    tlv("59", name) +
    tlv("60", city) +
    "6304";
  return payload + crc16(payload);
}

async function generatePaymentQR(amount) {
  const bankAccount = getSetting("BANK_ACCOUNT", "12345678@abanka");
  const payName     = getSetting("PAYMENT_NAME", "RADY");
  const qrString    = buildKHQR(bankAccount, payName, amount);
  const md5         = crypto.createHash("md5").update(qrString).digest("hex");
  try {
    const imgBuffer = await QRCode.toBuffer(qrString, {
      errorCorrectionLevel: "M",
      width: 400,
      margin: 2,
    });
    return { imgBuffer, md5, qrString, error: null };
  } catch (e) {
    return { imgBuffer: null, md5: null, qrString, error: e.message };
  }
}

async function checkPaymentStatus(md5) {
  const tok = getSetting("BAKONG_TOKEN", process.env.BAKONG_TOKEN || "");
  if (!tok) return { paid: false, data: null };
  const base = tok.startsWith("rbk")
    ? "https://api.bakongrelay.com/v1"
    : "https://api-bakong.nbc.gov.kh/v1";
  try {
    const res = await fetch(`${base}/check_transaction_by_md5`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: JSON.stringify({ md5 }),
    });
    const json = await res.json();
    if (json.responseCode === 0) return { paid: true, data: json.data ?? null };
  } catch (e) {
    console.warn(`[WARN] Payment check: ${e.message}`);
  }
  return { paid: false, data: null };
}

// ── Admin / state helpers ─────────────────────────────────────────────────────
function isAdmin(uid) {
  const extra = getSetting("EXTRA_ADMIN_IDS", []);
  return Number(uid) === ADMIN_ID || extra.map(Number).includes(Number(uid));
}

function typeCallbackId(accountType) {
  return crypto.createHash("sha1").update(accountType).digest("hex").slice(0, 12);
}

function typeFromCallbackId(cid) {
  return Object.keys(accounts.account_types).find((t) => typeCallbackId(t) === cid) ?? null;
}

function mainKb(uid) {
  return isAdmin(uid)
    ? Markup.keyboard([["⚙️ ការកំណត់"]]).resize().persistent()
    : Markup.removeKeyboard();
}

function maintenanceMode() {
  return Boolean(getSetting("MAINTENANCE_MODE", false));
}

// ── Keyboards ─────────────────────────────────────────────────────────────────
const ADMIN_SETTINGS_KB = Markup.keyboard([
  ["➕ បន្ថែម គូប៉ុង",  "🗑 លុបប្រភេទ"],
  ["📦 ស្តុក គូប៉ុង",    "📋 របាយការណ៍ទិញ"],
  ["👥 អ្នកប្រើប្រាស់",  "💳 ឈ្មោះ Payment"],
  ["🔑 Bakong Token",    "👑 គ្រប់គ្រង Admin"],
  ["🛠 Maintenance Mode","📢 ផ្សាយព័ត៌មាន"],
]).resize().persistent();

const CANCEL_KB = Markup.keyboard([["🚫 បោះបង់"]]).resize();
const BACK_KB   = Markup.keyboard([["⬅️ ត្រឡប់"]]).resize();

const CANCEL_PURCHASE_INLINE = Markup.inlineKeyboard([
  Markup.button.callback("🚫 បោះបង់", "cancel_purchase"),
]);

const ADMIN_BTN_SET = new Set([
  "➕ បន្ថែម គូប៉ុង","🗑 លុបប្រភេទ","📦 ស្តុក គូប៉ុង","📋 របាយការណ៍ទិញ",
  "👥 អ្នកប្រើប្រាស់","💳 ឈ្មោះ Payment","🔑 Bakong Token","👑 គ្រប់គ្រង Admin",
  "🛠 Maintenance Mode","📢 ផ្សាយព័ត៌មាន","⬅️ ត្រឡប់","🚫 បោះបង់",
  "✅ បញ្ជាក់លុប","🚫 បោះបង់ការលុប","✅ បញ្ជាក់ផ្សាយ","🚫 បោះបង់ការផ្សាយ",
  "🔴 បិទ Bot","🟢 បើក Bot","➕ Add Admin","➖ Remove Admin",
]);

// ── Send helpers ──────────────────────────────────────────────────────────────
async function sendMsg(ctx, chatId, text, extra = {}) {
  try {
    return await ctx.telegram.sendMessage(chatId, text, {
      parse_mode: "HTML", ...extra,
    });
  } catch (e) {
    console.warn(`[WARN] sendMsg(${chatId}): ${e.message}`);
  }
}

async function sendPhoto(ctx, chatId, buffer, caption = "", extra = {}) {
  try {
    return await ctx.telegram.sendPhoto(chatId, { source: buffer }, {
      caption, parse_mode: "HTML", ...extra,
    });
  } catch (e) {
    console.warn(`[WARN] sendPhoto(${chatId}): ${e.message}`);
  }
}

async function deleteMsg(ctx, chatId, messageId) {
  try { await ctx.telegram.deleteMessage(chatId, messageId); } catch {}
}

// ── Notify admin of new user ──────────────────────────────────────────────────
async function notifyAdminNewUser(ctx, user) {
  const uid = user.id;
  if (uid === ADMIN_ID || notifiedUsers.has(uid) || users[uid]) return;
  notifiedUsers.add(uid);
  users[String(uid)] = {
    first_name: user.first_name || "",
    last_name:  user.last_name  || "",
    username:   user.username   || "",
  };
  saveUsers();
  const full  = [user.first_name, user.last_name].filter(Boolean).join(" ") || "N/A";
  const uname = user.username ? `@${user.username}` : "—";
  await sendMsg(ctx, ADMIN_ID,
    `🆕 <b>អ្នកប្រើប្រាស់ថ្មី!</b>\n\n` +
    `👤 ឈ្មោះ: ${esc(full)}\n` +
    `🔖 Username: ${esc(uname)}\n` +
    `🪪 ID: <code>${uid}</code>`);
}

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ── Show account selection ────────────────────────────────────────────────────
async function showAccountSelection(ctx, chatId, uid) {
  const available = Object.entries(accounts.account_types)
    .filter(([, accs]) => accs.length > 0)
    .map(([at, accs]) => ({ at, count: accs.length, price: accounts.prices[at] ?? 0 }));

  if (!available.length) {
    await sendMsg(ctx, chatId, "😔 <i>សូមអភ័យទោស អស់ពីស្តុក</i>", mainKb(uid));
    return;
  }

  const buttons = available.map(({ at, count, price }) =>
    [Markup.button.callback(
      `${at}  [ $${price.toFixed(2)} ]  ស្តុក: ${count}`,
      `buy:${typeCallbackId(at)}`
    )]
  );
  await sendMsg(ctx, chatId, "<b>🛒 ជ្រើសរើសគូប៉ុងដើម្បីទិញ៖</b>",
    Markup.inlineKeyboard(buttons));
}

async function showAdminMenu(ctx, chatId) {
  await sendMsg(ctx, chatId,
    "<b>⚙️ ការកំណត់ Admin</b>\n\nជ្រើសរើសប្រតិបត្តិការ:",
    ADMIN_SETTINGS_KB);
}

// ── Payment flow ──────────────────────────────────────────────────────────────
async function startPayment(ctx, chatId, uid, sess, cbQuery = null) {
  const { account_type, quantity } = sess;
  const pool = accounts.account_types[account_type] ?? [];

  if (pool.length < quantity) {
    if (cbQuery) await cbQuery.answerCbQuery(`មានត្រឹមតែ ${pool.length} គូប៉ុងប៉ុណ្ណោះ`, { show_alert: true });
    delete sessions[uid]; saveSessions();
    return false;
  }

  const reserved = pool.slice(0, quantity);
  accounts.account_types[account_type] = pool.slice(quantity);
  sess.reserved_accounts = reserved;
  saveAccounts();

  if (cbQuery) { try { await cbQuery.answerCbQuery("កំពុងបង្កើត QR…"); } catch {} }

  sess.state = "payment_pending";
  const { imgBuffer, md5, error } = await generatePaymentQR(sess.total_price);

  if (!imgBuffer) {
    await sendMsg(ctx, chatId, "❌ <b>មានបញ្ហាក្នុងការបង្កើត QR Code</b>\n\nសូមព្យាយាមម្ដងទៀត។");
    await sendMsg(ctx, ADMIN_ID, `⚠️ QR Error (user ${uid}): <code>${esc(String(error))}</code>`);
    accounts.account_types[account_type] = [...reserved, ...accounts.account_types[account_type]];
    saveAccounts();
    delete sessions[uid]; saveSessions();
    return false;
  }

  sess.md5_hash   = md5;
  sess.qr_sent_at = Date.now();

  const caption =
    `💳 <b>ការទូទាត់ KHQR</b>\n\n` +
    `🛒 <b>${esc(account_type)}</b> × ${quantity}\n` +
    `💵 <b>$${sess.total_price.toFixed(2)}</b>\n\n` +
    `⏱ QR Code មានសុពលភាព ${PAYMENT_TIMEOUT_SEC} វិនាទី\n` +
    `👆 ស្កែន QR ហើយទូទាត់ភ្លាមៗ`;

  const photoMsg = await sendPhoto(ctx, chatId, imgBuffer, caption, CANCEL_PURCHASE_INLINE);
  if (photoMsg) sess.photo_message_id = photoMsg.message_id;

  sessions[uid] = sess;
  saveSessions();

  // Start polling
  pollPayment(ctx, chatId, uid, md5, sess);
  return true;
}

function pollPayment(ctx, chatId, uid, md5, sess) {
  const deadline = sess.qr_sent_at + PAYMENT_TIMEOUT_SEC * 1000;

  const timer = setInterval(async () => {
    const cur = sessions[uid];
    if (!cur || cur.state !== "payment_pending" || cur.md5_hash !== md5) {
      clearInterval(timer);
      return;
    }

    if (Date.now() > deadline) {
      clearInterval(timer);
      await expirePayment(ctx, chatId, uid, cur);
      return;
    }

    const { paid, data } = await checkPaymentStatus(md5);
    if (paid) {
      clearInterval(timer);
      await deliverAccounts(ctx, chatId, uid, cur, data);
    }
  }, PAYMENT_POLL_INTERVAL_SEC * 1000);
}

async function expirePayment(ctx, chatId, uid, sess) {
  const { account_type, reserved_accounts = [] } = sess;
  if (reserved_accounts.length && account_type) {
    accounts.account_types[account_type] = [
      ...reserved_accounts,
      ...(accounts.account_types[account_type] ?? []),
    ];
    saveAccounts();
  }
  if (sess.photo_message_id) await deleteMsg(ctx, chatId, sess.photo_message_id);
  delete sessions[uid]; saveSessions();
  await sendMsg(ctx, chatId,
    "⏰ <b>QR Code ផុតកំណត់</b>\n\nការទូទាត់មិនបានទទួលក្នុងពេលវេលា។ " +
    "ចុច /start ដើម្បីចាប់ផ្ដើមឡើងវិញ។",
    mainKb(uid));
}

async function deliverAccounts(ctx, chatId, uid, sess, paymentData = null) {
  delete sessions[uid]; saveSessions();

  const { reserved_accounts = [], account_type = "", quantity = 1, total_price = 0 } = sess;

  purchases.push({
    user_id: uid,
    account_type,
    quantity,
    total_price,
    delivered: reserved_accounts,
    paid_at: new Date().toISOString(),
  });
  savePurchases();

  const lines = [
    `✅ <b>ការទូទាត់ជោគជ័យ!</b>\n`,
    `🛒 <b>${esc(account_type)}</b> × ${quantity}`,
    `💵 បានទូទាត់: <b>$${total_price.toFixed(2)}</b>\n`,
    "━━━━━━━━━━━━━━━━━━━━━",
    "<b>🎫 គូប៉ុងរបស់អ្នក:</b>\n",
    ...reserved_accounts.map((a, i) => `${i + 1}. <code>${esc(a.code ?? a.email ?? JSON.stringify(a))}</code>`),
    "\n━━━━━━━━━━━━━━━━━━━━━",
    "🙏 <b>សូមអរគុណ!</b> ចុច /start ដើម្បីទិញបន្ថែម",
  ];

  if (sess.photo_message_id) await deleteMsg(ctx, chatId, sess.photo_message_id);
  await sendMsg(ctx, chatId, lines.join("\n"), mainKb(uid));
  await sendMsg(ctx, ADMIN_ID,
    `💰 <b>ការលក់ថ្មី!</b>\n` +
    `👤 User: <code>${uid}</code>\n` +
    `🛒 ${esc(account_type)} × ${quantity}\n` +
    `💵 $${total_price.toFixed(2)}`);
}

// ── Bot setup ─────────────────────────────────────────────────────────────────
const bot = new Telegraf(BOT_TOKEN);

// /start
bot.command("start", async (ctx) => {
  const uid     = ctx.from.id;
  const chatId  = ctx.chat.id;
  notifyAdminNewUser(ctx, ctx.from).catch(() => {});

  if (maintenanceMode() && !isAdmin(uid)) {
    return sendMsg(ctx, chatId, "🔧 <b>Bot កំពុង Update សូមរង់ចាំមួយភ្លែត…</b>");
  }
  const sess = sessions[uid];
  if (sess?.state === "payment_pending") {
    return sendMsg(ctx, chatId,
      "⏳ <b>អ្នកមានការបញ្ជាទិញកំពុងដំណើរការ។</b>\n" +
      "ចុច /cancel ដើម្បីបោះបង់ ឬបញ្ចប់ការទូទាត់ជាមុនសិន។");
  }
  delete sessions[uid];
  await showAccountSelection(ctx, chatId, uid);
});

// /cancel
bot.command("cancel", async (ctx) => {
  const uid    = ctx.from.id;
  const chatId = ctx.chat.id;
  const sess   = sessions[uid];
  if (sess) {
    const { account_type, reserved_accounts = [] } = sess;
    if (reserved_accounts.length && account_type) {
      accounts.account_types[account_type] = [
        ...reserved_accounts,
        ...(accounts.account_types[account_type] ?? []),
      ];
      saveAccounts();
    }
    if (sess.photo_message_id) await deleteMsg(ctx, chatId, sess.photo_message_id);
    delete sessions[uid]; saveSessions();
  }
  await sendMsg(ctx, chatId, "🚫 <b>បានបោះបង់</b>", mainKb(uid));
  await showAccountSelection(ctx, chatId, uid);
});

// ── Callback queries ──────────────────────────────────────────────────────────
bot.on("callback_query", async (ctx) => {
  const data   = ctx.callbackQuery.data ?? "";
  const uid    = ctx.from.id;
  const chatId = ctx.callbackQuery.message?.chat?.id ?? ctx.chat.id;

  if (data === "cancel_purchase") {
    await ctx.answerCbQuery("បោះបង់…");
    // re-use cancel logic
    const sess = sessions[uid];
    if (sess) {
      const { account_type, reserved_accounts = [] } = sess;
      if (reserved_accounts.length && account_type) {
        accounts.account_types[account_type] = [
          ...reserved_accounts,
          ...(accounts.account_types[account_type] ?? []),
        ];
        saveAccounts();
      }
      if (sess.photo_message_id) await deleteMsg(ctx, chatId, sess.photo_message_id);
      delete sessions[uid]; saveSessions();
    }
    await sendMsg(ctx, chatId, "🚫 <b>បានបោះបង់</b>", mainKb(uid));
    await showAccountSelection(ctx, chatId, uid);
    return;
  }

  if (data.startsWith("buy:")) {
    const sess = sessions[uid];
    if (sess?.state === "payment_pending") {
      return ctx.answerCbQuery("អ្នកមានការបញ្ជាទិញដែលកំពុងដំណើរការ", { show_alert: true });
    }
    const at = typeFromCallbackId(data.slice(4));
    if (!at) return ctx.answerCbQuery("ប្រភេទនេះអស់ស្តុករួចហើយ", { show_alert: true });

    const price = accounts.prices[at] ?? 0;
    sessions[uid] = { state: "waiting_for_quantity", account_type: at, price };
    saveSessions();
    await ctx.answerCbQuery();
    return sendMsg(ctx, chatId,
      `🛒 <b>${esc(at)}</b>\n💵 តម្លៃ: <b>$${price.toFixed(2)}</b> / គ្រាប់\n\n` +
      `✏️ <b>សូមបញ្ចូលចំនួនដែលចង់ទិញ:</b>`,
      CANCEL_KB);
  }

  if (data.startsWith("confirm_buy:")) {
    const qty  = parseInt(data.slice("confirm_buy:".length), 10);
    const sess = sessions[uid] ?? {};
    const at    = sess.account_type;
    const price = sess.price ?? 0;
    if (!at || isNaN(qty) || qty < 1) return ctx.answerCbQuery("ចំនួនមិនត្រឹមត្រូវ", { show_alert: true });

    sess.quantity    = qty;
    sess.total_price = Math.round(price * qty * 100) / 100;
    sessions[uid]    = sess;
    await ctx.answerCbQuery();
    await startPayment(ctx, chatId, uid, sess, ctx);
    return;
  }

  await ctx.answerCbQuery();
});

// ── Text message router ───────────────────────────────────────────────────────
bot.on("text", async (ctx) => {
  const uid    = ctx.from.id;
  const chatId = ctx.chat.id;
  const text   = ctx.message.text.trim();

  if (maintenanceMode() && !isAdmin(uid)) {
    return sendMsg(ctx, chatId, "🔧 <b>Bot កំពុង Update…</b>");
  }

  // ⚙️ Admin panel toggle
  if (text === "⚙️ ការកំណត់" && isAdmin(uid)) {
    delete sessions[uid];
    return showAdminMenu(ctx, chatId);
  }

  if (isAdmin(uid)) {
    const sess  = sessions[uid] ?? {};
    const state = sess.state ?? "";

    // Back / Cancel from any admin state
    if ((text === "⬅️ ត្រឡប់" || text === "🚫 បោះបង់") && state.startsWith("admin_")) {
      delete sessions[uid]; saveSessions();
      return showAdminMenu(ctx, chatId);
    }

    // Admin input states
    if (state.startsWith("admin_input:")) {
      return handleAdminInput(ctx, chatId, uid, ctx.message.message_id, state.slice("admin_input:".length), text);
    }
    if (state === "admin_waiting_for_accounts") return handleAccountsInput(ctx, chatId, uid, text);
    if (state === "admin_waiting_for_type")     return handleTypeInput(ctx, chatId, uid, text);
    if (state === "admin_waiting_for_price")    return handlePriceInput(ctx, chatId, uid, text);
    if (state === "admin_delete_select")        return handleDeleteSelect(ctx, chatId, uid, text, sess);
    if (state === "admin_delete_confirm")       return handleDeleteConfirm(ctx, chatId, uid, text, sess);
    if (state === "admin_broadcast_confirm")    return handleBroadcastConfirm(ctx, chatId, uid, text, sess);

    // Main admin panel buttons
    switch (text) {
      case "➕ បន្ថែម គូប៉ុង":
        sessions[uid] = { state: "admin_waiting_for_accounts" }; saveSessions();
        return sendMsg(ctx, chatId,
          "<b>➕ បញ្ចូលកូដគូប៉ុងមួយជួរមួយ:</b>\n\n<i>ឧ.:\nCODE-1234\nCODE-5678</i>",
          CANCEL_KB);

      case "🗑 លុបប្រភេទ": {
        const types = Object.keys(accounts.account_types);
        if (!types.length) return sendMsg(ctx, chatId, "⚠️ មិនមានប្រភេទណាទេ", ADMIN_SETTINGS_KB);
        sessions[uid] = { state: "admin_delete_select" }; saveSessions();
        return sendMsg(ctx, chatId, "🗑 <b>ជ្រើសរើសប្រភេទដែលចង់លុប:</b>",
          Markup.keyboard([...types.map((t) => [t]), [["⬅️ ត្រឡប់"]]]).resize());
      }

      case "📦 ស្តុក គូប៉ុង":   return showStock(ctx, chatId);
      case "📋 របាយការណ៍ទិញ": return showBuyers(ctx, chatId);
      case "👥 អ្នកប្រើប្រាស់": return showUsers(ctx, chatId);

      case "💳 ឈ្មោះ Payment":
        sessions[uid] = { state: "admin_input:payment_name" }; saveSessions();
        return sendMsg(ctx, chatId,
          `💳 <b>ឈ្មោះ Payment:</b> <code>${esc(getSetting("PAYMENT_NAME","RADY"))}</code>\n\nផ្ញើឈ្មោះថ្មី:`,
          CANCEL_KB);

      case "🔑 Bakong Token": {
        const tok = getSetting("BAKONG_TOKEN", "");
        sessions[uid] = { state: "admin_input:bakong_token" }; saveSessions();
        return sendMsg(ctx, chatId,
          `🔑 <b>Bakong Token:</b> <code>${tok ? tok.slice(0, 10) + "…" : "មិនទាន់មាន"}</code>\n\nផ្ញើ Token ថ្មី:`,
          CANCEL_KB);
      }

      case "👑 គ្រប់គ្រង Admin": {
        const extra = getSetting("EXTRA_ADMIN_IDS", []);
        const list  = extra.length ? extra.map((x) => `• <code>${x}</code>`).join("\n") : "(មិនមី)";
        sessions[uid] = { state: "admin_input:admin_action" }; saveSessions();
        return sendMsg(ctx, chatId, `👑 <b>Admin IDs ផ្សេង:</b>\n${list}\n\nជ្រើសរើស:`,
          Markup.keyboard([["➕ Add Admin"], ["➖ Remove Admin"], ["⬅️ ត្រឡប់"]]).resize());
      }

      case "➕ Add Admin":
        if (state === "admin_input:admin_action") {
          sessions[uid] = { state: "admin_input:admin_add" }; saveSessions();
          return sendMsg(ctx, chatId, "➕ ផ្ញើ <b>User ID</b> ដែលចង់បន្ថែម:", CANCEL_KB);
        }
        break;

      case "➖ Remove Admin":
        if (state === "admin_input:admin_action") {
          sessions[uid] = { state: "admin_input:admin_remove" }; saveSessions();
          return sendMsg(ctx, chatId, "➖ ផ្ញើ <b>User ID</b> ដែលចង់ដក:", CANCEL_KB);
        }
        break;

      case "🛠 Maintenance Mode": {
        const on = maintenanceMode();
        return sendMsg(ctx, chatId, `🛠 <b>ស្ថានភាព Bot:</b> ${on ? "🔴 បិទ" : "🟢 បើក"}`,
          Markup.keyboard([["🔴 បិទ Bot", "🟢 បើក Bot"], ["⬅️ ត្រឡប់"]]).resize());
      }
      case "🔴 បិទ Bot": setSetting("MAINTENANCE_MODE", true);
        return sendMsg(ctx, chatId, "🔴 <b>Bot ត្រូវបានបិទ (Maintenance)</b>", ADMIN_SETTINGS_KB);
      case "🟢 បើក Bot": setSetting("MAINTENANCE_MODE", false);
        return sendMsg(ctx, chatId, "🟢 <b>Bot ត្រូវបានបើក</b>", ADMIN_SETTINGS_KB);

      case "📢 ផ្សាយព័ត៌មាន":
        sessions[uid] = { state: "admin_input:broadcast_msg" }; saveSessions();
        return sendMsg(ctx, chatId,
          "📢 <b>ផ្ញើ​សារ​ដែល​ចង់​ផ្សាយ​ទៅ​អ្នក​ប្រើ​ទាំង​អស់:</b>", CANCEL_KB);

      case "⬅️ ត្រឡប់":
        delete sessions[uid]; saveSessions();
        return showAdminMenu(ctx, chatId);
    }
  }

  // ── User quantity input ───────────────────────────────────────────────────
  const sess  = sessions[uid] ?? {};
  const state = sess.state ?? "";

  if (state === "waiting_for_quantity") {
    if (text === "🚫 បោះបង់" || text === "/cancel") {
      delete sessions[uid]; saveSessions();
      await sendMsg(ctx, chatId, "🚫 <b>បានបោះបង់</b>", mainKb(uid));
      return showAccountSelection(ctx, chatId, uid);
    }
    const qty = parseInt(text, 10);
    if (isNaN(qty) || qty < 1) {
      return sendMsg(ctx, chatId, "❌ សូមបញ្ចូល<b>លេខ</b>ត្រឹមត្រូវ (ឧ. 1, 2, 3…):", CANCEL_KB);
    }
    const { account_type: at, price = 0 } = sess;
    const total = Math.round(price * qty * 100) / 100;
    sess.quantity    = qty;
    sess.total_price = total;
    sessions[uid]    = sess;

    return sendMsg(ctx, chatId,
      `📋 <b>សង្ខេបការបញ្ជាទិញ</b>\n\n` +
      `🛒 <b>${esc(at)}</b> × ${qty}\n` +
      `💵 <b>តម្លៃសរុប: $${total.toFixed(2)}</b>\n\n` +
      `📱 ចុច <b>បញ្ជាក់</b> ដើម្បីទទួល QR Code ទូទាត់:`,
      Markup.inlineKeyboard([
        [
          Markup.button.callback(`✅ បញ្ជាក់ $${total.toFixed(2)}`, `confirm_buy:${qty}`),
          Markup.button.callback("🚫 បោះបង់", "cancel_purchase"),
        ],
      ]));
  }

  if (state === "payment_pending") {
    return sendMsg(ctx, chatId,
      "⏳ <b>សូមបញ្ចប់ការទូទាត់ QR ជាមុនសិន</b>\nឬចុច /cancel ដើម្បីបោះបង់");
  }

  // Default
  await showAccountSelection(ctx, chatId, uid);
});

// ── Admin input handlers ──────────────────────────────────────────────────────
async function handleAdminInput(ctx, chatId, uid, msgId, key, text) {
  const isCancel = text === "⬅️ ត្រឡប់" || text === "🚫 បោះបង់";

  if (key === "payment_name") {
    if (isCancel) { delete sessions[uid]; saveSessions(); return showAdminMenu(ctx, chatId); }
    setSetting("PAYMENT_NAME", text);
    delete sessions[uid]; saveSessions();
    return sendMsg(ctx, chatId, `✅ <b>ឈ្មោះ Payment:</b> ${esc(text)}`, ADMIN_SETTINGS_KB);
  }

  if (key === "bakong_token") {
    if (isCancel) { delete sessions[uid]; saveSessions(); return showAdminMenu(ctx, chatId); }
    setSetting("BAKONG_TOKEN", text);
    delete sessions[uid]; saveSessions();
    await deleteMsg(ctx, chatId, msgId);
    return sendMsg(ctx, chatId,
      `✅ <b>Bakong Token បានកំណត់</b> (prefix: <code>${esc(text.slice(0, 10))}…</code>)`,
      ADMIN_SETTINGS_KB);
  }

  if (key === "admin_add") {
    if (isCancel) { delete sessions[uid]; saveSessions(); return showAdminMenu(ctx, chatId); }
    const target = parseInt(text, 10);
    if (isNaN(target)) return sendMsg(ctx, chatId, "❌ User ID ត្រូវតែជាលេខ");
    const extra = getSetting("EXTRA_ADMIN_IDS", []);
    if (!extra.includes(target)) extra.push(target);
    setSetting("EXTRA_ADMIN_IDS", extra);
    delete sessions[uid]; saveSessions();
    return sendMsg(ctx, chatId, `✅ <b>បន្ថែម Admin:</b> <code>${target}</code>`, ADMIN_SETTINGS_KB);
  }

  if (key === "admin_remove") {
    if (isCancel) { delete sessions[uid]; saveSessions(); return showAdminMenu(ctx, chatId); }
    const target = parseInt(text, 10);
    if (isNaN(target)) return sendMsg(ctx, chatId, "❌ User ID ត្រូវតែជាលេខ");
    setSetting("EXTRA_ADMIN_IDS", getSetting("EXTRA_ADMIN_IDS", []).filter((x) => x !== target));
    delete sessions[uid]; saveSessions();
    return sendMsg(ctx, chatId, `✅ <b>ដក Admin:</b> <code>${target}</code>`, ADMIN_SETTINGS_KB);
  }

  if (key === "admin_action") {
    if (isCancel) { delete sessions[uid]; saveSessions(); return showAdminMenu(ctx, chatId); }
    return;
  }

  if (key === "broadcast_msg") {
    if (isCancel) { delete sessions[uid]; saveSessions(); return showAdminMenu(ctx, chatId); }
    sessions[uid] = { state: "admin_broadcast_confirm", broadcast_text: text }; saveSessions();
    return sendMsg(ctx, chatId,
      `📢 <b>ព្រមព្រៀងផ្សាយ:</b>\n\n${esc(text)}\n\n` +
      `<i>ផ្សាយទៅអ្នកប្រើ ${Object.keys(users).length} នាក់</i>`,
      Markup.keyboard([["✅ បញ្ជាក់ផ្សាយ"], ["🚫 បោះបង់ការផ្សាយ"]]).resize());
  }
}

async function handleAccountsInput(ctx, chatId, uid, text) {
  if (text === "⬅️ ត្រឡប់" || text === "🚫 បោះបង់") {
    delete sessions[uid]; saveSessions(); return showAdminMenu(ctx, chatId);
  }
  const codes = text.split("\n").map((l) => l.trim()).filter(Boolean);
  if (!codes.length) return sendMsg(ctx, chatId, "❌ មិនឃើញកូដ — ផ្ញើម្ដងទៀត:");

  sessions[uid] = { state: "admin_waiting_for_type", new_accounts: codes.map((c) => ({ code: c })) };
  saveSessions();

  const types = Object.keys(accounts.account_types);
  return sendMsg(ctx, chatId,
    `✅ <b>ទទួលបាន ${codes.length} គូប៉ុង</b>\n\n` +
    `📁 <b>ប្រភេទដែលមានស្រាប់:</b>\n` +
    (types.map((t) => `• ${t}`).join("\n") || "<i>(មិនទាន់មី)</i>") +
    "\n\nវាយឈ្មោះប្រភេទ (ថ្មី ឬដែលមានស្រាប់):",
    CANCEL_KB);
}

async function handleTypeInput(ctx, chatId, uid, text) {
  if (text === "⬅️ ត្រឡប់" || text === "🚫 បោះបង់") {
    delete sessions[uid]; saveSessions(); return showAdminMenu(ctx, chatId);
  }
  const sess = sessions[uid] ?? {};
  sess.account_type = text;
  sess.state        = "admin_waiting_for_price";
  sessions[uid]     = sess; saveSessions();

  const existing = accounts.prices[text];
  return sendMsg(ctx, chatId,
    `💵 <b>ប្រភេទ:</b> ${esc(text)}\n` +
    (existing != null ? `តម្លៃបច្ចុប្បន្ន: <b>$${existing.toFixed(2)}</b>\n\nផ្ញើតម្លៃថ្មី ឬ <code>same</code>:` : "ផ្ញើ<b>តម្លៃ</b> (USD) ឧ. <code>1.50</code>:"),
    CANCEL_KB);
}

async function handlePriceInput(ctx, chatId, uid, text) {
  if (text === "⬅️ ត្រឡប់" || text === "🚫 បោះបង់") {
    delete sessions[uid]; saveSessions(); return showAdminMenu(ctx, chatId);
  }
  const sess    = sessions[uid] ?? {};
  const at      = sess.account_type ?? "";
  const newAccs = sess.new_accounts ?? [];
  const existing = accounts.prices[at];

  let price;
  if (text.toLowerCase() === "same" && existing != null) {
    price = existing;
  } else {
    price = parseFloat(text.replace("$", "").trim());
    if (isNaN(price) || price < 0) return sendMsg(ctx, chatId, "❌ តម្លៃមិនត្រឹមត្រូវ — ឧ. <code>1.50</code>:");
    price = Math.round(price * 100) / 100;
  }

  if (!accounts.account_types[at]) accounts.account_types[at] = [];
  const allExisting = new Set(
    Object.values(accounts.account_types).flat().map((a) => (a.code ?? "").toLowerCase())
  );
  const toAdd  = newAccs.filter((a) => !allExisting.has((a.code ?? "").toLowerCase()));
  const dupes  = newAccs.length - toAdd.length;

  accounts.account_types[at].push(...toAdd);
  accounts.prices[at] = price;
  saveAccounts();
  delete sessions[uid]; saveSessions();

  return sendMsg(ctx, chatId,
    `✅ <b>បន្ថែមជោគជ័យ!</b>\n\n` +
    `📁 ប្រភេទ: <b>${esc(at)}</b>\n` +
    `💵 តម្លៃ: <b>$${price.toFixed(2)}</b>\n` +
    `🆕 បន្ថែម: <b>${toAdd.length}</b> គូប៉ុង\n` +
    (dupes ? `⚠️ ដដែល (រំលង): <b>${dupes}</b>\n` : "") +
    `📦 ស្តុកសរុប: <b>${accounts.account_types[at].length}</b>`,
    ADMIN_SETTINGS_KB);
}

async function handleDeleteSelect(ctx, chatId, uid, text, sess) {
  if (text === "⬅️ ត្រឡប់" || text === "🚫 បោះបង់") {
    delete sessions[uid]; saveSessions(); return showAdminMenu(ctx, chatId);
  }
  if (!accounts.account_types[text]) return sendMsg(ctx, chatId, "❌ ប្រភេទមិនត្រឹម — ជ្រើសពីបញ្ជី");
  sessions[uid] = { state: "admin_delete_confirm", type_name: text }; saveSessions();
  const count = accounts.account_types[text].length;
  const price = accounts.prices[text] ?? 0;
  return sendMsg(ctx, chatId,
    `⚠️ <b>លុបប្រភេទ?</b>\n\n📁 <b>${esc(text)}</b>\n📦 ស្តុក: ${count} | 💵 $${price.toFixed(2)}\n\nការលុបនឹងដកគូប៉ុងទាំងអស់!`,
    Markup.keyboard([["✅ បញ្ជាក់លុប"], ["🚫 បោះបង់ការលុប"]]).resize());
}

async function handleDeleteConfirm(ctx, chatId, uid, text, sess) {
  const typeName = sess.type_name;
  delete sessions[uid]; saveSessions();
  if (text === "✅ បញ្ជាក់លុប" && typeName) {
    const count = (accounts.account_types[typeName] ?? []).length;
    delete accounts.account_types[typeName];
    delete accounts.prices[typeName];
    saveAccounts();
    return sendMsg(ctx, chatId,
      `✅ <b>លុបបានសម្រេច:</b> <code>${esc(typeName)}</code> (${count} records)`,
      ADMIN_SETTINGS_KB);
  }
  return sendMsg(ctx, chatId, "🚫 <b>បោះបង់ការលុប</b>", ADMIN_SETTINGS_KB);
}

async function handleBroadcastConfirm(ctx, chatId, uid, text, sess) {
  const broadcastText = sess.broadcast_text ?? "";
  delete sessions[uid]; saveSessions();
  if (text === "✅ បញ្ជាក់ផ្សាយ") {
    await sendMsg(ctx, chatId, "📢 <b>កំពុងផ្សាយ…</b>", ADMIN_SETTINGS_KB);
    doBroadcast(ctx, chatId, broadcastText);
  } else {
    await sendMsg(ctx, chatId, "🚫 <b>បោះបង់ការផ្សាយ</b>", ADMIN_SETTINGS_KB);
  }
}

async function doBroadcast(ctx, adminChatId, text) {
  let sent = 0, failed = 0;
  for (const uid of Object.keys(users)) {
    try {
      await ctx.telegram.sendMessage(Number(uid), text, { parse_mode: "HTML" });
      sent++;
    } catch { failed++; }
    await new Promise((r) => setTimeout(r, 50));
  }
  await sendMsg(ctx, adminChatId, `📢 <b>ផ្សាយចប់!</b>\n✅ ជោគជ័យ: ${sent}\n❌ បរាជ័យ: ${failed}`);
}

// ── Admin info displays ───────────────────────────────────────────────────────
async function showStock(ctx, chatId) {
  const lines = ["📦 <b>ស្តុកបច្ចុប្បន្ន:</b>\n"];
  let total = 0;
  for (const [at, accs] of Object.entries(accounts.account_types)) {
    const price = accounts.prices[at] ?? 0;
    lines.push(`• <b>${esc(at)}</b>: ${accs.length} | $${price.toFixed(2)}/គ្រាប់`);
    total += accs.length;
  }
  if (!total) lines.push("<i>ស្តុកទទេ</i>");
  lines.push(`\n📊 <b>សរុប: ${total} គូប៉ុង</b>`);
  return sendMsg(ctx, chatId, lines.join("\n"), ADMIN_SETTINGS_KB);
}

async function showBuyers(ctx, chatId) {
  if (!purchases.length) return sendMsg(ctx, chatId, "📋 <b>មិនទាន់មានការទិញ</b>", ADMIN_SETTINGS_KB);
  const recent = purchases.slice(-20).reverse();
  const lines  = [`📋 <b>ការទិញ (${purchases.length} សរុប):</b>\n`];
  for (const p of recent) {
    lines.push(
      `• ${esc(p.account_type)} ×${p.quantity} $${(p.total_price ?? 0).toFixed(2)} ` +
      `— user ${p.user_id} [${(p.paid_at ?? "").slice(0, 10)}]`
    );
  }
  return sendMsg(ctx, chatId, lines.join("\n"), ADMIN_SETTINGS_KB);
}

async function showUsers(ctx, chatId) {
  const count = Object.keys(users).length;
  const lines = [`👥 <b>អ្នកប្រើប្រាស់ (${count}):</b>\n`];
  for (const [uid, info] of Object.entries(users).slice(0, 30)) {
    const full  = [info.first_name, info.last_name].filter(Boolean).join(" ") || "N/A";
    const uname = info.username ? `@${info.username}` : "—";
    lines.push(`• <code>${uid}</code> ${esc(full)} ${esc(uname)}`);
  }
  if (count > 30) lines.push(`\n<i>… និង ${count - 30} ទៀត</i>`);
  return sendMsg(ctx, chatId, lines.join("\n"), ADMIN_SETTINGS_KB);
}

// ── Startup ───────────────────────────────────────────────────────────────────
function loadAll() {
  settings  = readJSON(FILES.settings, {});
  accounts  = readJSON(FILES.accounts, { account_types: {}, prices: {} });
  users     = readJSON(FILES.users, {});
  purchases = readJSON(FILES.purchases, []);

  const storedSessions = readJSON(FILES.sessions, {});
  for (const [k, v] of Object.entries(storedSessions)) sessions[Number(k)] = v;

  const couponCount = Object.values(accounts.account_types).reduce((s, a) => s + a.length, 0);
  console.log(`[INFO] Loaded: ${couponCount} coupons, ${Object.keys(users).length} users, ${purchases.length} purchases`);
}

// Graceful shutdown
process.once("SIGINT",  () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));

loadAll();
bot.launch().then(async () => {
  const me = await bot.telegram.getMe();
  console.log(`[INFO] Bot ready: @${me.username}`);
  try {
    await bot.telegram.sendMessage(ADMIN_ID, "✅ <b>Bot ចាប់ផ្ដើម! (JavaScript)</b>", { parse_mode: "HTML" });
  } catch {}
});
