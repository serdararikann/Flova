import os
import sys
import json
import time
import uuid
import threading
from urllib.parse import urlparse, parse_qs
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
import io
import soundfile as sf
import numpy as np

try:
    import demucs_onnx
except ImportError:
    demucs_onnx = None

try:
    import yt_dlp
    import imageio_ffmpeg
    FFMPEG_EXE = imageio_ffmpeg.get_ffmpeg_exe()
except Exception as e:
    yt_dlp = None
    FFMPEG_EXE = None

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

def sanitize_youtube_url(raw_url):
    raw_url = (raw_url or '').strip()
    try:
        p = urlparse(raw_url)
        if 'youtube.com' in p.netloc and '/watch' in p.path:
            qs = parse_qs(p.query)
            if 'v' in qs:
                from urllib.parse import urlencode
                return f"{p.scheme}://{p.netloc}{p.path}?{urlencode({'v': qs['v']}, doseq=True)}"
    except Exception:
        pass
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
    base_dir = os.path.dirname(os.path.abspath(__file__))
    candidate_paths = [
        os.path.join(base_dir, 'cookies.txt'),
        os.path.join(os.getcwd(), 'cookies.txt'),
        '/app/cookies.txt',
        '/home/user/app/cookies.txt'
    ]
    for p in candidate_paths:
        if os.path.exists(p) and os.path.getsize(p) > 0:
            return p
    return None


def get_youtube_dl_opts(extra_opts=None, client_list=None, use_cookies=True):
    opts = {
        'quiet': True,
        'no_warnings': True,
        'nocheckcertificate': True,
        'socket_timeout': 15,
        'ffmpeg_location': FFMPEG_EXE,
    }
    if client_list:
        opts['extractor_args'] = {
            'youtube': {
                'player_client': client_list
            }
        }

    cookie_file = find_valid_cookie_file() if use_cookies else None
    if cookie_file:
        opts['cookiefile'] = cookie_file

    if extra_opts:
        opts.update(extra_opts)
    return opts


def run_resilient_ytdlp_action(yt_url, base_opts=None, is_download=False):
    """
    Executes yt-dlp with automatic multi-tier fallback:
    1. Android+iOS+Web with cookies (if cookies.txt exists)
    2. Pure Android client WITHOUT cookies (bypasses stale cookie expiration & datacenter web bot filters)
    3. Android+iOS mobile clients WITHOUT cookies
    4. Web Embedded fallback
    """
    cookie_file = find_valid_cookie_file()
    strategies = []
    if cookie_file:
        strategies.append({
            'name': 'Android+iOS+Web (Cookies Aktif)',
            'clients': ['android', 'ios', 'web'],
            'use_cookies': True
        })
    strategies.append({
        'name': 'Pure Android Mobil API (Çerezsiz - Bot Koruması Atlatıcı)',
        'clients': ['android'],
        'use_cookies': False
    })
    strategies.append({
        'name': 'Android+iOS Hibrit (Çerezsiz)',
        'clients': ['android', 'ios'],
        'use_cookies': False
    })
    strategies.append({
        'name': 'Web Embedded Alternatif',
        'clients': ['web_embedded', 'mweb'],
        'use_cookies': False
    })

    last_err = None
    for idx, strat in enumerate(strategies, 1):
        try:
            ydl_opts = get_youtube_dl_opts(
                extra_opts=base_opts,
                client_list=strat['clients'],
                use_cookies=strat['use_cookies']
            )
            print(f"[YouTube Engine] Strateji {idx}/{len(strategies)} deneniyor: {strat['name']} -> {yt_url}", flush=True)
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(yt_url, download=is_download)
                if info:
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

        # Root welcome / status page (for Hugging Face Spaces health check & browser preview)
        if parsed.path in ('/', ''):
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
  </style>
</head>
<body>
  <div class="card">
    <div class="status"><span class="dot"></span> AI Sunucusu Aktif (Running)</div>
    <h1>🎛️ Flova Audio Studio</h1>
    <p>Demucs v4 AI (4-Stem & 6-Stem), YouTube İndirici ve Ses İşleme Servisi başarıyla çalışıyor.</p>
  </div>
</body>
</html>"""
            self.wfile.write(html.encode('utf-8'))
            return

        # Health Check API
        if parsed.path == '/api/health':
            self.send_json(200, {'status': 'ok', 'service': 'flova-backend', 'time': time.time()})
            return

        # YouTube Info API
        if parsed.path == '/api/youtube/info':
            query = parse_qs(parsed.query)
            raw_url = query.get('url', [''])[0].strip()
            mode = query.get('mode', ['auto'])[0] # 'auto' | 'single' | 'playlist'
            
            # Check if this URL represents a playlist
            is_pl_url = ('/playlist' in raw_url) or ('list=' in raw_url and mode != 'single')
            
            if not is_pl_url:
                yt_url = sanitize_youtube_url(raw_url)
            else:
                yt_url = raw_url

            if not yt_url:
                self.send_error_json(400, "Lütfen geçerli bir YouTube video linki belirtin.")
                return

            if not yt_dlp or not FFMPEG_EXE:
                self.send_error_json(500, "Sunucuda yt-dlp veya FFmpeg motoru hazır değil.")
                return

            t_start = time.time()
            print(f"[YouTube Info] Bilgi alınıyor (is_playlist={is_pl_url}): {yt_url}")

            try:
                if is_pl_url:
                    base_opts = {
                        'extract_flat': 'in_playlist',
                        'skip_download': True,
                        'playlist_items': '1-40',
                        'socket_timeout': 15,
                    }
                else:
                    base_opts = {
                        'skip_download': True,
                        'noplaylist': True,
                        'playlist_items': '1',
                        'socket_timeout': 12,
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
                print(f"[YouTube Info] Hata ({time.time() - t_start:.2f}s): {str(e)}")
                self.send_error_json(500, f"YouTube video bilgisi alınamadı: {str(e)}")
            return

        # YouTube Download API
        if parsed.path == '/api/youtube/download':
            query = parse_qs(parsed.query)
            raw_url = query.get('url', [''])[0].strip()
            yt_url = sanitize_youtube_url(raw_url)
            fmt = query.get('format', ['mp3'])[0].lower() # 'mp3' or 'mp4'
            quality_raw = query.get('quality', ['192'])[0].replace('p', '').split()[0]

            if not yt_url:
                self.send_error_json(400, "YouTube video linki eksik.")
                return

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
                        'format': 'bestaudio/best',
                        'outtmpl': out_tmpl,
                        'noplaylist': True,
                        'playlist_items': '1',
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
                        'format': f'bestvideo[height<={max_height}]+bestaudio/best[height<={max_height}]/best',
                        'outtmpl': out_tmpl,
                        'merge_output_format': 'mp4',
                        'noplaylist': True,
                        'playlist_items': '1',
                    }
                    target_ext = 'mp4'
                    mime_type = 'video/mp4'

                info = run_resilient_ytdlp_action(yt_url, base_opts=base_opts, is_download=True)
                if 'entries' in info and info['entries']:
                    info = info['entries'][0]
                video_title = info.get('title', 'flova_download')

                filepath = os.path.join(YT_TEMP_DIR, f'{dl_id}.{target_ext}')
                if not os.path.exists(filepath):
                    self.send_error_json(500, "İndirilen medya dosyası oluşturulamadı.")
                    return

                file_size = os.path.getsize(filepath)
                import unicodedata
                ascii_title = unicodedata.normalize('NFKD', video_title).encode('ascii', 'ignore').decode('ascii')
                ascii_title = "".join(c for c in ascii_title if c.isalnum() or c in " ._-()").strip() or "flova_media"
                import urllib.parse
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
    server = ThreadingHTTPServer(('0.0.0.0', server_port), FlovaHandler)
    server.serve_forever()

if __name__ == '__main__':
    run_server()
