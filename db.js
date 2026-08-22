const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');

// ⚠️ Render Free tier မှာ disk က deploy တိုင်း reset ဖြစ်တတ်ပါတယ်
// Production အတွက် Render "Persistent Disk" ($1/mo~) ထည့်ဖို့ လိုအပ်ပါတယ်
// (Render Dashboard → Service → Disks → Add Disk → mount path "/data" ထည့်ပြီး
//  DB_PATH environment variable ကို "/data/db.sqlite" လို့ ထားပါ)
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.sqlite');
const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS licenses (
    code TEXT PRIMARY KEY,
    plan TEXT NOT NULL,
    char_limit INTEGER NOT NULL,
    chars_used INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    note TEXT,
    email TEXT
  );
  CREATE TABLE IF NOT EXISTS usage_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL,
    chars INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS free_usage (
    email TEXT NOT NULL,
    day TEXT NOT NULL,
    chars_used INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (email, day)
  );
  CREATE TABLE IF NOT EXISTS telegram_users (
    username TEXT PRIMARY KEY,
    chat_id INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);

const FREE_DAILY_CHARS = 500; // Pricing page ထဲက "နေ့စဉ်အစမ်းသုံး" quota

// Plan (business rule) — pricing page ထဲက plan တွေနဲ့ ကိုက်အောင် ထားထားတယ်
const PLANS = {
  '7A':  { days: 7,  chars: 100000,  maxExtra: 0 },
  '7B':  { days: 7,  chars: 250000,  maxExtra: 0 },
  '30A': { days: 30, chars: 300000,  maxExtra: 200000 },
  '30B': { days: 30, chars: 1000000, maxExtra: 500000 },
  '30C': { days: 30, chars: 2000000, maxExtra: 500000 },
};
const ADDON_CHARS = 100000; // 5,000 ကျပ် တစ်ခါ ထပ်တိုးရင် ရမယ့် စာလုံးရေ

function generateCode() {
  return 'JOKER-' + crypto.randomBytes(4).toString('hex').toUpperCase();
}

function createLicense(planKey, note = '') {
  const plan = PLANS[planKey];
  if (!plan) throw new Error('Plan မမှန်ပါ: ' + planKey);
  const code = generateCode();
  const now = Date.now();
  const expiresAt = now + plan.days * 24 * 60 * 60 * 1000;
  db.prepare(`
    INSERT INTO licenses (code, plan, char_limit, chars_used, created_at, expires_at, active, note)
    VALUES (?, ?, ?, 0, ?, ?, 1, ?)
  `).run(code, planKey, plan.chars, now, expiresAt, note);
  return getLicense(code);
}

function getLicense(code) {
  return db.prepare('SELECT * FROM licenses WHERE code = ?').get(code);
}

function listLicenses() {
  return db.prepare('SELECT * FROM licenses ORDER BY created_at DESC').all();
}

function checkAndReserve(code, charCount) {
  const lic = getLicense(code);
  if (!lic) return { ok: false, error: 'Code မှားနေပါတယ်' };
  if (!lic.active) return { ok: false, error: 'ဒီ Code ကို ပိတ်ထားပါတယ်' };
  if (Date.now() > lic.expires_at) return { ok: false, error: 'Plan သက်တမ်းကုန်သွားပါပြီ' };
  const remaining = lic.char_limit - lic.chars_used;
  if (charCount > remaining) {
    return { ok: false, error: `စာလုံးရေ လိုအပ်ချက် ကျော်နေပါတယ် (ကျန်ရှိ: ${remaining.toLocaleString()} စာလုံး)` };
  }
  db.prepare('UPDATE licenses SET chars_used = chars_used + ? WHERE code = ?').run(charCount, code);
  db.prepare('INSERT INTO usage_log (code, chars, created_at) VALUES (?, ?, ?)').run(code, charCount, Date.now());
  const updated = getLicense(code);
  return { ok: true, remaining: updated.char_limit - updated.chars_used };
}

function extendLicense(code, extraChars, extraDays) {
  const lic = getLicense(code);
  if (!lic) throw new Error('Code မတွေ့ပါ');
  const newLimit = lic.char_limit + (extraChars || 0);
  const newExpiry = lic.expires_at + (extraDays || 0) * 24 * 60 * 60 * 1000;
  db.prepare('UPDATE licenses SET char_limit = ?, expires_at = ? WHERE code = ?').run(newLimit, newExpiry, code);
  return getLicense(code);
}

function setActive(code, active) {
  db.prepare('UPDATE licenses SET active = ? WHERE code = ?').run(active ? 1 : 0, code);
  return getLicense(code);
}

// Code ကို login ဝင်ထားတဲ့ user ရဲ့ email နဲ့ ချိတ်ဆက်ပေးတယ် (ပထမဆုံး သုံးတုန်းက)
function attachEmail(code, email) {
  const lic = getLicense(code);
  if (lic && !lic.email && email) {
    db.prepare('UPDATE licenses SET email = ? WHERE code = ?').run(email, code);
  }
}

function getLicensesByEmail(email) {
  return db.prepare('SELECT * FROM licenses WHERE email = ? ORDER BY created_at DESC').all(email);
}

function todayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function getFreeUsageToday(email) {
  const row = db.prepare('SELECT chars_used FROM free_usage WHERE email = ? AND day = ?').get(email, todayKey());
  return row ? row.chars_used : 0;
}

function checkAndReserveFree(email, charCount) {
  const used = getFreeUsageToday(email);
  const remaining = FREE_DAILY_CHARS - used;
  if (charCount > remaining) {
    return { ok: false, error: `နေ့စဉ်အခမဲ့ quota ကျော်နေပါတယ် (ကျန်ရှိ: ${remaining} / ${FREE_DAILY_CHARS} စာလုံး) — Access Code ဝယ်ပြီး ဆက်သုံးနိုင်ပါတယ်` };
  }
  const day = todayKey();
  db.prepare(`
    INSERT INTO free_usage (email, day, chars_used) VALUES (?, ?, ?)
    ON CONFLICT(email, day) DO UPDATE SET chars_used = chars_used + excluded.chars_used
  `).run(email, day, charCount);
  return { ok: true, remaining: FREE_DAILY_CHARS - (used + charCount) };
}

function normalizeUsername(u) {
  return (u || '').replace(/^@/, '').trim().toLowerCase();
}

function saveTelegramUser(username, chatId) {
  const uname = normalizeUsername(username);
  if (!uname) return;
  db.prepare(`
    INSERT INTO telegram_users (username, chat_id, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(username) DO UPDATE SET chat_id = excluded.chat_id, updated_at = excluded.updated_at
  `).run(uname, chatId, Date.now());
}

function getTelegramChatId(username) {
  const uname = normalizeUsername(username);
  const row = db.prepare('SELECT chat_id FROM telegram_users WHERE username = ?').get(uname);
  return row ? row.chat_id : null;
}

module.exports = {
  PLANS, ADDON_CHARS, FREE_DAILY_CHARS,
  createLicense, getLicense, listLicenses,
  checkAndReserve, extendLicense, setActive,
  attachEmail, getLicensesByEmail,
  getFreeUsageToday, checkAndReserveFree,
  saveTelegramUser, getTelegramChatId,
};
