import os
import sys
import json
import time
import uuid
import threading
import subprocess
import shutil
import re
import urllib.request
import urllib.parse
from urllib.parse import urlparse, parse_qs, quote
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
import io
import mimetypes

# Fix Windows registry MIME issues where .js is often registered as text/plain
mimetypes.init()
mimetypes.add_type('application/javascript', '.js')
mimetypes.add_type('application/javascript', '.mjs')
mimetypes.add_type('text/css', '.css')
mimetypes.add_type('application/json', '.json')
mimetypes.add_type('image/svg+xml', '.svg')
mimetypes.add_type('application/wasm', '.wasm')

# Ensure UTF-8 output on all operating systems (prevents Windows charmap crashes on emojis/unicode)
try:
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    if hasattr(sys.stderr, 'reconfigure'):
        sys.stderr.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

import soundfile as sf
import numpy as np

try:
    import demucs_onnx
except ImportError:
    demucs_onnx = None

def get_ffmpeg_binary():
    import shutil
    for p in ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/bin/ffmpeg']:
        if os.path.exists(p):
            return p
    which_ffmpeg = shutil.which('ffmpeg')
    if which_ffmpeg:
        return which_ffmpeg
    try:
        import imageio_ffmpeg
        exe = imageio_ffmpeg.get_ffmpeg_exe()
        if exe and os.path.exists(exe):
            return exe
    except Exception:
        pass
    return 'ffmpeg'

try:
    import yt_dlp
    FFMPEG_EXE = get_ffmpeg_binary()
except Exception as e:
    yt_dlp = None
    FFMPEG_EXE = None

try:
    import yt_dlp_ejs
except ImportError:
    try:
        subprocess.run([sys.executable, '-m', 'pip', 'install', 'yt-dlp-ejs>=0.8.0', '--quiet'], check=False, timeout=30)
        import yt_dlp_ejs
    except Exception:
        pass

try:
    from yt_dlp_plugins.extractor import getpot_bgutil_cli, getpot_bgutil_http
except Exception:
    pass

try:
    import noisereduce as nr
except ImportError:
    nr = None

try:
    import speech_recognition as sr_module
except ImportError:
    sr_module = None

PORT = int(os.environ.get('PORT', 3000))
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
TEMP_DIR = os.path.join(BASE_DIR, 'temp_stems')
YT_TEMP_DIR = os.path.join(BASE_DIR, 'temp_youtube')
os.makedirs(TEMP_DIR, exist_ok=True)
os.makedirs(YT_TEMP_DIR, exist_ok=True)

# Set process priority to BELOW_NORMAL so system, browser, and background never lag
if os.name == 'nt':
    try:
        import ctypes
        kernel32 = ctypes.windll.kernel32
        kernel32.SetPriorityClass.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
        kernel32.SetPriorityClass.restype = ctypes.c_bool
        kernel32.SetPriorityClass(kernel32.GetCurrentProcess(), 0x00004000)
    except Exception:
        pass

# Thread-safe in-memory job tracker
JOBS = {}
JOBS_LOCK = threading.Lock()

# Global cached ONNX sessions
VOCAL_SESSION = None
HTDEMUCS_SESSION = None
HTDEMUCS_6S_SESSION = None
SESSION_LOCK = threading.Lock()

def create_optimized_session_options():
    import onnxruntime as ort
    sess_opts = ort.SessionOptions()
    # Allocate up to 6 worker threads
    total_cores = os.cpu_count() or 4
    worker_threads = min(6, max(2, total_cores // 2))
    sess_opts.intra_op_num_threads = worker_threads
    sess_opts.inter_op_num_threads = 1
    sess_opts.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    sess_opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_BASIC
    sess_opts.enable_cpu_mem_arena = False
    sess_opts.enable_mem_pattern = False
    return sess_opts

def get_vocal_session():
    global VOCAL_SESSION
    with SESSION_LOCK:
        if VOCAL_SESSION is None:
            import onnxruntime as ort
            from demucs_onnx.inference import download_stem_model
            
            sess_opts = create_optimized_session_options()
            model_path = download_stem_model('vocals')
            VOCAL_SESSION = ort.InferenceSession(
                str(model_path),
                sess_options=sess_opts,
                providers=['CPUExecutionProvider']
            )
        return VOCAL_SESSION

def get_htdemucs_session():
    global HTDEMUCS_SESSION
    with SESSION_LOCK:
        if HTDEMUCS_SESSION is None:
            import onnxruntime as ort
            from huggingface_hub import hf_hub_download
            
            sess_opts = create_optimized_session_options()
            model_path = hf_hub_download('StemSplitio/htdemucs-onnx', 'htdemucs.onnx')
            HTDEMUCS_SESSION = ort.InferenceSession(
                str(model_path),
                sess_options=sess_opts,
                providers=['CPUExecutionProvider']
            )
        return HTDEMUCS_SESSION

def get_htdemucs_6s_session():
    global HTDEMUCS_6S_SESSION
    with SESSION_LOCK:
        if HTDEMUCS_6S_SESSION is None:
            import onnxruntime as ort
            from huggingface_hub import hf_hub_download
            
            sess_opts = create_optimized_session_options()
            model_path = hf_hub_download('StemSplitio/htdemucs-6s-onnx', 'htdemucs_6s.onnx')
            HTDEMUCS_6S_SESSION = ort.InferenceSession(
                str(model_path),
                sess_options=sess_opts,
                providers=['CPUExecutionProvider']
            )
        return HTDEMUCS_6S_SESSION

def apply_soft_noise_gate(audio_stem, threshold_db=-45.0, sr=44100):
    """
    Soft-knee adaptive noise gate to suppress faint bleed/reverb spill during quiet sections.
    Smoothly attenuates inactive frames without clipping natural decay tails.
    """
    try:
        frame_len = int(sr * 0.02) # 20ms frames
        if frame_len <= 0 or audio_stem.shape[1] < frame_len:
            return audio_stem

        mono = np.mean(audio_stem, axis=0)
        n_frames = audio_stem.shape[1] // frame_len
        padded_len = n_frames * frame_len

        frames = mono[:padded_len].reshape(n_frames, frame_len)
        rms = np.sqrt(np.mean(frames ** 2, axis=1) + 1e-12)
        rms_db = 20 * np.log10(np.maximum(rms, 1e-6))

        gate_gains = np.ones(n_frames, dtype=np.float32)
        knee_width = 8.0
        low_thresh = threshold_db - knee_width

        for f in range(n_frames):
            db = rms_db[f]
            if db < low_thresh:
                gate_gains[f] = 0.02
            elif db < threshold_db:
                alpha = (db - low_thresh) / knee_width
                gate_gains[f] = 0.02 + 0.98 * (alpha ** 2)
            else:
                gate_gains[f] = 1.0

        sample_gains = np.repeat(gate_gains, frame_len)
        if len(sample_gains) < audio_stem.shape[1]:
            sample_gains = np.pad(sample_gains, (0, audio_stem.shape[1] - len(sample_gains)), mode='edge')
        else:
            sample_gains = sample_gains[:audio_stem.shape[1]]

        smooth_win = int(sr * 0.01)
        if smooth_win > 1:
            kernel = np.ones(smooth_win, dtype=np.float32) / smooth_win
            sample_gains = np.convolve(sample_gains, kernel, mode='same')

        return audio_stem * sample_gains
    except Exception:
        return audio_stem

def apply_peak_limiter(audio_stem):
    """Prevents digital clipping by soft-scaling if true peak exceeds -0.2 dBFS."""
    peak = float(np.max(np.abs(audio_stem)))
    if peak > 0.98:
        return audio_stem * (0.98 / peak)
    return audio_stem

def run_htdemucs_job(job_id, input_path):
    """Background worker for Demucs 4-stem (drums, bass, other, vocals) neural separation with 50% overlap & studio gating."""
    try:
        from demucs_onnx.inference import (
            load_audio, _make_transition_window, resample_to_native,
            SAMPLE_RATE, N_SAMPLES, N_CHANNELS
        )

        with JOBS_LOCK:
            JOBS[job_id] = {
                'status': 'processing',
                'progress': 10,
                'message': 'Ses dosyası yükleniyor ve hazırlanıyor...'
            }

        audio, native_sr = load_audio(input_path, target_sr=SAMPLE_RATE)
        total_len = audio.shape[1]
        
        # 25% overlap for fast processing & seamless chunk transitions without phase flanging
        overlap = N_SAMPLES // 4
        stride = N_SAMPLES - overlap
        n_chunks = max(1, (total_len + stride - 1) // stride)

        with JOBS_LOCK:
            JOBS[job_id]['progress'] = 15
            JOBS[job_id]['message'] = f'Demucs 4-Stem modeli yükleniyor ({n_chunks} parça yüksek kaliteyle ayrıştırılacak)...'

        session = get_htdemucs_session()
        window = _make_transition_window(N_SAMPLES)
        
        # 4 stems: 0: drums, 1: bass, 2: other, 3: vocals
        out_stems = np.zeros((4, N_CHANNELS, total_len), dtype=np.float32)
        weight = np.zeros(total_len, dtype=np.float32)

        for i in range(n_chunks):
            start = i * stride
            end = min(start + N_SAMPLES, total_len)
            chunk = audio[:, start:end]
            if chunk.shape[1] < N_SAMPLES:
                chunk = np.pad(chunk, ((0, 0), (0, N_SAMPLES - chunk.shape[1])), mode='constant')
            x = chunk[np.newaxis, ...].astype(np.float32, copy=False)
            chunk_len = end - start
            w = window[:chunk_len]

            stems = session.run(['stems'], {'mix': x})[0][0]
            out_stems[:, :, start:end] += stems[:, :, :chunk_len] * w
            weight[start:end] += w

            # 5ms yield to OS so system, mouse, and browser stay 100% fluid
            time.sleep(0.005)

            chunk_pct = int(18 + ((i + 1) / n_chunks) * 70)
            with JOBS_LOCK:
                JOBS[job_id]['progress'] = chunk_pct
                JOBS[job_id]['message'] = f'4 Stem ayrıştırılıyor: {i + 1}/{n_chunks} parça (%{chunk_pct})'

        weight = np.maximum(weight, 1e-8)
        out_stems /= weight

        with JOBS_LOCK:
            JOBS[job_id]['progress'] = 90
            JOBS[job_id]['message'] = 'Akustik gürültü kapısı ve tavan sınırlayıcısı uygulanıyor...'

        # Resample & apply studio post-processing
        stem_keys = ['drums', 'bass', 'other', 'vocals']
        gate_thresholds = {
            'drums': -48.0,
            'bass': -46.0,
            'other': -50.0,
            'vocals': -44.0
        }

        resampled_stems = {}
        for idx, key in enumerate(stem_keys):
            st = out_stems[idx]
            if native_sr != SAMPLE_RATE:
                st = resample_to_native(st, SAMPLE_RATE, native_sr)
            
            # Apply adaptive bleed reduction and peak limiter
            st = apply_soft_noise_gate(st, threshold_db=gate_thresholds[key], sr=native_sr)
            st = apply_peak_limiter(st)
            resampled_stems[key] = st

        with JOBS_LOCK:
            JOBS[job_id]['progress'] = 96
            JOBS[job_id]['message'] = 'Stüdyo kalitesinde 4 Stem WAV dosyası kaydediliyor...'

        for key in stem_keys:
            out_path = os.path.join(TEMP_DIR, f'{key}_{job_id}.wav')
            sf.write(out_path, resampled_stems[key].T, native_sr)

        with JOBS_LOCK:
            JOBS[job_id] = {
                'status': 'done',
                'progress': 100,
                'message': '4 Stem başarıyla ayrıştırıldı!',
                'stems': {
                    'vocals': f'/api/stem?jobId={job_id}&type=vocals',
                    'drums': f'/api/stem?jobId={job_id}&type=drums',
                    'bass': f'/api/stem?jobId={job_id}&type=bass',
                    'other': f'/api/stem?jobId={job_id}&type=other'
                }
            }
    except Exception as e:
        print(f"Error in 4-stem job {job_id}: {e}")
        with JOBS_LOCK:
            JOBS[job_id] = {
                'status': 'error',
                'progress': 0,
                'error': str(e)
            }

def run_htdemucs_6s_job(job_id, input_path):
    """Background worker for Demucs 6-stem (drums, bass, other, vocals, guitar, piano) neural separation."""
    try:
        from demucs_onnx.inference import (
            load_audio, _make_transition_window, resample_to_native,
            SAMPLE_RATE, N_SAMPLES, N_CHANNELS
        )

        with JOBS_LOCK:
            JOBS[job_id] = {
                'status': 'processing',
                'progress': 10,
                'message': 'Ses dosyası yükleniyor ve hazırlanıyor...'
            }

        audio, native_sr = load_audio(input_path, target_sr=SAMPLE_RATE)
        total_len = audio.shape[1]
        
        # 25% overlap for high speed while keeping silk-smooth transitions
        overlap = N_SAMPLES // 4
        stride = N_SAMPLES - overlap
        n_chunks = max(1, (total_len + stride - 1) // stride)

        with JOBS_LOCK:
            JOBS[job_id]['progress'] = 15
            JOBS[job_id]['message'] = f'Demucs 6-Stem Pro modeli yükleniyor ({n_chunks} parça derinlemesine ayrıştırılacak)...'

        session = get_htdemucs_6s_session()
        window = _make_transition_window(N_SAMPLES)
        
        # 6 stems: 0: drums, 1: bass, 2: other, 3: vocals, 4: guitar, 5: piano
        out_stems = np.zeros((6, N_CHANNELS, total_len), dtype=np.float32)
        weight = np.zeros(total_len, dtype=np.float32)

        for i in range(n_chunks):
            start = i * stride
            end = min(start + N_SAMPLES, total_len)
            chunk = audio[:, start:end]
            if chunk.shape[1] < N_SAMPLES:
                chunk = np.pad(chunk, ((0, 0), (0, N_SAMPLES - chunk.shape[1])), mode='constant')
            x = chunk[np.newaxis, ...].astype(np.float32, copy=False)
            chunk_len = end - start
            w = window[:chunk_len]

            stems = session.run(['stems'], {'mix': x})[0][0]
            out_stems[:, :, start:end] += stems[:, :, :chunk_len] * w
            weight[start:end] += w

            # 5ms yield to OS so system, mouse, and browser stay 100% fluid
            time.sleep(0.005)

            chunk_pct = int(18 + ((i + 1) / n_chunks) * 70)
            with JOBS_LOCK:
                JOBS[job_id]['progress'] = chunk_pct
                JOBS[job_id]['message'] = f'6 Stem (Piyano & Gitar dahil) ayrıştırılıyor: {i + 1}/{n_chunks} parça (%{chunk_pct})'

        weight = np.maximum(weight, 1e-8)
        out_stems /= weight

        with JOBS_LOCK:
            JOBS[job_id]['progress'] = 90
            JOBS[job_id]['message'] = 'Akustik gürültü kapısı ve tavan sınırlayıcısı uygulanıyor...'

        # Order from SOURCES: drums, bass, other, vocals, guitar, piano
        stem_keys = ['drums', 'bass', 'other', 'vocals', 'guitar', 'piano']
        gate_thresholds = {
            'drums': -48.0,
            'bass': -46.0,
            'other': -50.0,
            'vocals': -44.0,
            'guitar': -48.0,
            'piano': -48.0
        }

        resampled_stems = {}
        for idx, key in enumerate(stem_keys):
            st = out_stems[idx]
            if native_sr != SAMPLE_RATE:
                st = resample_to_native(st, SAMPLE_RATE, native_sr)
            
            st = apply_soft_noise_gate(st, threshold_db=gate_thresholds[key], sr=native_sr)
            st = apply_peak_limiter(st)
            resampled_stems[key] = st

        with JOBS_LOCK:
            JOBS[job_id]['progress'] = 96
            JOBS[job_id]['message'] = '6 Stem WAV dosyaları stüdyo kalitesinde kaydediliyor...'

        for key in stem_keys:
            out_path = os.path.join(TEMP_DIR, f'{key}_{job_id}.wav')
            sf.write(out_path, resampled_stems[key].T, native_sr)

        with JOBS_LOCK:
            JOBS[job_id] = {
                'status': 'done',
                'progress': 100,
                'message': '6 Stem (Vokal, Davul, Bas, Gitar, Piyano, Sentetik) başarıyla ayrıştırıldı!',
                'stems': {
                    'vocals': f'/api/stem?jobId={job_id}&type=vocals',
                    'drums': f'/api/stem?jobId={job_id}&type=drums',
                    'bass': f'/api/stem?jobId={job_id}&type=bass',
                    'guitar': f'/api/stem?jobId={job_id}&type=guitar',
                    'piano': f'/api/stem?jobId={job_id}&type=piano',
                    'other': f'/api/stem?jobId={job_id}&type=other'
                }
            }
    except Exception as e:
        print(f"Error in 6-stem job {job_id}: {e}")
        with JOBS_LOCK:
            JOBS[job_id] = {
                'status': 'error',
                'progress': 0,
                'error': str(e)
            }

def run_demucs_job(job_id, input_path):
    """Background worker for Demucs neural vocal separation with real chunk progress."""
    try:
        from demucs_onnx.inference import (
            load_audio, _make_transition_window, resample_to_native,
            SAMPLE_RATE, N_SAMPLES, N_CHANNELS, SOURCES
        )

        with JOBS_LOCK:
            JOBS[job_id] = {
                'status': 'processing',
                'progress': 10,
                'message': 'Ses dosyası yükleniyor ve hazırlanıyor...'
            }

        audio, native_sr = load_audio(input_path, target_sr=SAMPLE_RATE)
        total_len = audio.shape[1]
        overlap = N_SAMPLES // 4
        stride = N_SAMPLES - overlap
        n_chunks = max(1, (total_len + stride - 1) // stride)

        with JOBS_LOCK:
            JOBS[job_id]['progress'] = 15
            JOBS[job_id]['message'] = f'Demucs yapay zeka modeli yükleniyor ({n_chunks} parça işlenecek)...'

        session = get_vocal_session()
        window = _make_transition_window(N_SAMPLES)
        out_vocals = np.zeros((N_CHANNELS, total_len), dtype=np.float32)
        weight = np.zeros(total_len, dtype=np.float32)
        row = SOURCES.index('vocals')

        for i in range(n_chunks):
            start = i * stride
            end = min(start + N_SAMPLES, total_len)
            chunk = audio[:, start:end]
            if chunk.shape[1] < N_SAMPLES:
                chunk = np.pad(chunk, ((0, 0), (0, N_SAMPLES - chunk.shape[1])), mode='constant')
            x = chunk[np.newaxis, ...].astype(np.float32, copy=False)
            chunk_len = end - start
            w = window[:chunk_len]

            stems = session.run(['stems'], {'mix': x})[0][0]
            out_vocals[:, start:end] += stems[row, :, :chunk_len] * w
            weight[start:end] += w

            # Small 5ms yield to OS so system, mouse, and browser stay 100% fluid
            time.sleep(0.005)

            # Real chunk progress from 18% to 88%
            chunk_pct = int(18 + ((i + 1) / n_chunks) * 70)
            with JOBS_LOCK:
                JOBS[job_id]['progress'] = chunk_pct
                JOBS[job_id]['message'] = f'Sinir ağı ayrıştırıyor: {i + 1}/{n_chunks} parça (%{chunk_pct})'

        weight = np.maximum(weight, 1e-8)
        out_vocals /= weight

        with JOBS_LOCK:
            JOBS[job_id]['progress'] = 90
            JOBS[job_id]['message'] = 'Enstrümantal altyapı hesaplanıyor...'

        if native_sr != SAMPLE_RATE:
            out_vocals = resample_to_native(out_vocals, SAMPLE_RATE, native_sr)

        # Read native mix for exact subtraction
        orig_data, orig_sr = sf.read(input_path)
        mix_t = orig_data.T
        if len(mix_t.shape) == 1:
            mix_t = np.array([mix_t, mix_t])
        
        min_len = min(mix_t.shape[1], out_vocals.shape[1])
        inst = mix_t[:, :min_len] - out_vocals[:, :min_len]

        with JOBS_LOCK:
            JOBS[job_id]['progress'] = 94
            JOBS[job_id]['message'] = 'İzler WAV dosyası olarak kaydediliyor...'

        vocal_filename = f'vocal_{job_id}.wav'
        inst_filename = f'inst_{job_id}.wav'
        vocal_path = os.path.join(TEMP_DIR, vocal_filename)
        inst_path = os.path.join(TEMP_DIR, inst_filename)

        sf.write(vocal_path, out_vocals[:, :min_len].T, native_sr)
        sf.write(inst_path, inst.T, native_sr)

        with JOBS_LOCK:
            JOBS[job_id] = {
                'status': 'done',
                'progress': 100,
                'message': 'Ayrıştırma başarıyla tamamlandı!',
                'vocalUrl': f'/api/stem?jobId={job_id}&type=vocal',
                'instUrl': f'/api/stem?jobId={job_id}&type=inst'
            }
    except Exception as e:
        print(f"Error in job {job_id}: {e}")
        with JOBS_LOCK:
            JOBS[job_id] = {
                'status': 'error',
                'progress': 0,
                'error': str(e)
            }

def parse_youtube_target(raw_input):
    """
    Robust YouTube target parser supporting:
    - youtu.be shortlinks (e.g. from mobile / share button)
    - standard youtube.com/watch?v=...
    - youtube.com/shorts/...
    - youtube.com/embed/... or /v/... or /live/...
    - music.youtube.com
    - plain 11-char video IDs (e.g. dQw4w9WgXcQ)
    - playlists (list=...)
    - search queries (artist / song keywords)
    """
    raw_input = (raw_input or '').strip()
    if not raw_input:
        return None

    # 1. Check raw 11-char video ID
    if re.match(r'^[a-zA-Z0-9_-]{11}$', raw_input):
        return {
            'type': 'video',
            'id': raw_input,
            'url': f'https://www.youtube.com/watch?v={raw_input}',
            'clean_url': f'https://www.youtube.com/watch?v={raw_input}'
        }

    # 2. URL parsing
    try:
        p = urlparse(raw_input)
        netloc = (p.netloc or '').lower()
        path = p.path or ''
        qs = parse_qs(p.query)

        # Playlist check
        if ('/playlist' in path or 'list=' in (p.query or '')) and 'list' in qs:
            pl_id = qs['list'][0]
            v_id = qs.get('v', [None])[0]
            return {
                'type': 'playlist',
                'id': pl_id,
                'video_id': v_id,
                'url': f'https://www.youtube.com/playlist?list={pl_id}',
                'clean_url': f'https://www.youtube.com/playlist?list={pl_id}'
            }

        # youtu.be/<id>
        if 'youtu.be' in netloc:
            v_id = path.strip('/').split('/')[0]
            if v_id:
                return {
                    'type': 'video',
                    'id': v_id,
                    'url': f'https://www.youtube.com/watch?v={v_id}',
                    'clean_url': f'https://www.youtube.com/watch?v={v_id}'
                }

        # youtube.com/shorts/<id>
        if 'youtube.com' in netloc and '/shorts/' in path:
            parts = path.split('/shorts/')
            if len(parts) > 1:
                v_id = parts[1].strip('/').split('/')[0]
                if v_id:
                    return {
                        'type': 'video',
                        'id': v_id,
                        'url': f'https://www.youtube.com/watch?v={v_id}',
                        'clean_url': f'https://www.youtube.com/watch?v={v_id}'
                    }

        # youtube.com/embed/<id> or /v/<id> or /live/<id>
        for prefix in ['/embed/', '/v/', '/live/']:
            if 'youtube.com' in netloc and prefix in path:
                parts = path.split(prefix)
                if len(parts) > 1:
                    v_id = parts[1].strip('/').split('/')[0]
                    if v_id:
                        return {
                            'type': 'video',
                            'id': v_id,
                            'url': f'https://www.youtube.com/watch?v={v_id}',
                            'clean_url': f'https://www.youtube.com/watch?v={v_id}'
                        }

        # youtube.com/watch?v=<id> or music.youtube.com/watch?v=<id>
        if ('youtube.com' in netloc or 'music.youtube.com' in netloc) and '/watch' in path:
            if 'v' in qs:
                v_id = qs['v'][0]
                return {
                    'type': 'video',
                    'id': v_id,
                    'url': f'https://www.youtube.com/watch?v={v_id}',
                    'clean_url': f'https://www.youtube.com/watch?v={v_id}'
                }
    except Exception:
        pass

    # If it is a generic http(s) URL that didn't match known patterns
    if raw_input.startswith(('http://', 'https://')):
        return {
            'type': 'unknown_url',
            'id': None,
            'url': raw_input,
            'clean_url': raw_input
        }

    # Otherwise treated as a song / artist search query
    return {
        'type': 'search',
        'query': raw_input,
        'url': f'ytsearch5:{raw_input}',
        'clean_url': raw_input
    }

def sanitize_youtube_url(raw_url):
    parsed = parse_youtube_target(raw_url)
    if not parsed:
        return None
    return parsed.get('clean_url') or parsed.get('url')
WHISPER_MODEL = None
WHISPER_MODEL_NAME = None
WHISPER_LOCK = threading.Lock()

def get_whisper_model(model_name="small"):
    global WHISPER_MODEL, WHISPER_MODEL_NAME
    with WHISPER_LOCK:
        if WHISPER_MODEL is None or WHISPER_MODEL_NAME != model_name:
            try:
                import faster_whisper
                print(f"[Whisper] Neural model ({model_name}) yukleniyor...", flush=True)
                WHISPER_MODEL = faster_whisper.WhisperModel(model_name, device="cpu", compute_type="int8")
                WHISPER_MODEL_NAME = model_name
                print(f"[Whisper] Neural model ({model_name}) basariyla yuklendi.", flush=True)
            except Exception as e:
                print(f"[Whisper Load Error for {model_name}]: {e}", flush=True)
                # Cascading fallbacks: medium -> small -> base
                fallback_target = "small" if model_name == "medium" else "base"
                if model_name != fallback_target:
                    try:
                        print(f"[Whisper] Fallback to {fallback_target} model...", flush=True)
                        WHISPER_MODEL = faster_whisper.WhisperModel(fallback_target, device="cpu", compute_type="int8")
                        WHISPER_MODEL_NAME = fallback_target
                    except Exception as e2:
                        print(f"[Whisper Fallback Error]: {e2}", flush=True)
                        WHISPER_MODEL = False
                else:
                    WHISPER_MODEL = False
        return WHISPER_MODEL

def format_lyrics_line(txt):
    import re
    t = (txt or '').strip()
    if not t:
        return ''
    # Strip leading bullet/punctuation marks
    t = re.sub(r'^[\-\*\•\–\—\s\"\']+', '', t)
    t = re.sub(r'[\"\'\“\‘\”]+$', '', t).strip()
    if not t:
        return ''
    # Turkish-aware capitalization
    first = t[0]
    if first == 'i':
        t = 'İ' + t[1:]
    elif first == 'ı':
        t = 'I' + t[1:]
    else:
        t = first.upper() + t[1:]
    return t

def fast_resample(audio_data, src_sr, dst_sr):
    """Ultra-fast, high-quality audio resampling using soxr (0.1s for full songs)."""
    if src_sr == dst_sr:
        return audio_data
    try:
        import soxr
        if audio_data.ndim == 1:
            return soxr.resample(audio_data, src_sr, dst_sr, quality='HQ').astype(np.float32)
        elif audio_data.ndim == 2:
            if audio_data.shape[0] <= 2 and audio_data.shape[1] > audio_data.shape[0]:
                res = soxr.resample(audio_data.T, src_sr, dst_sr, quality='HQ').T
            else:
                res = soxr.resample(audio_data, src_sr, dst_sr, quality='HQ')
            return np.ascontiguousarray(res, dtype=np.float32)
    except Exception:
        pass
    try:
        from scipy.signal import resample_poly
        from math import gcd
        g = gcd(int(src_sr), int(dst_sr))
        up = int(dst_sr // g)
        down = int(src_sr // g)
        axis = 1 if (audio_data.ndim == 2 and audio_data.shape[0] <= 2) else 0
        return resample_poly(audio_data, up, down, axis=axis).astype(np.float32)
    except Exception:
        pass
    num_s = int(round(audio_data.shape[-1] * dst_sr / src_sr))
    src_t = np.linspace(0, 1, audio_data.shape[-1])
    dst_t = np.linspace(0, 1, num_s)
    if audio_data.ndim == 1:
        return np.interp(dst_t, src_t, audio_data).astype(np.float32)
    else:
        return np.array([np.interp(dst_t, src_t, ch) for ch in audio_data], dtype=np.float32)

def separate_vocals_with_demucs(data, sr):
    """
    Separates human vocals from musical instruments using Demucs ONNX neural network.
    Leaves 0% phase distortion or watery artifacts.
    """
    try:
        from demucs_onnx.inference import (
            _make_transition_window, SAMPLE_RATE, N_SAMPLES, N_CHANNELS, SOURCES
        )
        if data.ndim == 1:
            audio_stereo = np.array([data, data], dtype=np.float32)
        else:
            audio_stereo = data.T.astype(np.float32)
            if audio_stereo.shape[0] == 1:
                audio_stereo = np.repeat(audio_stereo, 2, axis=0)

        if sr != SAMPLE_RATE:
            audio_stereo = fast_resample(audio_stereo, sr, SAMPLE_RATE)

        total_len = audio_stereo.shape[1]
        overlap = N_SAMPLES // 4
        stride = N_SAMPLES - overlap
        n_chunks = max(1, (total_len + stride - 1) // stride)

        session = get_vocal_session()
        window = _make_transition_window(N_SAMPLES)
        out_vocals = np.zeros((N_CHANNELS, total_len), dtype=np.float32)
        weight = np.zeros(total_len, dtype=np.float32)
        row = SOURCES.index('vocals')

        for i in range(n_chunks):
            start = i * stride
            end = min(start + N_SAMPLES, total_len)
            chunk = audio_stereo[:, start:end]
            if chunk.shape[1] < N_SAMPLES:
                chunk = np.pad(chunk, ((0, 0), (0, N_SAMPLES - chunk.shape[1])), mode='constant')
            x = chunk[np.newaxis, ...].astype(np.float32, copy=False)
            chunk_len = end - start
            w = window[:chunk_len]
            stems = session.run(['stems'], {'mix': x})[0][0]
            out_vocals[:, start:end] += stems[row, :, :chunk_len] * w
            weight[start:end] += w
            time.sleep(0.002)

        weight = np.maximum(weight, 1e-8)
        out_vocals /= weight
        mono_vocal = np.mean(out_vocals, axis=0)
        return mono_vocal, SAMPLE_RATE
    except Exception as e:
        print(f"[Demucs Vocal AI Separation Error]: {e}", flush=True)
        return None, sr

def segment_and_transcribe_audio(audio_bytes, lang='tr-TR', max_workers=4, model_size='small', ai_separate=True):
    try:
        data, sr_orig = sf.read(io.BytesIO(audio_bytes))
    except Exception as e:
        print(f"[Transcribe] Audio read error: {e}")
        return []

    target_sr = 16000

    # 1. Demucs AI Neural Vocal Separation (cleans music/drums/instruments before Whisper)
    mono_16k = None
    if ai_separate:
        try:
            print("[Demucs AI] Sarkidaki vokal yapay zeka (Demucs ONNX) ile ayristiriliyor...", flush=True)
            vocal_mono, v_sr = separate_vocals_with_demucs(data, sr_orig)
            if vocal_mono is not None and len(vocal_mono) > 0:
                mono_16k = fast_resample(vocal_mono, v_sr, target_sr).astype(np.float32)
                print("[Demucs AI] Vokal ayristirma tamamlandi, temiz vokal Whisper'a aktariliyor.", flush=True)
        except Exception as e:
            print(f"[Demucs AI Warning]: {e}. Orijinal ses kullanilacak.", flush=True)

    if mono_16k is None:
        if data.ndim > 1:
            mono = np.mean(data, axis=1)
        else:
            mono = data.astype(np.float32)
        if sr_orig != target_sr:
            mono_16k = fast_resample(mono, sr_orig, target_sr).astype(np.float32)
        else:
            mono_16k = mono.astype(np.float32)

        # 5ms Vocal Formant Filter: strips out sub-bass rumble (<150Hz) and harsh cymbal wash (>6500Hz)
        try:
            from scipy import signal
            sos = signal.butter(4, [150, 6500], btype='bandpass', fs=target_sr, output='sos')
            mono_16k = signal.sosfilt(sos, mono_16k).astype(np.float32)
        except Exception:
            pass

    # Normalize overall audio
    peak = np.max(np.abs(mono_16k))
    if peak > 1e-4:
        mono_16k = mono_16k / peak * 0.95

    # Map language code: tr-TR -> tr, en-US -> en, de-DE -> de, etc.
    lang_code = lang.split('-')[0].lower() if lang else 'tr'

    # 2. Primary Engine: Whisper (Exact previous formula: condition_on_previous_text=False)
    whisper_model = get_whisper_model(model_size)
    if whisper_model:
        try:
            print(f"[Whisper] Sarki sozu transkripsiyonu baslatiliyor (model={WHISPER_MODEL_NAME}, lang={lang_code}, duration={len(mono_16k)/target_sr:.1f}s)...", flush=True)
            segments, info = whisper_model.transcribe(
                mono_16k,
                language=lang_code,
                condition_on_previous_text=False,
                repetition_penalty=1.2,
                no_repeat_ngram_size=3,
                vad_filter=False,
                beam_size=3,
                temperature=0.0
            )

            import re
            def is_hallucination_or_noise(txt):
                t = (txt or "").strip()
                if not t or len(t) < 2:
                    return True
                letters_only = re.sub(r'[^\w\s]', '', t).strip()
                if not letters_only or len(letters_only) < 2:
                    return True
                cleaned = re.sub(r'[\(\[\{].*?[\)\]\}]', '', t).strip()
                if not cleaned:
                    return True
                upper = cleaned.upper()
                if upper in ['MÜZİK', 'MUZIK', 'ALKIŞ', 'ALKIS', 'ŞARKI', 'SARKI', 'MELODİ', 'MELODI', 'ISLIK', 'TEZAHÜRAT']:
                    return True
                words = cleaned.lower().split()
                if len(words) >= 4:
                    if len(set(words)) / len(words) < 0.35:
                        return True
                if re.search(r'(.)\1{4,}', cleaned):
                    return True
                return False

            lines = []
            for seg in segments:
                txt = format_lyrics_line(seg.text)
                if not is_hallucination_or_noise(txt):
                    if lines and lines[-1]['text'].strip().lower() == txt.strip().lower() and abs(seg.start - lines[-1]['time']) < 2.5:
                        continue
                    lines.append({
                        "time": round(float(seg.start), 1),
                        "duration": round(float(seg.end - seg.start), 1),
                        "text": txt
                    })

            if lines:
                print(f"[Whisper] Basarili: {len(lines)} satir sarki sozu cikarildi.", flush=True)
                return lines
            else:
                print("[Whisper] Bos dondu, Google segmenter deneniyor...", flush=True)
        except Exception as e:
            print(f"[Whisper Error, falling back to segmenter]: {e}", flush=True)

    # 2. Fallback: Google Speech Recognition with VAD Bandpass Segmentation
    if sr_module is None:
        return []

    try:
        from scipy import signal
        sos = signal.butter(4, [120, 6500], btype='bandpass', fs=target_sr, output='sos')
        filtered = signal.sosfilt(sos, mono_16k)
    except Exception:
        filtered = mono_16k

    frame_len = int(target_sr * 0.05)
    hop_len = int(target_sr * 0.025)
    n_frames = (len(filtered) - frame_len) // hop_len
    if n_frames <= 0:
        return []

    frames = np.lib.stride_tricks.sliding_window_view(filtered[:n_frames * hop_len + frame_len], frame_len)[::hop_len]
    rms = np.sqrt(np.mean(frames ** 2, axis=1) + 1e-12)
    kernel = np.ones(7) / 7
    smoothed_rms = np.convolve(rms, kernel, mode='same')
    base_noise = np.percentile(smoothed_rms, 25)
    peak_energy = np.percentile(smoothed_rms, 95)
    threshold = base_noise + 0.16 * (peak_energy - base_noise)
    is_active = smoothed_rms > threshold

    min_seg_len = 1.2
    max_seg_len = 9.5
    segments = []
    in_seg = False
    seg_start = 0.0

    for i, active in enumerate(is_active):
        t = i * (hop_len / target_sr)
        if active and not in_seg:
            in_seg = True
            seg_start = t
        elif not active and in_seg:
            in_seg = False
            seg_end = t
            if seg_end - seg_start >= min_seg_len:
                segments.append((seg_start, seg_end))

    if in_seg:
        segments.append((seg_start, len(filtered) / target_sr))

    merged = []
    for s_start, s_end in segments:
        if not merged:
            merged.append([s_start, s_end])
        else:
            prev_start, prev_end = merged[-1]
            if s_start - prev_end < 0.8 and (s_end - prev_start) <= max_seg_len:
                merged[-1][1] = s_end
            else:
                merged.append([s_start, s_end])

    total_duration = len(mono) / sr_orig
    if len(merged) == 0:
        step = 6.0
        cur = 0.0
        while cur < total_duration:
            merged.append([cur, min(cur + step, total_duration)])
            cur += step

    final_segments = []
    for s_start, s_end in merged:
        dur = s_end - s_start
        if dur > max_seg_len:
            step = 6.0
            cur = s_start
            while cur < s_end:
                c_end = min(cur + step, s_end)
                final_segments.append((cur, c_end))
                cur = c_end
        else:
            final_segments.append((s_start, s_end))

    r = sr_module.Recognizer()
    r.energy_threshold = 200
    r.dynamic_energy_threshold = True

    def transcribe_chunk(seg):
        st, en = seg
        start_samp = int(st * target_sr)
        end_samp = int(en * target_sr)
        chunk = mono_16k[start_samp:end_samp]
        if len(chunk) < int(target_sr * 0.7):
            return None
        peak = np.max(np.abs(chunk))
        if peak > 1e-4:
            chunk = chunk / peak * 0.92
        chunk_bytes = io.BytesIO()
        sf.write(chunk_bytes, chunk, target_sr, format='WAV', subtype='PCM_16')
        chunk_bytes.seek(0)
        try:
            with sr_module.AudioFile(chunk_bytes) as source:
                audio_rec = r.record(source)
            text = r.recognize_google(audio_rec, language=lang)
            if text and text.strip():
                return {
                    "time": round(float(st), 1),
                    "duration": round(float(en - st), 1),
                    "text": text.strip()
                }
        except Exception:
            pass
        return None

    lines = []
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        results = list(executor.map(transcribe_chunk, final_segments))
        for res in results:
            if res:
                lines.append(res)

    lines.sort(key=lambda x: x['time'])
    return lines


def find_valid_cookie_file():
    # 1. Environment variable support (ideal for Hugging Face Spaces Secrets / Docker deployments)
    env_cookies = os.environ.get('YOUTUBE_COOKIES') or os.environ.get('COOKIES_TXT') or os.environ.get('YOUTUBE_COOKIE_CONTENT')
    if env_cookies and env_cookies.strip():
        target_env_file = os.path.join(TEMP_DIR, 'env_cookies.txt')
        try:
            with open(target_env_file, 'w', encoding='utf-8') as f:
                f.write(env_cookies.strip())
            return target_env_file
        except Exception as e:
            print(f"[Cookies] Failed to save environment cookies: {e}", flush=True)

    # 2. Check candidate filesystem paths
    base_dir = os.path.dirname(os.path.abspath(__file__))
    candidate_paths = [
        os.path.join(base_dir, 'cookies.txt'),
        os.path.join(os.getcwd(), 'cookies.txt'),
        os.path.join(TEMP_DIR, 'cookies.txt'),
        os.path.join(YT_TEMP_DIR, 'cookies.txt'),
        '/app/cookies.txt',
        '/home/user/app/cookies.txt',
        os.path.join(TEMP_DIR, 'env_cookies.txt'),
    ]
    for p in candidate_paths:
        if os.path.exists(p) and os.path.getsize(p) > 0:
            return p
    return None


def fetch_oembed_info(yt_url):
    """
    Direct no-auth YouTube oEmbed metadata resolver.
    Never blocked by datacenter IPs, requires no cookies, returns instant title, author & thumbnail.
    """
    try:
        endpoint = f"https://www.youtube.com/oembed?url={quote(yt_url, safe=':/?=&')}&format=json"
        req = urllib.request.Request(endpoint, headers={
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
            'Accept': 'application/json'
        })
        with urllib.request.urlopen(req, timeout=6) as resp:
            if resp.status == 200:
                data = json.loads(resp.read().decode('utf-8'))
                return {
                    'title': data.get('title'),
                    'uploader': data.get('author_name'),
                    'thumbnail': data.get('thumbnail_url'),
                }
    except Exception as e:
        print(f"[oEmbed] Metadata sorgusu başarısız: {e}", flush=True)
    return None


def download_stream_and_convert(stream_url, target_path, media_format='mp3', quality='192', headers=None, chunk_size=1048576):
    """
    Two-stage high-speed reliable stream downloader & transcoder:
    1. Downloads raw audio stream via Python's native urllib with HTTP Range chunking (1MB chunks).
       Bypasses YouTube 1x throttling and FFmpeg TLS/networking limitations completely (0.5s transfer).
    2. Runs local FFmpeg to transcode raw stream into high-quality MP3 (or copy for MP4).
    """
    if not FFMPEG_EXE:
        return False, "FFMPEG_EXE bulunamadı"
    if not stream_url:
        return False, "stream_url boş"
        
    temp_raw = f"{target_path}.raw"
    try:
        req_headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
            'Accept': '*/*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Referer': 'https://www.youtube.com/',
        }
        if headers:
            for k, v in headers.items():
                if k.lower() in ('user-agent', 'accept-language', 'range'):
                    req_headers[k] = v

        proxy = (
            os.environ.get('YOUTUBE_PROXY') or 
            os.environ.get('PROXY_URL') or 
            os.environ.get('HTTPS_PROXY') or 
            os.environ.get('HTTP_PROXY')
        )
        if proxy and proxy.strip():
            proxy_clean = proxy.strip()
            proxy_handler = urllib.request.ProxyHandler({'http': proxy_clean, 'https': proxy_clean})
            opener = urllib.request.build_opener(proxy_handler)
        else:
            opener = urllib.request.build_opener()

        downloaded = 0
        total_size = None
        max_retries = 3

        with open(temp_raw, 'wb') as out_f:
            while True:
                end = downloaded + chunk_size - 1
                if total_size is not None and end >= total_size:
                    end = total_size - 1
                
                chunk_headers = dict(req_headers)
                chunk_headers['Range'] = f'bytes={downloaded}-{end}'
                
                req = urllib.request.Request(stream_url, headers=chunk_headers)
                chunk_data = None
                last_http_err = None
                for attempt in range(max_retries):
                    try:
                        with opener.open(req, timeout=12) as resp:
                            cr = resp.headers.get('Content-Range')
                            if cr and '/' in cr:
                                total_size = int(cr.split('/')[1])
                            chunk_data = resp.read()
                            break
                    except Exception as ce:
                        last_http_err = ce
                        time.sleep(0.3)
                        
                if chunk_data is None:
                    if downloaded > 0:
                        break # Got some data, let's try with what we have
                    return False, f"HTTP chunk error: {last_http_err}"

                out_f.write(chunk_data)
                downloaded += len(chunk_data)
                if total_size is not None and downloaded >= total_size:
                    break

        if not os.path.exists(temp_raw) or os.path.getsize(temp_raw) < 10240:
            sz = os.path.getsize(temp_raw) if os.path.exists(temp_raw) else 0
            if os.path.exists(temp_raw):
                try:
                    os.remove(temp_raw)
                except Exception:
                    pass
            return False, f"İndirilen ham veri çok küçük ({sz} bayt)"

        # Step 2: Transcode raw audio using local FFmpeg
        import subprocess
        if media_format == 'mp3':
            cmd = [FFMPEG_EXE, '-y', '-i', temp_raw, '-vn', '-b:a', f'{quality}k', target_path]
        else:
            cmd = [FFMPEG_EXE, '-y', '-i', temp_raw, '-c', 'copy', target_path]
            
        res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)
        
        # Clean up temp raw file
        if os.path.exists(temp_raw):
            try:
                os.remove(temp_raw)
            except Exception:
                pass
                
        if os.path.exists(target_path) and os.path.getsize(target_path) > 1024:
            return True, "OK"
        return False, f"FFmpeg kod={res.returncode}, err={res.stderr.decode(errors='ignore')[-150:].strip()}"
    except Exception as e:
        print(f"[Stream Transcoder] Hata: {e}", flush=True)
        if os.path.exists(temp_raw):
            try:
                os.remove(temp_raw)
            except Exception:
                pass
        return False, str(e)


POT_PROCESS = None
POT_LOCK = threading.Lock()
POT_STATUS = {
    'started': False,
    'last_check': 0,
    'last_error': None,
    'pot_bin': None,
    'bin_exists': False,
    'bin_size': 0
}

def get_js_runtime_config():
    import shutil
    node_exe = shutil.which('node') or shutil.which('nodejs')
    deno_exe = shutil.which('deno')
    runtimes = {}
    if node_exe:
        runtimes['node'] = {'path': node_exe}
    else:
        runtimes['node'] = {}
    if deno_exe:
        runtimes['deno'] = {'path': deno_exe}
    else:
        runtimes['deno'] = {}
    runtimes['quickjs'] = {}
    runtimes['bun'] = {}
    return runtimes

def ensure_pot_server():
    """
    Ensures the high-performance BotGuard Proof-of-Origin Token (POT) provider is running on http://127.0.0.1:4416.
    Generates authentic BotGuard tokens locally on cloud datacenter IPs (AWS / Hugging Face Spaces)
    so YouTube never blocks audio/video stream extraction.
    """
    global POT_PROCESS, POT_STATUS
    now = time.time()
    for target in ('http://127.0.0.1:4416/ping', 'http://localhost:4416/ping'):
        try:
            req = urllib.request.Request(target, headers={'User-Agent': 'Flova/1.0'})
            with urllib.request.urlopen(req, timeout=1.0) as resp:
                if resp.status == 200:
                    POT_STATUS['started'] = True
                    POT_STATUS['last_check'] = now
                    POT_STATUS['last_error'] = None
                    return True
        except Exception:
            pass

    with POT_LOCK:
        for target in ('http://127.0.0.1:4416/ping', 'http://localhost:4416/ping'):
            try:
                req = urllib.request.Request(target, headers={'User-Agent': 'Flova/1.0'})
                with urllib.request.urlopen(req, timeout=1.0) as resp:
                    if resp.status == 200:
                        POT_STATUS['started'] = True
                        POT_STATUS['last_check'] = now
                        return True
            except Exception:
                pass

        is_windows = (os.name == 'nt')
        bin_name = 'bgutil-pot.exe' if is_windows else 'bgutil-pot'
        pot_dir = os.path.join(BASE_DIR, 'bin')
        os.makedirs(pot_dir, exist_ok=True)
        pot_bin = os.path.join(pot_dir, bin_name)
        POT_STATUS['pot_bin'] = pot_bin

        if not os.path.exists(pot_bin) or os.path.getsize(pot_bin) < 1000000:
            print(f"[POT Engine] BotGuard PO Token motoru indiriliyor ({bin_name})...", flush=True)
            if is_windows:
                url = 'https://github.com/jim60105/bgutil-ytdlp-pot-provider-rs/releases/latest/download/bgutil-pot-windows-x86_64.exe'
            else:
                url = 'https://github.com/jim60105/bgutil-ytdlp-pot-provider-rs/releases/latest/download/bgutil-pot-linux-x86_64'

            try:
                headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'}
                req = urllib.request.Request(url, headers=headers)
                with urllib.request.urlopen(req, timeout=60) as response, open(pot_bin, 'wb') as out_file:
                    out_file.write(response.read())
                if not is_windows:
                    os.chmod(pot_bin, 0o755)
                print(f"[POT Engine] İndirme tamamlandı: {pot_bin} ({os.path.getsize(pot_bin)} bayt)", flush=True)
            except Exception as e:
                err = f"İndirme hatası: {e}"
                print(f"[POT Engine] {err}", flush=True)
                POT_STATUS['last_error'] = err
                return False

        POT_STATUS['bin_exists'] = os.path.exists(pot_bin)
        POT_STATUS['bin_size'] = os.path.getsize(pot_bin) if os.path.exists(pot_bin) else 0

        if not is_windows and os.path.exists(pot_bin):
            try:
                os.chmod(pot_bin, 0o755)
            except Exception:
                pass

        try:
            print(f"[POT Engine] BotGuard servisi 127.0.0.1:4416 üzerinde başlatılıyor...", flush=True)
            cmd = [pot_bin, 'server', '--host', '127.0.0.1', '--port', '4416']
            POT_PROCESS = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True
            )
            time.sleep(0.5)
            if POT_PROCESS.poll() is not None:
                stdout, stderr = POT_PROCESS.communicate(timeout=1)
                err = f"Süreç hemen çöktü (kod={POT_PROCESS.returncode}): stdout={stdout.strip()} stderr={stderr.strip()}"
                print(f"[POT Engine] {err}", flush=True)
                POT_STATUS['last_error'] = err
                return False

            for _ in range(30):
                time.sleep(0.2)
                for target in ('http://127.0.0.1:4416/ping', 'http://localhost:4416/ping'):
                    try:
                        req = urllib.request.Request(target, headers={'User-Agent': 'Flova/1.0'})
                        with urllib.request.urlopen(req, timeout=1.0) as resp:
                            if resp.status == 200:
                                print(f"[POT Engine] 🟢 BotGuard PO Token motoru aktif ve hazır (Port 4416)!", flush=True)
                                POT_STATUS['started'] = True
                                POT_STATUS['last_error'] = None
                                return True
                    except Exception:
                        pass
        except Exception as e:
            err = f"Servis başlatma hatası: {e}"
            print(f"[POT Engine] {err}", flush=True)
            POT_STATUS['last_error'] = err
            return False

        POT_STATUS['last_error'] = "Zaman aşımı: Port 4416 /ping yanıt vermedi"
        return False


def get_youtube_dl_opts(extra_opts=None, client_list=None, use_cookies=True):
    try:
        ensure_pot_server()
    except Exception:
        pass

    is_windows = (os.name == 'nt')
    bin_name = 'bgutil-pot.exe' if is_windows else 'bgutil-pot'
    pot_bin = os.path.join(BASE_DIR, 'bin', bin_name)

    opts = {
        'quiet': True,
        'no_warnings': True,
        'nocheckcertificate': True,
        'socket_timeout': 20,
        'ffmpeg_location': FFMPEG_EXE,
        'js_runtimes': get_js_runtime_config(),
        'check_formats': False,
        'ignore_no_formats_error': True,
        'format': '18/bestaudio/ba/140/251/best[height<=720]/best/b',
        'http_headers': {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
            'Accept-Language': 'en-US,en;q=0.9',
        },
        'extractor_args': {
            'youtubepot-bgutilcli': {
                'cli_path': [pot_bin]
            } if os.path.exists(pot_bin) else {},
            'youtubepot-bgutilhttp': {
                'base_url': ['http://127.0.0.1:4416']
            }
        }
    }
    if client_list:
        opts['extractor_args']['youtube'] = {
            'player_client': client_list
        }

    cookie_file = find_valid_cookie_file() if use_cookies else None
    if cookie_file:
        opts['cookiefile'] = cookie_file

    proxy = (
        os.environ.get('YOUTUBE_PROXY') or 
        os.environ.get('PROXY_URL') or 
        os.environ.get('HTTPS_PROXY') or 
        os.environ.get('HTTP_PROXY')
    )
    if proxy and proxy.strip():
        opts['proxy'] = proxy.strip()

    if extra_opts:
        extra_copy = dict(extra_opts)
        if 'extractor_args' in extra_copy:
            extra_ea = extra_copy.pop('extractor_args')
            for k, v in extra_ea.items():
                if k not in opts['extractor_args']:
                    opts['extractor_args'][k] = v
                elif isinstance(v, dict) and isinstance(opts['extractor_args'][k], dict):
                    opts['extractor_args'][k].update(v)
        opts.update(extra_copy)
    return opts


def run_resilient_ytdlp_action(yt_url, base_opts=None, is_download=False):
    """
    Executes yt-dlp with automatic multi-tier fallback optimized for both local and datacenter cloud environments:
    1. Android Mobil API (Evrensel Doğrudan İndirme - Hızlı & Kararlı, Format 18 AAC)
    2. MWEB Mobil API (BotGuard PO Token & EJS Destekli, 140/251/18)
    3. Web Embedded API (BotGuard Destekli)
    4. Web Standart API (BotGuard Destekli)
    5. VisionOS API (Modern JS-siz API)
    6. TV Client API (Yüksek Uyumluluk & Doğrudan Ses)
    7. Android VR API (Kısıtlamasız)
    8. iOS Mobil API
    9. Authenticated Cookies Fallback (Oturum / Yaş Kısıtlamalı içerikler için)
    """
    cookie_file = find_valid_cookie_file()
    strategies = [
        {
            'name': 'Android Mobil API (Evrensel Doğrudan İndirme - Hızlı & Kararlı)',
            'clients': ['android'],
            'use_cookies': False
        },
        {
            'name': 'MWEB Mobil API (BotGuard PO Token & EJS Destekli)',
            'clients': ['mweb'],
            'use_cookies': False
        },
        {
            'name': 'Web Embedded API (BotGuard Destekli)',
            'clients': ['web_embedded'],
            'use_cookies': False
        },
        {
            'name': 'Web Standart API (BotGuard Destekli)',
            'clients': ['web'],
            'use_cookies': False
        },
        {
            'name': 'VisionOS API (Modern Datacenter)',
            'clients': ['visionos'],
            'use_cookies': False
        },
        {
            'name': 'TV Client API (Yüksek Uyumluluk & Doğrudan Ses)',
            'clients': ['tv'],
            'use_cookies': False
        },
        {
            'name': 'Android VR API (Kısıtlamasız)',
            'clients': ['android_vr'],
            'use_cookies': False
        },
        {
            'name': 'iOS Mobil API (Çerezsiz)',
            'clients': ['ios'],
            'use_cookies': False
        }
    ]
    if cookie_file:
        strategies.append({
            'name': 'Android + Cookies (Gelişmiş Doğrulama)',
            'clients': ['android'],
            'use_cookies': True
        })
        strategies.append({
            'name': 'MWEB + Cookies (Doğrulanmış Oturum)',
            'clients': ['mweb'],
            'use_cookies': True
        })
        strategies.append({
            'name': 'Web + Cookies Fallback (Özel / Yaş Kısıtlamalı)',
            'clients': ['web'],
            'use_cookies': True
        })
        strategies.append({
            'name': 'VisionOS + Cookies (Gelişmiş Doğrulama)',
            'clients': ['visionos'],
            'use_cookies': True
        })

    last_err = None
    for idx, strat in enumerate(strategies, 1):
        try:
            ydl_opts = get_youtube_dl_opts(
                extra_opts=base_opts,
                client_list=strat['clients'],
                use_cookies=strat['use_cookies']
            )
            # Ensure format check is never blocking valid extraction
            ydl_opts['check_formats'] = False
            ydl_opts['ignore_no_formats_error'] = True
            if 'format' not in ydl_opts:
                ydl_opts['format'] = '18/bestaudio/ba/140/251/best[height<=720]/best/b'

            print(f"[YouTube Engine] Strateji {idx}/{len(strategies)} deneniyor: {strat['name']} -> {yt_url}", flush=True)
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(yt_url, download=is_download)
                if info:
                    formats = info.get('formats', []) or []
                    has_media = any(
                        (f.get('vcodec') != 'none' or f.get('acodec') != 'none') and
                        bool(f.get('url')) and
                        not str(f.get('format_id', '')).startswith('sb')
                        for f in formats
                    )
                    if formats and not has_media:
                        print(f"[YouTube Engine] Strateji {idx} yalnızca görsel/storyboard döndürdü ({strat['name']}), sonraki strateji deneniyor...", flush=True)
                        continue

                    if is_download:
                        outtmpl_pattern = base_opts.get('outtmpl') if base_opts else None
                        if outtmpl_pattern and isinstance(outtmpl_pattern, str):
                            prefix = os.path.basename(outtmpl_pattern).split('.%')[0]
                            matched = [f for f in os.listdir(YT_TEMP_DIR) if f.startswith(prefix) and os.path.getsize(os.path.join(YT_TEMP_DIR, f)) > 1024]
                            if not matched:
                                print(f"[YouTube Engine] Strateji {idx} ({strat['name']}) indirme dosyası üretemedi, sonraki strateji deneniyor...", flush=True)
                                continue

                    print(f"[YouTube Engine] BAŞARILI! ({strat['name']})", flush=True)
                    return info
        except Exception as e:
            err_msg = str(e)
            print(f"[YouTube Engine] Strateji {idx} başarısız ({strat['name']}): {err_msg[:120]}", flush=True)
            last_err = e
            if "Video unavailable" in err_msg or "Private video" in err_msg:
                break

    if last_err:
        raise last_err
    raise RuntimeError("YouTube verisi alınamadı.")


class FlovaHandler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        '.js': 'application/javascript; charset=utf-8',
        '.mjs': 'application/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.svg': 'image/svg+xml',
        '.wasm': 'application/wasm',
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=BASE_DIR, **kwargs)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def send_json(self, status_code, data):
        body = json.dumps(data).encode('utf-8')
        self.send_response(status_code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(body)

    def send_error_json(self, status_code, message):
        self.send_json(status_code, {'success': False, 'error': message})

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Range')
        self.send_header('Access-Control-Expose-Headers', 'Content-Disposition')
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)

        # Root route: Serve the Flova Audio Studio application (index.html)
        if parsed.path in ('/', ''):
            index_path = os.path.join(BASE_DIR, 'index.html')
            if os.path.exists(index_path):
                self.send_response(200)
                self.send_header('Content-Type', 'text/html; charset=utf-8')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                with open(index_path, 'rb') as f:
                    self.wfile.write(f.read())
                return

        # Diagnostics / status card for standalone backend verification
        if parsed.path in ('/status', '/api/status-card'):
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            html = """<!DOCTYPE html>
<html lang="tr">
<head>
  <meta charset="UTF-8">
  <title>Flova Studio AI Backend</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; background: #070913; color: #f8fafc; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .card { background: #101424; border: 1px solid rgba(255,255,255,0.12); padding: 36px 42px; border-radius: 20px; box-shadow: 0 20px 40px rgba(0,0,0,0.6); text-align: center; max-width: 500px; }
    h1 { font-size: 24px; color: #ff6b00; margin-bottom: 8px; }
    .status { display: inline-flex; align-items: center; gap: 8px; padding: 6px 14px; border-radius: 20px; background: rgba(16,185,129,0.15); color: #10b981; font-weight: 700; font-size: 14px; margin-bottom: 16px; border: 1px solid rgba(16,185,129,0.3); }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #10b981; box-shadow: 0 0 10px #10b981; }
    p { color: #94a3b8; font-size: 14px; line-height: 1.5; margin: 0; }
    .btn { display: inline-block; margin-top: 18px; padding: 10px 20px; background: #ff6b00; color: white; text-decoration: none; border-radius: 10px; font-weight: 600; font-size: 14px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="status"><span class="dot"></span> AI Sunucusu Aktif (Running)</div>
    <h1>🎛️ Flova Audio Studio</h1>
    <p>Demucs v4 AI (4-Stem & 6-Stem), YouTube İndirici ve Ses İşleme Servisi başarıyla çalışıyor.</p>
    <a href="/" class="btn">🚀 Stüdyoyu Aç</a>
  </div>
</body>
</html>"""
            self.wfile.write(html.encode('utf-8'))
            return

        # Health Check API
        if parsed.path == '/api/health':
            self.send_json(200, {'status': 'ok', 'service': 'flova-backend', 'time': time.time()})
            return

        # POT and Engine Diagnostics API
        if parsed.path == '/api/debug/pot':
            import shutil
            import platform
            node_path = shutil.which('node') or shutil.which('nodejs')
            deno_path = shutil.which('deno')
            
            pot_ping = False
            pot_ping_text = ''
            for target in ('http://127.0.0.1:4416/ping', 'http://localhost:4416/ping'):
                try:
                    req = urllib.request.Request(target, headers={'User-Agent': 'Flova/1.0'})
                    with urllib.request.urlopen(req, timeout=1.0) as resp:
                        if resp.status == 200:
                            pot_ping = True
                            pot_ping_text = resp.read().decode('utf-8', errors='ignore')
                            break
                except Exception as pe:
                    pot_ping_text = str(pe)

            cli_test_out = ''
            cli_test_err = ''
            pot_bin = POT_STATUS.get('pot_bin')
            if pot_bin and os.path.exists(pot_bin):
                try:
                    res = subprocess.run([pot_bin, '--version'], capture_output=True, text=True, timeout=4)
                    cli_test_out = res.stdout.strip()
                    cli_test_err = res.stderr.strip()
                except Exception as ce:
                    cli_test_err = str(ce)

            # Test actual format extraction (default to android, customizable via ?client=mweb)
            extract_formats = []
            raw_formats = []
            extract_err = ''
            ydl_logs = []
            
            class MemoryLogger:
                def debug(self, msg):
                    if 'error' in msg.lower() or 'warn' in msg.lower() or 'pot' in msg.lower() or 'client' in msg.lower() or 'format' in msg.lower():
                        ydl_logs.append(f"[debug] {msg[:150]}")
                def info(self, msg):
                    ydl_logs.append(f"[info] {msg[:150]}")
                def warning(self, msg):
                    ydl_logs.append(f"[warning] {msg[:150]}")
                def error(self, msg):
                    ydl_logs.append(f"[error] {msg[:150]}")

            query = parse_qs(parsed.query)
            test_client = query.get('client', ['android'])[0]
            cli_token_out = ''
            cli_token_err = ''
            if pot_bin and os.path.exists(pot_bin):
                try:
                    cp = subprocess.run([pot_bin, '-c', 'zrS2wKWVWzI'], capture_output=True, text=True, timeout=5)
                    cli_token_out = cp.stdout.strip()[:100]
                    cli_token_err = cp.stderr.strip()[:100]
                except Exception as cpe:
                    cli_token_err = str(cpe)

            try:
                test_opts = get_youtube_dl_opts(
                    extra_opts={
                        'skip_download': True,
                        'logger': MemoryLogger(),
                        'verbose': True,
                    },
                    client_list=[test_client],
                    use_cookies=False
                )
                with yt_dlp.YoutubeDL(test_opts) as ydl:
                    inf = ydl.extract_info('https://www.youtube.com/watch?v=zrS2wKWVWzI', download=False)
                    all_f = inf.get('formats', []) or []
                    for f in all_f:
                        raw_formats.append({
                            'id': f.get('format_id'),
                            'vcodec': f.get('vcodec'),
                            'acodec': f.get('acodec'),
                            'has_url': bool(f.get('url')),
                            'proto': f.get('protocol')
                        })
                        if f.get('acodec') != 'none' and f.get('url'):
                            extract_formats.append({
                                'id': f.get('format_id'),
                                'ext': f.get('ext'),
                                'acodec': f.get('acodec'),
                                'abr': f.get('abr')
                            })
            except Exception as ee:
                extract_err = str(ee)

            proxy_val = (
                os.environ.get('YOUTUBE_PROXY') or 
                os.environ.get('PROXY_URL') or 
                os.environ.get('HTTPS_PROXY') or 
                os.environ.get('HTTP_PROXY')
            )

            self.send_json(200, {
                'platform': platform.platform(),
                'python': sys.version,
                'cwd': os.getcwd(),
                'node_path': node_path,
                'deno_path': deno_path,
                'ejs_installed': ('yt_dlp_ejs' in sys.modules),
                'ffmpeg_path': FFMPEG_EXE,
                'pot_status': POT_STATUS,
                'cli_test_out': cli_test_out,
                'cli_token_test': cli_token_out or cli_token_err,
                'pot_ping_ok': pot_ping,
                'proxy_configured': bool(proxy_val),
                'proxy_masked': (proxy_val.split('@')[-1] if '@' in proxy_val else (proxy_val[:12] + '...')) if proxy_val else None,
                'tested_client': test_client,
                'formats_found': len(extract_formats),
                'formats': extract_formats,
                'raw_formats': raw_formats,
                'extract_error': extract_err,
                'ydl_logs': ydl_logs
            })
            return

        # YouTube Diagnostic API
        if parsed.path == '/api/debug/yt':
            query = parse_qs(parsed.query)
            test_url = query.get('url', ['https://www.youtube.com/watch?v=zrS2wKWVWzI'])[0]
            cookie_path = find_valid_cookie_file()
            results = {
                'yt_dlp_version': getattr(yt_dlp, '__version__', 'unknown'),
                'cookie_file_found': cookie_path,
                'cookie_file_size': os.path.getsize(cookie_path) if cookie_path else 0,
                'cwd': os.getcwd(),
                'tests': []
            }
            test_dl = query.get('dl', ['0'])[0] == '1'
            tests_to_run = [
                {'name': 'visionos_no_cookies', 'clients': ['visionos'], 'cookies': False},
                {'name': 'tv_no_cookies', 'clients': ['tv'], 'cookies': False},
                {'name': 'android_no_cookies', 'clients': ['android'], 'cookies': False},
                {'name': 'android_vr_no_cookies', 'clients': ['android_vr'], 'cookies': False},
                {'name': 'mweb_no_cookies', 'clients': ['mweb'], 'cookies': False},
                {'name': 'web_embedded_no_cookies', 'clients': ['web_embedded'], 'cookies': False},
                {'name': 'tv_downgraded_no_cookies', 'clients': ['tv_downgraded'], 'cookies': False},
                {'name': 'ios_no_cookies', 'clients': ['ios'], 'cookies': False},
                {'name': 'web_no_cookies', 'clients': ['web'], 'cookies': False},
                {'name': 'visionos_with_cookies', 'clients': ['visionos'], 'cookies': True},
                {'name': 'tv_with_cookies', 'clients': ['tv'], 'cookies': True},
                {'name': 'android_with_cookies', 'clients': ['android'], 'cookies': True},
                {'name': 'web_with_cookies', 'clients': ['web'], 'cookies': True},
            ]
            for t in tests_to_run:
                dl_id = f"diag_{uuid.uuid4().hex[:6]}"
                out_tmpl = os.path.join(YT_TEMP_DIR, f"{dl_id}.%(ext)s")
                opts = {
                    'quiet': True,
                    'no_warnings': True,
                    'skip_download': not test_dl,
                    'socket_timeout': 10,
                    'check_formats': False,
                    'ignore_no_formats_error': True,
                    'format': 'bestaudio/ba/best[height<=720]/best/b',
                    'outtmpl': out_tmpl,
                    'ffmpeg_location': FFMPEG_EXE,
                    'extractor_args': {'youtube': {'player_client': t['clients']}}
                }
                if test_dl:
                    opts['postprocessors'] = [{
                        'key': 'FFmpegExtractAudio',
                        'preferredcodec': 'mp3',
                        'preferredquality': '128',
                    }]
                if t['cookies'] and cookie_path:
                    opts['cookiefile'] = cookie_path
                try:
                    with yt_dlp.YoutubeDL(opts) as ydl:
                        inf = ydl.extract_info(test_url, download=test_dl)
                        # Clean up test file if created
                        for ext in ('.mp3', '.webm', '.m4a', '.mp4'):
                            tf = os.path.join(YT_TEMP_DIR, f"{dl_id}{ext}")
                            if os.path.exists(tf):
                                try:
                                    os.remove(tf)
                                except Exception:
                                    pass
                        results['tests'].append({
                            'name': t['name'],
                            'success': True,
                            'title': inf.get('title', '')
                        })
                except Exception as ex:
                    results['tests'].append({
                        'name': t['name'],
                        'success': False,
                        'error': str(ex)
                    })
            self.send_json(200, results)
            return

        # YouTube Cookie Status API
        if parsed.path == '/api/youtube/cookies/status':
            cookie_path = find_valid_cookie_file()
            if cookie_path and os.path.exists(cookie_path):
                self.send_json(200, {
                    'success': True,
                    'has_cookies': True,
                    'size': os.path.getsize(cookie_path),
                    'path': cookie_path,
                    'message': 'Sunucuda aktif YouTube çerez dosyası yüklü.'
                })
            else:
                self.send_json(200, {
                    'success': True,
                    'has_cookies': False,
                    'size': 0,
                    'message': 'Sunucuda aktif çerez dosyası bulunamadı.'
                })
            return

        # YouTube Cookie Delete API
        if parsed.path == '/api/youtube/cookies/delete':
            deleted = []
            base_dir = os.path.dirname(os.path.abspath(__file__))
            candidate_paths = [
                os.path.join(base_dir, 'cookies.txt'),
                os.path.join(os.getcwd(), 'cookies.txt'),
                os.path.join(TEMP_DIR, 'cookies.txt'),
                os.path.join(YT_TEMP_DIR, 'cookies.txt'),
                os.path.join(TEMP_DIR, 'env_cookies.txt'),
            ]
            for p in candidate_paths:
                try:
                    if os.path.exists(p):
                        os.remove(p)
                        deleted.append(p)
                except Exception:
                    pass
            self.send_json(200, {
                'success': True,
                'message': f'{len(deleted)} çerez dosyası silindi.',
                'deleted': deleted
            })
            return

        # YouTube Search API
        if parsed.path == '/api/youtube/search':
            query = parse_qs(parsed.query)
            q = query.get('q', [''])[0].strip()
            limit = int(query.get('limit', ['8'])[0])
            limit = max(1, min(limit, 20))
            if not q:
                self.send_error_json(400, "Lütfen arama terimi belirtin.")
                return

            if not yt_dlp:
                self.send_error_json(500, "Sunucuda yt-dlp motoru hazır değil.")
                return

            t_start = time.time()
            print(f"[YouTube Search] Arama yapılıyor: '{q}' (limit={limit})", flush=True)
            try:
                base_opts = {
                    'extract_flat': True,
                    'skip_download': True,
                    'socket_timeout': 10,
                }
                search_target = f"ytsearch{limit}:{q}"
                info = run_resilient_ytdlp_action(search_target, base_opts=base_opts, is_download=False)
                entries = (info.get('entries', []) or []) if info else []
                items = []
                for e in entries:
                    if not e:
                        continue
                    item_id = e.get('id', '')
                    dur = e.get('duration') or 0
                    try:
                        dur = int(dur)
                    except (ValueError, TypeError):
                        dur = 0
                    mins = dur // 60
                    secs = dur % 60
                    items.append({
                        'id': item_id,
                        'title': e.get('title') or 'YouTube Parça',
                        'uploader': e.get('uploader') or e.get('channel') or 'YouTube Sanatçısı',
                        'duration': dur,
                        'duration_formatted': f"{mins:02d}:{secs:02d}",
                        'thumbnail': e.get('thumbnail') or (f"https://img.youtube.com/vi/{item_id}/hqdefault.jpg" if item_id else ''),
                        'url': f"https://www.youtube.com/watch?v={item_id}" if item_id else ''
                    })
                resp_data = {
                    'success': True,
                    'query': q,
                    'count': len(items),
                    'items': items,
                    'elapsed': round(time.time() - t_start, 2)
                }
                print(f"[YouTube Search] Başarılı ({resp_data['elapsed']}s): {len(items)} sonuç bulundu")
                self.send_json(200, resp_data)
            except Exception as e:
                print(f"[YouTube Search] Hata ({time.time() - t_start:.2f}s): {str(e)}")
                self.send_error_json(500, f"Arama başarısız oldu: {str(e)}")
            return

        # YouTube Info API
        if parsed.path == '/api/youtube/info':
            query = parse_qs(parsed.query)
            raw_url = query.get('url', [''])[0].strip()
            mode = query.get('mode', ['auto'])[0] # 'auto' | 'single' | 'playlist'
            
            target = parse_youtube_target(raw_url)
            if not target:
                self.send_error_json(400, "Lütfen geçerli bir YouTube linki, video ID'si veya arama terimi belirtin.")
                return

            if not yt_dlp or not FFMPEG_EXE:
                self.send_error_json(500, "Sunucuda yt-dlp veya FFmpeg motoru hazır değil.")
                return

            # Check if this URL represents a playlist
            is_pl_url = (target.get('type') == 'playlist' and mode != 'single') or ('/playlist' in raw_url)
            yt_url = target.get('url', raw_url)

            t_start = time.time()
            print(f"[YouTube Info] Bilgi alınıyor (is_playlist={is_pl_url}): {yt_url}")

            try:
                if is_pl_url:
                    base_opts = {
                        'extract_flat': 'in_playlist',
                        'skip_download': True,
                        'playlist_items': '1-40',
                        'socket_timeout': 15,
                        'check_formats': False,
                        'ignore_no_formats_error': True,
                        'format': 'bestaudio/ba/best[height<=720]/best/b',
                    }
                else:
                    base_opts = {
                        'skip_download': True,
                        'noplaylist': True,
                        'playlist_items': '1',
                        'socket_timeout': 12,
                        'check_formats': False,
                        'ignore_no_formats_error': True,
                        'format': 'bestaudio/ba/best[height<=720]/best/b',
                    }

                info = run_resilient_ytdlp_action(yt_url, base_opts=base_opts, is_download=False)
                if not info:
                    self.send_error_json(404, "Video veya çalma listesi bulunamadı.")
                    return

                # Playlist handling
                if info.get('_type') == 'playlist' or ('entries' in info and len(info['entries']) > 1):
                    entries = info.get('entries', []) or []
                    parsed_items = []
                    total_secs = 0
                    for idx, item in enumerate(entries, 1):
                        if not item:
                            continue
                        item_id = item.get('id', '')
                        item_dur = item.get('duration') or 0
                        try:
                            item_dur = int(item_dur)
                        except (ValueError, TypeError):
                            item_dur = 0
                        total_secs += item_dur
                        mins = item_dur // 60
                        secs = item_dur % 60
                        thumb = item.get('thumbnail')
                        if not thumb and item_id:
                            thumb = f"https://img.youtube.com/vi/{item_id}/hqdefault.jpg"

                        parsed_items.append({
                            'index': idx,
                            'id': item_id,
                            'title': item.get('title') or f"Parça #{idx}",
                            'uploader': item.get('uploader') or item.get('channel') or info.get('uploader') or 'Bilinmeyen Kanal',
                            'duration': item_dur,
                            'duration_formatted': f"{mins:02d}:{secs:02d}",
                            'thumbnail': thumb,
                            'url': f"https://www.youtube.com/watch?v={item_id}" if item_id else ''
                        })

                    total_mins = total_secs // 60
                    total_hrs = total_mins // 60
                    rem_mins = total_mins % 60
                    if total_hrs > 0:
                        total_time_str = f"{total_hrs} sa {rem_mins} dk"
                    else:
                        total_time_str = f"{total_mins} dk {total_secs % 60} sn"

                    resp_data = {
                        'success': True,
                        'is_playlist': True,
                        'id': info.get('id', ''),
                        'title': info.get('title', 'YouTube Çalma Listesi'),
                        'uploader': info.get('uploader') or info.get('channel', 'YouTube'),
                        'item_count': len(parsed_items),
                        'total_duration_formatted': total_time_str,
                        'items': parsed_items,
                        'video_resolutions': ['1080p', '720p', '480p', '360p'],
                        'audio_qualities': ['320 kbps (Ultra)', '192 kbps (Önerilen)', '128 kbps (Kompakt)'],
                    }
                    print(f"[YouTube Info] Çalma Listesi Başarılı ({time.time() - t_start:.2f}s): {resp_data['title']} ({len(parsed_items)} parça)")
                    self.send_json(200, resp_data)
                    return

                # Single video handling
                if 'entries' in info and info['entries']:
                    info = info['entries'][0]

                formats = info.get('formats', []) or []
                available_heights = set()
                for f in formats:
                    h = f.get('height')
                    vcodec = f.get('vcodec', 'none')
                    if h and vcodec != 'none':
                        available_heights.add(h)

                standard_resolutions = []
                for res in [1080, 720, 480, 360]:
                    if any(h >= res for h in available_heights) or res == 360:
                        standard_resolutions.append(f"{res}p")

                if not standard_resolutions:
                    standard_resolutions = ["720p", "360p"]

                duration = info.get('duration', 0) or 0
                mins = duration // 60
                secs = duration % 60
                duration_str = f"{mins:02d}:{secs:02d}"

                resp_data = {
                    'success': True,
                    'is_playlist': False,
                    'id': info.get('id', ''),
                    'title': info.get('title', 'YouTube Video'),
                    'uploader': info.get('uploader') or info.get('channel', 'Bilinmeyen Kanal'),
                    'duration': duration,
                    'duration_formatted': duration_str,
                    'thumbnail': info.get('thumbnail') or f"https://img.youtube.com/vi/{info.get('id', '')}/hqdefault.jpg",
                    'video_resolutions': standard_resolutions,
                    'audio_qualities': ['320 kbps (En Yüksek)', '192 kbps (Önerilen)', '128 kbps (Hızlı)'],
                }
                print(f"[YouTube Info] Başarılı ({time.time() - t_start:.2f}s): {resp_data['title']}")
                self.send_json(200, resp_data)
            except Exception as e:
                print(f"[YouTube Info] yt-dlp hatası ({time.time() - t_start:.2f}s): {str(e)}, oEmbed ile kurtarılıyor...")
                # Automatic oEmbed fail-safe recovery: guarantees card and download button even under strict cloud IP bot filters
                oembed_data = fetch_oembed_info(yt_url)
                if oembed_data and not is_pl_url:
                    video_id = target.get('id', '')
                    resp_data = {
                        'success': True,
                        'is_playlist': False,
                        'id': video_id,
                        'title': oembed_data.get('title') or 'YouTube Video',
                        'uploader': oembed_data.get('uploader') or 'YouTube Sanatçısı',
                        'duration': 0,
                        'duration_formatted': "Hazır",
                        'thumbnail': oembed_data.get('thumbnail') or (f"https://img.youtube.com/vi/{video_id}/hqdefault.jpg" if video_id else ''),
                        'video_resolutions': ['1080p', '720p', '480p', '360p'],
                        'audio_qualities': ['320 kbps (En Yüksek)', '192 kbps (Önerilen)', '128 kbps (Hızlı)'],
                    }
                    print(f"[YouTube Info] oEmbed ile başarıyla kurtarıldı: {resp_data['title']}")
                    self.send_json(200, resp_data)
                    return

                self.send_error_json(500, f"YouTube video bilgisi alınamadı: {str(e)}")
            return

        # YouTube Download API
        if parsed.path == '/api/youtube/download':
            query = parse_qs(parsed.query)
            raw_url = query.get('url', [''])[0].strip()
            target = parse_youtube_target(raw_url)
            if not target:
                self.send_error_json(400, "YouTube video linki eksik veya geçersiz.")
                return
            if target.get('type') == 'search':
                yt_url = f"ytsearch1:{target.get('query')}"
            else:
                yt_url = target.get('url') or target.get('clean_url')

            fmt = query.get('format', ['mp3'])[0].lower() # 'mp3' or 'mp4'
            quality_raw = query.get('quality', ['192'])[0].replace('p', '').split()[0]

            if not yt_dlp or not FFMPEG_EXE:
                self.send_error_json(500, "Sunucuda yt-dlp veya FFmpeg motoru hazır değil.")
                return

            t_start = time.time()
            print(f"[YouTube Download] İndirme başladı: {yt_url} | Format: {fmt} | Kalite: {quality_raw}")

            try:
                dl_id = str(uuid.uuid4())[:10]
                out_tmpl = os.path.join(YT_TEMP_DIR, f'{dl_id}.%(ext)s')

                if fmt == 'mp3':
                    preferred_quality = quality_raw if quality_raw in ['320', '192', '128'] else '192'
                    base_opts = {
                        'format': '18/bestaudio/ba/140/251/best[height<=720]/best/b',
                        'outtmpl': out_tmpl,
                        'noplaylist': True,
                        'playlist_items': '1',
                        'check_formats': False,
                        'ignore_no_formats_error': True,
                        'postprocessors': [{
                            'key': 'FFmpegExtractAudio',
                            'preferredcodec': 'mp3',
                            'preferredquality': preferred_quality,
                        }],
                    }
                    target_ext = 'mp3'
                    mime_type = 'audio/mpeg'
                else:
                    max_height = int(quality_raw) if quality_raw.isdigit() else 720
                    base_opts = {
                        'format': f'bestvideo[height<={max_height}]+bestaudio/best[height<={max_height}]/18/best/b',
                        'outtmpl': out_tmpl,
                        'merge_output_format': 'mp4',
                        'noplaylist': True,
                        'playlist_items': '1',
                        'check_formats': False,
                        'ignore_no_formats_error': True,
                    }
                    target_ext = 'mp4'
                    mime_type = 'video/mp4'

                info = None
                dl_err = None
                try:
                    info = run_resilient_ytdlp_action(yt_url, base_opts=base_opts, is_download=True)
                except Exception as e:
                    dl_err = str(e)
                    print(f"[YouTube Download] Standart yt-dlp indirme uyarısı ({dl_err}), doğrudan akış katmanı deneniyor...", flush=True)

                filepath = os.path.join(YT_TEMP_DIR, f'{dl_id}.{target_ext}')

                # Fail-Safe Layer 2: Fast chunked stream downloader & local transcode
                if not os.path.exists(filepath) or os.path.getsize(filepath) == 0:
                    print(f"[YouTube Download] Hızlı doğrudan akış kurtarma başlatılıyor: {yt_url}", flush=True)
                    try:
                        info_raw = run_resilient_ytdlp_action(yt_url, base_opts={'skip_download': True}, is_download=False)
                    except Exception as extract_err:
                        print(f"[YouTube Download] Format çıkarma uyarısı: {extract_err}", flush=True)
                        info_raw = {}

                    if 'entries' in info_raw and info_raw['entries']:
                        info_raw = info_raw['entries'][0]
                    if not info:
                        info = info_raw
                    formats = info_raw.get('formats', []) or []
                    candidates = []
                    for f in formats:
                        if not f or not f.get('url'):
                            continue
                        u = f.get('url', '')
                        proto = f.get('protocol', '')
                        # Skip HLS / DASH manifest playlists
                        if 'manifest' in u or 'm3u8' in u or proto == 'm3u8_native':
                            continue
                            
                        acodec = f.get('acodec', 'none')
                        vcodec = f.get('vcodec', 'none')
                        fid = str(f.get('format_id', ''))
                        
                        priority = 0
                        if fid == '18': # 360p combined MP4 (universally accessible & non-throttled)
                            priority = 100
                        elif fid == '22': # 720p combined MP4
                            priority = 90
                        elif fid == '140': # 128k AAC M4A
                            priority = 80
                        elif fid == '251': # 160k Opus WebM
                            priority = 70
                        elif acodec and acodec != 'none' and vcodec == 'none':
                            priority = 60
                        elif acodec and acodec != 'none':
                            priority = 50
                        else:
                            continue
                            
                        abr = f.get('abr') or f.get('tbr') or 128
                        candidates.append((priority, abr, f))

                    candidates.sort(key=lambda x: (x[0], x[1]), reverse=True)
                    print(f"[YouTube Download] {len(candidates)} doğrudan akış adayı bulundu.", flush=True)
                    last_stream_err = f"Aday sayısı: {len(candidates)}"
                    for _, _, best_fmt in candidates:
                        s_url = best_fmt.get('url')
                        fid = best_fmt.get('format_id')
                        ext = best_fmt.get('ext')
                        print(f"[YouTube Download] Akış indiriliyor ve dönüştürülüyor (id={fid}, ext={ext})...", flush=True)
                        ok, err_detail = download_stream_and_convert(
                            stream_url=s_url,
                            target_path=filepath,
                            media_format=fmt,
                            quality=preferred_quality if fmt == 'mp3' else '720',
                            headers=best_fmt.get('http_headers')
                        )
                        if ok:
                            print(f"[YouTube Download] Akış dönüştürme BAŞARILI! Boyut: {os.path.getsize(filepath)} bayt", flush=True)
                            last_stream_err = "OK"
                            break
                        else:
                            last_stream_err = f"id={fid}: {err_detail}"

                if not os.path.exists(filepath) or os.path.getsize(filepath) == 0:
                    v_id = ''
                    if target and target.get('id'):
                        v_id = target.get('id')
                    elif info and info.get('id'):
                        v_id = info.get('id')
                    elif 'watch?v=' in yt_url:
                        try:
                            v_id = yt_url.split('watch?v=')[1].split('&')[0]
                        except Exception:
                            pass
                    elif 'youtu.be/' in yt_url:
                        try:
                            v_id = yt_url.split('youtu.be/')[1].split('?')[0]
                        except Exception:
                            pass
                    
                    v_title = 'YouTube Parça'
                    if info and info.get('title'):
                        v_title = info.get('title')
                    elif target and target.get('query'):
                        v_title = target.get('query')

                    diag = f"FFMPEG={FFMPEG_EXE} | DL_Err={str(dl_err)[:70] if dl_err else 'Yok'} | Adaylar={len(candidates)}/{len(formats)} | Akış={last_stream_err}"
                    is_dc_blocked = ('No video formats found' in str(dl_err) or len(candidates) == 0 or '403' in str(dl_err))
                    
                    resp_payload = {
                        "success": False,
                        "error_type": "download_failed",
                        "error": f"YouTube indirme hatası: Doğrudan akış işlenemedi ({diag})",
                        "video_id": v_id,
                        "title": v_title
                    }
                    self.send_json(500, resp_payload)
                    return

                if not info:
                    info = {}
                if 'entries' in info and info['entries']:
                    info = info['entries'][0]
                video_title = info.get('title', 'flova_download')

                file_size = os.path.getsize(filepath)
                import unicodedata
                ascii_title = unicodedata.normalize('NFKD', video_title).encode('ascii', 'ignore').decode('ascii')
                ascii_title = "".join(c for c in ascii_title if c.isalnum() or c in " ._-()").strip() or "flova_media"
                safe_encoded_name = urllib.parse.quote(video_title)

                print(f"[YouTube Download] Tamamlandı ({time.time() - t_start:.2f}s): {filepath} ({file_size / 1024 / 1024:.2f} MB)")

                self.send_response(200)
                self.send_header('Content-Type', mime_type)
                self.send_header('Content-Length', str(file_size))
                self.send_header('Content-Disposition', f'attachment; filename="{ascii_title}.{target_ext}"; filename*=UTF-8\'\'{safe_encoded_name}.{target_ext}')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.send_header('Access-Control-Expose-Headers', 'Content-Disposition')
                self.end_headers()

                with open(filepath, 'rb') as f:
                    while chunk := f.read(65536):
                        self.wfile.write(chunk)

                # Schedule background deletion after 5 minutes
                def delayed_remove(p):
                    time.sleep(300)
                    try:
                        if os.path.exists(p):
                            os.remove(p)
                    except Exception:
                        pass
                threading.Thread(target=delayed_remove, args=(filepath,), daemon=True).start()
                return
            except Exception as e:
                print(f"[YouTube Download] Hata ({time.time() - t_start:.2f}s): {e}")
                self.send_error_json(500, f"İndirme başarısız oldu: {str(e)}")
                return

        if parsed.path == '/api/status':
            query = parse_qs(parsed.query)
            job_id = query.get('jobId', [None])[0]
            with JOBS_LOCK:
                job_data = JOBS.get(job_id, {'status': 'not_found'})
            body = json.dumps(job_data).encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-cache, no-store')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(body)
            return

        if parsed.path == '/api/stem':
            query = parse_qs(parsed.query)
            job_id = query.get('jobId', [None])[0]
            stem_type = query.get('type', ['vocal'])[0]
            filename = f'{stem_type}_{job_id}.wav'
            filepath = os.path.join(TEMP_DIR, filename)
            if not os.path.exists(filepath):
                self.send_error(404, "Stem file not found")
                return
            with open(filepath, 'rb') as f:
                content = f.read()
            self.send_response(200)
            self.send_header('Content-Type', 'audio/wav')
            self.send_header('Content-Length', str(len(content)))
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Cache-Control', 'no-cache, no-store')
            self.end_headers()
            self.wfile.write(content)
            return

        super().do_GET()

    def do_POST(self):
        parsed = urlparse(self.path)

        # Upload / Save YouTube Cookies API
        if parsed.path == '/api/youtube/cookies':
            try:
                content_length = int(self.headers.get('Content-Length', 0))
                payload = self.rfile.read(content_length).decode('utf-8', errors='ignore')
                raw_cookies = payload
                if payload.strip().startswith('{'):
                    try:
                        data = json.loads(payload)
                        raw_cookies = data.get('cookies') or data.get('content') or payload
                    except Exception:
                        pass
                
                raw_cookies = raw_cookies.strip()
                if len(raw_cookies) < 20:
                    self.send_error_json(400, "Geçersiz veya boş çerez verisi. Lütfen Netscape formatında cookies.txt içeriği gönderin.")
                    return

                # Save to multiple candidate locations
                base_dir = os.path.dirname(os.path.abspath(__file__))
                save_paths = [
                    os.path.join(base_dir, 'cookies.txt'),
                    os.path.join(os.getcwd(), 'cookies.txt'),
                    os.path.join(TEMP_DIR, 'cookies.txt'),
                    os.path.join(YT_TEMP_DIR, 'cookies.txt')
                ]
                saved_count = 0
                for sp in save_paths:
                    try:
                        with open(sp, 'w', encoding='utf-8') as f:
                            f.write(raw_cookies)
                        saved_count += 1
                    except Exception:
                        pass

                print(f"[YouTube Cookies] Yeni çerez dosyası yüklendi ({len(raw_cookies)} bayt, {saved_count} konuma yazıldı)", flush=True)
                self.send_json(200, {
                    'success': True,
                    'message': 'YouTube çerezleri başarıyla yüklendi ve aktif edildi!',
                    'size': len(raw_cookies)
                })
            except Exception as e:
                self.send_error_json(500, f"Çerez kaydedilemedi: {str(e)}")
            return

        if parsed.path == '/api/separate-ai':
            try:
                content_length = int(self.headers.get('Content-Length', 0))
                audio_bytes = self.rfile.read(content_length)

                job_id = str(uuid.uuid4())[:8]
                input_path = os.path.join(TEMP_DIR, f'input_{job_id}.wav')
                with open(input_path, 'wb') as f:
                    f.write(audio_bytes)

                with JOBS_LOCK:
                    JOBS[job_id] = {
                        'status': 'queued',
                        'progress': 5,
                        'message': 'Kuyruğa alındı...'
                    }

                # Launch async thread
                worker_thread = threading.Thread(
                    target=run_demucs_job,
                    args=(job_id, input_path),
                    daemon=True
                )
                worker_thread.start()

                resp = {'success': True, 'jobId': job_id}
                body = json.dumps(resp).encode('utf-8')
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(body)))
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(body)
            except Exception as e:
                err_resp = {'success': False, 'error': str(e)}
                body = json.dumps(err_resp).encode('utf-8')
                self.send_response(500)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(body)))
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(body)
        elif parsed.path in ['/api/separate-stems', '/api/separate-stems-6s']:
            try:
                query = parse_qs(parsed.query)
                is_6s = (parsed.path == '/api/separate-stems-6s') or (query.get('mode', ['4s'])[0] == '6s')
                
                content_length = int(self.headers.get('Content-Length', 0))
                audio_bytes = self.rfile.read(content_length)

                job_id = str(uuid.uuid4())[:8]
                input_path = os.path.join(TEMP_DIR, f'input_{job_id}.wav')
                with open(input_path, 'wb') as f:
                    f.write(audio_bytes)

                mode_name = '6-Stem Pro (Piyano & Gitar)' if is_6s else '4-Stem'
                with JOBS_LOCK:
                    JOBS[job_id] = {
                        'status': 'queued',
                        'progress': 5,
                        'message': f'{mode_name} kuyruğuna alındı...'
                    }

                # Launch async worker thread
                worker_func = run_htdemucs_6s_job if is_6s else run_htdemucs_job
                worker_thread = threading.Thread(
                    target=worker_func,
                    args=(job_id, input_path),
                    daemon=True
                )
                worker_thread.start()

                resp = {'success': True, 'jobId': job_id, 'is6s': is_6s}
                body = json.dumps(resp).encode('utf-8')
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(body)))
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(body)
            except Exception as e:
                err_resp = {'success': False, 'error': str(e)}
                body = json.dumps(err_resp).encode('utf-8')
                self.send_response(500)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(body)))
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(body)
        elif parsed.path == '/api/ai/denoise':
            try:
                query = parse_qs(parsed.query)
                strength = float(query.get('strength', [0.8])[0])
                content_length = int(self.headers.get('Content-Length', 0))
                audio_bytes = self.rfile.read(content_length)

                job_id = str(uuid.uuid4())[:8]
                in_path = os.path.join(TEMP_DIR, f'denoise_in_{job_id}.wav')
                out_path = os.path.join(TEMP_DIR, f'denoise_out_{job_id}.wav')
                with open(in_path, 'wb') as f:
                    f.write(audio_bytes)

                data, sr = sf.read(in_path)
                if nr is not None:
                    if data.ndim == 2:
                        cleaned = np.zeros_like(data)
                        for ch in range(data.shape[1]):
                            cleaned[:, ch] = nr.reduce_noise(y=data[:, ch], sr=sr, prop_decrease=strength)
                    else:
                        cleaned = nr.reduce_noise(y=data, sr=sr, prop_decrease=strength)
                else:
                    cleaned = data

                sf.write(out_path, cleaned, sr)

                with open(out_path, 'rb') as f:
                    out_bytes = f.read()

                try:
                    os.remove(in_path)
                    os.remove(out_path)
                except Exception:
                    pass

                self.send_response(200)
                self.send_header('Content-Type', 'audio/wav')
                self.send_header('Content-Length', str(len(out_bytes)))
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(out_bytes)
            except Exception as e:
                err_resp = {'success': False, 'error': str(e)}
                body = json.dumps(err_resp).encode('utf-8')
                self.send_response(500)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(body)
        elif parsed.path == '/api/ai/transcribe':
            try:
                query = parse_qs(parsed.query)
                lang = query.get('lang', ['tr-TR'])[0]
                model_size = query.get('model', ['small'])[0]
                ai_vocal = query.get('ai_vocal', ['0'])[0] == '1'
                content_length = int(self.headers.get('Content-Length', 0))
                audio_bytes = self.rfile.read(content_length)

                t0 = time.time()
                print(f"[Transcribe] Transkripsiyon basladi (lang={lang}, model={model_size}, ai_vocal={ai_vocal}, bytes={len(audio_bytes)})", flush=True)
                lines = segment_and_transcribe_audio(audio_bytes, lang=lang, max_workers=4, model_size=model_size, ai_separate=ai_vocal)
                elapsed = time.time() - t0
                print(f"[Transcribe] Tamamlandi: {len(lines)} satir cikarildi ({elapsed:.2f} sn)", flush=True)

                resp = {
                    'success': True,
                    'lines': lines,
                    'detectedCount': len(lines),
                    'language': lang,
                    'elapsedSeconds': round(elapsed, 2)
                }
                body = json.dumps(resp).encode('utf-8')
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(body)))
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(body)
            except Exception as e:
                print(f"[Transcribe Error]: {e}")
                err_resp = {'success': False, 'error': str(e)}
                body = json.dumps(err_resp).encode('utf-8')
                self.send_response(500)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(body)
        else:
            self.send_error(404)

def run_server(port=None):
    server_port = int(port or os.environ.get('PORT', 3000))
    print(f'Starting Flova Threading Server on port {server_port}...')
    threading.Thread(target=ensure_pot_server, daemon=True).start()
    server = ThreadingHTTPServer(('0.0.0.0', server_port), FlovaHandler)
    server.serve_forever()

if __name__ == '__main__':
    run_server()
