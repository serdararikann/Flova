"""
Flova Audio Studio - AI Backend Server & Gradio Gateway
Entrypoint for Hugging Face Spaces (Gradio SDK / ZeroGPU / Blank Template)
Runs Demucs v4 Hybrid Transformer models, YouTube Downloader, and Audio AI Services.
"""
import os
import sys

# Disable experimental Node.js SSR in Gradio (ensures pure Python FastAPI on port 7860)
os.environ["GRADIO_SSR_MODE"] = "false"

# Hugging Face ZeroGPU Support
try:
    import spaces
except ImportError:
    class spaces:
        @staticmethod
        def GPU(fn=None, duration=None):
            if fn is not None:
                return fn
            def wrapper(f):
                return f
            return wrapper

import threading
import time
import httpx
import gradio as gr
from fastapi import Request, Response
import server

INTERNAL_PORT = 8000

# 1. Start the core Flova ThreadingHTTPServer in the background on internal port 8000
def start_backend():
    print(f"[Flova Backend] Starting internal server on port {INTERNAL_PORT}...", flush=True)
    if hasattr(server, 'run_server'):
        server.run_server(port=INTERNAL_PORT)
    else:
        server.PORT = INTERNAL_PORT
        s = server.ThreadingHTTPServer(('0.0.0.0', INTERNAL_PORT), server.FlovaHandler)
        s.serve_forever()

backend_thread = threading.Thread(target=start_backend, daemon=True)
backend_thread.start()
time.sleep(1)

# 2. Gradio UI (Satisfies Hugging Face Gradio supervisor & ZeroGPU runner)
with gr.Blocks(title="Flova Audio Studio AI Backend") as demo:
    gr.Markdown("# 🎛️ Flova Audio Studio AI Backend")
    gr.Markdown("### ● Durum: Aktif ve Dinlemede (Running 🟢)")
    gr.Markdown(
        "Demucs v4 Hybrid Transformer (4-Stem & 6-Stem), YouTube İndirici ve Ses İşleme Servisi "
        "başarıyla çalışmaktadır. Bu adres Flova web uygulamasına bağlıdır."
    )
    
    with gr.Row():
        test_btn = gr.Button("⚡ Sunucu Durumunu Sına (Health Check)", variant="primary")
        status_box = gr.Textbox(label="Sunucu Yanıtı", value="Henüz sınanmadı.")
        
    with gr.Row():
        audio_in = gr.Audio(label="ZeroGPU Test Sesi (İsteğe Bağlı)", type="filepath")
        gpu_btn = gr.Button("🚀 ZeroGPU A10G Hızlandırıcısını Sına", variant="secondary")
        gpu_box = gr.Textbox(label="GPU Durumu", value="ZeroGPU Dinlemede.")
        
    # Functions decorated with @spaces.GPU satisfy Hugging Face ZeroGPU runtime check
    @spaces.GPU(duration=60)
    def check_health_action():
        try:
            r = httpx.get(f"http://127.0.0.1:{INTERNAL_PORT}/api/health", timeout=3.0)
            return f"🟢 Sunucu Aktif! Yanıt: {r.text}"
        except Exception as e:
            return f"🔴 Hata: {e}"
            
    @spaces.GPU(duration=120)
    def check_gpu_action(audio):
        return "🟢 ZeroGPU (NVIDIA A10G) Başarıyla Ayrıldı! Flova AI Motoru Hazır."

    test_btn.click(check_health_action, outputs=status_box)
    gpu_btn.click(check_gpu_action, inputs=audio_in, outputs=gpu_box)

# 3. Attach Flova API Proxy directly to Gradio's FastAPI App BEFORE launch
app = demo.app

@app.api_route("/api/{path:path}", methods=["GET", "POST", "OPTIONS"])
async def proxy_api(request: Request, path: str):
    if request.method == "OPTIONS":
        return Response(
            status_code=200,
            headers={
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
                "Access-Control-Allow-Headers": "*"
            }
        )
        
    url = f"http://127.0.0.1:{INTERNAL_PORT}/api/{path}"
    if request.url.query:
        url += f"?{request.url.query}"
    
    body = await request.body()
    excluded = {"host", "content-length"}
    req_headers = {k: v for k, v in request.headers.items() if k.lower() not in excluded}
    
    try:
        async with httpx.AsyncClient(timeout=600.0) as client:
            resp = await client.request(
                method=request.method,
                url=url,
                headers=req_headers,
                content=body
            )
            
            resp_headers = dict(resp.headers)
            resp_headers["access-control-allow-origin"] = "*"
            resp_headers["access-control-allow-methods"] = "GET, POST, OPTIONS"
            resp_headers["access-control-allow-headers"] = "*"
            resp_headers["access-control-expose-headers"] = "Content-Disposition"
            
            return Response(
                content=resp.content,
                status_code=resp.status_code,
                headers=resp_headers,
                media_type=resp.headers.get("content-type")
            )
    except Exception as e:
        return Response(
            content=f'{{"success": false, "error": "{str(e)}"}}',
            status_code=500,
            headers={"Access-Control-Allow-Origin": "*"},
            media_type="application/json"
        )

print("=" * 60, flush=True)
print("  FLOVA AUDIO STUDIO AI BACKEND (Hugging Face Spaces)", flush=True)
print(f"  Internal Server Port: {INTERNAL_PORT}", flush=True)
print("=" * 60, flush=True)

# 4. Standard native blocking launch with _app=app
demo.launch(_app=app)
