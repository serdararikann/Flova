---
title: Flova GPU
emoji: 🎙️
colorFrom: yellow
colorTo: red
sdk: gradio
sdk_version: 6.29.0
python_version: '3.12'
app_file: app.py
pinned: false
license: mit
---

# Flova GPU

Whisper (faster-whisper, large-v3-turbo) on ZeroGPU for Flova Audio Studio's lyrics transcription.
The main backend (`Nergall/flova`) calls `/transcribe` with a 16 kHz mono FLAC and falls back to its own CPU
model when this Space is busy or out of quota.
