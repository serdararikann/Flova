import os
import sys
import json
import time
import uuid
import threading
from urllib.parse import urlparse, parse_qs
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
import soundfile as sf
import numpy as np

try:
    import demucs_onnx
except ImportError:
    demucs_onnx = None

PORT = 3000
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
TEMP_DIR = os.path.join(BASE_DIR, 'temp_stems')
os.makedirs(TEMP_DIR, exist_ok=True)

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
    # Allocate up to 8 threads (leaves 12+ CPU threads completely free for Windows & apps to prevent lag)
    total_cores = os.cpu_count() or 4
    worker_threads = min(8, max(2, total_cores // 2))
    sess_opts.intra_op_num_threads = worker_threads
    sess_opts.inter_op_num_threads = 1
    sess_opts.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    sess_opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    sess_opts.enable_cpu_mem_arena = True
    sess_opts.enable_mem_pattern = True
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

class FlovaHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=BASE_DIR, **kwargs)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
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
        else:
            self.send_error(404)

if __name__ == '__main__':
    print(f'Starting Flova Threading Server on port {PORT}...')
    server = ThreadingHTTPServer(('0.0.0.0', PORT), FlovaHandler)
    server.serve_forever()
