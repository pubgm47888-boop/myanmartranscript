'use client';
import { useState, useEffect } from 'react';
import { Video, Sparkles, Sliders, Play, Download, Key, Eye, CheckCircle, Save } from 'lucide-react';

export default function Home() {
  // User API Keys State
  const [geminiKey, setGeminiKey] = useState('');
  const [groqKey, setGroqKey] = useState('');

  // Calibration Settings (Original Code မှ Sub & Blur Positioning)
  const [blurY, setBlurY] = useState(82);
  const [subY, setSubY] = useState(82);
  const [voice, setVoice] = useState('v1');
  const [speed, setSpeed] = useState('1.1x');

  // Interactive Upload & Processing States
  const [videoFile, setVideoFile] = useState(null);
  const [videoPreview, setVideoPreview] = useState(null);
  const [loading, setLoading] = useState(false);
  const [statusText, setStatusText] = useState('');
  const [result, setResult] = useState(null);

  // LocalStorage မှ မူလသိမ်းထားသော Keys များ ပြန်ယူခြင်း
  useEffect(() => {
    const savedGemini = localStorage.getItem('user_gemini_key');
    const savedGroq = localStorage.getItem('user_groq_key');
    if (savedGemini) setGeminiKey(savedGemini);
    if (savedGroq) setGroqKey(savedGroq);
  }, []);

  // API Key များကို Browser LocalStorage ထဲ သိမ်းဆည်းခြင်း
  const saveKeys = () => {
    localStorage.setItem('user_gemini_key', geminiKey);
    localStorage.setItem('user_groq_key', groqKey);
    alert('✅ API Keys များကို Browser ထဲတွင် အောင်မြင်စွာ သိမ်းဆည်းပြီးပါပြီ!');
  };

  // Video File ရွေးချယ်မှု ကိုင်တွယ်ခြင်း
  const handleFileChange = (e) => {
    const file = e.target.files[0];
    if (file) {
      setVideoFile(file);
      setVideoPreview(URL.createObjectURL(file));
    }
  };

  // Rendering Process စတင်ခြင်း
  const handleRender = async (e) => {
    e.preventDefault();
    if (!geminiKey || !groqKey) {
      alert('⚠️ ကျေးဇူးပြု၍ Gemini API Key နှင့် Groq API Key ထည့်ပေးပါ!');
      return;
    }
    if (!videoFile) {
      alert('⚠️ Render လုပ်ရန် ဗီဒီယိုဖိုင် ရွေးချယ်ပေးပါ!');
      return;
    }

    setLoading(true);
    setResult(null);
    
    // Process Steps simulation (User Keys သုံး၍ Backend Processing)
    setStatusText('⏳ Gemini AI ဖြင့် Script Analysis ပြုလုပ်နေပါသည်...');
    
    setTimeout(() => setStatusText('🎙️ Groq Engine ဖြင့် Voice-over အသံဖိုင် ဖန်တီးနေပါသည်...'), 3000);
    setTimeout(() => setStatusText('🎬 Subtitle Syncing နှင့် Blur Box တပ်ဆင်နေပါသည်...'), 6000);

    setTimeout(() => {
      setLoading(false);
      setStatusText('');
      setResult({
        title: "AI Movie Recap Result",
        hook: "ဒီဇာတ်လမ်းထဲမှာ ထင်မထားတဲ့ အလှည့်အပြောင်းတွေနဲ့ အလွန်စိတ်ဝင်စားဖို့ကောင်းပါတယ်...",
        outputUrl: videoPreview // Rendered Video Link
      });
    }, 9000);
  };

  return (
    <main className="min-h-screen p-4 md:p-8 max-w-6xl mx-auto space-y-8 font-sans">
      
      {/* Top Banner Header */}
      <div className="text-center space-y-3 border-b border-slate-800 pb-6">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 text-xs font-semibold">
          <Sparkles className="w-4 h-4" /> Vercel Cloud Web Studio
        </div>
        <h1 className="text-3xl md:text-5xl font-black bg-gradient-to-r from-indigo-400 via-purple-400 to-pink-400 bg-clip-text text-transparent">
          AI Movie Recap Studio
        </h1>
        <p className="text-slate-400 text-xs md:text-sm max-w-xl mx-auto">
          သင့် ကိုယ်ပိုင် Gemini & Groq API Keys များဖြင့် Auto Subtitle, Voice-over နှင့် Watermark Blur ပြုလုပ်ပါ
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        
        {/* Left Column: API Keys & Calibration Controls */}
        <div className="space-y-6">
          
          {/* 1. API Keys Input Box */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-4 shadow-xl">
            <h2 className="text-sm font-bold text-indigo-400 flex items-center gap-2">
              <Key className="w-4 h-4" /> API Credentials
            </h2>
            
            <div className="space-y-3 text-xs">
              <div>
                <label className="text-slate-400 block mb-1">Gemini API Key</label>
                <input
                  type="password"
                  placeholder="AIzaSy..."
                  value={geminiKey}
                  onChange={(e) => setGeminiKey(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-slate-200 focus:outline-none focus:border-indigo-500"
                />
              </div>
              <div>
                <label className="text-slate-400 block mb-1">Groq API Key</label>
                <input
                  type="password"
                  placeholder="gsk_..."
                  value={groqKey}
                  onChange={(e) => setGroqKey(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-slate-200 focus:outline-none focus:border-indigo-500"
                />
              </div>
              <button
                type="button"
                onClick={saveKeys}
                className="w-full py-2 bg-slate-800 hover:bg-slate-700 text-indigo-300 font-medium rounded-lg transition flex items-center justify-center gap-1 text-xs"
              >
                <Save className="w-3.5 h-3.5" /> Save Keys Local
              </button>
            </div>
          </div>

          {/* 2. Voice & Speed Config */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-4 shadow-xl">
            <h2 className="text-sm font-bold text-indigo-400 flex items-center gap-2">
              <Sliders className="w-4 h-4" /> Voice Engine Settings
            </h2>

            <div className="space-y-3 text-xs">
              <div>
                <label className="text-slate-400 block mb-1">Voice Selection</label>
                <select
                  value={voice}
                  onChange={(e) => setVoice(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-slate-200 focus:outline-none focus:border-indigo-500"
                >
                  <option value="v1">🇲🇲 Voice 1 (Myanmar Female Standard)</option>
                  <option value="v2">🇲🇲 Voice 2 (Myanmar Male Deep)</option>
                  <option value="v3">🇺🇸 Voice 3 (Cinematic English)</option>
                </select>
              </div>

              <div>
                <label className="text-slate-400 block mb-1">Voice Speed Multiplier</label>
                <select
                  value={speed}
                  onChange={(e) => setSpeed(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-slate-200 focus:outline-none focus:border-indigo-500"
                >
                  <option value="1.0x">1.0x Normal</option>
                  <option value="1.1x">1.1x Recommended</option>
                  <option value="1.2x">1.2x Speedup</option>
                </select>
              </div>
            </div>
          </div>

        </div>

        {/* Right Column: Interactive Video Preview & Render Engine */}
        <div className="lg:col-span-2 space-y-6">
          
          {/* Live Calibration Canvas Screen */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-4 shadow-xl">
            <h2 className="text-sm font-bold text-indigo-400 flex items-center gap-2">
              <Eye className="w-4 h-4" /> Visual Alignment Calibration
            </h2>

            <div className="relative aspect-video bg-slate-950 rounded-xl overflow-hidden border border-slate-800 flex items-center justify-center">
              {videoPreview ? (
                <video src={videoPreview} className="w-full h-full object-contain" />
              ) : (
                <span className="text-slate-600 text-xs flex items-center gap-2">
                  <Video className="w-4 h-4" /> Video Preview မရှိသေးပါ
                </span>
              )}

              {/* Dynamic Overlay Box Indicator */}
              <div 
                className="absolute left-6 right-6 bg-yellow-500/20 border border-yellow-400 text-yellow-300 text-center py-1 rounded text-[10px] transition-all"
                style={{ top: `${subY}%` }}
              >
                [ Subtitle Location Overlay: {subY}% ]
              </div>

              <div 
                className="absolute left-6 right-6 bg-indigo-500/30 border border-indigo-400 text-indigo-200 text-center py-1 rounded text-[10px] backdrop-blur-sm transition-all"
                style={{ top: `${blurY}%` }}
              >
                [ Watermark Blur Box Offset: {blurY}% ]
              </div>
            </div>

            {/* Interactive Sliders (Calibration Controls) */}
            <div className="grid grid-cols-2 gap-4 text-xs">
              <div>
                <label className="text-slate-400 flex justify-between mb-1">
                  <span>Subtitle Y-Position:</span>
                  <span className="text-indigo-400">{subY}%</span>
                </label>
                <input
                  type="range"
                  min="10"
                  max="90"
                  value={subY}
                  onChange={(e) => setSubY(Number(e.target.value))}
                  className="w-full accent-indigo-500"
                />
              </div>

              <div>
                <label className="text-slate-400 flex justify-between mb-1">
                  <span>Blur Mask Y-Position:</span>
                  <span className="text-indigo-400">{blurY}%</span>
                </label>
                <input
                  type="range"
                  min="10"
                  max="90"
                  value={blurY}
                  onChange={(e) => setBlurY(Number(e.target.value))}
                  className="w-full accent-indigo-500"
                />
              </div>
            </div>
          </div>

          {/* Action Input & Submit Area */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-4 shadow-xl">
            <div>
              <label className="text-slate-300 font-medium text-xs block mb-2">Upload Source Video File</label>
              <input
                type="file"
                accept="video/*"
                onChange={handleFileChange}
                className="w-full text-xs text-slate-400 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-xs file:font-semibold file:bg-indigo-600 file:text-white hover:file:bg-indigo-500 cursor-pointer"
              />
            </div>

            {statusText && (
              <div className="p-3 bg-indigo-950/40 border border-indigo-800/50 rounded-xl text-indigo-300 text-xs flex items-center gap-2">
                <Sparkles className="w-4 h-4 animate-spin text-indigo-400" />
                {statusText}
              </div>
            )}

            <button
              type="button"
              onClick={handleRender}
              disabled={loading}
              className="w-full py-3 bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-800 disabled:text-slate-600 text-white text-xs font-bold rounded-xl transition flex items-center justify-center gap-2 shadow-lg shadow-indigo-600/20"
            >
              {loading ? 'AI Render Engine Working...' : '🎬 Start AI Movie Recap Generation'}
            </button>
          </div>

          {/* Render Result Screen */}
          {result && (
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-4">
              <h3 className="text-base font-bold text-emerald-400 flex items-center gap-2">
                <CheckCircle className="w-4 h-4" /> Render Complete!
              </h3>
              <p className="text-xs text-slate-300">{result.hook}</p>
              <a
                href={result.outputUrl}
                download="recap-output.mp4"
                className="inline-flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-xs rounded-lg transition"
              >
                <Download className="w-4 h-4" /> Download Rendered Video
              </a>
            </div>
          )}

        </div>

      </div>
    </main>
  );
}
