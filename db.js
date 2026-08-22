const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');

// ⚠️ Render Free tier မှာ disk က deploy တိုင်း reset ဖြစ်တတ်ပါတယ်
// Production အတွက် Render "Persistent Disk" ($1/mo~) ထည့်ဖို့ လိုအပ်ပါတယ်
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
  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT,
    telegram_username TEXT,
    plan_code TEXT NOT NULL,
    amount INTEGER NOT NULL,
    screenshot_b64 TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    code TEXT,
    created_at INTEGER NOT NULL,
    decided_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS telegram_links (
    username TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    linked_at INTEGER NOT NULL
  );
`);

const FREE_DAILY_CHARS = 500;

const PLANS = {
  '7A':  { days: 7,  chars: 100000,  maxExtra: 0,      amount: 10000 },
  '7B':  { days: 7,  chars: 250000,  maxExtra: 0,      amount: 20000 },
  '30A': { days: 30, chars: 300000,  maxExtra: 200000, amount: 30000 },
  '30B': { days: 30, chars: 1000000, maxExtra: 500000, amount: 50000 },
  '30C': { days: 30, chars: 2000000, maxExtra: 500000, amount: 80000 },
};
const ADDON_CHARS = 100000;
const ADDON_AMOUNT = 5000;

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
  return new Date().toISOString().slice(0, 10);
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

function createPayment({ email, telegram_username, plan_code, amount, screenshot_b64 }) {
  const now = Date.now();
  const info = db.prepare(`
    INSERT INTO payments (email, telegram_username, plan_code, amount, screenshot_b64, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?)
  `).run(email || null, telegram_username || null, plan_code, amount, screenshot_b64 || null, now);
  return getPayment(info.lastInsertRowid);
}

function getPayment(id) {
  return db.prepare('SELECT * FROM payments WHERE id = ?').get(id);
}

function listPayments(status) {
  if (status) return db.prepare('SELECT * FROM payments WHERE status = ? ORDER BY created_at DESC').all(status);
  return db.prepare('SELECT * FROM payments ORDER BY created_at DESC').all();
}

function decidePayment(id, status, code) {
  db.prepare('UPDATE payments SET status = ?, code = ?, decided_at = ? WHERE id = ?')
    .run(status, code || null, Date.now(), id);
  return getPayment(id);
}

function linkTelegram(username, chatId) {
  db.prepare(`
    INSERT INTO telegram_links (username, chat_id, linked_at) VALUES (?, ?, ?)
    ON CONFLICT(username) DO UPDATE SET chat_id = excluded.chat_id, linked_at = excluded.linked_at
  `).run(username.toLowerCase(), String(chatId), Date.now());
}

function getTelegramChatId(username) {
  if (!username) return null;
  const row = db.prepare('SELECT chat_id FROM telegram_links WHERE username = ?').get(username.toLowerCase());
  return row ? row.chat_id : null;
}

module.exports = {
  PLANS, ADDON_CHARS, ADDON_AMOUNT, FREE_DAILY_CHARS,
  createLicense, getLicense, listLicenses,
  checkAndReserve, extendLicense, setActive,
  attachEmail, getLicensesByEmail,
  getFreeUsageToday, checkAndReserveFree,
  createPayment, getPayment, listPayments, decidePayment,
  linkTelegram, getTelegramChatId,
};
