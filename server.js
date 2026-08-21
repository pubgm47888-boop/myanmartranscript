const express = require('express');
const path = require('path');

const app = express();
app.use(express.json({ limit: '25mb' })); // reference audio base64 ပါလို့ limit တိုးထားတယ်
app.use(express.static(path.join(__dirname, 'public')));

const RUNPOD_API_KEY = process.env.RUNPOD_API_KEY;
const RUNPOD_ENDPOINT_ID = process.env.RUNPOD_ENDPOINT_ID;

if (!RUNPOD_API_KEY || !RUNPOD_ENDPOINT_ID) {
  console.error('⚠️  RUNPOD_API_KEY / RUNPOD_ENDPOINT_ID environment variable များ Render Settings ထဲမှာ ထည့်ပါ');
}

// Frontend ကနေ ဒီ endpoint ကိုပဲ ခေါ်မယ် — RunPod key ကို client ဘက် လုံးဝ မပို့ပါ
app.post('/api/generate', async (req, res) => {
  try {
    const runRes = await fetch(`https://api.runpod.ai/v2/${RUNPOD_ENDPOINT_ID}/run`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${RUNPOD_API_KEY}`,
      },
      body: JSON.stringify({ input: req.body }),
    });
    const data = await runRes.json();
    if (!runRes.ok) {
      return res.status(runRes.status).json({ error: data.error || 'RunPod request fail ဖြစ်ပါတယ်' });
    }
    res.json(data); // { id, status }
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
    console.error(err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
