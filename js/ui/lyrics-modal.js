/**
 * Flova Studio - AI Lyrics & Karaoke Transcriber Modal (V2.5 Pro)
 * Real-time Speech Recognition, Demucs AI Neural Vocal Isolation, Karaoke Stage Mode,
 * Micro-timing Nudge (+/-0.2s), Bulk Lyrics Auto-Sync, and .LRC / .SRT / .TXT Export.
 */

import { ApiClient } from '../audio/api-client.js';

export class LyricsModal {
  constructor(audioEngine, showToast) {
    this.engine = audioEngine;
    this.showToast = showToast || console.log;
    this.modalEl = null;
    this.lines = []; // Array of { time: number, duration?: number, text: string }
    this.isTranscribing = false;
    this.currentActiveIndex = -1;
    this.viewMode = 'editor'; // 'editor' | 'stage'
    this.audioSource = 'auto'; // 'auto' | 'vocal' | 'mix'

    this._createDOM();
  }

  _createDOM() {
    let container = document.getElementById('lyricsModalContainer');
    if (!container) {
      container = document.createElement('div');
      container.id = 'lyricsModalContainer';
      document.body.appendChild(container);
    }

    container.innerHTML = `
      <div id="lyricsModalBackdrop" class="modal-backdrop" style="display: none; position: fixed; inset: 0; background: rgba(0, 4, 15, 0.9); backdrop-filter: blur(14px); z-index: 10000; justify-content: center; align-items: center; padding: 20px;">
        <div class="glass-card lyrics-dialog" style="width: 100%; max-width: 900px; max-height: 94vh; display: flex; flex-direction: column; overflow: hidden; border: 1px solid rgba(168, 85, 247, 0.35); box-shadow: 0 25px 70px rgba(0, 0, 0, 0.8), 0 0 40px rgba(168, 85, 247, 0.2);">
          
          <!-- Header -->
          <div style="display: flex; align-items: center; justify-content: space-between; padding: 16px 24px; border-bottom: 1px solid rgba(255, 255, 255, 0.08); background: rgba(168, 85, 247, 0.04);">
            <div style="display: flex; align-items: center; gap: 12px;">
              <span style="font-size: 1.5rem; background: linear-gradient(135deg, #a855f7, #00f2fe); -webkit-background-clip: text; -webkit-text-fill-color: transparent;">🎙️</span>
              <div>
                <h3 style="margin: 0; font-size: 1.18rem; font-weight: 700; color: #fff; letter-spacing: -0.01em;">AI Şarkı Sözü & Canlı Karaoke Stüdyosu</h3>
              </div>
            </div>
            
            <!-- Mode Switcher & Close -->
            <div style="display: flex; align-items: center; gap: 10px;">
              <div style="display: flex; background: rgba(0,0,0,0.4); padding: 3px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.1);">
                <button id="lyricsModeEditorBtn" class="btn btn-sm" style="padding: 4px 10px; font-size: 0.78rem; border-radius: 6px; font-weight: 700; background: #a855f7; color: #fff; border: none; cursor: pointer;">
                  📝 Düzenleyici
                </button>
                <button id="lyricsModeStageBtn" class="btn btn-sm" style="padding: 4px 10px; font-size: 0.78rem; border-radius: 6px; font-weight: 700; background: transparent; color: #94a3b8; border: none; cursor: pointer;">
                  🎤 Karaoke Sahnesi
                </button>
              </div>
              <button id="closeLyricsModal" class="btn btn-secondary btn-sm" style="border-radius: 50%; width: 32px; height: 32px; padding: 0; display: flex; align-items: center; justify-content: center;">✕</button>
            </div>
          </div>

          <!-- Body -->
          <div style="display: flex; flex-direction: column; flex: 1; overflow-y: auto; padding: 18px 22px; gap: 12px;">
            
            <!-- Controls bar -->
            <div style="display: flex; justify-content: space-between; align-items: center; background: rgba(255, 255, 255, 0.03); padding: 10px 14px; border-radius: 10px; border: 1px solid rgba(255, 255, 255, 0.07); flex-wrap: wrap; gap: 8px;">
              
              <!-- Transcribe Action & Options -->
              <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
                <button id="startTranscribeBtn" class="btn btn-primary btn-sm" style="display: flex; align-items: center; gap: 7px; background: linear-gradient(135deg, #a855f7, #6366f1); font-weight: 700; padding: 7px 15px; box-shadow: 0 4px 15px rgba(168, 85, 247, 0.35);">
                  <span>✨ AI ile Sözleri Çıkar</span>
                </button>

                <!-- Language -->
                <select id="lyricsLanguageSelect" class="form-input" style="padding: 6px 10px; font-size: 0.8rem; background: rgba(0,0,0,0.5); border: 1px solid rgba(255,255,255,0.18); color: #fff; border-radius: 6px; font-weight: 600;">
                  <option value="tr-TR" selected>🇹🇷 Türkçe</option>
                  <option value="en-US">🇬🇧 İngilizce</option>
                  <option value="de-DE">🇩🇪 Almanca</option>
                  <option value="es-ES">🇪🇸 İspanyolca</option>
                  <option value="fr-FR">🇫🇷 Fransızca</option>
                  <option value="az-AZ">🇦🇿 Azerbaycan Türkçesi</option>
                  <option value="it-IT">🇮🇹 İtalyanca</option>
                </select>

                <!-- Model Selector -->
                <select id="lyricsModelSelect" class="form-input" style="padding: 6px 10px; font-size: 0.8rem; background: rgba(0,0,0,0.5); border: 1px solid rgba(168, 85, 247, 0.4); color: #c084fc; border-radius: 6px; font-weight: 700;" title="Yapay zeka modeli kalitesi">
                  <option value="small" selected>⚡ Whisper Pro (Önerilen)</option>
                  <option value="medium">🎯 Whisper Medium (Stüdyo Kalitesi)</option>
                  <option value="base">🚀 Whisper Base (Ultra Hızlı)</option>
                </select>

                <!-- Demucs AI Neural Vocal Separation Checkbox (Optional) -->
                <label style="display: inline-flex; align-items: center; gap: 6px; font-size: 0.76rem; font-weight: 600; color: #c084fc; background: rgba(168, 85, 247, 0.1); border: 1px solid rgba(168, 85, 247, 0.3); padding: 5px 9px; border-radius: 6px; cursor: pointer; user-select: none;" title="Demucs U-Net sinir ağı ile tüm enstrümanları izole eder. CPU üzerinde parçanın uzunluğuna göre 2-3 dakika sürebilir. Hızlı analiz için kapalı tutunuz.">
                  <input type="checkbox" id="lyricsAutoVocalAiCheck" style="accent-color: #a855f7; cursor: pointer;">
                  🤖 Demucs Derin Vokal Ayrıştırma
                </label>

                <!-- Vocal Source Badge / Switcher -->
                <span id="vocalSourceBadge" style="font-size: 0.74rem; font-weight: 700; padding: 4px 8px; border-radius: 6px; background: rgba(0, 242, 254, 0.12); border: 1px solid rgba(0, 242, 254, 0.3); color: #00f2fe; display: none;">
                  🎙️ Temiz Vokal
                </span>

                <button id="openBulkPasteBtn" class="btn btn-secondary btn-sm" style="padding: 5px 10px; font-size: 0.76rem;" title="Hazır şarkı sözlerini yapıştırıp parçaya senkronize edin">
                  📋 Söz Yapıştır
                </button>
              </div>

              <!-- Export Buttons -->
              <div style="display: flex; gap: 5px; align-items: center; flex-wrap: wrap;">
                <button id="copyLyricsTextBtn" class="btn btn-secondary btn-sm" style="padding: 4px 8px; font-size: 0.74rem;" title="Tüm sözleri metin olarak panoya kopyala">
                  📋 Kopyala
                </button>
                <button id="downloadLrcBtn" class="btn btn-secondary btn-sm" style="padding: 4px 8px; font-size: 0.74rem;" title="Spotify ve müzik çalarlar için senkronize .LRC">
                  📥 .LRC
                </button>
                <button id="downloadSrtBtn" class="btn btn-secondary btn-sm" style="padding: 4px 8px; font-size: 0.74rem;" title="Video kurguları ve YouTube için altyazı .SRT">
                  🎬 .SRT
                </button>
                <button id="downloadTxtBtn" class="btn btn-secondary btn-sm" style="padding: 4px 8px; font-size: 0.74rem;" title="Düz metin dosyası">
                  📄 .TXT
                </button>
              </div>
            </div>

            <!-- Progress Bar / Status Row -->
            <div id="lyricsProgressBox" style="display: none; background: rgba(168, 85, 247, 0.1); border: 1px solid rgba(168, 85, 247, 0.3); border-radius: 8px; padding: 10px 14px; align-items: center; gap: 12px;">
              <div class="loading-spinner" style="border-top-color: #a855f7; width: 16px; height: 16px; flex-shrink: 0;"></div>
              <span id="lyricsProgressText" style="font-size: 0.82rem; color: #e2e8f0; font-weight: 600;">Şarkı sözleri analiz ediliyor...</span>
            </div>

            <!-- 1. EDITOR VIEW (List of editable lines with time adjustments) -->
            <div id="lyricsEditorView" style="display: flex; flex-direction: column; gap: 8px; flex: 1; min-height: 320px;">
              
              <!-- Secondary Tools Bar (Offset Shift, Find & Replace, Capitalize, Clear) -->
              <div style="display: flex; justify-content: space-between; align-items: center; background: rgba(255, 255, 255, 0.02); padding: 6px 12px; border-radius: 6px; border: 1px solid rgba(255, 255, 255, 0.06); font-size: 0.76rem; flex-wrap: wrap; gap: 8px;">
                <div style="display: flex; gap: 4px; align-items: center;">
                  <span style="color: var(--text-muted, #94a3b8); font-weight: 600;">⏱️ Tümünü Kaydır:</span>
                  <button id="shiftAllBack05Btn" class="btn btn-secondary btn-sm" style="padding: 2px 7px; font-size: 0.72rem;" title="Tüm satırları 0.5s geriye al">-0.5s</button>
                  <button id="shiftAllBack02Btn" class="btn btn-secondary btn-sm" style="padding: 2px 7px; font-size: 0.72rem;" title="Tüm satırları 0.2s geriye al">-0.2s</button>
                  <button id="shiftAllFwd02Btn" class="btn btn-secondary btn-sm" style="padding: 2px 7px; font-size: 0.72rem;" title="Tüm satırları 0.2s ileriye al">+0.2s</button>
                  <button id="shiftAllFwd05Btn" class="btn btn-secondary btn-sm" style="padding: 2px 7px; font-size: 0.72rem;" title="Tüm satırları 0.5s ileriye al">+0.5s</button>
                </div>

                <div style="display: flex; gap: 6px; align-items: center;">
                  <button id="toggleFindReplaceBtn" class="btn btn-secondary btn-sm" style="padding: 3px 9px; font-size: 0.74rem;">
                    🔍 Bul & Değiştir
                  </button>
                  <button id="formatLyricsBtn" class="btn btn-secondary btn-sm" style="padding: 3px 9px; font-size: 0.74rem;" title="Her satırın ilk harfini büyüt ve noktalama işaretlerini düzenle">
                    ✨ Yazım Düzelt
                  </button>
                  <button id="clearAllLyricsBtn" class="btn btn-secondary btn-sm" style="padding: 3px 9px; font-size: 0.74rem; color: #f87171;" title="Tüm satırları sil">
                    🗑️ Temizle
                  </button>
                </div>
              </div>

              <!-- Inline Find & Replace Panel (Hidden by default) -->
              <div id="findReplacePanel" style="display: none; gap: 8px; align-items: center; background: rgba(168, 85, 247, 0.08); border: 1px solid rgba(168, 85, 247, 0.3); padding: 8px 12px; border-radius: 6px;">
                <input type="text" id="findInput" placeholder="Aranacak kelime..." class="form-input" style="flex: 1; padding: 4px 8px; font-size: 0.8rem; background: rgba(0,0,0,0.5);" />
                <span style="color: #c084fc; font-weight: 700;">➔</span>
                <input type="text" id="replaceInput" placeholder="Yeni kelime..." class="form-input" style="flex: 1; padding: 4px 8px; font-size: 0.8rem; background: rgba(0,0,0,0.5);" />
                <button id="executeReplaceBtn" class="btn btn-primary btn-sm" style="padding: 4px 12px; font-size: 0.76rem; font-weight: 700;">Değiştir</button>
                <button id="closeFindReplaceBtn" class="btn btn-secondary btn-sm" style="padding: 2px 7px;">✕</button>
              </div>

              <!-- Synchronized Lines Container -->
              <div id="lyricsLinesContainer" style="flex: 1; max-height: 420px; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; padding: 10px; background: rgba(0, 0, 0, 0.35); border-radius: 8px; border: 1px solid rgba(255, 255, 255, 0.05);">
                <div id="lyricsEmptyState" style="margin: auto; text-align: center; color: var(--text-muted, #94a3b8); padding: 40px 20px;">
                  <div style="font-size: 2.4rem; margin-bottom: 10px; opacity: 0.6;">📝</div>
                  <div style="font-weight: 700; color: #e2e8f0; font-size: 0.95rem; margin-bottom: 4px;">Henüz şarkı sözü bulunmuyor</div>
                  <div style="font-size: 0.82rem; max-width: 440px; margin: 0 auto; line-height: 1.4;">
                    Yukarıdaki <strong>"✨ AI ile Sözleri Çıkar"</strong> butonuna tıklayarak vokali otomatik yazıya dökün veya <strong>"📋 Söz Yapıştır"</strong> ile hazır sözleri aktarın.
                  </div>
                </div>
              </div>

              <!-- Manual Add Line Row -->
              <div style="display: flex; gap: 8px; align-items: center; background: rgba(255, 255, 255, 0.02); padding: 8px 12px; border-radius: 8px; border: 1px solid rgba(255, 255, 255, 0.05);">
                <input type="text" id="manualLyricInput" placeholder="Şu anki konuma yeni söz satırı yazın..." class="form-input" style="flex: 1; padding: 8px 12px; font-size: 0.85rem; border-radius: 6px; background: rgba(0,0,0,0.4); border: 1px solid rgba(255,255,255,0.12); color: #fff;" />
                <button id="addManualLyricBtn" class="btn btn-secondary btn-sm" style="font-weight: 600; padding: 7px 14px;" title="Şu anki çalma zamanına yeni satır ekle">
                  ➕ Geçerli Zamana Ekle
                </button>
              </div>

            </div>

            <!-- 2. KARAOKE STAGE VIEW (Apple Music / Spotify Style Live Prompter) -->
            <div id="lyricsStageView" style="display: none; flex-direction: column; align-items: center; justify-content: center; flex: 1; min-height: 380px; max-height: 480px; background: radial-gradient(circle at center, rgba(168, 85, 247, 0.12) 0%, rgba(0, 0, 0, 0.7) 80%); border-radius: 12px; border: 1px solid rgba(168, 85, 247, 0.25); overflow-y: auto; padding: 30px 20px; position: relative;">
              <div id="lyricsStageContainer" style="display: flex; flex-direction: column; gap: 24px; text-align: center; width: 100%; max-width: 680px; padding: 60px 0;">
                <!-- Teleprompter lines injected here -->
              </div>
            </div>

            <!-- 3. BULK PASTE POPOVER/PANEL (Hidden by default) -->
            <div id="bulkPastePanel" style="display: none; flex-direction: column; gap: 10px; background: rgba(16, 20, 36, 0.95); border: 1px solid rgba(168, 85, 247, 0.4); border-radius: 10px; padding: 16px; box-shadow: 0 10px 30px rgba(0,0,0,0.7);">
              <div style="display: flex; justify-content: space-between; align-items: center;">
                <span style="font-weight: 700; font-size: 0.9rem; color: #fff;">📋 Şarkı Sözlerini Toplu Yapıştır</span>
                <button id="closeBulkPasteBtn" class="btn btn-secondary btn-sm" style="padding: 2px 8px;">✕</button>
              </div>
              <textarea id="bulkPasteTextarea" rows="8" placeholder="Şarkı sözlerini buraya satır satır yapıştırın (Her satır ayrı bir söz cümlesi olacaktır)..." style="width: 100%; padding: 10px; background: rgba(0,0,0,0.6); border: 1px solid rgba(255,255,255,0.15); border-radius: 6px; color: #fff; font-size: 0.85rem; font-family: inherit; resize: vertical;"></textarea>
              <div style="display: flex; justify-content: space-between; align-items: center;">
                <span style="font-size: 0.75rem; color: #94a3b8;">Satırlar şarkının uzunluğuna ve vokal ritmine otomatik paylaştırılacaktır.</span>
                <button id="applyBulkPasteBtn" class="btn btn-primary btn-sm" style="background: linear-gradient(135deg, #a855f7, #6366f1); font-weight: 700;">
                  ⚡ Şarkıya Senkronize Et
                </button>
              </div>
            </div>

          </div>

          <!-- Footer -->
          <div style="padding: 12px 24px; border-top: 1px solid rgba(255, 255, 255, 0.08); display: flex; justify-content: space-between; align-items: center; background: rgba(0, 0, 0, 0.35);">
            <div style="font-size: 0.78rem; color: var(--text-muted, #94a3b8); display: flex; align-items: center; gap: 8px;">
              <span>💡 Satırlara tıklayarak o saniyeye atlayabilir, <strong>⏱️</strong> butonuyla çalma konumuna eşitleyebilir veya <strong>±0.2s</strong> ile ince ayar yapabilirsiniz.</span>
            </div>
            <button id="closeLyricsFooterBtn" class="btn btn-secondary">Kapat</button>
          </div>

        </div>
      </div>
    `;

    this.modalEl = document.getElementById('lyricsModalBackdrop');
    this._bindEvents();
  }

  _bindEvents() {
    document.getElementById('closeLyricsModal')?.addEventListener('click', () => this.close());
    document.getElementById('closeLyricsFooterBtn')?.addEventListener('click', () => this.close());

    // Switch View Modes: Editor vs Stage
    const editorBtn = document.getElementById('lyricsModeEditorBtn');
    const stageBtn = document.getElementById('lyricsModeStageBtn');
    const editorView = document.getElementById('lyricsEditorView');
    const stageView = document.getElementById('lyricsStageView');

    editorBtn?.addEventListener('click', () => {
      this.viewMode = 'editor';
      editorBtn.style.background = '#a855f7';
      editorBtn.style.color = '#fff';
      stageBtn.style.background = 'transparent';
      stageBtn.style.color = '#94a3b8';
      if (editorView) editorView.style.display = 'flex';
      if (stageView) stageView.style.display = 'none';
      this._renderLines();
    });

    stageBtn?.addEventListener('click', () => {
      this.viewMode = 'stage';
      stageBtn.style.background = '#a855f7';
      stageBtn.style.color = '#fff';
      editorBtn.style.background = 'transparent';
      editorBtn.style.color = '#94a3b8';
      if (editorView) editorView.style.display = 'none';
      if (stageView) stageView.style.display = 'flex';
      this._renderStage();
    });

    // Bulk Paste Panel Toggle
    const bulkPanel = document.getElementById('bulkPastePanel');
    document.getElementById('openBulkPasteBtn')?.addEventListener('click', () => {
      if (bulkPanel) bulkPanel.style.display = bulkPanel.style.display === 'none' ? 'flex' : 'none';
    });
    document.getElementById('closeBulkPasteBtn')?.addEventListener('click', () => {
      if (bulkPanel) bulkPanel.style.display = 'none';
    });

    // Apply Bulk Paste
    document.getElementById('applyBulkPasteBtn')?.addEventListener('click', () => {
      const textarea = document.getElementById('bulkPasteTextarea');
      const text = textarea?.value?.trim();
      if (!text) {
        this.showToast('Lütfen yapıştırılacak şarkı sözü girin.', 'warning');
        return;
      }

      this._applyBulkLyrics(text);
      if (bulkPanel) bulkPanel.style.display = 'none';
    });

    // Pro Toolbar: Global Time Shift
    document.getElementById('shiftAllBack05Btn')?.addEventListener('click', () => this.shiftAllTime(-0.5));
    document.getElementById('shiftAllBack02Btn')?.addEventListener('click', () => this.shiftAllTime(-0.2));
    document.getElementById('shiftAllFwd02Btn')?.addEventListener('click', () => this.shiftAllTime(0.2));
    document.getElementById('shiftAllFwd05Btn')?.addEventListener('click', () => this.shiftAllTime(0.5));

    // Find & Replace Panel
    const findReplacePanel = document.getElementById('findReplacePanel');
    document.getElementById('toggleFindReplaceBtn')?.addEventListener('click', () => {
      if (findReplacePanel) {
        findReplacePanel.style.display = findReplacePanel.style.display === 'none' ? 'flex' : 'none';
        if (findReplacePanel.style.display === 'flex') {
          document.getElementById('findInput')?.focus();
        }
      }
    });
    document.getElementById('closeFindReplaceBtn')?.addEventListener('click', () => {
      if (findReplacePanel) findReplacePanel.style.display = 'none';
    });
    document.getElementById('executeReplaceBtn')?.addEventListener('click', () => {
      const findText = document.getElementById('findInput')?.value?.trim();
      const replaceText = document.getElementById('replaceInput')?.value || '';
      if (!findText) {
        this.showToast('Lütfen aranacak kelimeyi girin.', 'warning');
        return;
      }
      this.findAndReplace(findText, replaceText);
    });

    // Smart Capitalize / Formatting
    document.getElementById('formatLyricsBtn')?.addEventListener('click', () => this.formatCapitalization());

    // Clear All
    document.getElementById('clearAllLyricsBtn')?.addEventListener('click', () => this.clearAllLyrics());

    // Transcribe button
    document.getElementById('startTranscribeBtn')?.addEventListener('click', () => {
      this.transcribeAudio();
    });

    // Add manual line
    document.getElementById('addManualLyricBtn')?.addEventListener('click', () => {
      const input = document.getElementById('manualLyricInput');
      const text = input?.value?.trim();
      if (!text) return;
      const time = this.engine.currentTime || 0;
      this.lines.push({ time: Math.round(time * 10) / 10, text });
      this.lines.sort((a, b) => a.time - b.time);
      input.value = '';
      this._renderLines();
      if (this.viewMode === 'stage') this._renderStage();
      this.showToast('Satır eklendi!', 'info');
    });

    // Export formats
    document.getElementById('downloadLrcBtn')?.addEventListener('click', () => this.downloadLRC());
    document.getElementById('downloadSrtBtn')?.addEventListener('click', () => this.downloadSRT());
    document.getElementById('downloadTxtBtn')?.addEventListener('click', () => this.downloadTXT());
    document.getElementById('copyLyricsTextBtn')?.addEventListener('click', () => this.copyToClipboard());

    // Close on backdrop click
    this.modalEl?.addEventListener('click', (e) => {
      if (e.target === this.modalEl) this.close();
    });
  }

  open() {
    this.modalEl.style.display = 'flex';
    this.modalEl.classList.add('active');
    this._startPlaybackFollower();

    // Check if clean vocal track is available in memory
    const badge = document.getElementById('vocalSourceBadge');
    if (window.flovaSplitter && window.flovaSplitter.vocalBuffer) {
      if (badge) {
        badge.style.display = 'inline-flex';
        badge.title = 'Ayrıştırılmış temiz vokal parçası üzerinden en yüksek doğrulukla çıkarılır.';
      }
    } else {
      if (badge) badge.style.display = 'none';
    }

    const buffer = this.engine.currentBuffer || this.engine.audioBuffer;
    if (!buffer) {
      this.showToast('Lütfen önce bir ses dosyası açın.', 'info');
    }

    this._renderLines();
  }

  close() {
    this.modalEl.classList.remove('active');
    this.modalEl.style.display = 'none';
  }

  async transcribeAudio() {
    let buffer = null;
    let usingVocalStem = false;

    // Check if clean vocal track is already split
    if (window.flovaSplitter && window.flovaSplitter.vocalBuffer) {
      buffer = window.flovaSplitter.vocalBuffer;
      usingVocalStem = true;
    } else {
      buffer = this.engine.currentBuffer || this.engine.audioBuffer;
    }

    if (!buffer) {
      this.showToast('Transkript çıkarmak için lütfen önce bir ses dosyası yükleyin.', 'warning');
      document.getElementById('openFileBtn')?.click();
      return;
    }

    const btn = document.getElementById('startTranscribeBtn');
    const lang = document.getElementById('lyricsLanguageSelect')?.value || 'tr-TR';
    const model = document.getElementById('lyricsModelSelect')?.value || 'small';
    const aiSeparate = !usingVocalStem && (document.getElementById('lyricsAutoVocalAiCheck')?.checked ?? false);
    const progressBox = document.getElementById('lyricsProgressBox');
    const progressText = document.getElementById('lyricsProgressText');

    btn.disabled = true;
    btn.innerHTML = `<span>⏳ Analiz Ediliyor...</span>`;
    if (progressBox) progressBox.style.display = 'flex';

    let elapsedSec = 0;
    const modelLabel = model === 'medium' ? 'Whisper Medium' : (model === 'base' ? 'Whisper Base' : 'Whisper Pro');
    const baseMsg = usingVocalStem
      ? `🎙️ Ayrıştırılmış temiz vokal taranıyor (${modelLabel})`
      : (aiSeparate
          ? `🤖 Demucs sinir ağı ile vokal ayrıştırılıyor ve taranıyor (${modelLabel})`
          : `🎙️ Şarkı taranıyor ve sözler çözümleniyor (${modelLabel})`);

    if (progressText) progressText.textContent = `${baseMsg} (0 sn)...`;
    const timerInterval = setInterval(() => {
      elapsedSec++;
      if (progressText) {
        progressText.textContent = `${baseMsg} (${elapsedSec} sn)...`;
      }
    }, 1000);

    try {
      // Encode audio buffer directly
      const wavBlob = await this._audioBufferToWavBlob(buffer);

      const aiVocalParam = aiSeparate ? '1' : '0';
      const transcribeUrl = ApiClient.getApiUrl(`/api/ai/transcribe?lang=${lang}&model=${model}&ai_vocal=${aiVocalParam}`);
      const resp = await fetch(transcribeUrl, {
        method: 'POST',
        body: wavBlob,
        headers: { 'Content-Type': 'audio/wav' }
      });

      if (resp.ok) {
        const data = await resp.json();
        if (data.lines && data.lines.length > 0) {
          this.lines = data.lines;
          this._renderLines();
          if (this.viewMode === 'stage') this._renderStage();
          this.showToast(`✨ ${data.lines.length} satır şarkı sözü başarıyla çıkarıldı ve ritimle eşleştirildi! (${elapsedSec} sn)`, 'success');
          return;
        } else {
          this.showToast('Parçada belirgin şarkı sözü algılanamadı. İsterseniz "Söz Yapıştır" ile hazır sözleri aktarabilirsiniz.', 'info');
        }
      } else {
        const errJson = await resp.json().catch(() => ({}));
        throw new Error(errJson.error || `Sunucu hatası: ${resp.status}`);
      }
    } catch (err) {
      console.error('[Lyrics] Server transcribe error:', err);
      this.showToast('Transkripsiyon tamamlanamadı: ' + (err.message || 'Bağlantı hatası'), 'error');
    } finally {
      clearInterval(timerInterval);
      btn.disabled = false;
      btn.innerHTML = `<span>✨ AI ile Sözleri Çıkar</span>`;
      if (progressBox) progressBox.style.display = 'none';
    }
  }

  shiftAllTime(delta) {
    if (this.lines.length === 0) return;
    this.lines.forEach(l => {
      l.time = Math.max(0, Math.round((l.time + delta) * 10) / 10);
    });
    this.lines.sort((a, b) => a.time - b.time);
    this._renderLines();
    if (this.viewMode === 'stage') this._renderStage();
    this.showToast(`⏱️ Tüm satırlar ${delta > 0 ? '+' : ''}${delta}s kaydırıldı.`, 'info');
  }

  findAndReplace(findStr, replaceStr) {
    if (!findStr || this.lines.length === 0) return;
    let count = 0;
    const regex = new RegExp(findStr, 'gi');
    this.lines.forEach(l => {
      if (regex.test(l.text)) {
        l.text = l.text.replace(regex, replaceStr);
        count++;
      }
    });
    if (count > 0) {
      this._renderLines();
      if (this.viewMode === 'stage') this._renderStage();
      this.showToast(`🔍 ${count} satırda "${findStr}" ➔ "${replaceStr}" olarak güncellendi!`, 'success');
    } else {
      this.showToast(`"${findStr}" sözlerde bulunamadı.`, 'info');
    }
  }

  formatCapitalization() {
    if (this.lines.length === 0) return;
    this.lines.forEach(l => {
      let t = (l.text || '').trim();
      if (!t) return;
      let first = t[0];
      first = first === 'i' ? 'İ' : first === 'ı' ? 'I' : first.toUpperCase();
      l.text = first + t.slice(1);
    });
    this._renderLines();
    if (this.viewMode === 'stage') this._renderStage();
    this.showToast('✨ Tüm satırlar büyük harf ve imla ile düzenlendi!', 'success');
  }

  clearAllLyrics() {
    if (this.lines.length === 0) return;
    if (confirm('Tüm şarkı sözü satırlarını silmek istediğinize emin misiniz?')) {
      this.lines = [];
      this._renderLines();
      if (this.viewMode === 'stage') this._renderStage();
      this.showToast('Tüm şarkı sözleri temizlendi.', 'info');
    }
  }

  _applyBulkLyrics(rawText) {
    const rawLines = rawText.split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 0 && !l.startsWith('[')); // filter out section headers like [Chorus]

    if (rawLines.length === 0) return;

    const totalDur = (this.engine.currentBuffer ? this.engine.currentBuffer.duration : this.engine.duration) || 120;
    const startOffset = Math.min(3.0, totalDur * 0.05);
    const usableDur = Math.max(10, totalDur - startOffset - 4.0);
    const interval = usableDur / rawLines.length;

    this.lines = rawLines.map((text, idx) => ({
      time: Math.round((startOffset + idx * interval) * 10) / 10,
      text
    }));

    this._renderLines();
    if (this.viewMode === 'stage') this._renderStage();
    this.showToast(`📋 ${rawLines.length} satır başarıyla şarkıya dağıtıldı! İstediğiniz satırın zamanını ⏱️ butonuyla ayarlayabilirsiniz.`, 'success');
  }

  _generateSmartSampleLyrics(lang) {
    const dur = (this.engine.currentBuffer ? this.engine.currentBuffer.duration : this.engine.duration) || 60;
    const interval = Math.max(4, Math.floor(dur / 10));
    this.lines = [];

    const defaultPhrases = lang.startsWith('tr') ? [
      "Gözlerin bana bir şeyler anlatıyor",
      "Karanlığın içinde parlayan bir ışık gibi",
      "Zaman duruyor sen yanımdayken",
      "Rüzgar fısıldar adını geceleri",
      "Kalbim senin ritminle atıyor",
      "Bütün yollar sana çıkıyor sanki",
      "Yıldızlar şahit olsun sevgimize",
      "Geriye dönüp baktığımda yine sen"
    ] : [
      "In the middle of the night",
      "I see the neon lights glowing",
      "Everything feels right with you",
      "Time is moving fast like a dream",
      "Listen to the rhythm of the heart",
      "Never gonna let this feeling fade",
      "Standing tall through the storm",
      "Forever in the sound of music"
    ];

    let t = 2.0;
    let idx = 0;
    while (t < dur - 2 && idx < defaultPhrases.length) {
      this.lines.push({
        time: Math.round(t * 10) / 10,
        text: defaultPhrases[idx]
      });
      t += interval;
      idx++;
    }
  }

  _renderLines() {
    const container = document.getElementById('lyricsLinesContainer');
    if (!container) return;

    if (this.lines.length === 0) {
      container.innerHTML = `
        <div id="lyricsEmptyState" style="margin: auto; text-align: center; color: var(--text-muted, #94a3b8); padding: 40px 20px;">
          <div style="font-size: 2.4rem; margin-bottom: 10px; opacity: 0.6;">📝</div>
          <div style="font-weight: 700; color: #e2e8f0; font-size: 0.95rem; margin-bottom: 4px;">Henüz şarkı sözü bulunmuyor</div>
          <div style="font-size: 0.82rem; max-width: 440px; margin: 0 auto; line-height: 1.4;">
            Yukarıdaki <strong>"✨ AI ile Sözleri Çıkar"</strong> butonuna tıklayarak vokali otomatik yazıya dökün veya <strong>"📋 Söz Yapıştır"</strong> ile hazır sözleri aktarın.
          </div>
        </div>
      `;
      return;
    }

    container.innerHTML = '';
    this.lines.forEach((line, idx) => {
      const row = document.createElement('div');
      row.className = 'lyric-row';
      row.id = `lyricRow_${idx}`;
      row.style.cssText = `
        display: flex; align-items: center; gap: 10px; padding: 8px 12px;
        background: rgba(255, 255, 255, 0.03); border-radius: 6px;
        border-left: 3px solid transparent; transition: all 0.2s ease; cursor: pointer;
      `;

      const m = Math.floor(line.time / 60);
      const s = Math.floor(line.time % 60);
      const ms = Math.floor((line.time % 1) * 10);
      const timeStr = `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}.${ms}`;

      row.innerHTML = `
        <!-- Time Badge -->
        <span class="lyric-time-badge" style="font-family: var(--font-mono, monospace); font-size: 0.78rem; color: #c084fc; font-weight: 700; min-width: 60px; user-select: none;">
          ${timeStr}
        </span>

        <!-- Sync Tools: Snap current time & Nudge -->
        <div style="display: flex; gap: 3px; align-items: center;" onclick="event.stopPropagation();">
          <button class="btn btn-secondary btn-sm snap-time-btn" data-idx="${idx}" title="Şu anki çalma saniyesine eşitle" style="padding: 2px 5px; font-size: 0.72rem; border-radius: 4px;">
            ⏱️
          </button>
          <button class="btn btn-secondary btn-sm nudge-back-btn" data-idx="${idx}" title="0.2 saniye geriye al (-0.2s)" style="padding: 2px 5px; font-size: 0.7rem; border-radius: 4px;">
            -0.2s
          </button>
          <button class="btn btn-secondary btn-sm nudge-fwd-btn" data-idx="${idx}" title="0.2 saniye ileriye al (+0.2s)" style="padding: 2px 5px; font-size: 0.7rem; border-radius: 4px;">
            +0.2s
          </button>
        </div>

        <!-- Editable Lyric Text -->
        <input type="text" value="${line.text.replace(/"/g, '&quot;')}" class="form-input" style="flex: 1; padding: 4px 8px; font-size: 0.88rem; background: transparent; border: 1px solid transparent; color: #fff; border-radius: 4px;" />

        <!-- Delete Line -->
        <button class="btn btn-secondary btn-sm delete-lyric-btn" data-idx="${idx}" style="padding: 2px 6px; font-size: 0.75rem; opacity: 0.6;" title="Satırı sil">
          🗑️
        </button>
      `;

      // Jump to time on click
      row.addEventListener('click', (e) => {
        if (e.target.tagName !== 'INPUT' && !e.target.closest('button')) {
          this.engine.seek(line.time);
          if (!this.engine.isPlaying) this.engine.play();
        }
      });

      // Snap time to current
      row.querySelector('.snap-time-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        const cur = this.engine.currentTime || 0;
        this.lines[idx].time = Math.round(cur * 10) / 10;
        this.lines.sort((a, b) => a.time - b.time);
        this._renderLines();
      });

      // Nudge timing
      row.querySelector('.nudge-back-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        this.lines[idx].time = Math.max(0, Math.round((this.lines[idx].time - 0.2) * 10) / 10);
        this.lines.sort((a, b) => a.time - b.time);
        this._renderLines();
      });

      row.querySelector('.nudge-fwd-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        this.lines[idx].time = Math.round((this.lines[idx].time + 0.2) * 10) / 10;
        this.lines.sort((a, b) => a.time - b.time);
        this._renderLines();
      });

      // Update text on input
      const inputEl = row.querySelector('input');
      inputEl.addEventListener('focus', () => {
        inputEl.style.borderColor = 'rgba(168, 85, 247, 0.4)';
        inputEl.style.background = 'rgba(0,0,0,0.4)';
      });
      inputEl.addEventListener('blur', () => {
        inputEl.style.borderColor = 'transparent';
        inputEl.style.background = 'transparent';
      });
      inputEl.addEventListener('input', (e) => {
        this.lines[idx].text = e.target.value;
      });

      // Delete line
      row.querySelector('.delete-lyric-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        this.lines.splice(idx, 1);
        this._renderLines();
      });

      container.appendChild(row);
    });
  }

  _renderStage() {
    const stageContainer = document.getElementById('lyricsStageContainer');
    if (!stageContainer) return;

    if (this.lines.length === 0) {
      stageContainer.innerHTML = `
        <div style="color: #94a3b8; font-size: 1.1rem; padding: 40px 0;">
          Henüz şarkı sözü bulunmuyor.<br><span style="font-size: 0.85rem; opacity: 0.7;">"Düzenleyici" sekmesine geçerek sözleri çıkarın veya ekleyin.</span>
        </div>
      `;
      return;
    }

    stageContainer.innerHTML = '';
    this.lines.forEach((line, idx) => {
      const lineEl = document.createElement('div');
      lineEl.id = `stageLine_${idx}`;
      lineEl.style.cssText = `
        font-size: 1.35rem; font-weight: 700; color: rgba(255, 255, 255, 0.35);
        transition: all 0.28s cubic-bezier(0.16, 1, 0.3, 1); cursor: pointer;
        padding: 8px 16px; border-radius: 8px; line-height: 1.4;
      `;
      lineEl.textContent = line.text;

      lineEl.addEventListener('click', () => {
        this.engine.seek(line.time);
        if (!this.engine.isPlaying) this.engine.play();
      });

      stageContainer.appendChild(lineEl);
    });
  }

  _startPlaybackFollower() {
    const updateFollower = () => {
      if (this.modalEl.style.display === 'none') return;

      const current = this.engine.currentTime;
      let activeIdx = -1;

      for (let i = 0; i < this.lines.length; i++) {
        if (current >= this.lines[i].time) {
          activeIdx = i;
        } else {
          break;
        }
      }

      if (activeIdx !== this.currentActiveIndex) {
        this.currentActiveIndex = activeIdx;

        // 1. Editor List Highlighting
        if (this.viewMode === 'editor') {
          this.lines.forEach((_, idx) => {
            const row = document.getElementById(`lyricRow_${idx}`);
            if (row) {
              if (idx === activeIdx) {
                row.style.background = 'rgba(168, 85, 247, 0.22)';
                row.style.borderLeft = '3px solid #a855f7';
                row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
              } else {
                row.style.background = 'rgba(255, 255, 255, 0.03)';
                row.style.borderLeft = '3px solid transparent';
              }
            }
          });
        }

        // 2. Karaoke Stage Highlighting (Large glowing prompter)
        if (this.viewMode === 'stage') {
          this.lines.forEach((_, idx) => {
            const el = document.getElementById(`stageLine_${idx}`);
            if (el) {
              if (idx === activeIdx) {
                el.style.color = '#ffffff';
                el.style.fontSize = '1.85rem';
                el.style.transform = 'scale(1.08)';
                el.style.textShadow = '0 0 30px rgba(168, 85, 247, 0.9), 0 0 10px rgba(0, 242, 254, 0.6)';
                el.style.background = 'rgba(168, 85, 247, 0.15)';
                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
              } else if (idx === activeIdx + 1) {
                el.style.color = 'rgba(255, 255, 255, 0.65)';
                el.style.fontSize = '1.35rem';
                el.style.transform = 'scale(1.0)';
                el.style.textShadow = 'none';
                el.style.background = 'transparent';
              } else {
                el.style.color = 'rgba(255, 255, 255, 0.25)';
                el.style.fontSize = '1.25rem';
                el.style.transform = 'scale(0.96)';
                el.style.textShadow = 'none';
                el.style.background = 'transparent';
              }
            }
          });
        }
      }

      requestAnimationFrame(updateFollower);
    };

    requestAnimationFrame(updateFollower);
  }

  copyToClipboard() {
    if (this.lines.length === 0) {
      this.showToast('Kopyalanacak söz bulunmuyor!', 'warning');
      return;
    }

    const fullText = this.lines.map(l => l.text).join('\n');
    navigator.clipboard.writeText(fullText).then(() => {
      this.showToast('📋 Tüm sözler panoya kopyalandı!', 'success');
    }).catch(() => {
      this.showToast('Panoya kopyalanamadı.', 'error');
    });
  }

  downloadTXT() {
    if (this.lines.length === 0) {
      this.showToast('Dışa aktarılacak söz bulunmuyor!', 'warning');
      return;
    }

    const txt = this.lines.map(l => l.text).join('\n');
    const blob = new Blob([txt], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `lyrics_${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    this.showToast('📄 .TXT şarkı sözü dosyası indirildi!', 'success');
  }

  downloadLRC() {
    if (this.lines.length === 0) {
      this.showToast('Dışa aktarılacak söz bulunmuyor!', 'warning');
      return;
    }

    const trackName = this.engine.currentFileName || 'Flova Track';
    let lrc = `[ti:${trackName}]\n[ar:Flova Studio]\n`;
    this.lines.forEach(l => {
      const m = Math.floor(l.time / 60).toString().padStart(2, '0');
      const s = Math.floor(l.time % 60).toString().padStart(2, '0');
      const ms = Math.floor((l.time % 1) * 100).toString().padStart(2, '0');
      lrc += `[${m}:${s}.${ms}]${l.text}\n`;
    });

    const blob = new Blob([lrc], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${trackName.replace(/\.[^/.]+$/, '')}.lrc`;
    a.click();
    URL.revokeObjectURL(url);
    this.showToast('📥 .LRC karaoke dosyası indirildi!', 'success');
  }

  downloadSRT() {
    if (this.lines.length === 0) {
      this.showToast('Dışa aktarılacak altyazı bulunmuyor!', 'warning');
      return;
    }

    let srt = '';
    const dur = this.engine.duration || 120;

    this.lines.forEach((l, idx) => {
      const nextTime = (idx < this.lines.length - 1) ? this.lines[idx + 1].time : Math.min(dur, l.time + 3.5);
      
      const formatSrtTime = (sec) => {
        const h = Math.floor(sec / 3600).toString().padStart(2, '0');
        const m = Math.floor((sec % 3600) / 60).toString().padStart(2, '0');
        const s = Math.floor(sec % 60).toString().padStart(2, '0');
        const ms = Math.floor((sec % 1) * 1000).toString().padStart(3, '0');
        return `${h}:${m}:${s},${ms}`;
      };

      srt += `${idx + 1}\n`;
      srt += `${formatSrtTime(l.time)} --> ${formatSrtTime(nextTime)}\n`;
      srt += `${l.text}\n\n`;
    });

    const trackName = this.engine.currentFileName || 'Flova Track';
    const blob = new Blob([srt], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${trackName.replace(/\.[^/.]+$/, '')}.srt`;
    a.click();
    URL.revokeObjectURL(url);
    this.showToast('🎬 .SRT video altyazı dosyası indirildi!', 'success');
  }

  _audioBufferToWavBlob(buffer) {
    const numChannels = 1; // mono for speech
    const sampleRate = 16000; // ideal for speech recognition
    // Support full song up to 10 minutes (600s)
    const durationToEncode = Math.min(buffer.duration, 600);
    const length = Math.floor(durationToEncode * sampleRate) * 2;
    const bufferArray = new ArrayBuffer(44 + length);
    const view = new DataView(bufferArray);

    function writeString(view, offset, string) {
      for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
      }
    }

    writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + length, true);
    writeString(view, 8, 'WAVE');
    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true); // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeString(view, 36, 'data');
    view.setUint32(40, length, true);

    const ch0 = buffer.getChannelData(0);
    const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null;
    const ratio = buffer.sampleRate / sampleRate;
    let offset = 44;
    const maxSamples = Math.floor(length / 2);

    for (let i = 0; i < maxSamples; i++) {
      const srcIdx = Math.floor(i * ratio);
      const s0 = ch0[srcIdx] || 0;
      const s1 = ch1 ? (ch1[srcIdx] || 0) : s0;
      const sample = Math.max(-1, Math.min(1, (s0 + s1) * 0.5));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true);
      offset += 2;
    }

    return new Blob([view], { type: 'audio/wav' });
  }
}
