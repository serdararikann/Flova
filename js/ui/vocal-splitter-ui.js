/* ====================================================================
   FLOVA AUDIO STUDIO - VOCAL SPLITTER UI CONTROLLER
   - Dual Stem Waveforms (Vocal & Instrumental)
   - Synchronized Real-time 2-Stem Playback & Live Mixer
   - Advanced STFT Spectral & Mid/Side Separation Engines
   - Solo / Mute Controls, Bass Saver Crossover & Vocal Sensitivity
   - Dedicated Acapella & Karaoke Audio Export & Editor Routing
   ==================================================================== */

import { VocalSplitter } from '../audio/vocal-splitter.js';
import { AudioEncoders } from '../audio/audio-encoders.js';
import { ApiClient } from '../audio/api-client.js';

export class VocalSplitterUI {
  constructor(containerElement, audioEngine) {
    this.container = containerElement;
    this.engine = audioEngine;

    this.sourceBuffer = null;
    this.sourceFile = null;
    this.sourceFileName = '';
    this.vocalBuffer = null;
    this.instBuffer = null;

    this.isProcessing = false;
    this.engineMode = 'ai'; // 'ai' (Demucs Neural Network) | 'dsp' (Fast Browser Preview)
    this.preset = 'studio-stereo'; // 'studio-stereo' | 'acapella-master' | 'karaoke-master' | 'aggressive'
    this.bassCutoffHz = 160;
    this.vocalSensitivity = 1.2;
    this.stereoWidth = 1.0;
    this.vadGateStrength = 1.2;
    this.sibilanceAir = 1.0;
    this.transientWeight = 1.0;

    // Stem Mixer Levels
    this.vocalGain = 1.0;
    this.instGain = 1.0;
    this.vocalMuted = false;
    this.instMuted = false;
    this.vocalSolo = false;
    this.instSolo = false;

    // Playback State
    this.isPlaying = false;
    this.currentTime = 0;
    this.duration = 0;
    this.startTimeInCtx = 0;
    this.pausedOffset = 0;
    this.vocalSourceNode = null;
    this.instSourceNode = null;
    this.vocalGainNode = null;
    this.instGainNode = null;
    this.animFrameId = null;

    this.render();
    this.bindWindowEvents();
  }

  bindWindowEvents() {
    window.addEventListener('resize', () => {
      this.drawWaveforms();
    });
  }

  async handleUserFile(file) {
    if (!file) return;
    try {
      if (window.flovaApp) {
        window.flovaApp.showToast(`"${file.name}" yükleniyor...`, 'info');
      }
      this.engine.ensureContext();
      const arrayBuffer = await file.arrayBuffer();
      const buffer = await this.engine.ctx.decodeAudioData(arrayBuffer);
      await this.loadBuffer(buffer, file.name, file);
    } catch (err) {
      console.error('Vokal ayırıcı ses yükleme hatası:', err);
      if (window.flovaApp) {
        window.flovaApp.showToast(`Ses dosyası açılamadı: ${err.message || err}`, 'error');
      }
    }
  }

  async loadBuffer(buffer, fileName = 'Parça', rawFile = null) {
    this.sourceBuffer = buffer;
    this.sourceFile = rawFile;
    this.sourceFileName = fileName;
    this.duration = buffer.duration;
    this.stop();

    await this.processSeparation();
  }

  async processSeparation() {
    if (!this.sourceBuffer) return;
    if (this.engineMode === 'ai') {
      await this.processSeparationAI();
    } else {
      await this.processSeparationDSP();
    }
  }

  async processSeparationAI() {
    this.isProcessing = true;
    this.render();
    this.renderProgress(10, 'Demucs sinir ağı modeli başlatılıyor...');

    this.engine.ensureContext();
    const ctx = this.engine.ctx;

    try {
      let audioBlob = this.sourceFile;
      if (!audioBlob) {
        this.renderProgress(15, 'Ses WAV verisine dönüştürülüyor...');
        audioBlob = AudioEncoders.bufferToWave(this.sourceBuffer);
      }

      this.renderProgress(20, 'Ses dosyası sunucuya aktarılıyor...');
      
      const response = await fetch(ApiClient.getApiUrl('/api/separate-ai'), {
        method: 'POST',
        headers: { 'Content-Type': 'audio/wav' },
        body: audioBlob
      });

      if (!response.ok) {
        throw new Error('AI sunucusundan hata yanıtı alındı.');
      }

      const initData = await response.json();
      if (!initData.success || !initData.jobId) {
        throw new Error(initData.error || 'Ayrıştırma görevi başlatılamadı.');
      }

      const jobId = initData.jobId;
      let jobFinished = false;
      let jobResult = null;

      // Poll status every 1000ms - completely non-blocking
      let pollCount = 0;
      const MAX_POLLS = 900; // 15 minutes timeout (ample time for any full length audio)

      while (!jobFinished) {
        await new Promise(r => setTimeout(r, 1000));
        pollCount++;
        if (pollCount > MAX_POLLS) {
          throw new Error('Yapay zeka ayrıştırma zaman aşımına uğradı.');
        }

        let statusData = null;
        try {
          const pollRes = await fetch(ApiClient.getApiUrl(`/api/status?jobId=${jobId}`));
          if (pollRes.ok) {
            statusData = await pollRes.json();
          }
        } catch (netErr) {
          console.warn('Durum sorgulama ağ uyarısı:', netErr);
          continue;
        }

        if (statusData) {
          if (statusData.status === 'processing' || statusData.status === 'queued') {
            const displayPct = statusData.progress || 15;
            this.renderProgress(displayPct, `Demucs: ${statusData.message || 'Sinir ağı işliyor...'}`);
          } else if (statusData.status === 'done') {
            jobFinished = true;
            jobResult = statusData;
            this.renderProgress(92, 'Ayrıştırılmış vokal izi yükleniyor...');
          } else if (statusData.status === 'error') {
            throw new Error(statusData.error || 'Yapay zeka ayrıştırma hatası.');
          }
        }
      }

      this.engine.ensureContext();
      if (this.engine.ctx && this.engine.ctx.state === 'suspended') {
        await this.engine.ctx.resume();
      }

      this.renderProgress(92, 'Ayrıştırılmış vokal izi yükleniyor...');
      const vocRes = await fetch(ApiClient.getApiUrl(jobResult.vocalUrl));
      if (!vocRes.ok) throw new Error(`Vokal izi sunucudan indirilemedi (${vocRes.status})`);
      const vocBuf = await vocRes.arrayBuffer();
      this.vocalBuffer = await this.engine.ctx.decodeAudioData(vocBuf.slice(0));

      this.renderProgress(96, 'Ayrıştırılmış müzik izi yükleniyor...');
      const instRes = await fetch(ApiClient.getApiUrl(jobResult.instUrl));
      if (!instRes.ok) throw new Error(`Müzik izi sunucudan indirilemedi (${instRes.status})`);
      const instBuf = await instRes.arrayBuffer();
      this.instBuffer = await this.engine.ctx.decodeAudioData(instBuf.slice(0));

      this.duration = this.vocalBuffer ? this.vocalBuffer.duration : (this.sourceBuffer ? this.sourceBuffer.duration : 0);
      this.currentTime = 0;
      this.pausedOffset = 0;
      this.isProcessing = false;
      this.currentProgress = null;

      this.render();
      this.updateTimeDisplays();
      setTimeout(() => {
        this.drawWaveforms();
      }, 80);

      if (window.flovaApp) {
        window.flovaApp.showToast('Vokal ve Müzik ayrıştırma tamamlandı.', 'success');
      }
    } catch (err) {
      console.warn('AI ayrıştırma hatası, yerel DSP motoruna yönlendiriliyor:', err);
      if (window.flovaApp) {
        window.flovaApp.showToast('Sunucu çevrimdışı. Spektral DSP motoruna yönlendirildi.', 'info');
      }
      this.engineMode = 'dsp';
      await this.processSeparationDSP();
    }
  }

  async processSeparationDSP() {
    this.isProcessing = true;
    this.render();
    this.renderProgress(5, 'Stüdyo Spektral DSP 2.0 Ayrıştırma başlatılıyor...');

    this.engine.ensureContext();
    const ctx = this.engine.ctx;

    try {
      const { vocalBuffer, instrumentalBuffer } = await VocalSplitter.processBuffer(
        ctx,
        this.sourceBuffer,
        {
          preset: this.preset,
          bassCutoffHz: this.bassCutoffHz,
          vocalSensitivity: this.vocalSensitivity,
          stereoWidth: this.stereoWidth,
          vadGateStrength: this.vadGateStrength,
          sibilanceAir: this.sibilanceAir,
          transientWeight: this.transientWeight
        },
        (pct, text) => {
          this.renderProgress(pct, text);
        }
      );

      this.vocalBuffer = vocalBuffer;
      this.instBuffer = instrumentalBuffer;
      this.isProcessing = false;
      this.currentProgress = null;

      this.render();
      this.drawWaveforms();
      if (window.flovaApp) {
        window.flovaApp.showToast('Vokal ve Enstrümantal ayrıştırıldı!', 'success');
      }
    } catch (err) {
      console.error(err);
      this.isProcessing = false;
      this.currentProgress = null;
      this.render();
      if (window.flovaApp) {
        window.flovaApp.showToast('Ayrıştırma işlemi sırasında hata oluştu.', 'error');
      }
    }
  }

  getProgressHtml(pct, text) {
    return `
      <div style="background: rgba(10, 14, 24, 0.9); border: 1px solid rgba(56, 189, 248, 0.3); border-radius: 8px; padding: 16px 20px; margin-bottom: 14px; box-shadow: 0 4px 20px rgba(0,0,0,0.5);">
        <div style="display: flex; justify-content: space-between; align-items: center; font-size: 0.88rem; margin-bottom: 8px;">
          <div style="display: flex; align-items: center; gap: 8px;">
            <div class="loading-spinner" style="width: 16px; height: 16px;"></div>
            <span style="font-weight: 700; color: var(--accent-cyan);">${text}</span>
          </div>
          <span style="font-family: var(--font-mono); font-weight: 700; color: #fff;">%${pct}</span>
        </div>
        <div class="progress-bar-bg" style="height: 7px;">
          <div class="progress-bar-fill" style="width: ${pct}%;"></div>
        </div>
      </div>
    `;
  }

  renderProgress(pct, text) {
    this.currentProgress = { pct, text };
    const statusBox = this.container.querySelector('#splitterStatusBox');
    if (statusBox) {
      statusBox.innerHTML = this.getProgressHtml(pct, text);
    }
  }

  /* ====================================================================
     PLAYBACK ENGINE
     ==================================================================== */
  play(offset = null) {
    if (!this.vocalBuffer || !this.instBuffer) return;
    this.engine.ensureContext();
    const ctx = this.engine.ctx;

    if (this.isPlaying) {
      this.stopSources();
    }

    const startPos = offset !== null ? offset : this.pausedOffset;
    this.pausedOffset = Math.max(0, Math.min(this.duration, startPos));

    // Create dual sources
    this.vocalSourceNode = ctx.createBufferSource();
    this.vocalSourceNode.buffer = this.vocalBuffer;

    this.instSourceNode = ctx.createBufferSource();
    this.instSourceNode.buffer = this.instBuffer;

    // Create gain nodes for live mixing
    this.vocalGainNode = ctx.createGain();
    this.instGainNode = ctx.createGain();

    this.updateGainNodes();

    this.vocalSourceNode.connect(this.vocalGainNode);
    this.vocalGainNode.connect(ctx.destination);

    this.instSourceNode.connect(this.instGainNode);
    this.instGainNode.connect(ctx.destination);

    const now = ctx.currentTime;
    this.startTimeInCtx = now - this.pausedOffset;

    this.vocalSourceNode.start(now, this.pausedOffset);
    this.instSourceNode.start(now, this.pausedOffset);

    this.isPlaying = true;

    this.vocalSourceNode.onended = () => {
      if (this.isPlaying) {
        const cur = this.getCurrentPlayTime();
        if (cur >= this.duration - 0.05) {
          this.stop();
        }
      }
    };

    this.startPlayheadTimer();
    this.updatePlayButton();
  }

  pause() {
    if (!this.isPlaying) return;
    this.pausedOffset = this.getCurrentPlayTime();
    this.stopSources();
    this.isPlaying = false;
    this.stopPlayheadTimer();
    this.updatePlayButton();
  }

  stop() {
    this.stopSources();
    this.isPlaying = false;
    this.pausedOffset = 0;
    this.currentTime = 0;
    this.stopPlayheadTimer();
    this.updatePlayButton();
    this.updateTimeDisplays();
    this.drawPlayheads();
  }

  togglePlay() {
    if (this.isPlaying) {
      this.pause();
    } else {
      this.play();
    }
  }

  seek(time) {
    const clamped = Math.max(0, Math.min(this.duration, time));
    const wasPlaying = this.isPlaying;
    if (wasPlaying) {
      this.stopSources();
    }
    this.pausedOffset = clamped;
    this.currentTime = clamped;
    this.updateTimeDisplays();
    this.drawPlayheads();

    if (wasPlaying) {
      this.play(clamped);
    }
  }

  stopSources() {
    if (this.vocalSourceNode) {
      try { this.vocalSourceNode.stop(); this.vocalSourceNode.disconnect(); } catch (e) {}
      this.vocalSourceNode = null;
    }
    if (this.instSourceNode) {
      try { this.instSourceNode.stop(); this.instSourceNode.disconnect(); } catch (e) {}
      this.instSourceNode = null;
    }
  }

  getCurrentPlayTime() {
    if (!this.isPlaying || !this.engine.ctx) return this.pausedOffset;
    return Math.min(this.duration, this.engine.ctx.currentTime - this.startTimeInCtx);
  }

  startPlayheadTimer() {
    this.stopPlayheadTimer();
    const tick = () => {
      if (this.isPlaying) {
        this.currentTime = this.getCurrentPlayTime();
        this.updateTimeDisplays();
        this.drawPlayheads();
      }
      this.animFrameId = requestAnimationFrame(tick);
    };
    this.animFrameId = requestAnimationFrame(tick);
  }

  stopPlayheadTimer() {
    if (this.animFrameId) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
  }

  updateGainNodes() {
    if (!this.engine.ctx) return;
    const now = this.engine.ctx.currentTime;

    let effVocal = this.vocalMuted ? 0 : this.vocalGain;
    let effInst = this.instMuted ? 0 : this.instGain;

    if (this.vocalSolo && !this.instSolo) {
      effInst = 0;
    } else if (this.instSolo && !this.vocalSolo) {
      effVocal = 0;
    }

    if (this.vocalGainNode) {
      this.vocalGainNode.gain.setValueAtTime(effVocal, now);
    }
    if (this.instGainNode) {
      this.instGainNode.gain.setValueAtTime(effInst, now);
    }
  }

  updatePlayButton() {
    const btn = this.container.querySelector('#splitterPlayBtn');
    if (btn) {
      btn.innerHTML = this.isPlaying
        ? `<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>`
        : `<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>`;
      btn.title = this.isPlaying ? 'Duraklat (Space)' : 'Oynat (Space)';
    }
  }

  updateTimeDisplays() {
    const curElem = this.container.querySelector('#splitterCurrentTime');
    const totElem = this.container.querySelector('#splitterTotalTime');
    if (curElem) curElem.textContent = this.formatTime(this.currentTime);
    if (totElem) totElem.textContent = '/ ' + this.formatTime(this.duration);
  }

  /* ====================================================================
     DUAL WAVEFORM RENDERING
     ==================================================================== */
  drawWaveforms() {
    this.drawSingleWaveform('vocalWaveformCanvas', this.vocalBuffer, '#38bdf8', '#6366f1');
    this.drawSingleWaveform('instWaveformCanvas', this.instBuffer, '#ec4899', '#8b5cf6');
    this.drawPlayheads();
  }

  drawSingleWaveform(canvasId, buffer, color1, color2) {
    const canvas = this.container.querySelector(`#${canvasId}`);
    if (!canvas) return;

    const rect = canvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = rect.width || 600;
    const h = 130;

    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);

    const ctx = canvas.getContext('2d');
    ctx.resetTransform ? ctx.resetTransform() : ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);

    ctx.fillStyle = '#070912';
    ctx.fillRect(0, 0, w, h);

    if (!buffer) return;

    const data = buffer.getChannelData(0);
    const totalSamples = buffer.length;
    const centerY = h / 2;
    const amp = h * 0.44;

    // Center guideline
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, centerY);
    ctx.lineTo(w, centerY);
    ctx.stroke();

    const barWidth = 2;
    const gap = 1;
    const step = Math.max(1, Math.floor(totalSamples / (w * 1.5)));

    for (let x = 0; x < w; x += (barWidth + gap)) {
      const sampleStart = Math.floor((x / w) * totalSamples);
      const sampleEnd = Math.min(totalSamples, sampleStart + step);

      let min = 1.0;
      let max = -1.0;
      const stride = Math.max(1, Math.floor((sampleEnd - sampleStart) / 25));

      for (let i = sampleStart; i < sampleEnd; i += stride) {
        const val = data[i] || 0;
        if (val < min) min = val;
        if (val > max) max = val;
      }

      if (max < min || min === 1.0) { min = -0.02; max = 0.02; }

      const top = centerY - Math.max(2, max * amp);
      const bottom = centerY - Math.min(-2, min * amp);
      const barHeight = Math.max(2, bottom - top);

      const grad = ctx.createLinearGradient(0, top, 0, bottom);
      grad.addColorStop(0, color1);
      grad.addColorStop(1, color2);
      ctx.fillStyle = grad;

      ctx.fillRect(x, top, barWidth, barHeight);
    }
  }

  drawPlayheads() {
    ['vocalPlayheadCanvas', 'instPlayheadCanvas'].forEach(canvasId => {
      const canvas = this.container.querySelector(`#${canvasId}`);
      if (!canvas) return;

      const rect = canvas.parentElement.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const w = rect.width || 600;
      const h = 130;

      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);

      const ctx = canvas.getContext('2d');
      ctx.resetTransform ? ctx.resetTransform() : ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.scale(dpr, dpr);

      ctx.clearRect(0, 0, w, h);

      if (!this.duration) return;

      const playX = (this.currentTime / this.duration) * w;

      ctx.strokeStyle = '#f43f5e';
      ctx.lineWidth = 2.5;
      ctx.shadowColor = 'rgba(244, 63, 94, 0.9)';
      ctx.shadowBlur = 8;
      ctx.beginPath();
      ctx.moveTo(playX, 0);
      ctx.lineTo(playX, h);
      ctx.stroke();

      ctx.fillStyle = '#f43f5e';
      ctx.beginPath();
      ctx.moveTo(playX - 6, 0);
      ctx.lineTo(playX + 6, 0);
      ctx.lineTo(playX, 10);
      ctx.closePath();
      ctx.fill();
      ctx.shadowBlur = 0;
    });
  }

  /* ====================================================================
     EXPORT & ROUTING ACTIONS
     ==================================================================== */
  async exportStem(type = 'vocal') {
    const buffer = type === 'vocal' ? this.vocalBuffer : type === 'inst' ? this.instBuffer : null;
    if (!buffer) return;

    const baseName = (this.sourceFileName || 'Sarki').replace(/\.[^/.]+$/, '');
    const defaultName = type === 'vocal' ? `${baseName}_Acapella_Vokal` : `${baseName}_Karaoke_Enstrumantal`;

    this.engine.setBuffer(buffer, true, `${defaultName}.wav`);
    if (window.flovaApp && window.flovaApp.exportModal) {
      window.flovaApp.exportModal.open(0, buffer.duration);
    }
  }

  downloadStemDirect(type = 'vocal') {
    const buffer = type === 'vocal' ? this.vocalBuffer : this.instBuffer;
    if (!buffer) return;

    const baseName = (this.sourceFileName || 'Sarki').replace(/\.[^/.]+$/, '');
    const filename = type === 'vocal' ? `${baseName}_Vokal.wav` : `${baseName}_Muzik.wav`;

    const wavBlob = AudioEncoders.bufferToWave(buffer);
    const url = URL.createObjectURL(wavBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    if (window.flovaApp) {
      window.flovaApp.showToast(`"${filename}" başarıyla indirildi!`, 'success');
    }
  }

  async exportMixedStems() {
    if (!this.vocalBuffer || !this.instBuffer) return;
    this.engine.ensureContext();
    const mixed = VocalSplitter.mixStems(
      this.engine.ctx,
      this.vocalBuffer,
      this.instBuffer,
      this.vocalMuted ? 0 : this.vocalGain,
      this.instMuted ? 0 : this.instGain
    );

    const baseName = (this.sourceFileName || 'Sarki').replace(/\.[^/.]+$/, '');
    this.engine.setBuffer(mixed, true, `${baseName}_Ayrilmis_Miks.wav`);
    if (window.flovaApp && window.flovaApp.exportModal) {
      window.flovaApp.exportModal.open(0, mixed.duration);
    }
  }

  sendToEditor(type = 'vocal') {
    const buffer = type === 'vocal' ? this.vocalBuffer : this.instBuffer;
    if (!buffer) return;

    const baseName = (this.sourceFileName || 'Sarki').replace(/\.[^/.]+$/, '');
    const name = type === 'vocal' ? `${baseName}_Vokal.wav` : `${baseName}_Enstrumantal.wav`;

    this.stop();
    this.engine.currentFileName = name;
    this.engine.setBuffer(buffer, true);
    if (window.flovaApp) {
      window.flovaApp.switchMode('editor');
      window.flovaApp.showToast(`"${name}" Kesici & Düzenleyiciye aktarıldı!`, 'success');
    }
  }

  sendToMerger(type = 'vocal') {
    const buffer = type === 'vocal' ? this.vocalBuffer : this.instBuffer;
    if (!buffer) return;

    const baseName = (this.sourceFileName || 'Sarki').replace(/\.[^/.]+$/, '');
    const name = type === 'vocal' ? `${baseName}_Vokal.wav` : `${baseName}_Enstrumantal.wav`;

    this.stop();
    if (window.flovaMerger) {
      window.flovaMerger.addTrack({ name }, buffer);
      if (window.flovaApp) {
        window.flovaApp.switchMode('merger');
        window.flovaApp.showToast(`"${name}" Birleştiriciye eklendi!`, 'success');
      }
    }
  }

  /* ====================================================================
     UI RENDERING & EVENT BINDING
     ==================================================================== */
  render() {
    this.container.innerHTML = `
      <div class="vocal-splitter-section">
        
        <!-- Header & Track Load Bar -->
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; flex-wrap: wrap; gap: 10px;">
          <div style="display: flex; align-items: center; gap: 10px;">
            <div style="font-size: 1.1rem; font-weight: 700; display: flex; align-items: center; gap: 8px;">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="22"></line></svg>
              Vokal & Enstrüman Ayrıştırma
            </div>
            ${this.sourceBuffer ? `
              <div class="track-info-pill" style="margin-left: 8px;">
                <span class="track-name">${this.sourceFileName}</span>
                <span style="font-size: 0.75rem; color: var(--text-dim); margin-left: 6px;">(${this.formatTime(this.duration)})</span>
              </div>
            ` : ''}
          </div>

          <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
            <!-- Engine Mode Switcher -->
            <div style="display: flex; align-items: center; gap: 4px; background: rgba(255,255,255,0.06); padding: 3px 6px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.1);">
              <span style="font-size: 0.74rem; color: var(--text-muted); font-weight: 600;">Motor:</span>
              <button class="btn ${this.engineMode === 'ai' ? 'btn-primary' : 'btn-secondary'} btn-sm" style="padding: 2px 8px; font-size: 0.74rem;" onclick="window.flovaSplitter.setEngineMode('ai')" title="Demucs Sinir Ağı">
                Demucs Sinir Ağı
              </button>
              <button class="btn ${this.engineMode === 'dsp' ? 'btn-primary' : 'btn-secondary'} btn-sm" style="padding: 2px 8px; font-size: 0.74rem;" onclick="window.flovaSplitter.setEngineMode('dsp')" title="Hızlı Spektral DSP">
                Hızlı DSP
              </button>
            </div>

            ${this.engine.currentBuffer && this.engine.currentBuffer !== this.sourceBuffer ? `
              <button id="useCurrentTrackBtn" class="btn btn-emerald btn-sm" onclick="window.flovaSplitter.loadBuffer(window.flovaApp.engine.currentBuffer, window.flovaApp.engine.currentFileName || 'Duzenleyici_Parcasi')">
                Editörden Al
              </button>
            ` : ''}
            <label class="btn btn-primary btn-sm" style="cursor: pointer;">
              Dosya Aç
              <input type="file" id="splitterFileInput" accept="audio/*" style="display: none;" />
            </label>
          </div>
        </div>

        <div id="splitterStatusBox">
          ${this.isProcessing && this.currentProgress ? this.getProgressHtml(this.currentProgress.pct, this.currentProgress.text) : ''}
        </div>

        ${!this.sourceBuffer ? `
          <div id="vocalDropZone" class="drop-zone" style="margin-top: 10px;">
            <div class="drop-zone-icon" style="color: var(--accent-cyan);">
              <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"></path>
                <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
                <line x1="12" y1="19" x2="12" y2="22"></line>
              </svg>
            </div>
            <h2 class="drop-zone-title">Ses Dosyası Bırakın veya Seçin</h2>
            <p class="drop-zone-sub">MP3, WAV, FLAC, M4A, OGG</p>
          </div>
        ` : `
          <!-- Main Stems View -->
          <div class="stems-view-container" style="display: flex; flex-direction: column; gap: 14px;">
            
            <!-- 1. STEM: VOCALS (Acapella) -->
            <div class="stem-card glass-card" style="border-left: 4px solid var(--accent-cyan); padding: 12px 16px; background: rgba(10, 14, 24, 0.75);">
              <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; flex-wrap: wrap; gap: 8px;">
                <div style="display: flex; align-items: center; gap: 8px;">
                  <span style="font-size: 0.95rem; font-weight: 700; color: var(--accent-cyan);">Vokal (Acapella)</span>
                  <span class="badge-pro" style="font-size: 0.7rem; padding: 1px 6px;">${this.engineMode === 'ai' ? 'Demucs' : 'DSP'}</span>
                </div>

                <!-- Stem Controls -->
                <div style="display: flex; align-items: center; gap: 10px;">
                  <button id="vocalSoloBtn" class="btn btn-sm ${this.vocalSolo ? 'btn-primary' : 'btn-secondary'}" 
                    style="padding: 2px 8px; font-size: 0.75rem;" onclick="window.flovaSplitter.toggleSolo('vocal')">
                    SOLO
                  </button>
                  <button id="vocalMuteBtn" class="btn btn-sm ${this.vocalMuted ? 'btn-danger' : 'btn-secondary'}" 
                    style="padding: 2px 8px; font-size: 0.75rem;" onclick="window.flovaSplitter.toggleMute('vocal')">
                    MUTE
                  </button>
                  <div style="display: flex; align-items: center; gap: 6px;">
                    <span style="font-size: 0.78rem; color: var(--text-muted);">Ses:</span>
                    <input type="range" min="0" max="2" step="0.05" value="${this.vocalGain}" 
                      class="studio-slider" style="width: 80px; height: 4px;"
                      oninput="window.flovaSplitter.setVocalGain(this.value)" />
                    <span id="vocalGainVal" style="font-family: var(--font-mono); color: var(--accent-cyan); font-weight: 700; font-size: 0.8rem; width: 42px;">${Math.round(this.vocalGain * 100)}%</span>
                  </div>
                  <button class="btn btn-emerald btn-sm" style="padding: 3px 8px; font-size: 0.75rem;" onclick="window.flovaSplitter.exportStem('vocal')">
                    İndir
                  </button>
                </div>
              </div>

              <!-- Vocal Waveform Canvas -->
              <div class="stem-waveform-wrapper" style="position: relative; height: 130px; background: #070912; border: 1px solid rgba(56, 189, 248, 0.2); border-radius: 8px; overflow: hidden; cursor: crosshair;" onclick="window.flovaSplitter.handleWaveformClick(event, this)">
                <canvas id="vocalWaveformCanvas" style="width: 100%; height: 100%; display: block;"></canvas>
                <canvas id="vocalPlayheadCanvas" style="width: 100%; height: 100%; position: absolute; top: 0; left: 0; pointer-events: none;"></canvas>
              </div>
            </div>

            <!-- 2. STEM: INSTRUMENTAL (Karaoke / Music) -->
            <div class="stem-card glass-card" style="border-left: 4px solid var(--accent-primary); padding: 12px 16px; background: rgba(10, 14, 24, 0.75);">
              <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; flex-wrap: wrap; gap: 8px;">
                <div style="display: flex; align-items: center; gap: 8px;">
                  <span style="font-size: 0.95rem; font-weight: 700; color: #ec4899;">Enstrümantal (Karaoke)</span>
                  <span class="badge-pro" style="font-size: 0.7rem; padding: 1px 6px; background: rgba(236,72,153,0.2); color: #ec4899; border-color: rgba(236,72,153,0.3);">${this.engineMode === 'ai' ? 'Demucs' : 'DSP'}</span>
                </div>

                <!-- Stem Controls -->
                <div style="display: flex; align-items: center; gap: 10px;">
                  <button id="instSoloBtn" class="btn btn-sm ${this.instSolo ? 'btn-primary' : 'btn-secondary'}" 
                    style="padding: 2px 8px; font-size: 0.75rem;" onclick="window.flovaSplitter.toggleSolo('inst')">
                    SOLO
                  </button>
                  <button id="instMuteBtn" class="btn btn-sm ${this.instMuted ? 'btn-danger' : 'btn-secondary'}" 
                    style="padding: 2px 8px; font-size: 0.75rem;" onclick="window.flovaSplitter.toggleMute('inst')">
                    MUTE
                  </button>
                  <div style="display: flex; align-items: center; gap: 6px;">
                    <span style="font-size: 0.78rem; color: var(--text-muted);">Ses:</span>
                    <input type="range" min="0" max="2" step="0.05" value="${this.instGain}" 
                      class="studio-slider" style="width: 80px; height: 4px;"
                      oninput="window.flovaSplitter.setInstGain(this.value)" />
                    <span id="instGainVal" style="font-family: var(--font-mono); color: #ec4899; font-weight: 700; font-size: 0.8rem; width: 42px;">${Math.round(this.instGain * 100)}%</span>
                  </div>
                  <button class="btn btn-emerald btn-sm" style="padding: 3px 8px; font-size: 0.75rem;" onclick="window.flovaSplitter.exportStem('inst')">
                    İndir
                  </button>
                </div>
              </div>

              <!-- Instrumental Waveform Canvas -->
              <div class="stem-waveform-wrapper" style="position: relative; height: 130px; background: #070912; border: 1px solid rgba(236, 72, 153, 0.2); border-radius: 8px; overflow: hidden; cursor: crosshair;" onclick="window.flovaSplitter.handleWaveformClick(event, this)">
                <canvas id="instWaveformCanvas" style="width: 100%; height: 100%; display: block;"></canvas>
                <canvas id="instPlayheadCanvas" style="width: 100%; height: 100%; position: absolute; top: 0; left: 0; pointer-events: none;"></canvas>
              </div>
            </div>

            <!-- Transport & Tuning Bar -->
            <div style="background: rgba(10, 14, 24, 0.9); border: 1px solid var(--border-glass); border-radius: var(--radius-md); padding: 14px 18px; display: flex; flex-direction: column; gap: 12px;">
              
              <!-- Upper Row: Transport + Presets + Routing Actions -->
              <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px;">
                
                <!-- Playback Controls -->
                <div style="display: flex; align-items: center; gap: 12px;">
                  <button id="splitterPlayBtn" class="play-main-btn" style="width: 44px; height: 44px;" onclick="window.flovaSplitter.togglePlay()" title="Oynat / Duraklat (Space)">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                      <polygon points="5 3 19 12 5 21 5 3"></polygon>
                    </svg>
                  </button>
                  <button class="control-circle-btn" onclick="window.flovaSplitter.stop()" title="Başa Sar">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
                      <rect x="4" y="4" width="16" height="16" rx="2"></rect>
                    </svg>
                  </button>
                  <div style="font-family: var(--font-mono); font-size: 0.95rem; font-weight: 700;">
                    <span id="splitterCurrentTime" style="color: var(--accent-cyan);">00:00.0</span>
                    <span id="splitterTotalTime" style="color: var(--text-dim); margin-left: 4px;">/ 00:00.0</span>
                  </div>

                  <!-- Quick A/B Audition Toggles -->
                  <div style="display: flex; align-items: center; gap: 4px; background: rgba(0,0,0,0.35); padding: 2px 6px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.06); margin-left: 8px;">
                    <span style="font-size: 0.72rem; color: var(--text-dim); margin-right: 4px; font-weight: 600;">A/B:</span>
                    <button class="btn ${!this.vocalSolo && !this.instSolo ? 'btn-primary' : 'btn-secondary'} btn-sm" style="font-size: 0.72rem; padding: 2px 7px;" onclick="window.flovaSplitter.setQuickMode('mix')">Miks</button>
                    <button class="btn ${this.vocalSolo && !this.instSolo ? 'btn-primary' : 'btn-secondary'} btn-sm" style="font-size: 0.72rem; padding: 2px 7px;" onclick="window.flovaSplitter.setQuickMode('vocal')">Vokal</button>
                    <button class="btn ${this.instSolo && !this.vocalSolo ? 'btn-primary' : 'btn-secondary'} btn-sm" style="font-size: 0.72rem; padding: 2px 7px;" onclick="window.flovaSplitter.setQuickMode('inst')">Altyapı</button>
                  </div>
                </div>

                <!-- DSP Presets (shown in DSP mode) or AI indicator -->
                ${this.engineMode === 'dsp' ? `
                  <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
                    <button class="btn ${this.preset === 'studio-stereo' ? 'btn-primary' : 'btn-secondary'} btn-sm" style="font-size: 0.75rem; padding: 4px 9px;" onclick="window.flovaSplitter.applyPreset('studio-stereo')">
                      Stereo Pro
                    </button>
                    <button class="btn ${this.preset === 'acapella-master' ? 'btn-primary' : 'btn-secondary'} btn-sm" style="font-size: 0.75rem; padding: 4px 9px;" onclick="window.flovaSplitter.applyPreset('acapella-master')">
                      Acapella
                    </button>
                    <button class="btn ${this.preset === 'karaoke-master' ? 'btn-primary' : 'btn-secondary'} btn-sm" style="font-size: 0.75rem; padding: 4px 9px;" onclick="window.flovaSplitter.applyPreset('karaoke-master')">
                      Karaoke
                    </button>
                    <button class="btn ${this.preset === 'aggressive' ? 'btn-primary' : 'btn-secondary'} btn-sm" style="font-size: 0.75rem; padding: 4px 9px;" onclick="window.flovaSplitter.applyPreset('aggressive')">
                      Agresif
                    </button>
                  </div>
                ` : `
                  <div style="display: flex; align-items: center; gap: 8px; background: rgba(56,189,248,0.1); border: 1px solid rgba(56,189,248,0.25); border-radius: 6px; padding: 4px 10px;">
                    <span style="font-size: 0.78rem; font-weight: 600; color: var(--accent-cyan);">Demucs v4 Sinir Ağı</span>
                  </div>
                `}

                <!-- Quick Actions -->
                <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
                  <button class="btn btn-emerald btn-sm" onclick="window.flovaSplitter.downloadStemDirect('vocal')" title="Vokali WAV olarak indir">
                    Vokal İndir
                  </button>
                  <button class="btn btn-primary btn-sm" onclick="window.flovaSplitter.downloadStemDirect('inst')" title="Müziği WAV olarak indir">
                    Müzik İndir
                  </button>
                  <button class="btn btn-secondary btn-sm" onclick="window.flovaSplitter.sendToEditor('vocal')" title="Vokali düzenle">
                    Vokal Düzenle
                  </button>
                  <button class="btn btn-secondary btn-sm" onclick="window.flovaSplitter.sendToEditor('inst')" title="Müziği düzenle">
                    Müzik Düzenle
                  </button>
                  <button class="btn btn-secondary btn-sm" onclick="window.flovaSplitter.exportMixedStems()" title="Mikslenmiş sesi dışa aktar">
                    Miks İndir
                  </button>
                </div>

              </div>

              <!-- Lower Row: DSP Fine-Tuning Sliders (when DSP mode is active) or AI Re-run Button -->
              <div style="display: flex; align-items: center; gap: 16px; flex-wrap: wrap; padding-top: 8px; border-top: 1px solid rgba(255,255,255,0.06);">
                ${this.engineMode === 'dsp' ? `
                  <!-- 1. Vocal Sensitivity -->
                  <div style="display: flex; align-items: center; gap: 6px;">
                    <span style="font-size: 0.78rem; color: var(--text-muted);">Hassasiyet:</span>
                    <input type="range" min="0.5" max="2.5" step="0.1" value="${this.vocalSensitivity}" 
                      class="studio-slider" style="width: 60px; height: 4px;"
                      onchange="window.flovaSplitter.setVocalSensitivity(this.value)" />
                    <span id="vocalSensVal" style="font-family: var(--font-mono); font-size: 0.78rem; color: var(--accent-cyan); font-weight: 700;">${this.vocalSensitivity.toFixed(1)}x</span>
                  </div>

                  <!-- 2. Stereo Width -->
                  <div style="display: flex; align-items: center; gap: 6px;">
                    <span style="font-size: 0.78rem; color: var(--text-muted);">Stereo:</span>
                    <input type="range" min="0.2" max="1.5" step="0.1" value="${this.stereoWidth}" 
                      class="studio-slider" style="width: 60px; height: 4px;"
                      onchange="window.flovaSplitter.setStereoWidth(this.value)" />
                    <span id="stereoWidthVal" style="font-family: var(--font-mono); font-size: 0.78rem; color: var(--accent-cyan); font-weight: 700;">${this.stereoWidth.toFixed(1)}x</span>
                  </div>

                  <!-- 3. VAD Silence Gate -->
                  <div style="display: flex; align-items: center; gap: 6px;">
                    <span style="font-size: 0.78rem; color: var(--text-muted);">VAD Eşiği:</span>
                    <input type="range" min="0.0" max="2.0" step="0.2" value="${this.vadGateStrength}" 
                      class="studio-slider" style="width: 60px; height: 4px;"
                      onchange="window.flovaSplitter.setVadGateStrength(this.value)" />
                    <span id="vadGateVal" style="font-family: var(--font-mono); font-size: 0.78rem; color: var(--accent-cyan); font-weight: 700;">${this.vadGateStrength.toFixed(1)}x</span>
                  </div>

                  <!-- 4. Sibilance & High Freq Air -->
                  <div style="display: flex; align-items: center; gap: 6px;">
                    <span style="font-size: 0.78rem; color: var(--text-muted);">Sibilans:</span>
                    <input type="range" min="0.5" max="2.0" step="0.1" value="${this.sibilanceAir}" 
                      class="studio-slider" style="width: 60px; height: 4px;"
                      onchange="window.flovaSplitter.setSibilanceAir(this.value)" />
                    <span id="sibilanceVal" style="font-family: var(--font-mono); font-size: 0.78rem; color: var(--accent-cyan); font-weight: 700;">${this.sibilanceAir.toFixed(1)}x</span>
                  </div>

                  <!-- 5. Bass Shield Crossover -->
                  <div style="display: flex; align-items: center; gap: 6px;">
                    <span style="font-size: 0.78rem; color: var(--text-muted);">Bas Filtresi:</span>
                    <input type="range" min="80" max="260" step="10" value="${this.bassCutoffHz}" 
                      class="studio-slider" style="width: 60px; height: 4px;"
                      onchange="window.flovaSplitter.setBassCutoff(this.value)" />
                    <span id="bassCutoffVal" style="font-family: var(--font-mono); font-size: 0.78rem; color: var(--accent-cyan); font-weight: 700;">${this.bassCutoffHz}Hz</span>
                  </div>
                ` : `
                  <!-- Clean spacer in AI mode -->
                `}

                <!-- Re-process button -->
                <button class="btn btn-primary btn-sm" style="font-size: 0.8rem; padding: 4px 14px; margin-left: auto;" onclick="window.flovaSplitter.processSeparation()" title="Parçayı yeniden ayrıştır">
                  Yeniden İşle
                </button>

              </div>

            </div>

          </div>
        `}
      </div>
    `;

    // Bind file input events
    const fileInputs = [
      this.container.querySelector('#splitterFileInput'),
      this.container.querySelector('#splitterFileInputEmpty')
    ];

    fileInputs.forEach(input => {
      if (input) {
        input.addEventListener('click', () => {
          input.value = '';
        });
        input.addEventListener('change', async (e) => {
          const file = e.target.files[0];
          if (file) {
            await this.handleUserFile(file);
          }
        });
      }
    });

    const vocalDropZone = this.container.querySelector('#vocalDropZone');
    const primaryInput = this.container.querySelector('#splitterFileInput');
    if (vocalDropZone) {
      vocalDropZone.addEventListener('click', () => {
        if (primaryInput) {
          primaryInput.value = '';
          primaryInput.click();
        }
      });

      ['dragenter', 'dragover'].forEach(name => {
        vocalDropZone.addEventListener(name, (e) => {
          e.preventDefault();
          e.stopPropagation();
          vocalDropZone.classList.add('dragover', 'drop-zone-drag');
        });
      });

      ['dragleave', 'drop'].forEach(name => {
        vocalDropZone.addEventListener(name, (e) => {
          e.preventDefault();
          e.stopPropagation();
          vocalDropZone.classList.remove('dragover', 'drop-zone-drag');
        });
      });

      vocalDropZone.addEventListener('drop', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        vocalDropZone.classList.remove('dragover', 'drop-zone-drag');
        const file = e.dataTransfer.files[0];
        if (file && (file.type.startsWith('audio/') || /\.(mp3|wav|ogg|flac|m4a|aac|wma|aiff)$/i.test(file.name))) {
          await this.handleUserFile(file);
        }
      });
    }

    if (this.sourceBuffer && !this.isProcessing) {
      setTimeout(() => this.drawWaveforms(), 50);
    }
  }

  setEngineMode(mode) {
    this.engineMode = mode;
    this.render();
    if (this.sourceBuffer) {
      this.processSeparation();
    }
  }

  handleWaveformClick(e, wrapper) {
    const rect = wrapper.getBoundingClientRect();
    const clickX = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    const targetTime = (clickX / rect.width) * this.duration;
    this.seek(targetTime);
  }

  setVocalGain(val) {
    this.vocalGain = parseFloat(val);
    const label = this.container.querySelector('#vocalGainVal');
    if (label) label.textContent = Math.round(this.vocalGain * 100) + '%';
    this.updateGainNodes();
  }

  setInstGain(val) {
    this.instGain = parseFloat(val);
    const label = this.container.querySelector('#instGainVal');
    if (label) label.textContent = Math.round(this.instGain * 100) + '%';
    this.updateGainNodes();
  }

  setVocalSensitivity(val) {
    this.vocalSensitivity = parseFloat(val);
    const label = this.container.querySelector('#vocalSensVal');
    if (label) label.textContent = this.vocalSensitivity.toFixed(1) + 'x';
  }

  setStereoWidth(val) {
    this.stereoWidth = parseFloat(val);
    const label = this.container.querySelector('#stereoWidthVal');
    if (label) label.textContent = this.stereoWidth.toFixed(1) + 'x';
  }

  setVadGateStrength(val) {
    this.vadGateStrength = parseFloat(val);
    const label = this.container.querySelector('#vadGateVal');
    if (label) label.textContent = this.vadGateStrength.toFixed(1) + 'x';
  }

  setSibilanceAir(val) {
    this.sibilanceAir = parseFloat(val);
    const label = this.container.querySelector('#sibilanceVal');
    if (label) label.textContent = this.sibilanceAir.toFixed(1) + 'x';
  }

  setBassCutoff(val) {
    this.bassCutoffHz = parseInt(val, 10);
    const label = this.container.querySelector('#bassCutoffVal');
    if (label) label.textContent = this.bassCutoffHz + 'Hz';
  }

  applyPreset(preset) {
    this.preset = preset;
    if (preset === 'studio-stereo') {
      this.vocalSensitivity = 1.2;
      this.stereoWidth = 1.0;
      this.vadGateStrength = 1.2;
      this.sibilanceAir = 1.0;
      this.bassCutoffHz = 160;
      this.transientWeight = 1.0;
    } else if (preset === 'acapella-master') {
      this.vocalSensitivity = 1.5;
      this.stereoWidth = 0.8;
      this.vadGateStrength = 1.6;
      this.sibilanceAir = 1.2;
      this.bassCutoffHz = 180;
      this.transientWeight = 1.5;
    } else if (preset === 'karaoke-master') {
      this.vocalSensitivity = 1.0;
      this.stereoWidth = 1.2;
      this.vadGateStrength = 1.0;
      this.sibilanceAir = 0.8;
      this.bassCutoffHz = 150;
      this.transientWeight = 0.8;
    } else if (preset === 'aggressive') {
      this.vocalSensitivity = 1.8;
      this.stereoWidth = 0.6;
      this.vadGateStrength = 1.8;
      this.sibilanceAir = 1.3;
      this.bassCutoffHz = 200;
      this.transientWeight = 1.6;
    }
    this.render();
    if (this.sourceBuffer) {
      this.processSeparation();
    }
  }

  toggleSolo(type) {
    if (type === 'vocal') {
      this.vocalSolo = !this.vocalSolo;
      if (this.vocalSolo) this.instSolo = false;
    } else {
      this.instSolo = !this.instSolo;
      if (this.instSolo) this.vocalSolo = false;
    }
    this.render();
    this.drawWaveforms();
    this.updateGainNodes();
  }

  toggleMute(type) {
    if (type === 'vocal') {
      this.vocalMuted = !this.vocalMuted;
    } else {
      this.instMuted = !this.instMuted;
    }
    this.render();
    this.drawWaveforms();
    this.updateGainNodes();
  }

  setQuickMode(mode) {
    if (mode === 'vocal') {
      this.vocalSolo = true;
      this.instSolo = false;
      this.vocalMuted = false;
      this.instMuted = false;
    } else if (mode === 'inst') {
      this.vocalSolo = false;
      this.instSolo = true;
      this.vocalMuted = false;
      this.instMuted = false;
    } else {
      this.vocalSolo = false;
      this.instSolo = false;
      this.vocalMuted = false;
      this.instMuted = false;
    }
    this.render();
    this.drawWaveforms();
    this.updateGainNodes();
  }

  formatTime(sec) {
    const mins = Math.floor(sec / 60);
    const secs = Math.floor(sec % 60);
    const ms = Math.floor((sec % 1) * 10);
    return `${mins}:${secs.toString().padStart(2, '0')}.${ms}`;
  }
}
