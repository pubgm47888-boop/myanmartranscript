# AI Movie Recap Studio (Web)

Browser-only version ရဲ့ အသံ/ရုပ်မကိုက်တဲ့ ပြဿနာကို ဖြေရှင်းထားတဲ့ full-stack ဗားရှင်း —
Telegram bot ရဲ့ core sync engine (ffmpeg `setpts` per-segment speed matching + frame-drift
correction) ကို website architecture အဖြစ် ပြောင်းထားပါတယ်။

```
backend/   FastAPI + ffmpeg + Gemini + Groq + edge-tts  →  Railway မှာ deploy
frontend/  Next.js upload UI + step-by-step progress    →  Vercel မှာ deploy
```

## အလုပ်လုပ်ပုံ

1. User က ဗီဒီယို upload တင်၊ Gemini/Groq API key ထည့်၊ voice/subtitle option ရွေး
2. Backend က job တစ်ခု စဖန်တီးပြီး background မှာ အောက်ပါအဆင့်တွေ အလိုက် run:
   `black-bar crop → audio extract → Groq Whisper transcribe → Gemini translate →
   title/hashtag generate → edge-tts narration generate → per-segment sync (setpts) →
   concat → subtitle burn → final render`
3. Frontend က 1.5 စက္ကန့်တိုင်း status polling လုပ်ပြီး step-by-step progress ပြ
4. ပြီးရင် video preview + download button ပြပေး

## 1) GitHub ပေါ်တင်ခြင်း

```bash
cd movie-recap-web
git init
git add .
git commit -m "Initial commit - AI Movie Recap web app"
git branch -M main
git remote add origin https://github.com/<your-username>/<your-repo>.git
git push -u origin main
```

## 2) Backend ကို Railway မှာ Deploy လုပ်ခြင်း

1. https://railway.app → **New Project → Deploy from GitHub repo** → ဒီ repo ကို ရွေး
2. **Root Directory** ကို `backend` လို့ သတ်မှတ်ပါ (Settings → General → Root Directory)
   - Railway က `backend/Dockerfile` ကို အလိုအလျောက် တွေ့ပြီး ffmpeg ပါတဲ့ container ကို build လုပ်ပေးပါလိမ့်မယ်
3. **Variables** tab မှာ (မလိုအပ်ဘူး - user တွေက သူတို့ key ကို frontend ကနေ တိုက်ရိုက်ထည့်မယ်, ဒါပေမဲ့ frontend URL သိရင် ဒါကို ထည့်ပါ):
   - `FRONTEND_ORIGIN` = `https://your-app.vercel.app` (frontend deploy ပြီးမှ ပြန်ထည့်ပါ)
4. Deploy ပြီးရင် Railway က URL တစ်ခု ပေးပါလိမ့်မယ် (ဥပမာ `https://your-app.up.railway.app`) — ဒါကို မှတ်ထားပါ

## 3) Frontend ကို Vercel မှာ Deploy လုပ်ခြင်း

1. https://vercel.com → **Add New → Project** → ဒီ repo ကို ရွေး
2. **Root Directory** ကို `frontend` လို့ သတ်မှတ်ပါ
3. **Environment Variables** မှာ:
   - `NEXT_PUBLIC_API_BASE` = `https://your-app.up.railway.app` (အပေါ်က Railway URL)
4. **Deploy** နှိပ်ပါ

Deploy ပြီးရင် Vercel က `https://your-app.vercel.app` လို URL ပေးပါလိမ့်မယ် — ဒီ URL ကို
ပြန်ပြီး Railway ရဲ့ `FRONTEND_ORIGIN` variable မှာ ထည့်ပေးပါ (CORS အတွက်), ပြီးရင်
Railway ကို redeploy လုပ်ပါ။

## 4) Burmese Font (အရေးကြီး)

`backend/app/fonts/` ဖိုလ်ဒါထဲ Burmese-capable font (.ttf/.otf) ကို ထည့်ပါ (ဥပမာ - Padauk-Bold.ttf,
https://software.sil.org/padauk/ မှ အခမဲ့ ရယူနိုင်ပါတယ်) — မထည့်ရင် subtitle စာလုံးတွေ
မှန်ကန်စွာ မပေါ်နိုင်ပါ။ ထည့်ပြီးရင် GitHub ကို commit/push ပြန်လုပ်ပြီး Railway ကို redeploy လုပ်ပါ။

## Local testing (deploy မလုပ်ခင် စမ်းချင်ရင်)

```bash
# Backend
cd backend
python -m venv venv && source venv/bin/activate
pip install -r requirements.txt
# ffmpeg ကို system မှာ install ထားဖို့ လိုပါတယ် (brew install ffmpeg / apt install ffmpeg)
uvicorn app.main:app --reload --port 8000

# Frontend (အခြား terminal)
cd frontend
npm install
cp .env.example .env.local   # NEXT_PUBLIC_API_BASE=http://localhost:8000
npm run dev
```

## သတိပြုရန်

- User တစ်ဦးစီက သူတို့ ကိုယ်ပိုင် Gemini/Groq API key ကို website ပေါ်မှာ ထည့်ရမှာဖြစ်လို့
  key တွေကို server ဘက်မှာ မသိမ်းထားပါ (job တစ်ခုစီမှာပဲ သုံးပြီး ပယ်ဖျက်ပါတယ်)။
- Railway ရဲ့ free tier မှာ RAM/CPU/disk quota ကန့်သတ်ချက်ရှိပါတယ် — ဗီဒီယို ကြာချိန်ရှည်ရင်
  (၅ မိနစ်ကျော်) processing time ပိုကြာနိုင်ပြီး quota ကျော်နိုင်ပါတယ်, လိုအပ်ရင် Railway
  ရဲ့ paid plan (more RAM/CPU) ကို upgrade လုပ်ဖို့ စဉ်းစားပါ။
- Job data အားလုံးက in-memory dict ထဲမှာပဲ ရှိတာမို့ Railway service ပြန် restart ဖြစ်ရင်
  လုပ်ဆောင်နေတဲ့ job တွေ ပျောက်သွားနိုင်ပါတယ် — production အတွက် Redis/DB ကို job store
  အဖြစ် ပြောင်းသုံးဖို့ အကြံပြုပါတယ်။
