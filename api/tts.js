import { EdgeTTS } from 'edge-tts-universal';

export default async function handler(req, res) {
  // CORS Configuration
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

  // Get URL queries
  const { voice = 'my-MM-NilarNeural', text, rate = '+0%', pitch = '+0Hz' } = req.query;

  if (!text) {
    return res.status(400).json({ error: 'စာသား (Text parameter) ထည့်သွင်းရန် လိုအပ်ပါသည်။' });
  }

  try {
    // edge-tts-universal သုံးပြီး Engine Initialize လုပ်ခြင်း
    const tts = new EdgeTTS(text, voice, {
      rate: rate,
      pitch: pitch,
      volume: '+0%'
    });

    // Synthesize to ArrayBuffer directly
    const buffer = await tts.synthesize();

    // Send MP3 buffer to client
    res.setHeader('Content-Type', 'audio/mpeg');
    return res.send(Buffer.from(buffer));
  } catch (error) {
    console.error('TTS API Server Error:', error);
    return res.status(500).json({ 
      error: 'အသံဖိုင်ထုတ်လုပ်ခြင်း မအောင်မြင်ပါ', 
      details: error.message 
    });
  }
}
