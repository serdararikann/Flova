"""
Flova GPU: lyrics transcription on ZeroGPU.

`/lyrics` takes the song as the main backend received it, separates the vocal with the same Demucs ONNX model
(CUDA instead of CPU) and runs Whisper; `/transcribe` takes an already prepared 16 kHz mono FLAC. Both return
Whisper's raw segments with word timings; line splitting, hallucination filtering and lyric alignment stay in
server.py, so the result matches its CPU path, which is also the fallback when this Space is busy or out of quota.
"""
import os
import subprocess
import sys
import time
from importlib.metadata import PackageNotFoundError, version


def _ensure_onnxruntime_gpu():
    """faster-whisper depends on the CPU onnxruntime, which shares the module with onnxruntime-gpu: whichever pip
    unpacked last wins. Remove the CPU one and reinstall the GPU one over it before anything imports it."""
    try:
        version('onnxruntime')
    except PackageNotFoundError:
        return
    gpu = version('onnxruntime-gpu')
    subprocess.run([sys.executable, '-m', 'pip', 'uninstall', '-y', 'onnxruntime'], check=False)
    subprocess.run([sys.executable, '-m', 'pip', 'install', '--no-deps', '--force-reinstall',
                    f'onnxruntime-gpu=={gpu}'], check=True)


_ensure_onnxruntime_gpu()

import torch  # loads the CUDA/cuDNN libraries that CTranslate2 and ONNX Runtime need
import spaces
import gradio as gr
import numpy as np
import soundfile as sf
import soxr
import onnxruntime as ort
from scipy import signal
from huggingface_hub import hf_hub_download
from faster_whisper import WhisperModel, download_model

# demucs_onnx's constants and vocal model (not imported: it pulls in the CPU onnxruntime over onnxruntime-gpu)
SAMPLE_RATE, N_SAMPLES, N_CHANNELS = 44100, 343980, 2
SOURCES = ('drums', 'bass', 'other', 'vocals')

MODEL_NAME = os.environ.get('FLOVA_WHISPER_MODEL', 'large-v3-turbo')
# Downloaded at start-up, so a call only pays for moving the models to the GPU
WHISPER_DIR = download_model(MODEL_NAME)
VOCAL_MODEL = hf_hub_download('StemSplitio/htdemucs-ft-vocals-onnx', 'htdemucs_ft_vocals.onnx')
if hasattr(ort, 'preload_dlls'):
    ort.preload_dlls()

TARGET_SR = 16000
_whisper = None
_vocal = None


def _make_transition_window(segment, overlap_frac=0.25):
    """Triangular fade-in/fade-out window for overlap-add chunked inference (demucs_onnx's)."""
    transition = int(segment * overlap_frac)
    window = np.ones(segment, dtype=np.float32)
    fade = np.linspace(0, 1, transition, dtype=np.float32)
    window[:transition] = fade
    window[-transition:] = fade[::-1]
    return window


def resample(audio, src_sr, dst_sr):
    """server.py's fast_resample (soxr HQ), channels first."""
    if src_sr == dst_sr:
        return audio.astype(np.float32)
    if audio.ndim == 1:
        return soxr.resample(audio, src_sr, dst_sr, quality='HQ').astype(np.float32)
    return np.ascontiguousarray(soxr.resample(audio.T, src_sr, dst_sr, quality='HQ').T, dtype=np.float32)


def separate_vocal(data, sr):
    """server.py's separate_vocals_with_demucs on CUDA: 25 % overlapping chunks, mono vocal at 44.1 kHz."""
    global _vocal
    if _vocal is None:
        opts = ort.SessionOptions()
        opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        _vocal = ort.InferenceSession(VOCAL_MODEL, sess_options=opts,
                                      providers=['CUDAExecutionProvider', 'CPUExecutionProvider'])
        if 'CUDAExecutionProvider' not in _vocal.get_providers():
            raise gr.Error('CUDA kullanılamıyor.')
    stereo = np.array([data, data], dtype=np.float32) if data.ndim == 1 else data.T.astype(np.float32)
    if stereo.shape[0] == 1:
        stereo = np.repeat(stereo, 2, axis=0)
    stereo = resample(stereo, sr, SAMPLE_RATE)

    total = stereo.shape[1]
    overlap = N_SAMPLES // 4
    stride = N_SAMPLES - overlap
    window = _make_transition_window(N_SAMPLES)
    out = np.zeros((N_CHANNELS, total), dtype=np.float32)
    weight = np.zeros(total, dtype=np.float32)
    row = SOURCES.index('vocals')
    for start in range(0, max(1, total), stride):
        end = min(start + N_SAMPLES, total)
        chunk = stereo[:, start:end]
        if chunk.shape[1] < N_SAMPLES:
            chunk = np.pad(chunk, ((0, 0), (0, N_SAMPLES - chunk.shape[1])))
        stems = _vocal.run(['stems'], {'mix': chunk[np.newaxis].astype(np.float32, copy=False)})[0][0]
        w = window[:end - start]
        out[:, start:end] += stems[row, :, :end - start] * w
        weight[start:end] += w
        if end >= total:
            break
    out /= np.maximum(weight, 1e-8)
    return out.mean(axis=0)


def run_whisper(mono_16k, language, vad):
    global _whisper
    if _whisper is None:
        _whisper = WhisperModel(WHISPER_DIR, device='cuda', compute_type='float16')
    segments, info = _whisper.transcribe(
        mono_16k,
        language=language or None,
        condition_on_previous_text=False,
        repetition_penalty=1.2,
        no_repeat_ngram_size=3,
        vad_filter=vad,
        vad_parameters={'min_silence_duration_ms': 700, 'speech_pad_ms': 300} if vad else None,
        word_timestamps=True,
        beam_size=3,
        temperature=0.0,
    )
    return [{
        'start': seg.start,
        'end': seg.end,
        'text': seg.text,
        'no_speech_prob': seg.no_speech_prob,
        'avg_logprob': seg.avg_logprob,
        'words': [[w.start, w.end, w.word] for w in (seg.words or [])],
    } for seg in segments], info.language


def audio_seconds(path):
    try:
        return sf.info(path).duration
    except Exception:
        return 300


def lyrics_duration(audio_path, language='tr', separate=True, vocal_stem=False):
    """Seconds of GPU to ask for: ZeroGPU queues shorter requests first."""
    return int(min(170, 25 + audio_seconds(audio_path) * (0.2 if separate and not vocal_stem else 0.12)))


@spaces.GPU(duration=lyrics_duration)
def lyrics(audio_path, language='tr', separate=True, vocal_stem=False):
    """The whole of server.py's _transcribe_lines up to Whisper: vocal separation (unless the client sent a
    separated vocal), else band-pass of the mix; peak normalisation; Whisper with VAD on a separated vocal."""
    started = time.time()
    data, sr = sf.read(audio_path, dtype='float32')
    separate, vocal_stem = bool(separate), bool(vocal_stem)
    mono_16k = None
    vocals_only = vocal_stem
    if separate and not vocal_stem:
        mono_16k = resample(separate_vocal(data, sr), SAMPLE_RATE, TARGET_SR)
        vocals_only = True
    separated = time.time()
    if mono_16k is None:
        mono = data.mean(axis=1) if data.ndim > 1 else data
        mono_16k = resample(mono, sr, TARGET_SR)
        sos = signal.butter(4, [150, 6500], btype='bandpass', fs=TARGET_SR, output='sos')
        mono_16k = signal.sosfilt(sos, mono_16k).astype(np.float32)
    peak = float(np.max(np.abs(mono_16k))) if len(mono_16k) else 0.0
    if peak > 1e-4:
        mono_16k = mono_16k / peak * 0.95
    segments, lang = run_whisper(mono_16k.astype(np.float32), language, vocals_only)
    return {
        'model': MODEL_NAME,
        'language': lang,
        'duration': len(mono_16k) / TARGET_SR,
        'separated': separate and not vocal_stem,
        'separate_seconds': round(separated - started, 2),
        'seconds': round(time.time() - started, 2),
        'segments': segments,
    }


def transcribe_duration(audio_path, language='tr', vad=False):
    return int(min(170, 20 + audio_seconds(audio_path) * 0.12))


@spaces.GPU(duration=transcribe_duration)
def transcribe(audio_path, language='tr', vad=False):
    """Whisper only, on a 16 kHz mono FLAC prepared by the caller."""
    started = time.time()
    audio, sr = sf.read(audio_path, dtype='float32')
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    if sr != TARGET_SR:
        raise gr.Error('16 kHz mono bekleniyor.')
    segments, lang = run_whisper(audio, language, bool(vad))
    return {'model': MODEL_NAME, 'language': lang, 'duration': len(audio) / TARGET_SR,
            'seconds': round(time.time() - started, 2), 'segments': segments}


with gr.Blocks(title='Flova GPU') as demo:
    gr.Markdown('Lyrics transcription on ZeroGPU for [Flova Audio Studio](https://flova.serdararikan.net). API only.')
    with gr.Tab('Lyrics'):
        song_in = gr.File(label='Song (WAV/FLAC)', type='filepath')
        song_lang = gr.Textbox(value='tr', label='Language')
        sep_in = gr.Checkbox(value=True, label='Separate the vocal (Demucs)')
        stem_in = gr.Checkbox(value=False, label='The file is already a separated vocal')
        song_out = gr.JSON()
        gr.Button('Transcribe').click(lyrics, [song_in, song_lang, sep_in, stem_in], song_out, api_name='lyrics')
    with gr.Tab('Whisper only'):
        audio_in = gr.File(label='16 kHz mono FLAC', type='filepath')
        lang_in = gr.Textbox(value='tr', label='Language')
        vad_in = gr.Checkbox(value=False, label='VAD (separated vocal)')
        result = gr.JSON()
        gr.Button('Transcribe').click(transcribe, [audio_in, lang_in, vad_in], result, api_name='transcribe')

demo.queue(default_concurrency_limit=2).launch()
