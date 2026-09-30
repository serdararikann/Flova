/* ====================================================================
   FLOVA AUDIO STUDIO - YOUTUBE DOWNLOADER & STUDIO INTEGRATION MODULE
   Fetches YouTube video & playlist metadata, downloads MP3 / MP4 via Python backend,
   supports batch ZIP downloading and integrates directly with Flova's Editor, Merger & Splitters!
   ==================================================================== */

export class YouTubeUI {
  constructor(containerElement, audioEngine, options = {}) {
    this.container = containerElement;
    this.engine = audioEngine;
    this.options = options;

    this.videoInfo = null;
    this.currentUrl = '';
    this.selectedFormat = 'mp3'; // 'mp3' | 'mp4'
    this.selectedQuality = '320'; // '320' | '192' | '128' or '1080' | '720' | '480' | '360'
    this.isLoading = false;
    this.loadingStage = '';
    this.isDownloading = false;
    this.downloadProgressText = '';
    this.activeAbortController = null;

    // Playlist specific state
    this.selectedPlaylistIndices = new Set();
    this.isBatchDownloading = false;
    this.batchProgressPercent = 0;
    this.batchProgressText = '';
    this.cancelBatch = false;
    this.activeDownloadingItemId = null;

    this.render();
  }

  getApiBase() {
    if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
      return `http://${window.location.hostname}:3000`;
    }
    const saved = localStorage.getItem('flova_backend_url');
    if (saved) return saved.replace(/\/+$/, '');
    return window.location.origin;
  }

  escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  render() {
    this.container.innerHTML = `
      <div class="youtube-module-wrapper">
        
        <!-- Module Header -->
        <div class="youtube-header-bar">
          <div>
            <h2 class="youtube-title">🎥 YouTube MP3 & MP4 İndirici & Liste Yöneticisi</h2>
            <p class="youtube-subtitle">
              YouTube videolarını ve çalma listelerini yüksek kalitede MP3/MP4 olarak indirin, toplu ZIP paketleyin veya doğrudan stüdyo kanallarına aktarın.
            </p>
          </div>
          <div class="youtube-backend-badge" title="Arka planda çalışan yt-dlp & FFmpeg motoru">
            <span class="status-indicator-dot online"></span>
            <span>Motor: <strong>Python yt-dlp + FFmpeg</strong></span>
          </div>
        </div>

        <!-- URL Input & Search Area -->
        <div class="youtube-input-card">
          <div class="youtube-search-group">
            <div class="youtube-icon-addon">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
                <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/>
              </svg>
            </div>
            <input 
              type="text" 
              id="ytUrlInput" 
              class="youtube-url-input" 
              placeholder="YouTube video veya oynatma listesi linkini yapıştırın (youtube.com/watch?v=... veya playlist?list=...)"
              value="${this.escapeHtml(this.currentUrl)}"
              autocomplete="off"
            />
            <button id="ytPasteBtn" class="btn btn-secondary btn-sm yt-btn-inline" title="Panodaki linki yapıştır" ${this.isLoading ? 'disabled' : ''}>
              📋 Yapıştır
            </button>
            <button id="ytFetchBtn" class="btn btn-primary btn-sm yt-btn-inline" ${this.isLoading ? 'disabled' : ''}>
              ${this.isLoading ? '⏳ Getiriliyor...' : '🔍 Bilgileri Getir'}
            </button>
          </div>

          <!-- Quick Samples / Suggestions -->
          <div class="youtube-hints">
            <span class="hint-label">💡 Hızlı Örnekler:</span>
            <button type="button" class="hint-chip" onclick="window.flovaYouTube.loadPreset('https://www.youtube.com/watch?v=jNQXAC9IVRw')">
              🎥 Me at the zoo (Tek Video)
            </button>
            <button type="button" class="hint-chip" onclick="window.flovaYouTube.loadPreset('https://www.youtube.com/watch?v=dQw4w9WgXcQ')">
              🎵 Rick Astley (Tek Video)
            </button>
            <button type="button" class="hint-chip" style="border-color: rgba(239, 68, 68, 0.45); color: #f87171;" onclick="window.flovaYouTube.loadPreset('https://www.youtube.com/playlist?list=PLzCxunOM5WFLNCSF0UEHZqFJJlmdeL71S')">
              📑 SoundCloud Telifsiz (Örnek Liste)
            </button>
          </div>
        </div>

        <!-- Loading State Indicator with Cancel Button -->
        ${this.isLoading ? `
          <div class="youtube-loading-box">
            <div class="spinner"></div>
            <div style="font-weight: 700; color: #fff; margin-top: 10px; font-size: 1.05rem;">Bilgiler Alınıyor...</div>
            <div id="ytLoadingStageText" style="font-size: 0.82rem; color: var(--accent-cyan); margin-top: 4px;">
              ${this.loadingStage || 'YouTube sunucularından veriler taranıyor...'}
            </div>
            <div style="margin-top: 14px;">
              <button type="button" class="btn btn-secondary btn-sm" onclick="window.flovaYouTube.cancelLoading()" title="Aramayı durdur">
                ✕ İptal Et
              </button>
            </div>
          </div>
        ` : ''}

        <!-- 1. PLAYLIST RESULT CARD -->
        ${this.videoInfo && this.videoInfo.is_playlist && !this.isLoading ? `
          <div class="youtube-playlist-card animate-fadeIn">
            
            <!-- Playlist Top Header -->
            <div class="youtube-playlist-header">
              <div class="playlist-info-meta">
                <span class="playlist-tag-badge">📑 Oynatma Listesi</span>
                <h3 class="playlist-title">${this.escapeHtml(this.videoInfo.title)}</h3>
                <div class="playlist-stats-row">
                  <span>📺 ${this.escapeHtml(this.videoInfo.uploader)}</span>
                  <span>•</span>
                  <span>📊 <strong>${this.videoInfo.item_count}</strong> Parça</span>
                  ${this.videoInfo.total_duration_formatted ? `
                    <span>•</span>
                    <span>⏱️ Toplam: ${this.escapeHtml(this.videoInfo.total_duration_formatted)}</span>
                  ` : ''}
                </div>
              </div>

              <!-- Format & Quality Picker -->
              <div class="youtube-format-switch-bar" style="margin-top: 0; padding-top: 0; border-top: none;">
                <div class="format-toggle-group">
                  <button type="button" class="format-toggle-btn ${this.selectedFormat === 'mp3' ? 'active' : ''}" onclick="window.flovaYouTube.setFormat('mp3')">
                    🎵 MP3 (Ses)
                  </button>
                  <button type="button" class="format-toggle-btn ${this.selectedFormat === 'mp4' ? 'active' : ''}" onclick="window.flovaYouTube.setFormat('mp4')">
                    🎬 MP4 (Video)
                  </button>
                </div>

                <div class="quality-selector-group">
                  <span class="quality-label">Kalite:</span>
                  ${this.selectedFormat === 'mp3' ? `
                    <button type="button" class="quality-pill ${this.selectedQuality === '320' ? 'active' : ''}" onclick="window.flovaYouTube.setQuality('320')">
                      320 kbps (Ultra)
                    </button>
                    <button type="button" class="quality-pill ${this.selectedQuality === '192' ? 'active' : ''}" onclick="window.flovaYouTube.setQuality('192')">
                      192 kbps (Önerilen)
                    </button>
                    <button type="button" class="quality-pill ${this.selectedQuality === '128' ? 'active' : ''}" onclick="window.flovaYouTube.setQuality('128')">
                      128 kbps (Kompakt)
                    </button>
                  ` : `
                    ${(this.videoInfo.video_resolutions || ['1080p', '720p', '480p', '360p']).map(res => {
                      const val = res.replace('p', '');
                      return `
                        <button type="button" class="quality-pill ${this.selectedQuality === val ? 'active' : ''}" onclick="window.flovaYouTube.setQuality('${val}')">
                          ${res}
                        </button>
                      `;
                    }).join('')}
                  `}
                </div>
              </div>
            </div>

            <!-- Batch Action Toolbar -->
            <div class="playlist-batch-toolbar">
              <label class="playlist-select-all">
                <input 
                  type="checkbox" 
                  id="ytSelectAllCheckbox"
                  ${this.selectedPlaylistIndices.size === this.videoInfo.items.length ? 'checked' : ''}
                  onchange="window.flovaYouTube.toggleSelectAll(this.checked)"
                />
                <span>Tümünü Seç (${this.selectedPlaylistIndices.size} / ${this.videoInfo.items.length})</span>
              </label>

              <div style="display: flex; gap: 10px; align-items: center;">
                <button 
                  type="button" 
                  class="btn btn-emerald yt-col-btn-primary" 
                  ${this.isBatchDownloading || this.selectedPlaylistIndices.size === 0 ? 'disabled' : ''}
                  onclick="window.flovaYouTube.downloadPlaylistBatch()"
                  title="Seçilen parçaları ZIP paketi olarak bilgisayara indir"
                >
                  ${this.isBatchDownloading ? `<span class="spinner-sm" style="margin-right: 6px;"></span> İndiriliyor...` : `📦 Seçilenleri Toplu İndir (.ZIP)`}
                </button>
              </div>
            </div>

            <!-- Active Batch Progress Bar -->
            ${this.isBatchDownloading ? `
              <div class="playlist-batch-progress animate-fadeIn">
                <div style="display: flex; justify-content: space-between; align-items: center; font-size: 0.82rem;">
                  <span style="font-weight: 700; color: #fff;">${this.escapeHtml(this.batchProgressText || 'Toplu indirme yapılıyor...')}</span>
                  <div style="display: flex; gap: 8px; align-items: center;">
                    <span style="color: var(--accent-cyan); font-weight: 700;">%${this.batchProgressPercent}</span>
                    <button type="button" class="btn btn-secondary btn-sm" style="padding: 2px 8px; font-size: 0.72rem;" onclick="window.flovaYouTube.stopBatchDownload()">
                      ✕ Durdur
                    </button>
                  </div>
                </div>
                <div class="progress-track">
                  <div class="progress-fill" style="width: ${this.batchProgressPercent}%;"></div>
                </div>
              </div>
            ` : ''}

            <!-- Vertically Stacked Playlist Items -->
            <div class="youtube-playlist-items custom-scrollbar">
              ${this.videoInfo.items.map((item, idx) => {
                const isChecked = this.selectedPlaylistIndices.has(idx);
                const isItemDownloading = this.activeDownloadingItemId === item.id;
                return `
                  <div class="youtube-playlist-item" id="ytPlaylistItem_${idx}">
                    <!-- Checkbox -->
                    <input 
                      type="checkbox" 
                      class="playlist-item-check" 
                      ${isChecked ? 'checked' : ''} 
                      onchange="window.flovaYouTube.toggleItemCheck(${idx}, this.checked)"
                    />

                    <!-- Index -->
                    <span class="playlist-item-idx">#${item.index}</span>

                    <!-- Thumbnail -->
                    <div class="playlist-item-thumb-box">
                      <img src="${this.escapeHtml(item.thumbnail)}" alt="${this.escapeHtml(item.title)}" class="playlist-item-thumb-img" onerror="this.src='https://img.youtube.com/vi/${item.id}/hqdefault.jpg'" />
                      <span class="playlist-item-duration">${this.escapeHtml(item.duration_formatted)}</span>
                    </div>

                    <!-- Metadata -->
                    <div class="playlist-item-info">
                      <div class="playlist-item-title" title="${this.escapeHtml(item.title)}">
                        ${this.escapeHtml(item.title)}
                      </div>
                      <div class="playlist-item-artist">
                        📺 ${this.escapeHtml(item.uploader)}
                      </div>
                    </div>

                    <!-- Individual Item Actions -->
                    <div class="playlist-item-actions">
                      <!-- Single Download -->
                      <button 
                        type="button" 
                        class="btn btn-emerald btn-playlist-action" 
                        ${isItemDownloading || this.isBatchDownloading ? 'disabled' : ''}
                        onclick="window.flovaYouTube.downloadSinglePlaylistItem(${idx})"
                        title="Bu parçayı tek olarak bilgisayara indir"
                      >
                        ${isItemDownloading ? `<span class="spinner-sm"></span>` : `📥 İndir`}
                      </button>

                      <!-- Open in Editor -->
                      <button 
                        type="button" 
                        class="btn btn-primary btn-playlist-action"
                        ${isItemDownloading || this.isBatchDownloading ? 'disabled' : ''}
                        onclick="window.flovaYouTube.loadPlaylistItemToEditor(${idx})"
                        title="Düzenleyicide aç"
                      >
                        ✂️ Düzenleyici
                      </button>

                      <!-- Add to Merger -->
                      <button 
                        type="button" 
                        class="btn btn-secondary btn-playlist-action"
                        ${isItemDownloading || this.isBatchDownloading ? 'disabled' : ''}
                        onclick="window.flovaYouTube.addPlaylistItemToMerger(${idx})"
                        title="Birleştiriciye kanal olarak ekle"
                      >
                        🔗 Birleştirici
                      </button>

                      <!-- Send to Vocal Splitter -->
                      <button 
                        type="button" 
                        class="btn btn-secondary btn-playlist-action"
                        ${isItemDownloading || this.isBatchDownloading ? 'disabled' : ''}
                        onclick="window.flovaYouTube.sendPlaylistItemToVocalSplitter(${idx})"
                        title="Vokal ayırıcıya aktar"
                      >
                        🎙️ Vokal
                      </button>
                    </div>

                  </div>
                `;
              }).join('')}
            </div>

          </div>
        ` : ''}

        <!-- 2. SINGLE VIDEO RESULT CARD (3-Column Layout) -->
        ${this.videoInfo && !this.videoInfo.is_playlist && !this.isLoading ? `
          <div class="youtube-result-card animate-fadeIn">
            
            <div class="youtube-card-layout">
              <!-- Left: Video Thumbnail -->
              <div class="youtube-thumb-wrapper">
                <img src="${this.escapeHtml(this.videoInfo.thumbnail)}" alt="${this.escapeHtml(this.videoInfo.title)}" class="youtube-thumb-img" onerror="this.src='https://img.youtube.com/vi/${this.videoInfo.id}/hqdefault.jpg'" />
                <span class="youtube-duration-tag">⏱️ ${this.escapeHtml(this.videoInfo.duration_formatted)}</span>
              </div>

              <!-- Center: Video Info & Format Switcher -->
              <div class="youtube-info-col">
                <div class="youtube-uploader-badge">
                  <span>📺 ${this.escapeHtml(this.videoInfo.uploader)}</span>
                </div>
                <h3 class="youtube-video-title" title="${this.escapeHtml(this.videoInfo.title)}">
                  ${this.escapeHtml(this.videoInfo.title)}
                </h3>

                <!-- Format Selection Tabs: MP3 (Audio) vs MP4 (Video) -->
                <div class="youtube-format-switch-bar">
                  <div class="format-toggle-group">
                    <button type="button" class="format-toggle-btn ${this.selectedFormat === 'mp3' ? 'active' : ''}" onclick="window.flovaYouTube.setFormat('mp3')">
                      🎵 MP3 (Ses)
                    </button>
                    <button type="button" class="format-toggle-btn ${this.selectedFormat === 'mp4' ? 'active' : ''}" onclick="window.flovaYouTube.setFormat('mp4')">
                      🎬 MP4 (Video)
                    </button>
                  </div>

                  <!-- Quality Option Pills -->
                  <div class="quality-selector-group">
                    <span class="quality-label">Kalite:</span>
                    ${this.selectedFormat === 'mp3' ? `
                      <button type="button" class="quality-pill ${this.selectedQuality === '320' ? 'active' : ''}" onclick="window.flovaYouTube.setQuality('320')">
                        320 kbps (Ultra)
                      </button>
                      <button type="button" class="quality-pill ${this.selectedQuality === '192' ? 'active' : ''}" onclick="window.flovaYouTube.setQuality('192')">
                        192 kbps (Önerilen)
                      </button>
                      <button type="button" class="quality-pill ${this.selectedQuality === '128' ? 'active' : ''}" onclick="window.flovaYouTube.setQuality('128')">
                        128 kbps (Kompakt)
                      </button>
                    ` : `
                      ${(this.videoInfo.video_resolutions || ['1080p', '720p', '480p', '360p']).map(res => {
                        const val = res.replace('p', '');
                        return `
                          <button type="button" class="quality-pill ${this.selectedQuality === val ? 'active' : ''}" onclick="window.flovaYouTube.setQuality('${val}')">
                            ${res}
                          </button>
                        `;
                      }).join('')}
                    `}
                  </div>
                </div>

                <!-- Progress Feedback Inline -->
                ${this.isDownloading ? `
                  <div class="youtube-progress-inline">
                    <span class="spinner-sm"></span>
                    <span>${this.downloadProgressText || 'Dosya indiriliyor ve dönüştürülüyor...'}</span>
                  </div>
                ` : ''}
              </div>

              <!-- Right: Stacked Action Buttons -->
              <div class="youtube-actions-col">
                <!-- 1. Direct Download to PC -->
                <button id="ytDownloadBtn" class="btn btn-emerald yt-col-btn yt-col-btn-primary" ${this.isDownloading ? 'disabled' : ''} onclick="window.flovaYouTube.downloadDirect()" title="Dosyayı doğrudan bilgisayara kaydet">
                  ${this.isDownloading ? `<span class="spinner-sm" style="margin-right: 6px;"></span> İndiriliyor...` : `📥 Bilgisayara İndir (.${this.selectedFormat})`}
                </button>

                <!-- 2. Open in Studio Waveform Editor -->
                <button class="btn btn-primary yt-col-btn" ${this.isDownloading ? 'disabled' : ''} onclick="window.flovaYouTube.loadToEditor()" title="Doğrudan Flova Kesici/Düzenleyici dalga formunda açar">
                  ✂️ Düzenleyicide Aç
                </button>

                <!-- 3. Add to Merger Track -->
                <button class="btn btn-secondary yt-col-btn" ${this.isDownloading ? 'disabled' : ''} onclick="window.flovaYouTube.addToMerger()" title="Şarkı Birleştirici parçalarına yeni kanal olarak ekler">
                  🔗 Birleştiriciye Ekle
                </button>

                <!-- 4. Send to AI Vocal Splitter -->
                <button class="btn btn-secondary yt-col-btn" ${this.isDownloading ? 'disabled' : ''} onclick="window.flovaYouTube.sendToVocalSplitter()" title="Şarkıyı AI Vokal / Enstrümantal ayırıcıya aktarır">
                  🎙️ Vokalleri Ayır
                </button>
              </div>
            </div>

          </div>
        ` : ''}

      </div>
    `;

    this.bindEvents();
  }

  bindEvents() {
    const urlInput = this.container.querySelector('#ytUrlInput');
    const fetchBtn = this.container.querySelector('#ytFetchBtn');
    const pasteBtn = this.container.querySelector('#ytPasteBtn');

    if (fetchBtn && urlInput) {
      fetchBtn.addEventListener('click', () => {
        this.fetchVideoInfo(urlInput.value);
      });

      urlInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          this.fetchVideoInfo(urlInput.value);
        }
      });

      urlInput.addEventListener('input', (e) => {
        this.currentUrl = e.target.value;
      });
    }

    if (pasteBtn && urlInput) {
      pasteBtn.addEventListener('click', async () => {
        try {
          const text = await navigator.clipboard.readText();
          if (text) {
            urlInput.value = text.trim();
            this.currentUrl = text.trim();
            this.fetchVideoInfo(urlInput.value);
          }
        } catch (err) {
          if (window.flovaApp) window.flovaApp.showToast('Panoya erişilemedi, lütfen linki elle yapıştırın.', 'info');
        }
      });
    }
  }

  loadPreset(url) {
    this.currentUrl = url;
    const urlInput = this.container.querySelector('#ytUrlInput');
    if (urlInput) {
      urlInput.value = url;
    }
    this.fetchVideoInfo(url);
  }

  setFormat(fmt) {
    this.selectedFormat = fmt;
    if (fmt === 'mp3') {
      this.selectedQuality = '320';
    } else {
      const defaultRes = (this.videoInfo && this.videoInfo.video_resolutions && this.videoInfo.video_resolutions[0]) || '720p';
      this.selectedQuality = defaultRes.replace('p', '');
    }
    this.render();
  }

  setQuality(q) {
    this.selectedQuality = q;
    this.render();
  }

  toggleSelectAll(checked) {
    if (!this.videoInfo || !this.videoInfo.items) return;
    if (checked) {
      this.selectedPlaylistIndices = new Set(this.videoInfo.items.map((_, i) => i));
    } else {
      this.selectedPlaylistIndices.clear();
    }
    this.render();
  }

  toggleItemCheck(idx, checked) {
    if (checked) {
      this.selectedPlaylistIndices.add(idx);
    } else {
      this.selectedPlaylistIndices.delete(idx);
    }
    const selectAllCheck = this.container.querySelector('#ytSelectAllCheckbox');
    if (selectAllCheck && this.videoInfo && this.videoInfo.items) {
      selectAllCheck.checked = this.selectedPlaylistIndices.size === this.videoInfo.items.length;
    }
    const label = this.container.querySelector('.playlist-select-all span');
    if (label && this.videoInfo && this.videoInfo.items) {
      label.textContent = `Tümünü Seç (${this.selectedPlaylistIndices.size} / ${this.videoInfo.items.length})`;
    }
  }

  cancelLoading() {
    if (this.activeAbortController) {
      this.activeAbortController.abort('İptal edildi');
      this.activeAbortController = null;
    }
    this.isLoading = false;
    this.loadingStage = '';
    this.render();
    if (window.flovaApp) {
      window.flovaApp.showToast('YouTube arama işlemi iptal edildi.', 'info');
    }
  }

  async fetchVideoInfo(url) {
    url = (url || '').trim();
    if (!url) {
      if (window.flovaApp) window.flovaApp.showToast('Lütfen geçerli bir YouTube video veya çalma listesi linki girin.', 'error');
      return;
    }

    this.currentUrl = url;
    this.isLoading = true;
    this.loadingStage = 'Python backend motoruna bağlanılıyor...';
    this.render();

    this.activeAbortController = new AbortController();
    const timeoutId = setTimeout(() => {
      if (this.activeAbortController) {
        this.activeAbortController.abort('Zaman aşımı');
      }
    }, 25000);

    const stageTimer = setTimeout(() => {
      if (this.isLoading) {
        this.loadingStage = 'YouTube sunucularından video ve liste formatları taranıyor...';
        const stageEl = document.getElementById('ytLoadingStageText');
        if (stageEl) stageEl.textContent = this.loadingStage;
      }
    }, 1500);

    try {
      const apiEndpoint = `${this.getApiBase()}/api/youtube/info?url=${encodeURIComponent(url)}`;
      const resp = await fetch(apiEndpoint, {
        signal: this.activeAbortController.signal
      });

      clearTimeout(timeoutId);
      clearTimeout(stageTimer);
      this.activeAbortController = null;

      const contentType = resp.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        throw new Error('Sunucudan beklenmeyen yanıt geldi. Python sunucusunun (server.py) çalıştığından emin olun.');
      }

      const data = await resp.json();

      if (!resp.ok || !data.success) {
        throw new Error(data.error || 'Bilgiler alınamadı.');
      }

      this.videoInfo = data;
      this.selectedFormat = 'mp3';
      this.selectedQuality = '320';
      this.isLoading = false;
      this.loadingStage = '';

      if (data.is_playlist && data.items) {
        this.selectedPlaylistIndices = new Set(data.items.map((_, i) => i));
      }

      this.render();

      if (window.flovaApp) {
        const titleText = data.is_playlist ? `Çalma Listesi: "${data.title}" (${data.item_count} parça)` : `"${data.title}"`;
        window.flovaApp.showToast(`${titleText} başarıyla getirildi!`, 'success');
      }
    } catch (err) {
      clearTimeout(timeoutId);
      clearTimeout(stageTimer);
      this.activeAbortController = null;
      console.error('YouTube info error:', err);
      this.isLoading = false;
      this.loadingStage = '';
      this.render();

      let msg = err.message || String(err);
      if (err.name === 'AbortError' || msg.includes('Zaman aşımı')) {
        msg = 'Bağlantı zaman aşımına uğradı (25s). YouTube sunucusu geç yanıt veriyor, lütfen tekrar deneyin.';
      } else if (msg.includes('Failed to fetch') || msg.includes('NetworkError')) {
        msg = 'Flova Python backend sunucusuna (localhost:3000) erişilemedi. Lütfen sunucunun (server.py) çalıştığından emin olun.';
      }

      if (window.flovaApp) {
        window.flovaApp.showToast(msg, 'error');
      }
    }
  }

  /**
   * Batch downloads all selected playlist items into a ZIP bundle
   */
  async downloadPlaylistBatch() {
    if (!this.videoInfo || !this.videoInfo.is_playlist || !this.videoInfo.items) return;
    if (typeof window.JSZip === 'undefined') {
      if (window.flovaApp) window.flovaApp.showToast('JSZip kütüphanesi yüklenemedi.', 'error');
      return;
    }

    const indices = Array.from(this.selectedPlaylistIndices).sort((a, b) => a - b);
    if (indices.length === 0) {
      if (window.flovaApp) window.flovaApp.showToast('Lütfen indirmek için en az bir parça seçin.', 'info');
      return;
    }

    this.isBatchDownloading = true;
    this.cancelBatch = false;
    this.batchProgressPercent = 0;
    this.batchProgressText = `Toplu indirme başlatılıyor (${indices.length} parça)...`;
    this.render();

    const zip = new window.JSZip();
    let successCount = 0;

    for (let i = 0; i < indices.length; i++) {
      if (this.cancelBatch) {
        break;
      }

      const itemIdx = indices[i];
      const item = this.videoInfo.items[itemIdx];
      const currentNum = i + 1;

      this.batchProgressPercent = Math.round((i / indices.length) * 100);
      this.batchProgressText = `İndiriliyor: ${currentNum} / ${indices.length} ("${item.title.substring(0, 30)}...")`;
      this.render();

      try {
        const itemUrl = item.url || `https://www.youtube.com/watch?v=${item.id}`;
        const downloadUrl = `${this.getApiBase()}/api/youtube/download?url=${encodeURIComponent(itemUrl)}&format=${this.selectedFormat}&quality=${this.selectedQuality}`;
        
        const resp = await fetch(downloadUrl);
        if (!resp.ok) {
          console.warn(`Parça #${item.index} indirilemedi (${resp.status})`);
          continue;
        }

        const arrayBuffer = await resp.arrayBuffer();
        const cleanTitle = (item.title || f`parca_${item.index}`).replace(/[\\/:*?"<>|]/g, '_').trim();
        const filename = `${String(item.index).padStart(2, '0')} - ${cleanTitle}.${this.selectedFormat}`;
        
        zip.file(filename, arrayBuffer);
        successCount++;
      } catch (err) {
        console.error(`Error downloading item #${item.index}:`, err);
      }
    }

    if (this.cancelBatch) {
      this.isBatchDownloading = false;
      this.batchProgressPercent = 0;
      this.batchProgressText = '';
      this.render();
      if (window.flovaApp) window.flovaApp.showToast('Toplu indirme kullanıcı tarafından durduruldu.', 'info');
      return;
    }

    if (successCount === 0) {
      this.isBatchDownloading = false;
      this.batchProgressPercent = 0;
      this.batchProgressText = '';
      this.render();
      if (window.flovaApp) window.flovaApp.showToast('Hiçbir parça indirilemedi.', 'error');
      return;
    }

    this.batchProgressPercent = 100;
    this.batchProgressText = 'ZIP paketi oluşturuluyor ve sıkıştırılıyor...';
    this.render();

    try {
      const zipBlob = await zip.generateAsync({ type: 'blob' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(zipBlob);
      const cleanPlTitle = (this.videoInfo.title || 'flova_playlist').replace(/[\\/:*?"<>|]/g, '_').trim();
      a.download = `${cleanPlTitle}_Flova_${this.selectedFormat.toUpperCase()}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);

      setTimeout(() => URL.revokeObjectURL(a.href), 20000);

      this.isBatchDownloading = false;
      this.batchProgressPercent = 0;
      this.batchProgressText = '';
      this.render();

      if (window.flovaApp) {
        window.flovaApp.showToast(`🎉 ${successCount} parça başarıyla ZIP olarak indirildi!`, 'success');
      }
    } catch (err) {
      console.error('ZIP generation error:', err);
      this.isBatchDownloading = false;
      this.batchProgressPercent = 0;
      this.batchProgressText = '';
      this.render();
      if (window.flovaApp) window.flovaApp.showToast(`ZIP oluşturma hatası: ${err.message || err}`, 'error');
    }
  }

  stopBatchDownload() {
    this.cancelBatch = true;
  }

  /**
   * Downloads a single playlist item directly to user's PC
   */
  async downloadSinglePlaylistItem(idx) {
    if (!this.videoInfo || !this.videoInfo.items || !this.videoInfo.items[idx]) return;
    const item = this.videoInfo.items[idx];

    this.activeDownloadingItemId = item.id;
    this.render();

    try {
      const itemUrl = item.url || `https://www.youtube.com/watch?v=${item.id}`;
      const downloadUrl = `${this.getApiBase()}/api/youtube/download?url=${encodeURIComponent(itemUrl)}&format=${this.selectedFormat}&quality=${this.selectedQuality}`;
      
      const resp = await fetch(downloadUrl);
      if (!resp.ok) {
        throw new Error(`Sunucu hatası (${resp.status})`);
      }

      const blob = await resp.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      const safeTitle = (item.title || 'flova_track').replace(/[\\/:*?"<>|]/g, '_');
      a.download = `${safeTitle}.${this.selectedFormat}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);

      setTimeout(() => URL.revokeObjectURL(a.href), 15000);

      this.activeDownloadingItemId = null;
      this.render();

      if (window.flovaApp) {
        window.flovaApp.showToast(`"${item.title}" başarıyla indirildi!`, 'success');
      }
    } catch (err) {
      console.error('Item download error:', err);
      this.activeDownloadingItemId = null;
      this.render();
      if (window.flovaApp) {
        window.flovaApp.showToast(`İndirme başarısız: ${err.message || err}`, 'error');
      }
    }
  }

  /**
   * Directly downloads single video
   */
  async downloadDirect() {
    if (!this.videoInfo) return;
    const urlInput = this.container.querySelector('#ytUrlInput');
    const ytUrl = urlInput ? urlInput.value.trim() : (this.currentUrl || '');
    if (!ytUrl) return;

    this.isDownloading = true;
    this.downloadProgressText = `YouTube'dan ${this.selectedFormat.toUpperCase()} (${this.selectedQuality}) indiriliyor ve dönüştürülüyor... Lütfen bekleyin.`;
    this.render();

    try {
      const downloadUrl = `${this.getApiBase()}/api/youtube/download?url=${encodeURIComponent(ytUrl)}&format=${this.selectedFormat}&quality=${this.selectedQuality}`;
      const resp = await fetch(downloadUrl);
      if (!resp.ok) {
        const errData = await resp.json().catch(() => null);
        throw new Error((errData && errData.error) || `Sunucu hatası (${resp.status})`);
      }

      this.downloadProgressText = 'Dosya tarayıcıya aktarılıyor...';
      this.render();

      const blob = await resp.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      const safeTitle = (this.videoInfo.title || 'flova_youtube').replace(/[\\/:*?"<>|]/g, '_');
      a.download = `${safeTitle}.${this.selectedFormat}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);

      setTimeout(() => URL.revokeObjectURL(blobUrl), 15000);

      this.isDownloading = false;
      this.downloadProgressText = '';
      this.render();

      if (window.flovaApp) {
        window.flovaApp.showToast(`"${this.videoInfo.title}" başarıyla indirildi!`, 'success');
      }
    } catch (err) {
      console.error('Download error:', err);
      this.isDownloading = false;
      this.downloadProgressText = '';
      this.render();
      if (window.flovaApp) {
        window.flovaApp.showToast(`İndirme başarısız: ${err.message || err}`, 'error');
      }
    }
  }

  /**
   * Loads item into Waveform Editor
   */
  async loadPlaylistItemToEditor(idx) {
    if (!this.videoInfo || !this.videoInfo.items || !this.videoInfo.items[idx]) return;
    const item = this.videoInfo.items[idx];
    const audioBuffer = await this.fetchItemAudioBuffer(item);
    if (!audioBuffer) return;

    this.engine.currentFileName = `${item.title}.mp3`;
    this.engine.setBuffer(audioBuffer, true);

    if (window.flovaApp) {
      window.flovaApp.switchMode('editor');
      window.flovaApp.showToast(`"${item.title}" stüdyo düzenleyicide açıldı!`, 'success');
    }
  }

  /**
   * Adds item to Merger sequencer
   */
  async addPlaylistItemToMerger(idx) {
    if (!this.videoInfo || !this.videoInfo.items || !this.videoInfo.items[idx]) return;
    const item = this.videoInfo.items[idx];
    const audioBuffer = await this.fetchItemAudioBuffer(item);
    if (!audioBuffer) return;

    if (window.flovaMerger) {
      window.flovaMerger.addTrackFromBuffer(audioBuffer, `${item.title}.mp3`);
      if (window.flovaApp) {
        window.flovaApp.switchMode('merger');
        window.flovaApp.showToast(`"${item.title}" birleştiriciye eklendi!`, 'success');
      }
    }
  }

  /**
   * Sends item to AI Vocal Splitter
   */
  async sendPlaylistItemToVocalSplitter(idx) {
    if (!this.videoInfo || !this.videoInfo.items || !this.videoInfo.items[idx]) return;
    const item = this.videoInfo.items[idx];
    const audioBuffer = await this.fetchItemAudioBuffer(item);
    if (!audioBuffer) return;

    if (window.flovaSplitter) {
      window.flovaSplitter.loadBuffer(audioBuffer, `${item.title}.mp3`);
      if (window.flovaApp) {
        window.flovaApp.switchMode('vocal-splitter');
        window.flovaApp.showToast(`"${item.title}" vokal ayırıcıya aktarıldı!`, 'success');
      }
    }
  }

  async loadToEditor() {
    if (!this.videoInfo) return;
    const audioBuffer = await this.fetchAudioBuffer();
    if (!audioBuffer) return;

    this.engine.currentFileName = `${this.videoInfo.title}.mp3`;
    this.engine.setBuffer(audioBuffer, true);

    if (window.flovaApp) {
      window.flovaApp.switchMode('editor');
      window.flovaApp.showToast(`"${this.videoInfo.title}" stüdyo düzenleyicide açıldı!`, 'success');
    }
  }

  async addToMerger() {
    if (!this.videoInfo) return;
    const audioBuffer = await this.fetchAudioBuffer();
    if (!audioBuffer) return;

    if (window.flovaMerger) {
      window.flovaMerger.addTrackFromBuffer(audioBuffer, `${this.videoInfo.title}.mp3`);
      if (window.flovaApp) {
        window.flovaApp.switchMode('merger');
        window.flovaApp.showToast(`"${this.videoInfo.title}" birleştiriciye eklendi!`, 'success');
      }
    }
  }

  async sendToVocalSplitter() {
    if (!this.videoInfo) return;
    const audioBuffer = await this.fetchAudioBuffer();
    if (!audioBuffer) return;

    if (window.flovaSplitter) {
      window.flovaSplitter.loadBuffer(audioBuffer, `${this.videoInfo.title}.mp3`);
      if (window.flovaApp) {
        window.flovaApp.switchMode('vocal-splitter');
        window.flovaApp.showToast(`"${this.videoInfo.title}" vokal ayırıcıya aktarıldı!`, 'success');
      }
    }
  }

  async fetchItemAudioBuffer(item) {
    this.activeDownloadingItemId = item.id;
    this.render();

    if (window.flovaApp) {
      window.flovaApp.showToast(`"${item.title}" stüdyoya aktarılmak üzere indiriliyor...`, 'info');
    }

    try {
      const itemUrl = item.url || `https://www.youtube.com/watch?v=${item.id}`;
      const downloadUrl = `${this.getApiBase()}/api/youtube/download?url=${encodeURIComponent(itemUrl)}&format=mp3&quality=320`;
      const resp = await fetch(downloadUrl);
      if (!resp.ok) {
        throw new Error(`İndirme başarısız (${resp.status})`);
      }

      const arrayBuffer = await resp.arrayBuffer();
      this.engine.ensureContext();
      const decodedBuffer = await this.engine.ctx.decodeAudioData(arrayBuffer);

      this.activeDownloadingItemId = null;
      this.render();
      return decodedBuffer;
    } catch (err) {
      console.error('Audio fetch/decode error:', err);
      this.activeDownloadingItemId = null;
      this.render();
      if (window.flovaApp) {
        window.flovaApp.showToast(`Stüdyoya aktarma hatası: ${err.message || err}`, 'error');
      }
      return null;
    }
  }

  async fetchAudioBuffer() {
    const urlInput = this.container.querySelector('#ytUrlInput');
    const ytUrl = urlInput ? urlInput.value.trim() : (this.currentUrl || '');
    if (!ytUrl) return null;

    this.isDownloading = true;
    this.downloadProgressText = 'Ses indiriliyor ve stüdyo için işleniyor...';
    this.render();

    try {
      const downloadUrl = `${this.getApiBase()}/api/youtube/download?url=${encodeURIComponent(ytUrl)}&format=mp3&quality=320`;
      const resp = await fetch(downloadUrl);
      if (!resp.ok) {
        throw new Error(`İndirme başarısız (${resp.status})`);
      }

      this.downloadProgressText = 'Ses verisi çözülüyor (Decoding)...';
      this.render();

      const arrayBuffer = await resp.arrayBuffer();
      this.engine.ensureContext();
      const decodedBuffer = await this.engine.ctx.decodeAudioData(arrayBuffer);

      this.isDownloading = false;
      this.downloadProgressText = '';
      this.render();
      return decodedBuffer;
    } catch (err) {
      console.error('Audio fetch/decode error:', err);
      this.isDownloading = false;
      this.downloadProgressText = '';
      this.render();
      if (window.flovaApp) {
        window.flovaApp.showToast(`Stüdyoya aktarma hatası: ${err.message || err}`, 'error');
      }
      return null;
    }
  }
}
