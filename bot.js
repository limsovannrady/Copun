import fs from "fs";
import path from "path";
import crypto from "crypto";
import http from "http";
import { fileURLToPath } from "url";
import QRCode from "qrcode";
import { Telegraf, Markup } from "telegraf";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── 1. Config ─────────────────────────────────────────────────────────────────
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
if (!BOT_TOKEN) { console.error("[ERROR] TELEGRAM_BOT_TOKEN is not set. Exiting."); process.exit(1); }

const ADMIN_ID               = 5002402843;
let   EXTRA_ADMIN_IDS        = new Set();
let   CHANNEL_ID             = "";
let   PAYMENT_NAME           = "RADY";
let   MAINTENANCE_MODE       = false;
let   KHPAY_API_KEY          = "ak_5de3149200e549b740b513233fa2a90930f8d2efadabcd92";
let   DROPMAIL_TOKEN         = "";
const KHPAY_BASE             = "https://www.khpay.site/api/v1";
const PAYMENT_TIMEOUT_SEC    = 60;
const PAYMENT_POLL_INTERVAL  = 5;
const WEBHOOK_PORT           = 5000;
let   WEBHOOK_SECRET         = "";   // loaded/generated in loadAll()
let   WEBHOOK_URL            = "";

// ── 2. DB file ────────────────────────────────────────────────────────────────
const DB_FILE = path.join(__dirname, "db.json");

// ── 3. In-memory state ────────────────────────────────────────────────────────
let accounts_data  = { accounts: [], account_types: {}, prices: {} };
let user_sessions  = {};
let settings       = {};
let known_users    = {};
let purchases      = [];
const _notified    = new Set();

// ── 4. Single-file persistence ────────────────────────────────────────────────
const readDB  = () => { try { return JSON.parse(fs.readFileSync(DB_FILE, "utf8")); } catch { return {}; } };
const saveDB  = () => {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(
      { accounts: accounts_data, sessions: user_sessions, settings, users: known_users, purchases },
      null, 2), "utf8");
  } catch(e) { console.warn("[WARN]", e.message); }
};

const saveAccounts  = saveDB;
const saveSessions  = saveDB;
const saveSettings  = saveDB;
const saveUsers     = saveDB;
const savePurchases = saveDB;

const getSetting = (k, def = null) => settings[k] ?? def;
const setSetting = (k, v) => { settings[k] = v; saveDB(); };

// ── 5. Admin helpers ──────────────────────────────────────────────────────────
const isAdmin = uid => Number(uid) === ADMIN_ID || EXTRA_ADMIN_IDS.has(Number(uid));

// ── 6. Button labels (100% identical to GitHub) ───────────────────────────────
const BTN_ADD_ACCOUNT       = "➕ បន្ថែម គូប៉ុង";
const BTN_DELETE_TYPE       = "🗑 លុបប្រភេទ";
const BTN_STOCK             = "📦 ស្តុក គូប៉ុង";
const BTN_USERS             = "👥 អ្នកប្រើប្រាស់";
const BTN_BUYERS            = "📋 របាយការណ៍ទិញ";
const BTN_KHPAY             = "💰 KhPay API";
const BTN_CHANNEL           = "📢 Channel ID";
const BTN_ADMINS            = "👑 គ្រប់គ្រង Admin";
const BTN_MAINTENANCE       = "🛠 Maintenance Mode";
const BTN_BROADCAST         = "📢 ផ្សាយព័ត៌មាន";
const BTN_BACK_SETTINGS     = "⬅️ ត្រឡប់ទៅកំណត់";
const BTN_KHPAY_KEY_EDIT    = "✏️ ប្តូរ KhPay API Key";
const BTN_KHPAY_INFO        = "📊 ព័ត៌មាន KhPay";
const BTN_CHANNEL_EDIT      = "✏️ ប្តូរ Channel ID";
const BTN_CHANNEL_CLEAR     = "🗑 លុប Channel ID";
const BTN_ADMIN_ADD         = "➕ បន្ថែម Admin";
const BTN_ADMIN_REMOVE      = "➖ ដក Admin";
const BTN_MAINT_ON          = "🔴 បិទ Bot";
const BTN_MAINT_OFF         = "🟢 បើក Bot";
const BTN_CANCEL_INPUT      = "🚫 បោះបង់";
const BTN_DELETE_CONFIRM    = "✅ បញ្ជាក់លុប";
const BTN_DELETE_CANCEL     = "🚫 បោះបង់ការលុប";
const BTN_BROADCAST_CONFIRM = "✅ បញ្ជាក់ផ្សាយ";
const BTN_BROADCAST_CANCEL  = "🚫 បោះបង់ការផ្សាយ";
const BTN_EMAIL_MGMT        = "📧 អ៊ីម៉ែល";
const BTN_EMAIL_NEW         = "📨 Email ថ្មី";
const BTN_EMAIL_LIST        = "📋 បញ្ជី Email";
const BTN_EMAIL_SET_TOKEN   = "🔑 កំណត់ Token";
const BTN_EMAIL_CLEAR       = "🗑 លុប Email";
const ADMIN_SETTINGS_BTN    = "⚙️កំណត់";

const ADMIN_BUTTON_LABELS = new Set([
  BTN_ADD_ACCOUNT, BTN_DELETE_TYPE, BTN_STOCK, BTN_USERS, BTN_BUYERS,
  BTN_KHPAY, BTN_CHANNEL, BTN_ADMINS, BTN_MAINTENANCE, BTN_BROADCAST,
  BTN_BACK_SETTINGS, BTN_KHPAY_KEY_EDIT, BTN_KHPAY_INFO,
  BTN_CHANNEL_EDIT, BTN_CHANNEL_CLEAR, BTN_ADMIN_ADD, BTN_ADMIN_REMOVE,
  BTN_MAINT_ON, BTN_MAINT_OFF, BTN_CANCEL_INPUT,
  BTN_DELETE_CONFIRM, BTN_DELETE_CANCEL, BTN_BROADCAST_CONFIRM, BTN_BROADCAST_CANCEL,
  BTN_EMAIL_MGMT, BTN_EMAIL_NEW, BTN_EMAIL_LIST, BTN_EMAIL_SET_TOKEN, BTN_EMAIL_CLEAR,
  ADMIN_SETTINGS_BTN,
]);

// ── 7. Keyboards ──────────────────────────────────────────────────────────────
const MAIN_KB = Markup.keyboard([["💵 ទិញគូប៉ុង"]]).resize().persistent();

const ADMIN_KB = Markup.keyboard([[ADMIN_SETTINGS_BTN]]).resize().persistent();

const ADMIN_SETTINGS_KB = Markup.keyboard([
  [BTN_ADD_ACCOUNT, BTN_DELETE_TYPE],
  [BTN_STOCK,       BTN_BUYERS],
  [BTN_USERS,       BTN_EMAIL_MGMT],
  [BTN_KHPAY,       BTN_CHANNEL],
  [BTN_ADMINS,      BTN_BROADCAST],
  [BTN_MAINTENANCE],
]).resize().persistent();

const CANCEL_INPUT_KB    = Markup.keyboard([[BTN_CANCEL_INPUT]]).resize().persistent();
const ADD_ACCOUNT_KB     = Markup.keyboard([[BTN_BACK_SETTINGS]]).resize().persistent();
const BACK_SETTINGS_KB   = Markup.keyboard([[BTN_BACK_SETTINGS]]).resize().persistent();

const KHPAY_SUBMENU_KB = Markup.keyboard([
  [BTN_KHPAY_KEY_EDIT, BTN_KHPAY_INFO], [BTN_BACK_SETTINGS],
]).resize().persistent();

const CHANNEL_SUBMENU_KB = Markup.keyboard([
  [BTN_CHANNEL_EDIT, BTN_CHANNEL_CLEAR], [BTN_BACK_SETTINGS],
]).resize().persistent();

const ADMINS_SUBMENU_KB = Markup.keyboard([
  [BTN_ADMIN_ADD, BTN_ADMIN_REMOVE], [BTN_BACK_SETTINGS],
]).resize().persistent();

const MAINTENANCE_SUBMENU_KB = Markup.keyboard([
  [BTN_MAINT_ON, BTN_MAINT_OFF], [BTN_BACK_SETTINGS],
]).resize().persistent();

const BROADCAST_CONFIRM_KB = Markup.keyboard([
  [BTN_BROADCAST_CONFIRM], [BTN_BROADCAST_CANCEL],
]).resize().persistent();

const EMAIL_SUBMENU_KB = Markup.keyboard([
  [BTN_EMAIL_NEW, BTN_EMAIL_LIST],
  [BTN_EMAIL_SET_TOKEN, BTN_EMAIL_CLEAR],
  [BTN_BACK_SETTINGS],
]).resize().persistent();

const CHECK_PAYMENT_INLINE = Markup.inlineKeyboard([
  [Markup.button.callback("🚫 បោះបង់", "cancel_purchase")],
]);

const mainKb = uid => isAdmin(uid) ? ADMIN_KB : Markup.removeKeyboard();

// ── 8a. Dropmail API helpers ──────────────────────────────────────────────────
async function dropmailGql(query) {
  if (!DROPMAIL_TOKEN) throw new Error("no_token");
  const res = await fetch(`https://dropmail.me/api/graphql/${DROPMAIL_TOKEN}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(12000),
  });
  return res.json();
}

async function dropmailCreateSession() {
  const data = await dropmailGql(`mutation { introduceSession { id expiresAt addresses { address } } }`);
  return data?.data?.introduceSession ?? null;
}

async function dropmailGetSession(sessionId) {
  const data = await dropmailGql(
    `{ session(id: "${sessionId}") { expiresAt addresses { address } mails { fromAddr headerSubject text downloadUrl } } }`
  );
  return data?.data?.session ?? null;
}

function getDropmailSession(uid) {
  try {
    const stored = getSetting("DROPMAIL_SESSIONS");
    if (!stored) return null;
    return JSON.parse(stored)[String(uid)] ?? null;
  } catch { return null; }
}

function getAllDropmailSessions() {
  try { return JSON.parse(getSetting("DROPMAIL_SESSIONS") || "{}"); } catch { return {}; }
}

function setDropmailSession(uid, session) {
  let all = {};
  try { all = JSON.parse(getSetting("DROPMAIL_SESSIONS") || "{}"); } catch {}
  if (session) all[String(uid)] = session;
  else delete all[String(uid)];
  setSetting("DROPMAIL_SESSIONS", JSON.stringify(all));
}

// ── 8b. Email live polling ────────────────────────────────────────────────────
const EMAIL_POLL_INTERVAL_SEC = 30;
let _emailPollTimer   = null;
let _seenMailHashes   = new Set();

function mailHash(m) {
  return crypto.createHash("md5")
    .update(`${m.fromAddr||""}|${m.headerSubject||""}|${(m.text||"").slice(0,120)}`)
    .digest("hex");
}

function loadSeenHashes() {
  try {
    const raw = getSetting("DROPMAIL_SEEN");
    if (raw) _seenMailHashes = new Set(JSON.parse(raw));
  } catch {}
}

function saveSeenHashes() {
  setSetting("DROPMAIL_SEEN", JSON.stringify([..._seenMailHashes]));
}

async function pollEmailSessions() {
  if (!DROPMAIL_TOKEN) return;
  const channelTarget = CHANNEL_ID || null;
  if (!channelTarget) return;

  const all = getAllDropmailSessions();
  const entries = Object.entries(all);
  if (!entries.length) return;

  const fakeCtx = { telegram: bot.telegram };
  let anyNew = false;

  for (const [uid, sess] of entries) {
    try {
      const session = await dropmailGetSession(sess.sessionId);
      if (!session) {
        // Session expired — clean up
        setDropmailSession(uid, null);
        console.log(`[Email] Session for uid ${uid} expired, removed.`);
        continue;
      }

      const mails = session.mails || [];
      for (const m of mails) {
        const h = mailHash(m);
        if (_seenMailHashes.has(h)) continue;
        _seenMailHashes.add(h);
        anyNew = true;

        const subject = m.headerSubject || "(គ្មាន subject)";
        const from    = m.fromAddr || "—";
        const body    = (m.text || "").slice(0, 800) || "(គ្មានខ្លឹមសារ)";
        const msg =
          `📬 <b>អ៊ីម៉ែលថ្មីចូលមកដល់!</b>\n\n` +
          `📧 <b>ទៅ:</b> <code>${esc(sess.address)}</code>\n` +
          `👤 <b>ពី:</b> <code>${esc(from)}</code>\n` +
          `📝 <b>ប្រធានបទ:</b> ${esc(subject)}\n\n` +
          `────────────────────────────\n` +
          `${esc(body)}${(m.text || "").length > 800 ? "\n<i>…(truncated)</i>" : ""}`;

        await sendMsg(fakeCtx, channelTarget, msg).catch(() => {});
        console.log(`[Email] New mail forwarded to channel: ${from} → ${sess.address}`);
      }
    } catch (e) {
      console.warn(`[Email] Poll error for uid ${uid}:`, e.message);
    }
  }

  if (anyNew) saveSeenHashes();
}

function startEmailLivePolling() {
  if (_emailPollTimer) clearInterval(_emailPollTimer);
  _emailPollTimer = setInterval(async () => {
    try { await pollEmailSessions(); } catch (e) { console.warn("[Email] Poll cycle error:", e.message); }
  }, EMAIL_POLL_INTERVAL_SEC * 1000);
  console.log(`[Email] Live polling started (every ${EMAIL_POLL_INTERVAL_SEC}s)`);
}

// ── 8. KhPay API helpers ──────────────────────────────────────────────────────
async function khpayRequest(method, path, body = null) {
  const opts = {
    method,
    headers: {
      Authorization: `Bearer ${KHPAY_API_KEY}`,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(12000),
  };
  if (body) opts.body = JSON.stringify(body);
  const res  = await fetch(`${KHPAY_BASE}${path}`, opts);
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { success: false, error: text }; }
}

async function createKhpayPayment(amount, note = "") {
  try {
    const data = await khpayRequest("POST", "/bakong/generate", {
      amount,
      note: note || PAYMENT_NAME,
      callback_url: WEBHOOK_URL,
    });
    if (!data.success) {
      return { imgBuffer: null, transaction_id: null, error: data.error || "API error" };
    }
    const { transaction_id, qr: qr_string, expires_in, md5 } = data.data;

    // Render QR from qr_string locally (reliable, no extra fetch)
    const imgBuffer = await QRCode.toBuffer(qr_string, { errorCorrectionLevel: "M", width: 400, margin: 2 });
    return { imgBuffer, transaction_id, md5: md5 ?? null, expires_in: expires_in ?? 180, error: null };
  } catch (e) {
    return { imgBuffer: null, transaction_id: null, error: e.message };
  }
}

async function checkKhpayStatus(transaction_id, md5 = null) {
  try {
    // Primary: GET /transactions/{id}
    const data = await khpayRequest("GET", `/transactions/${transaction_id}`);
    if (data.success) {
      const d = data.data;
      const status = (d.status ?? "").toLowerCase();
      if (status === "paid" || status === "success" || status === "completed" || !!d.paid_at) {
        return { paid: true, status, data: d };
      }
    }

    // Secondary: POST /bakong/check — always call this; md5 is optional but endpoint works without it
    const bkBody = md5 ? { transaction_id, md5 } : { transaction_id };
    const bk = await khpayRequest("POST", "/bakong/check", bkBody);
    if (bk.success && bk.data) {
      const bkStatus = (bk.data.status ?? "").toLowerCase();
      const bkPaid = bkStatus === "paid" || bkStatus === "success" || bkStatus === "completed"
        || bk.data.transaction !== null && bk.data.transaction !== undefined;
      if (bkPaid) return { paid: true, status: bkStatus, data: bk.data.transaction ?? bk.data };
    }

    const fallbackStatus = data.success ? (data.data?.status ?? "pending") : "error";
    return { paid: false, status: fallbackStatus, data: data.data ?? null };
  } catch (e) {
    console.warn("[WARN] checkKhpayStatus:", e.message);
    return { paid: false, status: "error", data: null };
  }
}

// ── 9. Account type helpers ───────────────────────────────────────────────────
const typeCallbackId  = at => crypto.createHash("sha1").update(at).digest("hex").slice(0, 12);
const typeFromCbId    = cid => Object.keys(accounts_data.account_types).find(t => typeCallbackId(t) === cid) ?? null;
const shortLabel      = (t, n = 36) => { const c = t.trim(); return c.length <= n ? c : c.slice(0, n - 1) + "…"; };

// ── 10. HTML escape ───────────────────────────────────────────────────────────
const esc = s => String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");

// ── 11. JWT expiry decoder ────────────────────────────────────────────────────
function decodeJWTExpiry(token) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return { exp: null, daysLeft: null };
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g,"+").replace(/_/g,"/"), "base64").toString("utf8"));
    if (!payload.exp) return { exp: null, daysLeft: null };
    const expDate  = new Date(payload.exp * 1000);
    const daysLeft = Math.floor((expDate - Date.now()) / 86400000);
    return { exp: expDate, daysLeft };
  } catch { return { exp: null, daysLeft: null }; }
}

function daysStatus(daysLeft) {
  if (daysLeft == null)    return "✅ Active";
  if (daysLeft < 0)        return `❌ ផុតកំណត់រួចហើយ (${Math.abs(daysLeft)} ថ្ងៃមុន)`;
  if (daysLeft === 0)      return "⚠️ ផុតកំណត់ថ្ងៃនេះ!";
  if (daysLeft <= 7)       return `⚠️ នឹងផុតក្នុង ${daysLeft} ថ្ងៃ`;
  return `✅ នៅសល់ ${daysLeft} ថ្ងៃ`;
}

// ── 12. Account format helper ─────────────────────────────────────────────────
function formatAccount(acc) {
  if (typeof acc === "string") return acc;
  if (acc.email)  return acc.email;
  if (acc.phone)  return `${acc.phone} | ${acc.password || ""}`;
  if (acc.code)   return acc.code;
  return JSON.stringify(acc);
}

// ── 13. Send helpers ──────────────────────────────────────────────────────────
async function sendMsg(ctx, chatId, text, extra = {}) {
  try { return await ctx.telegram.sendMessage(chatId, text, { parse_mode: "HTML", ...extra }); }
  catch (e) { console.warn(`[WARN] sendMsg(${chatId}):`, e.message); }
}
async function sendPhoto(ctx, chatId, buffer, extra = {}) {
  try { return await ctx.telegram.sendPhoto(chatId, { source: buffer }, { parse_mode: "HTML", ...extra }); }
  catch (e) { console.warn(`[WARN] sendPhoto(${chatId}):`, e.message); }
}
async function sendDocument(ctx, chatId, buffer, filename, caption = "") {
  try { return await ctx.telegram.sendDocument(chatId, { source: buffer, filename }, { caption, parse_mode: "HTML" }); }
  catch (e) { console.warn(`[WARN] sendDocument(${chatId}):`, e.message); }
}
async function deleteMsg(ctx, chatId, messageId) {
  if (!messageId) return;
  try { await ctx.telegram.deleteMessage(chatId, messageId); } catch {}
}
async function editMsgReplyMarkup(ctx, chatId, messageId, markup) {
  try { await ctx.telegram.editMessageReplyMarkup(chatId, messageId, null, markup?.reply_markup ?? markup); } catch {}
}

// ── 14. Admin notifications ───────────────────────────────────────────────────
async function notifyAdminNewUser(ctx, user) {
  const uid = user.id;
  if (uid === ADMIN_ID || _notified.has(uid) || known_users[String(uid)]) return;
  _notified.add(uid);
  known_users[String(uid)] = {
    first_name: user.first_name || "",
    last_name:  user.last_name  || "",
    username:   user.username   || "",
    first_seen: new Date().toISOString(),
  };
  saveUsers();
  const full  = [user.first_name, user.last_name].filter(Boolean).join(" ") || "N/A";
  const uname = user.username ? `@${user.username}` : "—";
  await sendMsg(ctx, ADMIN_ID,
    `🆕 <b>អ្នកប្រើប្រាស់ថ្មី!</b>\n\n👤 ឈ្មោះ: ${esc(full)}\n🔖 Username: ${esc(uname)}\n🪪 ID: <code>${uid}</code>`);
}

// ── 15. Account selection ─────────────────────────────────────────────────────
async function showAccountSelection(ctx, chatId) {
  const available = Object.entries(accounts_data.account_types)
    .filter(([, v]) => v.length > 0)
    .map(([at, v]) => ({ at, count: v.length }));

  if (!available.length) {
    await sendMsg(ctx, chatId, "<i>សូមអភ័យទោស អស់ពីស្តុក 🪤</i>");
    return;
  }
  const rows = available.map(({ at, count }) =>
    [Markup.button.callback(`${at} – មានក្នុងស្តុក ${count}`, `buy:${typeCallbackId(at)}`)]
  );
  await sendMsg(ctx, chatId, "<b>សូមជ្រើសរើសគូប៉ុងដើម្បីទិញ៖</b>",
    Markup.inlineKeyboard(rows));
}

async function sendAdminSettingsMenu(ctx, chatId) {
  await sendMsg(ctx, chatId,
    "<b>⚙️ ការកំណត់ Admin</b>\n\nសូមជ្រើសរើសប្រតិបត្តិការខាងក្រោម៖",
    ADMIN_SETTINGS_KB);
}

// ── 16. Payment flow ──────────────────────────────────────────────────────────
async function startPaymentForSession(ctx, chatId, userId, session, cbQuery = null) {
  const { account_type, quantity } = session;
  const pool = accounts_data.account_types[account_type] ?? [];

  if (pool.length < quantity) {
    if (cbQuery) { try { await cbQuery.answerCbQuery(`សូមអភ័យទោស! មានត្រឹមតែ ${pool.length} គូប៉ុង នៅក្នុងស្តុក`, { show_alert: true }); } catch {} }
    delete user_sessions[userId]; saveSessions();
    return false;
  }

  const reserved = pool.slice(0, quantity);
  accounts_data.account_types[account_type] = pool.slice(quantity);
  session.reserved_accounts = reserved;
  session.available_count   = accounts_data.account_types[account_type].length;
  saveAccounts();

  if (cbQuery) { try { await cbQuery.answerCbQuery("កំពុងបង្កើត QR..."); } catch {} }
  session.state = "payment_pending";

  const { imgBuffer, transaction_id, md5, error } = await createKhpayPayment(session.total_price, session.account_type);

  if (!imgBuffer || !transaction_id) {
    if (isAdmin(userId)) {
      await sendMsg(ctx, chatId, `❌ <b>QR បរាជ័យ (Admin Debug):</b>\n<code>${esc(String(error))}</code>`);
    } else {
      await sendMsg(ctx, chatId, "❌ <b>មានបញ្ហាក្នុងការបង្កើត QR Code</b>\n\nសូមព្យាយាមម្ដងទៀត។");
      await sendMsg(ctx, ADMIN_ID, `⚠️ QR Error (user ${userId}): <code>${esc(String(error))}</code>`);
    }
    accounts_data.account_types[account_type] = [...reserved, ...(accounts_data.account_types[account_type] ?? [])];
    saveAccounts();
    delete user_sessions[userId]; saveSessions();
    return false;
  }

  session.transaction_id = transaction_id;
  session.md5            = md5 ?? null;
  session.qr_sent_at     = Date.now();

  const photoMsg = await sendPhoto(ctx, chatId, imgBuffer, { ...CHECK_PAYMENT_INLINE });
  if (photoMsg) {
    session.photo_message_id = photoMsg.message_id;
    session.qr_message_id    = photoMsg.message_id;
  }

  user_sessions[userId] = session;
  saveSessions();

  console.log(`[INFO] KhPay QR sent to user ${userId}: Amount $${session.total_price}, TxnID: ${transaction_id}`);
  return true;
}

// ── KhPay Webhook HTTP Server ─────────────────────────────────────────────────
function startWebhookServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost`);

    // Health check
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200); res.end("OK"); return;
    }

    // Only handle POST /khpay-webhook
    if (req.method !== "POST" || url.pathname !== "/khpay-webhook") {
      res.writeHead(404); res.end(); return;
    }

    // Verify secret
    if (url.searchParams.get("secret") !== WEBHOOK_SECRET) {
      console.warn("[Webhook] Rejected: invalid secret");
      res.writeHead(403); res.end(); return;
    }

    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", async () => {
      res.writeHead(200); res.end("OK");
      try {
        const payload = JSON.parse(body);
        const txnId   = payload?.transaction_id ?? payload?.data?.transaction_id;
        const status  = (payload?.status ?? payload?.data?.status ?? "").toLowerCase();
        const isPaid  = status === "paid" || status === "success" || status === "completed"
                     || payload?.data?.transaction != null;

        console.log(`[Webhook] Received: txn=${txnId} status=${status}`);
        if (!txnId || !isPaid) return;

        // Find matching pending session
        const entry = Object.entries(user_sessions).find(
          ([, s]) => s.state === "payment_pending" && s.transaction_id === txnId
        );
        if (!entry) return;

        const [uidStr, sess] = entry;
        const userId = Number(uidStr);
        if (sess.state !== "payment_pending") return;
        sess.state = "delivering";

        console.log(`[Webhook] ✅ Payment confirmed instantly for user ${userId}: ${txnId}`);
        const fakeCtx = { telegram: bot.telegram };
        await deliverAccounts(fakeCtx, userId, userId, sess, payload?.data ?? payload);
      } catch (e) {
        console.warn("[Webhook] Error processing payload:", e.message);
      }
    });
  });

  server.listen(WEBHOOK_PORT, () => {
    console.log(`[Webhook] Server listening on port ${WEBHOOK_PORT}`);
    console.log(`[Webhook] URL: ${WEBHOOK_URL}`);
  });
}

// ── Global payment watchdog (replaces per-session setInterval) ─────────────────
let _watchdogTimer = null;

function startPaymentWatchdog() {
  if (_watchdogTimer) clearInterval(_watchdogTimer);
  _watchdogTimer = setInterval(async () => {
    try { await runPaymentWatchdog(); } catch (e) { console.warn("[Watchdog] error:", e.message); }
  }, PAYMENT_POLL_INTERVAL * 1000);
  console.log(`[Watchdog] Payment watchdog started (every ${PAYMENT_POLL_INTERVAL}s)`);
}

async function runPaymentWatchdog() {
  const pending = Object.entries(user_sessions).filter(([, s]) => s.state === "payment_pending");
  if (!pending.length) return;

  const fakeCtx = { telegram: bot.telegram };

  for (const [uidStr, sess] of pending) {
    const userId = Number(uidStr);
    const { transaction_id, qr_sent_at, account_type, reserved_accounts = [] } = sess;

    const elapsed = Date.now() - (qr_sent_at || 0);

    if (elapsed >= PAYMENT_TIMEOUT_SEC * 1000) {
      // Expired — return stock, notify user
      console.log(`[Watchdog] Session expired for user ${userId}`);
      if (reserved_accounts.length && account_type) {
        accounts_data.account_types[account_type] = [
          ...reserved_accounts, ...(accounts_data.account_types[account_type] ?? []),
        ];
        saveAccounts();
      }
      delete user_sessions[userId]; saveSessions();
      deleteMsg(fakeCtx, userId, sess.photo_message_id).catch(() => {});
      await sendMsg(fakeCtx, userId, "⌛ <b>QR Code បានផុតកំណត់</b>\n\nសូមបង្កើតការទិញម្ដងទៀត។").catch(() => {});
      await showAccountSelection(fakeCtx, userId).catch(() => {});
      continue;
    }

    // Check payment status
    try {
      const { paid, data: payData } = await checkKhpayStatus(transaction_id, sess.md5 ?? null);
      if (!paid) continue;

      // Mark as delivering (idempotency guard)
      const cur = user_sessions[userId];
      if (!cur || cur.transaction_id !== transaction_id || cur.state !== "payment_pending") continue;
      cur.state = "delivering";

      console.log(`[Watchdog] Payment confirmed for user ${userId}: ${transaction_id}`);
      await deliverAccounts(fakeCtx, userId, userId, cur, payData);
    } catch (e) {
      console.warn(`[Watchdog] Status check error for ${transaction_id}:`, e.message);
    }
  }
}

async function deliverAccounts(ctx, chatId, userId, session, paymentData = null) {
  const { account_type, quantity } = session;
  let reserved = session.reserved_accounts ?? [];

  // Delete QR photo
  for (const k of ["photo_message_id", "qr_message_id"]) {
    if (session[k]) deleteMsg(ctx, chatId, session[k]).catch(() => {});
  }

  let delivered = null;
  if (reserved.length >= quantity) {
    delivered = reserved.slice(0, quantity);
  } else if ((accounts_data.account_types[account_type] ?? []).length >= quantity) {
    const pool = accounts_data.account_types[account_type];
    delivered  = pool.slice(0, quantity);
    accounts_data.account_types[account_type] = pool.slice(quantity);
    saveAccounts();
  }

  delete user_sessions[userId]; saveSessions();

  if (!delivered) {
    await sendMsg(ctx, chatId, `❌ <b>មានបញ្ហា!</b>\n\nគ្មាន គូប៉ុង ប្រភេទ ${esc(account_type)} ក្នុងស្តុក។`);
    return;
  }

  // Save purchase history
  purchases.push({
    user_id: userId, account_type, quantity,
    total_price: session.total_price, accounts: delivered,
    purchased_at: new Date().toISOString(),
  });
  savePurchases();

  // Build delivery message (100% identical format to GitHub)
  let msg = `<tg-emoji emoji-id="5436040291507247633">🎉</tg-emoji> <b>ការទិញបានបញ្ជាក់ដោយជោគជ័យ</b>\n\n`;
  msg += `<blockquote>🔹 ប្រភេទ: ${esc(account_type)}\n🔹 ចំនួន: ${quantity}</blockquote>\n\n`;
  msg += `<b>គូប៉ុង របស់អ្នក៖</b>\n\n`;
  for (const acc of delivered) {
    msg += `${esc(formatAccount(acc))}\n`;
  }
  msg += `\n<i>សូមអរគុណសម្រាប់ការទិញ <tg-emoji emoji-id="5897474556834091884">🙏</tg-emoji></i>`;

  await sendMsg(ctx, chatId, msg, mainKb(userId));

  // Admin notification
  try {
    const pd  = paymentData || {};
    const now = new Date().toLocaleString("en-GB", { timeZone: "Asia/Phnom_Penh", hour12: false });
    const fromAcc = pd.fromAccountId || pd.hash || "N/A";
    const memo    = pd.memo || "គ្មាន";
    const ref     = pd.externalRef || pd.transactionId || pd.md5 || "N/A";
    const adminMsg = (
      "🎉 <b>ទទួលបានការបង់ប្រាក់ជោគជ័យ</b>\n" +
      "━━━━━━━━━━━━━━━━━━━\n" +
      `🆔 <b>ឈ្មោះអ្នកទិញ(ID):</b> ${userId}\n` +
      `💵 <b>ទឹកប្រាក់:</b> ${session.total_price} USD\n` +
      `👤 <b>ពីធនាគារ:</b> <code>${esc(fromAcc)}</code>\n` +
      `📝 <b>ចំណាំ:</b> ${esc(memo)}\n` +
      `🧾 <b>លេខយោង:</b> <code>${esc(ref)}</code>\n` +
      `⏰ <b>ម៉ោង:</b> ${now}`
    );
    await sendMsg(ctx, ADMIN_ID, adminMsg);
    if (CHANNEL_ID && String(CHANNEL_ID) !== String(ADMIN_ID)) {
      await sendMsg(ctx, CHANNEL_ID, adminMsg).catch(() => {});
    }
  } catch (e) { console.warn("[WARN] admin payment notify:", e.message); }

  console.log(`[INFO] Payment confirmed and ${quantity} accounts delivered to user ${userId}`);
}

// ── 17. Bot setup ─────────────────────────────────────────────────────────────
const bot = new Telegraf(BOT_TOKEN);

// /start
bot.command("start", async ctx => {
  const uid    = ctx.from.id;
  const chatId = ctx.chat.id;
  notifyAdminNewUser(ctx, ctx.from).catch(() => {});
  if (MAINTENANCE_MODE && !isAdmin(uid)) {
    return sendMsg(ctx, chatId, "🔧 <b>Bot កំពុង Update សូមរង់ចាំមួយភ្លែត...</b>");
  }
  const sess = user_sessions[uid];
  if (sess?.state === "payment_pending") {
    return sendMsg(ctx, chatId,
      "⏳ <b>សូមបញ្ចប់ការទិញបច្ចុប្បន្នជាមុនសិន</b>\n\nអ្នកមានការបញ្ជាទិញមួយកំពុងដំណើរការ។ " +
      "សូមបញ្ចប់ការទូទាត់ ឬចុច <b>🚫 បោះបង់</b> មុននឹងចាប់ផ្តើមការទិញថ្មី។");
  }
  delete user_sessions[uid];
  await showAccountSelection(ctx, chatId);
});


// ── 18. Callback query handler ────────────────────────────────────────────────
bot.on("callback_query", async ctx => {
  const data   = ctx.callbackQuery.data ?? "";
  const uid    = ctx.from.id;
  const chatId = ctx.callbackQuery.message?.chat?.id ?? ctx.chat?.id;

  notifyAdminNewUser(ctx, ctx.from).catch(() => {});

  // ── buy:<id> ─────────────────────────────────────────────────────────────
  if (data.startsWith("buy:")) {
    const at = typeFromCbId(data.slice(4));
    if (!at) return ctx.answerCbQuery("ប្រភេទនេះមិនមានទៀតហើយ។", { show_alert: true });
    const sess = user_sessions[uid];
    if (sess?.state === "payment_pending") return ctx.answerCbQuery("សូមបញ្ចប់ការទិញបច្ចុប្បន្នជាមុនសិន", { show_alert: true });

    await ctx.answerCbQuery();
    const pool  = accounts_data.account_types[at] ?? [];
    const price = accounts_data.prices[at] ?? 0;
    if (pool.length <= 0) {
      return sendMsg(ctx, chatId, `<i>សូមអភ័យទោស គូប៉ុង ${esc(at)} អស់ពីស្តុក 🪤</i>`);
    }

    // Clear old session
    const old = user_sessions[uid];
    if (old?.reserved_accounts?.length && old.account_type) {
      accounts_data.account_types[old.account_type] = [...(old.reserved_accounts), ...(accounts_data.account_types[old.account_type] ?? [])];
      saveAccounts();
    }

    user_sessions[uid] = { state: "waiting_for_quantity", account_type: at, price, available_count: pool.length, started_at: Date.now() };
    saveSessions();

    const typeCbId  = typeCallbackId(at);
    const qtyBtns   = Array.from({ length: Math.min(pool.length, 25) }, (_, i) =>
      Markup.button.callback(String(i + 1), `qty:${typeCbId}:${i + 1}`)
    );
    const rows = [];
    for (let i = 0; i < qtyBtns.length; i += 5) rows.push(qtyBtns.slice(i, i + 5));
    rows.push([Markup.button.callback("🚫 បោះបង់", "cancel_buy")]);

    await sendMsg(ctx, chatId, "<b>សូមជ្រើសរើសចំនួនដែលចង់ទិញ៖</b>", Markup.inlineKeyboard(rows));
    deleteMsg(ctx, chatId, ctx.callbackQuery.message.message_id).catch(() => {});
    return;
  }

  // ── qty:<typeid>:<n> ──────────────────────────────────────────────────────
  if (data.startsWith("qty:")) {
    const parts = data.split(":");
    let   at    = null, qty = null;
    if (parts.length === 3) { at = typeFromCbId(parts[1]); qty = parseInt(parts[2], 10); }
    else if (parts.length === 2) { qty = parseInt(parts[1], 10); }

    if (!qty || qty < 1) return ctx.answerCbQuery();

    const sess = user_sessions[uid];
    if (!sess || sess.state !== "waiting_for_quantity") return ctx.answerCbQuery();
    if (at && sess.account_type !== at) return ctx.answerCbQuery("ប្រភេទផ្លាស់ប្ដូរ — ចាប់ផ្ដើមម្ដងទៀត", { show_alert: true });
    if (qty > sess.available_count) return ctx.answerCbQuery(`សុំទោស! មានត្រឹមតែ ${sess.available_count} នៅក្នុងស្តុក`, { show_alert: true });

    sess.quantity    = qty;
    sess.total_price = Math.round(qty * sess.price * 100) / 100;
    deleteMsg(ctx, chatId, ctx.callbackQuery.message.message_id).catch(() => {});
    await startPaymentForSession(ctx, chatId, uid, sess, ctx);
    return;
  }

  // ── cancel_buy ────────────────────────────────────────────────────────────
  if (data === "cancel_buy") {
    await ctx.answerCbQuery();
    const sess = user_sessions[uid];
    if (sess?.reserved_accounts?.length && sess.account_type) {
      accounts_data.account_types[sess.account_type] = [...sess.reserved_accounts, ...(accounts_data.account_types[sess.account_type] ?? [])];
      saveAccounts();
    }
    delete user_sessions[uid]; saveSessions();
    deleteMsg(ctx, chatId, ctx.callbackQuery.message.message_id).catch(() => {});
    await showAccountSelection(ctx, chatId);
    return;
  }

  // ── cancel_purchase ───────────────────────────────────────────────────────
  if (data === "cancel_purchase") {
    const sess = user_sessions[uid];
    const txnId = sess?.transaction_id;
    // Check if actually paid first (smart cancel)
    if (txnId) {
      try {
        const { paid, data: pd } = await checkKhpayStatus(txnId);
        if (paid) {
          await ctx.answerCbQuery("✅ បានទទួលការបង់ប្រាក់!");
          await deliverAccounts(ctx, chatId, uid, sess, pd);
          return;
        }
      } catch {}
    }
    await ctx.answerCbQuery();
    if (sess) {
      const { account_type, reserved_accounts = [] } = sess;
      if (reserved_accounts.length && account_type) {
        accounts_data.account_types[account_type] = [...reserved_accounts, ...(accounts_data.account_types[account_type] ?? [])];
        saveAccounts();
      }
      for (const k of ["photo_message_id", "qr_message_id"]) {
        if (sess[k]) deleteMsg(ctx, chatId, sess[k]).catch(() => {});
      }
      delete user_sessions[uid]; saveSessions();
    }
    await showAccountSelection(ctx, chatId);
    return;
  }

  // ── Admin: dts: (delete type select) ─────────────────────────────────────
  if (data.startsWith("dts:") && isAdmin(uid)) {
    const typeName = typeFromCbId(data.slice(4)) || data.slice(4);
    if (!accounts_data.account_types[typeName]) return ctx.answerCbQuery("ប្រភេទនេះមិនមានទៀតហើយ!", { show_alert: true });
    await ctx.answerCbQuery();
    const count = accounts_data.account_types[typeName].length;
    const price = accounts_data.prices[typeName] ?? 0;
    await sendMsg(ctx, chatId,
      `⚠️ <b>តើអ្នកពិតជាចង់លុបប្រភេទ គូប៉ុង នេះមែនទេ?</b>\n\n` +
      `<blockquote>🔹 ប្រភេទ: ${esc(typeName)}\n🔹 ចំនួន: ${count}\n🔹 តម្លៃ: $${price}</blockquote>`,
      Markup.inlineKeyboard([[
        Markup.button.callback("✅ បញ្ជាក់លុប", `dtc:${typeCallbackId(typeName)}`),
        Markup.button.callback("🚫 បោះបង់", "dtcancel"),
      ]]));
    return;
  }

  // ── Admin: dtc: (delete type confirm) ────────────────────────────────────
  if (data.startsWith("dtc:") && isAdmin(uid)) {
    const typeName = typeFromCbId(data.slice(4)) || data.slice(4);
    if (!accounts_data.account_types[typeName]) return ctx.answerCbQuery("ប្រភេទនេះមិនមានទៀតហើយ!", { show_alert: true });
    await ctx.answerCbQuery();
    const count = (accounts_data.account_types[typeName] ?? []).length;
    delete accounts_data.account_types[typeName];
    delete accounts_data.prices[typeName];
    accounts_data.accounts = (accounts_data.accounts || []).filter(a => a.type !== typeName);
    saveAccounts();
    deleteMsg(ctx, chatId, ctx.callbackQuery.message.message_id).catch(() => {});
    await sendMsg(ctx, chatId, `✅ <b>បានលុប <code>${esc(typeName)}</code> ចំនួន ${count} records!</b>`);
    return;
  }

  if (data === "dtcancel" && isAdmin(uid)) {
    await ctx.answerCbQuery();
    deleteMsg(ctx, chatId, ctx.callbackQuery.message.message_id).catch(() => {});
    await sendMsg(ctx, chatId, "🚫 <b>បានបោះបង់ការលុប</b>");
    return;
  }

  await ctx.answerCbQuery();
});

// ── 19. Text message router ───────────────────────────────────────────────────
bot.on("text", async ctx => {
  const uid    = ctx.from.id;
  const chatId = ctx.chat.id;
  const text   = ctx.message.text.trim();

  notifyAdminNewUser(ctx, ctx.from).catch(() => {});

  if (MAINTENANCE_MODE && !isAdmin(uid)) {
    return sendMsg(ctx, chatId, "🔧 <b>Bot កំពុង Update សូមរង់ចាំមួយភ្លែត...</b>");
  }

  // Admin ⚙️ button
  if (text === ADMIN_SETTINGS_BTN && isAdmin(uid)) {
    const sess = user_sessions[uid] ?? {};
    if (String(sess.state || "").startsWith("admin_input:")) delete user_sessions[uid];
    saveSessions();
    return sendAdminSettingsMenu(ctx, chatId);
  }

  // ── Admin state machine ───────────────────────────────────────────────────
  if (isAdmin(uid)) {
    const sess  = user_sessions[uid] ?? {};
    const state = sess.state ?? "";

    // BTN_BACK_SETTINGS from any admin state
    if (text === BTN_BACK_SETTINGS) {
      delete user_sessions[uid]; saveSessions();
      return sendAdminSettingsMenu(ctx, chatId);
    }

    // Admin pending input state
    if (state.startsWith("admin_input:")) {
      const key = state.slice("admin_input:".length);
      return handleAdminInput(ctx, chatId, uid, ctx.message.message_id, key, text);
    }

    // Delete type selection
    if (state === "delete_type_select") {
      if (text === BTN_BACK_SETTINGS) { delete user_sessions[uid]; saveSessions(); return sendAdminSettingsMenu(ctx, chatId); }
      const labels = sess.labels || {};
      const typeName = labels[text];
      if (typeName && accounts_data.account_types[typeName] !== undefined) {
        const count = accounts_data.account_types[typeName].length;
        const price = accounts_data.prices[typeName] ?? 0;
        user_sessions[uid] = { state: "delete_type_confirm", type_name: typeName }; saveSessions();
        return sendMsg(ctx, chatId,
          `⚠️ <b>តើអ្នកពិតជាចង់លុបប្រភេទ គូប៉ុង នេះមែនទេ?</b>\n\n` +
          `<blockquote>🔹 ប្រភេទ: ${esc(typeName)}\n🔹 ចំនួន: ${count}\n🔹 តម្លៃ: $${price}</blockquote>`,
          Markup.keyboard([[BTN_DELETE_CONFIRM], [BTN_DELETE_CANCEL]]).resize().persistent());
      }
      return;
    }

    // Delete type confirm
    if (state === "delete_type_confirm") {
      const typeName = sess.type_name;
      delete user_sessions[uid]; saveSessions();
      if (text === BTN_DELETE_CONFIRM && typeName) {
        const count = (accounts_data.account_types[typeName] ?? []).length;
        delete accounts_data.account_types[typeName];
        delete accounts_data.prices[typeName];
        accounts_data.accounts = (accounts_data.accounts || []).filter(a => a.type !== typeName);
        saveAccounts();
        return sendMsg(ctx, chatId, `✅ <b>បានលុបប្រភេទ <code>${esc(typeName)}</code> ចំនួន ${count} records!</b>`, ADMIN_SETTINGS_KB);
      }
      return sendMsg(ctx, chatId, "🚫 <b>បានបោះបង់ការលុប</b>", ADMIN_SETTINGS_KB);
    }

    // Broadcast confirm
    if (state === "broadcast_confirm") {
      const bcastMsgId  = sess.broadcast_message_id;
      const bcastChatId = sess.broadcast_chat_id || chatId;
      const useCopy     = Boolean(sess.broadcast_use_copy);
      delete user_sessions[uid]; saveSessions();
      if (text === BTN_BROADCAST_CONFIRM && bcastMsgId) {
        await sendMsg(ctx, chatId, "📢 កំពុង​ផ្សាយ​សារ ... សូមរង់ចាំ", ADMIN_SETTINGS_KB);
        runBroadcast(ctx, chatId, bcastChatId, bcastMsgId, useCopy);
      } else {
        await sendMsg(ctx, chatId, "🚫 <b>បាន​បោះបង់​ការ​ផ្សាយ</b>", ADMIN_SETTINGS_KB);
      }
      return;
    }

    // Waiting for accounts (coupon input)
    if (state === "waiting_for_accounts") {
      if (text === BTN_BACK_SETTINGS || text === BTN_CANCEL_INPUT) {
        delete user_sessions[uid]; saveSessions(); return sendAdminSettingsMenu(ctx, chatId);
      }
      const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
      if (!lines.length) return sendMsg(ctx, chatId, "<b>អ៊ីមែលមិនត្រឹមត្រូវតាមទម្រង់</b>", ADD_ACCOUNT_KB);

      const newAccounts = lines.map(l => {
        if (l.includes("|")) { const [ph, pw] = l.split("|").map(s => s.trim()); return { phone: ph, password: pw }; }
        return { code: l };
      });
      const existingTypes = Object.keys(accounts_data.account_types);
      user_sessions[uid] = { state: "waiting_for_account_type", accounts: newAccounts }; saveSessions();
      const typeRows = [...existingTypes.map(t => [t]), [BTN_BACK_SETTINGS]];
      return sendMsg(ctx, chatId,
        `<b>បានបញ្ចូល គូប៉ុង ចំនួន ${newAccounts.length}\n\nសូមជ្រើសរើស ឬបញ្ចូលប្រភេទ គូប៉ុង៖</b>`,
        Markup.keyboard(typeRows).resize().persistent());
    }

    // Waiting for account type
    if (state === "waiting_for_account_type") {
      if (text === BTN_BACK_SETTINGS || text === BTN_CANCEL_INPUT) {
        delete user_sessions[uid]; saveSessions(); return sendAdminSettingsMenu(ctx, chatId);
      }
      const existingPrice = accounts_data.prices[text];
      user_sessions[uid] = { ...sess, state: "waiting_for_price", account_type: text }; saveSessions();
      if (existingPrice != null) {
        return sendMsg(ctx, chatId,
          `<b>ប្រភេទ <code>${esc(text)}</code> មានស្រាប់ ដែលមានតម្លៃ ${existingPrice}$\n\nតម្លៃត្រូវតែដូចគ្នា (${existingPrice}$) ដើម្បីបន្ថែម គូប៉ុង</b>`,
          ADD_ACCOUNT_KB);
      }
      return sendMsg(ctx, chatId, `<b>សូមដាក់តម្លៃក្នុងប្រភេទ គូប៉ុង ${esc(text)}</b>`, ADD_ACCOUNT_KB);
    }

    // Waiting for price
    if (state === "waiting_for_price") {
      if (text === BTN_BACK_SETTINGS || text === BTN_CANCEL_INPUT) {
        delete user_sessions[uid]; saveSessions(); return sendAdminSettingsMenu(ctx, chatId);
      }
      const price = parseFloat(text.replace("$", "").trim());
      if (isNaN(price) || price < 0) return sendMsg(ctx, chatId, "តម្លៃមិនត្រឹមត្រូវ។ សូមបញ្ចូលតម្លៃជាលេខ (ឧ: 5.99)");

      const accountType = sess.account_type;
      const accsToAdd   = sess.accounts ?? [];
      const existingPrice = accounts_data.prices[accountType];
      if (existingPrice != null && Math.round(existingPrice * 10000) !== Math.round(price * 10000)) {
        return sendMsg(ctx, chatId,
          `❌ <b>មិនអាចបញ្ចូលបាន!</b>\n\nប្រភេទ <code>${esc(accountType)}</code> មានតម្លៃ <b>${existingPrice}$</b> ស្រាប់។\nតម្លៃ <b>${price}$</b> មិនដូចគ្នា។ សូមប្រើ <b>${existingPrice}$</b>`,
          ADD_ACCOUNT_KB);
      }

      const allExisting = new Set(
        Object.values(accounts_data.account_types).flat()
          .map(a => (a.code || a.email || a.phone || "").toLowerCase())
          .filter(Boolean)
      );
      const toAdd  = accsToAdd.filter(a => !allExisting.has((a.code || a.email || a.phone || "").toLowerCase()));
      const dupes  = accsToAdd.length - toAdd.length;

      if (!accounts_data.account_types[accountType]) accounts_data.account_types[accountType] = [];
      accounts_data.account_types[accountType].push(...toAdd);
      accounts_data.prices[accountType] = Math.round(price * 10000) / 10000;
      accounts_data.accounts = [...(accounts_data.accounts || []), ...toAdd];
      saveAccounts();
      delete user_sessions[uid]; saveSessions();

      await sendMsg(ctx, chatId,
        `✅ <b>បានបញ្ចូល គូប៉ុង ដោយជោគជ័យ</b>\n\n<blockquote>🔹 ចំនួន: ${toAdd.length}\n🔹 ប្រភេទ: ${esc(accountType)}\n🔹 តម្លៃ: ${price}$</blockquote>` +
        (dupes ? `\n\n⚠️ ដដែល (រំលង): ${dupes}` : ""));
      return sendAdminSettingsMenu(ctx, chatId);
    }

    // Admin button dispatcher
    if (ADMIN_BUTTON_LABELS.has(text)) return dispatchAdminButton(ctx, chatId, uid, text);
  }

  // ── User: 💵 ទិញគូប៉ុង ───────────────────────────────────────────────────
  if (text === "💵 ទិញគូប៉ុង") {
    const sess = user_sessions[uid];
    if (sess?.state === "payment_pending") {
      return sendMsg(ctx, chatId,
        "⏳ <b>សូមបញ្ចប់ការទិញបច្ចុប្បន្នជាមុនសិន</b>\n\nអ្នកមានការបញ្ជាទិញមួយកំពុងដំណើរការ។ " +
        "សូមបញ្ចប់ការទូទាត់ ឬចុច <b>🚫 បោះបង់</b> មុននឹងចាប់ផ្ដើមការទិញថ្មី។");
    }
    delete user_sessions[uid];
    return showAccountSelection(ctx, chatId);
  }

  // Default fallback
  if (user_sessions[uid]?.state === "payment_pending") {
    return sendMsg(ctx, chatId, "⏳ <b>សូមបញ្ចប់ការទូទាត់ QR ជាមុនសិន</b>\nឬចុច <b>🚫 បោះបង់</b> ដើម្បីបោះបង់");
  }
  await showAccountSelection(ctx, chatId);
});

// ── 20. Admin button dispatcher ───────────────────────────────────────────────
async function dispatchAdminButton(ctx, chatId, uid, btn) {
  switch (btn) {
    case BTN_ADD_ACCOUNT:
      user_sessions[uid] = { state: "waiting_for_accounts" }; saveSessions();
      return sendMsg(ctx, chatId, "<b>បញ្ចូលគូប៉ុងសម្រាប់លក់</b>", ADD_ACCOUNT_KB);

    case BTN_DELETE_TYPE: {
      const types = Object.keys(accounts_data.account_types);
      if (!types.length) return sendMsg(ctx, chatId, "⚠️ <b>មិនមានប្រភេទ គូប៉ុង ណាមួយទេ!</b>");
      const labelsMap = {};
      const rows = types.map(t => {
        const count = accounts_data.account_types[t].length;
        const label = `${shortLabel(t)} – មានក្នុងស្តុក ${count}`;
        labelsMap[label] = t;
        return [label];
      });
      rows.push([BTN_BACK_SETTINGS]);
      user_sessions[uid] = { state: "delete_type_select", labels: labelsMap }; saveSessions();
      return sendMsg(ctx, chatId, "🗑 <b>ជ្រើសរើសប្រភេទ គូប៉ុង ដែលចង់លុប៖</b>",
        Markup.keyboard(rows).resize().persistent());
    }

    case BTN_STOCK:       return exportStock(ctx, chatId);
    case BTN_BUYERS:      return exportBuyers(ctx, chatId);
    case BTN_USERS:       return showUsersList(ctx, chatId);

    case BTN_KHPAY:
      return sendMsg(ctx, chatId,
        `💰 <b>KhPay API Key បច្ចុប្បន្ន៖</b>\n\n<code>${esc(KHPAY_API_KEY.slice(0,12))}…${esc(KHPAY_API_KEY.slice(-4))}</code>`,
        KHPAY_SUBMENU_KB);

    case BTN_KHPAY_KEY_EDIT:
      user_sessions[uid] = { state: "admin_input:khpay_key" }; saveSessions();
      return sendMsg(ctx, chatId, "💰 សូមផ្ញើ <b>KhPay API Key</b> ថ្មី:\n\n<i>ចុច 🚫 បោះបង់ ដើម្បីបោះបង់</i>", CANCEL_INPUT_KB);

    case BTN_KHPAY_INFO:
      return sendKhpayInfo(ctx, chatId);

    case BTN_CHANNEL: {
      const cur = CHANNEL_ID || "(មិនទាន់កំណត់)";
      return sendMsg(ctx, chatId,
        `📢 <b>Channel ID បច្ចុប្បន្ន៖</b>\n<code>${esc(String(cur))}</code>`,
        CHANNEL_SUBMENU_KB);
    }

    case BTN_CHANNEL_EDIT:
      user_sessions[uid] = { state: "admin_input:channel" }; saveSessions();
      return sendMsg(ctx, chatId,
        "📢 សូមផ្ញើ <b>Channel ID</b> ថ្មី (ឧ. <code>-1001234567890</code>):\n\n<i>ចុច 🚫 បោះបង់ ដើម្បីបោះបង់</i>",
        CANCEL_INPUT_KB);

    case BTN_CHANNEL_CLEAR:
      CHANNEL_ID = ""; setSetting("TELEGRAM_CHANNEL_ID", "");
      return sendMsg(ctx, chatId, "✅ បានលុប Channel ID", ADMIN_SETTINGS_KB);

    case BTN_ADMINS: {
      const extras = [...EXTRA_ADMIN_IDS].sort();
      const extrasStr = extras.length ? extras.map(x => `• <code>${x}</code>`).join("\n") : "(គ្មាន)";
      return sendMsg(ctx, chatId,
        `👑 <b>Admin បឋម៖</b> <code>${ADMIN_ID}</code>\n\n➕ <b>Admin បន្ថែម៖</b>\n${extrasStr}`,
        ADMINS_SUBMENU_KB);
    }

    case BTN_ADMIN_ADD:
      user_sessions[uid] = { state: "admin_input:admin_add" }; saveSessions();
      return sendMsg(ctx, chatId, "➕ សូមផ្ញើ <b>Telegram User ID</b> ដែលចង់បន្ថែម:", CANCEL_INPUT_KB);

    case BTN_ADMIN_REMOVE:
      user_sessions[uid] = { state: "admin_input:admin_remove" }; saveSessions();
      return sendMsg(ctx, chatId, "➖ សូមផ្ញើ <b>Telegram User ID</b> ដែលចង់ដក:", CANCEL_INPUT_KB);

    case BTN_MAINTENANCE: {
      const status = MAINTENANCE_MODE ? "🔴 បិទ" : "🟢 បើក";
      return sendMsg(ctx, chatId, `🛠 <b>ស្ថានភាព Bot បច្ចុប្បន្ន៖</b> ${status}`, MAINTENANCE_SUBMENU_KB);
    }

    case BTN_MAINT_ON:
      MAINTENANCE_MODE = true; setSetting("MAINTENANCE_MODE", "true");
      return sendMsg(ctx, chatId, "🔴 បានបិទ Bot", ADMIN_SETTINGS_KB);

    case BTN_MAINT_OFF:
      MAINTENANCE_MODE = false; setSetting("MAINTENANCE_MODE", "false");
      return sendMsg(ctx, chatId, "🟢 បានបើក Bot", ADMIN_SETTINGS_KB);

    case BTN_BROADCAST:
      user_sessions[uid] = { state: "admin_input:broadcast" }; saveSessions();
      return sendMsg(ctx, chatId,
        "📢 សូមផ្ញើ​សារ​ដែល​ចង់​ផ្សាយ​ទៅ​អ្នក​ប្រើ​ប្រាស់​ទាំង​អស់៖\n\n<i>ចុច 🚫 បោះបង់ ដើម្បីបោះបង់</i>",
        CANCEL_INPUT_KB);

    case BTN_EMAIL_MGMT: {
      const tokenStatus = DROPMAIL_TOKEN
        ? `✅ Token: <code>${esc(DROPMAIL_TOKEN.slice(0,8))}…</code>`
        : "❌ មិនទាន់មាន Token — ចុច 🔑 កំណត់ Token";
      const allSessions = getAllDropmailSessions();
      const entries = Object.entries(allSessions);
      let emailList;
      if (!entries.length) {
        emailList = "📭 មិនទាន់មាន Email (ចុច 📨 Email ថ្មី)";
      } else {
        emailList = `📋 <b>Email Sessions (${entries.length}):</b>\n\n` +
          entries.map(([sessUid, s], i) => {
            const exp = s.expiresAt ? new Date(s.expiresAt).toISOString().slice(0,16).replace("T"," ") : "—";
            const mine = String(sessUid) === String(uid) ? " 👤" : "";
            return `${i + 1}. <code>${esc(s.address)}</code>${mine}\n    ⏱ ${esc(exp)} UTC`;
          }).join("\n\n");
      }
      return sendMsg(ctx, chatId,
        `📧 <b>ការគ្រប់គ្រងអ៊ីម៉ែល (Dropmail)</b>\n\n${tokenStatus}\n\n${emailList}`,
        EMAIL_SUBMENU_KB);
    }

    case BTN_EMAIL_SET_TOKEN:
      user_sessions[uid] = { state: "admin_input:email_token" }; saveSessions();
      return sendMsg(ctx, chatId,
        "🔑 សូមផ្ញើ <b>Dropmail API Token</b> របស់អ្នក:\n\n<i>ទទួល token ពី <a href=\"https://dropmail.me\">dropmail.me</a> (GraphQL API Token)</i>\n\n<i>ចុច 🚫 បោះបង់ ដើម្បីបោះបង់</i>",
        CANCEL_INPUT_KB);

    case BTN_EMAIL_NEW: {
      if (!DROPMAIL_TOKEN) {
        return sendMsg(ctx, chatId,
          "❌ មិនទាន់មាន Dropmail Token! សូមចុច 🔑 កំណត់ Token ជាមុនសិន។",
          EMAIL_SUBMENU_KB);
      }
      try {
        await sendMsg(ctx, chatId, "⏳ កំពុងបង្កើត Email ថ្មី…", EMAIL_SUBMENU_KB);
        const session = await dropmailCreateSession();
        if (!session || !session.addresses?.length) {
          return sendMsg(ctx, chatId, "❌ មិនអាចបង្កើត Email បានទេ។ Token ប្រហែលមិនត្រឹមត្រូវ។", EMAIL_SUBMENU_KB);
        }
        const address = session.addresses[0].address;
        const expires = session.expiresAt ? new Date(session.expiresAt).toISOString().slice(0,19) + " UTC" : "—";
        setDropmailSession(uid, { sessionId: session.id, address, expiresAt: session.expiresAt });
        startEmailLivePolling();
        return sendMsg(ctx, chatId,
          `✅ <b>Email ថ្មីបានបង្កើត!</b>\n\n` +
          `📧 <b>Address:</b> <code>${esc(address)}</code>\n` +
          `🆔 <b>Session ID:</b> <code>${esc(session.id)}</code>\n` +
          `⏱ <b>Expires:</b> ${esc(expires)}\n\n` +
          `<i>ចុច 📥 Inbox ដើម្បីមើលអ៊ីម៉ែលដែលទទួល</i>`,
          EMAIL_SUBMENU_KB);
      } catch (e) {
        return sendMsg(ctx, chatId, `❌ Error: <code>${esc(e.message)}</code>`, EMAIL_SUBMENU_KB);
      }
    }

    case BTN_EMAIL_INBOX: {
      const sess = getDropmailSession(uid);
      if (!sess) {
        return sendMsg(ctx, chatId,
          "❌ មិនទាន់មាន Email! ចុច 📨 Email ថ្មី ដើម្បីបង្កើតមួយ។",
          EMAIL_SUBMENU_KB);
      }
      if (!DROPMAIL_TOKEN) {
        return sendMsg(ctx, chatId,
          "❌ មិនទាន់មាន Dropmail Token! សូមចុច 🔑 កំណត់ Token ជាមុនសិន។",
          EMAIL_SUBMENU_KB);
      }
      try {
        await sendMsg(ctx, chatId, `⏳ កំពុងពិនិត្យ Inbox <code>${esc(sess.address)}</code>…`, EMAIL_SUBMENU_KB);
        const session = await dropmailGetSession(sess.sessionId);
        if (!session) {
          setDropmailSession(uid, null);
          return sendMsg(ctx, chatId,
            "❌ Session ផុតកំណត់ ឬ Token មិនត្រឹមត្រូវ។ សូមបង្កើត Email ថ្មី។",
            EMAIL_SUBMENU_KB);
        }
        const mails = session.mails || [];
        const expires = session.expiresAt ? new Date(session.expiresAt).toISOString().slice(0,19) + " UTC" : "—";
        if (!mails.length) {
          return sendMsg(ctx, chatId,
            `📭 <b>Inbox ទទេ</b>\n\n📧 <code>${esc(sess.address)}</code>\n⏱ Expires: ${esc(expires)}\n\n<i>រង់ចាំអ៊ីម៉ែលចូល…</i>`,
            EMAIL_SUBMENU_KB);
        }
        const header = `📥 <b>Inbox</b> — ${mails.length} អ៊ីម៉ែល\n📧 <code>${esc(sess.address)}</code>\n━━━━━━━━━━━━━━━━━━━\n`;
        const targets = [chatId];
        if (CHANNEL_ID && String(CHANNEL_ID) !== String(chatId)) targets.push(CHANNEL_ID);
        for (const target of targets) await sendMsg(ctx, target, header, EMAIL_SUBMENU_KB).catch(() => {});
        for (let i = 0; i < mails.length; i++) {
          const m = mails[i];
          const subject = m.headerSubject || "(គ្មាន subject)";
          const from    = m.fromAddr || "—";
          const body    = (m.text || "").slice(0, 500) || "(គ្មានខ្លឹមសារ)";
          const mailMsg =
            `📨 <b>អ៊ីម៉ែល #${i + 1}</b>\n` +
            `👤 <b>From:</b> <code>${esc(from)}</code>\n` +
            `📌 <b>Subject:</b> ${esc(subject)}\n` +
            `━━━━━━━━━━━━━━━━━━━\n` +
            `${esc(body)}${(m.text || "").length > 500 ? "\n<i>…(truncated)</i>" : ""}`;
          for (const target of targets) await sendMsg(ctx, target, mailMsg).catch(() => {});
        }
        return;
      } catch (e) {
        return sendMsg(ctx, chatId, `❌ Error: <code>${esc(e.message)}</code>`, EMAIL_SUBMENU_KB);
      }
    }

    case BTN_EMAIL_LIST: {
      const allSessions = getAllDropmailSessions();
      const entries = Object.entries(allSessions);
      if (!entries.length) {
        return sendMsg(ctx, chatId, "📭 <b>មិនទាន់មាន Email session ណាមួយទេ។</b>\n\nចុច 📨 Email ថ្មី ដើម្បីបង្កើត។", EMAIL_SUBMENU_KB);
      }
      const now = Date.now();
      const lines = entries.map(([sessUid, s], i) => {
        const exp = s.expiresAt ? new Date(s.expiresAt).toISOString().slice(0, 16).replace("T", " ") : "—";
        const expired = s.expiresAt && new Date(s.expiresAt).getTime() < now;
        const status = expired ? "❌ ផុតកំណត់" : "✅ សកម្ម";
        const mine = String(sessUid) === String(uid) ? " <b>(អ្នក)</b>" : "";
        return `${i + 1}. 📧 <code>${esc(s.address)}</code>${mine}\n    ${status} | ⏱ ${esc(exp)} UTC`;
      });
      return sendMsg(ctx, chatId,
        `📋 <b>បញ្ជី Email Sessions (${entries.length})</b>\n\n` + lines.join("\n\n"),
        EMAIL_SUBMENU_KB);
    }

    case BTN_EMAIL_CLEAR:
      setDropmailSession(uid, null);
      return sendMsg(ctx, chatId, "🗑 បានលុប Email session — ចុច 📨 Email ថ្មី ដើម្បីបង្កើតម្ដងទៀត។", EMAIL_SUBMENU_KB);

    default:
      return sendAdminSettingsMenu(ctx, chatId);
  }
}

// ── 21. Admin input handlers ──────────────────────────────────────────────────
async function handleAdminInput(ctx, chatId, uid, msgId, key, text) {
  const cancelWords = new Set(["បោះបង់", "🚫 បោះបង់", BTN_CANCEL_INPUT, BTN_BACK_SETTINGS]);
  if (cancelWords.has(text)) {
    delete user_sessions[uid]; saveSessions();
    return sendAdminSettingsMenu(ctx, chatId);
  }

  if (key === "khpay_key") {
    if (!text || !text.startsWith("ak_")) return sendMsg(ctx, chatId, "❌ KhPay API Key ត្រូវចាប់ផ្ដើមដោយ <code>ak_</code>\n\nសូមផ្ញើ Key ត្រឹមត្រូវ (ឬចុច 🚫 បោះបង់)");
    KHPAY_API_KEY = text;
    setSetting("KHPAY_API_KEY", text);
    delete user_sessions[uid]; saveSessions();
    deleteMsg(ctx, chatId, msgId).catch(() => {});
    return sendMsg(ctx, chatId,
      `✅ បានប្តូរ <b>KhPay API Key</b>\n<code>${esc(text.slice(0, 12))}…${esc(text.slice(-4))}</code>`,
      mainKb(uid));
  }

  if (key === "channel") {
    if (!text) return sendMsg(ctx, chatId, "សូមផ្ញើ Channel ID ថ្មី ឬ <code>off</code> ដើម្បីបិទ");
    if (["off","none","clear","delete","remove"].includes(text.toLowerCase())) {
      CHANNEL_ID = ""; setSetting("TELEGRAM_CHANNEL_ID", "");
    } else {
      CHANNEL_ID = text; setSetting("TELEGRAM_CHANNEL_ID", text);
    }
    delete user_sessions[uid]; saveSessions();
    return sendMsg(ctx, chatId, `✅ បានកំណត់ Channel ID ទៅជា <code>${esc(CHANNEL_ID || "(ទទេ)")}</code>`, mainKb(uid));
  }

  if (key === "admin_add") {
    const target = parseInt(text, 10);
    if (isNaN(target)) return sendMsg(ctx, chatId, "❌ user_id ត្រូវតែជាលេខ (ឬចុច 🚫 បោះបង់)");
    if (target === ADMIN_ID) { delete user_sessions[uid]; saveSessions(); return sendMsg(ctx, chatId, "ℹ️ Admin បឋមមិនអាចលុប/បន្ថែមបានទេ។", mainKb(uid)); }
    EXTRA_ADMIN_IDS.add(target);
    setSetting("EXTRA_ADMIN_IDS", JSON.stringify([...EXTRA_ADMIN_IDS]));
    delete user_sessions[uid]; saveSessions();
    return sendMsg(ctx, chatId, `✅ បានបន្ថែម <code>${target}</code> ជា admin`);
  }

  if (key === "admin_remove") {
    const target = parseInt(text, 10);
    if (isNaN(target)) return sendMsg(ctx, chatId, "❌ user_id ត្រូវតែជាលេខ (ឬចុច 🚫 បោះបង់)");
    EXTRA_ADMIN_IDS.delete(target);
    setSetting("EXTRA_ADMIN_IDS", JSON.stringify([...EXTRA_ADMIN_IDS]));
    delete user_sessions[uid]; saveSessions();
    return sendMsg(ctx, chatId, `✅ បានដក <code>${target}</code> ចាក admin`);
  }

  if (key === "email_token") {
    if (!text) return sendMsg(ctx, chatId, "❌ Token មិនអាចទទេបានទេ (ឬចុច 🚫 បោះបង់)");
    DROPMAIL_TOKEN = text;
    setSetting("DROPMAIL_TOKEN", text);
    delete user_sessions[uid]; saveSessions();
    deleteMsg(ctx, chatId, msgId).catch(() => {});
    return sendMsg(ctx, chatId,
      `✅ បានកំណត់ <b>Dropmail Token</b>\n<code>${esc(text.slice(0,8))}…</code>\n\nឥឡូវចុច 📨 Email ថ្មី ដើម្បីបង្កើត Email!`,
      EMAIL_SUBMENU_KB);
  }

  if (key === "broadcast") {
    // Store message for forward/copy broadcast
    user_sessions[uid] = {
      state: "broadcast_confirm",
      broadcast_message_id:  ctx.message.message_id,
      broadcast_chat_id:     chatId,
      broadcast_use_copy:    true,
      broadcast_text:        text,
    }; saveSessions();
    return sendMsg(ctx, chatId,
      `📢 <b>ព្រមព្រៀងផ្សាយ:</b>\n\n${esc(text)}\n\n<i>ផ្សាយទៅអ្នកប្រើ ${Object.keys(known_users).length} នាក់</i>`,
      BROADCAST_CONFIRM_KB);
  }
}

// ── 22. Broadcast ─────────────────────────────────────────────────────────────
async function runBroadcast(ctx, adminChatId, srcChatId, srcMsgId, useCopy) {
  const uids = Object.keys(known_users);
  let sent = 0, failed = 0, blocked = 0;
  for (const uidStr of uids) {
    const uid = Number(uidStr);
    try {
      if (useCopy) {
        await ctx.telegram.copyMessage(uid, srcChatId, srcMsgId);
      } else {
        await ctx.telegram.forwardMessage(uid, srcChatId, srcMsgId);
      }
      sent++;
    } catch (e) {
      if (e.message?.includes("blocked") || e.message?.includes("deactivated")) blocked++;
      else failed++;
    }
    await new Promise(r => setTimeout(r, 50));
  }
  await sendMsg(ctx, adminChatId,
    "📢 <b>ផ្សាយ​សារ​បាន​ចប់</b>\n" +
    "━━━━━━━━━━━━━━━━━━━\n" +
    `👥 សរុប:         ${uids.length}\n` +
    `✅ ផ្ញើ​ជោគជ័យ:   ${sent}\n` +
    `⛔ បាន​ប្លុក/លុប:  ${blocked}\n` +
    `❌ បរាជ័យ:        ${failed}`, ADMIN_SETTINGS_KB);
}

// ── 23. Stock / Buyers / Users exports ───────────────────────────────────────
async function exportStock(ctx, chatId) {
  const types  = accounts_data.account_types;
  const prices = accounts_data.prices;
  const names  = Object.keys(types).sort();

  if (!names.length) {
    return sendMsg(ctx, chatId, "📦 មិនមានប្រភេទ គូប៉ុង ឡើយទេ។", ADMIN_SETTINGS_KB);
  }

  const totalAvail = names.reduce((s, t) => s + (types[t] || []).length, 0);
  await sendMsg(ctx, chatId, `📦 <b>ស្តុក គូប៉ុង</b> — ${names.length} ប្រភេទ, ${totalAvail} នៅសល់`);

  for (const t of names) {
    const pool  = types[t] || [];
    const price = prices[t] ?? 0;
    const lines = pool.map(acc => `• ${esc(formatAccount(acc))}`);
    let block = `<b>${esc(t)}</b>  💰 $${price}  📦 ${pool.length}\n` +
                (lines.length ? lines.join("\n") : "<i>(គ្មាន)</i>");
    // Split if too long
    const MAX = 4000;
    while (block.length > MAX) {
      const cut = block.lastIndexOf("\n", MAX);
      await sendMsg(ctx, chatId, block.slice(0, cut === -1 ? MAX : cut));
      block = block.slice(cut === -1 ? MAX : cut + 1);
    }
    if (block) await sendMsg(ctx, chatId, block);
  }
  return sendAdminSettingsMenu(ctx, chatId);
}

async function exportBuyers(ctx, chatId) {
  if (!purchases.length) {
    return sendMsg(ctx, chatId, "មិនមានទិន្នន័យ​ទិញ​នៅឡើយ​ទេ។", ADMIN_SETTINGS_KB);
  }
  const grouped = {};
  for (const p of purchases) {
    const uid = String(p.user_id);
    if (!grouped[uid]) {
      const u = known_users[uid] || {};
      grouped[uid] = { first_name: u.first_name || "", last_name: u.last_name || "", username: u.username || "", purchases: [] };
    }
    grouped[uid].purchases.push(p);
  }
  const W = 60;
  const now_str = new Date().toISOString().slice(0,19) + " UTC";
  const lines = [
    "=".repeat(W),
    "  BUYERS REPORT".padStart((W + 14) / 2).padEnd(W),
    `  ${now_str}`.padEnd(W),
    "=".repeat(W),
    `  Total buyers : ${Object.keys(grouped).length}`,
  ];
  for (const [uid, info] of Object.entries(grouped)) {
    const fn = [info.first_name, info.last_name].filter(Boolean).join(" ") || "(no name)";
    const un = info.username ? `@${info.username}` : "—";
    lines.push("", "─".repeat(W),
      `  ID       : ${uid}`, `  Name     : ${fn}`, `  Username : ${un}`,
      `  Purchases: ${info.purchases.length}`, "─".repeat(W));
    info.purchases.forEach((p, i) => {
      const when = (p.purchased_at || "").slice(0, 19);
      lines.push(`  [${i+1}] ${p.account_type}`, `      Qty   : ${p.quantity}`,
        `      Price : $${p.total_price}`, `      Date  : ${when}`, "      Accounts:");
      (p.accounts || []).forEach(a => lines.push(`        • ${formatAccount(a)}`));
      if (!(p.accounts || []).length) lines.push("        (none)");
    });
  }
  lines.push("", "=".repeat(W), "=".repeat(W));

  const now_ts = new Date().toISOString().replace(/[:.]/g,"").slice(0,15);
  const buf    = Buffer.from(lines.join("\n"), "utf8");
  await sendDocument(ctx, chatId, buf, `buyers_${now_ts}.txt`,
    `📋 របាយការណ៍ទិញ — ${Object.keys(grouped).length} អ្នក​ទិញ`);
  return sendAdminSettingsMenu(ctx, chatId);
}

async function showUsersList(ctx, chatId) {
  const rows = Object.entries(known_users);
  if (!rows.length) {
    return sendMsg(ctx, chatId, "📭 <b>មិនទាន់មានអ្នកប្រើប្រាស់ទេ។</b>", BACK_SETTINGS_KB);
  }
  const lines = [`👥 អ្នកប្រើប្រាស់សរុប: ${rows.length}`, ""];
  for (const [uid, info] of rows) {
    const full  = [info.first_name, info.last_name].filter(Boolean).join(" ") || "N/A";
    const uname = info.username ? `@${info.username}` : "—";
    lines.push(`${full}`, `   🔖 ${uname}`, `   🪪 ${uid}`, "");
  }
  const now_ts = new Date().toISOString().replace(/[:.]/g,"").slice(0,15);
  const buf    = Buffer.from(lines.join("\n"), "utf8");
  await sendDocument(ctx, chatId, buf, `users_${now_ts}.txt`,
    `👥 បញ្ជីអ្នកប្រើប្រាស់ — ${rows.length} នាក់`);
  return sendAdminSettingsMenu(ctx, chatId);
}

// ── 24. KhPay account info ────────────────────────────────────────────────────
async function sendKhpayInfo(ctx, chatId) {
  try {
    const data = await khpayRequest("GET", "/me");
    if (!data.success) {
      return sendMsg(ctx, chatId,
        `💰 <b>KhPay API Info</b>\n\n❌ ${esc(data.error || "API Error")}`, KHPAY_SUBMENU_KB);
    }
    const d   = data.data;
    const key = KHPAY_API_KEY;
    const masked = `${key.slice(0,12)}…${key.slice(-4)}`;
    const lines = [
      "💰 <b>KhPay Account Info</b>",
      "━━━━━━━━━━━━━━━━━━━",
      `👤 <b>ឈ្មោះ:</b> ${esc(d.name || "—")}`,
      `📧 <b>Email:</b> <code>${esc(d.email || "—")}</code>`,
      `📦 <b>Plan:</b> ${esc(d.plan || "—")}`,
      `🔑 <b>API Key:</b> <code>${esc(masked)}</code>`,
      `💳 <b>Bakong:</b> ${d.bakong_configured ? "✅ Configured" : "❌ Not set"}`,
      `🔗 <b>Payway:</b> ${d.payway_link_set ? "✅ Linked" : "❌ Not linked"}`,
      "━━━━━━━━━━━━━━━━━━━",
      `📊 <b>ការប្រើប្រាស់ API:</b>`,
      `   • ថ្ងៃនេះ: ${d.usage?.today ?? 0}`,
      `   • ខែនេះ: ${d.usage?.month ?? 0}`,
      `   • សរុប: ${d.usage?.total ?? 0}`,
    ];
    return sendMsg(ctx, chatId, lines.join("\n"), KHPAY_SUBMENU_KB);
  } catch (e) {
    return sendMsg(ctx, chatId,
      `💰 <b>KhPay API Info</b>\n\n❌ Error: <code>${esc(e.message)}</code>`, KHPAY_SUBMENU_KB);
  }
}

// ── 25. Recovery of pending sessions after restart ────────────────────────────
async function recoverPendingSessions() {
  const pending = Object.entries(user_sessions).filter(([, s]) => s.state === "payment_pending");
  if (!pending.length) return;
  console.log(`[INFO] Recovery: ${pending.length} pending session(s) found — watchdog will handle them`);

  const fakeCtx = { telegram: bot.telegram };
  for (const [uidStr] of pending) {
    const uid = Number(uidStr);
    await sendMsg(fakeCtx, uid,
      "⚠️ <b>Bot បានចាប់ផ្ដើមឡើងវិញ!</b>\n\nQR Code របស់អ្នកនៅតែដំណើរការ។ សូមមើលរូប QR ចាស់ ឬរង់ចាំ…"
    ).catch(() => {});
  }
}

// ── 26. Startup ───────────────────────────────────────────────────────────────
function loadAll() {
  const db       = readDB();
  settings       = db.settings   ?? {};
  accounts_data  = db.accounts   ?? { accounts: [], account_types: {}, prices: {} };
  known_users    = db.users      ?? {};
  purchases      = db.purchases  ?? [];
  const stored   = db.sessions   ?? {};
  for (const [k, v] of Object.entries(stored)) user_sessions[Number(k)] = v;

  // Restore settings
  const pm = getSetting("PAYMENT_NAME");       if (pm)   PAYMENT_NAME = pm;
  const mm = getSetting("MAINTENANCE_MODE");   if (mm)   MAINTENANCE_MODE = mm === "true";
  const ch = getSetting("TELEGRAM_CHANNEL_ID"); if (ch) CHANNEL_ID = ch;
  const kk = getSetting("KHPAY_API_KEY");      if (kk)   KHPAY_API_KEY = kk;
  const ea = getSetting("EXTRA_ADMIN_IDS");    if (ea)   { try { EXTRA_ADMIN_IDS = new Set(JSON.parse(ea).map(Number)); } catch {} }
  const dt = getSetting("DROPMAIL_TOKEN");     if (dt)   DROPMAIL_TOKEN = dt;

  // Persistent webhook secret — generate once, reuse on restart
  let whs = getSetting("WEBHOOK_SECRET");
  if (!whs) { whs = crypto.randomBytes(16).toString("hex"); setSetting("WEBHOOK_SECRET", whs); }
  WEBHOOK_SECRET = whs;
  WEBHOOK_URL    = `https://${process.env.REPLIT_DEV_DOMAIN || "localhost"}/khpay-webhook?secret=${WEBHOOK_SECRET}`;

  loadSeenHashes();

  const couponCount = Object.values(accounts_data.account_types).reduce((s, a) => s + a.length, 0);
  console.log(`[INFO] Loaded: ${couponCount} coupons, ${Object.keys(known_users).length} users, ${purchases.length} purchases`);
}

process.once("SIGINT",  () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));

loadAll();
bot.launch();

(async () => {
  try {
    const me = await bot.telegram.getMe();
    console.log(`[INFO] Bot ready: @${me.username}`);
    try { await bot.telegram.sendMessage(ADMIN_ID, "✅ <b>Bot ចាប់ផ្ដើម! (JavaScript — 100% GitHub structure)</b>", { parse_mode: "HTML" }); } catch {}
  } catch {}
  await recoverPendingSessions();
  startWebhookServer();
  startPaymentWatchdog();
  startEmailLivePolling();
})();
