import os
import uuid
import shutil
import asyncio
import logging
from typing import Optional

from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from . import pipeline

logging.basicConfig(format="%(asctime)s - %(levelname)s - %(message)s", level=logging.INFO)

app = FastAPI(title="AI Movie Recap - Web Engine")

# CORS: allow your Vercel frontend to call this API. Set FRONTEND_ORIGIN
# in Railway's env vars once you know your vercel.app URL, e.g.
# FRONTEND_ORIGIN=https://your-app.vercel.app
FRONTEND_ORIGIN = os.environ.get("FRONTEND_ORIGIN", "*")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[FRONTEND_ORIGIN] if FRONTEND_ORIGIN != "*" else ["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

UPLOAD_DIR = os.environ.get("RECAP_UPLOAD_DIR", "uploads")
OUTPUT_DIR = os.environ.get("RECAP_OUTPUT_DIR", "outputs")
os.makedirs(UPLOAD_DIR, exist_ok=True)
os.makedirs(OUTPUT_DIR, exist_ok=True)

# In-memory job store. Fine for a single-instance Railway deployment;
# swap for Redis/DB if you ever scale to multiple workers.
JOBS: dict[str, dict] = {}

STEP_ORDER = [
    "queued", "crop", "extract_audio", "transcribe", "translate", "title",
    "sub_translate", "tts", "sync", "concat", "subtitles", "render", "done",
]


@app.get("/api/health")
async def health():
    return {"status": "ok"}


@app.get("/api/voices")
async def voices():
    return {
        "voices": [{"key": k, "name": v["name"]} for k, v in pipeline.VOICE_MODES.items()],
        "sub_languages": pipeline.SUB_LANGUAGES,
        "sub_colors": list(pipeline.SUB_COLORS.keys()),
    }


@app.post("/api/jobs")
async def create_job(
    video: UploadFile = File(...),
    gemini_key: str = Form(...),
    groq_key: str = Form(...),
    voice: str = Form("v1"),
    speed: str = Form("1.1x"),
    platform: str = Form("yt"),
    resolution: str = Form("720"),
    subtitles_enabled: bool = Form(True),
    sub_lang: str = Form("my"),
    sub_color: str = Form("yellow"),
    font_size: int = Form(40),
    blur_mask: bool = Form(False),
):
    job_id = str(uuid.uuid4())
    input_path = os.path.join(UPLOAD_DIR, f"{job_id}_{video.filename}")
    with open(input_path, "wb") as f:
        shutil.copyfileobj(video.file, f)

    output_path = os.path.join(OUTPUT_DIR, f"{job_id}.mp4")

    JOBS[job_id] = {
        "id": job_id,
        "status": "queued",
        "step": "queued",
        "message": "Queue ထဲတွင် စောင့်ဆိုင်းနေသည်...",
        "percent": 0,
        "error": None,
        "result": None,
        "output_path": output_path,
    }

    asyncio.create_task(_run_job(
        job_id, input_path, output_path,
        gemini_key, groq_key, voice, speed, platform, resolution,
        subtitles_enabled, sub_lang, sub_color, font_size, blur_mask,
    ))

    return {"job_id": job_id}


async def _run_job(job_id, input_path, output_path, gemini_key, groq_key, voice, speed,
                    platform, resolution, subtitles_enabled, sub_lang, sub_color, font_size, blur_mask):
    async def on_progress(step, message, percent):
        JOBS[job_id].update(status="processing", step=step, message=message, percent=percent)

    try:
        result = await pipeline.run_recap_pipeline(
            input_video=input_path,
            output_video_path=output_path,
            gemini_key=gemini_key,
            groq_key=groq_key,
            voice_key=voice,
            speed=speed,
            platform=platform,
            resolution=resolution,
            subtitles_enabled=subtitles_enabled,
            sub_lang=sub_lang,
            sub_color=sub_color,
            font_size=font_size,
            blur_mask=blur_mask,
            on_progress=on_progress,
        )
        JOBS[job_id].update(status="finished", step="done", message="ပြီးမြောက်ပါပြီ။", percent=100, result=result)
    except Exception as e:
        logging.exception(f"Job {job_id} failed")
        JOBS[job_id].update(status="error", error=str(e))
    finally:
        if os.path.exists(input_path):
            os.remove(input_path)


@app.get("/api/jobs/{job_id}")
async def get_job(job_id: str):
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return {
        "id": job["id"],
        "status": job["status"],
        "step": job["step"],
        "message": job["message"],
        "percent": job["percent"],
        "error": job["error"],
        "result": job["result"],
        "step_order": STEP_ORDER,
    }


@app.get("/api/jobs/{job_id}/download")
async def download_job(job_id: str):
    job = JOBS.get(job_id)
    if not job or job["status"] != "finished":
        raise HTTPException(status_code=404, detail="Video not ready")
    if not os.path.exists(job["output_path"]):
        raise HTTPException(status_code=404, detail="Output file missing")
    return FileResponse(job["output_path"], media_type="video/mp4", filename=f"recap_{job_id}.mp4")
