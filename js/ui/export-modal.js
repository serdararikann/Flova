/* ====================================================================
   FLOVA AUDIO STUDIO - EXPORT MODAL & RENDER DIALOG
   Custom File Name Input, WAV / MP3 Encoding, Quality & Download
   ==================================================================== */

import { AudioEncoders } from '../audio/audio-encoders.js';
import { AudioProcessor } from '../audio/audio-processor.js';

export class ExportModal {
  constructor(containerElement, audioEngine) {
    this.container = containerElement;
    this.engine = audioEngine;
    this.isOpen = false;

    this.render();
    this.bindEvents();
  }

  open(selectionStart, selectionEnd) {
    this.selectionStart = selectionStart || 0;
    this.selectionEnd = selectionEnd || (this.engine.currentBuffer ? this.engine.currentBuffer.duration : 0);
    this.isOpen = true;
    this.container.classList.add('active');
    this.resetProgress();

    // Default filename from current track
    const fileNameInput = this.container.querySelector('#exportFileNameInput');
    if (fileNameInput) {
      let baseName = this.engine.currentFileName ? this.engine.currentFileName.replace(/\.[^/.]+$/, '') : 'Flova_Audio';
      if (!baseName.endsWith('_edit')) baseName += '_edit';
      fileNameInput.value = baseName;
    }

    // Auto-select 'Sadece Seçili Alan' if track is shortened
    const isCustomShortened = this.selectionStart > 0.05 || (this.engine.currentBuffer && this.selectionEnd < this.engine.currentBuffer.duration - 0.05);
    const scopeSelectionInput = this.container.querySelector('input[name="exportScope"][value="selection"]');
    const scopeAllInput = this.container.querySelector('input[name="exportScope"][value="all"]');
    const scopeSelectionLabel = this.container.querySelector('#scopeSelectionLabel');
    const scopeAllLabel = this.container.querySelector('#scopeAllLabel');

    if (isCustomShortened) {
      if (scopeSelectionInput) scopeSelectionInput.checked = true;
      if (scopeSelectionLabel) scopeSelectionLabel.classList.add('checked');
      if (scopeAllLabel) scopeAllLabel.classList.remove('checked');
    } else {
      if (scopeAllInput) scopeAllInput.checked = true;
      if (scopeAllLabel) scopeAllLabel.classList.add('checked');
      if (scopeSelectionLabel) scopeSelectionLabel.classList.remove('checked');
    }
  }

  close() {
    this.isOpen = false;
    this.container.classList.remove('active');
  }

  resetProgress() {
    const progressContainer = this.container.querySelector('#exportProgress');
    const fill = this.container.querySelector('#exportProgressFill');
    const text = this.container.querySelector('#exportProgressText');
    const btn = this.container.querySelector('#startExportBtn');

    if (progressContainer) progressContainer.style.display = 'none';
    if (fill) fill.style.width = '0%';
    if (text) text.textContent = '';
    if (btn) btn.disabled = false;
  }

  async startExport() {
    if (!this.engine.currentBuffer) return;

    const format = this.container.querySelector('input[name="exportFormat"]:checked').value;
    const scope = this.container.querySelector('input[name="exportScope"]:checked').value;
    const applyFx = this.container.querySelector('#applyEffectsCheckbox').checked;
    const mp3Kbps = parseInt(this.container.querySelector('#mp3BitrateSelect').value, 10);
    const wavDepth = parseInt(this.container.querySelector('#wavBitDepthSelect').value, 10);
    const userFileName = this.container.querySelector('#exportFileNameInput').value.trim() || 'flova_audio';

    const progressContainer = this.container.querySelector('#exportProgress');
    const fill = this.container.querySelector('#exportProgressFill');
    const text = this.container.querySelector('#exportProgressText');
    const btn = this.container.querySelector('#startExportBtn');

    progressContainer.style.display = 'flex';
    btn.disabled = true;
    text.textContent = 'Ses verisi hazırlanıyor...';
    fill.style.width = '15%';

    // Step 1: Crop buffer if exporting selection only
    let sourceBuffer = this.engine.currentBuffer;
    if (scope === 'selection') {
      sourceBuffer = AudioProcessor.trimBuffer(
        this.engine.ctx,
        this.engine.currentBuffer,
        this.selectionStart,
        this.selectionEnd
      );
    }

    fill.style.width = '35%';
    text.textContent = 'Efektler ve ses işleniyor...';
    await new Promise(r => setTimeout(r, 50));

    // Step 2: Apply DSP Effects offline if requested
    let finalBuffer = sourceBuffer;
    if (applyFx && this.engine.effectsRack) {
      finalBuffer = await AudioProcessor.renderEffectsOffline(
        sourceBuffer,
        this.engine.effectsRack.params
      );
    }

    fill.style.width = '60%';
    text.textContent = `${format.toUpperCase()} formatında kodlanıyor...`;
    await new Promise(r => setTimeout(r, 50));

    // Step 3: Encode to Blob
    let blob;
    let cleanName = userFileName.replace(/\.[^/.]+$/, ''); // Remove extension if user wrote one
    let fileName = `${cleanName}.${format}`;

    if (format === 'wav') {
      blob = AudioEncoders.bufferToWave(finalBuffer, { bitDepth: wavDepth });
      fill.style.width = '100%';
      text.textContent = 'Dışa aktarma tamamlandı!';
    } else {
      blob = await AudioEncoders.bufferToMp3(finalBuffer, { kbps: mp3Kbps }, (prog) => {
        const percent = Math.round(60 + prog * 40);
        fill.style.width = `${percent}%`;
        text.textContent = `MP3 kodlanıyor: %${Math.round(prog * 100)}`;
      });
      text.textContent = 'Dışa aktarma tamamlandı!';
    }

    // Step 4: Trigger browser download with user's specified file name
    this.downloadBlob(blob, fileName);

    setTimeout(() => {
      this.close();
      this.resetProgress();
    }, 1200);
  }

  downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.style.display = 'none';
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 100);
  }

  render() {
    this.container.className = 'modal-backdrop';
    this.container.innerHTML = `
      <div class="modal-card">
        <div class="modal-header">
          <div class="modal-title">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
              <polyline points="7 10 12 15 17 10"></polyline>
              <line x1="12" y1="15" x2="12" y2="3"></line>
            </svg>
            Dışa Aktar & Kaydet
          </div>
          <button class="modal-close-btn" id="closeExportModalBtn">✕</button>
        </div>

        <div class="export-options-grid">
          
          <!-- Custom File Name Input -->
          <div class="option-group">
            <label class="option-label">Dosya Adı</label>
            <div style="display: flex; align-items: center; background: rgba(0,0,0,0.45); border: 1px solid var(--border-glass); border-radius: var(--radius-sm); padding: 7px 12px;">
              <input type="text" id="exportFileNameInput" value="Flova_Audio_edit" 
                placeholder="Dosya adını yazın..." 
                style="width: 100%; background: transparent; border: none; outline: none; color: #fff; font-family: var(--font-sans); font-size: 0.95rem; font-weight: 600;" />
              <span id="exportExtLabel" style="color: var(--accent-cyan); font-family: var(--font-mono); font-weight: 700; font-size: 0.88rem; margin-left: 6px;">.wav</span>
            </div>
          </div>

          <!-- Scope Selection -->
          <div class="option-group">
            <label class="option-label">Kapsam</label>
            <div class="radio-pills">
              <label class="radio-pill-label checked" id="scopeAllLabel">
                <input type="radio" name="exportScope" value="all" checked />
                Tüm Parça
              </label>
              <label class="radio-pill-label" id="scopeSelectionLabel">
                <input type="radio" name="exportScope" value="selection" />
                Sadece Seçili Alan
              </label>
            </div>
          </div>

          <!-- Format Selection -->
          <div class="option-group">
            <label class="option-label">Format</label>
            <div class="radio-pills">
              <label class="radio-pill-label checked" id="formatWavLabel">
                <input type="radio" name="exportFormat" value="wav" checked />
                WAV (Kayıpsız / Stüdyo)
              </label>
              <label class="radio-pill-label" id="formatMp3Label">
                <input type="radio" name="exportFormat" value="mp3" />
                MP3 (Sıkıştırılmış)
              </label>
            </div>
          </div>

          <!-- WAV Settings -->
          <div class="option-group" id="wavSettingsGroup">
            <label class="option-label">WAV Bit Derinliği</label>
            <select id="wavBitDepthSelect" style="background: rgba(0,0,0,0.4); border: 1px solid var(--border-glass); color: #fff; padding: 8px 12px; border-radius: var(--radius-sm); outline: none;">
              <option value="16" selected>16-bit PCM (CD Kalitesi - Standart)</option>
              <option value="24">24-bit PCM (Stüdyo Master)</option>
              <option value="32">32-bit Float (Yüksek Dinamik Aralık)</option>
            </select>
          </div>

          <!-- MP3 Settings -->
          <div class="option-group" id="mp3SettingsGroup" style="display: none;">
            <label class="option-label">MP3 Kalitesi (Bitrate)</label>
            <select id="mp3BitrateSelect" style="background: rgba(0,0,0,0.4); border: 1px solid var(--border-glass); color: #fff; padding: 8px 12px; border-radius: var(--radius-sm); outline: none;">
              <option value="320" selected>320 kbps (En Yüksek Kalite)</option>
              <option value="192">192 kbps (Yüksek Kalite)</option>
              <option value="128">128 kbps (Standart / Küçük Boyut)</option>
            </select>
          </div>

          <!-- Effects Apply Checkbox -->
          <div style="display: flex; align-items: center; gap: 10px; margin-top: 4px;">
            <input type="checkbox" id="applyEffectsCheckbox" checked style="accent-color: var(--accent-primary); width: 16px; height: 16px;" />
            <label for="applyEffectsCheckbox" style="font-size: 0.85rem; color: var(--text-main); cursor: pointer;">
              Ekolayzer, Reverb, Hız ve Ses efektlerini sese uygula
            </label>
          </div>
        </div>

        <!-- Progress bar -->
        <div class="progress-container" id="exportProgress">
          <div class="progress-bar-bg">
            <div class="progress-bar-fill" id="exportProgressFill"></div>
          </div>
          <div class="progress-status-text" id="exportProgressText">Hazırlanıyor...</div>
        </div>

        <div style="display: flex; justify-content: flex-end; gap: 12px; margin-top: 20px;">
          <button class="btn btn-secondary" id="cancelExportBtn">İptal</button>
          <button class="btn btn-emerald" id="startExportBtn" style="display: inline-flex; align-items: center; gap: 8px;">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
            İndir ve Kaydet
          </button>
        </div>
      </div>
    `;
  }

  bindEvents() {
    this.container.querySelector('#closeExportModalBtn').addEventListener('click', () => this.close());
    this.container.querySelector('#cancelExportBtn').addEventListener('click', () => this.close());
    this.container.querySelector('#startExportBtn').addEventListener('click', () => this.startExport());

    // Format toggle & extension label update
    const wavLabel = this.container.querySelector('#formatWavLabel');
    const mp3Label = this.container.querySelector('#formatMp3Label');
    const wavGroup = this.container.querySelector('#wavSettingsGroup');
    const mp3Group = this.container.querySelector('#mp3SettingsGroup');
    const extLabel = this.container.querySelector('#exportExtLabel');

    wavLabel.addEventListener('click', () => {
      wavLabel.classList.add('checked');
      mp3Label.classList.remove('checked');
      wavGroup.style.display = 'flex';
      mp3Group.style.display = 'none';
      if (extLabel) extLabel.textContent = '.wav';
    });

    mp3Label.addEventListener('click', () => {
      mp3Label.classList.add('checked');
      wavLabel.classList.remove('checked');
      wavGroup.style.display = 'none';
      mp3Group.style.display = 'flex';
      if (extLabel) extLabel.textContent = '.mp3';
    });

    // Scope toggle
    const scopeAll = this.container.querySelector('#scopeAllLabel');
    const scopeSel = this.container.querySelector('#scopeSelectionLabel');

    scopeAll.addEventListener('click', () => {
      scopeAll.classList.add('checked');
      scopeSel.classList.remove('checked');
    });

    scopeSel.addEventListener('click', () => {
      scopeSel.classList.add('checked');
      scopeAll.classList.remove('checked');
    });
  }
}
