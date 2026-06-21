import WebSocket from 'ws';

// UUID random generator to simulate official Edge connection id
function generateConnectionId() {
  return 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    var r = Math.random() * 16 | 0;
    return r.toString(16);
  });
}

// XML characters escaping to prevent SSML parser failure
function escapeXml(unsafe) {
  return unsafe.replace(/[<>&'"]/g, function (c) {
    switch (c) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case '\'': return '&apos;';
      case '"': return '&quot;';
      default: return c;
    }
  });
}

export default async function handler(req, res) {
  // Setup CORS Headers
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  const { voice = 'my-MM-NilarNeural', text, rate = '+0%', pitch = '+0Hz' } = req.query;

  if (!text) {
    return res.status(400).json({ error: 'စာသား (Text parameter) ထည့်သွင်းရန် လိုအပ်ပါသည်။' });
  }

  try {
    const connectionId = generateConnectionId();
    const wsUrl = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/cognitive/v1?trustedclienttoken=6A5AA1D4EAFF4E9B87E7D3C2844AD9C5&ConnectionId=${connectionId}`;

    const ws = new WebSocket(wsUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Origin': 'chrome-extension://jdiccldimpdaibofdbgfjebmciafeclg'
      }
    });

    const audioBuffers = [];

    await new Promise((resolve, reject) => {
      ws.on('open', () => {
        // Send Speech Config Message
        const timestamp = new Date().toISOString();
        const configMsg = `X-Timestamp:${timestamp}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n{"context":{"system":{"name":"SpeechSDK","version":"1.30.0","build":"JavaScript","lang":"JavaScript"},"os":{"platform":"Browser","name":"Chrome","version":"120.0.0.0"}}}`;
        ws.send(configMsg);

        // Send SSML Synthesize Request Message
        const escapedText = escapeXml(text);
        const ssmlMsg = `X-RequestId:${connectionId}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${timestamp}\r\nPath:ssml\r\n\r\n<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'><voice name='${voice}'><prosody rate='${rate}' pitch='${pitch}'>${escapedText}</prosody></voice></speak>`;
        ws.send(ssmlMsg);
      });

      ws.on('message', (data, isBinary) => {
        if (isBinary) {
          const buffer = Buffer.from(data);
          if (buffer.length > 2) {
            // Read length of header metadata inside binary frame
            const headerLength = buffer.readUInt16BE(0);
            const header = buffer.toString('utf8', 2, 2 + headerLength);
            const audioData = buffer.slice(2 + headerLength);
            
            // Collect audio frame buffers
            if (header.includes('Path:audio')) {
              audioBuffers.push(audioData);
            }
          }
        } else {
          const textMessage = data.toString();
          // Turn completed indicator
          if (textMessage.includes('Path:turn.end')) {
            ws.close();
            resolve();
          }
        }
      });

      ws.on('error', (err) => {
        reject(err);
      });

      ws.on('close', () => {
        resolve();
      });

      // Safety timeout guard (Vercel maximum is 10s for Hobby tier)
      setTimeout(() => {
        ws.close();
        reject(new Error('Cloud TTS Server Connection Timeout.'));
      }, 8500);
    });

    if (audioBuffers.length === 0) {
      throw new Error('အသံဒေတာ မရရှိပါ။ Cloud စနစ်မှ တုံ့ပြန်မှု ကွက်လပ်ဖြစ်နေသည်။');
    }

    // Merge and return the complete MP3 binary buffer
    const finalAudioBuffer = Buffer.concat(audioBuffers);
    res.setHeader('Content-Type', 'audio/mpeg');
    return res.send(finalAudioBuffer);

  } catch (error) {
    console.error('Custom Cloud TTS Backend Error:', error);
    return res.status(500).json({ 
      error: 'Cloud Speech Synthesizer အမှားအယွင်းရှိနေပါသည်', 
      details: error.message 
    });
  }
}
