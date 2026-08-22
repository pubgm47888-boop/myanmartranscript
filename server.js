const express = require('express');
const path = require('path');
const db = require('./db');

const app = express();
app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const RUNPOD_API_KEY = process.env.RUNPOD_API_KEY;
const RUNPOD_ENDPOINT_ID = process.env.RUNPOD_ENDPOINT_ID;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
// Admin ၂ ယောက်ရဲ့ Telegram username (без @), comma ခြား — ဥပမာ "kopyae131019,SZMOFF848"
const ADMIN_TELEGRAM_USERNAMES = (process.env.ADMIN_TELEGRAM_USERNAMES || '')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

if (!RUNPOD_API_KEY || !RUNPOD_ENDPOINT_ID) {
  console.error('⚠️  RUNPOD_API_KEY / RUNPOD_ENDPOINT_ID environment variable များ ထည့်ပါ');
}
if (!ADMIN_PASSWORD) {
  console.error('⚠️  ADMIN_PASSWORD environment variable ထည့်ပါ');
}
if (!TELEGRAM_BOT_TOKEN) {
  console.error('⚠️  TELEGRAM_BOT_TOKEN environment variable ထည့်ပါ — Telegram features အလုပ်မလုပ်ပါ');
}

function requireAdmin(req, res, next) {
  const provided = req.headers['x-admin-password'];
  if (!ADMIN_PASSWORD || provided !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Admin password မှားနေပါတယ်' });
  }
  next();
}

// =====================================================================
// Telegram helpers
// =====================================================================
const TG_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

async function tgCall(method, body) {
  const res = await fetch(`${TG_API}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return res.json();
}

async function tgSendPhotoBase64(chatId, base64, caption, replyMarkup) {
  const buffer = Buffer.from(base64, 'base64');
  const form = new FormData();
  form.append('chat_id', chatId);
  if (caption) form.append('caption', caption);
  form.append('parse_mode', 'HTML');
  if (replyMarkup) form.append('reply_markup', JSON.stringify(replyMarkup));
  form.append('photo', new Blob([buffer]), 'screenshot.jpg');
  const res = await fetch(`${TG_API}/sendPhoto`, { method: 'POST', body: form });
  return res.json();
}

async function tgSendMessage(chatId, text, replyMarkup) {
  return tgCall('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', reply_markup: replyMarkup });
}

async function tgEditCaption(chatId, messageId, caption) {
  return tgCall('editMessageCaption', { chat_id: chatId, message_id: messageId, caption, parse_mode: 'HTML' });
}

async function tgAnswerCallback(callbackQueryId, text) {
  return tgCall('answerCallbackQuery', { callback_query_id: callbackQueryId, text });
}

async function tgSendAudioBase64(chatId, base64, filename, caption) {
  const buffer = Buffer.from(base64, 'base64');
  const form = new FormData();
  form.append('chat_id', chatId);
  if (caption) form.append('caption', caption);
  form.append('audio', new Blob([buffer], { type: 'audio/mpeg' }), filename || 'voice.mp3');
  const res = await fetch(`${TG_API}/sendAudio`, { method: 'POST', body: form });
  return res.json();
}

function getAdminChatIds() {
  return ADMIN_TELEGRAM_USERNAMES.map(u => db.getTelegramChatId(u)).filter(Boolean);
}

async function notifyAdminsOfPayment(payment) {
  const plan = payment.plan_code === 'ADDON'
    ? { label: `Add-on ${db.ADDON_CHARS.toLocaleString()} စာလုံး` }
    : { label: payment.plan_code };
  const caption =
    `🆕 <b>Payment တောင်းဆိုမှု #${payment.id}</b>\n` +
    `👤 Email: ${payment.email || '-'}\n` +
    `📨 Telegram: ${payment.telegram_username ? '@' + payment.telegram_username : '-'}\n` +
    `📦 Plan: ${plan.label}\n` +
    `💰 ငွေပမာဏ: ${payment.amount.toLocaleString()} ကျပ်`;
  const replyMarkup = {
    inline_keyboard: [[
      { text: '✅ Approve', callback_data: `approve:${payment.id}` },
      { text: '❌ Reject', callback_data: `reject:${payment.id}` },
    ]],
  };
  const adminChatIds = getAdminChatIds();
  if (!adminChatIds.length) {
    console.error('⚠️  Admin telegram chat_id မတွေ့သေးပါ — admin ၂ ယောက်စလုံး bot ကို /start အရင်နှိပ်ပေးဖို့ လိုပါတယ်');
    return;
  }
  for (const chatId of adminChatIds) {
    if (payment.screenshot_b64) {
      await tgSendPhotoBase64(chatId, payment.screenshot_b64, caption, replyMarkup);
    } else {
      await tgSendMessage(chatId, caption, replyMarkup);
    }
  }
}

// =====================================================================
// Shared approve/reject logic (used by Telegram callback AND web admin)
// =====================================================================
async function approvePaymentCore(paymentId, decidedBy) {
  const payment = db.getPayment(paymentId);
  if (!payment) throw new Error('Payment မတွေ့ပါ');
  if (payment.status !== 'pending') throw new Error(`ဒီ payment ကို ပြီးခဲ့ပါပြီ (${payment.status})`);

  let license;
  if (payment.plan_code === 'ADDON') {
    if (!payment.email) throw new Error('Add-on approve ဖို့ email မရှိပါ');
    const existing = db.getLicensesByEmail(payment.email).find(l => l.active && Date.now() < l.expires_at);
    if (!existing) throw new Error('Active plan မရှိသေးတဲ့ user ဖြစ်လို့ Add-on approve မရပါ');
    license = db.extendLicense(existing.code, db.ADDON_CHARS, 0);
  } else {
    license = db.createLicense(payment.plan_code, `Payment #${payment.id}${payment.telegram_username ? ' / @' + payment.telegram_username : ''}`);
    if (payment.email) db.attachEmail(license.code, payment.email);
  }

  db.decidePayment(paymentId, 'approved', license.code);

  // User ရဲ့ Telegram ကို link ထားပြီးသားဆိုရင် code ကို auto ပို့
  const userChatId = db.getTelegramChatId(payment.telegram_username);
  if (userChatId) {
    const msg = payment.plan_code === 'ADDON'
      ? `✅ Add-on approve ဖြစ်ပါပြီ — စာလုံးရေ ${db.ADDON_CHARS.toLocaleString()} ထပ်တိုးပြီးပါပြီ။`
      : `✅ Payment approve ဖြစ်ပါပြီ 🎉\n\nသင့် Access Code: <code>${license.code}</code>\nPlan: ${payment.plan_code}\n\nApp ထဲက Access Code နေရာမှာ ဒီ code ကို ထည့်ပါ။`;
    await tgSendMessage(userChatId, msg);
  }

  return license;
}

async function rejectPaymentCore(paymentId) {
  const payment = db.getPayment(paymentId);
  if (!payment) throw new Error('Payment မတွေ့ပါ');
  if (payment.status !== 'pending') throw new Error(`ဒီ payment ကို ပြီးခဲ့ပါပြီ (${payment.status})`);
  db.decidePayment(paymentId, 'rejected', null);

  const userChatId = db.getTelegramChatId(payment.telegram_username);
  if (userChatId) {
    await tgSendMessage(userChatId, `❌ Payment #${payment.id} ကို confirm မလုပ်ပေးနိုင်ပါ — screenshot ပြန်စစ်ပြီး admin ကို ဆက်သွယ်ပါ။`);
  }
  return payment;
}

// =====================================================================
// Public: customer voice-clone generate (license OR free-trial gated)
// =====================================================================
app.post('/api/generate', async (req, res) => {
  try {
    const { text, reference_audio_b64, reference_text, code, email } = req.body;
    if (!text || !text.trim()) return res.status(400).json({ error: 'စာသား ထည့်ပါ' });

    let reserve;
    if (code) {
      reserve = db.checkAndReserve(code, text.length);
      if (!reserve.ok) return res.status(403).json({ error: reserve.error });
      if (email) db.attachEmail(code, email);
    } else {
      if (!email) return res.status(400).json({ error: 'Login ဝင်ပြီးမှ (Free trial) သုံးလို့ရပါတယ်' });
      reserve = db.checkAndReserveFree(email, text.length);
      if (!reserve.ok) return res.status(403).json({ error: reserve.error });
    }

    const runRes = await fetch(`https://api.runpod.ai/v2/${RUNPOD_ENDPOINT_ID}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${RUNPOD_API_KEY}` },
      body: JSON.stringify({ input: { text, reference_audio_b64, reference_text } }),
    });
    const data = await runRes.json();
    if (!runRes.ok) return res.status(runRes.status).json({ error: data.error || 'RunPod request fail' });

    res.json({ ...data, remaining_chars: reserve.remaining });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

app.get('/api/status/:jobId', async (req, res) => {
  try {
    const statusRes = await fetch(
      `https://api.runpod.ai/v2/${RUNPOD_ENDPOINT_ID}/status/${req.params.jobId}`,
      { headers: { 'Authorization': `Bearer ${RUNPOD_API_KEY}` } }
    );
    const data = await statusRes.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

app.get('/api/license/:code', (req, res) => {
  const lic = db.getLicense(req.params.code);
  if (!lic) return res.status(404).json({ error: 'Code မတွေ့ပါ' });
  res.json({
    plan: lic.plan,
    remaining: lic.char_limit - lic.chars_used,
    char_limit: lic.char_limit,
    expires_at: lic.expires_at,
    active: !!lic.active,
  });
});

app.get('/api/plans', (req, res) => {
  res.json({ plans: db.PLANS, addonChars: db.ADDON_CHARS, addonAmount: db.ADDON_AMOUNT, freeDailyChars: db.FREE_DAILY_CHARS });
});

// =====================================================================
// Payment submission (plan ရွေး → QR ကြည့် → screenshot တင်)
// =====================================================================
app.post('/api/payment/submit', async (req, res) => {
  try {
    const { email, telegram_username, plan_code, screenshot_base64 } = req.body;
    if (!plan_code || !screenshot_base64) return res.status(400).json({ error: 'Plan/screenshot ထည့်ပါ' });
    if (!telegram_username) return res.status(400).json({ error: 'Telegram username ထည့်ပါ' });

    const amount = plan_code === 'ADDON' ? db.ADDON_AMOUNT : (db.PLANS[plan_code] || {}).amount;
    if (!amount) return res.status(400).json({ error: 'Plan code မမှန်ပါ' });

    const payment = db.createPayment({ email, telegram_username, plan_code, amount, screenshot_b64: screenshot_base64 });
    await notifyAdminsOfPayment(payment);

    res.json({ ok: true, message: 'ပို့ပြီးပါပြီ — admin confirm လုပ်ပေးတာကို Telegram ထဲမှာ ခဏစောင့်ပါ' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Payment ပို့ခြင်း မအောင်မြင်ပါ' });
  }
});

// =====================================================================
// Telegram webhook — /start (username↔chat_id link) + Approve/Reject buttons
// =====================================================================
app.post('/telegram/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const msg = req.body.message;
    if (msg && msg.text && msg.text.startsWith('/start')) {
      if (msg.from.username) {
        db.linkTelegram(msg.from.username, msg.chat.id);
        await tgSendMessage(msg.chat.id, '✅ ချိတ်ဆက်ပြီးပါပြီ — App ထဲမှာ payment ပို့တာ/audio ရလဒ် ဒီ chat ထဲကို ရောက်လာပါလိမ့်မယ်။');
      } else {
        await tgSendMessage(msg.chat.id, '⚠️ Telegram username သတ်မှတ်ထားပါ (Settings → Username) — ဒါမှ app နဲ့ ချိတ်ဆက်နိုင်ပါမယ်။');
      }
      return;
    }

    const cb = req.body.callback_query;
    if (cb) {
      const chatId = String(cb.message.chat.id);
      if (!getAdminChatIds().includes(chatId)) {
        return tgAnswerCallback(cb.id, 'Admin permission မရှိပါ');
      }
      const [action, paymentIdStr] = cb.data.split(':');
      const paymentId = Number(paymentIdStr);
      try {
        if (action === 'approve') {
          const license = await approvePaymentCore(paymentId, `telegram:${chatId}`);
          await tgEditCaption(chatId, cb.message.message_id, (cb.message.caption || '') + `\n\n✅ <b>APPROVED</b> — Code: <code>${license.code}</code>`);
        } else if (action === 'reject') {
          await rejectPaymentCore(paymentId);
          await tgEditCaption(chatId, cb.message.message_id, (cb.message.caption || '') + '\n\n❌ <b>REJECTED</b>');
        }
        await tgAnswerCallback(cb.id, 'ပြီးပါပြီ');
      } catch (err) {
        await tgAnswerCallback(cb.id, err.message);
      }
    }
  } catch (err) {
    console.error('Telegram webhook error:', err);
  }
});

// =====================================================================
// Voice-clone ရလဒ် အသံဖိုင်ကို user ရဲ့ Telegram ထဲ auto ပို့ရန်
// (Client က generation COMPLETED ဖြစ်တာနဲ့ ဒီ endpoint ကို ခေါ်မယ်)
// =====================================================================
app.post('/api/telegram/deliver', async (req, res) => {
  try {
    const { telegram_username, audio_b64 } = req.body;
    if (!telegram_username || !audio_b64) return res.status(400).json({ error: 'Data မပြည့်စုံပါ' });

    const chatId = db.getTelegramChatId(telegram_username);
    if (!chatId) {
      return res.status(404).json({
        error: 'Telegram ချိတ်ဆက်မထားသေးပါ',
        needsLink: true,
      });
    }
    await tgSendAudioBase64(chatId, audio_b64, 'cloned-voice.mp3', '🎙 သင့် voice clone ရလဒ်');
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Telegram ပို့ခြင်း မအောင်မြင်ပါ' });
  }
});

// =====================================================================
// Admin: license management
// =====================================================================
app.post('/api/admin/login', (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) return res.json({ ok: true });
  res.status(401).json({ ok: false });
});

app.get('/api/admin/licenses', requireAdmin, (req, res) => {
  res.json(db.listLicenses());
});

app.post('/api/admin/licenses', requireAdmin, (req, res) => {
  try {
    const { plan, note } = req.body;
    const lic = db.createLicense(plan, note || '');
    res.json(lic);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/admin/licenses/:code/extend', requireAdmin, (req, res) => {
  try {
    const { extraChars, extraDays } = req.body;
    const lic = db.extendLicense(req.params.code, extraChars || 0, extraDays || 0);
    res.json(lic);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/admin/licenses/:code/toggle', requireAdmin, (req, res) => {
  const lic = db.getLicense(req.params.code);
  if (!lic) return res.status(404).json({ error: 'Code မတွေ့ပါ' });
  const updated = db.setActive(req.params.code, !lic.active);
  res.json(updated);
});

app.get('/api/admin/plans', requireAdmin, (req, res) => {
  res.json({ plans: db.PLANS, addonChars: db.ADDON_CHARS, freeDailyChars: db.FREE_DAILY_CHARS });
});

// Admin: pending payments (web panel — Telegram approve ရှိပြီးသားနဲ့ parallel)
app.get('/api/admin/payments', requireAdmin, (req, res) => {
  res.json(db.listPayments(req.query.status || 'pending'));
});

app.post('/api/admin/payments/:id/approve', requireAdmin, async (req, res) => {
  try {
    const license = await approvePaymentCore(Number(req.params.id));
    res.json({ ok: true, code: license.code });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/admin/payments/:id/reject', requireAdmin, async (req, res) => {
  try {
    await rejectPaymentCore(Number(req.params.id));
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Google login ဝင်ထားတဲ့ user အားလုံးကို Supabase ကနေ ဆွဲထုတ်
app.get('/api/admin/users', requireAdmin, async (req, res) => {
  try {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(500).json({ error: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY env var မထည့်ရသေးပါ' });
    }
    const supRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?per_page=1000`, {
      headers: {
        'apikey': SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      },
    });
    const supData = await supRes.json();
    if (!supRes.ok) return res.status(supRes.status).json({ error: supData.msg || 'Supabase user fetch fail' });

    const users = (supData.users || []).map(u => {
      const licenses = db.getLicensesByEmail(u.email);
      const activeLicense = licenses.find(l => l.active && Date.now() < l.expires_at);
      const freeUsedToday = db.getFreeUsageToday(u.email);
      return {
        email: u.email,
        created_at: u.created_at,
        last_sign_in_at: u.last_sign_in_at,
        avatar_url: (u.user_metadata && u.user_metadata.avatar_url) || null,
        status: activeLicense ? 'VIP' : 'Free',
        plan: activeLicense ? activeLicense.plan : null,
        code: activeLicense ? activeLicense.code : null,
        remaining: activeLicense ? (activeLicense.char_limit - activeLicense.chars_used) : (db.FREE_DAILY_CHARS - freeUsedToday),
        expires_at: activeLicense ? activeLicense.expires_at : null,
        free_used_today: freeUsedToday,
        all_licenses: licenses.map(l => ({ code: l.code, plan: l.plan, active: !!l.active, remaining: l.char_limit - l.chars_used, expires_at: l.expires_at })),
      };
    });

    res.json(users);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
