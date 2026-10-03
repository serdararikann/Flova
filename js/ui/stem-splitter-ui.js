/* ====================================================================
   FLOVA AUDIO STUDIO - MULTI-STEM INSTRUMENT SPLITTER UI (4-STEM & 6-STEM PRO)
   - 6 Independent Stems: Vokal, Davul, Bas Gitar, Gitar, Piyano, Sentetikler/Yaylılar
   - Demucs Hybrid Transformer v4 (htdemucs_6s & htdemucs)
   - Synchronized 6-Track Studio Mixer with Solo, Mute, Gain & Stereo Pan
   - A/B Instant Comparison with Original Mix
   - Custom Backing Track / Karaoke / Drumless Mixdown Exporter
   - One-Click ZIP Stem Archive Downloader (JSZip)
   ==================================================================== */

import { AudioEncoders } from '../audio/audio-encoders.js';
import { ApiClient } from '../audio/api-client.js';

export const STEM_DEFS = {
  vocals: {
    id: 'vocals',
    name: 'Vokal',
    color: '#38bdf8',
    gradientStart: '#38bdf8',
    gradientEnd: '#0284c7',
    icon: '',
    badge: 'VOKAL'
  },
  drums: {
    id: 'drums',
    name: 'Davul',
    color: '#f59e0b',
    gradientStart: '#fbbf24',
    gradientEnd: '#d97706',
    icon: '',
    badge: 'DAVUL'
  },
  bass: {
    id: 'bass',
    name: 'Bas',
    color: '#a855f7',
    gradientStart: '#c084fc',
    gradientEnd: '#7e22ce',
    icon: '',
    badge: 'BAS'
  },
  guitar: {
    id: 'guitar',
    name: 'Gitar',
    color: '#f97316',
    gradientStart: '#fb923c',
    gradientEnd: '#c2410c',
    icon: '',
    badge: 'GİTAR'
  },
  piano: {
    id: 'piano',
    name: 'Piyano',
    color: '#10b981',
    gradientStart: '#34d399',
    gradientEnd: '#059669',
    icon: '',
    badge: 'PİYANO'
  },
  other: {
    id: 'other',
    name: 'Sentetik & FX',
    color: '#ec4899',
    gradientStart: '#f472b6',
    gradientEnd: '#be185d',
    icon: '',
    badge: 'DİĞER'
  }
};

export class StemSplitterUI {
  constructor(containerElement, audioEngine) {
    this.container = containerElement;
    this.engine = audioEngine;

    this.sourceBuffer = null;
    this.sourceFile = null;
    this.sourceFileName = '';
    this.currentJobId = null;

    // Separation Mode: '6s' (Pro: separates Piano & Guitar) or '4s' (Standard)
    this.separationMode = '6s';

    // Stem Data Store with Pan support for all 6 stems
    this.stems = {
      vocals: { buffer: null, gain: 1.0, pan: 0.0, muted: false, solo: false, sourceNode: null, gainNode: null, pannerNode: null },
      drums:  { buffer: null, gain: 1.0, pan: 0.0, muted: false, solo: false, sourceNode: null, gainNode: null, pannerNode: null },
      bass:   { buffer: null, gain: 1.0, pan: 0.0, muted: false, solo: false, sourceNode: null, gainNode: null, pannerNode: null },
      guitar: { buffer: null, gain: 1.0, pan: 0.0, muted: false, solo: false, sourceNode: null, gainNode: null, pannerNode: null },
      piano:  { buffer: null, gain: 1.0, pan: 0.0, muted: false, solo: false, sourceNode: null, gainNode: null, pannerNode: null },
      other:  { buffer: null, gain: 1.0, pan: 0.0, muted: false, solo: false, sourceNode: null, gainNode: null, pannerNode: null }
    };

    // State
    this.isProcessing = false;
    this.isPlaying = false;
    this.currentTime = 0;
    this.duration = 0;
    this.startTimeInCtx = 0;
    this.pausedOffset = 0;
    this.masterGain = 1.0;
    this.masterGainNode = null;
    this.animFrameId = null;

    // A/B Comparison State
    this.isComparingOriginal = false;
    this.origSourceNode = null;
    this.origGainNode = null;

    this.render();
    this.bindWindowEvents();
  }

  bindWindowEvents() {
    window.addEventListener('resize', () => {
      this.drawAllWaveforms();
    });
  }

  setSeparationMode(mode) {
    this.separationMode = mode;
    this.render();
    if (this.sourceBuffer) {
      this.processSeparation();
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

  /* ====================================================================
     AI SEPARATION PIPELINE (DEMUCS 4-STEM OR 6-STEM PRO)
     ==================================================================== */
  async processSeparation() {
    if (!this.sourceBuffer) return;

    this.isProcessing = true;
    this.render();
    
    const is6s = this.separationMode === '6s';
    const modeName = is6s ? '6-Stem Pro' : '4-Stem';
    this.renderProgress(8, `Demucs ${modeName} başlatılıyor...`);

    this.engine.ensureContext();

    try {
      let audioBlob = this.sourceFile;
      if (!audioBlob) {
        this.renderProgress(12, 'Ses WAV verisine dönüştürülüyor...');
        audioBlob = AudioEncoders.bufferToWave(this.sourceBuffer);
      }

      this.renderProgress(16, 'Ses dosyası sunucuya aktarılıyor...');
      
      const response = await fetch(ApiClient.getApiUrl(`/api/separate-stems?mode=${this.separationMode}`), {
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
      this.currentJobId = jobId;
      let jobFinished = false;
      let jobResult = null;

      let pollCount = 0;
      const MAX_POLLS = 900;

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
            this.renderProgress(displayPct, `Demucs: ${statusData.message || 'Ayrıştırma işleniyor...'}`);
          } else if (statusData.status === 'done') {
            jobFinished = true;
            jobResult = statusData;
          } else if (statusData.status === 'error') {
            throw new Error(statusData.error || 'Yapay zeka ayrıştırma hatası.');
          }
        }
      }

      this.engine.ensureContext();
      if (this.engine.ctx && this.engine.ctx.state === 'suspended') {
        await this.engine.ctx.resume();
      }

      // Reset all stems buffers first
      for (const k of Object.keys(this.stems)) {
        this.stems[k].buffer = null;
      }

      // Download and decode all returned stems
      const returnedKeys = Object.keys(jobResult.stems);
      const stemNamesTr = {
        vocals: 'Vokal',
        drums: 'Davul',
        bass: 'Bas',
        guitar: 'Gitar',
        piano: 'Piyano',
        other: is6s ? 'Sentetikler' : 'Melodi'
      };

      for (let i = 0; i < returnedKeys.length; i++) {
        const key = returnedKeys[i];
        const pct = 90 + Math.floor((i / returnedKeys.length) * 8);
        this.renderProgress(pct, `Kanal yükleniyor: ${stemNamesTr[key] || key} (%${pct})...`);

        const stemUrl = jobResult.stems[key];
        const res = await fetch(ApiClient.getApiUrl(stemUrl));
        if (!res.ok) throw new Error(`${stemNamesTr[key] || key} izi indirilemedi (${res.status})`);
        const ab = await res.arrayBuffer();
        if (this.stems[key]) {
          this.stems[key].buffer = await this.engine.ctx.decodeAudioData(ab.slice(0));
        }
      }

      this.duration = this.stems.vocals.buffer ? this.stems.vocals.buffer.duration : this.sourceBuffer.duration;
      this.currentTime = 0;
      this.pausedOffset = 0;
      this.isProcessing = false;
      this.currentProgress = null;

      this.render();
      this.updateTimeDisplays();
      setTimeout(() => {
        this.drawAllWaveforms();
      }, 100);

      const successMsg = is6s 
        ? '6 Enstrüman kökü (Vokal, Davul, Bas, Gitar, Piyano, Sentetik) ayrıştırıldı.'
        : '4 Enstrüman kökü ayrıştırıldı.';
      if (window.flovaApp) {
        window.flovaApp.showToast(successMsg, 'success');
      }
    } catch (err) {
      console.error('Ayrıştırma hatası:', err);
      this.isProcessing = false;
      this.currentProgress = null;
      this.render();
      if (window.flovaApp) {
        const isNetworkErr = err.message?.includes('Failed to fetch') || err.message?.includes('sunucusundan');
        const userMsg = isNetworkErr
          ? 'Sunucuya bağlanılamadı. Sağ üstteki sunucu durumu butonundan kontrol edebilirsiniz.'
          : `Ayrıştırma Hatası: ${err.message || err}`;
        window.flovaApp.showToast(userMsg, 'error');
      }
    }
  }

  /* ====================================================================
     SYNCHRONIZED MULTI-TRACK AUDIO PLAYBACK
     ==================================================================== */
  togglePlay() {
    if (this.isPlaying) {
      this.pause();
    } else {
      this.play();
    }
  }

  async play() {
    if (this.isPlaying) return;
    if (!this.hasAnyStem()) return;

    this.engine.ensureContext();
    const ctx = this.engine.ctx;
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }

    if (this.pausedOffset >= this.duration) {
      this.pausedOffset = 0;
    }

    const startOffset = this.pausedOffset;
    this.startTimeInCtx = ctx.currentTime - startOffset;

    // Create Master Gain
    this.masterGainNode = ctx.createGain();
    this.masterGainNode.gain.setValueAtTime(this.isComparingOriginal ? 0 : this.masterGain, ctx.currentTime);
    this.masterGainNode.connect(ctx.destination);

    const anySolo = this.getActiveStemKeys().some(k => this.stems[k].solo);

    for (const key of this.getActiveStemKeys()) {
      const stem = this.stems[key];
      if (!stem.buffer) continue;

      const source = ctx.createBufferSource();
      source.buffer = stem.buffer;

      const gainNode = ctx.createGain();
      let targetGain = stem.gain;
      if (stem.muted) {
        targetGain = 0;
      } else if (anySolo && !stem.solo) {
        targetGain = 0;
      }
      gainNode.gain.setValueAtTime(targetGain, ctx.currentTime);

      // Stereo Panner
      if (ctx.createStereoPanner) {
        const panner = ctx.createStereoPanner();
        panner.pan.setValueAtTime(stem.pan || 0, ctx.currentTime);
        source.connect(gainNode);
        gainNode.connect(panner);
        panner.connect(this.masterGainNode);
        stem.pannerNode = panner;
      } else {
        source.connect(gainNode);
        gainNode.connect(this.masterGainNode);
      }

      source.start(0, startOffset);
      stem.sourceNode = source;
      stem.gainNode = gainNode;
    }

    // Setup Original Source for A/B comparison
    if (this.sourceBuffer) {
      const origSource = ctx.createBufferSource();
      origSource.buffer = this.sourceBuffer;

      const origGain = ctx.createGain();
      origGain.gain.setValueAtTime(this.isComparingOriginal ? this.masterGain : 0, ctx.currentTime);

      origSource.connect(origGain);
      origGain.connect(ctx.destination);

      origSource.start(0, startOffset);
      this.origSourceNode = origSource;
      this.origGainNode = origGain;
    }

    this.isPlaying = true;
    this.updatePlayBtnState();
    this.startProgressLoop();
  }

  pause() {
    if (!this.isPlaying) return;

    this.engine.ensureContext();
    const ctx = this.engine.ctx;

    this.pausedOffset = Math.min(ctx.currentTime - this.startTimeInCtx, this.duration);
    this.currentTime = this.pausedOffset;

    this.stopAllSourceNodes();
    this.isPlaying = false;
    this.cancelProgressLoop();
    this.updatePlayBtnState();
    this.updateTimeDisplays();
    this.drawAllPlayheads();
  }

  stop() {
    this.stopAllSourceNodes();
    this.isPlaying = false;
    this.currentTime = 0;
    this.pausedOffset = 0;
    this.cancelProgressLoop();
    this.updatePlayBtnState();
    this.updateTimeDisplays();
    this.drawAllPlayheads();
  }

  seek(targetTime) {
    const wasPlaying = this.isPlaying;
    if (wasPlaying) {
      this.stopAllSourceNodes();
      this.isPlaying = false;
      this.cancelProgressLoop();
    }

    this.pausedOffset = Math.max(0, Math.min(targetTime, this.duration));
    this.currentTime = this.pausedOffset;

    this.updateTimeDisplays();
    this.drawAllPlayheads();

    if (wasPlaying) {
      this.play();
    }
  }

  stopAllSourceNodes() {
    for (const stem of Object.values(this.stems)) {
      if (stem.sourceNode) {
        try {
          stem.sourceNode.stop();
          stem.sourceNode.disconnect();
        } catch (_) {}
        stem.sourceNode = null;
      }
      if (stem.gainNode) {
        try { stem.gainNode.disconnect(); } catch (_) {}
        stem.gainNode = null;
      }
      if (stem.pannerNode) {
        try { stem.pannerNode.disconnect(); } catch (_) {}
        stem.pannerNode = null;
      }
    }
    if (this.origSourceNode) {
      try {
        this.origSourceNode.stop();
        this.origSourceNode.disconnect();
      } catch (_) {}
      this.origSourceNode = null;
    }
    if (this.origGainNode) {
      try { this.origGainNode.disconnect(); } catch (_) {}
      this.origGainNode = null;
    }
    if (this.masterGainNode) {
      try { this.masterGainNode.disconnect(); } catch (_) {}
      this.masterGainNode = null;
    }
  }

  startProgressLoop() {
    const loop = () => {
      if (!this.isPlaying) return;
      const ctx = this.engine.ctx;
      this.currentTime = ctx.currentTime - this.startTimeInCtx;

      if (this.currentTime >= this.duration) {
        this.stop();
        return;
      }

      this.updateTimeDisplays();
      this.drawAllPlayheads();
      this.animFrameId = requestAnimationFrame(loop);
    };
    this.animFrameId = requestAnimationFrame(loop);
  }

  cancelProgressLoop() {
    if (this.animFrameId) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
  }

  /* ====================================================================
     A/B COMPARISON (ORIGINAL MIX vs STEM MIX)
     ==================================================================== */
  toggleABComparison() {
    this.isComparingOriginal = !this.isComparingOriginal;
    const ctx = this.engine.ctx;

    if (ctx && this.masterGainNode && this.origGainNode) {
      const now = ctx.currentTime;
      if (this.isComparingOriginal) {
        this.masterGainNode.gain.setTargetAtTime(0, now, 0.03);
        this.origGainNode.gain.setTargetAtTime(this.masterGain, now, 0.03);
      } else {
        this.origGainNode.gain.setTargetAtTime(0, now, 0.03);
        this.masterGainNode.gain.setTargetAtTime(this.masterGain, now, 0.03);
      }
    }

    const btn = document.getElementById('stemABBtn');
    if (btn) {
      if (this.isComparingOriginal) {
        btn.classList.add('active-ab');
        btn.innerHTML = '<b>Orijinal Parça (A)</b>';
        if (window.flovaApp) window.flovaApp.showToast('Orijinal parça dinleniyor', 'info');
      } else {
        btn.classList.remove('active-ab');
        btn.innerHTML = '<b>Ayrıştırılmış Miks (B)</b>';
        if (window.flovaApp) window.flovaApp.showToast('Ayrıştırılmış stem miksi dinleniyor', 'info');
      }
    }
  }

  /* ====================================================================
     MIXER GAIN, PAN & SOLO / MUTE LOGIC
     ==================================================================== */
  setStemGain(key, gainVal) {
    if (!this.stems[key]) return;
    this.stems[key].gain = parseFloat(gainVal);
    this.updateStemGains();

    const label = document.getElementById(`stemGainVal_${key}`);
    if (label) {
      label.textContent = `${Math.round(gainVal * 100)}%`;
    }
  }

  setStemPan(key, panVal) {
    if (!this.stems[key]) return;
    const p = parseFloat(panVal);
    this.stems[key].pan = p;

    if (this.stems[key].pannerNode && this.engine.ctx) {
      this.stems[key].pannerNode.pan.setTargetAtTime(p, this.engine.ctx.currentTime, 0.02);
    }

    const label = document.getElementById(`stemPanVal_${key}`);
    if (label) {
      if (Math.abs(p) < 0.05) label.textContent = 'C';
      else if (p < 0) label.textContent = `L${Math.round(Math.abs(p) * 50)}`;
      else label.textContent = `R${Math.round(p * 50)}`;
    }
  }

  toggleSolo(key) {
    if (!this.stems[key]) return;
    this.stems[key].solo = !this.stems[key].solo;
    this.updateStemGains();
    this.updateMixerButtonVisuals();
  }

  toggleMute(key) {
    if (!this.stems[key]) return;
    this.stems[key].muted = !this.stems[key].muted;
    this.updateStemGains();
    this.updateMixerButtonVisuals();
  }

  setMasterGain(val) {
    this.masterGain = parseFloat(val);
    if (this.masterGainNode && this.engine.ctx && !this.isComparingOriginal) {
      this.masterGainNode.gain.setValueAtTime(this.masterGain, this.engine.ctx.currentTime);
    }
    if (this.origGainNode && this.engine.ctx && this.isComparingOriginal) {
      this.origGainNode.gain.setValueAtTime(this.masterGain, this.engine.ctx.currentTime);
    }
    const label = document.getElementById('stemMasterVolVal');
    if (label) {
      label.textContent = `${Math.round(this.masterGain * 100)}%`;
    }
  }

  updateStemGains() {
    const anySolo = this.getActiveStemKeys().some(k => this.stems[k].solo);
    const ctx = this.engine.ctx;

    for (const key of this.getActiveStemKeys()) {
      const stem = this.stems[key];
      if (stem.gainNode && ctx) {
        let target = stem.gain;
        if (stem.muted) {
          target = 0;
        } else if (anySolo && !stem.solo) {
          target = 0;
        }
        stem.gainNode.gain.setTargetAtTime(target, ctx.currentTime, 0.02);
      }
    }
  }

  updateMixerButtonVisuals() {
    for (const key of this.getActiveStemKeys()) {
      const stem = this.stems[key];
      const soloBtn = document.getElementById(`soloBtn_${key}`);
      const muteBtn = document.getElementById(`muteBtn_${key}`);
      if (soloBtn) {
        if (stem.solo) {
          soloBtn.classList.add('active-solo');
        } else {
          soloBtn.classList.remove('active-solo');
        }
      }
      if (muteBtn) {
        if (stem.muted) {
          muteBtn.classList.add('active-mute');
        } else {
          muteBtn.classList.remove('active-mute');
        }
      }
    }
  }

  getActiveStemKeys() {
    return Object.keys(this.stems).filter(k => this.stems[k].buffer !== null);
  }

  hasAnyStem() {
    return this.getActiveStemKeys().length > 0;
  }

  /* ====================================================================
     EXPORT OPTIONS: INDIVIDUAL WAV, ALL AS ZIP, CUSTOM MIX
     ==================================================================== */
  async downloadStem(key) {
    const stem = this.stems[key];
    if (!stem || !stem.buffer) return;

    const def = STEM_DEFS[key];
    const baseName = (this.sourceFileName || 'Sarki').replace(/\.[^/.]+$/, '');
    const filename = `${baseName}_${def.badge}.wav`;

    const wavBlob = AudioEncoders.bufferToWave(stem.buffer);
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

  async downloadStemsAsZip() {
    const activeKeys = this.getActiveStemKeys();
    if (activeKeys.length === 0) return;

    if (!window.JSZip) {
      if (window.flovaApp) window.flovaApp.showToast('JSZip kütüphanesi yükleniyor, sırayla indiriliyor...', 'info');
      await this.downloadAllStemsSequentially();
      return;
    }

    try {
      if (window.flovaApp) {
        window.flovaApp.showToast(`${activeKeys.length} Stem ZIP arşivi olarak paketleniyor...`, 'info');
      }

      const zip = new window.JSZip();
      const baseName = (this.sourceFileName || 'Sarki').replace(/\.[^/.]+$/, '');

      for (const key of activeKeys) {
        const stem = this.stems[key];
        const def = STEM_DEFS[key];
        const blob = AudioEncoders.bufferToWave(stem.buffer);
        zip.file(`${baseName}_${def.badge}.wav`, blob);
      }

      const zipBlob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
      const url = URL.createObjectURL(zipBlob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${baseName}_Stems_Paketi.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      if (window.flovaApp) {
        window.flovaApp.showToast(`"${baseName}_Stems_Paketi.zip" indirildi.`, 'success');
      }
    } catch (err) {
      console.error('ZIP oluşturma hatası:', err);
      await this.downloadAllStemsSequentially();
    }
  }

  async downloadAllStemsSequentially() {
    const activeKeys = this.getActiveStemKeys();
    for (let i = 0; i < activeKeys.length; i++) {
      const key = activeKeys[i];
      await this.downloadStem(key);
      await new Promise(r => setTimeout(r, 450));
    }
  }

  /* Render custom active mix based on faders & solo/mute */
  async exportCustomMix() {
    const activeKeys = this.getActiveStemKeys();
    if (activeKeys.length === 0) return;

    try {
      if (window.flovaApp) {
        window.flovaApp.showToast('Özel miksiniz render ediliyor...', 'info');
      }

      const anySolo = activeKeys.some(k => this.stems[k].solo);
      const sampleRate = this.stems.vocals.buffer ? this.stems.vocals.buffer.sampleRate : 44100;
      const numFrames = Math.ceil(this.duration * sampleRate);

      const offlineCtx = new OfflineAudioContext(2, numFrames, sampleRate);

      let activeCount = 0;
      for (const key of activeKeys) {
        const stem = this.stems[key];
        let effectiveGain = stem.gain;
        if (stem.muted || (anySolo && !stem.solo)) {
          effectiveGain = 0;
        }

        if (effectiveGain > 0.001) {
          activeCount++;
          const src = offlineCtx.createBufferSource();
          src.buffer = stem.buffer;

          const gainNode = offlineCtx.createGain();
          gainNode.gain.value = effectiveGain;

          if (offlineCtx.createStereoPanner) {
            const panner = offlineCtx.createStereoPanner();
            panner.pan.value = stem.pan || 0;
            src.connect(gainNode);
            gainNode.connect(panner);
            panner.connect(offlineCtx.destination);
          } else {
            src.connect(gainNode);
            gainNode.connect(offlineCtx.destination);
          }

          src.start(0);
        }
      }

      if (activeCount === 0) {
        if (window.flovaApp) window.flovaApp.showToast('Tüm kanallar sessizde, aktarılacak ses yok!', 'error');
        return;
      }

      const renderedBuffer = await offlineCtx.startRendering();

      // Determine smart title
      const baseName = (this.sourceFileName || 'Sarki').replace(/\.[^/.]+$/, '');
      let mixType = 'Ozel_Miks';

      if (this.stems.vocals.buffer && (this.stems.vocals.muted || (anySolo && !this.stems.vocals.solo))) {
        mixType = 'Karaoke_Altyapi';
      } else if (this.stems.drums.buffer && (this.stems.drums.muted || (anySolo && !this.stems.drums.solo))) {
        mixType = 'Davulsuz_Drumless';
      } else if (this.stems.guitar.buffer && (this.stems.guitar.muted || (anySolo && !this.stems.guitar.solo))) {
        mixType = 'Gitarsiz_Altyapi';
      } else if (this.stems.piano.buffer && (this.stems.piano.muted || (anySolo && !this.stems.piano.solo))) {
        mixType = 'Piyanosuz_Altyapi';
      } else if (this.stems.bass.buffer && (this.stems.bass.muted || (anySolo && !this.stems.bass.solo))) {
        mixType = 'Bassiz_Altyapi';
      }

      const exportFileName = `${baseName}_${mixType}.wav`;

      const wavBlob = AudioEncoders.bufferToWave(renderedBuffer);
      const url = URL.createObjectURL(wavBlob);
      const a = document.createElement('a');
      a.href = url;
      a.download = exportFileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      if (window.flovaApp) {
        window.flovaApp.showToast(`"${exportFileName}" başarıyla kaydedildi!`, 'success');
      }
    } catch (err) {
      console.error('Özel miks hatası:', err);
      if (window.flovaApp) {
        window.flovaApp.showToast(`Miks render hatası: ${err.message || err}`, 'error');
      }
    }
  }

  sendToEditor(key) {
    const stem = this.stems[key];
    if (!stem || !stem.buffer) return;

    const def = STEM_DEFS[key];
    const baseName = (this.sourceFileName || 'Sarki').replace(/\.[^/.]+$/, '');
    const trackName = `${baseName}_${def.badge}.wav`;

    this.stop();
    this.engine.currentFileName = trackName;
    this.engine.setBuffer(stem.buffer, true);

    if (window.flovaApp) {
      window.flovaApp.switchMode('editor');
      window.flovaApp.showToast(`"${trackName}" Kesici & Düzenleyiciye aktarıldı!`, 'success');
    }
  }

  /* ====================================================================
     WAVEFORM RENDERING
     ==================================================================== */
  drawAllWaveforms() {
    for (const key of this.getActiveStemKeys()) {
      this.drawStemWaveform(key);
    }
  }

  drawStemWaveform(key) {
    const stem = this.stems[key];
    const canvas = document.getElementById(`waveform_${key}`);
    if (!canvas) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;

    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    const width = rect.width;
    const height = rect.height;

    ctx.clearRect(0, 0, width, height);

    if (!stem.buffer) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
      ctx.fillRect(0, height / 2 - 1, width, 2);
      return;
    }

    const def = STEM_DEFS[key];
    const data = stem.buffer.getChannelData(0);
    const step = Math.ceil(data.length / width);
    const amp = height / 2;

    const grad = ctx.createLinearGradient(0, 0, 0, height);
    grad.addColorStop(0, def.gradientStart);
    grad.addColorStop(1, def.gradientEnd);
    ctx.fillStyle = grad;

    for (let i = 0; i < width; i++) {
      let min = 1.0;
      let max = -1.0;
      const startIdx = i * step;
      const endIdx = Math.min(startIdx + step, data.length);

      for (let j = startIdx; j < endIdx; j += 4) {
        const val = data[j];
        if (val < min) min = val;
        if (val > max) max = val;
      }

      if (max < min) {
        min = 0;
        max = 0;
      }

      const y1 = Math.max(0, (1 + min) * amp);
      const y2 = Math.min(height, (1 + max) * amp);
      const barHeight = Math.max(2, y2 - y1);

      ctx.fillRect(i, y1, 1.2, barHeight);
    }

    this.drawStemPlayhead(key);
  }

  drawAllPlayheads() {
    for (const key of this.getActiveStemKeys()) {
      this.drawStemPlayhead(key);
    }
  }

  drawStemPlayhead(key) {
    const canvas = document.getElementById(`overlay_${key}`);
    if (!canvas) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;

    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    const width = rect.width;
    const height = rect.height;

    ctx.clearRect(0, 0, width, height);

    if (this.duration <= 0) return;

    const progress = Math.max(0, Math.min(this.currentTime / this.duration, 1));
    const playheadX = progress * width;

    // Played region dim overlay
    ctx.fillStyle = 'rgba(255, 255, 255, 0.04)';
    ctx.fillRect(0, 0, playheadX, height);

    // Glowing Neon Playhead Line
    ctx.strokeStyle = '#f43f5e';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(playheadX, 0);
    ctx.lineTo(playheadX, height);
    ctx.stroke();

    // Playhead handle
    ctx.fillStyle = '#f43f5e';
    ctx.beginPath();
    ctx.arc(playheadX, 5, 4, 0, Math.PI * 2);
    ctx.fill();
  }

  /* ====================================================================
     UI RENDERING
     ==================================================================== */
  render() {
    const is6s = this.separationMode === '6s';
    const activeKeys = this.hasAnyStem() ? this.getActiveStemKeys() : (is6s ? Object.keys(this.stems) : ['vocals', 'drums', 'bass', 'other']);

    this.container.innerHTML = `
      <div class="stem-splitter-layout">
        
        <!-- Header Bar -->
        <div class="stem-header-bar">
          <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">
            <div style="font-size: 1.15rem; font-weight: 700; display: flex; align-items: center; gap: 8px;">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align: middle;"><line x1="4" y1="21" x2="4" y2="14"></line><line x1="4" y1="10" x2="4" y2="3"></line><line x1="12" y1="21" x2="12" y2="12"></line><line x1="12" y1="8" x2="12" y2="3"></line><line x1="20" y1="21" x2="20" y2="16"></line><line x1="20" y1="12" x2="20" y2="3"></line></svg>
              Çok Kanallı Kök (Stem) Ayırıcı
              <span class="badge-pro" style="background: rgba(168, 85, 247, 0.15); color: #c084fc; border: 1px solid rgba(168, 85, 247, 0.3); font-weight: 600; padding: 2px 8px; border-radius: 4px; font-size: 0.72rem; letter-spacing: 0.05em;">${is6s ? '6-STEM PRO' : '4-STEM'}</span>
            </div>
            ${this.sourceBuffer ? `
              <div class="track-info-pill">
                <span class="track-name">${this.sourceFileName}</span>
                <span style="font-size: 0.75rem; color: var(--text-dim); margin-left: 6px;">(${this.formatTime(this.duration)})</span>
              </div>
            ` : ''}
          </div>

          <div style="display: flex; gap: 6px; align-items: center; flex-wrap: wrap;">
            <!-- Mode Switcher Pill -->
            <div style="display: flex; align-items: center; gap: 3px; background: rgba(255,255,255,0.05); padding: 3px 5px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.08);">
              <button class="btn ${is6s ? 'btn-primary' : 'btn-secondary'} btn-sm" style="padding: 2px 8px; font-size: 0.74rem;" 
                onclick="window.flovaStemSplitter.setSeparationMode('6s')">
                6-Stem Pro
              </button>
              <button class="btn ${!is6s ? 'btn-primary' : 'btn-secondary'} btn-sm" style="padding: 2px 8px; font-size: 0.74rem;" 
                onclick="window.flovaStemSplitter.setSeparationMode('4s')">
                4-Stem
              </button>
            </div>

            ${this.engine.currentBuffer && this.engine.currentBuffer !== this.sourceBuffer ? `
              <button id="stemUseEditorTrackBtn" class="btn btn-emerald btn-sm" onclick="window.flovaStemSplitter.loadBuffer(window.flovaApp.engine.currentBuffer, window.flovaApp.engine.currentFileName || 'Duzenleyici_Parcasi')" style="display: inline-flex; align-items: center; gap: 5px;">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
                Editörden Al
              </button>
            ` : ''}
            
            <label class="btn btn-primary btn-sm" style="cursor: pointer; display: inline-flex; align-items: center; gap: 5px;">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>
              Dosya Aç
              <input type="file" id="stemFileInput" accept="audio/*" style="display: none;" />
            </label>

            ${this.hasAnyStem() ? `
              <button id="stemABBtn" class="btn btn-secondary btn-sm" onclick="window.flovaStemSplitter.toggleABComparison()" title="Orijinal ile miksi kıyasla" style="display: inline-flex; align-items: center; gap: 5px;">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polygon points="12 8 8 12 12 16 12 8"></polygon></svg>
                A/B: Miks
              </button>

              <button class="btn btn-primary btn-sm" onclick="window.flovaStemSplitter.exportCustomMix()" title="Mikser ayarlarına göre miksi kaydet" style="background: linear-gradient(135deg, #4f46e5, #7c3aed); border: none; display: inline-flex; align-items: center; gap: 5px;">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
                Miks İndir
              </button>

              <button class="btn btn-emerald btn-sm" onclick="window.flovaStemSplitter.downloadStemsAsZip()" title="Tüm kökleri tek bir ZIP dosyasında indir" style="display: inline-flex; align-items: center; gap: 5px;">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="21 8 21 21 3 21 3 8"></polyline><rect x="1" y="3" width="22" height="5"></rect><line x1="10" y1="12" x2="14" y2="12"></line></svg>
                ZIP İndir
              </button>
            ` : ''}
          </div>
        </div>

        <!-- AI Progress Container -->
        <div id="stemProgressBox" style="${this.isProcessing ? 'display: block;' : 'display: none;'} margin-bottom: 16px;">
          ${this.isProcessing && this.currentProgress ? this.getProgressHtml(this.currentProgress.pct, this.currentProgress.statusText) : ''}
        </div>

        <!-- Master Transport & Time Bar -->
        ${this.hasAnyStem() ? `
          <div class="stem-transport-card glass-card">
            <div style="display: flex; align-items: center; gap: 14px;">
              <button id="stemStopBtn" class="control-circle-btn" onclick="window.flovaStemSplitter.stop()" title="Başa Dön (00:00)">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                  <rect x="4" y="4" width="16" height="16" rx="2"></rect>
                </svg>
              </button>
              
              <button id="stemPlayBtn" class="play-main-btn" onclick="window.flovaStemSplitter.togglePlay()" title="Oynat / Duraklat (Space)">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
                  <polygon points="6 3 20 12 6 21 6 3"></polygon>
                </svg>
              </button>

              <div class="time-display-group">
                <span class="time-current" id="stemCurrentTime">00:00.000</span>
                <span class="time-total" id="stemTotalTime">/ ${this.formatTime(this.duration)}</span>
              </div>
            </div>

            <!-- Master Scrub Slider -->
            <div style="flex: 1; min-width: 180px; display: flex; align-items: center; gap: 10px;">
              <input type="range" id="stemScrubBar" class="studio-slider" min="0" max="${this.duration || 100}" step="0.05" value="0"
                oninput="window.flovaStemSplitter.seek(parseFloat(this.value))" style="width: 100%;" />
            </div>

            <!-- Master Output Volume -->
            <div style="display: flex; align-items: center; gap: 8px; border-left: 1px solid rgba(255,255,255,0.08); padding-left: 14px;">
              <span style="font-size: 0.8rem; color: var(--text-muted); font-weight: 600; display: inline-flex; align-items: center; gap: 4px;">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>
                Çıkış:
              </span>
              <span id="stemMasterVolVal" class="effect-val-pill">100%</span>
              <input type="range" class="studio-slider" min="0" max="1.5" step="0.05" value="${this.masterGain}"
                oninput="window.flovaStemSplitter.setMasterGain(this.value)" style="width: 85px;" />
            </div>
          </div>
        ` : ''}

        <!-- Empty State Dropzone -->
        ${!this.sourceBuffer && !this.isProcessing ? `
          <div id="stemDropZone" class="drop-zone" style="margin-top: 10px;">
            <div class="drop-zone-icon" style="color: #a855f7;">
              <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M9 18V5l12-2v13"></path>
                <circle cx="6" cy="18" r="3"></circle>
                <circle cx="18" cy="16" r="3"></circle>
              </svg>
            </div>
            <h2 class="drop-zone-title">Ses Dosyası Bırakın veya Seçin</h2>
            <p class="drop-zone-sub">MP3, WAV, FLAC, M4A, OGG</p>
          </div>
        ` : ''}

        <!-- Stem Mixer Lanes -->
        ${this.hasAnyStem() ? `
          <div class="stem-lanes-container">
            ${activeKeys.map(k => this.renderStemLane(k)).join('')}
          </div>
        ` : ''}

      </div>
    `;

    this.bindEvents();
  }

  renderStemLane(key) {
    const def = STEM_DEFS[key];
    if (!def) return '';
    const stem = this.stems[key];

    let panText = 'C';
    if (stem.pan < -0.05) panText = `L${Math.round(Math.abs(stem.pan) * 50)}`;
    else if (stem.pan > 0.05) panText = `R${Math.round(stem.pan * 50)}`;

    return `
      <div class="stem-lane glass-card" style="border-left: 4px solid ${def.color};">
        
        <!-- Track Header Strip -->
        <div class="stem-lane-header">
          <div class="stem-lane-info">
            <span class="stem-lane-badge" style="background: ${def.color}22; color: ${def.color}; border: 1px solid ${def.color}44;">
              ${def.icon} ${def.badge}
            </span>
            <span class="stem-lane-title">${def.name}</span>
          </div>

          <!-- Channel Controls: Solo, Mute, Volume, Pan, Download, Edit -->
          <div class="stem-lane-controls">
            
            <!-- Solo / Mute -->
            <button id="soloBtn_${key}" class="stem-btn-sm ${stem.solo ? 'active-solo' : ''}" 
              onclick="window.flovaStemSplitter.toggleSolo('${key}')" title="Solo">
              S
            </button>
            <button id="muteBtn_${key}" class="stem-btn-sm ${stem.muted ? 'active-mute' : ''}" 
              onclick="window.flovaStemSplitter.toggleMute('${key}')" title="Mute">
              M
            </button>

            <!-- Volume Fader -->
            <div class="stem-fader-group" title="Kanal Ses Düzeyi">
              <span style="font-size: 0.72rem; color: var(--text-dim);">Vol</span>
              <input type="range" class="studio-slider stem-slider" min="0" max="1.5" step="0.05" value="${stem.gain}"
                oninput="window.flovaStemSplitter.setStemGain('${key}', this.value)" />
              <span id="stemGainVal_${key}" class="stem-gain-val">${Math.round(stem.gain * 100)}%</span>
            </div>

            <!-- Stereo Pan Slider -->
            <div class="stem-fader-group" title="Stereo Pan (Sol / Sağ)">
              <span style="font-size: 0.72rem; color: var(--text-dim);">Pan</span>
              <input type="range" class="studio-slider stem-slider" min="-1" max="1" step="0.05" value="${stem.pan || 0}"
                oninput="window.flovaStemSplitter.setStemPan('${key}', this.value)" style="width: 55px !important;" />
              <span id="stemPanVal_${key}" class="stem-gain-val" style="min-width: 24px;">${panText}</span>
            </div>

            <!-- Action Buttons -->
            <button class="btn btn-secondary btn-sm" onclick="window.flovaStemSplitter.sendToEditor('${key}')" title="Editöre aktar" style="display: inline-flex; align-items: center; gap: 5px;">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="6" cy="6" r="3"></circle><circle cx="6" cy="18" r="3"></circle><line x1="20" y1="4" x2="8.12" y2="15.88"></line><line x1="14.47" y1="14.48" x2="20" y2="20"></line><line x1="8.12" y1="8.12" x2="12" y2="12"></line></svg>
              Editör
            </button>
            
            <button class="btn btn-primary btn-sm" onclick="window.flovaStemSplitter.downloadStem('${key}')" style="background: ${def.color}; border-color: ${def.color}; display: inline-flex; align-items: center; gap: 5px;" title="WAV olarak indir">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
              İndir
            </button>

          </div>
        </div>

        <!-- Waveform Canvas Display -->
        <div class="stem-waveform-box" onclick="window.flovaStemSplitter.handleCanvasClick(event, '${key}')">
          <canvas id="waveform_${key}" class="stem-canvas"></canvas>
          <canvas id="overlay_${key}" class="stem-overlay-canvas"></canvas>
        </div>

      </div>
    `;
  }

  getProgressHtml(pct, statusText) {
    return `
      <div class="glass-card" style="padding: 16px 20px; border-left: 4px solid #a855f7; background: rgba(18, 23, 38, 0.9);">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
          <div style="display: flex; align-items: center; gap: 10px;">
            <div class="loading-spinner" style="border-top-color: #a855f7;"></div>
            <span style="font-weight: 700; font-size: 0.92rem; color: #f8fafc;">Çok Kanallı Stem Ayrıştırma İşlemi</span>
          </div>
          <span style="font-family: var(--font-mono); font-weight: 700; color: #a855f7; font-size: 0.95rem;">%${pct}</span>
        </div>
        <div class="progress-bar-container" style="height: 9px; background: rgba(255,255,255,0.08); border-radius: 5px; overflow: hidden; margin-bottom: 8px;">
          <div class="progress-bar-fill" style="width: ${pct}%; height: 100%; background: linear-gradient(90deg, #6366f1, #a855f7, #38bdf8); transition: width 0.3s ease;"></div>
        </div>
        <div class="progress-status-text" style="color: var(--text-muted); font-size: 0.8rem; font-family: var(--font-mono);">
          ${statusText}
        </div>
      </div>
    `;
  }

  renderProgress(pct, statusText) {
    this.currentProgress = { pct, statusText };
    const box = document.getElementById('stemProgressBox');
    if (!box) return;
    box.style.display = 'block';
    box.innerHTML = this.getProgressHtml(pct, statusText);
  }

  bindEvents() {
    const fileInput = document.getElementById('stemFileInput');
    if (fileInput) {
      fileInput.addEventListener('click', () => {
        fileInput.value = '';
      });
      fileInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        await this.handleUserFile(file);
      });
    }

    const dropZone = document.getElementById('stemDropZone');
    if (dropZone) {
      dropZone.addEventListener('click', () => {
        if (fileInput) {
          fileInput.value = '';
          fileInput.click();
        }
      });

      ['dragenter', 'dragover'].forEach(name => {
        dropZone.addEventListener(name, (e) => {
          e.preventDefault();
          e.stopPropagation();
          dropZone.classList.add('drop-zone-drag', 'dragover');
        });
      });

      ['dragleave', 'drop'].forEach(name => {
        dropZone.addEventListener(name, (e) => {
          e.preventDefault();
          e.stopPropagation();
          dropZone.classList.remove('drop-zone-drag', 'dragover');
        });
      });

      dropZone.addEventListener('drop', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropZone.classList.remove('drop-zone-drag', 'dragover');
        const file = e.dataTransfer.files[0];
        if (file && (file.type.startsWith('audio/') || /\.(mp3|wav|ogg|flac|m4a|aac|wma|aiff)$/i.test(file.name))) {
          await this.handleUserFile(file);
        }
      });
    }
  }

  async handleUserFile(file) {
    try {
      this.engine.ensureContext();
      const ab = await file.arrayBuffer();
      const decoded = await this.engine.ctx.decodeAudioData(ab.slice(0));
      await this.loadBuffer(decoded, file.name, file);
    } catch (err) {
      console.error('Ses yükleme hatası:', err);
      if (window.flovaApp) {
        window.flovaApp.showToast(`Dosya okunamadı: ${err.message || err}`, 'error');
      }
    }
  }

  handleCanvasClick(event, key) {
    const canvas = document.getElementById(`overlay_${key}`);
    if (!canvas || this.duration <= 0) return;
    const rect = canvas.getBoundingClientRect();
    const clickX = event.clientX - rect.left;
    const pct = Math.max(0, Math.min(clickX / rect.width, 1));
    this.seek(pct * this.duration);
  }

  updatePlayBtnState() {
    const playBtn = document.getElementById('stemPlayBtn');
    if (!playBtn) return;
    if (this.isPlaying) {
      playBtn.classList.add('playing');
      playBtn.innerHTML = `
        <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
          <rect x="6" y="4" width="4" height="16" rx="1"></rect>
          <rect x="14" y="4" width="4" height="16" rx="1"></rect>
        </svg>
      `;
    } else {
      playBtn.classList.remove('playing');
      playBtn.innerHTML = `
        <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
          <polygon points="6 3 20 12 6 21 6 3"></polygon>
        </svg>
      `;
    }
  }

  updateTimeDisplays() {
    const curElem = document.getElementById('stemCurrentTime');
    if (curElem) curElem.textContent = this.formatTime(this.currentTime);

    const scrub = document.getElementById('stemScrubBar');
    if (scrub && !scrub.matches(':active')) {
      scrub.value = this.currentTime;
    }
  }

  formatTime(seconds) {
    if (isNaN(seconds) || seconds < 0) seconds = 0;
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 1000);
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
  }
}
