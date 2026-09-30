/**
 * Flova Studio - Audiogram & Waveform Video Maker
 * Renders animated waveform videos for Instagram Reels, TikTok, YouTube Shorts, and Feed.
 */

export class AudiogramModal {
  constructor(audioEngine, showToast) {
    this.engine = audioEngine;
    this.showToast = showToast || console.log;
    this.modalEl = null;
    this.canvas = null;
    this.ctx = null;
    this.animFrameId = null;
    this.isRendering = false;
    this.mediaRecorder = null;
    this.recordedChunks = [];
    this.bgImage = null;

    this.settings = {
      format: '9:16', // '9:16', '1:1', '16:9'
      theme: 'cyberpunk', // 'cyberpunk', 'sunset', 'midnight', 'custom'
      vizType: 'bars', // 'bars', 'wave', 'circle'
      title: 'Flova Studio Pro',
      artist: 'Flova Artist',
      barColor: '#00f2fe',
      barGlow: '#4facfe',
      fps: 30
    };

    this._createDOM();
  }

  _createDOM() {
    let container = document.getElementById('audiogramModalContainer');
    if (!container) {
      container = document.createElement('div');
      container.id = 'audiogramModalContainer';
      document.body.appendChild(container);
    }

    container.innerHTML = `
      <div id="audiogramModalBackdrop" class="modal-backdrop" style="display: none; position: fixed; inset: 0; background: rgba(0, 4, 15, 0.88); backdrop-filter: blur(12px); z-index: 10000; justify-content: center; align-items: center; padding: 20px;">
        <div class="glass-card audiogram-dialog" style="width: 100%; max-width: 900px; max-height: 92vh; display: flex; flex-direction: column; overflow: hidden; border: 1px solid rgba(0, 242, 254, 0.25); box-shadow: 0 20px 60px rgba(0, 0, 0, 0.7);">
          
          <!-- Header -->
          <div style="display: flex; align-items: center; justify-content: space-between; padding: 18px 24px; border-bottom: 1px solid rgba(255, 255, 255, 0.08);">
            <div style="display: flex; align-items: center; gap: 10px;">
              <span style="font-size: 1.4rem;">📹</span>
              <div>
                <h3 style="margin: 0; font-size: 1.15rem; font-weight: 700; color: #fff;">Sosyal Medya Audiogram Video Oluşturucu</h3>
                <p style="margin: 2px 0 0 0; font-size: 0.78rem; color: var(--text-muted, #94a3b8);">Instagram Reels, TikTok ve YouTube Shorts için animasyonlu dalga formu videosu render edin</p>
              </div>
            </div>
            <button id="closeAudiogramModal" class="btn btn-secondary btn-sm" style="border-radius: 50%; width: 32px; height: 32px; padding: 0; display: flex; align-items: center; justify-content: center;">✕</button>
          </div>

          <!-- Body -->
          <div style="display: flex; flex: 1; overflow-y: auto; padding: 20px; gap: 24px;">
            
            <!-- Preview Column -->
            <div style="flex: 1.1; display: flex; flex-direction: column; align-items: center; justify-content: center; background: rgba(0, 0, 0, 0.4); border-radius: 12px; padding: 16px; border: 1px dashed rgba(255, 255, 255, 0.1);">
              <div id="audiogramPreviewWrapper" style="position: relative; max-width: 100%; display: flex; align-items: center; justify-content: center; box-shadow: 0 10px 30px rgba(0,0,0,0.5); border-radius: 10px; overflow: hidden;">
                <canvas id="audiogramCanvas" style="max-height: 480px; width: auto; object-fit: contain; border-radius: 8px;"></canvas>
              </div>
              <div style="margin-top: 14px; display: flex; gap: 12px; align-items: center;">
                <button id="audiogramPlayPreviewBtn" class="btn btn-secondary btn-sm">▶️ Önizleme Oynat</button>
                <span id="audiogramRenderProgress" style="font-size: 0.8rem; color: #00f2fe; font-weight: 600; display: none;">Render ediliyor...</span>
              </div>
            </div>

            <!-- Controls Column -->
            <div style="flex: 1; display: flex; flex-direction: column; gap: 16px;">
              
              <!-- Video Format -->
              <div>
                <label style="font-size: 0.8rem; font-weight: 700; color: #94a3b8; text-transform: uppercase; margin-bottom: 6px; display: block;">Video Formatı</label>
                <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px;">
                  <button class="ag-format-btn active" data-fmt="9:16" style="padding: 8px 6px; font-size: 0.82rem; border-radius: 6px; border: 1px solid #00f2fe; background: rgba(0, 242, 254, 0.15); color: #fff; cursor: pointer; text-align: center;">
                    📱 9:16<br><span style="font-size: 0.7rem; opacity: 0.7;">Reels/TikTok</span>
                  </button>
                  <button class="ag-format-btn" data-fmt="1:1" style="padding: 8px 6px; font-size: 0.82rem; border-radius: 6px; border: 1px solid rgba(255,255,255,0.1); background: rgba(255,255,255,0.04); color: #ccc; cursor: pointer; text-align: center;">
                    🔲 1:1<br><span style="font-size: 0.7rem; opacity: 0.7;">Post / Kare</span>
                  </button>
                  <button class="ag-format-btn" data-fmt="16:9" style="padding: 8px 6px; font-size: 0.82rem; border-radius: 6px; border: 1px solid rgba(255,255,255,0.1); background: rgba(255,255,255,0.04); color: #ccc; cursor: pointer; text-align: center;">
                    💻 16:9<br><span style="font-size: 0.7rem; opacity: 0.7;">YouTube</span>
                  </button>
                </div>
              </div>

              <!-- Theme & Background -->
              <div>
                <label style="font-size: 0.8rem; font-weight: 700; color: #94a3b8; text-transform: uppercase; margin-bottom: 6px; display: block;">Görsel Tema</label>
                <div style="display: flex; gap: 8px; flex-wrap: wrap;">
                  <button class="ag-theme-btn active" data-theme="cyberpunk" style="padding: 6px 12px; font-size: 0.8rem; border-radius: 6px; border: 1px solid #00f2fe; background: rgba(0, 242, 254, 0.2); color: #fff; cursor: pointer;">⚡ Cyberpunk</button>
                  <button class="ag-theme-btn" data-theme="sunset" style="padding: 6px 12px; font-size: 0.8rem; border-radius: 6px; border: 1px solid rgba(255,255,255,0.1); background: rgba(255,255,255,0.04); color: #ccc; cursor: pointer;">🌅 Sunset</button>
                  <button class="ag-theme-btn" data-theme="midnight" style="padding: 6px 12px; font-size: 0.8rem; border-radius: 6px; border: 1px solid rgba(255,255,255,0.1); background: rgba(255,255,255,0.04); color: #ccc; cursor: pointer;">🌌 Midnight</button>
                  <label class="btn btn-secondary btn-sm" style="padding: 6px 12px; font-size: 0.8rem; cursor: pointer; display: inline-flex; align-items: center; gap: 4px;">
                    🖼️ Resim Seç
                    <input type="file" id="agCustomBgFile" accept="image/*" style="display: none;" />
                  </label>
                </div>
              </div>

              <!-- Visualizer Style -->
              <div>
                <label style="font-size: 0.8rem; font-weight: 700; color: #94a3b8; text-transform: uppercase; margin-bottom: 6px; display: block;">Dalga Formu Tarzı</label>
                <div style="display: flex; gap: 8px;">
                  <button class="ag-viz-btn active" data-viz="bars" style="flex: 1; padding: 6px 10px; font-size: 0.8rem; border-radius: 6px; border: 1px solid #00f2fe; background: rgba(0, 242, 254, 0.2); color: #fff; cursor: pointer;">📊 Spektrum Çubukları</button>
                  <button class="ag-viz-btn" data-viz="wave" style="flex: 1; padding: 6px 10px; font-size: 0.8rem; border-radius: 6px; border: 1px solid rgba(255,255,255,0.1); background: rgba(255,255,255,0.04); color: #ccc; cursor: pointer;">〰️ Neon Dalga</button>
                  <button class="ag-viz-btn" data-viz="circle" style="flex: 1; padding: 6px 10px; font-size: 0.8rem; border-radius: 6px; border: 1px solid rgba(255,255,255,0.1); background: rgba(255,255,255,0.04); color: #ccc; cursor: pointer;">⭕ Dairesel Orbit</button>
                </div>
              </div>

              <!-- Track Title & Artist -->
              <div style="display: flex; gap: 10px;">
                <div style="flex: 1;">
                  <label style="font-size: 0.75rem; color: #94a3b8;">Parça Başlığı</label>
                  <input type="text" id="agTrackTitle" class="form-input" value="Flova Track" style="width: 100%; padding: 8px 10px; font-size: 0.85rem; border-radius: 6px; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.15); color: #fff; margin-top: 4px;" />
                </div>
                <div style="flex: 1;">
                  <label style="font-size: 0.75rem; color: #94a3b8;">Sanatçı / İsim</label>
                  <input type="text" id="agTrackArtist" class="form-input" value="Flova Studio Pro" style="width: 100%; padding: 8px 10px; font-size: 0.85rem; border-radius: 6px; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.15); color: #fff; margin-top: 4px;" />
                </div>
              </div>

            </div>
          </div>

          <!-- Footer Actions -->
          <div style="padding: 16px 24px; border-top: 1px solid rgba(255, 255, 255, 0.08); display: flex; justify-content: space-between; align-items: center; background: rgba(0, 0, 0, 0.3);">
            <div style="font-size: 0.8rem; color: var(--text-muted, #94a3b8);">
              💡 Tarayıcı içinde GPU hızlandırmasıyla anında render edilir
            </div>
            <div style="display: flex; gap: 10px;">
              <button id="cancelAudiogramBtn" class="btn btn-secondary">Kapat</button>
              <button id="exportAudiogramVideoBtn" class="btn btn-emerald" style="padding: 10px 24px; font-weight: 700; display: flex; align-items: center; gap: 8px;">
                <span>🎬 Videoyu Oluştur & İndir</span>
              </button>
            </div>
          </div>

        </div>
      </div>
    `;

    this.modalEl = document.getElementById('audiogramModalBackdrop');
    this.canvas = document.getElementById('audiogramCanvas');
    this.ctx = this.canvas.getContext('2d');

    this._bindEvents();
  }

  _bindEvents() {
    const backdrop = document.getElementById('audiogramModalBackdrop');
    document.getElementById('closeAudiogramModal')?.addEventListener('click', () => this.close());
    document.getElementById('cancelAudiogramBtn')?.addEventListener('click', () => this.close());

    // Format selection
    const fmtBtns = backdrop.querySelectorAll('.ag-format-btn');
    fmtBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        fmtBtns.forEach(b => {
          b.style.border = '1px solid rgba(255,255,255,0.1)';
          b.style.background = 'rgba(255,255,255,0.04)';
          b.style.color = '#ccc';
        });
        btn.style.border = '1px solid #00f2fe';
        btn.style.background = 'rgba(0, 242, 254, 0.15)';
        btn.style.color = '#fff';
        this.settings.format = btn.dataset.fmt;
        this._updateCanvasResolution();
        this._drawStaticFrame();
      });
    });

    // Theme selection
    const themeBtns = backdrop.querySelectorAll('.ag-theme-btn');
    themeBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        themeBtns.forEach(b => {
          b.style.border = '1px solid rgba(255,255,255,0.1)';
          b.style.background = 'rgba(255,255,255,0.04)';
          b.style.color = '#ccc';
        });
        btn.style.border = '1px solid #00f2fe';
        btn.style.background = 'rgba(0, 242, 254, 0.2)';
        btn.style.color = '#fff';
        this.settings.theme = btn.dataset.theme;
        this.bgImage = null;
        this._drawStaticFrame();
      });
    });

    // Viz style selection
    const vizBtns = backdrop.querySelectorAll('.ag-viz-btn');
    vizBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        vizBtns.forEach(b => {
          b.style.border = '1px solid rgba(255,255,255,0.1)';
          b.style.background = 'rgba(255,255,255,0.04)';
          b.style.color = '#ccc';
        });
        btn.style.border = '1px solid #00f2fe';
        btn.style.background = 'rgba(0, 242, 254, 0.2)';
        btn.style.color = '#fff';
        this.settings.vizType = btn.dataset.viz;
        this._drawStaticFrame();
      });
    });

    // Custom background file
    document.getElementById('agCustomBgFile')?.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (file) {
        const reader = new FileReader();
        reader.onload = (event) => {
          const img = new Image();
          img.onload = () => {
            this.bgImage = img;
            this.settings.theme = 'custom';
            this._drawStaticFrame();
          };
          img.src = event.target.result;
        };
        reader.readAsDataURL(file);
      }
    });

    // Title / Artist inputs
    document.getElementById('agTrackTitle')?.addEventListener('input', (e) => {
      this.settings.title = e.target.value;
      this._drawStaticFrame();
    });
    document.getElementById('agTrackArtist')?.addEventListener('input', (e) => {
      this.settings.artist = e.target.value;
      this._drawStaticFrame();
    });

    // Preview play
    document.getElementById('audiogramPlayPreviewBtn')?.addEventListener('click', () => {
      if (this.engine.isPlaying) {
        this.engine.pause();
        document.getElementById('audiogramPlayPreviewBtn').textContent = '▶️ Önizleme Oynat';
      } else {
        this.engine.play();
        document.getElementById('audiogramPlayPreviewBtn').textContent = '⏸️ Duraklat';
      }
    });

    // Export Video
    document.getElementById('exportAudiogramVideoBtn')?.addEventListener('click', () => {
      this.renderAndDownloadVideo();
    });

    // Close on backdrop click
    this.modalEl?.addEventListener('click', (e) => {
      if (e.target === this.modalEl) this.close();
    });
  }

  open(trackName = 'Flova Song') {
    this.settings.title = trackName || 'Flova Studio Pro';
    const titleInput = document.getElementById('agTrackTitle');
    if (titleInput) titleInput.value = this.settings.title;

    this._updateCanvasResolution();
    this.modalEl.style.display = 'flex';
    this.modalEl.classList.add('active');
    this._startLiveAnimation();

    const buffer = this.engine.currentBuffer || this.engine.audioBuffer;
    if (!buffer) {
      this.showToast('İpucu: Henüz bir parça yüklemediniz. Video önizlemesini deneyebilir veya Demo yükleyebilirsiniz.', 'info');
    }
  }

  close() {
    this.modalEl.classList.remove('active');
    this.modalEl.style.display = 'none';
    if (this.animFrameId) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
    if (this.engine.isPlaying) {
      this.engine.pause();
    }
  }

  _updateCanvasResolution() {
    let w = 720, h = 1280; // 9:16
    if (this.settings.format === '1:1') {
      w = 800; h = 800;
    } else if (this.settings.format === '16:9') {
      w = 1280; h = 720;
    }
    this.canvas.width = w;
    this.canvas.height = h;
  }

  _startLiveAnimation() {
    const render = () => {
      if (this.modalEl.style.display === 'none') return;
      this._drawFrame();
      this.animFrameId = requestAnimationFrame(render);
    };
    render();
  }

  _drawStaticFrame() {
    this._drawFrame();
  }

  _drawFrame() {
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;

    // 1. Draw Background
    if (this.bgImage && this.settings.theme === 'custom') {
      ctx.drawImage(this.bgImage, 0, 0, w, h);
      ctx.fillStyle = 'rgba(0, 4, 15, 0.45)';
      ctx.fillRect(0, 0, w, h);
    } else {
      const grad = ctx.createLinearGradient(0, 0, w, h);
      if (this.settings.theme === 'sunset') {
        grad.addColorStop(0, '#2e0854');
        grad.addColorStop(0.5, '#7b113a');
        grad.addColorStop(1, '#ff6e40');
      } else if (this.settings.theme === 'midnight') {
        grad.addColorStop(0, '#040d21');
        grad.addColorStop(0.5, '#091b3e');
        grad.addColorStop(1, '#1b3b6f');
      } else { // Cyberpunk
        grad.addColorStop(0, '#020024');
        grad.addColorStop(0.5, '#090979');
        grad.addColorStop(1, '#00d4ff');
      }
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);
    }

    // 2. Frequency data
    let freqData = new Uint8Array(64);
    if (this.engine.analyserNode && this.engine.isPlaying) {
      this.engine.analyserNode.getByteFrequencyData(freqData);
    } else {
      // Gentle resting waveform simulation when stopped
      const t = Date.now() / 300;
      for (let i = 0; i < 64; i++) {
        freqData[i] = Math.floor(40 + 35 * Math.sin(t + i * 0.2));
      }
    }

    // 3. Draw Track Title and Artist
    ctx.save();
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = 'rgba(0, 0, 0, 0.7)';
    ctx.shadowBlur = 10;

    const titleY = this.settings.format === '9:16' ? h * 0.32 : h * 0.28;
    ctx.font = `bold ${Math.round(w * 0.052)}px 'Plus Jakarta Sans', sans-serif`;
    ctx.fillText(this.settings.title, w / 2, titleY);

    ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
    ctx.font = `${Math.round(w * 0.034)}px 'Plus Jakarta Sans', sans-serif`;
    ctx.fillText(this.settings.artist, w / 2, titleY + Math.round(w * 0.055));
    ctx.restore();

    // 4. Draw Visualizer
    const centerY = this.settings.format === '9:16' ? h * 0.58 : h * 0.55;

    if (this.settings.vizType === 'bars') {
      const numBars = 48;
      const barWidth = Math.floor((w * 0.8) / numBars);
      const startX = (w - (numBars * barWidth)) / 2;

      for (let i = 0; i < numBars; i++) {
        const val = (freqData[i] || 0) / 255;
        const barHeight = Math.max(8, val * (h * 0.28));
        const x = startX + i * barWidth;
        const y = centerY - barHeight / 2;

        const barGrad = ctx.createLinearGradient(0, y, 0, y + barHeight);
        barGrad.addColorStop(0, '#00f2fe');
        barGrad.addColorStop(1, '#4facfe');

        ctx.fillStyle = barGrad;
        ctx.shadowColor = '#00f2fe';
        ctx.shadowBlur = 12;
        ctx.beginPath();
        ctx.roundRect(x + 2, y, barWidth - 4, barHeight, 4);
        ctx.fill();
      }
    } else if (this.settings.vizType === 'wave') {
      ctx.beginPath();
      ctx.strokeStyle = '#00f2fe';
      ctx.lineWidth = 5;
      ctx.shadowColor = '#00f2fe';
      ctx.shadowBlur = 16;

      const numPoints = 64;
      const step = (w * 0.85) / numPoints;
      const startX = (w - (numPoints * step)) / 2;

      for (let i = 0; i < numPoints; i++) {
        const val = ((freqData[i] || 0) / 255 - 0.5) * (h * 0.35);
        const x = startX + i * step;
        const y = centerY + val;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    } else { // Circle Orbit
      const radius = Math.min(w, h) * 0.18;
      ctx.save();
      ctx.translate(w / 2, centerY);

      const numBars = 48;
      for (let i = 0; i < numBars; i++) {
        const angle = (i / numBars) * Math.PI * 2;
        const val = (freqData[i] || 0) / 255;
        const length = val * (radius * 0.7) + 6;

        const x1 = Math.cos(angle) * radius;
        const y1 = Math.sin(angle) * radius;
        const x2 = Math.cos(angle) * (radius + length);
        const y2 = Math.sin(angle) * (radius + length);

        ctx.strokeStyle = '#00f2fe';
        ctx.shadowColor = '#00f2fe';
        ctx.shadowBlur = 10;
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      }
      ctx.restore();
    }

    // 5. Flova Watermark Badge
    ctx.save();
    ctx.font = `600 ${Math.round(w * 0.024)}px 'Plus Jakarta Sans', sans-serif`;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
    ctx.textAlign = 'center';
    ctx.fillText('⚡ FLOVA STUDIO PRO', w / 2, h - 35);
    ctx.restore();
  }

  async renderAndDownloadVideo() {
    const buffer = this.engine.currentBuffer || this.engine.audioBuffer;
    if (!buffer) {
      this.showToast('Video oluşturmak için lütfen önce bir ses dosyası yükleyin.', 'warning');
      document.getElementById('openFileBtn')?.click();
      return;
    }

    const progressEl = document.getElementById('audiogramRenderProgress');
    const exportBtn = document.getElementById('exportAudiogramVideoBtn');
    
    if (progressEl) {
      progressEl.style.display = 'inline-block';
      progressEl.textContent = 'Render başlatılıyor...';
    }
    if (exportBtn) exportBtn.disabled = true;

    try {
      // 1. Prepare video stream from canvas
      const canvasStream = this.canvas.captureStream(30);

      // 2. Prepare audio destination stream
      const audioStreamDestination = this.engine.ctx.createMediaStreamDestination();
      // Connect master analyser to destination stream
      if (this.engine.analyser) {
        this.engine.analyser.connect(audioStreamDestination);
      }

      // Combine video track + audio track
      const combinedStream = new MediaStream([
        ...canvasStream.getVideoTracks(),
        ...audioStreamDestination.stream.getAudioTracks()
      ]);

      // 3. Setup MediaRecorder
      const mimeType = MediaRecorder.isTypeSupported('video/mp4;codecs=avc1') 
        ? 'video/mp4' 
        : (MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm');

      this.mediaRecorder = new MediaRecorder(combinedStream, {
        mimeType,
        videoBitsPerSecond: 4000000 // 4 Mbps
      });

      this.recordedChunks = [];
      this.mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          this.recordedChunks.push(e.data);
        }
      };

      this.mediaRecorder.onstop = () => {
        const ext = mimeType.includes('mp4') ? 'mp4' : 'webm';
        const blob = new Blob(this.recordedChunks, { type: mimeType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${this.settings.title.replace(/[^a-zA-Z0-9_\-]/g, '_')}_audiogram.${ext}`;
        a.click();
        URL.revokeObjectURL(url);

        this.engine.pause();
        if (progressEl) progressEl.style.display = 'none';
        if (exportBtn) exportBtn.disabled = false;
        this.showToast('🎉 Video başarıyla oluşturuldu ve indirildi!', 'success');
      };

      // 4. Start recording and playback
      this.mediaRecorder.start(200);
      this.engine.seek(0);
      this.engine.play();

      // Monitor playback until end
      const checkEnd = setInterval(() => {
        const current = this.engine.currentTime;
        const total = this.engine.duration;
        if (progressEl) {
          progressEl.textContent = `Render ediliyor: %${Math.round((current / (total || 1)) * 100)}`;
        }

        if (current >= total || !this.engine.isPlaying) {
          clearInterval(checkEnd);
          if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
            this.mediaRecorder.stop();
          }
        }
      }, 500);

    } catch (err) {
      console.error('[Audiogram] Render error:', err);
      this.showToast(`Video oluşturulamadı: ${err.message}`, 'error');
      if (progressEl) progressEl.style.display = 'none';
      if (exportBtn) exportBtn.disabled = false;
    }
  }
}
