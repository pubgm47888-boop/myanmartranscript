# =====================================================================
# AI Movie Recap - Web Pipeline
# Ported from the original Telegram bot engine (v76). Same sync
# mechanism: each narration chunk's speed is stretched/shrunk with
# ffmpeg `setpts` to match the generated TTS audio exactly, which is
# why this produces frame-accurate audio/video sync (the thing the
# pure browser Canvas+MediaRecorder version could never guarantee).
#
# Differences from the bot:
#   - No Telegram/telethon - this is called by FastAPI job workers.
#   - No PyQt5 - subtitle/title text is rendered with Pillow instead,
#     so this runs in a plain Docker container (no Qt/X11 deps).
#   - Single Gemini/Groq key per job (the web user supplies their own),
#     instead of the bot's multi-key rotation pool.
# =====================================================================

import os
import re
import time
import json
import math
import glob
import shutil
import asyncio
import logging
import subprocess
from concurrent.futures import ThreadPoolExecutor

import httpx
import edge_tts
from PIL import Image, ImageDraw, ImageFont

logging.basicConfig(format="%(asctime)s - %(levelname)s - %(message)s", level=logging.INFO)

TEMP_DIR = os.environ.get("RECAP_TEMP_DIR", "temp")
os.makedirs(TEMP_DIR, exist_ok=True)

CHUNK_FRAME_RATE = 30

# ---------------------------------------------------------------------
# Fonts - looks for a bundled Burmese-capable .ttf/.otf next to this file,
# falls back to Pillow's default if none is present. For real Burmese
# subtitles, drop a font file (e.g. Padauk-Bold.ttf, Pyidaungsu.ttf) into
# backend/app/fonts/ before deploying.
# ---------------------------------------------------------------------
FONT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fonts")


def _find_font_file():
    for ext in ("*.ttf", "*.otf", "*.TTF", "*.OTF"):
        matches = glob.glob(os.path.join(FONT_DIR, ext))
        if matches:
            return matches[0]
    return None


DEFAULT_FONT_FILE = _find_font_file()


def load_font(size):
    if DEFAULT_FONT_FILE:
        try:
            return ImageFont.truetype(DEFAULT_FONT_FILE, size)
        except Exception:
            pass
    try:
        return ImageFont.truetype("DejaVuSans-Bold.ttf", size)
    except Exception:
        return ImageFont.load_default()


VOICE_MODES = {
    "v1": {"name": "ကိုစိုင်းစိုင်း (Male)", "voice": "my-MM-ThihaNeural", "gender": "male", "rate": "+18%", "pitch": "+0Hz"},
    "v2": {"name": "မဖွေးဖွေး (Female)", "voice": "my-MM-NilarNeural", "gender": "female", "rate": "+18%", "pitch": "+0Hz"},
    "v3": {"name": "Nilar - Fast Action", "voice": "my-MM-NilarNeural", "gender": "female", "rate": "+25%", "pitch": "+0Hz"},
    "v4": {"name": "Thiha - Suspense", "voice": "my-MM-ThihaNeural", "gender": "male", "rate": "+15%", "pitch": "-3Hz"},
    "v5": {"name": "Andrew (English, Multilingual)", "voice": "en-US-AndrewMultilingualNeural", "gender": "male", "rate": "+15%", "pitch": "+0Hz"},
    "v6": {"name": "Ava (English, Multilingual)", "voice": "en-US-AvaMultilingualNeural", "gender": "female", "rate": "+15%", "pitch": "+0Hz"},
}

SUB_LANGUAGES = {
    "my": "မြန်မာ (Burmese)",
    "en": "English",
    "th": "ไทย (Thai)",
    "zh": "中文 (Chinese)",
    "id": "Bahasa Indonesia",
}

SUB_COLORS = {
    "yellow": (255, 214, 0, 255),
    "white": (255, 255, 255, 255),
    "cyan": (0, 229, 255, 255),
    "lime": (57, 255, 20, 255),
    "pink": (255, 110, 199, 255),
}


# =====================================================================
# ffmpeg helpers
# =====================================================================
def run_ffmpeg(cmd, label="ffmpeg"):
    result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if result.returncode != 0:
        tail = (result.stderr or "").strip()
        tail = tail[-1200:] if len(tail) > 1200 else tail
        raise RuntimeError(f"FFmpeg error [{label}] (exit {result.returncode}):\n{tail}")
    return result


def extract_audio_ffmpeg(video_path, audio_path):
    cmd = ["ffmpeg", "-y", "-i", video_path, "-vn", "-c:a", "libmp3lame",
           "-b:a", "32k", "-ar", "16000", "-ac", "1", audio_path]
    run_ffmpeg(cmd, label="extract_audio")


def get_media_duration(file_path):
    cmd = ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", file_path]
    res = subprocess.run(cmd, stdout=subprocess.PIPE, text=True, check=True)
    return float(json.loads(res.stdout)["format"]["duration"])


def create_silent_audio(duration, output_path):
    cmd = ["ffmpeg", "-y", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
           "-t", str(max(duration, 0.1)), "-c:a", "libmp3lame", "-b:a", "128k", output_path]
    run_ffmpeg(cmd, label="silent_audio")


def get_video_dimensions(platform, res):
    if platform == "tt":
        return (720, 1280) if res == "720" else (1080, 1920)
    elif platform == "fb":
        return (720, 720) if res == "720" else (1080, 1080)
    return (1280, 720) if res == "720" else (1920, 1080)


def detect_content_crop(video_path, sample_seconds=8):
    try:
        dur = get_media_duration(video_path)
    except Exception:
        dur = sample_seconds + 1.0
    ss = max(0.0, dur * 0.15)
    t = min(sample_seconds, max(dur - ss - 0.2, 1.0))
    cmd = ["ffmpeg", "-ss", f"{ss:.2f}", "-t", f"{t:.2f}", "-i", video_path,
           "-vf", "cropdetect=24:16:0", "-f", "null", "-"]
    result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    crops = re.findall(r"crop=(\d+):(\d+):(\d+):(\d+)", result.stderr or "")
    if not crops:
        return None
    w, h, x, y = (int(v) for v in crops[-1])
    if w <= 0 or h <= 0:
        return None
    return w, h, x, y


def apply_content_crop_if_needed(video_path, job_tag):
    """Removes baked-in black bars from the source clip before anything
    else touches it, so downstream sync/subtitle steps work on clean
    footage. Safe no-op if detection fails or nothing to crop."""
    try:
        crop = detect_content_crop(video_path)
        if not crop:
            return video_path
        cw, ch, cx, cy = crop
        probe = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "v:0",
             "-show_entries", "stream=width,height", "-of", "json", video_path],
            stdout=subprocess.PIPE, text=True,
        )
        dims = json.loads(probe.stdout)["streams"][0]
        src_w, src_h = dims["width"], dims["height"]
        if cw >= src_w * 0.97 and ch >= src_h * 0.97:
            return video_path
        cropped_path = os.path.join(TEMP_DIR, f"crop_{job_tag}_{int(time.time())}.mp4")
        cmd = ["ffmpeg", "-y", "-i", video_path, "-vf", f"crop={cw}:{ch}:{cx}:{cy}",
               "-c:a", "copy", cropped_path]
        run_ffmpeg(cmd, label="content_crop")
        return cropped_path
    except Exception as e:
        logging.warning(f"content crop skipped ({e}); using original footage.")
        return video_path


def get_blur_mask_filter(current_video_label="[0:v]", y_position_percent=82):
    y_position_percent = min(y_position_percent, 88)
    crop_y = f"ih*({y_position_percent}/100.0)"
    overlay_y = f"H*({y_position_percent}/100.0)"
    h_expr = "ih*0.12"
    filt = f"{current_video_label}split=2[orig_for_blur][blur_crop];"
    filt += f"[blur_crop]crop=iw:{h_expr}:0:{crop_y},scale=iw/4:ih/4,boxblur=5:2,scale=iw*4:ih*4:flags=fast_bilinear[blurred_bot];"
    filt += f"[orig_for_blur][blurred_bot]overlay=0:{overlay_y}[vid_sub_blurred]"
    return filt, "[vid_sub_blurred]"


# =====================================================================
# Groq transcription (whisper-large-v3)
# =====================================================================
async def transcribe_with_groq(audio_path, groq_key):
    with open(audio_path, "rb") as f:
        files = {"file": (os.path.basename(audio_path), f.read(), "audio/mp3")}
    data = {"model": "whisper-large-v3", "response_format": "verbose_json"}
    headers = {"Authorization": f"Bearer {groq_key.strip()}"}
    async with httpx.AsyncClient(timeout=120.0) as client:
        res = await client.post("https://api.groq.com/openai/v1/audio/transcriptions",
                                 headers=headers, data=data, files=files)
    if res.status_code != 200:
        raise Exception(f"Groq transcription error: {res.text}")
    body = res.json()
    if "segments" not in body or not body["segments"]:
        text = body.get("text", "")
        duration = body.get("duration", 1.0)
        words = text.split()
        if not words:
            return []
        word_dur = duration / len(words)
        return [{"start": i * word_dur, "end": (i + 1) * word_dur, "text": w} for i, w in enumerate(words)]
    return body["segments"]


# =====================================================================
# Gemini (single-key) helpers
# =====================================================================
_GEMINI_MODEL_CACHE = {}


async def get_working_gemini_url(api_key):
    if api_key in _GEMINI_MODEL_CACHE:
        return f"https://generativelanguage.googleapis.com/v1beta/models/{_GEMINI_MODEL_CACHE[api_key]}:generateContent?key={api_key}"
    list_url = f"https://generativelanguage.googleapis.com/v1beta/models?key={api_key}"
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            res = await client.get(list_url)
            if res.status_code == 200:
                models = res.json().get("models", [])
                available = [m["name"].replace("models/", "") for m in models
                             if "generateContent" in m.get("supportedGenerationMethods", [])]
                flash = [m for m in available if "flash" in m.lower() and "preview" not in m.lower() and "exp" not in m.lower()]
                if not flash:
                    flash = [m for m in available if "flash" in m.lower()]
                chosen = sorted(flash, reverse=True)[0] if flash else (available[0] if available else None)
                if chosen:
                    _GEMINI_MODEL_CACHE[api_key] = chosen
                    return f"https://generativelanguage.googleapis.com/v1beta/models/{chosen}:generateContent?key={api_key}"
    except Exception as e:
        logging.warning(f"gemini model list failed: {e}")
    _GEMINI_MODEL_CACHE[api_key] = "gemini-2.5-flash"
    return f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={api_key}"


async def gemini_generate(prompt, gemini_key, retries=4, timeout=30.0):
    url = await get_working_gemini_url(gemini_key)
    last_err = None
    for attempt in range(retries):
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                res = await client.post(url, json={"contents": [{"parts": [{"text": prompt}]}]},
                                         headers={"Content-Type": "application/json"})
            if res.status_code == 200:
                return res.json()["candidates"][0]["content"]["parts"][0]["text"].strip()
            if res.status_code == 429:
                await asyncio.sleep(5 * (attempt + 1))
                continue
            last_err = res.text
        except Exception as e:
            last_err = str(e)
            await asyncio.sleep(1.5)
    raise Exception(f"Gemini API error after {retries} attempts: {last_err}")


async def translate_batch_to_burmese(timeline_data, speech_indices, gemini_key, gender_rule_female):
    translated = {}
    gender_rule = ("မိန်းကလေး narrator အသံ (Female Voiceover) ဖြင့် ဖတ်မည်ဖြစ်ပါသည်။"
                   if gender_rule_female else
                   "ယောက်ျားလေး narrator အသံ (Male Voiceover) ဖြင့် ဖတ်မည်ဖြစ်ပါသည်။")
    batch_size = 10
    full_text = ""
    for i in range(0, len(speech_indices), batch_size):
        chunk = speech_indices[i:i + batch_size]
        original_text = "".join(f"[{idx}] {timeline_data[idx]['text'].strip()}\n" for idx in chunk)
        prompt = f"""
[SYSTEM INSTRUCTION: You are an expert Video Narration Translator. Translate the given subtitles into smooth, natural Burmese.]

"{original_text}"

Rules:
1. Speak like a natural narrator, not a book (no formal "သည်/၏" endings).
2. Translate every line completely, none skipped.
3. {gender_rule}
4. Avoid "ဗျာ"/"ရှင့်"/"လေ" sentence particles more than once every 10 lines.
5. Burmese script only, no English letters.
6. Keep the original [index] numbers exactly as given.
7. Keep each line to about 15-20 words max.
"""
        raw = await gemini_generate(prompt, gemini_key)
        for m in re.findall(r"\[\s*(\d+)\s*\][:\-\s]*([^\[]*)", raw):
            translated[int(m[0])] = m[1].strip()
            full_text += " " + m[1].strip()
        if len(speech_indices) > batch_size:
            await asyncio.sleep(0.4)
    return translated, full_text


async def translate_segments_to_language(timeline_data, speech_indices, gemini_key, lang_name):
    translated = {}
    batch_size = 10
    for i in range(0, len(speech_indices), batch_size):
        chunk = speech_indices[i:i + batch_size]
        original_text = "".join(f"[{idx}] {timeline_data[idx]['text'].strip()}\n" for idx in chunk)
        prompt = f"""
[SYSTEM INSTRUCTION: You are a professional subtitle translator.]
Translate the following numbered lines into natural, concise {lang_name} for on-screen subtitles.

"{original_text}"

Rules:
1. Translate every line.
2. Keep translations short and natural (subtitle style).
3. Keep the original [index] numbers exactly as given, one per line.
4. Output ONLY the numbered translated lines.
"""
        raw = await gemini_generate(prompt, gemini_key)
        for m in re.findall(r"\[\s*(\d+)\s*\][:\-\s]*([^\[]*)", raw):
            translated[int(m[0])] = m[1].strip()
        if len(speech_indices) > batch_size:
            await asyncio.sleep(0.4)
    return translated


async def generate_title_hook_hashtags(story_text, gemini_key):
    prompt = f"""
[SYSTEM INSTRUCTION: You are a fast, viral Content Creator.]
Based on this Burmese video summary, generate an engaging Title, a Hook, and exactly 3 relevant hashtags.
Story Summary:
{story_text[:2500]}
Output EXACTLY in this JSON format without any extra markdown or text:
{{
    "title": "မြန်မာဆွဲဆောင်မှုရှိသော ခေါင်းစဉ် (၁၀-၁၅ လုံးဝန်းကျင်)",
    "hook": "ဆွဲဆောင်မှုရှိသော မြန်မာစာကြောင်း ၁ ကြောင်း",
    "hashtags": "#Recap #TikTok #AIStory"
}}
"""
    try:
        raw = await gemini_generate(prompt, gemini_key)
        raw = re.sub(r"```json|```", "", raw).strip()
        data = json.loads(raw)
        return (data.get("title", "AI Movie Recap"), data.get("hook", ""), data.get("hashtags", "#Recap"))
    except Exception:
        return "AI Movie Recap", "", "#Recap #AIStory"


# =====================================================================
# Timeline building (unchanged from the bot - merges raw whisper
# segments into speech/silence chunks capped at max_dur/max_gap)
# =====================================================================
def build_complete_timeline(segments_data, total_duration, max_dur=20.0, max_gap=5.0):
    if not segments_data:
        return [{"start": 0.0, "end": total_duration, "text": "", "is_speech": False}]

    merged = []
    curr_text = ""
    curr_start = float(segments_data[0]["start"])
    curr_end = float(segments_data[0]["end"])

    for i in range(1, len(segments_data)):
        seg = segments_data[i]
        seg_start, seg_end = float(seg["start"]), float(seg["end"])
        seg_text = seg["text"].strip()
        gap = seg_start - curr_end
        if gap > max_gap or (seg_end - curr_start) > max_dur:
            if curr_text.strip():
                merged.append({"start": curr_start, "end": curr_end, "text": curr_text.strip(), "is_speech": True})
            curr_start, curr_end, curr_text = seg_start, seg_end, seg_text
        else:
            curr_text = (curr_text + " " + seg_text).strip() if curr_text else seg_text
            curr_end = seg_end

    if curr_text.strip():
        merged.append({"start": curr_start, "end": curr_end, "text": curr_text.strip(), "is_speech": True})

    timeline = []
    current_time = 0.0
    for seg in merged:
        if seg["start"] > current_time + 0.1:
            timeline.append({"start": current_time, "end": seg["start"], "text": "", "is_speech": False})
        timeline.append(seg)
        current_time = seg["end"]
    if current_time < total_duration - 0.1:
        timeline.append({"start": current_time, "end": total_duration, "text": "", "is_speech": False})
    return timeline


def _compute_frame_synced_durations(raw_durations, frame_rate=CHUNK_FRAME_RATE):
    """Carries fixed-frame-rate rounding error from each chunk into the
    next (Bresenham-style), so drift never accumulates across a long
    video - the key fix that keeps audio/video in sync end-to-end."""
    target = []
    carry = 0.0
    for d in raw_durations:
        ideal = d + carry
        frames = max(1, round(ideal * frame_rate))
        actual = frames / frame_rate
        carry = ideal - actual
        target.append(actual)
    return target


def split_subtitle_text_chronologically(text, start_t, end_t, max_chars=14):
    if not text.strip():
        return [{"start": start_t, "end": end_t, "text": text}]
    words = text.split(" ")
    chunks, current = [], ""
    for w in words:
        candidate = f"{current} {w}".strip() if current else w
        if len(candidate) <= max_chars:
            current = candidate
        else:
            if current:
                chunks.append(current)
            current = w
    if current:
        chunks.append(current)
    if not chunks:
        chunks = [text]

    duration = max(end_t - start_t, 0.5)
    lens = [max(len(c), 1) for c in chunks]
    total_len = sum(lens)
    result, cursor = [], start_t
    for i, chunk in enumerate(chunks):
        is_last = i == len(chunks) - 1
        share = lens[i] / total_len
        c_dur = duration * share
        c_start = cursor
        c_end = end_t if is_last else min(cursor + c_dur, end_t)
        if c_end - c_start < 0.5:
            c_end = min(c_start + 0.5, end_t) if not is_last else end_t
        result.append({"start": c_start, "end": c_end, "text": chunk})
        cursor = c_end
    return result


# =====================================================================
# Per-chunk sync: THIS is the core mechanism that keeps audio/video in
# sync (stretch/shrink the video segment's own timeline with `setpts`
# to exactly match the TTS narration length, then pad any shortfall by
# cloning the last frame instead of freezing/skipping).
# =====================================================================
def process_single_chunk(args):
    idx, start_time, end_time, input_video, chunk_audio_path, target_dur, platform, res = args
    chunk_video_path = os.path.join(TEMP_DIR, f"chunk_vid_{idx}_{int(time.time()*1000)}.mp4")
    try:
        audio_dur = max(target_dur, 0.1)
        vid_dur = max(end_time - start_time, 0.1)
        speed_ratio = audio_dur / vid_dur
        speed_ratio = min(max(speed_ratio, 0.2), 6.0)

        dim_w, dim_h = get_video_dimensions(platform, res)
        color_edit = "eq=contrast=1.04:brightness=0.01:saturation=1.12,"
        adjusted_vid_dur = vid_dur * speed_ratio
        pad_needed = max(0.0, audio_dur - adjusted_vid_dur)
        tpad_filter = f"tpad=stop_mode=clone:stop_duration={pad_needed:.3f}," if pad_needed > 0.03 else ""

        v_branch = (
            f"[0:v]trim=start={start_time}:end={end_time},setpts=PTS-STARTPTS,"
            f"setpts={speed_ratio:.4f}*PTS,"
            f"{color_edit}"
            f"split=2[vb_bg][vb_fg];"
            f"[vb_bg]scale={dim_w}:{dim_h}:force_original_aspect_ratio=increase,crop={dim_w}:{dim_h},boxblur=16:4,eq=brightness=-0.05[vb_bgblur];"
            f"[vb_fg]scale={dim_w}:{dim_h}:force_original_aspect_ratio=decrease[vb_fgs];"
            f"[vb_bgblur][vb_fgs]overlay=(W-w)/2:(H-h)/2,"
            f"{tpad_filter}"
            f"trim=0:{audio_dur:.3f},setpts=PTS-STARTPTS[v_out];"
        )
        a_branch = f"[1:a]aresample=44100,volume=1.6,apad,atrim=0:{audio_dur:.3f},asetpts=PTS-STARTPTS[a_out]"
        filter_str = v_branch + a_branch

        cmd = [
            "ffmpeg", "-y", "-i", input_video, "-i", chunk_audio_path,
            "-filter_complex", filter_str,
            "-map", "[v_out]", "-map", "[a_out]",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-r", str(CHUNK_FRAME_RATE),
            "-c:a", "aac", "-ar", "44100", "-ac", "2",
            chunk_video_path,
        ]
        run_ffmpeg(cmd, label=f"chunk_{idx}_sync")
        actual_dur = get_media_duration(chunk_video_path)
        return idx, chunk_video_path, actual_dur
    except Exception as e:
        logging.error(f"process_single_chunk idx={idx} failed: {e}")
        if os.path.exists(chunk_video_path):
            os.remove(chunk_video_path)
        return idx, None, 0.0


# =====================================================================
# Subtitle image rendering (Pillow port of the bot's PyQt5 renderer -
# same idea: transparent PNG per subtitle line, stitched over the
# video timeline via an ffconcat "image sequence" input)
# =====================================================================
def _wrap_text(draw, text, font, max_w):
    words = [w for w in text.split(" ") if w]
    lines, current = [], ""
    for word in words:
        candidate = f"{current} {word}".strip() if current else word
        bbox = draw.textbbox((0, 0), candidate, font=font)
        if bbox[2] - bbox[0] <= max_w or not current:
            current = candidate
        else:
            lines.append(current)
            current = word
    if current:
        lines.append(current)
    return lines


def render_subtitle_png(text, out_path, width, height, sub_y_percent=82, color="yellow", font_size=44):
    img = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    font = load_font(font_size)
    max_w = int(width * 0.86)
    lines = _wrap_text(draw, text, font, max_w)

    line_h = int(font_size * 1.3)
    total_h = line_h * len(lines)
    y = int(height * (sub_y_percent / 100.0))

    box_pad = 18
    box_w = max((draw.textbbox((0, 0), line, font=font)[2] for line in lines), default=0) + box_pad * 2
    draw.rectangle(
        [int((width - box_w) / 2), y - box_pad, int((width - box_w) / 2) + box_w, y + total_h + box_pad],
        fill=(0, 0, 0, 130),
    )

    fill_color = SUB_COLORS.get(color, SUB_COLORS["yellow"])
    cy = y
    for line in lines:
        bbox = draw.textbbox((0, 0), line, font=font)
        lw = bbox[2] - bbox[0]
        lx = int((width - lw) / 2)
        # thin black outline for legibility
        for dx, dy in [(-2, 0), (2, 0), (0, -2), (0, 2), (-2, -2), (2, 2), (-2, 2), (2, -2)]:
            draw.text((lx + dx, cy + dy), line, font=font, fill=(0, 0, 0, 255))
        draw.text((lx, cy), line, font=font, fill=fill_color)
        cy += line_h
    img.save(out_path, "PNG")


def generate_subtitle_overlay_concat(sub_segments, audio_length, job_dir, tw, th, sub_y_percent, sub_color, font_size):
    blank_path = os.path.join(job_dir, "blank_sub.png")
    Image.new("RGBA", (tw, th), (0, 0, 0, 0)).save(blank_path, "PNG")

    concat_path = os.path.join(job_dir, "subs_concat.txt")
    with open(concat_path, "w", encoding="utf-8") as f:
        f.write("ffconcat version 1.0\n")
        current_time = 0.0
        abs_blank = os.path.abspath(blank_path).replace("\\", "/")
        for i, seg in enumerate(sub_segments):
            txt = seg.get("text", "").strip()
            if not txt:
                continue
            start_t, end_t = float(seg["start"]), float(seg["end"])
            if end_t - start_t < 0.5:
                end_t = start_t + 0.5
            if start_t > current_time + 0.05:
                f.write(f"file '{abs_blank}'\nduration {start_t - current_time:.3f}\n")
            sub_png = os.path.join(job_dir, f"sub_{i}.png")
            render_subtitle_png(txt, sub_png, tw, th, sub_y_percent, sub_color, font_size)
            f.write(f"file '{os.path.abspath(sub_png).replace(chr(92), '/')}'\nduration {end_t - start_t:.3f}\n")
            current_time = end_t
        if current_time < audio_length - 0.05:
            f.write(f"file '{abs_blank}'\nduration {audio_length - current_time:.3f}\n")
        f.write(f"file '{abs_blank}'\n")
    return concat_path


# =====================================================================
# MAIN PIPELINE - orchestrates every step and reports progress through
# a callback so the FastAPI job layer can expose it to the frontend.
# =====================================================================
async def run_recap_pipeline(
    input_video: str,
    output_video_path: str,
    gemini_key: str,
    groq_key: str,
    voice_key: str = "v1",
    speed: str = "1.1x",
    platform: str = "yt",
    resolution: str = "720",
    subtitles_enabled: bool = True,
    sub_lang: str = "my",
    sub_color: str = "yellow",
    font_size: int = 40,
    blur_mask: bool = False,
    on_progress=None,
):
    async def report(step, message, percent):
        if on_progress:
            await on_progress(step, message, percent)

    job_tag = f"{int(time.time())}"
    job_dir = os.path.join(TEMP_DIR, f"job_{job_tag}")
    os.makedirs(job_dir, exist_ok=True)

    await report("crop", "မူရင်းဗီဒီယိုထဲက black bar များကို စစ်ဆေးနေသည်...", 3)
    clean_video = apply_content_crop_if_needed(input_video, job_tag)

    total_duration = get_media_duration(clean_video)
    extracted_audio = os.path.join(job_dir, "extracted.mp3")

    await report("extract_audio", "အသံကို ဗီဒီယိုမှ ခွဲထုတ်နေသည်...", 8)
    extract_audio_ffmpeg(clean_video, extracted_audio)

    await report("transcribe", "မူရင်းစကားသံများကို Groq (Whisper) ဖြင့် ဖတ်နေသည်...", 18)
    raw_segments = await transcribe_with_groq(extracted_audio, groq_key)
    if not raw_segments:
        raise Exception("ဗီဒီယိုထဲတွင် ရှင်းလင်းသော စကားသံ မတွေ့ပါ။")

    timeline = build_complete_timeline(raw_segments, total_duration)
    speech_indices = [i for i, seg in enumerate(timeline) if seg["is_speech"]]
    if not speech_indices:
        raise Exception("ပြောစကား အပိုင်းများ မတွေ့ပါ။")

    voice_config = VOICE_MODES.get(voice_key, VOICE_MODES["v1"])

    await report("translate", "Gemini ဖြင့် မြန်မာဘာသာသို့ ပြန်ဆိုနေသည်...", 32)
    translated_dict, full_translated_text = await translate_batch_to_burmese(
        timeline, speech_indices, gemini_key, voice_config["gender"] == "female"
    )

    await report("title", "ခေါင်းစဉ်နှင့် Hashtag များ ထုတ်လုပ်နေသည်...", 38)
    story_title, story_hook, story_hashtags = await generate_title_hook_hashtags(full_translated_text, gemini_key)

    translated_dict_secondary = {}
    if subtitles_enabled and sub_lang != "my":
        await report("sub_translate", f"စာတန်းထိုးအတွက် {SUB_LANGUAGES.get(sub_lang, sub_lang)} သို့ ပြန်ဆိုနေသည်...", 42)
        translated_dict_secondary = await translate_segments_to_language(
            timeline, speech_indices, gemini_key, SUB_LANGUAGES.get(sub_lang, sub_lang)
        )

    await report("tts", f"AI အသံ ({voice_config['name']}) ဖြင့် narration ထုတ်လုပ်နေသည်...", 48)
    audio_files_map = {}
    tts_semaphore = asyncio.Semaphore(6)
    selected_rate = voice_config.get("rate", "+15%")

    async def gen_chunk_audio(idx, seg):
        path = os.path.join(job_dir, f"chunk_audio_{idx}.mp3")
        expected_dur = seg["end"] - seg["start"]
        if not seg["is_speech"] or idx not in translated_dict or not translated_dict[idx].strip():
            create_silent_audio(expected_dur, path)
            audio_files_map[idx] = path
            return
        clean_text = re.sub(r"[\[\]{}()<>~*#_]", "", translated_dict[idx]).strip()
        if len(clean_text) < 2:
            create_silent_audio(expected_dur, path)
            audio_files_map[idx] = path
            return
        async with tts_semaphore:
            rendered = False
            for _ in range(3):
                try:
                    comm = edge_tts.Communicate(text=clean_text, voice=voice_config["voice"],
                                                 rate=selected_rate, pitch=voice_config["pitch"])
                    await comm.save(path)
                    if os.path.exists(path) and os.path.getsize(path) > 500:
                        rendered = True
                        break
                except Exception:
                    await asyncio.sleep(1.0)
            if not rendered:
                create_silent_audio(expected_dur, path)
            audio_files_map[idx] = path

    await asyncio.gather(*[gen_chunk_audio(i, seg) for i, seg in enumerate(timeline)])

    await report("sync", "ဗီဒီယို segment တစ်ခုချင်းစီကို narration အသံနှင့် frame-accurate ကိုက်ညီအောင် ညှိနေသည်...", 62)
    ordered_idxs = [i for i in range(len(timeline)) if i in audio_files_map]
    raw_durs = [get_media_duration(audio_files_map[i]) for i in ordered_idxs]
    target_durs = _compute_frame_synced_durations(raw_durs)
    target_dur_map = dict(zip(ordered_idxs, target_durs))

    chunk_args = [
        (i, float(timeline[i]["start"]), float(timeline[i]["end"]), clean_video,
         audio_files_map[i], target_dur_map[i], platform, resolution)
        for i in ordered_idxs
    ]

    loop = asyncio.get_event_loop()
    with ThreadPoolExecutor(max_workers=min(os.cpu_count() or 4, 6)) as executor:
        chunk_results = await loop.run_in_executor(None, lambda: list(executor.map(process_single_chunk, chunk_args)))
    chunk_results.sort(key=lambda x: x[0])
    ffmpeg_inputs = [r[1] for r in chunk_results if r[1] is not None]
    chunk_durations = {r[0]: r[2] for r in chunk_results if r[1] is not None}
    if not ffmpeg_inputs:
        raise Exception("ဗီဒီယို Timeline ချိန်ညှိမှု မအောင်မြင်ပါ။")

    await report("concat", "ဗီဒီယို segment များကို တစ်ခုတည်း ပေါင်းစည်းနေသည်...", 78)
    concat_list_path = os.path.join(job_dir, "concat_list.txt")
    with open(concat_list_path, "w", encoding="utf-8") as f:
        for v in ffmpeg_inputs:
            f.write(f"file '{os.path.abspath(v)}'\n")
    merged_path = os.path.join(job_dir, "merged.mp4")
    run_ffmpeg(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", concat_list_path,
                "-c", "copy", "-fflags", "+genpts", "-avoid_negative_ts", "make_zero", merged_path],
               label="concat_merge")

    dim_w, dim_h = get_video_dimensions(platform, resolution)

    sub_segments = []
    cursor = 0.0
    for i in range(len(timeline)):
        if i not in chunk_durations:
            continue
        dur = chunk_durations[i]
        if subtitles_enabled and timeline[i]["is_speech"]:
            source = translated_dict_secondary if sub_lang != "my" else translated_dict
            text = source.get(i, "").strip()
            if text:
                sub_segments.extend(split_subtitle_text_chronologically(text, cursor, cursor + dur))
        cursor += dur
    total_final_duration = cursor

    inputs = ["-i", merged_path]
    filter_complex_parts = []
    map_video_label = "0:v"
    next_idx = 1

    blur_str, blur_label = ("", None)
    if blur_mask:
        blur_str, blur_label = get_blur_mask_filter("[0:v]", 82)

    subs_concat_path = None
    if subtitles_enabled and sub_segments:
        await report("subtitles", "စာတန်းထိုးများကို ဖန်တီးနေသည်...", 86)
        subs_concat_path = generate_subtitle_overlay_concat(
            sub_segments, total_final_duration, job_dir, dim_w, dim_h, 82, sub_color, font_size
        )
        inputs += ["-f", "concat", "-safe", "0", "-i", subs_concat_path]
        subs_idx = next_idx
        next_idx += 1
    else:
        subs_idx = None

    if blur_str:
        filter_complex_parts.append(blur_str)
        map_video_label = "vid_sub_blurred"

    if subs_idx is not None:
        filter_complex_parts.append(f"[{map_video_label}][{subs_idx}:v]overlay=0:0:shortest=1[v]")
        final_video_label = "v"
    else:
        final_video_label = map_video_label

    await report("render", "နောက်ဆုံးအဆင့် ဗီဒီယို render ပြုလုပ်နေသည်...", 92)
    if filter_complex_parts:
        filter_complex = ";".join(filter_complex_parts)
        cmd = [
            "ffmpeg", "-y", *inputs,
            "-filter_complex", filter_complex,
            "-map", f"[{final_video_label}]" if final_video_label != "0:v" else "0:v",
            "-map", "0:a",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast",
            "-c:a", "aac", "-ar", "44100", "-ac", "2",
            output_video_path,
        ]
        run_ffmpeg(cmd, label="final_render")
    else:
        shutil.copy(merged_path, output_video_path)

    shutil.rmtree(job_dir, ignore_errors=True)
    if clean_video != input_video and os.path.exists(clean_video):
        os.remove(clean_video)

    await report("done", "ပြီးမြောက်ပါပြီ။", 100)
    return {
        "title": story_title,
        "hook": story_hook,
        "hashtags": story_hashtags,
        "duration": total_final_duration,
    }
