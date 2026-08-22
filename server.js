const express = require('express');
const path = require('path');
const db = require('./db');

const app = express();
app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const RUNPOD_API_KEY = process.env.RUNPOD_API_KEY;
const RUNPOD_ENDPOINT_ID = process.env.RUNPOD_ENDPOINT_ID;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD; // Render Environment Variables ထဲ ထည့်ပါ
const SUPABASE_URL = process.env.SUPABASE_URL; // ဥပမာ https://xxxx.supabase.co
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY; // Supabase → Settings → API → service_role (SECRET — anon key မဟုတ်ပါ)
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN; // BotFather ကနေ ရထားတဲ့ token

if (!RUNPOD_API_KEY || !RUNPOD_ENDPOINT_ID) {
  console.error('⚠️  RUNPOD_API_KEY / RUNPOD_ENDPOINT_ID environment variable များ ထည့်ပါ');
}
if (!ADMIN_PASSWORD) {
  console.error('⚠️  ADMIN_PASSWORD environment variable ထည့်ပါ — မထည့်ရင် admin panel ကို ဘယ်သူမှ မဝင်နိုင်ပါဘူး');
}

let TELEGRAM_BOT_USERNAME = null;

// ---------- Telegram bot (username → chat_id capture, ပြီးရင် audio ပို့ဖို့) ----------
if (TELEGRAM_BOT_TOKEN) {
  const TelegramBot = require('node-telegram-bot-api');
  const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

  bot.getMe().then(me => { TELEGRAM_BOT_USERNAME = me.username; console.log('Telegram bot username:', me.username); });

  bot.on('message', (msg) => {
    if (msg.from && msg.from.username) {
      db.saveTelegramUser(msg.from.username, msg.chat.id);
    }
    if (msg.text === '/start') {
      bot.sendMessage(msg.chat.id,
        '🎭 JOKER Voice Clone Bot ချိတ်ဆက်ပြီးပါပြီ!\n\n' +
        'Website ပေါ်မှာ Voice clone generate လုပ်ပြီးရင် ဒီ Telegram ကို audio file အလိုအလျောက် ပို့ပေးပါလိမ့်မယ်။\n' +
        'Website ထဲမှာ Telegram username ထည့်တဲ့နေရာမှာ @' + (msg.from.username || '(username မရှိသေးပါ — Telegram Settings ထဲ username အရင်ဖန်တီးပါ)') + ' လို့ ထည့်ပါ။'
      );
    }
  });
  bot.on('polling_error', (err) => console.error('Telegram polling error:', err.message));
  console.log('Telegram bot polling started.');
} else {
  console.error('⚠️  TELEGRAM_BOT_TOKEN မထည့်ရသေးပါ — Telegram auto-delivery အလုပ်မလုပ်ပါ');
}

// ---------- Admin auth middleware (simple password header check) ----------
function requireAdmin(req, res, next) {
  const provided = req.headers['x-admin-password'];
  if (!ADMIN_PASSWORD || provided !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Admin password မှားနေပါတယ်' });
  }
  next();
}

// ---------- Public: customer voice-clone generate (license OR free-trial gated) ----------
app.post('/api/generate', async (req, res) => {
  try {
    const { text, reference_audio_b64, reference_text, code, email } = req.body;
    if (!text || !text.trim()) return res.status(400).json({ error: 'စာသား ထည့်ပါ' });

    let reserve;
    if (code) {
      reserve = db.checkAndReserve(code, text.length);
      if (!reserve.ok) return res.status(403).json({ error: reserve.error });
      if (email) db.attachEmail(code, email); // ပထမဆုံးအကြိမ် သုံးတုန်းက account ကို code နဲ့ ချိတ်ပေးမယ်
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

// Customer/website ဘက်က code ရဲ့ balance/status ကို check ဖို့
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

// ---------- Admin: license management (password-protected) ----------
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

// Google login ဝင်ထားတဲ့ user အားလုံးကို Supabase ကနေ ဆွဲထုတ်ပြီး
// Free/VIP status + usage detail တွဲပြပေးမယ့် endpoint
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

// Frontend က t.me link တည်ဆောက်ဖို့ Bot username ကို ခေါ်ယူနိုင်အောင်
app.get('/api/telegram-bot-info', (req, res) => {
  res.json({ username: TELEGRAM_BOT_USERNAME });
});

// Website ကနေ generate ပြီးသား audio ကို user ရဲ့ Telegram ဆီ ပို့ဖို့
app.post('/api/telegram/send', async (req, res) => {
  try {
    if (!TELEGRAM_BOT_TOKEN) return res.status(500).json({ error: 'Telegram bot ချိတ်ဆက်မထားပါ' });
    const { username, audio_b64 } = req.body;
    if (!username || !audio_b64) return res.status(400).json({ error: 'username / audio ပေးပါ' });

    const chatId = db.getTelegramChatId(username);
    if (!chatId) {
      return res.status(404).json({
        error: `@${username} ကို Telegram ဆီ ပို့လို့မရသေးပါ — Bot ကို /start အရင် နှိပ်ပေးပါ`,
        botUsername: TELEGRAM_BOT_USERNAME,
      });
    }

    const audioBuffer = Buffer.from(audio_b64, 'base64');
    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append('audio', new Blob([audioBuffer], { type: 'audio/mpeg' }), 'cloned-voice.mp3');
    form.append('caption', '🎭 JOKER Voice Clone — ပြီးစီးပါပြီ!');

    const tgRes = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendAudio`, {
      method: 'POST',
      body: form,
    });
    const tgData = await tgRes.json();
    if (!tgData.ok) return res.status(400).json({ error: tgData.description || 'Telegram ပို့လို့မရပါ' });

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
