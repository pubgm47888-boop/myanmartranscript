import { EdgeTTS } from 'node-edge-tts';

export default async function handler(req, res) {
  // CORS Security Headers configuration
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  // Parse URL Query parameters
  const { voice = 'my-MM-NilarNeural', text, rate = '+0%', pitch = '+0Hz' } = req.query;

  if (!text) {
    return res.status(400).json({ error: 'စာသား (Text parameter) ထည့်သွင်းရန် လိုအပ်ပါသည်။' });
  }

  try {
    const tts = new EdgeTTS();
    
    // Microsoft Edge TTS Server ဆီမှ အသံလှမ်းထုတ်ယူခြင်း
    const buffer = await tts.ttsPromise({
      text: text,
      voice: voice,
      rate: rate,
      pitch: pitch
    });

    // ရရှိလာသည့် Audio Stream ကို MP3 Buffer အဖြစ် ပြန်လည်ပေးပို့ခြင်း
    res.setHeader('Content-Type', 'audio/mpeg');
    return res.send(buffer);
  } catch (error) {
    console.error('Edge TTS Service Error:', error);
    return res.status(500).json({ 
      error: 'အသံဖိုင်ထုတ်လုပ်ခြင်း မအောင်မြင်ပါ', 
      details: error.message 
    });
  }
}
