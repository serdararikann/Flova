/* ====================================================================
   FLOVA AUDIO STUDIO - MAIN APPLICATION CONTROLLER
   Event coordination, AudioEngine integration, Canvas syncing & UI State
   ==================================================================== */

import { AudioEngine } from './audio/audio-engine.js';
import { WaveformCanvas } from './ui/waveform-canvas.js';
import { VisualizerCanvas } from './ui/visualizer-canvas.js';
import { MergerUI } from './ui/merger-ui.js?v=9.6';
import { VocalSplitterUI } from './ui/vocal-splitter-ui.js?v=9.6';
import { StemSplitterUI } from './ui/stem-splitter-ui.js?v=9.6';
import { YouTubeUI } from './ui/youtube-ui.js?v=9.6';
import { ExportModal } from './ui/export-modal.js?v=9.6';
import { HotkeysModal } from './ui/hotkeys-modal.js?v=9.6';
import { BPMKeyDetector } from './audio/bpm-key-detector.js';
import { SmartToolsModal } from './ui/smart-tools-modal.js';
import { LyricsModal } from './ui/lyrics-modal.js?v=9.1';
import { AudiogramModal } from './ui/audiogram-modal.js';
import { ServerModal } from './ui/server-modal.js?v=9.1';
import { CodeGuard } from './security/code-guard.js?v=9.1';
import { ApiClient } from './audio/api-client.js?v=9.1';

class FlovaStudioApp {
  constructor() {
    CodeGuard.init();
    this.engine = new AudioEngine();
    this.activeMode = 'editor'; // 'editor' | 'merger' | 'vocal-splitter' | 'stem-splitter'

    this.selectionStart = 0;
    this.selectionEnd = 0;

    this.initDOM();
    this.initComponents();
    this.bindEvents();
    this.bindKeyboardShortcuts();
    this.initPWA();
    this.handleHashNavigation();
  }

  initDOM() {
    // Top Tabs
    this.tabEditor = document.getElementById('tabEditor');
    this.tabMerger = document.getElementById('tabMerger');
    this.tabVocalSplitter = document.getElementById('tabVocalSplitter');
    this.tabStemSplitter = document.getElementById('tabStemSplitter');
    this.tabYoutube = document.getElementById('tabYoutube');
    this.editorView = document.getElementById('editorView');
    this.mergerView = document.getElementById('mergerView');
    this.vocalSplitterView = document.getElementById('vocalSplitterView');
    this.stemSplitterView = document.getElementById('stemSplitterView');
    this.youtubeView = document.getElementById('youtubeView');

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
    this.editorFadeInSlider = document.getElementById('editorFadeInSlider');
    this.editorFadeInNum = document.getElementById('editorFadeInNum');
    this.editorFadeOutSlider = document.getElementById('editorFadeOutSlider');
    this.editorFadeOutNum = document.getElementById('editorFadeOutNum');
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

    // Bottom Studio Rack (Spectrum & Master Effects)
    this.studioBottomRack = document.getElementById('studioBottomRack');

    // Creative Suite Buttons
    this.openSmartToolsBtn = document.getElementById('openSmartToolsBtn');
    this.openLyricsBtn = document.getElementById('openLyricsBtn');
    this.openAudiogramBtn = document.getElementById('openAudiogramBtn');
    this.beatGridToggleBtn = document.getElementById('beatGridToggleBtn');

    // New DAW Controls
    this.normalizeBtn = document.getElementById('normalizeBtn');
    this.addMarkerBtn = document.getElementById('addMarkerBtn');
    this.hotkeysBtn = document.getElementById('hotkeysBtn');
    this.themeSelector = document.getElementById('themeSelector');
    this.pwaInstallBtn = document.getElementById('pwaInstallBtn');
  }

  initComponents() {
    // 1. Waveform Canvas
    const waveCanvas = document.getElementById('waveformCanvas');
    const overlayCanvas = document.getElementById('overlayCanvas');
    this.waveform = new WaveformCanvas(waveCanvas, overlayCanvas, {
      onSelectionChange: (start, end) => this.handleSelectionChange(start, end),
      onSeek: (time) => this.engine.seek(time),
      scrollbarContainer: document.getElementById('waveformScrollbarContainer')
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

    // 6. YouTube Downloader UI
    const ytContainer = document.getElementById('youtubeContainer');
    if (ytContainer) {
      this.youtubeUI = new YouTubeUI(ytContainer, this.engine);
      window.flovaYouTube = this.youtubeUI;
    }

    // 7. Export Modal
    this.exportModal = new ExportModal(this.exportModalContainer, this.engine);

    // 8. Smart AI Tools Modal
    this.smartToolsModal = new SmartToolsModal(
      this.engine,
      (msg, type) => this.showToast(msg, type),
      (newBuffer, actionName) => {
        this.engine.setBuffer(newBuffer, this.engine.currentFileName || 'Flova Düzeltilmiş');
        this.onBufferLoaded(newBuffer);
        this.showToast(`${actionName} uygulandı!`, 'success');
      }
    );

    // 9. Lyrics / Karaoke Modal
    this.lyricsModal = new LyricsModal(this.engine, (msg, type) => this.showToast(msg, type));

    // 10. Audiogram Video Maker Modal
    this.audiogramModal = new AudiogramModal(this.engine, (msg, type) => this.showToast(msg, type));

    // 11. AI Server Settings Modal
    const serverContainer = document.getElementById('serverModalContainer');
    if (serverContainer) {
      this.serverModal = new ServerModal(serverContainer, () => {
        if (this.vocalSplitter) this.vocalSplitter.isProcessing = false;
      });
      window.flovaServerModal = this.serverModal;
    }

    // 12. Keyboard Shortcuts Modal
    const hotkeysContainer = document.getElementById('hotkeysModalContainer');
    if (hotkeysContainer) {
      this.hotkeysModal = new HotkeysModal(hotkeysContainer);
    }

    // Audio Engine callbacks
    this.engine.onBufferChange = (buffer, selection) => this.handleBufferChange(buffer, selection);
    this.engine.onTimeUpdate = (time) => this.handleTimeUpdate(time);
    this.engine.onPlayStateChange = (isPlaying) => this.handlePlayStateChange(isPlaying);
    this.engine.onHistoryChange = (canUndo, canRedo) => {
      if (this.undoBtn) this.undoBtn.disabled = !canUndo;
      if (this.redoBtn) this.redoBtn.disabled = !canRedo;
    };

    // 8. Waveform selection commit
    this.waveform.onSelectionCommit = (start, end) => {
      this.engine.pushSelectionState(start, end);
      this.undoBtn.disabled = !this.engine.canUndo();
      this.redoBtn.disabled = !this.engine.canRedo();
    };
  }

  bindEvents() {
    // AI Server Status Button
    const serverStatusBtn = document.getElementById('serverStatusBtn');
    if (serverStatusBtn) {
      serverStatusBtn.addEventListener('click', () => {
        if (this.serverModal) this.serverModal.open();
      });
    }

    // Mode Switch
    this.tabEditor.addEventListener('click', () => this.switchMode('editor'));
    this.tabMerger.addEventListener('click', () => this.switchMode('merger'));
    this.tabVocalSplitter.addEventListener('click', () => this.switchMode('vocal-splitter'));
    this.tabStemSplitter.addEventListener('click', () => this.switchMode('stem-splitter'));
    if (this.tabYoutube) {
      this.tabYoutube.addEventListener('click', () => this.switchMode('youtube'));
    }

    // File Upload & Demo
    if (this.loadDemoBtn) {
      this.loadDemoBtn.addEventListener('click', async () => {
        this.showToast('Demo müzik sentezleniyor...', 'info');
        await this.engine.loadDemoTrack();
        this.visualizer.setAnalyser(this.engine.analyser);
        this.showToast('Demo müzik yüklendi! Şimdi düzenleyebilirsiniz.', 'success');
      });
    }

    this.openFileBtn.addEventListener('click', () => {
      if (this.activeMode === 'vocal-splitter') {
        const inp = document.getElementById('splitterFileInput');
        if (inp) { inp.value = ''; inp.click(); return; }
      } else if (this.activeMode === 'stem-splitter') {
        const inp = document.getElementById('stemFileInput');
        if (inp) { inp.value = ''; inp.click(); return; }
      } else if (this.activeMode === 'merger') {
        if (this.merger && typeof this.merger.triggerAddTrack === 'function') {
          this.merger.triggerAddTrack();
          return;
        }
        const inp = document.getElementById('mergerFileInput') || document.getElementById('mergerFileInputEmpty');
        if (inp) { inp.value = ''; inp.click(); return; }
      }
      this.fileInput.value = '';
      this.fileInput.click();
    });

    this.fileInput.addEventListener('click', () => {
      this.fileInput.value = '';
    });

    if (this.dropZone) {
      this.dropZone.addEventListener('click', (e) => {
        if (e.target.closest('#dropZoneYoutubeBtn')) {
          e.stopPropagation();
          this.switchMode('youtube');
          setTimeout(() => {
            const inp = document.getElementById('ytUrlInput');
            if (inp) {
              inp.focus();
              inp.select();
            }
          }, 120);
          return;
        }
        this.fileInput.value = '';
        this.fileInput.click();
      });
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
      this.trimBtn.blur();
      if (document.activeElement) document.activeElement.blur();
      this.showToast('Seçili alan kırpıldı!', 'success');
    });

    this.cutBtn.addEventListener('click', () => {
      if (!this.engine.currentBuffer) {
        this.showToast('Lütfen önce bir ses dosyası açın.', 'info');
        return;
      }

      // Sync manual typed inputs if user entered values directly
      if (this.selStartInput && this.selEndInput) {
        const inpStart = this.parseTimeString(this.selStartInput.value);
        const inpEnd = this.parseTimeString(this.selEndInput.value);
        if (inpEnd > inpStart && (this.selectionEnd <= this.selectionStart)) {
          this.selectionStart = inpStart;
          this.selectionEnd = inpEnd;
          this.waveform.setSelection(inpStart, inpEnd);
        }
      }

      if (this.selectionEnd <= this.selectionStart || (this.selectionStart === 0 && this.selectionEnd === 0)) {
        this.showToast('Lütfen silmek istediğiniz aralığı (örn. ortadaki 20 saniyeyi) dalga formu üzerinden seçin.', 'info');
        return;
      }

      const cutDuration = (this.selectionEnd - this.selectionStart).toFixed(1);
      const startAt = this.selectionStart;

      this.engine.cutOutCurrent(this.selectionStart, this.selectionEnd);

      this.selectionStart = 0;
      this.selectionEnd = 0;
      this.engine.loopStart = 0;
      this.engine.loopEnd = this.engine.currentBuffer ? this.engine.currentBuffer.duration : 0;
      this.waveform.setSelection(0, 0);
      if (this.selStartInput) this.selStartInput.value = '00:00.000';
      if (this.selEndInput) this.selEndInput.value = '00:00.000';
      if (this.selDurationInput) this.selDurationInput.value = '00:00.000';

      this.cutBtn.blur();
      if (document.activeElement) document.activeElement.blur();

      // Move playhead to cut junction so user can audition the splice immediately
      this.engine.seek(startAt);

      this.showToast(`Seçili ${cutDuration} sn silindi, kalan parçalar birleştirildi!`, 'success');
    });

    this.silenceBtn.addEventListener('click', () => {
      if (!this.engine.currentBuffer) return;
      this.engine.silenceCurrent(this.selectionStart, this.selectionEnd);
      this.silenceBtn.blur();
      if (document.activeElement) document.activeElement.blur();
      this.showToast('Seçili alan sessize alındı!', 'success');
    });

    this.reverseBtn.addEventListener('click', () => {
      if (!this.engine.currentBuffer) return;
      this.engine.reverseCurrent();
      this.reverseBtn.blur();
      if (document.activeElement) document.activeElement.blur();
      this.showToast('Ses ters çevrildi!', 'success');
    });

    // Manual Fade In & Fade Out sync & handlers
    if (this.editorFadeInSlider && this.editorFadeInNum) {
      this.editorFadeInSlider.addEventListener('input', (e) => {
        this.editorFadeInNum.value = parseFloat(e.target.value).toFixed(1);
      });
      this.editorFadeInNum.addEventListener('input', (e) => {
        const val = Math.max(0.1, Math.min(30, parseFloat(e.target.value) || 0.1));
        this.editorFadeInSlider.value = val;
      });
    }

    if (this.editorFadeOutSlider && this.editorFadeOutNum) {
      this.editorFadeOutSlider.addEventListener('input', (e) => {
        this.editorFadeOutNum.value = parseFloat(e.target.value).toFixed(1);
      });
      this.editorFadeOutNum.addEventListener('input', (e) => {
        const val = Math.max(0.1, Math.min(30, parseFloat(e.target.value) || 0.1));
        this.editorFadeOutSlider.value = val;
      });
    }

    this.fadeInBtn.addEventListener('click', () => {
      if (!this.engine.currentBuffer) return;
      const customDur = this.editorFadeInNum ? parseFloat(this.editorFadeInNum.value) : 3.0;
      const dur = Math.max(0.05, Math.min(this.engine.currentBuffer.duration, customDur || 3.0));

      const hasSelection = this.selectionEnd > this.selectionStart + 0.05 &&
        (this.selectionStart > 0.05 || this.selectionEnd < this.engine.currentBuffer.duration - 0.05);

      if (hasSelection) {
        this.engine.applyFadeToCurrent(0, 0, {
          start: this.selectionStart,
          end: this.selectionEnd,
          type: 'in'
        });
        const selDur = (this.selectionEnd - this.selectionStart).toFixed(1);
        this.showToast(`Seçili alana (${selDur} sn) Fade-In uygulandı!`, 'success');
      } else {
        this.engine.applyFadeToCurrent(dur, 0);
        this.showToast(`${dur.toFixed(1)} sn Fade-In uygulandı!`, 'success');
      }
    });

    this.fadeOutBtn.addEventListener('click', () => {
      if (!this.engine.currentBuffer) return;
      const customDur = this.editorFadeOutNum ? parseFloat(this.editorFadeOutNum.value) : 3.0;
      const dur = Math.max(0.05, Math.min(this.engine.currentBuffer.duration, customDur || 3.0));

      const hasSelection = this.selectionEnd > this.selectionStart + 0.05 &&
        (this.selectionStart > 0.05 || this.selectionEnd < this.engine.currentBuffer.duration - 0.05);

      if (hasSelection) {
        this.engine.applyFadeToCurrent(0, 0, {
          start: this.selectionStart,
          end: this.selectionEnd,
          type: 'out'
        });
        const selDur = (this.selectionEnd - this.selectionStart).toFixed(1);
        this.showToast(`Seçili alana (${selDur} sn) Fade-Out uygulandı!`, 'success');
      } else {
        this.engine.applyFadeToCurrent(0, dur);
        this.showToast(`${dur.toFixed(1)} sn Fade-Out uygulandı!`, 'success');
      }
    });

    // Undo / Redo
    this.undoBtn.addEventListener('click', () => this.handleUndo());
    this.redoBtn.addEventListener('click', () => this.handleRedo());

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
        this.showToast('Lütfen önce bir ses dosyası açın.', 'error');
        return;
      }
      this.exportModal.open(this.selectionStart, this.selectionEnd);
    });

    // Normalize Button
    this.normalizeBtn?.addEventListener('click', () => {
      if (!this.engine.currentBuffer) {
        this.showToast('Lütfen önce bir ses dosyası yükleyin.', 'info');
        return;
      }
      const res = this.engine.normalizeCurrent(-0.1);
      if (res) {
        const gainSign = res.gainDb >= 0 ? '+' : '';
        this.showToast(`Ses normalize edildi (-0.1 dB tepe, ${gainSign}${res.gainDb.toFixed(1)} dB)`, 'success');
      }
    });

    // Add Marker (Cue Point) Button
    this.addMarkerBtn?.addEventListener('click', () => {
      if (!this.engine.currentBuffer) {
        this.showToast('Lütfen önce bir ses dosyası yükleyin.', 'info');
        return;
      }
      const curTime = this.engine.getCurrentTime();
      const count = this.waveform.getMarkers().length + 1;
      this.waveform.addMarker(curTime, `Bölüm ${count}`);
      this.showToast(`İşaretçi eklendi: Bölüm ${count} (${this.formatTime(curTime)})`, 'success');
    });

    // Hotkeys Help Modal Button
    this.hotkeysBtn?.addEventListener('click', () => {
      this.hotkeysModal?.open();
    });

    // Hardware Theme Selector
    if (this.themeSelector) {
      const savedTheme = localStorage.getItem('flova_theme') || 'obsidian';
      this.themeSelector.value = savedTheme;
      document.documentElement.setAttribute('data-theme', savedTheme);

      this.themeSelector.addEventListener('change', (e) => {
        const selected = e.target.value;
        document.documentElement.setAttribute('data-theme', selected);
        localStorage.setItem('flova_theme', selected);
        const name = e.target.options[e.target.selectedIndex].text;
        this.showToast(`Stüdyo teması: ${name}`, 'info');
      });
    }

    // Creative & Smart Tools Buttons
    this.openSmartToolsBtn?.addEventListener('click', () => {
      this.smartToolsModal.open('denoise');
    });

    this.openLyricsBtn?.addEventListener('click', () => {
      this.lyricsModal.open();
    });

    this.openAudiogramBtn?.addEventListener('click', () => {
      this.audiogramModal.open(this.engine.currentFileName || 'Flova Parça');
    });

    this.beatGridToggleBtn?.addEventListener('click', () => {
      const isShown = this.waveform.toggleBeatGrid();
      if (isShown) {
        this.beatGridToggleBtn.style.background = 'rgba(0, 242, 254, 0.2)';
        this.beatGridToggleBtn.style.borderColor = '#00f2fe';
        this.beatGridToggleBtn.style.color = '#00f2fe';
        this.showToast('Ritim Izgarası Açıldı', 'info');
      } else {
        this.beatGridToggleBtn.style.background = '';
        this.beatGridToggleBtn.style.borderColor = '';
        this.beatGridToggleBtn.style.color = '';
        this.showToast('Ritim Izgarası Kapatıldı', 'info');
      }
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

    reverbDecaySlider?.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      fx.setReverb(undefined, val);
      if (reverbDecayVal) reverbDecayVal.textContent = val.toFixed(1) + ' sn';
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

    echoTimeSlider?.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      fx.setEcho(undefined, val, undefined);
      if (echoTimeVal) echoTimeVal.textContent = val.toFixed(2) + ' sn';
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
    const presetChips = document.querySelectorAll('.preset-chip[data-preset]');
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

    // Mastering Compressor & LUFS Presets
    const lufsChips = document.querySelectorAll('[data-lufs]');
    lufsChips.forEach(chip => {
      chip.addEventListener('click', () => {
        lufsChips.forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        const preset = chip.dataset.lufs;
        fx.applyMasteringPreset(preset);
        const badge = document.getElementById('masterLufsReductionVal');
        if (badge) {
          badge.textContent = preset === 'bypass' ? 'Bypass' : `${preset.toUpperCase()} Aktif`;
        }
        this.showToast(`Mastering: ${preset.toUpperCase()} devrede`, 'info');
      });
    });

    const masterMakeupSlider = document.getElementById('masterMakeupSlider');
    const masterMakeupVal = document.getElementById('masterMakeupVal');
    masterMakeupSlider?.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      fx.setMasteringMakeup(val);
      if (masterMakeupVal) masterMakeupVal.textContent = `${val.toFixed(2)}x`;
    });

    // Global drag-and-drop protection & smart active-tab fallback
    window.addEventListener('dragover', (e) => {
      e.preventDefault();
    });

    window.addEventListener('drop', async (e) => {
      e.preventDefault();
      const files = e.dataTransfer && e.dataTransfer.files;
      if (!files || !files.length) return;
      const file = files[0];
      const isAudio = file.type.startsWith('audio/') || /\.(mp3|wav|ogg|flac|m4a|aac|wma|aiff)$/i.test(file.name);
      if (!isAudio) return;

      if (this.activeMode === 'vocal-splitter' && this.vocalSplitter) {
        await this.vocalSplitter.handleUserFile(file);
      } else if (this.activeMode === 'stem-splitter' && this.stemSplitter) {
        await this.stemSplitter.handleUserFile(file);
      } else if (this.activeMode === 'merger' && this.merger) {
        await this.merger.handleFiles(files);
      } else {
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

  setupDropZone(zone) {
    if (!zone) return;

    ['dragenter', 'dragover'].forEach(name => {
      zone.addEventListener(name, (e) => {
        e.preventDefault();
        e.stopPropagation();
        zone.classList.add('dragover', 'drop-zone-drag');
      });
    });

    ['dragleave', 'drop'].forEach(name => {
      zone.addEventListener(name, (e) => {
        e.preventDefault();
        e.stopPropagation();
        zone.classList.remove('dragover', 'drop-zone-drag');
      });
    });

    zone.addEventListener('drop', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      zone.classList.remove('dragover', 'drop-zone-drag');
      const file = e.dataTransfer && e.dataTransfer.files ? e.dataTransfer.files[0] : null;
      if (file && (file.type.startsWith('audio/') || /\.(mp3|wav|ogg|flac|m4a|aac|wma|aiff)$/i.test(file.name))) {
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
    if (this.tabYoutube) this.tabYoutube.classList.remove('active');

    this.editorView.style.display = 'none';
    this.mergerView.style.display = 'none';
    this.vocalSplitterView.style.display = 'none';
    this.stemSplitterView.style.display = 'none';
    if (this.youtubeView) this.youtubeView.style.display = 'none';

    // Show Studio Bottom Rack (Spectrum & Master Effects) ONLY in Editor mode
    if (this.studioBottomRack) {
      this.studioBottomRack.style.display = mode === 'editor' ? 'grid' : 'none';
    }

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
      if (this.vocalSplitter.sourceBuffer) {
        requestAnimationFrame(() => this.vocalSplitter.drawWaveforms());
        setTimeout(() => this.vocalSplitter.drawWaveforms(), 50);
      }

      // If a song is already loaded in editor, offer/auto-load into vocal splitter if not already loaded
      if (this.engine.currentBuffer && !this.vocalSplitter.sourceBuffer) {
        this.vocalSplitter.loadBuffer(this.engine.currentBuffer, this.engine.currentFileName || 'Parça');
      }
    } else if (mode === 'stem-splitter') {
      this.tabStemSplitter.classList.add('active');
      this.stemSplitterView.style.display = 'block';
      this.stemSplitter.render();
      if (this.stemSplitter.hasAnyStem()) {
        requestAnimationFrame(() => this.stemSplitter.drawAllWaveforms());
        setTimeout(() => this.stemSplitter.drawAllWaveforms(), 50);
      }

      // If a song is already loaded in editor, offer/auto-load into 4-stem splitter if not already loaded
      if (this.engine.currentBuffer && !this.stemSplitter.sourceBuffer) {
        this.stemSplitter.loadBuffer(this.engine.currentBuffer, this.engine.currentFileName || 'Parça');
      }
    } else if (mode === 'youtube') {
      if (this.tabYoutube) this.tabYoutube.classList.add('active');
      if (this.youtubeView) this.youtubeView.style.display = 'block';
      if (this.youtubeUI) this.youtubeUI.render();
    }

    try {
      if (window.location.hash !== '#' + mode && window.history.replaceState) {
        window.history.replaceState(null, '', '#' + mode);
      }
    } catch (e) {}
  }

  initPWA() {
    // 1. Register Service Worker
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js')
          .then((reg) => {
            console.log('[Flova PWA] Service Worker aktif:', reg.scope);
          })
          .catch((err) => {
            console.warn('[Flova PWA] Service Worker kaydedilemedi:', err);
          });
      });
    }

    // 2. Install Prompt Handling
    let deferredPrompt = null;
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredPrompt = e;
      if (this.pwaInstallBtn) {
        this.pwaInstallBtn.style.display = 'inline-flex';
      }
    });

    if (this.pwaInstallBtn) {
      this.pwaInstallBtn.addEventListener('click', async () => {
        if (!deferredPrompt) return;
        deferredPrompt.prompt();
        const { outcome } = await deferredPrompt.userChoice;
        if (outcome === 'accepted') {
          this.showToast('Flova Audio Studio kuruluyor...', 'success');
        }
        deferredPrompt = null;
        this.pwaInstallBtn.style.display = 'none';
      });
    }

    window.addEventListener('appinstalled', () => {
      if (this.pwaInstallBtn) this.pwaInstallBtn.style.display = 'none';
      this.showToast('Flova başarıyla cihazınıza yüklendi!', 'success');
    });

    // 3. Listen to Hash Navigation
    window.addEventListener('hashchange', () => {
      this.handleHashNavigation();
    });
  }

  handleHashNavigation() {
    const rawHash = window.location.hash.replace(/^#/, '').toLowerCase();
    const validModes = ['editor', 'merger', 'vocal-splitter', 'stem-splitter', 'youtube'];
    if (validModes.includes(rawHash) && rawHash !== this.activeMode) {
      this.switchMode(rawHash);
    }
  }

  onBufferLoaded(buffer) {
    this.handleBufferChange(buffer);
  }

  handleBufferChange(buffer, selectionRange = null) {
    if (this.dropZone) this.dropZone.style.display = 'none';
    if (this.trackWorkspace) this.trackWorkspace.style.display = 'flex';

    this.trackNameElem.textContent = this.engine.currentFileName;
    this.totalTimeElem.textContent = '/ ' + this.formatTime(buffer.duration);

    const channels = buffer.numberOfChannels === 2 ? 'Stereo' : buffer.numberOfChannels === 1 ? 'Mono' : `${buffer.numberOfChannels} Kanal`;
    this.trackSpecsElem.innerHTML = `
      <span class="spec-item">${channels}</span>
      <span class="spec-item">${buffer.sampleRate} Hz</span>
      <span class="spec-item">${this.formatTime(buffer.duration)}</span>
      <span class="spec-item spec-bpm" id="trackBpmBadge" style="cursor: pointer; background: rgba(56, 189, 248, 0.1); border: 1px solid rgba(56, 189, 248, 0.25); color: #38bdf8; font-weight: 600;" title="Ritim Izgarasını Aç/Kapat"><span style="opacity: 0.7; font-size: 0.75rem; margin-right: 4px;">BPM</span> ...</span>
      <span class="spec-item spec-key" id="trackKeyBadge" style="background: rgba(168, 85, 247, 0.1); border: 1px solid rgba(168, 85, 247, 0.25); color: #c084fc; font-weight: 600;"><span style="opacity: 0.7; font-size: 0.75rem; margin-right: 4px;">KEY</span> ...</span>
    `;

    // Asynchronously detect BPM and Musical Key
    BPMKeyDetector.analyze(buffer).then(analysis => {
      const bpmEl = document.getElementById('trackBpmBadge');
      const keyEl = document.getElementById('trackKeyBadge');
      if (bpmEl) {
        bpmEl.innerHTML = `<span style="opacity: 0.7; font-size: 0.75rem; margin-right: 4px;">BPM</span> ${analysis.bpm}`;
        bpmEl.onclick = () => {
          document.getElementById('beatGridToggleBtn')?.click();
        };
      }
      if (keyEl) {
        keyEl.innerHTML = `<span style="opacity: 0.7; font-size: 0.75rem; margin-right: 4px;">KEY</span> ${analysis.key}`;
      }
      this.waveform.setBeats(analysis.beats, analysis.bpm);
    }).catch(err => {
      console.warn('BPM/Key analysis error:', err);
    });

    this.selectionStart = selectionRange ? selectionRange.start : 0;
    this.selectionEnd = selectionRange ? selectionRange.end : buffer.duration;

    this.waveform.setBuffer(buffer, this.selectionStart, this.selectionEnd);
    this.updateSelectionInputs();

    this.undoBtn.disabled = !this.engine.canUndo();
    this.redoBtn.disabled = !this.engine.canRedo();
  }

  handleUndo() {
    if (this.activeMode === 'merger') {
      if (this.merger) {
        this.merger.undoLastAction();
      }
      return;
    }
    if (this.engine.undo()) {
      this.showToast('Geri alındı (Undo)', 'info');
    } else {
      this.showToast('Geri alınacak başka işlem yok.', 'info');
    }
    this.undoBtn.disabled = !this.engine.canUndo();
    this.redoBtn.disabled = !this.engine.canRedo();
  }

  handleRedo() {
    if (this.activeMode === 'merger') {
      return;
    }
    if (this.engine.redo()) {
      this.showToast('Yinelendi (Redo)', 'info');
    } else {
      this.showToast('İleri alınacak başka işlem yok.', 'info');
    }
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
      const tag = e.target.tagName ? e.target.tagName.toLowerCase() : '';
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable) {
        if (e.key === 'Escape') {
          e.target.blur();
        }
        return;
      }

      if (e.key === 'Escape') {
        this.hotkeysModal?.close();
        this.smartToolsModal?.close();
        this.lyricsModal?.close();
        this.audiogramModal?.close();
        if (this.exportModal) {
          const closeBtn = document.getElementById('closeExportModalBtn');
          closeBtn?.click();
        }
        return;
      }

      if (e.code === 'Space') {
        e.preventDefault();
        e.stopPropagation();

        if (document.activeElement && (document.activeElement.tagName === 'BUTTON' || document.activeElement.tagName === 'A')) {
          document.activeElement.blur();
        }
        
        if (this.activeMode === 'merger') {
          if (this.merger) {
            this.merger.togglePlayAll();
          }
        } else if (this.activeMode === 'vocal-splitter') {
          if (this.vocalSplitter) {
            this.vocalSplitter.togglePlay();
          }
        } else if (this.activeMode === 'stem-splitter') {
          if (this.stemSplitter) {
            this.stemSplitter.togglePlay();
          }
        } else {
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
      } else if (e.code === 'KeyL' && !e.ctrlKey && !e.metaKey) {
        this.loopBtn.click();
      } else if (e.code === 'KeyS' && !e.ctrlKey && !e.metaKey) {
        if (this.activeMode === 'editor' && this.trimBtn) {
          e.preventDefault();
          this.trimBtn.click();
        }
      } else if (e.code === 'KeyN' && !e.ctrlKey && !e.metaKey) {
        if (this.activeMode === 'editor' && this.normalizeBtn) {
          e.preventDefault();
          this.normalizeBtn.click();
        }
      } else if (e.code === 'KeyM' && !e.ctrlKey && !e.metaKey) {
        if (this.activeMode === 'editor' && this.addMarkerBtn) {
          e.preventDefault();
          this.addMarkerBtn.click();
        }
      } else if (['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5'].includes(e.code) && !e.ctrlKey && !e.metaKey) {
        const modes = ['editor', 'merger', 'vocal-splitter', 'stem-splitter', 'youtube'];
        const idx = parseInt(e.code.replace('Digit', ''), 10) - 1;
        if (modes[idx]) {
          e.preventDefault();
          this.switchMode(modes[idx]);
        }
      } else if (e.key === '?' || (e.shiftKey && e.key === '/')) {
        e.preventDefault();
        this.hotkeysModal?.open();
      } else if (e.code === 'Delete' || e.code === 'Backspace') {
        if (this.engine.currentBuffer && this.activeMode === 'editor') {
          e.preventDefault();
          this.cutBtn.click();
        }
      } else if ((e.key === 'z' || e.key === 'Z' || e.code === 'KeyZ') && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        if (e.shiftKey) {
          this.handleRedo();
        } else {
          this.handleUndo();
        }
      } else if ((e.key === 'y' || e.key === 'Y' || e.code === 'KeyY') && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        this.handleRedo();
      }
    });
  }
}

// Initialize on DOM ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    window.flovaApp = new FlovaStudioApp();
  });
} else {
  window.flovaApp = new FlovaStudioApp();
}
