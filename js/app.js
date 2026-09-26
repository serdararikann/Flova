/* ====================================================================
   FLOVA AUDIO STUDIO - MAIN APPLICATION CONTROLLER
   Event coordination, AudioEngine integration, Canvas syncing & UI State
   ==================================================================== */

import { AudioEngine } from './audio/audio-engine.js';
import { WaveformCanvas } from './ui/waveform-canvas.js';
import { VisualizerCanvas } from './ui/visualizer-canvas.js';
import { MergerUI } from './ui/merger-ui.js';
import { VocalSplitterUI } from './ui/vocal-splitter-ui.js';
import { StemSplitterUI } from './ui/stem-splitter-ui.js';
import { ExportModal } from './ui/export-modal.js';

class FlovaStudioApp {
  constructor() {
    this.engine = new AudioEngine();
    this.activeMode = 'editor'; // 'editor' | 'merger' | 'vocal-splitter' | 'stem-splitter'

    this.selectionStart = 0;
    this.selectionEnd = 0;

    this.initDOM();
    this.initComponents();
    this.bindEvents();
    this.bindKeyboardShortcuts();
  }

  initDOM() {
    // Top Tabs
    this.tabEditor = document.getElementById('tabEditor');
    this.tabMerger = document.getElementById('tabMerger');
    this.tabVocalSplitter = document.getElementById('tabVocalSplitter');
    this.tabStemSplitter = document.getElementById('tabStemSplitter');
    this.editorView = document.getElementById('editorView');
    this.mergerView = document.getElementById('mergerView');
    this.vocalSplitterView = document.getElementById('vocalSplitterView');
    this.stemSplitterView = document.getElementById('stemSplitterView');

    // Uploader / Empty State
    this.dropZone = document.getElementById('dropZone');
    this.fileInput = document.getElementById('fileInput');
    this.loadDemoBtn = document.getElementById('loadDemoBtn');
    this.openFileBtn = document.getElementById('openFileBtn');

    // Track Info
    this.trackWorkspace = document.getElementById('trackWorkspace');
    this.trackNameElem = document.getElementById('trackName');
    this.trackDurationElem = document.getElementById('trackDuration');
    this.trackSpecsElem = document.getElementById('trackSpecs');

    // Transport Controls
    this.playBtn = document.getElementById('playBtn');
    this.stopBtn = document.getElementById('stopBtn');
    this.loopBtn = document.getElementById('loopBtn');
    this.currentTimeElem = document.getElementById('currentTimeDisplay');
    this.totalTimeElem = document.getElementById('totalTimeDisplay');

    // Action Buttons
    this.trimBtn = document.getElementById('trimBtn');
    this.cutBtn = document.getElementById('cutBtn');
    this.silenceBtn = document.getElementById('silenceBtn');
    this.reverseBtn = document.getElementById('reverseBtn');
    this.fadeInBtn = document.getElementById('fadeInBtn');
    this.fadeOutBtn = document.getElementById('fadeOutBtn');
    this.undoBtn = document.getElementById('undoBtn');
    this.redoBtn = document.getElementById('redoBtn');

    // Manual time inputs
    this.selStartInput = document.getElementById('selStartInput');
    this.selEndInput = document.getElementById('selEndInput');
    this.selDurationInput = document.getElementById('selDurationInput');
    this.setStartToCurrentBtn = document.getElementById('setStartToCurrentBtn');
    this.setEndToCurrentBtn = document.getElementById('setEndToCurrentBtn');

    // Export Trigger
    this.exportBtn = document.getElementById('exportBtn');
    this.exportModalContainer = document.getElementById('exportModal');

    // Toast Container
    this.toastContainer = document.getElementById('toastContainer');
  }

  initComponents() {
    // 1. Waveform Canvas
    const waveCanvas = document.getElementById('waveformCanvas');
    const overlayCanvas = document.getElementById('overlayCanvas');
    this.waveform = new WaveformCanvas(waveCanvas, overlayCanvas, {
      onSelectionChange: (start, end) => this.handleSelectionChange(start, end),
      onSeek: (time) => this.engine.seek(time)
    });

    // 2. Visualizer Canvas
    const visCanvas = document.getElementById('visualizerCanvas');
    this.visualizer = new VisualizerCanvas(visCanvas, null);

    // 3. Merger UI
    const mergerContainer = document.getElementById('mergerContainer');
    this.merger = new MergerUI(mergerContainer, this.engine, {
      onMerged: (mergedBuffer, name) => {
        this.engine.currentFileName = name;
        this.engine.setBuffer(mergedBuffer, true);
        this.switchMode('editor');
        this.showToast('Parçalar başarıyla birleştirildi ve düzenleyiciye aktarıldı!', 'success');
      }
    });
    window.flovaMerger = this.merger;

    // 4. Vocal Splitter UI
    const splitterContainer = document.getElementById('vocalSplitterContainer');
    this.vocalSplitter = new VocalSplitterUI(splitterContainer, this.engine);
    window.flovaSplitter = this.vocalSplitter;

    // 5. 4-Stem Splitter UI
    const stemContainer = document.getElementById('stemSplitterContainer');
    this.stemSplitter = new StemSplitterUI(stemContainer, this.engine);
    window.flovaStemSplitter = this.stemSplitter;

    // 6. Export Modal
    this.exportModal = new ExportModal(this.exportModalContainer, this.engine);

    // 7. Audio Engine callbacks
    this.engine.onBufferChange = (buffer) => this.handleBufferChange(buffer);
    this.engine.onTimeUpdate = (time) => this.handleTimeUpdate(time);
    this.engine.onPlayStateChange = (isPlaying) => this.handlePlayStateChange(isPlaying);
  }

  bindEvents() {
    // Mode Switch
    this.tabEditor.addEventListener('click', () => this.switchMode('editor'));
    this.tabMerger.addEventListener('click', () => this.switchMode('merger'));
    this.tabVocalSplitter.addEventListener('click', () => this.switchMode('vocal-splitter'));
    this.tabStemSplitter.addEventListener('click', () => this.switchMode('stem-splitter'));

    // File Upload & Demo
    this.loadDemoBtn.addEventListener('click', async () => {
      this.showToast('Demo müzik sentezleniyor...', 'info');
      await this.engine.loadDemoTrack();
      this.visualizer.setAnalyser(this.engine.analyser);
      this.showToast('Demo müzik yüklendi! Şimdi düzenleyebilirsiniz.', 'success');
    });

    this.openFileBtn.addEventListener('click', () => this.fileInput.click());
    if (this.dropZone) {
      this.dropZone.addEventListener('click', () => this.fileInput.click());
      this.setupDropZone(this.dropZone);
    }

    this.fileInput.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (file) {
        this.showToast(`"${file.name}" yükleniyor...`, 'info');
        try {
          await this.engine.loadFile(file);
          this.visualizer.setAnalyser(this.engine.analyser);
          this.showToast('Ses dosyası yüklendi!', 'success');
        } catch (err) {
          console.error(err);
          this.showToast('Ses dosyası açılamadı veya biçim desteklenmiyor.', 'error');
        }
      }
    });

    // Transport Controls
    this.playBtn.addEventListener('click', () => {
      this.engine.ensureContext();
      this.visualizer.setAnalyser(this.engine.analyser);
      if (this.engine.isPlaying) {
        this.engine.pause();
      } else {
        this.engine.play();
      }
    });

    this.stopBtn.addEventListener('click', () => this.engine.stop());

    this.loopBtn.addEventListener('click', () => {
      this.engine.isLooping = !this.engine.isLooping;
      this.engine.useLoopRegion = this.engine.isLooping;
      this.loopBtn.classList.toggle('active', this.engine.isLooping);
      this.showToast(this.engine.isLooping ? 'Döngü (Loop) Açık' : 'Döngü Kapalı', 'info');
    });

    // Edit Operations
    this.trimBtn.addEventListener('click', () => {
      if (!this.engine.currentBuffer) return;
      this.engine.trimCurrent(this.selectionStart, this.selectionEnd);
      this.showToast('Seçili alan kırpıldı!', 'success');
    });

    this.cutBtn.addEventListener('click', () => {
      if (!this.engine.currentBuffer) return;
      if (this.selectionEnd <= this.selectionStart || (this.selectionStart === 0 && this.selectionEnd === 0)) {
        this.showToast('Lütfen önce silmek istediğiniz alanı dalga formu üzerinden seçin.', 'info');
        return;
      }
      this.engine.cutOutCurrent(this.selectionStart, this.selectionEnd);
      this.selectionStart = 0;
      this.selectionEnd = 0;
      this.waveform.setSelection(0, 0);
      this.showToast('Seçili alan başarıyla silindi!', 'success');
    });

    this.silenceBtn.addEventListener('click', () => {
      if (!this.engine.currentBuffer) return;
      this.engine.silenceCurrent(this.selectionStart, this.selectionEnd);
      this.showToast('Seçili alan sessize alındı!', 'success');
    });

    this.reverseBtn.addEventListener('click', () => {
      if (!this.engine.currentBuffer) return;
      this.engine.reverseCurrent();
      this.showToast('Ses ters çevrildi!', 'success');
    });

    this.fadeInBtn.addEventListener('click', () => {
      if (!this.engine.currentBuffer) return;
      const dur = Math.min(3.0, this.engine.currentBuffer.duration * 0.25);
      this.engine.applyFadeToCurrent(dur, 0);
      this.showToast(`${dur.toFixed(1)} sn Fade-In uygulandı!`, 'success');
    });

    this.fadeOutBtn.addEventListener('click', () => {
      if (!this.engine.currentBuffer) return;
      const dur = Math.min(3.0, this.engine.currentBuffer.duration * 0.25);
      this.engine.applyFadeToCurrent(0, dur);
      this.showToast(`${dur.toFixed(1)} sn Fade-Out uygulandı!`, 'success');
    });

    // Undo / Redo
    this.undoBtn.addEventListener('click', () => {
      if (this.engine.undo()) {
        this.showToast('Geri alındı (Undo)', 'info');
      }
    });

    this.redoBtn.addEventListener('click', () => {
      if (this.engine.redo()) {
        this.showToast('Yinelendi (Redo)', 'info');
      }
    });

    // Time input markers
    this.setStartToCurrentBtn.addEventListener('click', () => {
      const cur = this.engine.getCurrentTime();
      this.selectionStart = cur;
      this.waveform.setSelection(this.selectionStart, this.selectionEnd);
    });

    this.setEndToCurrentBtn.addEventListener('click', () => {
      const cur = this.engine.getCurrentTime();
      this.selectionEnd = cur;
      this.waveform.setSelection(this.selectionStart, this.selectionEnd);
    });

    this.selStartInput.addEventListener('change', () => {
      this.selectionStart = this.parseTimeString(this.selStartInput.value);
      this.waveform.setSelection(this.selectionStart, this.selectionEnd);
    });

    this.selEndInput.addEventListener('change', () => {
      this.selectionEnd = this.parseTimeString(this.selEndInput.value);
      this.waveform.setSelection(this.selectionStart, this.selectionEnd);
    });

    // Export Modal Open
    this.exportBtn.addEventListener('click', () => {
      if (!this.engine.currentBuffer) {
        this.showToast('Lütfen önce bir ses dosyası yükleyin veya demo oluşturun.', 'error');
        return;
      }
      this.exportModal.open(this.selectionStart, this.selectionEnd);
    });

    // Bind Effects Rack Controls
    this.bindEffectsControls();
  }

  bindEffectsControls() {
    this.engine.ensureContext();
    const fx = this.engine.effectsRack;

    // Master Volume
    const masterVolSlider = document.getElementById('masterVolumeSlider');
    const masterVolVal = document.getElementById('masterVolumeVal');
    masterVolSlider.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      fx.setVolume(val);
      masterVolVal.textContent = Math.round(val * 100) + '%';
    });

    // Playback Speed / Pitch
    const speedSlider = document.getElementById('speedSlider');
    const speedVal = document.getElementById('speedVal');
    speedSlider.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      this.engine.setPlaybackRate(val);
      speedVal.textContent = val.toFixed(2) + 'x';
    });

    // Stereo Panning
    const panSlider = document.getElementById('panSlider');
    const panVal = document.getElementById('panVal');
    panSlider.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      fx.setPan(val);
      panVal.textContent = val < 0 ? `Sol ${Math.abs(Math.round(val * 100))}%` : val > 0 ? `Sağ ${Math.round(val * 100)}%` : 'Merkez';
    });

    // 8D Audio Toggle
    const autoPanCheckbox = document.getElementById('autoPanCheckbox');
    autoPanCheckbox.addEventListener('change', (e) => {
      fx.setAutoPan(e.target.checked);
      this.showToast(e.target.checked ? '8D Audio (Auto-Pan) Aktif' : '8D Audio Pasif', 'info');
    });

    // Reverb Sliders
    const reverbWetSlider = document.getElementById('reverbWetSlider');
    const reverbWetVal = document.getElementById('reverbWetVal');
    const reverbDecaySlider = document.getElementById('reverbDecaySlider');
    const reverbDecayVal = document.getElementById('reverbDecayVal');

    reverbWetSlider.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      fx.setReverb(val, undefined);
      reverbWetVal.textContent = Math.round(val * 100) + '%';
    });

    reverbDecaySlider.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      fx.setReverb(undefined, val);
      reverbDecayVal.textContent = val.toFixed(1) + ' sn';
    });

    // Echo Sliders
    const echoWetSlider = document.getElementById('echoWetSlider');
    const echoWetVal = document.getElementById('echoWetVal');
    const echoTimeSlider = document.getElementById('echoTimeSlider');
    const echoTimeVal = document.getElementById('echoTimeVal');

    echoWetSlider.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      fx.setEcho(val, undefined, val * 0.6);
      echoWetVal.textContent = Math.round(val * 100) + '%';
    });

    echoTimeSlider.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      fx.setEcho(undefined, val, undefined);
      echoTimeVal.textContent = val.toFixed(2) + ' sn';
    });

    // 5-Band EQ Sliders
    const bands = ['band60', 'band250', 'band1000', 'band4000', 'band12000'];
    bands.forEach(band => {
      const slider = document.getElementById(`eq_${band}`);
      if (slider) {
        slider.addEventListener('input', (e) => {
          const val = parseFloat(e.target.value);
          fx.setEQBand(band, val);
        });
      }
    });

    // EQ Presets
    const presetChips = document.querySelectorAll('.preset-chip');
    presetChips.forEach(chip => {
      chip.addEventListener('click', () => {
        const preset = chip.dataset.preset;
        const target = fx.applyEQPreset(preset);
        bands.forEach(band => {
          const sl = document.getElementById(`eq_${band}`);
          if (sl && target[band] !== undefined) {
            sl.value = target[band];
          }
        });
        this.showToast(`EQ Hazır Ayar: ${chip.textContent}`, 'info');
      });
    });
  }

  setupDropZone(zone) {
    ['dragenter', 'dragover'].forEach(name => {
      zone.addEventListener(name, (e) => {
        e.preventDefault();
        zone.classList.add('dragover');
      });
    });

    ['dragleave', 'drop'].forEach(name => {
      zone.addEventListener(name, (e) => {
        e.preventDefault();
        zone.classList.remove('dragover');
      });
    });

    zone.addEventListener('drop', async (e) => {
      const file = e.dataTransfer.files[0];
      if (file) {
        this.showToast(`"${file.name}" yükleniyor...`, 'info');
        try {
          await this.engine.loadFile(file);
          this.visualizer.setAnalyser(this.engine.analyser);
          this.showToast('Ses dosyası yüklendi!', 'success');
        } catch (err) {
          console.error(err);
          this.showToast('Ses dosyası açılamadı.', 'error');
        }
      }
    });
  }

  switchMode(mode) {
    this.activeMode = mode;
    if (this.engine.isPlaying) {
      this.engine.pause();
    }
    if (this.merger && this.merger.playback && this.merger.playback.isPlaying) {
      this.merger.stopPlayback();
    }
    if (this.vocalSplitter && this.vocalSplitter.isPlaying) {
      this.vocalSplitter.pause();
    }
    if (this.stemSplitter && this.stemSplitter.isPlaying) {
      this.stemSplitter.pause();
    }

    // Reset tab active states
    this.tabEditor.classList.remove('active');
    this.tabMerger.classList.remove('active');
    this.tabVocalSplitter.classList.remove('active');
    this.tabStemSplitter.classList.remove('active');

    this.editorView.style.display = 'none';
    this.mergerView.style.display = 'none';
    this.vocalSplitterView.style.display = 'none';
    this.stemSplitterView.style.display = 'none';

    if (mode === 'editor') {
      this.tabEditor.classList.add('active');
      this.editorView.style.display = 'block';
      this.waveform.resize();
    } else if (mode === 'merger') {
      this.tabMerger.classList.add('active');
      this.mergerView.style.display = 'block';
      this.merger.render();
    } else if (mode === 'vocal-splitter') {
      this.tabVocalSplitter.classList.add('active');
      this.vocalSplitterView.style.display = 'block';
      this.vocalSplitter.render();

      // If a song is already loaded in editor, offer/auto-load into vocal splitter if not already loaded
      if (this.engine.currentBuffer && !this.vocalSplitter.sourceBuffer) {
        this.vocalSplitter.loadBuffer(this.engine.currentBuffer, this.engine.currentFileName || 'Parça');
      }
    } else if (mode === 'stem-splitter') {
      this.tabStemSplitter.classList.add('active');
      this.stemSplitterView.style.display = 'block';
      this.stemSplitter.render();

      // If a song is already loaded in editor, offer/auto-load into 4-stem splitter if not already loaded
      if (this.engine.currentBuffer && !this.stemSplitter.sourceBuffer) {
        this.stemSplitter.loadBuffer(this.engine.currentBuffer, this.engine.currentFileName || 'Parça');
      }
    }
  }

  handleBufferChange(buffer) {
    if (this.dropZone) this.dropZone.style.display = 'none';
    if (this.trackWorkspace) this.trackWorkspace.style.display = 'flex';

    this.trackNameElem.textContent = this.engine.currentFileName;
    this.totalTimeElem.textContent = '/ ' + this.formatTime(buffer.duration);

    const channels = buffer.numberOfChannels === 2 ? 'Stereo' : buffer.numberOfChannels === 1 ? 'Mono' : `${buffer.numberOfChannels} Kanal`;
    this.trackSpecsElem.innerHTML = `
      <span class="spec-item">${channels}</span>
      <span class="spec-item">${buffer.sampleRate} Hz</span>
      <span class="spec-item">${this.formatTime(buffer.duration)}</span>
    `;

    this.selectionStart = 0;
    this.selectionEnd = buffer.duration;

    // Use requestAnimationFrame to guarantee layout dimensions are calculated by browser
    requestAnimationFrame(() => {
      this.waveform.setBuffer(buffer);
      this.updateSelectionInputs();
    });

    this.undoBtn.disabled = !this.engine.canUndo();
    this.redoBtn.disabled = !this.engine.canRedo();
  }

  handleTimeUpdate(time) {
    this.currentTimeElem.textContent = this.formatTime(time);
    this.waveform.setTime(time);
  }

  handlePlayStateChange(isPlaying) {
    const playIcon = this.playBtn.querySelector('svg');
    if (isPlaying) {
      this.playBtn.innerHTML = `
        <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
          <rect x="6" y="4" width="4" height="16" rx="1"/>
          <rect x="14" y="4" width="4" height="16" rx="1"/>
        </svg>
      `;
      this.playBtn.title = 'Duraklat (Space)';
    } else {
      this.playBtn.innerHTML = `
        <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
          <polygon points="5 3 19 12 5 21 5 3"/>
        </svg>
      `;
      this.playBtn.title = 'Oynat (Space)';
    }
  }

  handleSelectionChange(start, end) {
    this.selectionStart = start;
    this.selectionEnd = end;
    this.engine.loopStart = start;
    this.engine.loopEnd = end;
    this.updateSelectionInputs();
  }

  updateSelectionInputs() {
    this.selStartInput.value = this.formatTime(this.selectionStart);
    this.selEndInput.value = this.formatTime(this.selectionEnd);
    const dur = Math.max(0, this.selectionEnd - this.selectionStart);
    this.selDurationInput.value = this.formatTime(dur);
  }

  formatTime(sec) {
    const mins = Math.floor(sec / 60);
    const secs = Math.floor(sec % 60);
    const ms = Math.floor((sec % 1) * 1000);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0')}`;
  }

  parseTimeString(str) {
    const parts = str.split(':');
    if (parts.length === 2) {
      const mins = parseFloat(parts[0]) || 0;
      const secs = parseFloat(parts[1]) || 0;
      return mins * 60 + secs;
    }
    return parseFloat(str) || 0;
  }

  showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    this.toastContainer.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(50px)';
      toast.style.transition = 'all 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, 3200);
  }

  bindKeyboardShortcuts() {
    window.addEventListener('keydown', (e) => {
      // Avoid firing shortcuts when typing in text or number inputs
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;

      if (e.code === 'Space') {
        e.preventDefault();
        
        if (this.activeMode === 'merger') {
          // In Merger mode: Space toggles sequential preview
          if (this.merger) {
            this.merger.togglePlayAll();
          }
        } else if (this.activeMode === 'vocal-splitter') {
          // In Vocal Splitter mode: Space toggles dual stem playback
          if (this.vocalSplitter) {
            this.vocalSplitter.togglePlay();
          }
        } else if (this.activeMode === 'stem-splitter') {
          // In 4-Stem Splitter mode: Space toggles 4-stem playback
          if (this.stemSplitter) {
            this.stemSplitter.togglePlay();
          }
        } else {
          // In Editor mode: Space toggles main audio player
          if (this.merger && this.merger.playback && this.merger.playback.isPlaying) {
            this.merger.stopPlayback();
          }
          if (this.vocalSplitter && this.vocalSplitter.isPlaying) {
            this.vocalSplitter.stop();
          }
          if (this.stemSplitter && this.stemSplitter.isPlaying) {
            this.stemSplitter.stop();
          }
          this.engine.ensureContext();
          this.visualizer.setAnalyser(this.engine.analyser);
          if (this.engine.isPlaying) {
            this.engine.pause();
          } else {
            this.engine.play();
          }
        }
      } else if (e.code === 'KeyL') {
        this.loopBtn.click();
      } else if (e.code === 'Delete' || e.code === 'Backspace') {
        if (this.engine.currentBuffer && this.activeMode === 'editor') {
          e.preventDefault();
          this.cutBtn.click();
        }
      } else if (e.code === 'KeyZ' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        if (e.shiftKey) {
          this.redoBtn.click();
        } else {
          this.undoBtn.click();
        }
      } else if (e.code === 'KeyY' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        this.redoBtn.click();
      }
    });
  }
}

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', () => {
  window.flovaApp = new FlovaStudioApp();
});
