/* ====================================================================
   FLOVA AUDIO STUDIO - YOUTUBE DOWNLOADER & STUDIO INTEGRATION MODULE
   Fetches YouTube video & playlist metadata, downloads high-fidelity MP3 via Python backend,
   supports batch ZIP downloading and integrates directly with Flova's Editor, Merger & Splitters!
   ==================================================================== */

import { ApiClient } from '../audio/api-client.js';

export class YouTubeUI {
  constructor(containerElement, audioEngine, options = {}) {
    this.container = containerElement;
    this.engine = audioEngine;
    this.options = options;

    this.videoInfo = null;
    this.currentUrl = '';
    this.selectedFormat = 'mp3'; // Flova is exclusively an Audio Studio (MP3)
    this.selectedQuality = '320'; // '320' | '192' | '128' kbps
    this.isLoading = false;
    this.loadingStage = '';
    this.isDownloading = false;
    this.downloadProgressText = '';
    this.activeAbortController = null;

    // Search and Preview state
    this.searchResults = null;
    this.searchQuery = '';
    this.activePreviewAudio = null;
    this.previewingItemId = null;

    // Playlist specific state
    this.selectedPlaylistIndices = new Set();
    this.isBatchDownloading = false;
    this.batchProgressPercent = 0;
    this.batchProgressText = '';
    this.cancelBatch = false;
    this.activeDownloadingItemId = null;
    this.cookieStatus = null;
    this.isCookieModalOpen = false;

    this.render();
    this.fetchCookieStatus();
  }

  getApiBase() {
    return ApiClient.getBaseUrl();
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
    const hasCookies = this.cookieStatus && this.cookieStatus.has_cookies;
    this.container.innerHTML = `
      <div class="youtube-module-wrapper">
        
        <!-- Module Header -->
        <div class="youtube-header-bar">
          <div>
            <h2 class="youtube-title">🎥 YouTube Müzik & Ses Yöneticisi</h2>
            <p class="youtube-subtitle">
              YouTube parçalarını stüdyo düzenleyicisine aktarın, vokallerini ayrıştırın veya MP3 olarak indirin.
            </p>
          </div>
          <div class="youtube-backend-badge" title="Arka planda çalışan yüksek hızlı ses işleme motoru">
            <span class="status-indicator-dot online"></span>
            <span>Motor: <strong>Python AI Studio + FFmpeg</strong></span>
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
              placeholder="YouTube video/liste linki yapıştırın veya şarkı / sanatçı adı arayın (örn: Metallica, Rick Astley, youtu.be/...)"
              value="${this.escapeHtml(this.currentUrl)}"
              autocomplete="off"
            />
            <button id="ytPasteBtn" class="btn btn-secondary btn-sm yt-btn-inline" title="Panodaki linki yapıştır" ${this.isLoading ? 'disabled' : ''}>
              📋 Yapıştır
            </button>
            <button id="ytFetchBtn" class="btn btn-primary btn-sm yt-btn-inline" ${this.isLoading ? 'disabled' : ''}>
              ${this.isLoading ? '⏳ Getiriliyor...' : '🔍 Ara & Getir'}
            </button>
          </div>

          <!-- Quick Samples / Suggestions -->
          <div class="youtube-hints">
            <span class="hint-label">💡 Hızlı Örnekler & Aramalar:</span>
            <button type="button" class="hint-chip" onclick="window.flovaYouTube.loadPreset('https://www.youtube.com/watch?v=jNQXAC9IVRw')">
              🎥 Me at the zoo (Video)
            </button>
            <button type="button" class="hint-chip" onclick="window.flovaYouTube.loadPreset('https://www.youtube.com/watch?v=dQw4w9WgXcQ')">
              🎵 Rick Astley (Video)
            </button>
            <button type="button" class="hint-chip" style="border-color: rgba(239, 68, 68, 0.45); color: #f87171;" onclick="window.flovaYouTube.loadPreset('https://www.youtube.com/playlist?list=PLzCxunOM5WFLNCSF0UEHZqFJJlmdeL71S')">
              📑 Telifsiz Müzik (Liste)
            </button>
            <button type="button" class="hint-chip" style="border-color: rgba(168, 85, 247, 0.45); color: #c084fc;" onclick="window.flovaYouTube.searchVideos('queen bohemian rhapsody')">
              🔍 Queen
            </button>
            <button type="button" class="hint-chip" style="border-color: rgba(56, 189, 248, 0.45); color: #38bdf8;" onclick="window.flovaYouTube.searchVideos('metallica enter sandman')">
              🔍 Metallica
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

        <!-- SEARCH RESULTS GRID -->
        ${this.searchResults && this.searchResults.length > 0 && !this.isLoading && !this.videoInfo ? `
          <div class="youtube-search-results-section animate-fadeIn">
            <div class="youtube-search-header">
              <div class="youtube-search-title-text">
                <span>🔍 Arama Sonuçları: <strong>"${this.escapeHtml(this.searchQuery)}"</strong></span>
                <span class="youtube-search-count-badge">${this.searchResults.length} Parça Bulundu</span>
              </div>
              <button type="button" class="btn btn-secondary btn-sm" onclick="window.flovaYouTube.clearSearchResults()">
                ✕ Sonuçları Temizle
              </button>
            </div>

            <div class="youtube-search-results-grid">
              ${this.searchResults.map((item, idx) => `
                <div class="youtube-search-card" id="ytSearchCard_${idx}">
                  <div class="yt-card-top-row" onclick="window.flovaYouTube.selectSearchResult(${idx})" title="Detayları ve indirme seçeneklerini gör">
                    <div class="yt-card-thumb-wrap">
                      <img src="${this.escapeHtml(item.thumbnail)}" alt="${this.escapeHtml(item.title)}" class="yt-card-thumb-img" onerror="this.src='https://img.youtube.com/vi/${item.id}/hqdefault.jpg'" />
                      <span class="yt-card-dur-tag">${this.escapeHtml(item.duration_formatted)}</span>
                    </div>
                    <div class="yt-card-meta">
                      <div class="yt-card-title" title="${this.escapeHtml(item.title)}">${this.escapeHtml(item.title)}</div>
                      <div class="yt-card-channel">📺 ${this.escapeHtml(item.uploader)}</div>
                    </div>
                  </div>

                  <div class="yt-card-actions">
                    <button type="button" class="btn-yt-card btn-yt-card-editor" onclick="window.flovaYouTube.loadSearchResultToEditor(${idx})" title="Doğrudan Dalga Formu Düzenleyicide aç">
                      ✂️ Düzenleyicide Aç
                    </button>
                    <button type="button" class="btn-yt-card btn-yt-card-stem" onclick="window.flovaYouTube.loadSearchResultToStemSplitter(${idx})" title="4/6-Stem Enstrüman Ayırıcıya aktar">
                      🎸 Stemler
                    </button>
                    <button type="button" class="btn-yt-card btn-yt-card-vocal" onclick="window.flovaYouTube.loadSearchResultToVocalSplitter(${idx})" title="AI Vokal / Enstrümantal Ayırıcıya aktar">
                      🎙️ Vokal
                    </button>
                    <button type="button" class="btn-yt-card btn-yt-card-download" onclick="window.flovaYouTube.downloadSearchResultDirect(${idx})" title="MP3 olarak bilgisayara indir">
                      📥 İndir (MP3)
                    </button>
                  </div>
                </div>
              `).join('')}
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

              <!-- MP3 Quality Picker -->
              <div class="youtube-format-switch-bar" style="margin-top: 0; padding-top: 0; border-top: none;">
                <div class="quality-selector-group">
                  <span class="quality-label">🎵 MP3 Kalitesi:</span>
                  <button type="button" class="quality-pill ${this.selectedQuality === '320' ? 'active' : ''}" onclick="window.flovaYouTube.setQuality('320')">
                    320 kbps (Ultra)
                  </button>
                  <button type="button" class="quality-pill ${this.selectedQuality === '192' ? 'active' : ''}" onclick="window.flovaYouTube.setQuality('192')">
                    192 kbps (Önerilen)
                  </button>
                  <button type="button" class="quality-pill ${this.selectedQuality === '128' ? 'active' : ''}" onclick="window.flovaYouTube.setQuality('128')">
                    128 kbps (Kompakt)
                  </button>
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

                      <!-- Send to 4/6-Stem Splitter -->
                      <button 
                        type="button" 
                        class="btn btn-secondary btn-playlist-action"
                        ${isItemDownloading || this.isBatchDownloading ? 'disabled' : ''}
                        onclick="window.flovaYouTube.sendPlaylistItemToStemSplitter(${idx})"
                        title="Demucs 4/6-Stem enstrüman ayırıcıya aktar"
                      >
                        🎸 Stem
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

                <!-- Audio Preview Player -->
                <div style="margin: 4px 0; display: flex; gap: 8px; align-items: center;">
                  <button type="button" class="btn btn-secondary btn-sm" onclick="window.flovaYouTube.togglePreview('${this.videoInfo.id}')" title="Ses önizlemesini dinle / durdur">
                    ${this.previewingItemId === this.videoInfo.id ? '⏹️ Önizlemeyi Durdur' : '▶️ Ses Önizle'}
                  </button>
                  ${this.previewingItemId === this.videoInfo.id ? `
                    <span style="font-size: 0.76rem; color: var(--accent-cyan); display: flex; align-items: center; gap: 6px;">
                      <span class="spinner-sm"></span> Önizleme çalınıyor...
                    </span>
                  ` : ''}
                </div>

                <!-- Quality Selection: Pure MP3 Audio -->
                <div class="youtube-format-switch-bar">
                  <div class="quality-selector-group">
                    <span class="quality-label">🎵 MP3 Ses Kalitesi:</span>
                    <button type="button" class="quality-pill ${this.selectedQuality === '320' ? 'active' : ''}" onclick="window.flovaYouTube.setQuality('320')">
                      320 kbps (Ultra)
                    </button>
                    <button type="button" class="quality-pill ${this.selectedQuality === '192' ? 'active' : ''}" onclick="window.flovaYouTube.setQuality('192')">
                      192 kbps (Önerilen)
                    </button>
                    <button type="button" class="quality-pill ${this.selectedQuality === '128' ? 'active' : ''}" onclick="window.flovaYouTube.setQuality('128')">
                      128 kbps (Kompakt)
                    </button>
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
                <!-- 1. Open in Studio Waveform Editor -->
                <button class="btn btn-primary yt-col-btn yt-col-btn-primary" ${this.isDownloading ? 'disabled' : ''} onclick="window.flovaYouTube.loadToEditor()" title="Doğrudan Flova Kesici/Düzenleyici dalga formunda açar">
                  ✂️ Düzenleyicide Aç
                </button>

                <!-- 2. Send to 4-Stem & 6-Stem AI Splitter -->
                <button class="btn btn-secondary yt-col-btn" ${this.isDownloading ? 'disabled' : ''} onclick="window.flovaYouTube.sendToStemSplitter()" title="Demucs v4 ile Davul, Bas, Gitar, Piyano, Vokal ayrıştırır">
                  🎸 Stem Ayrıştır (4/6-Stem)
                </button>

                <!-- 3. Send to AI Vocal Splitter -->
                <button class="btn btn-secondary yt-col-btn" ${this.isDownloading ? 'disabled' : ''} onclick="window.flovaYouTube.sendToVocalSplitter()" title="Şarkıyı AI Vokal / Enstrümantal ayırıcıya aktarır">
                  🎙️ Vokalleri Ayır
                </button>

                <!-- 4. Add to Merger Track -->
                <button class="btn btn-secondary yt-col-btn" ${this.isDownloading ? 'disabled' : ''} onclick="window.flovaYouTube.addToMerger()" title="Şarkı Birleştirici parçalarına yeni kanal olarak ekler">
                  🔗 Birleştiriciye Ekle
                </button>

                <!-- 5. Direct Download to PC -->
                <button id="ytDownloadBtn" class="btn btn-emerald yt-col-btn" ${this.isDownloading ? 'disabled' : ''} onclick="window.flovaYouTube.downloadDirect()" title="MP3 dosyasını doğrudan bilgisayara kaydet">
                  ${this.isDownloading ? `<span class="spinner-sm" style="margin-right: 6px;"></span> İndiriliyor...` : `📥 Bilgisayara İndir (MP3)`}
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
    this.selectedFormat = 'mp3';
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
      if (window.flovaApp) window.flovaApp.showToast('Lütfen geçerli bir YouTube linki veya arama terimi girin.', 'error');
      return;
    }

    // If input is not a URL or 11-char ID, route to direct YouTube search
    const isUrlOrId = url.includes('http://') || url.includes('https://') || url.includes('youtu.be') || url.includes('youtube.com') || /^[a-zA-Z0-9_-]{11}$/.test(url);
    if (!isUrlOrId) {
      return this.searchVideos(url);
    }

    this.currentUrl = url;
    this.searchResults = null;
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
        msg = 'Bağlantı zaman aşımına uğradı. YouTube sunucusu geç yanıt veriyor, lütfen tekrar deneyin.';
      } else if (msg.includes('not a bot') || msg.includes('Sign in') || msg.includes('cookies')) {
        msg = 'Bu şarkı YouTube tarafından kısıtlanmış. Lütfen başka bir şarkı deneyin veya ses dosyasını doğrudan stüdyoya sürükleyin.';
      } else if (msg.includes('Failed to fetch') || msg.includes('NetworkError')) {
        msg = 'Flova ses işleme sunucusuna ulaşılamadı. Lütfen internet bağlantınızı kontrol edin.';
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
        const downloadUrl = `${this.getApiBase()}/api/youtube/download?url=${encodeURIComponent(itemUrl)}&format=mp3&quality=${this.selectedQuality}`;
        
        const resp = await fetch(downloadUrl);
        if (!resp.ok) {
          console.warn(`Parça #${item.index} indirilemedi (${resp.status})`);
          continue;
        }

        const arrayBuffer = await resp.arrayBuffer();
        const cleanTitle = (item.title || `parca_${item.index}`).replace(/[\\/:*?"<>|]/g, '_').trim();
        const filename = `${String(item.index).padStart(2, '0')} - ${cleanTitle}.mp3`;
        
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
      a.download = `${cleanPlTitle}_Flova_MP3.zip`;
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
      const downloadUrl = `${this.getApiBase()}/api/youtube/download?url=${encodeURIComponent(itemUrl)}&format=mp3&quality=${this.selectedQuality}`;
      
      const resp = await fetch(downloadUrl);
      if (!resp.ok) {
        throw new Error(`Sunucu hatası (${resp.status})`);
      }

      const blob = await resp.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      const safeTitle = (item.title || 'flova_track').replace(/[\\/:*?"<>|]/g, '_');
      a.download = `${safeTitle}.mp3`;
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
   * Directly downloads single track as MP3
   */
  async downloadDirect() {
    if (!this.videoInfo) return;
    const urlInput = this.container.querySelector('#ytUrlInput');
    const ytUrl = urlInput ? urlInput.value.trim() : (this.currentUrl || '');
    if (!ytUrl) return;

    this.isDownloading = true;
    this.downloadProgressText = `YouTube'dan MP3 (${this.selectedQuality} kbps) indiriliyor ve dönüştürülüyor... Lütfen bekleyin.`;
    this.render();

    try {
      const downloadUrl = `${this.getApiBase()}/api/youtube/download?url=${encodeURIComponent(ytUrl)}&format=mp3&quality=${this.selectedQuality}`;
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
      a.download = `${safeTitle}.mp3`;
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

  async sendToStemSplitter() {
    if (!this.videoInfo) return;
    const audioBuffer = await this.fetchAudioBuffer();
    if (!audioBuffer) return;

    if (window.flovaStemSplitter) {
      window.flovaStemSplitter.loadBuffer(audioBuffer, `${this.videoInfo.title}.mp3`);
      if (window.flovaApp) {
        window.flovaApp.switchMode('stem-splitter');
        window.flovaApp.showToast(`"${this.videoInfo.title}" 4-Stem & 6-Stem enstrüman ayrıştırıcıya aktarıldı!`, 'success');
      }
    }
  }

  async sendPlaylistItemToStemSplitter(idx) {
    if (!this.videoInfo || !this.videoInfo.items || !this.videoInfo.items[idx]) return;
    const item = this.videoInfo.items[idx];
    const audioBuffer = await this.fetchItemAudioBuffer(item);
    if (!audioBuffer) return;

    if (window.flovaStemSplitter) {
      window.flovaStemSplitter.loadBuffer(audioBuffer, `${item.title}.mp3`);
      if (window.flovaApp) {
        window.flovaApp.switchMode('stem-splitter');
        window.flovaApp.showToast(`"${item.title}" 4-Stem & 6-Stem ayrıştırıcıya aktarıldı!`, 'success');
      }
    }
  }

  clearSearchResults() {
    this.searchResults = null;
    this.searchQuery = '';
    this.render();
  }

  async searchVideos(query) {
    query = (query || '').trim();
    if (!query) return;

    this.searchQuery = query;
    this.isLoading = true;
    this.loadingStage = `"${query}" YouTube'da aranıyor...`;
    this.videoInfo = null;
    this.render();

    this.activeAbortController = new AbortController();
    const timeoutId = setTimeout(() => {
      if (this.activeAbortController) {
        this.activeAbortController.abort('Zaman aşımı');
      }
    }, 25000);

    try {
      const endpoint = `${this.getApiBase()}/api/youtube/search?q=${encodeURIComponent(query)}&limit=9`;
      const resp = await fetch(endpoint, { signal: this.activeAbortController.signal });
      clearTimeout(timeoutId);
      this.activeAbortController = null;

      const data = await resp.json();
      if (!resp.ok || !data.success) {
        throw new Error(data.error || 'Arama yapılamadı.');
      }

      this.searchResults = data.items || [];
      this.isLoading = false;
      this.loadingStage = '';
      this.render();

      if (window.flovaApp) {
        window.flovaApp.showToast(`"${query}" için ${this.searchResults.length} sonuç bulundu!`, 'success');
      }
    } catch (err) {
      clearTimeout(timeoutId);
      this.activeAbortController = null;
      this.isLoading = false;
      this.loadingStage = '';
      this.render();
      if (window.flovaApp) {
        window.flovaApp.showToast(err.message || 'Arama başarısız oldu.', 'error');
      }
    }
  }

  selectSearchResult(idx) {
    if (!this.searchResults || !this.searchResults[idx]) return;
    const item = this.searchResults[idx];
    const url = item.url || `https://www.youtube.com/watch?v=${item.id}`;
    this.searchResults = null;
    this.currentUrl = url;
    const urlInput = this.container.querySelector('#ytUrlInput');
    if (urlInput) urlInput.value = url;
    this.fetchVideoInfo(url);
  }

  async loadSearchResultToEditor(idx) {
    if (!this.searchResults || !this.searchResults[idx]) return;
    const item = this.searchResults[idx];
    const audioBuffer = await this.fetchItemAudioBuffer(item);
    if (!audioBuffer) return;

    this.engine.currentFileName = `${item.title}.mp3`;
    this.engine.setBuffer(audioBuffer, true);

    if (window.flovaApp) {
      window.flovaApp.switchMode('editor');
      window.flovaApp.showToast(`"${item.title}" stüdyo düzenleyicide açıldı!`, 'success');
    }
  }

  async loadSearchResultToStemSplitter(idx) {
    if (!this.searchResults || !this.searchResults[idx]) return;
    const item = this.searchResults[idx];
    const audioBuffer = await this.fetchItemAudioBuffer(item);
    if (!audioBuffer) return;

    if (window.flovaStemSplitter) {
      window.flovaStemSplitter.loadBuffer(audioBuffer, `${item.title}.mp3`);
      if (window.flovaApp) {
        window.flovaApp.switchMode('stem-splitter');
        window.flovaApp.showToast(`"${item.title}" 4-Stem & 6-Stem ayrıştırıcıya aktarıldı!`, 'success');
      }
    }
  }

  async loadSearchResultToVocalSplitter(idx) {
    if (!this.searchResults || !this.searchResults[idx]) return;
    const item = this.searchResults[idx];
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

  async downloadSearchResultDirect(idx) {
    if (!this.searchResults || !this.searchResults[idx]) return;
    const item = this.searchResults[idx];
    this.activeDownloadingItemId = item.id;
    this.render();

    try {
      const itemUrl = item.url || `https://www.youtube.com/watch?v=${item.id}`;
      const downloadUrl = `${this.getApiBase()}/api/youtube/download?url=${encodeURIComponent(itemUrl)}&format=mp3&quality=320`;
      const resp = await fetch(downloadUrl);
      if (!resp.ok) {
        throw new Error(`İndirme başarısız (${resp.status})`);
      }
      const blob = await resp.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      const safeTitle = (item.title || 'flova_track').replace(/[\\/:*?"<>|]/g, '_');
      a.download = `${safeTitle}.mp3`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(a.href), 15000);

      this.activeDownloadingItemId = null;
      this.render();
      if (window.flovaApp) window.flovaApp.showToast(`"${item.title}" başarıyla indirildi!`, 'success');
    } catch (err) {
      this.activeDownloadingItemId = null;
      this.render();
      if (window.flovaApp) window.flovaApp.showToast(`İndirme hatası: ${err.message || err}`, 'error');
    }
  }

  togglePreview(id, customUrl = null) {
    if (this.previewingItemId === id) {
      this.stopPreview();
      return;
    }
    this.stopPreview();

    const targetUrl = customUrl || (this.videoInfo && this.videoInfo.id === id ? (this.videoInfo.url || `https://www.youtube.com/watch?v=${id}`) : `https://www.youtube.com/watch?v=${id}`);
    const audioUrl = `${this.getApiBase()}/api/youtube/download?url=${encodeURIComponent(targetUrl)}&format=mp3&quality=128`;

    this.activePreviewAudio = new Audio(audioUrl);
    this.previewingItemId = id;
    this.render();

    this.activePreviewAudio.play().catch(err => {
      console.warn('Preview playback error:', err);
      this.stopPreview();
    });

    this.activePreviewAudio.onended = () => {
      this.stopPreview();
    };
  }

  stopPreview() {
    if (this.activePreviewAudio) {
      try {
        this.activePreviewAudio.pause();
        this.activePreviewAudio.src = '';
      } catch (e) {}
      this.activePreviewAudio = null;
    }
    this.previewingItemId = null;
    this.render();
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

  async fetchAudioBuffer(customUrl = null) {
    let targetUrl = customUrl;
    if (!targetUrl) {
      if (this.videoInfo) {
        targetUrl = this.videoInfo.url || (this.videoInfo.id ? `https://www.youtube.com/watch?v=${this.videoInfo.id}` : null);
      }
      if (!targetUrl) {
        const urlInput = this.container.querySelector('#ytUrlInput');
        targetUrl = urlInput ? urlInput.value.trim() : (this.currentUrl || '');
      }
    }
    if (!targetUrl) return null;

    this.isDownloading = true;
    this.downloadProgressText = 'Ses YouTube sunucularından indiriliyor ve stüdyo için işleniyor...';
    this.render();

    try {
      const downloadUrl = `${this.getApiBase()}/api/youtube/download?url=${encodeURIComponent(targetUrl)}&format=mp3&quality=320`;
      const resp = await fetch(downloadUrl);
      if (!resp.ok) {
        const errData = await resp.json().catch(() => null);
        throw new Error((errData && errData.error) || `İndirme başarısız (${resp.status})`);
      }

      this.downloadProgressText = 'Ses verisi stüdyo dalga formuna çözülüyor (Decoding)...';
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
      let errText = err.message || String(err);
      if (errText.includes('not a bot') || errText.includes('Sign in') || errText.includes('cookies')) {
        errText = 'Bu parça YouTube erişim kısıtlamasına sahip. Lütfen başka bir şarkı deneyin veya ses dosyasını sürükleyin.';
      }
      if (window.flovaApp) {
        window.flovaApp.showToast(`Stüdyoya aktarma hatası: ${errText}`, 'error');
      }
      return null;
    }
  }

  async fetchCookieStatus() {
    try {
      const res = await fetch(`${this.getApiBase()}/api/youtube/cookies/status`);
      if (res.ok) {
        this.cookieStatus = await res.json();
        const cookieBtn = this.container.querySelector('.yt-cookie-btn');
        if (cookieBtn) {
          const has = this.cookieStatus && this.cookieStatus.has_cookies;
          cookieBtn.innerHTML = `🍪 ${has ? 'Çerez Aktif' : 'Bulut Çerezi (Gerekli)'}`;
          cookieBtn.style.color = has ? '#10b981' : '#f59e0b';
          cookieBtn.style.borderColor = has ? 'rgba(16,185,129,0.45)' : 'rgba(245,158,11,0.45)';
          cookieBtn.style.background = has ? 'rgba(16,185,129,0.1)' : 'rgba(245,158,11,0.1)';
        }
      }
    } catch (_) {}
  }

  openCookieModal() {
    let modalContainer = document.getElementById('youtubeCookiesModalContainer');
    if (!modalContainer) {
      modalContainer = document.createElement('div');
      modalContainer.id = 'youtubeCookiesModalContainer';
      document.body.appendChild(modalContainer);
    }
    this.isCookieModalOpen = true;
    modalContainer.className = 'modal-backdrop active';
    modalContainer.style.display = 'flex';
    this.renderCookieModalContent(modalContainer);
  }

  closeCookieModal() {
    const modalContainer = document.getElementById('youtubeCookiesModalContainer');
    if (!modalContainer) return;
    this.isCookieModalOpen = false;
    modalContainer.className = 'modal-backdrop';
    modalContainer.style.display = 'none';
  }

  renderCookieModalContent(container) {
    const hasCookies = this.cookieStatus && this.cookieStatus.has_cookies;
    const cookieSizeKb = this.cookieStatus && this.cookieStatus.size ? Math.round(this.cookieStatus.size / 1024) : 0;

    container.innerHTML = `
      <div class="modal-card glass-card server-modal-card" style="max-width: 580px;">
        <div class="modal-header">
          <div class="modal-title-row">
            <span class="modal-icon">🍪</span>
            <div>
              <h3 class="modal-title">YouTube Bot Koruması & Bulut Çerezleri</h3>
              <p class="modal-subtitle">Hugging Face & Bulut Sunucularda YouTube İndirmelerini Aktif Edin</p>
            </div>
          </div>
          <button class="modal-close-btn" id="closeCookieModalBtn" title="Kapat">✕</button>
        </div>

        <div class="modal-body" style="display: flex; flex-direction: column; gap: 14px;">
          
          <!-- Status Banner -->
          <div class="server-status-banner ${hasCookies ? 'status-ok' : 'status-err'}">
            <div class="status-indicator-circle ${hasCookies ? 'pulse-green' : 'pulse-red'}"></div>
            <div style="flex: 1;">
              <div style="font-weight: 700; font-size: 0.95rem; color: #fff;">
                ${hasCookies ? `🟢 Aktif YouTube Çerezi Yüklü (${cookieSizeKb} KB)` : '⚠️ Bulut Sunucusunda Çerez Bulunmuyor'}
              </div>
              <div style="font-size: 0.82rem; color: #94a3b8; margin-top: 2px;">
                ${hasCookies 
                  ? 'Sunucunuz YouTube isteklerini bu çerezle yetkilendirmektedir. İndirme ve aktarma işlemleri hazırdır.' 
                  : 'Hugging Face / AWS gibi bulut sunucuları YouTube bot kontrolüne takılır. Aşağıdan cookies.txt yükleyerek engeli kaldırabilirsiniz.'}
              </div>
            </div>
            ${hasCookies ? `
              <button id="deleteCookiesBtn" class="btn btn-secondary btn-sm" style="color: #f87171; border-color: rgba(239,68,68,0.35);">
                🗑️ Çerezi Sil
              </button>
            ` : ''}
          </div>

          <!-- Explanation Box -->
          <div class="server-info-box">
            <div style="font-weight: 600; color: #c7d2fe; margin-bottom: 4px; font-size: 0.85rem;">
              💡 2 Kolay Çözüm Yolu:
            </div>
            <ul style="font-size: 0.82rem; color: #94a3b8; margin: 0; padding-left: 18px; line-height: 1.6;">
              <li><strong>Yöntem 1 (Önerilen - Çerez Yükleme):</strong> Chrome/Edge mağazasından ücretsiz <em>"Get cookies.txt LOCALLY"</em> eklentisini kurun. YouTube.com sekmesindeyken dışa aktardığınız <code>cookies.txt</code> dosyasını aşağıdaki kutuya bırakın.</li>
              <li><strong>Yöntem 2 (Sıfır Çerez - Kendi PC'niz):</strong> Proje klasöründeki <code>start-cloud-tunnel.bat</code> dosyasını açın. Ev internetinizin IP'si YouTube tarafından asla engellenmez! Aldığınız linki AI Ayarları'na yapıştırın.</li>
            </ul>
          </div>

          <!-- Drag & Drop File Zone -->
          <div id="cookieDropZone" style="border: 2px dashed rgba(255, 107, 0, 0.45); border-radius: 12px; padding: 22px; text-align: center; background: rgba(255, 107, 0, 0.04); cursor: pointer; transition: all 0.2s ease;">
            <input type="file" id="cookieFileInput" accept=".txt" style="display: none;" />
            <div style="font-size: 1.8rem; margin-bottom: 6px;">📂</div>
            <div style="font-weight: 600; font-size: 0.9rem; color: #f8fafc;">
              cookies.txt dosyasını buraya sürükleyin veya tıklayarak seçin
            </div>
            <div style="font-size: 0.78rem; color: #94a3b8; margin-top: 4px;">
              Netscape HTTP Cookie formatı (.txt)
            </div>
          </div>

          <!-- Paste Raw Cookies Textarea -->
          <div class="form-group" style="margin-top: 4px;">
            <label style="font-size: 0.82rem; font-weight: 600; color: #cbd5e1; margin-bottom: 4px; display: block;">
              Veya Çerez Metnini Doğrudan Buraya Yapıştırın:
            </label>
            <textarea 
              id="rawCookiesTextarea" 
              class="studio-input" 
              rows="3" 
              placeholder="# Netscape HTTP Cookie File&#10;.youtube.com  TRUE  /  TRUE  ... "
              style="width: 100%; font-family: monospace; font-size: 0.75rem; resize: vertical;"
            ></textarea>
          </div>

          <!-- Action Row -->
          <div style="display: flex; justify-content: flex-end; gap: 10px; margin-top: 6px;">
            <button id="closeCookieModalActionBtn" class="btn btn-secondary btn-sm">Kapat</button>
            <button id="saveCookiesTextBtn" class="btn btn-primary btn-sm" style="padding: 7px 18px; font-weight: 700;">
              💾 Çerezi Sunucuya Kaydet
            </button>
          </div>

        </div>
      </div>
    `;

    // Hook listeners
    const closeBtn = container.querySelector('#closeCookieModalBtn');
    const closeActionBtn = container.querySelector('#closeCookieModalActionBtn');
    const dropZone = container.querySelector('#cookieDropZone');
    const fileInput = container.querySelector('#cookieFileInput');
    const saveTextBtn = container.querySelector('#saveCookiesTextBtn');
    const deleteBtn = container.querySelector('#deleteCookiesBtn');
    const textarea = container.querySelector('#rawCookiesTextarea');

    if (closeBtn) closeBtn.onclick = () => this.closeCookieModal();
    if (closeActionBtn) closeActionBtn.onclick = () => this.closeCookieModal();
    container.onclick = (e) => {
      if (e.target === container) this.closeCookieModal();
    };

    if (dropZone && fileInput) {
      dropZone.onclick = () => fileInput.click();
      dropZone.ondragover = (e) => {
        e.preventDefault();
        dropZone.style.borderColor = 'var(--accent-orange)';
        dropZone.style.background = 'rgba(255, 107, 0, 0.12)';
      };
      dropZone.ondragleave = () => {
        dropZone.style.borderColor = 'rgba(255, 107, 0, 0.45)';
        dropZone.style.background = 'rgba(255, 107, 0, 0.04)';
      };
      dropZone.ondrop = (e) => {
        e.preventDefault();
        dropZone.style.borderColor = 'rgba(255, 107, 0, 0.45)';
        dropZone.style.background = 'rgba(255, 107, 0, 0.04)';
        if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) {
          this.handleCookieFileUpload(e.dataTransfer.files[0]);
        }
      };
      fileInput.onchange = (e) => {
        if (e.target.files && e.target.files[0]) {
          this.handleCookieFileUpload(e.target.files[0]);
        }
      };
    }

    if (saveTextBtn && textarea) {
      saveTextBtn.onclick = () => {
        const val = textarea.value.trim();
        if (!val) {
          if (window.flovaApp) window.flovaApp.showToast('Lütfen çerez metnini yapıştırın.', 'error');
          return;
        }
        this.submitCookiesToBackend(val);
      };
    }

    if (deleteBtn) {
      deleteBtn.onclick = async () => {
        try {
          const res = await fetch(`${this.getApiBase()}/api/youtube/cookies/delete`);
          const d = await res.json();
          if (window.flovaApp) window.flovaApp.showToast(d.message || 'Çerezler silindi.', 'info');
          await this.fetchCookieStatus();
          this.renderCookieModalContent(container);
        } catch (ex) {
          if (window.flovaApp) window.flovaApp.showToast(`Silme hatası: ${ex.message}`, 'error');
        }
      };
    }
  }

  async handleCookieFileUpload(file) {
    try {
      const text = await file.text();
      await this.submitCookiesToBackend(text);
    } catch (ex) {
      if (window.flovaApp) window.flovaApp.showToast(`Dosya okuma hatası: ${ex.message}`, 'error');
    }
  }

  async submitCookiesToBackend(cookieText) {
    if (!cookieText || cookieText.length < 20) {
      if (window.flovaApp) window.flovaApp.showToast('Geçersiz çerez formatı.', 'error');
      return;
    }
    if (window.flovaApp) window.flovaApp.showToast('Çerezler bulut sunucusuna yükleniyor...', 'info');
    try {
      const res = await fetch(`${this.getApiBase()}/api/youtube/cookies`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        body: cookieText
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Çerez kaydedilemedi.');
      }
      if (window.flovaApp) window.flovaApp.showToast(data.message || 'YouTube çerezleri aktif edildi!', 'success');
      await this.fetchCookieStatus();
      const modalContainer = document.getElementById('youtubeCookiesModalContainer');
      if (modalContainer && this.isCookieModalOpen) {
        this.renderCookieModalContent(modalContainer);
      }
    } catch (ex) {
      if (window.flovaApp) window.flovaApp.showToast(`Çerez yükleme hatası: ${ex.message}`, 'error');
    }
  }
}
