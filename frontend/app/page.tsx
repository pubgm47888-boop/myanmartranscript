"use client";

import { useEffect, useRef, useState } from "react";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "http://localhost:8000";

const STEP_LABELS: Record<string, string> = {
  queued: "Queue ထဲ ထည့်သွင်းပြီးပါပြီ",
  crop: "Black bar စစ်ဆေးခြင်း",
  extract_audio: "အသံ ခွဲထုတ်ခြင်း",
  transcribe: "စကားသံ ဖတ်ခြင်း (Groq)",
  translate: "မြန်မာဘာသာသို့ ပြန်ဆိုခြင်း",
  title: "ခေါင်းစဉ် ထုတ်လုပ်ခြင်း",
  sub_translate: "စာတန်းထိုး ဘာသာပြန်ခြင်း",
  tts: "AI အသံ ထုတ်လုပ်ခြင်း",
  sync: "ဗီဒီယို/အသံ Sync ညှိခြင်း",
  concat: "Segment များ ပေါင်းစည်းခြင်း",
  subtitles: "စာတန်းထိုး ထည့်သွင်းခြင်း",
  render: "နောက်ဆုံးအဆင့် Render",
  done: "ပြီးမြောက်ပါပြီ",
};

const STEP_ORDER = Object.keys(STEP_LABELS);

type JobStatus = {
  id: string;
  status: "queued" | "processing" | "finished" | "error";
  step: string;
  message: string;
  percent: number;
  error: string | null;
  result: { title: string; hook: string; hashtags: string; duration: number } | null;
};

export default function Home() {
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [geminiKey, setGeminiKey] = useState("");
  const [groqKey, setGroqKey] = useState("");
  const [voice, setVoice] = useState("v1");
  const [speed, setSpeed] = useState("1.1x");
  const [platform, setPlatform] = useState("yt");
  const [resolution, setResolution] = useState("720");
  const [subtitlesEnabled, setSubtitlesEnabled] = useState(true);
  const [subLang, setSubLang] = useState("my");
  const [subColor, setSubColor] = useState("yellow");
  const [blurMask, setBlurMask] = useState(false);

  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<JobStatus | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!jobId) return;
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`${API_BASE}/api/jobs/${jobId}`);
        if (!res.ok) return;
        const data: JobStatus = await res.json();
        setJob(data);
        if (data.status === "finished" || data.status === "error") {
          if (pollRef.current) clearInterval(pollRef.current);
        }
      } catch (e) {
        // network hiccup - keep polling
      }
    }, 1500);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [jobId]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    if (!videoFile) {
      setFormError("ဗီဒီယိုဖိုင် ရွေးချယ်ပေးပါ။");
      return;
    }
    if (!geminiKey.trim() || !groqKey.trim()) {
      setFormError("Gemini key နှင့် Groq key နှစ်ခုစလုံး လိုအပ်ပါသည်။");
      return;
    }

    const fd = new FormData();
    fd.append("video", videoFile);
    fd.append("gemini_key", geminiKey.trim());
    fd.append("groq_key", groqKey.trim());
    fd.append("voice", voice);
    fd.append("speed", speed);
    fd.append("platform", platform);
    fd.append("resolution", resolution);
    fd.append("subtitles_enabled", String(subtitlesEnabled));
    fd.append("sub_lang", subLang);
    fd.append("sub_color", subColor);
    fd.append("font_size", "40");
    fd.append("blur_mask", String(blurMask));

    setSubmitting(true);
    try {
      const res = await fetch(`${API_BASE}/api/jobs`, { method: "POST", body: fd });
      if (!res.ok) {
        const t = await res.text();
        throw new Error(t || "Upload failed");
      }
      const data = await res.json();
      setJobId(data.job_id);
      setJob({ id: data.job_id, status: "queued", step: "queued", message: "Queue ထဲ ထည့်သွင်းပြီးပါပြီ", percent: 0, error: null, result: null });
    } catch (err: any) {
      setFormError(err.message || "မတင်နိုင်ပါ။ Backend URL မှန်မမှန် စစ်ဆေးပါ။");
    } finally {
      setSubmitting(false);
    }
  }

  function reset() {
    setJobId(null);
    setJob(null);
    setVideoFile(null);
  }

  const currentStepIndex = job ? STEP_ORDER.indexOf(job.step) : -1;

  return (
    <main className="min-h-screen flex flex-col">
      <header className="border-b border-gray-800 bg-gray-900/80 px-6 py-4 flex items-center gap-3">
        <div className="bg-gradient-to-tr from-amber-500 to-amber-600 p-2.5 rounded-xl">
          <span className="text-black text-xl">🎬</span>
        </div>
        <div>
          <h1 className="text-lg font-bold text-white">AI Movie Recap Studio</h1>
          <p className="text-xs text-gray-400">Frame-accurate audio/video sync • Burmese narration &amp; subtitles</p>
        </div>
      </header>

      <div className="flex-1 max-w-3xl w-full mx-auto p-6 space-y-6">
        {!job && (
          <form onSubmit={handleSubmit} className="bg-gray-900 border border-gray-800 rounded-2xl p-6 space-y-5">
            <div>
              <label className="text-xs font-semibold text-gray-300 block mb-2">ဗီဒီယိုဖိုင်</label>
              <input
                type="file"
                accept="video/*"
                onChange={(e) => setVideoFile(e.target.files?.[0] || null)}
                className="w-full text-sm text-gray-300 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:bg-amber-500 file:text-black file:font-medium"
              />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="text-xs font-semibold text-gray-300 block mb-1">Gemini API Key</label>
                <input
                  type="password"
                  value={geminiKey}
                  onChange={(e) => setGeminiKey(e.target.value)}
                  placeholder="AIzaSy..."
                  className="w-full bg-gray-950 border border-gray-800 rounded-lg p-2 text-sm text-white"
                />
              </div>
              <div>
                <label className="text-xs font-semibold text-gray-300 block mb-1">Groq API Key</label>
                <input
                  type="password"
                  value={groqKey}
                  onChange={(e) => setGroqKey(e.target.value)}
                  placeholder="gsk_..."
                  className="w-full bg-gray-950 border border-gray-800 rounded-lg p-2 text-sm text-white"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div>
                <label className="text-xs font-semibold text-gray-300 block mb-1">အသံ</label>
                <select value={voice} onChange={(e) => setVoice(e.target.value)} className="w-full bg-gray-950 border border-gray-800 rounded-lg p-2 text-sm text-white">
                  <option value="v1">ကိုစိုင်းစိုင်း</option>
                  <option value="v2">မဖွေးဖွေး</option>
                  <option value="v3">Nilar - Fast</option>
                  <option value="v4">Thiha - Suspense</option>
                  <option value="v5">Andrew (EN)</option>
                  <option value="v6">Ava (EN)</option>
                </select>
              </div>
              <div>
                <label className="text-xs font-semibold text-gray-300 block mb-1">Speed</label>
                <select value={speed} onChange={(e) => setSpeed(e.target.value)} className="w-full bg-gray-950 border border-gray-800 rounded-lg p-2 text-sm text-white">
                  <option value="1.0x">1.0x</option>
                  <option value="1.1x">1.1x</option>
                  <option value="1.2x">1.2x</option>
                  <option value="1.3x">1.3x</option>
                </select>
              </div>
              <div>
                <label className="text-xs font-semibold text-gray-300 block mb-1">Format</label>
                <select value={platform} onChange={(e) => setPlatform(e.target.value)} className="w-full bg-gray-950 border border-gray-800 rounded-lg p-2 text-sm text-white">
                  <option value="tt">TikTok/Reels (9:16)</option>
                  <option value="yt">YouTube (16:9)</option>
                  <option value="fb">Facebook (1:1)</option>
                </select>
              </div>
              <div>
                <label className="text-xs font-semibold text-gray-300 block mb-1">Resolution</label>
                <select value={resolution} onChange={(e) => setResolution(e.target.value)} className="w-full bg-gray-950 border border-gray-800 rounded-lg p-2 text-sm text-white">
                  <option value="720">720p</option>
                  <option value="1080">1080p</option>
                </select>
              </div>
            </div>

            <div className="flex flex-wrap gap-6 items-center border-t border-gray-800 pt-4">
              <label className="flex items-center gap-2 text-sm text-gray-300">
                <input type="checkbox" checked={subtitlesEnabled} onChange={(e) => setSubtitlesEnabled(e.target.checked)} />
                စာတန်းထိုး
              </label>
              {subtitlesEnabled && (
                <>
                  <select value={subLang} onChange={(e) => setSubLang(e.target.value)} className="bg-gray-950 border border-gray-800 rounded-lg p-2 text-sm text-white">
                    <option value="my">မြန်မာ</option>
                    <option value="en">English</option>
                    <option value="th">ไทย</option>
                    <option value="zh">中文</option>
                    <option value="id">Bahasa Indonesia</option>
                  </select>
                  <select value={subColor} onChange={(e) => setSubColor(e.target.value)} className="bg-gray-950 border border-gray-800 rounded-lg p-2 text-sm text-white">
                    <option value="yellow">အဝါရောင်</option>
                    <option value="white">အဖြူရောင်</option>
                    <option value="cyan">Cyan</option>
                    <option value="lime">Lime</option>
                    <option value="pink">ပန်းရောင်</option>
                  </select>
                </>
              )}
              <label className="flex items-center gap-2 text-sm text-gray-300">
                <input type="checkbox" checked={blurMask} onChange={(e) => setBlurMask(e.target.checked)} />
                Blur Mask (စာတန်းဟောင်းဖျောက်ရန်)
              </label>
            </div>

            {formError && <p className="text-sm text-red-400">{formError}</p>}

            <button
              type="submit"
              disabled={submitting}
              className="w-full bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-black font-semibold py-3 rounded-xl transition-colors"
            >
              {submitting ? "တင်နေသည်..." : "Recap စတင်ဖန်တီးမည်"}
            </button>
          </form>
        )}

        {job && (
          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6 space-y-5">
            {job.status !== "error" && (
              <>
                <div>
                  <div className="flex justify-between text-xs text-gray-400 mb-1">
                    <span>{job.message}</span>
                    <span>{job.percent}%</span>
                  </div>
                  <div className="w-full h-2 bg-gray-800 rounded-full overflow-hidden">
                    <div className="h-full bg-amber-500 transition-all duration-500" style={{ width: `${job.percent}%` }} />
                  </div>
                </div>

                <ol className="space-y-2">
                  {STEP_ORDER.map((step, i) => {
                    const done = currentStepIndex > i || job.status === "finished";
                    const active = currentStepIndex === i && job.status !== "finished";
                    return (
                      <li key={step} className={`flex items-center gap-3 text-sm ${done ? "text-amber-400" : active ? "text-white" : "text-gray-600"}`}>
                        <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] border ${done ? "bg-amber-500 border-amber-500 text-black" : active ? "border-amber-500 animate-pulse" : "border-gray-700"}`}>
                          {done ? "✓" : i + 1}
                        </span>
                        {STEP_LABELS[step]}
                      </li>
                    );
                  })}
                </ol>
              </>
            )}

            {job.status === "error" && (
              <div className="space-y-3">
                <p className="text-red-400 text-sm">❌ {job.error}</p>
                <button onClick={reset} className="text-amber-400 text-sm underline">
                  ပြန်စမည်
                </button>
              </div>
            )}

            {job.status === "finished" && job.result && (
              <div className="space-y-4 border-t border-gray-800 pt-4">
                <div>
                  <h3 className="text-white font-semibold">{job.result.title}</h3>
                  <p className="text-sm text-gray-400">{job.result.hook}</p>
                  <p className="text-xs text-amber-400 mt-1">{job.result.hashtags}</p>
                </div>
                <video controls className="w-full rounded-xl bg-black" src={`${API_BASE}/api/jobs/${job.id}/download`} />
                <div className="flex gap-3">
                  <a
                    href={`${API_BASE}/api/jobs/${job.id}/download`}
                    download
                    className="flex-1 text-center bg-amber-500 hover:bg-amber-600 text-black font-semibold py-3 rounded-xl"
                  >
                    ဒေါင်းလုဒ်လုပ်မည်
                  </a>
                  <button onClick={reset} className="px-4 py-3 rounded-xl border border-gray-700 text-gray-300 text-sm">
                    နောက်တစ်ခု ပြုလုပ်မည်
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </main>
  );
}
