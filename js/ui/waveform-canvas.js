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

    this.onSelectionChange = options.onSelectionChange || null;
    this.onSeek = options.onSeek || null;

    this.initEvents();
    this.resize();
    window.addEventListener('resize', () => this.resize());
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
  }

  setBuffer(buffer) {
    this.audioBuffer = buffer;
    this.duration = buffer ? buffer.duration : 0;
    this.currentTime = 0;
    this.selectionStart = 0;
    this.selectionEnd = this.duration;

    this.resize();
    this.draw();
    this.drawOverlay();

    if (this.onSelectionChange) {
      this.onSelectionChange(this.selectionStart, this.selectionEnd);
    }
  }

  setTime(time) {
    this.currentTime = Math.max(0, Math.min(this.duration, time));
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
    return (time / this.duration) * this.width;
  }

  pixelToTime(pixel) {
    if (this.width === 0 || this.duration === 0) return 0;
    return Math.max(0, Math.min(this.duration, (pixel / this.width) * this.duration));
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

    // Step calculation: Draw crisp peak bars
    const barWidth = 2;
    const gap = 1;
    const step = Math.max(1, Math.floor(totalSamples / (w * 1.5)));

    for (let x = 0; x < w; x += (barWidth + gap)) {
      const sampleStart = Math.floor((x / w) * totalSamples);
      const sampleEnd = Math.min(totalSamples, sampleStart + step);

      let min = 1.0;
      let max = -1.0;

      // Sample stride to ensure lightning speed rendering even on 1-hour tracks
      const stride = Math.max(1, Math.floor((sampleEnd - sampleStart) / 40));

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

    const startX = this.timeToPixel(this.selectionStart);
    const endX = this.timeToPixel(this.selectionEnd);
    const playheadX = this.timeToPixel(this.currentTime);

    // 1. Draw Selection Range
    if (this.selectionEnd > this.selectionStart) {
      // Dimmed area outside selection
      ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
      ctx.fillRect(0, 0, startX, h);
      ctx.fillRect(endX, 0, w - endX, h);

      // Selected area highlight
      ctx.fillStyle = this.colors.regionBg;
      ctx.fillRect(startX, 0, endX - startX, h);

      // Selection Borders
      ctx.strokeStyle = this.colors.regionBorder;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(startX, 0);
      ctx.lineTo(startX, h);
      ctx.moveTo(endX, 0);
      ctx.lineTo(endX, h);
      ctx.stroke();

      // Draggable Handles
      this.drawHandle(ctx, startX, 36, true);
      this.drawHandle(ctx, endX, 36, false);
    }

    // 2. Draw Playhead Indicator
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

  initEvents() {
    const overlay = this.overlay;

    const getX = (e) => {
      const rect = overlay.getBoundingClientRect();
      return Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    };

    let mouseDownX = 0;
    let mouseDownTime = 0;

    overlay.addEventListener('mousedown', (e) => {
      if (!this.audioBuffer) return;
      const rect = overlay.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const time = this.pixelToTime(x);

      mouseDownX = x;
      mouseDownTime = time;

      const startX = this.timeToPixel(this.selectionStart);
      const endX = this.timeToPixel(this.selectionEnd);

      const handleRadius = 14;

      if (Math.abs(x - startX) <= handleRadius) {
        this.isDragging = true;
        this.dragTarget = 'start';
      } else if (Math.abs(x - endX) <= handleRadius) {
        this.isDragging = true;
        this.dragTarget = 'end';
      } else if (x > startX + handleRadius && x < endX - handleRadius && e.shiftKey) {
        this.isDragging = true;
        this.dragTarget = 'region';
        this.dragStartX = x;
        this.dragStartSelection = { start: this.selectionStart, end: this.selectionEnd };
      } else {
        // Natural Selection / Seek: Start new selection from click
        this.isDragging = true;
        this.dragTarget = 'newSelection';
        this.dragStartX = x;
        this.selectionStart = time;
        this.selectionEnd = time;
        this.currentTime = time;
        if (this.onSeek) this.onSeek(time);
        this.drawOverlay();
      }
    });

    window.addEventListener('mousemove', (e) => {
      if (!this.isDragging || !this.audioBuffer) {
        const rect = overlay.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const startX = this.timeToPixel(this.selectionStart);
        const endX = this.timeToPixel(this.selectionEnd);
        const handleRadius = 12;

        if (Math.abs(x - startX) <= handleRadius || Math.abs(x - endX) <= handleRadius) {
          overlay.style.cursor = 'ew-resize';
        } else if (x > startX && x < endX) {
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
        this.selectionStart = Math.min(time, this.selectionEnd - 0.05);
      } else if (this.dragTarget === 'end') {
        this.selectionEnd = Math.max(time, this.selectionStart + 0.05);
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
      } else if (this.dragTarget === 'newSelection') {
        // Dragging to select a region
        if (time >= mouseDownTime) {
          this.selectionStart = mouseDownTime;
          this.selectionEnd = time;
        } else {
          this.selectionStart = time;
          this.selectionEnd = mouseDownTime;
        }
      }

      this.drawOverlay();

      if (this.onSelectionChange && this.dragTarget !== 'seek') {
        const s = Math.min(this.selectionStart, this.selectionEnd);
        const en = Math.max(this.selectionStart, this.selectionEnd);
        this.onSelectionChange(s, en);
      }
    });

    window.addEventListener('mouseup', (e) => {
      if (this.isDragging) {
        if (this.dragTarget === 'newSelection') {
          const s = Math.min(this.selectionStart, this.selectionEnd);
          const en = Math.max(this.selectionStart, this.selectionEnd);

          // If user barely moved (< 4px), select entire track and place playhead at click
          if (Math.abs(s - en) < 0.08) {
            this.selectionStart = 0;
            this.selectionEnd = this.duration;
            this.currentTime = mouseDownTime;
            if (this.onSeek) this.onSeek(mouseDownTime);
          } else {
            this.selectionStart = s;
            this.selectionEnd = en;
          }

          if (this.onSelectionChange) {
            this.onSelectionChange(this.selectionStart, this.selectionEnd);
          }
        }
        this.isDragging = false;
        this.dragTarget = null;
        this.drawOverlay();
      }
    });
  }
}
