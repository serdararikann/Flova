/* ====================================================================
   FLOVA AUDIO STUDIO - WAVEFORM CANVAS & TIMELINE CONTROLLER
   Interactive Multi-zoom Waveform, Selection Regions & Playhead Scrubbing
   Robust Canvas Peak Rendering with Safe Fallbacks
   ==================================================================== */

export class WaveformCanvas {
  constructor(canvasElement, overlayCanvas, options = {}) {
    this.canvas = canvasElement;
    this.ctx = this.canvas.getContext('2d');
    this.overlay = overlayCanvas;
    this.overlayCtx = this.overlay.getContext('2d');

    this.audioBuffer = null;
    this.currentTime = 0;
    this.duration = 0;

    // Selection range (in seconds)
    this.selectionStart = 0;
    this.selectionEnd = 0;
    this.isDragging = false;
    this.dragTarget = null; // 'start' | 'end' | 'region' | 'seek'
    this.dragStartX = 0;
    this.dragStartSelection = { start: 0, end: 0 };

    this.width = 800;
    this.height = 580;

    // Styling
    this.colors = {
      bg: '#070912',
      waveGradTop: '#38bdf8',
      waveGradBottom: '#6366f1',
      centerLine: 'rgba(255, 255, 255, 0.08)',
      playhead: '#f43f5e',
      regionBg: 'rgba(99, 102, 241, 0.22)',
      regionBorder: '#818cf8',
      handle: '#ffffff'
    };

    // Zoom & Horizontal Navigation
    this.zoomLevel = 1.0;
    this.minZoom = 1.0;
    this.maxZoom = 32.0;
    this.scrollTime = 0.0; // Leftmost time in seconds
    this.isPanning = false;
    this.panStartX = 0;
    this.panStartScrollTime = 0;

    // Beat Grid & Snapping
    this.beats = [];
    this.bpm = 0;
    this.showBeatGrid = false;
    this.snapToBeat = false;

    // Timeline Markers / Cue Points
    this.markers = [];

    this.onSelectionChange = options.onSelectionChange || null;
    this.onSeek = options.onSeek || null;

    this.initEvents();
    if (options.scrollbarContainer) {
      this.setupScrollbar(options.scrollbarContainer);
    }
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  get visibleDuration() {
    if (!this.duration || this.zoomLevel <= 1.0) return this.duration || 1;
    return this.duration / this.zoomLevel;
  }

  resize() {
    const parent = this.canvas.parentElement;
    if (!parent) return;

    const rect = parent.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;

    this.width = rect.width || 800;
    this.height = rect.height || 580;

    this.canvas.width = Math.floor(this.width * dpr);
    this.canvas.height = Math.floor(this.height * dpr);
    this.overlay.width = Math.floor(this.width * dpr);
    this.overlay.height = Math.floor(this.height * dpr);

    this.ctx.resetTransform ? this.ctx.resetTransform() : this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.overlayCtx.resetTransform ? this.overlayCtx.resetTransform() : this.overlayCtx.setTransform(1, 0, 0, 1, 0, 0);

    this.ctx.scale(dpr, dpr);
    this.overlayCtx.scale(dpr, dpr);

    this.draw();
    this.drawOverlay();
    this.updateScrollbar();
  }

  setBuffer(buffer, selStart = 0, selEnd = null) {
    this.audioBuffer = buffer;
    this.duration = buffer ? buffer.duration : 0;
    this.currentTime = 0;
    this.selectionStart = Math.max(0, Math.min(this.duration, selStart));
    this.selectionEnd = selEnd !== null ? Math.max(this.selectionStart, Math.min(this.duration, selEnd)) : this.duration;
    if (this.selectionEnd <= this.selectionStart && this.duration > 0) {
      this.selectionStart = 0;
      this.selectionEnd = this.duration;
    }
    this.zoomLevel = 1.0;
    this.scrollTime = 0.0;

    this.resize();
    this.draw();
    this.drawOverlay();
    this.updateScrollbar();

    if (this.onSelectionChange) {
      this.onSelectionChange(this.selectionStart, this.selectionEnd);
    }
  }

  setTime(time) {
    this.currentTime = Math.max(0, Math.min(this.duration, time));
    if (this.zoomLevel > 1.0) {
      const visDur = this.visibleDuration;
      // If playhead walks off right edge of screen during playback, smoothly autoscroll
      if (this.currentTime > this.scrollTime + visDur) {
        this.scrollToTime(Math.min(this.duration - visDur, this.currentTime - visDur * 0.15));
      } else if (this.currentTime < this.scrollTime) {
        this.scrollToTime(Math.max(0, this.currentTime - visDur * 0.15));
      }
    }
    this.drawOverlay();
  }

  setSelection(start, end) {
    this.selectionStart = Math.max(0, Math.min(this.duration, Math.min(start, end)));
    this.selectionEnd = Math.max(0, Math.min(this.duration, Math.max(start, end)));
    this.drawOverlay();

    if (this.onSelectionChange) {
      this.onSelectionChange(this.selectionStart, this.selectionEnd);
    }
  }

  timeToPixel(time) {
    if (this.duration === 0 || !this.width) return 0;
    const visDur = this.visibleDuration;
    return ((time - this.scrollTime) / visDur) * this.width;
  }

  pixelToTime(pixel) {
    if (this.width === 0 || this.duration === 0) return 0;
    const visDur = this.visibleDuration;
    const t = this.scrollTime + (pixel / this.width) * visDur;
    return Math.max(0, Math.min(this.duration, t));
  }

  setZoom(newZoom, focalX = null) {
    if (!this.audioBuffer || this.duration === 0) return;
    newZoom = Math.max(this.minZoom, Math.min(this.maxZoom, newZoom));
    if (Math.abs(newZoom - this.zoomLevel) < 0.001) return;

    const centerX = focalX !== null ? focalX : this.width / 2;
    const focalTime = this.pixelToTime(centerX);

    this.zoomLevel = newZoom;
    const newVisDur = this.visibleDuration;

    if (newZoom <= 1.0) {
      this.zoomLevel = 1.0;
      this.scrollTime = 0.0;
    } else {
      let targetScroll = focalTime - (centerX / this.width) * newVisDur;
      const maxScroll = Math.max(0, this.duration - newVisDur);
      this.scrollTime = Math.max(0, Math.min(maxScroll, targetScroll));
    }

    this.draw();
    this.drawOverlay();
    this.updateScrollbar();
  }

  scrollToTime(time) {
    const visDur = this.visibleDuration;
    const maxScroll = Math.max(0, this.duration - visDur);
    this.scrollTime = Math.max(0, Math.min(maxScroll, time));
    this.draw();
    this.drawOverlay();
    this.updateScrollbar();
  }

  scrollByPixels(deltaPx) {
    if (this.zoomLevel <= 1.0) return;
    const visDur = this.visibleDuration;
    const deltaTime = (deltaPx / this.width) * visDur;
    this.scrollToTime(this.scrollTime + deltaTime);
  }

  draw() {
    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;

    ctx.clearRect(0, 0, w, h);

    // Background
    ctx.fillStyle = this.colors.bg;
    ctx.fillRect(0, 0, w, h);

    if (!this.audioBuffer) {
      this.drawPlaceholderGrid(ctx, w, h);
      return;
    }

    const dataL = this.audioBuffer.getChannelData(0);
    const dataR = this.audioBuffer.numberOfChannels > 1 ? this.audioBuffer.getChannelData(1) : dataL;
    const totalSamples = this.audioBuffer.length;

    const centerY = h / 2;
    const amp = h * 0.44;

    // Draw center guideline
    ctx.strokeStyle = this.colors.centerLine;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, centerY);
    ctx.lineTo(w, centerY);
    ctx.stroke();

    // Waveform gradient
    const gradient = ctx.createLinearGradient(0, centerY - amp, 0, centerY + amp);
    gradient.addColorStop(0, this.colors.waveGradTop);
    gradient.addColorStop(0.5, '#ffffff');
    gradient.addColorStop(1, this.colors.waveGradBottom);

    ctx.fillStyle = gradient;

    // Step calculation: Draw crisp peak bars for visible window
    const visDur = this.visibleDuration;
    const sampleRate = this.audioBuffer.sampleRate || 44100;
    const startSample = Math.max(0, Math.floor(this.scrollTime * sampleRate));
    const endSample = Math.min(totalSamples, Math.ceil((this.scrollTime + visDur) * sampleRate));
    const visibleSamples = Math.max(1, endSample - startSample);

    const barWidth = 2;
    const gap = 1;
    const step = Math.max(1, Math.floor(visibleSamples / (w * 1.5)));

    for (let x = 0; x < w; x += (barWidth + gap)) {
      const sampleStart = startSample + Math.floor((x / w) * visibleSamples);
      const sampleEnd = Math.min(totalSamples, sampleStart + step);

      let min = 1.0;
      let max = -1.0;

      // Sample stride to ensure lightning speed rendering even at high zoom
      const count = sampleEnd - sampleStart;
      const stride = Math.max(1, Math.floor(count / 40));

      for (let i = sampleStart; i < sampleEnd; i += stride) {
        const valL = dataL[i] || 0;
        const valR = dataR[i] || 0;
        const val = (valL + valR) * 0.5;
        if (val < min) min = val;
        if (val > max) max = val;
      }

      if (max < min || min === 1.0) {
        min = -0.02;
        max = 0.02;
      }

      const top = centerY - Math.max(2, max * amp);
      const bottom = centerY - Math.min(-2, min * amp);
      const barHeight = Math.max(3, bottom - top);

      ctx.fillRect(x, top, barWidth, barHeight);
    }
  }

  drawOverlay() {
    const ctx = this.overlayCtx;
    const w = this.width;
    const h = this.height;

    ctx.clearRect(0, 0, w, h);

    if (!this.audioBuffer || this.duration === 0) return;

    // 0. Draw Beat Grid (if enabled)
    if (this.showBeatGrid && this.beats && this.beats.length > 0) {
      ctx.strokeStyle = 'rgba(0, 242, 254, 0.22)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);

      const visibleDuration = this.duration / this.zoomLevel;
      const minT = this.scrollTime - 0.5;
      const maxT = this.scrollTime + visibleDuration + 0.5;

      for (let i = 0; i < this.beats.length; i++) {
        const beatT = this.beats[i];
        if (beatT < minT) continue;
        if (beatT > maxT) break;

        const bx = this.timeToPixel(beatT);
        if (bx >= 0 && bx <= w) {
          ctx.beginPath();
          ctx.moveTo(bx, 0);
          ctx.lineTo(bx, h);
          ctx.stroke();
        }
      }
      ctx.setLineDash([]);
    }

    const startX = this.timeToPixel(this.selectionStart);
    const endX = this.timeToPixel(this.selectionEnd);
    const playheadX = this.timeToPixel(this.currentTime);

    // 1. Draw Selection Range
    const isCustomTrimmed = this.selectionEnd > this.selectionStart && (this.selectionStart > 0.05 || this.selectionEnd < this.duration - 0.05);

    if (this.selectionEnd > this.selectionStart) {
      const visibleLeft = Math.max(0, Math.min(w, startX));
      const visibleRight = Math.max(0, Math.min(w, endX));

      // Dimmed area outside selection - only when track is actually trimmed!
      if (isCustomTrimmed) {
        ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
        if (visibleLeft > 0) ctx.fillRect(0, 0, visibleLeft, h);
        if (visibleRight < w) ctx.fillRect(visibleRight, 0, w - visibleRight, h);

        // Selected area highlight
        if (visibleRight > visibleLeft) {
          ctx.fillStyle = this.colors.regionBg;
          ctx.fillRect(visibleLeft, 0, visibleRight - visibleLeft, h);
        }
      }

      // Selection Borders & Handles
      ctx.strokeStyle = this.colors.regionBorder;
      ctx.lineWidth = 2;

      if (startX >= -5 && startX <= w + 5) {
        ctx.beginPath();
        ctx.moveTo(startX, 0);
        ctx.lineTo(startX, h);
        ctx.stroke();
        this.drawHandle(ctx, startX, 36, true);
      }

      if (endX >= -5 && endX <= w + 5) {
        ctx.beginPath();
        ctx.moveTo(endX, 0);
        ctx.lineTo(endX, h);
        ctx.stroke();
        this.drawHandle(ctx, endX, 36, false);
      }
    }

    // 2. Draw Markers (Cue Points)
    if (this.markers && this.markers.length > 0) {
      for (const m of this.markers) {
        const mx = this.timeToPixel(m.time);
        if (mx >= -20 && mx <= w + 20) {
          ctx.strokeStyle = m.color || '#38bdf8';
          ctx.lineWidth = 1.5;
          ctx.setLineDash([3, 3]);
          ctx.beginPath();
          ctx.moveTo(mx, 26);
          ctx.lineTo(mx, h);
          ctx.stroke();
          ctx.setLineDash([]);

          // Marker Head Badge
          const labelText = m.label || 'İşaret';
          ctx.font = '600 10px Inter, -apple-system, sans-serif';
          const textMetrics = ctx.measureText(labelText);
          const badgeWidth = Math.max(22, textMetrics.width + 12);
          const badgeHeight = 18;
          const badgeX = mx - badgeWidth / 2;
          const badgeY = 6;

          ctx.fillStyle = m.color || '#38bdf8';
          ctx.beginPath();
          if (ctx.roundRect) {
            ctx.roundRect(badgeX, badgeY, badgeWidth, badgeHeight, 4);
          } else {
            ctx.rect(badgeX, badgeY, badgeWidth, badgeHeight);
          }
          ctx.fill();

          // Small pointer
          ctx.beginPath();
          ctx.moveTo(mx - 4, badgeY + badgeHeight);
          ctx.lineTo(mx + 4, badgeY + badgeHeight);
          ctx.lineTo(mx, badgeY + badgeHeight + 4);
          ctx.closePath();
          ctx.fill();

          ctx.fillStyle = '#080a10';
          ctx.fillText(labelText, badgeX + (badgeWidth - textMetrics.width) / 2, badgeY + 13);
        }
      }
    }

    // 3. Draw Playhead Indicator
    if (playheadX >= -10 && playheadX <= w + 10) {
      ctx.strokeStyle = this.colors.playhead;
      ctx.lineWidth = 2.5;
      ctx.shadowColor = 'rgba(244, 63, 94, 0.9)';
      ctx.shadowBlur = 8;
      ctx.beginPath();
      ctx.moveTo(playheadX, 0);
      ctx.lineTo(playheadX, h);
      ctx.stroke();

      // Playhead head marker
      ctx.fillStyle = this.colors.playhead;
      ctx.beginPath();
      ctx.moveTo(playheadX - 7, 0);
      ctx.lineTo(playheadX + 7, 0);
      ctx.lineTo(playheadX, 12);
      ctx.closePath();
      ctx.fill();
      ctx.shadowBlur = 0;
    }
  }

  addMarker(time, label = 'İşaretçi', color = '#38bdf8') {
    const id = 'marker_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4);
    const marker = { id, time: Math.max(0, Math.min(this.duration, time)), label, color };
    this.markers.push(marker);
    this.markers.sort((a, b) => a.time - b.time);
    this.drawOverlay();
    return marker;
  }

  removeMarker(id) {
    this.markers = this.markers.filter(m => m.id !== id);
    this.drawOverlay();
  }

  clearMarkers() {
    this.markers = [];
    this.drawOverlay();
  }

  getMarkers() {
    return [...this.markers];
  }

  findMarkerNear(pixelX, tolerance = 16) {
    for (const m of this.markers) {
      const px = this.timeToPixel(m.time);
      if (Math.abs(px - pixelX) <= tolerance) {
        return m;
      }
    }
    return null;
  }

  setBeats(beats, bpm = 120) {
    this.beats = beats || [];
    this.bpm = bpm || 120;
    this.drawOverlay();
  }

  toggleBeatGrid(forceState = null) {
    this.showBeatGrid = forceState !== null ? forceState : !this.showBeatGrid;
    this.drawOverlay();
    return this.showBeatGrid;
  }

  setSnapToBeat(enabled) {
    this.snapToBeat = !!enabled;
  }

  drawHandle(ctx, x, size, isLeft) {
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = isLeft ? '#38bdf8' : '#a855f7';
    ctx.lineWidth = 2;

    const handleWidth = 10;
    const handleHeight = 36;
    const handleY = 14;
    const handleX = isLeft ? x - handleWidth : x;

    ctx.fillRect(handleX, handleY, handleWidth, handleHeight);
    ctx.strokeRect(handleX, handleY, handleWidth, handleHeight);

    // Handle grip lines
    ctx.strokeStyle = '#475569';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(handleX + 3.5, handleY + 9);
    ctx.lineTo(handleX + 3.5, handleY + handleHeight - 9);
    ctx.moveTo(handleX + 6.5, handleY + 9);
    ctx.lineTo(handleX + 6.5, handleY + handleHeight - 9);
    ctx.stroke();
  }

  drawPlaceholderGrid(ctx, w, h) {
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.03)';
    ctx.lineWidth = 1;
    const gridSize = 24;
    for (let x = 0; x < w; x += gridSize) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
    for (let y = 0; y < h; y += gridSize) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }
  }

  setupScrollbar(container) {
    if (!container) return;
    this.scrollbarContainer = container;
    this.scrollbarTrack = container.querySelector('#waveformScrollbarTrack');
    this.scrollbarThumb = container.querySelector('#waveformScrollbarThumb');
    this.zoomLevelDisplay = container.querySelector('#zoomLevelDisplay');
    this.zoomInBtn = container.querySelector('#zoomInBtn');
    this.zoomOutBtn = container.querySelector('#zoomOutBtn');
    this.zoomResetBtn = container.querySelector('#zoomResetBtn');

    if (this.zoomInBtn) {
      this.zoomInBtn.addEventListener('click', () => {
        this.setZoom(this.zoomLevel * 1.5);
      });
    }
    if (this.zoomOutBtn) {
      this.zoomOutBtn.addEventListener('click', () => {
        this.setZoom(this.zoomLevel / 1.5);
      });
    }
    if (this.zoomResetBtn) {
      this.zoomResetBtn.addEventListener('click', () => {
        this.setZoom(1.0);
      });
    }

    let isThumbDragging = false;
    let thumbDragStartX = 0;
    let thumbDragStartScrollTime = 0;

    if (this.scrollbarThumb) {
      this.scrollbarThumb.addEventListener('mousedown', (e) => {
        if (this.zoomLevel <= 1.0) return;
        e.preventDefault();
        e.stopPropagation();
        isThumbDragging = true;
        thumbDragStartX = e.clientX;
        thumbDragStartScrollTime = this.scrollTime;
        this.scrollbarThumb.classList.add('active');
      });
    }

    if (this.scrollbarTrack) {
      this.scrollbarTrack.addEventListener('click', (e) => {
        if (this.zoomLevel <= 1.0 || isThumbDragging) return;
        const rect = this.scrollbarTrack.getBoundingClientRect();
        const clickRatio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        const visDur = this.visibleDuration;
        const targetTime = clickRatio * this.duration - visDur / 2;
        this.scrollToTime(targetTime);
      });
    }

    window.addEventListener('mousemove', (e) => {
      if (!isThumbDragging || !this.scrollbarTrack) return;
      const rect = this.scrollbarTrack.getBoundingClientRect();
      const trackWidth = rect.width;
      if (trackWidth <= 0) return;

      const deltaX = e.clientX - thumbDragStartX;
      const deltaTime = (deltaX / trackWidth) * this.duration;
      this.scrollToTime(thumbDragStartScrollTime + deltaTime);
    });

    window.addEventListener('mouseup', () => {
      if (isThumbDragging) {
        isThumbDragging = false;
        if (this.scrollbarThumb) {
          this.scrollbarThumb.classList.remove('active');
        }
      }
    });

    this.updateScrollbar();
  }

  updateScrollbar() {
    if (!this.scrollbarContainer) return;
    if (this.zoomLevelDisplay) {
      this.zoomLevelDisplay.textContent = `${this.zoomLevel.toFixed(1)}x`;
    }

    if (!this.scrollbarThumb || !this.scrollbarTrack) return;

    if (this.zoomLevel <= 1.0) {
      this.scrollbarThumb.style.width = '100%';
      this.scrollbarThumb.style.left = '0%';
      this.scrollbarThumb.style.opacity = '0.35';
      this.scrollbarThumb.style.cursor = 'default';
    } else {
      const thumbRatio = Math.max(0.04, 1 / this.zoomLevel);
      const scrollRatio = this.duration > 0 ? this.scrollTime / this.duration : 0;
      
      const thumbWidthPct = thumbRatio * 100;
      const thumbLeftPct = Math.min(100 - thumbWidthPct, scrollRatio * 100);

      this.scrollbarThumb.style.width = `${thumbWidthPct}%`;
      this.scrollbarThumb.style.left = `${thumbLeftPct}%`;
      this.scrollbarThumb.style.opacity = '1';
      this.scrollbarThumb.style.cursor = 'grab';
    }
  }

  initEvents() {
    const overlay = this.overlay;

    // Ctrl + Mouse Wheel = Zoom in/out at cursor
    // Plain Mouse Wheel (when zoomed) = Horizontal Scroll
    overlay.addEventListener('wheel', (e) => {
      if (!this.audioBuffer) return;

      if (e.ctrlKey) {
        e.preventDefault();
        const rect = overlay.getBoundingClientRect();
        const mouseX = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
        const factor = e.deltaY < 0 ? 1.3 : 0.77;
        this.setZoom(this.zoomLevel * factor, mouseX);
      } else if (this.zoomLevel > 1.0) {
        e.preventDefault();
        const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        this.scrollByPixels(delta * 0.7);
      }
    }, { passive: false });

    let mouseDownX = 0;
    let mouseDownTime = 0;

    overlay.addEventListener('mousedown', (e) => {
      if (!this.audioBuffer) return;
      const rect = overlay.getBoundingClientRect();
      const x = e.clientX - rect.left;

      // Middle click or Alt+Click = Pan
      if (e.button === 1 || (e.button === 0 && e.altKey)) {
        e.preventDefault();
        this.isPanning = true;
        this.panStartX = e.clientX;
        this.panStartScrollTime = this.scrollTime;
        overlay.style.cursor = 'grabbing';
        return;
      }

      if (e.button !== 0) return; // Only left click from here

      const time = this.pixelToTime(x);
      mouseDownX = x;
      mouseDownTime = time;

      const startX = this.timeToPixel(this.selectionStart);
      const endX = this.timeToPixel(this.selectionEnd);
      const handleRadius = 14;

      this.dragStartX = x;
      this.dragStartSelection = { start: this.selectionStart, end: this.selectionEnd };

      // Check marker click in top header region (y <= 30)
      const y = e.clientY - rect.top;
      if (y <= 30) {
        const marker = this.findMarkerNear(x);
        if (marker) {
          this.currentTime = marker.time;
          if (this.onSeek) this.onSeek(marker.time);
          this.drawOverlay();
          return;
        }
      }

      const hasSelection = this.selectionEnd > this.selectionStart && (this.selectionEnd - this.selectionStart) > 0.05;

      if (hasSelection && Math.abs(x - startX) <= handleRadius) {
        this.isDragging = true;
        this.dragTarget = 'start';
      } else if (hasSelection && Math.abs(x - endX) <= handleRadius) {
        this.isDragging = true;
        this.dragTarget = 'end';
      } else if (hasSelection && time >= this.selectionStart && time <= this.selectionEnd) {
        this.isDragging = true;
        this.dragTarget = e.shiftKey ? 'region' : 'seek';
      } else {
        this.isDragging = true;
        this.dragTarget = hasSelection ? 'outsideClick' : 'seek';
      }
    });

    window.addEventListener('mousemove', (e) => {
      if (this.isPanning) {
        const deltaPx = e.clientX - this.panStartX;
        const deltaTime = (deltaPx / this.width) * this.visibleDuration;
        this.scrollToTime(this.panStartScrollTime - deltaTime);
        return;
      }

      if (!this.isDragging || !this.audioBuffer) {
        const rect = overlay.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const startX = this.timeToPixel(this.selectionStart);
        const endX = this.timeToPixel(this.selectionEnd);
        const handleRadius = 12;
        const hasSelection = this.selectionEnd > this.selectionStart && (this.selectionEnd - this.selectionStart) > 0.05;

        if (hasSelection && (Math.abs(x - startX) <= handleRadius || Math.abs(x - endX) <= handleRadius)) {
          overlay.style.cursor = 'ew-resize';
        } else if (hasSelection && x > startX && x < endX) {
          overlay.style.cursor = 'crosshair';
        } else {
          overlay.style.cursor = 'pointer';
        }
        return;
      }

      const rect = overlay.getBoundingClientRect();
      const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
      const time = this.pixelToTime(x);

      if (this.dragTarget === 'start') {
        this.selectionStart = Math.max(0, Math.min(this.selectionEnd - 0.05, time));
      } else if (this.dragTarget === 'end') {
        this.selectionEnd = Math.min(this.duration, Math.max(this.selectionStart + 0.05, time));
      } else if (this.dragTarget === 'region') {
        const deltaSec = this.pixelToTime(x) - this.pixelToTime(this.dragStartX);
        const dur = this.dragStartSelection.end - this.dragStartSelection.start;
        let newStart = this.dragStartSelection.start + deltaSec;
        let newEnd = this.dragStartSelection.end + deltaSec;

        if (newStart < 0) {
          newStart = 0;
          newEnd = dur;
        }
        if (newEnd > this.duration) {
          newEnd = this.duration;
          newStart = this.duration - dur;
        }
        this.selectionStart = newStart;
        this.selectionEnd = newEnd;
      } else if (this.dragTarget === 'seek' || this.dragTarget === 'outsideClick') {
        // If dragged more than 8 pixels, user is actively drawing a new selection
        const dragDist = Math.abs(x - this.dragStartX);
        if (dragDist > 8) {
          this.dragTarget = 'newSelection';
          if (time >= mouseDownTime) {
            this.selectionStart = mouseDownTime;
            this.selectionEnd = time;
          } else {
            this.selectionStart = time;
            this.selectionEnd = mouseDownTime;
          }
        }
      } else if (this.dragTarget === 'newSelection') {
        if (time >= mouseDownTime) {
          this.selectionStart = mouseDownTime;
          this.selectionEnd = time;
        } else {
          this.selectionStart = time;
          this.selectionEnd = mouseDownTime;
        }
      }

      this.drawOverlay();

      if (this.onSelectionChange && this.dragTarget !== 'seek' && this.dragTarget !== 'outsideClick') {
        const s = Math.min(this.selectionStart, this.selectionEnd);
        const en = Math.max(this.selectionStart, this.selectionEnd);
        this.onSelectionChange(s, en);
      }
    });

    window.addEventListener('mouseup', (e) => {
      if (this.isPanning) {
        this.isPanning = false;
        overlay.style.cursor = 'crosshair';
      }

      if (this.isDragging) {
        const curX = e.clientX - overlay.getBoundingClientRect().left;
        const dragDist = Math.abs(curX - this.dragStartX);

        if ((this.dragTarget === 'seek' || this.dragTarget === 'outsideClick') && dragDist <= 8) {
          // Clicked anywhere on the waveform: seek playhead directly to clicked time
          const targetTime = Math.max(0, Math.min(this.duration, mouseDownTime));
          this.currentTime = targetTime;
          if (this.onSeek) this.onSeek(targetTime);
          this.drawOverlay();
        } else if (this.dragTarget === 'newSelection') {
          const s = Math.min(this.selectionStart, this.selectionEnd);
          const en = Math.max(this.selectionStart, this.selectionEnd);

          if (Math.abs(s - en) < 0.08) {
            // Barely moved: restore previous selection and seek to clicked time
            this.selectionStart = this.dragStartSelection.start;
            this.selectionEnd = this.dragStartSelection.end;
            const targetTime = Math.max(0, Math.min(this.duration, mouseDownTime));
            this.currentTime = targetTime;
            if (this.onSeek) this.onSeek(targetTime);
            this.drawOverlay();
          } else {
            this.selectionStart = s;
            this.selectionEnd = en;
            if (this.onSelectionChange) {
              this.onSelectionChange(this.selectionStart, this.selectionEnd);
            }
            if (this.onSelectionCommit) {
              this.onSelectionCommit(this.selectionStart, this.selectionEnd);
            }
          }
        } else if (this.dragTarget === 'start' || this.dragTarget === 'end' || this.dragTarget === 'region') {
          if (this.onSelectionChange) {
            this.onSelectionChange(this.selectionStart, this.selectionEnd);
          }
          if (this.onSelectionCommit) {
            this.onSelectionCommit(this.selectionStart, this.selectionEnd);
          }
        }

        this.isDragging = false;
        this.dragTarget = null;
        this.drawOverlay();
      }
    });
  }
}
