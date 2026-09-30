/**
 * Flova Studio - Smart AI Tools Modal
 * Interactive UI for Denoise, Silence Trimmer, and Auto-Tune Pitch Correction
 */

import { NoiseCleaner } from '../audio/noise-cleaner.js';
import { SilenceRemover } from '../audio/silence-remover.js';
import { AutoTuneEngine } from '../audio/autotune-node.js';

export class SmartToolsModal {
  constructor(audioEngine, showToast, onBufferUpdated) {
    this.engine = audioEngine;
    this.showToast = showToast || console.log;
    this.onBufferUpdated = onBufferUpdated || (() => {});
    this.modalEl = null;
    this.detectedSilences = null;

    this._createDOM();
  }

  _createDOM() {
    let container = document.getElementById('smartToolsModalContainer');
    if (!container) {
      container = document.createElement('div');
      container.id = 'smartToolsModalContainer';
      document.body.appendChild(container);
    }

    container.innerHTML = `
      <div id="smartToolsModalBackdrop" class="modal-backdrop" style="display: none; position: fixed; inset: 0; background: rgba(0, 4, 15, 0.88); backdrop-filter: blur(12px); z-index: 10000; justify-content: center; align-items: center; padding: 20px;">
        <div class="glass-card smart-tools-dialog" style="width: 100%; max-width: 680px; max-height: 90vh; display: flex; flex-direction: column; overflow: hidden; border: 1px solid rgba(0, 242, 254, 0.3); box-shadow: 0 20px 60px rgba(0, 0, 0, 0.7);">
          
          <!-- Header -->
          <div style="display: flex; align-items: center; justify-content: space-between; padding: 18px 24px; border-bottom: 1px solid rgba(255, 255, 255, 0.08);">
            <div style="display: flex; align-items: center; gap: 10px;">
              <span style="font-size: 1.4rem;">🪄</span>
              <div>
                <h3 style="margin: 0; font-size: 1.15rem; font-weight: 700; color: #fff;">Stüdyo Akıllı Araçlar & AI</h3>
                <p style="margin: 2px 0 0 0; font-size: 0.78rem; color: var(--text-muted, #94a3b8);">Gürültü temizleme, sessizlik budama ve vokal auto-tune ayarları</p>
              </div>
            </div>
            <button id="closeSmartToolsModal" class="btn btn-secondary btn-sm" style="border-radius: 50%; width: 32px; height: 32px; padding: 0; display: flex; align-items: center; justify-content: center;">✕</button>
          </div>

          <!-- Tool Selector Tabs -->
          <div style="display: flex; background: rgba(0, 0, 0, 0.3); padding: 8px 16px; border-bottom: 1px solid rgba(255, 255, 255, 0.06); gap: 8px;">
            <button class="st-tab-btn active" data-tab="denoise" style="flex: 1; padding: 8px 12px; border-radius: 6px; font-size: 0.84rem; font-weight: 600; border: 1px solid #00f2fe; background: rgba(0, 242, 254, 0.15); color: #fff; cursor: pointer;">
              🔇 AI Dip Ses Temizle
            </button>
            <button class="st-tab-btn" data-tab="silence" style="flex: 1; padding: 8px 12px; border-radius: 6px; font-size: 0.84rem; font-weight: 600; border: 1px solid rgba(255, 255, 255, 0.1); background: rgba(255, 255, 255, 0.04); color: #ccc; cursor: pointer;">
              ✂️ Sessizlikleri Buday
            </button>
            <button class="st-tab-btn" data-tab="autotune" style="flex: 1; padding: 8px 12px; border-radius: 6px; font-size: 0.84rem; font-weight: 600; border: 1px solid rgba(255, 255, 255, 0.1); background: rgba(255, 255, 255, 0.04); color: #ccc; cursor: pointer;">
              🎤 Auto-Tune Vokal
            </button>
          </div>

          <!-- Body Panels -->
          <div style="padding: 24px; flex: 1; overflow-y: auto;">
            
            <!-- 1. DENOISE PANEL -->
            <div id="stDenoisePanel" class="st-panel">
              <h4 style="margin: 0 0 8px 0; font-size: 0.95rem; color: #fff;">Arka Plan Dip Ses ve Hiss Temizleme</h4>
              <p style="margin: 0 0 16px 0; font-size: 0.82rem; color: #94a3b8; line-height: 1.5;">
                Kayıttaki fan gürültüsü, klima sesi, mikrofon cızırtısı ve mekan dip sesini spektral yapay zeka ile yok eder.
              </p>

              <div style="background: rgba(255,255,255,0.03); padding: 16px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.08); margin-bottom: 20px;">
                <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
                  <span style="font-size: 0.85rem; color: #e2e8f0; font-weight: 600;">Temizleme Gücü</span>
                  <span id="denoiseStrengthDisplay" style="font-size: 0.85rem; color: #00f2fe; font-weight: 700;">%80 (Önerilen)</span>
                </div>
                <input type="range" id="denoiseStrengthSlider" min="20" max="100" step="5" value="80" class="studio-slider" style="width: 100%;" />
                <div style="display: flex; justify-content: space-between; font-size: 0.72rem; color: #64748b; margin-top: 4px;">
                  <span>Hafif (%20)</span>
                  <span>Dengeli (%80)</span>
                  <span>Maksimum (%100)</span>
                </div>
              </div>

              <button id="applyDenoiseBtn" class="btn btn-primary" style="width: 100%; padding: 12px; font-weight: 700; background: linear-gradient(135deg, #00f2fe, #4facfe);">
                🔇 Dip Sesi Temizle ve Parçaya Uygula
              </button>
            </div>

            <!-- 2. SILENCE TRIMMER PANEL -->
            <div id="stSilencePanel" class="st-panel" style="display: none;">
              <h4 style="margin: 0 0 8px 0; font-size: 0.95rem; color: #fff;">Konuşma & Kayıt İçi Sessizlik Budayıcı</h4>
              <p style="margin: 0 0 16px 0; font-size: 0.82rem; color: #94a3b8; line-height: 1.5;">
                Podcast, seslendirme ve şarkı kaydındaki gereksiz duraksamaları ve nefes boşluklarını mikrosaniyeler içinde kesip akıcı hale getirir.
              </p>

              <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 16px;">
                <div style="background: rgba(255,255,255,0.03); padding: 12px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.08);">
                  <label style="font-size: 0.78rem; color: #94a3b8; display: block; margin-bottom: 4px;">Sessizlik Eşiği</label>
                  <select id="silenceThresholdSelect" class="form-input" style="width: 100%; padding: 6px 10px; font-size: 0.85rem; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.15); color: #fff; border-radius: 6px;">
                    <option value="-45">-45 dB (Çok Sessiz)</option>
                    <option value="-40" selected>-40 dB (Normal / Standart)</option>
                    <option value="-35">-35 dB (Hafif Arka Planlı)</option>
                    <option value="-30">-30 dB (Agresif)</option>
                  </select>
                </div>
                <div style="background: rgba(255,255,255,0.03); padding: 12px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.08);">
                  <label style="font-size: 0.78rem; color: #94a3b8; display: block; margin-bottom: 4px;">Minimum Süre</label>
                  <select id="silenceMinDurationSelect" class="form-input" style="width: 100%; padding: 6px 10px; font-size: 0.85rem; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.15); color: #fff; border-radius: 6px;">
                    <option value="0.25">0.25 saniye</option>
                    <option value="0.35" selected>0.35 saniye (Önerilen)</option>
                    <option value="0.5">0.50 saniye</option>
                    <option value="1.0">1.00 saniye</option>
                  </select>
                </div>
              </div>

              <!-- Scan Results Box -->
              <div id="silenceScanResultBox" style="background: rgba(0, 242, 254, 0.06); border: 1px dashed rgba(0, 242, 254, 0.3); padding: 12px 16px; border-radius: 8px; margin-bottom: 16px; display: none;">
                <span id="silenceScanResultText" style="font-size: 0.85rem; color: #00f2fe; font-weight: 600;"></span>
              </div>

              <div style="display: flex; gap: 10px;">
                <button id="scanSilenceBtn" class="btn btn-secondary" style="flex: 1; padding: 10px; font-weight: 600;">
                  🔍 Sessizlikleri Tara
                </button>
                <button id="applySilenceCutBtn" class="btn btn-primary" style="flex: 1.2; padding: 10px; font-weight: 700; background: linear-gradient(135deg, #10b981, #059669);" disabled>
                  ✂️ Sessizlikleri Kes & Birleştir
                </button>
              </div>
            </div>

            <!-- 3. AUTOTUNE PANEL -->
            <div id="stAutotunePanel" class="st-panel" style="display: none;">
              <h4 style="margin: 0 0 8px 0; font-size: 0.95rem; color: #fff;">Akıllı Pitch Correction & Auto-Tune</h4>
              <p style="margin: 0 0 16px 0; font-size: 0.82rem; color: #94a3b8; line-height: 1.5;">
                Vokal notasını müzikal gam çizgisine oturtarak detone kısımları düzeltin veya ünlü T-Pain robot vokal efektini yakalayın.
              </p>

              <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 16px;">
                <div style="background: rgba(255,255,255,0.03); padding: 12px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.08);">
                  <label style="font-size: 0.78rem; color: #94a3b8; display: block; margin-bottom: 4px;">Kök Nota (Root Key)</label>
                  <select id="autotuneRootSelect" class="form-input" style="width: 100%; padding: 6px 10px; font-size: 0.85rem; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.15); color: #fff; border-radius: 6px;">
                    <option value="C">C (Do)</option>
                    <option value="C#">C# / Db</option>
                    <option value="D">D (Re)</option>
                    <option value="D#">D# / Eb</option>
                    <option value="E">E (Mi)</option>
                    <option value="F">F (Fa)</option>
                    <option value="F#">F# / Gb</option>
                    <option value="G">G (Sol)</option>
                    <option value="G#">G# / Ab</option>
                    <option value="A" selected>A (La)</option>
                    <option value="A#">A# / Bb</option>
                    <option value="B">B (Si)</option>
                  </select>
                </div>
                <div style="background: rgba(255,255,255,0.03); padding: 12px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.08);">
                  <label style="font-size: 0.78rem; color: #94a3b8; display: block; margin-bottom: 4px;">Müzikal Gam (Scale)</label>
                  <select id="autotuneScaleSelect" class="form-input" style="width: 100%; padding: 6px 10px; font-size: 0.85rem; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.15); color: #fff; border-radius: 6px;">
                    <option value="minor" selected>Doğal Minör (Minor)</option>
                    <option value="major">Majör (Major)</option>
                    <option value="pentatonicMinor">Pentatonik Minör</option>
                    <option value="pentatonicMajor">Pentatonik Majör</option>
                    <option value="blues">Blues Gamı</option>
                    <option value="chromatic">Kromatik (Tüm Notalar)</option>
                  </select>
                </div>
              </div>

              <!-- Speed preset -->
              <div style="background: rgba(255,255,255,0.03); padding: 16px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.08); margin-bottom: 20px;">
                <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
                  <span style="font-size: 0.85rem; color: #e2e8f0; font-weight: 600;">Düzeltme Hızı & Karakteri</span>
                  <span id="autotuneSpeedDisplay" style="font-size: 0.85rem; color: #a855f7; font-weight: 700;">Modern Pop (25ms)</span>
                </div>
                <input type="range" id="autotuneSpeedSlider" min="0" max="80" step="5" value="25" class="studio-slider" style="width: 100%;" />
                <div style="display: flex; justify-content: space-between; font-size: 0.72rem; color: #64748b; margin-top: 4px;">
                  <span>🤖 Robot / T-Pain (0ms)</span>
                  <span>⚡ Modern Pop (25ms)</span>
                  <span>🍃 Doğal Akustik (80ms)</span>
                </div>
              </div>

              <button id="applyAutotuneBtn" class="btn btn-primary" style="width: 100%; padding: 12px; font-weight: 700; background: linear-gradient(135deg, #a855f7, #6366f1);">
                🎤 Auto-Tune Uygula
              </button>
            </div>

          </div>

        </div>
      </div>
    `;

    this.modalEl = document.getElementById('smartToolsModalBackdrop');
    this._bindEvents();
  }

  _bindEvents() {
    document.getElementById('closeSmartToolsModal')?.addEventListener('click', () => this.close());

    // Tab switching
    const tabBtns = this.modalEl.querySelectorAll('.st-tab-btn');
    const panels = {
      denoise: document.getElementById('stDenoisePanel'),
      silence: document.getElementById('stSilencePanel'),
      autotune: document.getElementById('stAutotunePanel')
    };

    tabBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        tabBtns.forEach(b => {
          b.style.border = '1px solid rgba(255,255,255,0.1)';
          b.style.background = 'rgba(255,255,255,0.04)';
          b.style.color = '#ccc';
        });
        btn.style.border = '1px solid #00f2fe';
        btn.style.background = 'rgba(0, 242, 254, 0.15)';
        btn.style.color = '#fff';

        const tab = btn.dataset.tab;
        Object.keys(panels).forEach(p => {
          if (panels[p]) panels[p].style.display = p === tab ? 'block' : 'none';
        });
      });
    });

    // Denoise slider
    const denoiseSlider = document.getElementById('denoiseStrengthSlider');
    const denoiseDisplay = document.getElementById('denoiseStrengthDisplay');
    denoiseSlider?.addEventListener('input', (e) => {
      const val = e.target.value;
      let label = `%${val}`;
      if (val <= 40) label += ' (Hafif)';
      else if (val <= 85) label += ' (Önerilen)';
      else label += ' (Güçlü)';
      if (denoiseDisplay) denoiseDisplay.textContent = label;
    });

    // Apply Denoise
    document.getElementById('applyDenoiseBtn')?.addEventListener('click', async () => {
      await this._executeDenoise();
    });

    // Scan Silence
    document.getElementById('scanSilenceBtn')?.addEventListener('click', () => {
      this._scanSilence();
    });

    // Apply Silence Cut
    document.getElementById('applySilenceCutBtn')?.addEventListener('click', () => {
      this._executeSilenceCut();
    });

    // Autotune slider
    const atSlider = document.getElementById('autotuneSpeedSlider');
    const atDisplay = document.getElementById('autotuneSpeedDisplay');
    atSlider?.addEventListener('input', (e) => {
      const val = parseInt(e.target.value);
      if (val === 0) atDisplay.textContent = '🤖 Robotik T-Pain (0ms)';
      else if (val < 40) atDisplay.textContent = `⚡ Modern Pop (${val}ms)`;
      else atDisplay.textContent = `🍃 Doğal Akustik (${val}ms)`;
    });

    // Apply Autotune
    document.getElementById('applyAutotuneBtn')?.addEventListener('click', () => {
      this._executeAutotune();
    });

    // Close on backdrop click
    this.modalEl?.addEventListener('click', (e) => {
      if (e.target === this.modalEl) this.close();
    });
  }

  open(initialTab = 'denoise') {
    const tabBtn = this.modalEl.querySelector(`.st-tab-btn[data-tab="${initialTab}"]`);
    if (tabBtn) tabBtn.click();

    this.modalEl.style.display = 'flex';
    this.modalEl.classList.add('active');

    const buffer = this.engine.currentBuffer || this.engine.audioBuffer;
    if (!buffer) {
      this.showToast('İpucu: Henüz bir parça yüklemediniz. Düzenlemek için Demo yükleyebilir veya Dosya Açabilirsiniz.', 'info');
    }
  }

  close() {
    this.modalEl.classList.remove('active');
    this.modalEl.style.display = 'none';
  }

  async _executeDenoise() {
    const btn = document.getElementById('applyDenoiseBtn');
    const strengthVal = parseInt(document.getElementById('denoiseStrengthSlider')?.value || 80) / 100;

    btn.disabled = true;
    btn.textContent = '⏳ Dip Ses Temizleniyor...';

    try {
      const buf = this.engine.currentBuffer || this.engine.audioBuffer;
      const cleaned = await NoiseCleaner.denoise(buf, {
        strength: strengthVal,
        useBackend: true
      }, this.engine.ctx);

      this.onBufferUpdated(cleaned, 'AI Dip Ses Temizlendi');
      this.showToast('✨ Arka plan dip sesi başarıyla temizlendi!', 'success');
      this.close();
    } catch (err) {
      console.error('[SmartTools] Denoise error:', err);
      this.showToast(`Hata: ${err.message}`, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = '🔇 Dip Sesi Temizle ve Parçaya Uygula';
    }
  }

  _scanSilence() {
    const thresholdDb = parseFloat(document.getElementById('silenceThresholdSelect')?.value || -40);
    const minDur = parseFloat(document.getElementById('silenceMinDurationSelect')?.value || 0.35);
    const buf = this.engine.currentBuffer || this.engine.audioBuffer;

    const result = SilenceRemover.detectSilence(buf, {
      thresholdDb,
      minDurationSec: minDur
    });

    this.detectedSilences = result.silences;

    const resultBox = document.getElementById('silenceScanResultBox');
    const resultText = document.getElementById('silenceScanResultText');
    const applyBtn = document.getElementById('applySilenceCutBtn');

    if (result.silences.length === 0) {
      resultBox.style.display = 'block';
      resultText.textContent = 'Belirtilen kriterlerde sessiz bölüm bulunamadı.';
      applyBtn.disabled = true;
    } else {
      resultBox.style.display = 'block';
      resultText.textContent = `🎯 ${result.silences.length} adet sessiz bölüm bulundu! Toplam ${result.totalSilenceSec} saniye (%${result.percentSilence}) süre kazanılacak.`;
      applyBtn.disabled = false;
    }
  }

  _executeSilenceCut() {
    if (!this.detectedSilences || this.detectedSilences.length === 0) return;
    const buf = this.engine.currentBuffer || this.engine.audioBuffer;

    try {
      const trimmed = SilenceRemover.removeSilence(buf, this.detectedSilences, this.engine.ctx);
      this.onBufferUpdated(trimmed, 'Sessizlikler Budandı');
      this.showToast('✂️ Sessiz bölümler başarıyla kesilip birleştirildi!', 'success');
      this.close();
    } catch (err) {
      this.showToast(`Budama hatası: ${err.message}`, 'error');
    }
  }

  _executeAutotune() {
    const root = document.getElementById('autotuneRootSelect')?.value || 'A';
    const scale = document.getElementById('autotuneScaleSelect')?.value || 'minor';
    const speed = parseInt(document.getElementById('autotuneSpeedSlider')?.value || 25);
    const btn = document.getElementById('applyAutotuneBtn');
    const buf = this.engine.currentBuffer || this.engine.audioBuffer;

    btn.disabled = true;
    btn.textContent = '⏳ Auto-Tune Hesaplanıyor...';

    setTimeout(() => {
      try {
        const tuned = AutoTuneEngine.process(buf, {
          root,
          scale,
          speed,
          amount: 0.92
        }, this.engine.ctx);

        this.onBufferUpdated(tuned, `Auto-Tune (${root} ${scale})`);
        this.showToast(`🎤 Auto-Tune (${root} ${scale}) başarıyla uygulandı!`, 'success');
        this.close();
      } catch (err) {
        this.showToast(`Auto-Tune hatası: ${err.message}`, 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = '🎤 Auto-Tune Uygula';
      }
    }, 50);
  }
}
