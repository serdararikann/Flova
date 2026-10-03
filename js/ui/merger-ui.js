/* ====================================================================
   FLOVA AUDIO STUDIO - AUDIO MERGER UI CONTROLLER
   - Typed Number Inputs & Sliders for Crossfade, Fade In & Fade Out
   - Resume Playback Exactly Where Paused on Space Key
   - Persistent Track List & Continuous Session Editing After Merge
   - Real-time Waveform Canvas with Draggable Handles & Fade Envelopes
   ==================================================================== */

import { AudioProcessor } from '../audio/audio-processor.js';
import { BPMKeyDetector } from '../audio/bpm-key-detector.js';

/**
 * Interactive waveform canvas for an individual track in the Merger
 */
class MergerTrackWaveform {
  constructor(canvasElement, track, onRangeChange, onSeek, scrollbarWrap = null, onRangeCommit = null) {
    this.canvas = canvasElement;
    this.ctx = this.canvas.getContext('2d');
    this.track = track;
    this.onRangeChange = onRangeChange;
    this.onSeek = onSeek;
    this.onRangeCommit = onRangeCommit;

    this.isDragging = false;
    this.dragTarget = null; // 'start' | 'end' | 'region'
    this.dragStartX = 0;
    this.dragInitialRange = { start: track.trimStart, end: track.trimEnd };
    this.currentPlayTime = null;

    // Zoom & Horizontal Navigation
    this.zoomLevel = 1.0;
    this.minZoom = 1.0;
    this.maxZoom = 32.0;
    this.scrollTime = 0.0;
    this.scrollbarWrap = scrollbarWrap;

    this.resize();
    this.initEvents();
    if (this.scrollbarWrap) {
      this.setupScrollbar(this.scrollbarWrap);
    }
  }

  get visibleDuration() {
    if (!this.track.duration || this.zoomLevel <= 1.0) return this.track.duration || 1;
    return this.track.duration / this.zoomLevel;
  }

  resize() {
    const parent = this.canvas.parentElement;
    if (!parent) return;
    const rect = parent.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.width = rect.width || 600;
    this.height = 130;

    this.canvas.width = Math.floor(this.width * dpr);
    this.canvas.height = Math.floor(this.height * dpr);

    this.ctx.resetTransform ? this.ctx.resetTransform() : this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.scale(dpr, dpr);
    this.draw();
    this.updateScrollbar();
  }

  setPlayheadTime(time) {
    this.currentPlayTime = time;
    if (this.zoomLevel > 1.0 && time !== null) {
      const visDur = this.visibleDuration;
      if (time > this.scrollTime + visDur) {
        this.scrollToTime(Math.min(this.track.duration - visDur, time - visDur * 0.15));
      } else if (time < this.scrollTime) {
        this.scrollToTime(Math.max(0, time - visDur * 0.15));
      }
    }
    this.draw();
  }

  timeToX(time) {
    if (!this.track.duration || !this.width) return 0;
    const visDur = this.visibleDuration;
    return ((time - this.scrollTime) / visDur) * this.width;
  }

  xToTime(x) {
    if (!this.width || !this.track.duration) return 0;
    const visDur = this.visibleDuration;
    const t = this.scrollTime + (x / this.width) * visDur;
    return Math.max(0, Math.min(this.track.duration, t));
  }

  setZoom(newZoom, focalX = null) {
    if (!this.track.duration) return;
    newZoom = Math.max(this.minZoom, Math.min(this.maxZoom, newZoom));
    if (Math.abs(newZoom - this.zoomLevel) < 0.001) return;

    const centerX = focalX !== null ? focalX : this.width / 2;
    const focalTime = this.xToTime(centerX);

    this.zoomLevel = newZoom;
    const newVisDur = this.visibleDuration;

    if (newZoom <= 1.0) {
      this.zoomLevel = 1.0;
      this.scrollTime = 0.0;
    } else {
      let targetScroll = focalTime - (centerX / this.width) * newVisDur;
      const maxScroll = Math.max(0, this.track.duration - newVisDur);
      this.scrollTime = Math.max(0, Math.min(maxScroll, targetScroll));
    }

    this.draw();
    this.updateScrollbar();
  }

  scrollToTime(time) {
    const visDur = this.visibleDuration;
    const maxScroll = Math.max(0, this.track.duration - visDur);
    this.scrollTime = Math.max(0, Math.min(maxScroll, time));
    this.draw();
    this.updateScrollbar();
  }

  scrollByPixels(deltaPx) {
    if (this.zoomLevel <= 1.0) return;
    const visDur = this.visibleDuration;
    const deltaTime = (deltaPx / this.width) * visDur;
    this.scrollToTime(this.scrollTime + deltaTime);
  }

  setupScrollbar(container) {
    if (!container) return;
    this.scrollbarWrap = container;
    this.scrollTrack = container.querySelector('.merger-track-scrollbar-track');
    this.scrollThumb = container.querySelector('.merger-track-scrollbar-thumb');
    this.zoomBadge = container.querySelector('.merger-zoom-badge');

    let isThumbDragging = false;
    let dragStartX = 0;
    let dragStartScroll = 0;

    if (this.scrollThumb) {
      this.scrollThumb.addEventListener('mousedown', (e) => {
        if (this.zoomLevel <= 1.0) return;
        e.preventDefault();
        e.stopPropagation();
        isThumbDragging = true;
        dragStartX = e.clientX;
        dragStartScroll = this.scrollTime;
        this.scrollThumb.classList.add('active');
      });
    }

    if (this.scrollTrack) {
      this.scrollTrack.addEventListener('click', (e) => {
        if (this.zoomLevel <= 1.0 || isThumbDragging) return;
        const rect = this.scrollTrack.getBoundingClientRect();
        const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        const visDur = this.visibleDuration;
        const target = ratio * this.track.duration - visDur / 2;
        this.scrollToTime(target);
      });
    }

    window.addEventListener('mousemove', (e) => {
      if (!isThumbDragging || !this.scrollTrack) return;
      const rect = this.scrollTrack.getBoundingClientRect();
      if (rect.width <= 0) return;
      const deltaX = e.clientX - dragStartX;
      const deltaTime = (deltaX / rect.width) * this.track.duration;
      this.scrollToTime(dragStartScroll + deltaTime);
    });

    window.addEventListener('mouseup', () => {
      if (isThumbDragging) {
        isThumbDragging = false;
        if (this.scrollThumb) this.scrollThumb.classList.remove('active');
      }
    });

    this.updateScrollbar();
  }

  updateScrollbar() {
    if (!this.scrollbarWrap) return;
    if (this.zoomLevel <= 1.0) {
      this.scrollbarWrap.style.display = 'none';
      return;
    }

    this.scrollbarWrap.style.display = 'flex';
    if (this.zoomBadge) {
      this.zoomBadge.textContent = `${this.zoomLevel.toFixed(1)}x`;
    }

    if (!this.scrollThumb || !this.scrollTrack) return;

    const thumbRatio = Math.max(0.04, 1 / this.zoomLevel);
    const scrollRatio = this.track.duration > 0 ? this.scrollTime / this.track.duration : 0;
    const thumbWidthPct = thumbRatio * 100;
    const thumbLeftPct = Math.min(100 - thumbWidthPct, scrollRatio * 100);

    this.scrollThumb.style.width = `${thumbWidthPct}%`;
    this.scrollThumb.style.left = `${thumbLeftPct}%`;
  }

  draw() {
    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;
    const track = this.track;
    const buffer = track.buffer;

    ctx.clearRect(0, 0, w, h);

    // Background
    ctx.fillStyle = '#070912';
    ctx.fillRect(0, 0, w, h);

    if (!buffer) return;

    const data = buffer.getChannelData(0);
    const totalSamples = buffer.length;
    const centerY = h / 2;
    const amp = h * 0.44;

    // Center guideline
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, centerY);
    ctx.lineTo(w, centerY);
    ctx.stroke();

    // 1. Draw Waveform Peaks for visible window
    const visDur = this.visibleDuration;
    const sampleRate = buffer.sampleRate || 44100;
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
      const count = sampleEnd - sampleStart;
      const stride = Math.max(1, Math.floor(count / 30));

      for (let i = sampleStart; i < sampleEnd; i += stride) {
        const val = data[i] || 0;
        if (val < min) min = val;
        if (val > max) max = val;
      }

      if (max < min || min === 1.0) { min = -0.02; max = 0.02; }

      const top = centerY - Math.max(2, max * amp);
      const bottom = centerY - Math.min(-2, min * amp);
      const barHeight = Math.max(2, bottom - top);

      const currentTime = this.xToTime(x);
      const isInside = (track.trimStart <= 0.05 && track.trimEnd >= track.duration - 0.05) || (currentTime >= track.trimStart && currentTime <= track.trimEnd);

      if (isInside) {
        const grad = ctx.createLinearGradient(0, top, 0, bottom);
        grad.addColorStop(0, '#38bdf8');
        grad.addColorStop(1, '#6366f1');
        ctx.fillStyle = grad;
      } else {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.15)';
      }

      ctx.fillRect(x, top, barWidth, barHeight);
    }

    // 2. Selection Bounds & Dimmed Overlays
    const startX = this.timeToX(track.trimStart);
    const endX = this.timeToX(track.trimEnd);
    const visibleLeft = Math.max(0, Math.min(w, startX));
    const visibleRight = Math.max(0, Math.min(w, endX));

    const isCustomTrimmed = track.trimEnd > track.trimStart && (track.trimStart > 0.05 || track.trimEnd < track.duration - 0.05);

    if (isCustomTrimmed) {
      ctx.fillStyle = 'rgba(0, 0, 0, 0.65)';
      if (visibleLeft > 0) ctx.fillRect(0, 0, visibleLeft, h);
      if (visibleRight < w) ctx.fillRect(visibleRight, 0, w - visibleRight, h);

      // 3. Selection Region Highlight
      if (visibleRight > visibleLeft) {
        ctx.fillStyle = 'rgba(99, 102, 241, 0.12)';
        ctx.fillRect(visibleLeft, 0, visibleRight - visibleLeft, h);
      }
    }

    // 4. Draw Fade In & Fade Out Visual Curves on Waveform
    if (track.fadeInSec > 0) {
      const fadeStartX = startX;
      const fadeEndX = Math.min(endX, this.timeToX(track.trimStart + track.fadeInSec));
      if (fadeEndX > 0 && fadeStartX < w) {
        ctx.fillStyle = 'rgba(16, 185, 129, 0.18)';
        ctx.beginPath();
        ctx.moveTo(Math.max(0, fadeStartX), h);
        ctx.lineTo(Math.min(w, fadeEndX), 0);
        ctx.lineTo(Math.max(0, fadeStartX), 0);
        ctx.closePath();
        ctx.fill();

        ctx.strokeStyle = '#10b981';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(Math.max(0, fadeStartX), h);
        ctx.lineTo(Math.min(w, fadeEndX), 0);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    if (track.fadeOutSec > 0) {
      const fadeOutStartX = Math.max(startX, this.timeToX(track.trimEnd - track.fadeOutSec));
      const fadeOutEndX = endX;
      if (fadeOutEndX > 0 && fadeOutStartX < w) {
        ctx.fillStyle = 'rgba(244, 63, 94, 0.18)';
        ctx.beginPath();
        ctx.moveTo(Math.max(0, fadeOutStartX), 0);
        ctx.lineTo(Math.min(w, fadeOutEndX), h);
        ctx.lineTo(Math.min(w, fadeOutEndX), 0);
        ctx.closePath();
        ctx.fill();

        ctx.strokeStyle = '#f43f5e';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(Math.max(0, fadeOutStartX), 0);
        ctx.lineTo(Math.min(w, fadeOutEndX), h);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // Top and bottom selection borders (when custom trimmed)
    if (isCustomTrimmed && visibleRight > visibleLeft) {
      ctx.strokeStyle = '#818cf8';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(visibleLeft, 0);
      ctx.lineTo(visibleRight, 0);
      ctx.moveTo(visibleLeft, h);
      ctx.lineTo(visibleRight, h);
      ctx.stroke();
    }

    // 5. Draggable Handles (Left & Right)
    if (startX >= -5 && startX <= w + 5) {
      this.drawHandle(ctx, startX, h, true);
    }
    if (endX >= -5 && endX <= w + 5) {
      this.drawHandle(ctx, endX, h, false);
    }

    // 6. Draw Live Moving Playhead Cursor (if playing)
    if (this.currentPlayTime !== null && this.currentPlayTime >= 0) {
      const playX = this.timeToX(this.currentPlayTime);
      if (playX >= -5 && playX <= w + 5) {
        ctx.strokeStyle = '#f43f5e';
        ctx.lineWidth = 2.5;
        ctx.shadowColor = 'rgba(244, 63, 94, 0.9)';
        ctx.shadowBlur = 8;
        ctx.beginPath();
        ctx.moveTo(playX, 0);
        ctx.lineTo(playX, h);
        ctx.stroke();

        ctx.fillStyle = '#f43f5e';
        ctx.beginPath();
        ctx.moveTo(playX - 6, 0);
        ctx.lineTo(playX + 6, 0);
        ctx.lineTo(playX, 10);
        ctx.closePath();
        ctx.fill();
        ctx.shadowBlur = 0;
      }
    }
  }

  drawHandle(ctx, x, h, isLeft) {
    const handleW = 12;
    const handleX = isLeft ? x - handleW : x;

    ctx.strokeStyle = isLeft ? '#38bdf8' : '#a855f7';
    ctx.lineWidth = 2.5;
    ctx.shadowColor = isLeft ? 'rgba(56, 189, 248, 0.8)' : 'rgba(168, 85, 247, 0.8)';
    ctx.shadowBlur = 6;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
    ctx.shadowBlur = 0;

    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = isLeft ? '#38bdf8' : '#a855f7';
    ctx.lineWidth = 1.5;

    const btnH = 30;
    const btnY = (h - btnH) / 2;

    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(handleX, btnY, handleW, btnH, isLeft ? [5, 0, 0, 5] : [0, 5, 5, 0]) : ctx.fillRect(handleX, btnY, handleW, btnH);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#475569';
    ctx.beginPath();
    ctx.arc(handleX + handleW / 2, btnY + 9, 1.3, 0, Math.PI * 2);
    ctx.arc(handleX + handleW / 2, btnY + 15, 1.3, 0, Math.PI * 2);
    ctx.arc(handleX + handleW / 2, btnY + 21, 1.3, 0, Math.PI * 2);
    ctx.fill();
  }

  initEvents() {
    const canvas = this.canvas;

    const getX = (e) => {
      const rect = canvas.getBoundingClientRect();
      return Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    };

    // Ctrl + Mouse Wheel = Zoom In/Out
    // Plain Mouse Wheel (zoomed in) = Horizontal Scroll
    canvas.addEventListener('wheel', (e) => {
      if (!this.track.buffer) return;

      if (e.ctrlKey) {
        e.preventDefault();
        const rect = canvas.getBoundingClientRect();
        const mouseX = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
        const factor = e.deltaY < 0 ? 1.3 : 0.77;
        this.setZoom(this.zoomLevel * factor, mouseX);
      } else if (this.zoomLevel > 1.0) {
        e.preventDefault();
        const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        this.scrollByPixels(delta * 0.7);
      }
    }, { passive: false });

    canvas.addEventListener('mousedown', (e) => {
      const x = getX(e);
      const time = this.xToTime(x);

      const startX = this.timeToX(this.track.trimStart);
      const endX = this.timeToX(this.track.trimEnd);
      const threshold = 18;

      this.dragStartX = x;
      this.dragStartTime = time;
      this.dragInitialRange = { start: this.track.trimStart, end: this.track.trimEnd };

      if (Math.abs(x - startX) <= threshold) {
        this.isDragging = true;
        this.dragTarget = 'start';
      } else if (Math.abs(x - endX) <= threshold) {
        this.isDragging = true;
        this.dragTarget = 'end';
      } else if (time >= this.track.trimStart && time <= this.track.trimEnd) {
        // Clicked inside active trimmed area
        this.isDragging = true;
        this.dragTarget = e.shiftKey ? 'region' : 'seek';
      } else {
        // Clicked in the dimmed / excluded part outside the trim bounds
        // DO NOT reset trimStart or trimEnd!
        this.isDragging = true;
        this.dragTarget = 'outsideClick';
      }
    });

    window.addEventListener('mousemove', (e) => {
      if (!this.isDragging) {
        const rect = canvas.getBoundingClientRect();
        if (e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom) {
          const x = e.clientX - rect.left;
          const startX = this.timeToX(this.track.trimStart);
          const endX = this.timeToX(this.track.trimEnd);
          const threshold = 18;

          if (Math.abs(x - startX) <= threshold || Math.abs(x - endX) <= threshold) {
            canvas.style.cursor = 'ew-resize';
          } else if (x > startX && x < endX) {
            canvas.style.cursor = 'pointer';
          } else {
            canvas.style.cursor = 'default';
          }
        }
        return;
      }

      const x = getX(e);
      const time = this.xToTime(x);

      if (this.dragTarget === 'start') {
        this.track.trimStart = Math.max(0, Math.min(this.track.trimEnd - 0.05, time));
        this.draw();
        if (this.onRangeChange) this.onRangeChange(this.track.trimStart, this.track.trimEnd);
      } else if (this.dragTarget === 'end') {
        this.track.trimEnd = Math.min(this.track.duration, Math.max(this.track.trimStart + 0.05, time));
        this.draw();
        if (this.onRangeChange) this.onRangeChange(this.track.trimStart, this.track.trimEnd);
      } else if (this.dragTarget === 'region') {
        canvas.style.cursor = 'grabbing';
        const deltaSec = this.xToTime(x) - this.xToTime(this.dragStartX);
        const windowDur = this.dragInitialRange.end - this.dragInitialRange.start;

        let newStart = this.dragInitialRange.start + deltaSec;
        let newEnd = this.dragInitialRange.end + deltaSec;

        if (newStart < 0) {
          newStart = 0;
          newEnd = windowDur;
        }
        if (newEnd > this.track.duration) {
          newEnd = this.track.duration;
          newStart = this.track.duration - windowDur;
        }

        this.track.trimStart = newStart;
        this.track.trimEnd = newEnd;
        this.draw();
        if (this.onRangeChange) this.onRangeChange(this.track.trimStart, this.track.trimEnd);
      }
    });

    window.addEventListener('mouseup', (e) => {
      if (this.isDragging) {
        const rect = canvas.getBoundingClientRect();
        const curX = e.clientX - rect.left;
        const dragDist = Math.abs(curX - this.dragStartX);

        if (this.dragTarget === 'seek' && dragDist < 8) {
          // User clicked inside active trimmed section: seek & play from this exact time
          const clickedTime = Math.max(this.track.trimStart, Math.min(this.track.trimEnd, this.dragStartTime));
          this.setPlayheadTime(clickedTime);
          if (this.onSeek) {
            this.onSeek(this.track, clickedTime);
          }
        } else if (this.dragTarget === 'outsideClick' && dragDist < 8) {
          // User clicked outside in the excluded part:
          // DO NOT reset trim bounds! Trim bounds stay strictly where user placed them.
          // Jump playhead to trimStart (active part start) and seek from there!
          this.setPlayheadTime(this.track.trimStart);
          if (this.onSeek) {
            this.onSeek(this.track, this.track.trimStart);
          }
        }

        if (this.dragTarget === 'start' || this.dragTarget === 'end' || this.dragTarget === 'region') {
          if (this.onRangeCommit) {
            this.onRangeCommit(this.track.trimStart, this.track.trimEnd);
          }
        }

        this.isDragging = false;
        this.dragTarget = null;
        this.draw();
      }
    });
  }
}

export class MergerUI {
  constructor(containerElement, audioEngine, options = {}) {
    this.container = containerElement;
    this.engine = audioEngine;
    this.tracks = []; // Array of { id, name, buffer, volume, duration, trimStart, trimEnd, fadeInSec, fadeOutSec, enabled }
    this.trackWaveforms = new Map();
    this.crossfadeMode = 'auto'; // 'auto' (fade-matching envelope) | 'manual' (fixed seconds)
    this.crossfadeCurve = 'equal-power'; // 'equal-power' | 'exponential' | 'linear'
    this.crossfadeSec = 2.0;
    this.onMerged = options.onMerged || null;

    // Continuous Sequential Preview Player State (with accurate parallel crossfade & pause memory)
    this.playback = {
      isPlaying: false,
      currentTrackIndex: null,
      activeSources: [], // Holds active { source, gain, trackIndex } during overlapping crossfades
      nextTrackTimer: null,
      trackStartTimeInCtx: 0,
      trackOffset: 0,
      animFrameId: null,
      pausedTrackIndex: null,
      pausedOffsetSec: null
    };

    this.initGlobalDropEvents();
    this.render();
    window.addEventListener('resize', () => {
      this.trackWaveforms.forEach(wf => wf.resize());
    });
  }

  initGlobalDropEvents() {
    ['dragenter', 'dragover'].forEach(name => {
      this.container.addEventListener(name, (e) => {
        e.preventDefault();
      });
    });

    this.container.addEventListener('drop', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
        await this.handleFiles(e.dataTransfer.files);
      }
    });
  }

  triggerAddTrack() {
    const input = this.container.querySelector('#mergerFileInput') || this.container.querySelector('#mergerFileInputEmpty');
    if (input) {
      input.value = '';
      input.click();
    }
  }

  setCrossfadeMode(mode) {
    this.crossfadeMode = mode === 'manual' ? 'manual' : 'auto';
    this.render();
  }

  setCrossfadeCurve(curve) {
    this.crossfadeCurve = curve;
    this.render();
  }

  toggleCrossfadeMode() {
    this.setCrossfadeMode(this.crossfadeMode === 'auto' ? 'manual' : 'auto');
  }

  /**
   * Calculates the exact crossfade overlap duration between two adjacent tracks
   */
  getCrossfadeDurationForPair(trackA, trackB) {
    if (!trackA || !trackB) return 0;
    const durA = Math.max(0.1, (trackA.trimEnd || trackA.duration) - (trackA.trimStart || 0));
    const durB = Math.max(0.1, (trackB.trimEnd || trackB.duration) - (trackB.trimStart || 0));
    const maxAllowed = Math.min(durA * 0.48, durB * 0.48);

    let overlap = 0;
    if (this.crossfadeMode === 'auto') {
      const curFadeOut = trackA.fadeOutSec || 0;
      const nextFadeIn = trackB.fadeInSec || 0;
      if (curFadeOut > 0 || nextFadeIn > 0) {
        overlap = Math.max(curFadeOut, nextFadeIn);
      } else {
        overlap = this.crossfadeSec > 0 ? this.crossfadeSec : 1.5;
      }
    } else {
      overlap = this.crossfadeSec;
    }

    return Math.max(0, Math.min(overlap, maxAllowed));
  }

  /**
   * Dynamically updates the visual transition bridges between adjacent cards in real-time
   */
  updateAllTransitionBridges() {
    const activeItems = this.tracks.map((t, idx) => ({ track: t, idx })).filter(item => item.track.enabled !== false);
    for (let i = 0; i < activeItems.length - 1; i++) {
      const cur = activeItems[i];
      const nxt = activeItems[i + 1];
      const badge = this.container.querySelector(`#connector_badge_${cur.track.id}`);
      if (badge) {
        const dur = this.getCrossfadeDurationForPair(cur.track, nxt.track);
        const modeLabel = this.crossfadeMode === 'auto' ? 'Otomatik Fade' : 'Manuel';
        badge.innerHTML = `<strong>${dur.toFixed(1)} sn</strong> geçiş <span style="opacity: 0.75; font-size: 0.72rem; margin-left: 4px;">(${modeLabel})</span>`;
      }
    }
    this.updateTotalDurationBadge();
  }

  /**
   * Calculates the exact total duration of the merged audio taking into account
   * trims and all crossfade overlaps between adjacent active tracks
   */
  calculateTotalMergedDuration() {
    const activeTracks = this.tracks.filter(t => t.enabled !== false);
    if (activeTracks.length === 0) return 0;
    if (activeTracks.length === 1) {
      const t = activeTracks[0];
      return Math.max(0, (t.trimEnd || t.duration) - (t.trimStart || 0));
    }

    let total = Math.max(0, (activeTracks[0].trimEnd || activeTracks[0].duration) - (activeTracks[0].trimStart || 0));
    for (let i = 0; i < activeTracks.length - 1; i++) {
      const cur = activeTracks[i];
      const next = activeTracks[i + 1];
      const nextDur = Math.max(0.1, (next.trimEnd || next.duration) - (next.trimStart || 0));
      const overlap = this.getCrossfadeDurationForPair(cur, next);
      total = Math.max(0, total - overlap + nextDur);
    }
    return total;
  }

  /**
   * Updates the total merged duration pill badges in the UI in real-time
   */
  updateTotalDurationBadge() {
    const totalSec = this.calculateTotalMergedDuration();
    const bottomBadge = this.container.querySelector('#mergerTotalDurationBadge');
    if (bottomBadge) {
      bottomBadge.innerHTML = `<span style="color: var(--text-dim); font-size: 0.78rem;">SÜRE:</span> <strong style="color: #fff; font-size: 0.95rem;">${this.formatTime(totalSec)}</strong> <span style="font-size: 0.75rem; opacity: 0.8; color: var(--accent-cyan);">(${totalSec.toFixed(1)} sn)</span>`;
    }
    const headerBadge = this.container.querySelector('#mergerHeaderTotalDuration');
    if (headerBadge) {
      headerBadge.innerHTML = `${this.formatTime(totalSec)}`;
    }
  }

  addTrackFromBuffer(buffer, name = 'Parça') {
    if (!buffer) return null;
    const trackName = (typeof name === 'string' && name.trim()) 
      ? name.trim() 
      : ((name && name.name) || 'Parça ' + (this.tracks.length + 1));

    const track = {
      id: 'track_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
      name: trackName,
      buffer: buffer,
      volume: 1.0,
      duration: buffer.duration,
      trimStart: 0,
      trimEnd: buffer.duration,
      fadeInSec: 0,
      fadeOutSec: 0,
      enabled: true,
      bpm: null
    };
    this.tracks.push(track);
    this.render();
    this.updateTotalDurationBadge();
    this.updateAllTransitionBridges();

    // Asynchronously detect BPM for BPM matching
    BPMKeyDetector.analyze(buffer).then(analysis => {
      track.bpm = analysis.bpm;
      const bpmBadge = this.container.querySelector(`#bpm_badge_${track.id}`);
      if (bpmBadge) {
        bpmBadge.textContent = `${analysis.bpm} BPM`;
        bpmBadge.style.display = 'inline-block';
      }
    }).catch(() => {});

    return track;
  }

  addTrack(fileOrBuffer, bufferOrName) {
    if (!fileOrBuffer) return null;
    // Check if called as addTrack(buffer, name)
    if (fileOrBuffer instanceof AudioBuffer || (fileOrBuffer.numberOfChannels && fileOrBuffer.sampleRate)) {
      return this.addTrackFromBuffer(fileOrBuffer, bufferOrName);
    }
    // Check if called as addTrack(file, buffer)
    const file = fileOrBuffer;
    const buffer = bufferOrName;
    if (!buffer) return null;
    const trackName = (file && file.name) || (typeof file === 'string' ? file : 'Parça ' + (this.tracks.length + 1));
    return this.addTrackFromBuffer(buffer, trackName);
  }

  removeTrack(id) {
    this.stopPlayback(true);
    this.trackWaveforms.delete(id);
    this.tracks = this.tracks.filter(t => t.id !== id);
    this.render();
  }

  moveTrack(index, direction) {
    this.stopPlayback(true);
    const newIndex = index + direction;
    if (newIndex < 0 || newIndex >= this.tracks.length) return;
    const temp = this.tracks[index];
    this.tracks[index] = this.tracks[newIndex];
    this.tracks[newIndex] = temp;
    this.render();
  }

  toggleTrackEnabled(id, enabled) {
    const track = this.tracks.find(t => t.id === id);
    if (track) {
      track.enabled = enabled;
      this.render();
    }
  }

  setVolume(id, vol) {
    const track = this.tracks.find(t => t.id === id);
    if (track) {
      track.volume = parseFloat(vol);
      const valElem = this.container.querySelector(`#vol_val_${id}`);
      if (valElem) valElem.textContent = Math.round(track.volume * 100) + '%';
      if (this.playback.isPlaying && this.playback.activeSources) {
        const trackIdx = this.tracks.findIndex(t => t.id === id);
        const active = this.playback.activeSources.find(s => s.trackIndex === trackIdx);
        if (active && active.gain) {
          active.gain.gain.setValueAtTime(track.volume, this.engine.ctx.currentTime);
        }
      }
    }
  }

  setCrossfade(sec) {
    const val = Math.max(0, Math.min(10, parseFloat(sec) || 0));
    this.crossfadeSec = val;
    ['#crossfadeSlider', '#headerCrossfadeSlider'].forEach(sel => {
      const slider = this.container.querySelector(sel);
      if (slider && parseFloat(slider.value) !== val) slider.value = val;
    });
    ['#crossfadeNumInput', '#headerCrossfadeNumInput'].forEach(sel => {
      const numInput = this.container.querySelector(sel);
      if (numInput && parseFloat(numInput.value) !== val) numInput.value = val.toFixed(1);
    });
    this.updateAllTransitionBridges();
  }

  setFadeIn(id, sec) {
    const track = this.tracks.find(t => t.id === id);
    if (track) {
      const val = Math.max(0, Math.min(10, parseFloat(sec) || 0));
      track.fadeInSec = val;
      const slider = this.container.querySelector(`#fadein_slider_${id}`);
      const numInput = this.container.querySelector(`#fadein_num_${id}`);
      if (slider && parseFloat(slider.value) !== val) slider.value = val;
      if (numInput && parseFloat(numInput.value) !== val) numInput.value = val.toFixed(1);

      const wf = this.trackWaveforms.get(id);
      if (wf) wf.draw();
      this.updateAllTransitionBridges();
    }
  }

  setFadeOut(id, sec) {
    const track = this.tracks.find(t => t.id === id);
    if (track) {
      const val = Math.max(0, Math.min(10, parseFloat(sec) || 0));
      track.fadeOutSec = val;
      const slider = this.container.querySelector(`#fadeout_slider_${id}`);
      const numInput = this.container.querySelector(`#fadeout_num_${id}`);
      if (slider && parseFloat(slider.value) !== val) slider.value = val;
      if (numInput && parseFloat(numInput.value) !== val) numInput.value = val.toFixed(1);

      const wf = this.trackWaveforms.get(id);
      if (wf) wf.draw();
      this.updateAllTransitionBridges();
    }
  }

  parseTimeInput(str, defaultVal) {
    if (typeof str === 'number') return str;
    if (!str) return defaultVal;
    str = String(str).trim();
    if (str.includes(':')) {
      const parts = str.split(':');
      if (parts.length === 2) {
        const mins = parseFloat(parts[0]) || 0;
        const secs = parseFloat(parts[1]) || 0;
        return mins * 60 + secs;
      }
    }
    const val = parseFloat(str);
    return isNaN(val) ? defaultVal : val;
  }

  setTrackTrimStart(id, valStr) {
    const track = this.tracks.find(t => t.id === id);
    if (!track) return;
    const parsed = this.parseTimeInput(valStr, track.trimStart);
    track.trimStart = Math.max(0, Math.min(track.trimEnd - 0.1, parsed));
    const wf = this.trackWaveforms.get(id);
    if (wf) wf.draw();
    this.updateTrackTrimBadge(track);
  }

  setTrackTrimEnd(id, valStr) {
    const track = this.tracks.find(t => t.id === id);
    if (!track) return;
    const parsed = this.parseTimeInput(valStr, track.trimEnd);
    track.trimEnd = Math.max(track.trimStart + 0.1, Math.min(track.duration, parsed));
    const wf = this.trackWaveforms.get(id);
    if (wf) wf.draw();
    this.updateTrackTrimBadge(track);
  }

  updateTrackTrimBadge(track) {
    const startInput = this.container.querySelector(`#trim_start_input_${track.id}`);
    const endInput = this.container.querySelector(`#trim_end_input_${track.id}`);
    const durLabel = this.container.querySelector(`#trim_dur_${track.id}`);
    if (startInput && document.activeElement !== startInput) {
      startInput.value = this.formatTime(track.trimStart);
    }
    if (endInput && document.activeElement !== endInput) {
      endInput.value = this.formatTime(track.trimEnd);
    }
    if (durLabel) {
      const dur = Math.max(0, track.trimEnd - track.trimStart);
      durLabel.textContent = `(${dur.toFixed(1)} sn)`;
    }
    this.updateAllTransitionBridges();
  }

  trimTrack(id) {
    const track = this.tracks.find(t => t.id === id);
    if (!track || !track.buffer) return;
    if (track.trimEnd <= track.trimStart) {
      if (window.flovaApp) window.flovaApp.showToast('Lütfen geçerli bir aralık seçin.', 'info');
      return;
    }
    this.stopPlayback(true);
    this.pushTrackHistory(track);

    this.engine.ensureContext();
    track.buffer = AudioProcessor.trimBuffer(this.engine.ctx, track.buffer, track.trimStart, track.trimEnd);
    track.duration = track.buffer.duration;
    track.trimStart = 0;
    track.trimEnd = track.duration;
    this.render();
    if (window.flovaApp) window.flovaApp.showToast(`"${track.name}" seçili alana göre kırpıldı!`, 'success');
  }

  cutOutTrackSelection(id) {
    const track = this.tracks.find(t => t.id === id);
    if (!track || !track.buffer) return;
    if (track.trimEnd <= track.trimStart || (track.trimStart === 0 && track.trimEnd >= track.duration - 0.05)) {
      if (window.flovaApp) window.flovaApp.showToast('Lütfen önce dalga formundan silmek istediğiniz alanı seçin/daraltın.', 'info');
      return;
    }
    this.stopPlayback(true);
    this.pushTrackHistory(track);

    this.engine.ensureContext();
    track.buffer = AudioProcessor.cutOutRange(this.engine.ctx, track.buffer, track.trimStart, track.trimEnd);
    track.duration = track.buffer.duration;
    track.trimStart = 0;
    track.trimEnd = track.duration;
    this.render();
    if (window.flovaApp) window.flovaApp.showToast(`"${track.name}" parçasından seçili alan silindi!`, 'success');
  }

  silenceTrackSelection(id) {
    const track = this.tracks.find(t => t.id === id);
    if (!track || !track.buffer) return;
    if (track.trimEnd <= track.trimStart) return;
    this.stopPlayback(true);
    this.pushTrackHistory(track);

    this.engine.ensureContext();
    track.buffer = AudioProcessor.silenceRange(this.engine.ctx, track.buffer, track.trimStart, track.trimEnd);
    const wf = this.trackWaveforms.get(id);
    if (wf) wf.draw();
    if (window.flovaApp) window.flovaApp.showToast(`"${track.name}" seçili alanı sessize alındı!`, 'success');
  }

  pushTrackHistory(track) {
    if (!track || !track.buffer) return;
    if (!track.history) track.history = [];
    track.history.push({
      buffer: track.buffer,
      duration: track.duration,
      trimStart: track.trimStart,
      trimEnd: track.trimEnd,
      volume: track.volume,
      fadeInSec: track.fadeInSec,
      fadeOutSec: track.fadeOutSec
    });
    if (track.history.length > 25) {
      track.history.shift();
    }
    this.lastEditedTrackId = track.id;
  }

  undoTrack(id) {
    const track = this.tracks.find(t => t.id === id);
    if (!track || !track.history || track.history.length === 0) {
      if (window.flovaApp) window.flovaApp.showToast('Geri alınacak işlem bulunamadı.', 'info');
      return;
    }
    this.stopPlayback(true);
    const prevState = track.history.pop();
    if (prevState.buffer) {
      track.buffer = prevState.buffer;
      track.duration = prevState.duration || prevState.buffer.duration;
      track.trimStart = prevState.trimStart !== undefined ? prevState.trimStart : 0;
      track.trimEnd = prevState.trimEnd !== undefined ? prevState.trimEnd : track.duration;
      if (prevState.volume !== undefined) track.volume = prevState.volume;
    } else {
      track.buffer = prevState;
      track.duration = track.buffer.duration;
      track.trimStart = 0;
      track.trimEnd = track.duration;
    }

    if (track.trimEnd <= track.trimStart || isNaN(track.trimEnd) || isNaN(track.trimStart)) {
      track.trimStart = 0;
      track.trimEnd = track.duration;
    }

    this.render();
    if (window.flovaApp) window.flovaApp.showToast(`"${track.name}" geri alındı!`, 'info');
  }

  undoLastAction() {
    let track = null;
    if (this.lastEditedTrackId) {
      track = this.tracks.find(t => t.id === this.lastEditedTrackId && t.history && t.history.length > 0);
    }
    if (!track) {
      track = this.tracks.slice().reverse().find(t => t.history && t.history.length > 0);
    }
    if (!track) {
      if (window.flovaApp) window.flovaApp.showToast('Birleştiricide geri alınacak işlem bulunamadı.', 'info');
      return;
    }
    this.undoTrack(track.id);
  }

  /* ====================================================================
     SEAMLESS CONTINUOUS SEQUENTIAL PLAYBACK & PARALLEL CROSSFADING
     ==================================================================== */
  playSequentialFromTrack(trackIndex, startOffsetSec = null, isCrossfadeTransition = false) {
    this.engine.ensureContext();
    const ctx = this.engine.ctx;

    const activeTracks = this.tracks.map((t, idx) => ({ track: t, origIndex: idx })).filter(item => item.track.enabled !== false);
    if (activeTracks.length === 0) return;

    let activePos = activeTracks.findIndex(item => item.origIndex === trackIndex);
    if (activePos === -1) activePos = 0;

    // If manual seek or user-initiated play, cancel pending timers and clean up active sources
    if (!isCrossfadeTransition) {
      if (this.playback.nextTrackTimer) {
        clearTimeout(this.playback.nextTrackTimer);
        this.playback.nextTrackTimer = null;
      }
      this.stopAllActiveSources();
    }

    const currentItem = activeTracks[activePos];
    const track = currentItem.track;
    const offset = startOffsetSec !== null ? startOffsetSec : track.trimStart;
    const playOffset = Math.max(track.trimStart, Math.min(track.trimEnd, offset));
    const remainingDur = Math.max(0.01, track.trimEnd - playOffset);

    // Calculate crossfade overlap duration with the next active track
    const nextItem = (activePos + 1 < activeTracks.length) ? activeTracks[activePos + 1] : null;
    let overlapSec = 0;
    if (nextItem) {
      overlapSec = this.getCrossfadeDurationForPair(track, nextItem.track);
      overlapSec = Math.min(overlapSec, remainingDur * 0.9);
    }

    const source = ctx.createBufferSource();
    source.buffer = track.buffer;

    const gain = ctx.createGain();
    const now = ctx.currentTime;
    const vol = track.volume !== undefined ? track.volume : 1.0;

    // Apply Fade In (or crossfade in if transitioning from previous track)
    const effectiveFadeIn = isCrossfadeTransition 
      ? Math.max(track.fadeInSec || 0, overlapSec)
      : (track.fadeInSec || 0);

    if (effectiveFadeIn > 0.01 && playOffset < track.trimStart + effectiveFadeIn) {
      const fadeProgress = (playOffset - track.trimStart) / effectiveFadeIn;
      const initialGain = Math.max(0.0001, vol * fadeProgress);
      const fadeRemaining = effectiveFadeIn * (1 - fadeProgress);
      gain.gain.setValueAtTime(initialGain, now);
      gain.gain.linearRampToValueAtTime(vol, now + fadeRemaining);
    } else {
      gain.gain.setValueAtTime(vol, now);
    }

    // Apply Fade Out (or crossfade out before transition to next track)
    const effectiveFadeOut = nextItem 
      ? Math.max(track.fadeOutSec || 0, overlapSec)
      : (track.fadeOutSec || 0);

    if (effectiveFadeOut > 0.01) {
      const fadeOutDuration = Math.min(remainingDur, effectiveFadeOut);
      const fadeOutStartTime = Math.max(now, now + remainingDur - fadeOutDuration);
      gain.gain.setValueAtTime(vol, fadeOutStartTime);
      gain.gain.linearRampToValueAtTime(0.0001, now + remainingDur);
    }

    source.connect(gain);
    gain.connect(ctx.destination);

    source.start(now, playOffset, remainingDur);

    const sourceRecord = {
      source,
      gain,
      trackIndex: currentItem.origIndex,
      trackId: track.id,
      track: track,
      startTimeInCtx: now,
      startOffsetSec: playOffset,
      trimEnd: track.trimEnd
    };
    this.playback.activeSources.push(sourceRecord);

    // When this track reaches the end of its duration, clean up its source and clear its playhead
    source.onended = () => {
      const sIdx = this.playback.activeSources.indexOf(sourceRecord);
      if (sIdx !== -1) {
        this.playback.activeSources.splice(sIdx, 1);
      }
      const wf = this.trackWaveforms.get(track.id);
      if (wf) {
        wf.setPlayheadTime(null);
      }
      try {
        source.disconnect();
        gain.disconnect();
      } catch (e) {}

      this.updateGlobalPlayButtons();

      // If no active sources remain and no next track is queued, playback is complete
      if (this.playback.activeSources.length === 0 && !this.playback.nextTrackTimer) {
        this.stopPlayback(true);
      }
    };

    // Schedule next track to start overlapping before this track finishes!
    if (nextItem && overlapSec > 0.01) {
      const timeUntilNext = Math.max(0.01, remainingDur - overlapSec);
      this.playback.nextTrackTimer = setTimeout(() => {
        if (!this.playback.isPlaying) return;
        this.playback.nextTrackTimer = null;
        this.playSequentialFromTrack(nextItem.origIndex, nextItem.track.trimStart, true /* isCrossfadeTransition */);
      }, timeUntilNext * 1000);
    } else if (nextItem) {
      // Hard cut transition at exact end
      this.playback.nextTrackTimer = setTimeout(() => {
        if (!this.playback.isPlaying) return;
        this.playback.nextTrackTimer = null;
        this.playSequentialFromTrack(nextItem.origIndex, nextItem.track.trimStart, false);
      }, remainingDur * 1000);
    }

    this.playback.isPlaying = true;
    this.playback.currentTrackIndex = currentItem.origIndex;
    this.playback.trackStartTimeInCtx = now;
    this.playback.trackOffset = playOffset;
    this.playback.pausedTrackIndex = currentItem.origIndex;
    this.playback.pausedOffsetSec = playOffset;

    if (!isCrossfadeTransition) {
      this.trackWaveforms.forEach(wf => wf.setPlayheadTime(null));
    }

    this.startPlayheadAnimation();
    this.updateGlobalPlayButtons();
  }

  startPlayheadAnimation() {
    if (this.playback.animFrameId) cancelAnimationFrame(this.playback.animFrameId);

    const tick = () => {
      if (!this.playback.isPlaying) return;

      const nowCtx = this.engine.ctx ? this.engine.ctx.currentTime : 0;

      // Animate playheads for ALL currently playing active sources (both tracks during crossfade!)
      if (this.playback.activeSources && this.playback.activeSources.length > 0) {
        this.playback.activeSources.forEach(record => {
          const elapsed = nowCtx - record.startTimeInCtx;
          const curTime = record.startOffsetSec + elapsed;
          const wf = this.trackWaveforms.get(record.trackId);
          if (wf) {
            if (curTime <= record.trimEnd + 0.05) {
              wf.setPlayheadTime(Math.min(record.trimEnd, curTime));
            } else {
              wf.setPlayheadTime(null);
            }
          }
        });

        // Track pause offset of the latest active track
        const latestRecord = this.playback.activeSources[this.playback.activeSources.length - 1];
        if (latestRecord) {
          this.playback.pausedTrackIndex = latestRecord.trackIndex;
          this.playback.pausedOffsetSec = latestRecord.startOffsetSec + (nowCtx - latestRecord.startTimeInCtx);
        }
      }

      this.playback.animFrameId = requestAnimationFrame(tick);
    };
    this.playback.animFrameId = requestAnimationFrame(tick);
  }

  stopAllActiveSources() {
    if (this.playback.activeSources && this.playback.activeSources.length > 0) {
      this.playback.activeSources.forEach(record => {
        try {
          record.source.stop();
          record.source.disconnect();
          record.gain.disconnect();
        } catch (e) {}
      });
      this.playback.activeSources = [];
    }
  }

  /**
   * Stops playback. If resetPosition is false, preserves paused position so Space resumes right there!
   */
  stopPlayback(resetPosition = false) {
    if (this.playback.isPlaying && !resetPosition) {
      // Record exact pause time from latest active track
      if (this.playback.activeSources && this.playback.activeSources.length > 0) {
        const latest = this.playback.activeSources[this.playback.activeSources.length - 1];
        const elapsed = this.engine.ctx ? (this.engine.ctx.currentTime - latest.startTimeInCtx) : 0;
        this.playback.pausedOffsetSec = latest.startOffsetSec + elapsed;
        this.playback.pausedTrackIndex = latest.trackIndex;
      } else if (this.playback.currentTrackIndex !== null) {
        const elapsed = this.engine.ctx ? (this.engine.ctx.currentTime - this.playback.trackStartTimeInCtx) : 0;
        this.playback.pausedOffsetSec = this.playback.trackOffset + elapsed;
        this.playback.pausedTrackIndex = this.playback.currentTrackIndex;
      }
    }

    if (this.playback.nextTrackTimer) {
      clearTimeout(this.playback.nextTrackTimer);
      this.playback.nextTrackTimer = null;
    }

    this.stopAllActiveSources();
    this.playback.isPlaying = false;
    this.playback.currentTrackIndex = null;

    if (this.playback.animFrameId) {
      cancelAnimationFrame(this.playback.animFrameId);
      this.playback.animFrameId = null;
    }

    if (resetPosition) {
      this.playback.pausedTrackIndex = null;
      this.playback.pausedOffsetSec = null;
      this.trackWaveforms.forEach(wf => wf.setPlayheadTime(null));
    }

    this.updateGlobalPlayButtons();
  }

  togglePlayAll() {
    if (this.playback.isPlaying) {
      this.stopPlayback(false); // Pause and keep position!
    } else {
      // Resume from paused position if exists!
      if (this.playback.pausedTrackIndex !== null && this.playback.pausedOffsetSec !== null) {
        this.playSequentialFromTrack(this.playback.pausedTrackIndex, this.playback.pausedOffsetSec);
      } else {
        const firstActive = this.tracks.findIndex(t => t.enabled !== false);
        if (firstActive !== -1) {
          this.playSequentialFromTrack(firstActive);
        }
      }
    }
  }

  updateGlobalPlayButtons() {
    const playAllBtn = this.container.querySelector('#playAllBtn');
    if (playAllBtn) {
      if (this.playback.isPlaying) {
        playAllBtn.innerHTML = '⏸ Duraklat (Space)';
        playAllBtn.classList.add('btn-primary');
        playAllBtn.classList.remove('btn-emerald');
      } else {
        playAllBtn.innerHTML = '▶ Önizle (Space)';
        playAllBtn.classList.add('btn-emerald');
        playAllBtn.classList.remove('btn-primary');
      }
    }

    this.tracks.forEach((track, idx) => {
      const btn = this.container.querySelector(`#preview_btn_${track.id}`);
      if (btn) {
        const isTrackActive = this.playback.isPlaying && (
          this.playback.currentTrackIndex === idx ||
          (this.playback.activeSources && this.playback.activeSources.some(s => s.trackIndex === idx))
        );
        if (isTrackActive) {
          btn.innerHTML = '⏸ Duraklat';
          btn.classList.add('btn-primary');
          btn.classList.remove('btn-secondary');
        } else {
          btn.innerHTML = '▶ Çal';
          btn.classList.add('btn-secondary');
          btn.classList.remove('btn-primary');
        }
      }
    });
  }

  async performMergeOnly() {
    this.stopPlayback(false);
    const activeTracks = this.tracks.filter(t => t.enabled !== false);

    if (activeTracks.length === 0) {
      if (window.flovaApp) window.flovaApp.showToast('Lütfen birleştirmek için en az 1 aktif parça seçin.', 'error');
      return null;
    }

    this.engine.ensureContext();
    const ctx = this.engine.ctx;

    // Prepare each track with custom cut/trimmed buffer
    // Native gain envelopes and crossfades are handled inside AudioProcessor.mergeTracks
    const processedTracks = activeTracks.map(track => {
      const isCustomTrim = track.trimStart > 0.05 || track.trimEnd < track.duration - 0.05;
      let buf = isCustomTrim 
        ? AudioProcessor.trimBuffer(ctx, track.buffer, track.trimStart, track.trimEnd)
        : track.buffer;

      return {
        buffer: buf,
        volume: track.volume !== undefined ? track.volume : 1.0,
        fadeInSec: track.fadeInSec || 0,
        fadeOutSec: track.fadeOutSec || 0
      };
    });

    return await AudioProcessor.mergeTracks(processedTracks, {
      mode: this.crossfadeMode || 'auto',
      crossfadeSec: this.crossfadeSec !== undefined ? this.crossfadeSec : 2.0,
      curve: this.crossfadeCurve || 'equal-power'
    });
  }

  async performMerge() {
    const mergedBuffer = await this.performMergeOnly();
    if (!mergedBuffer) return null;
    const activeTracks = this.tracks.filter(t => t.enabled !== false);
    if (this.onMerged) {
      this.onMerged(mergedBuffer, `Birleştirilmiş_${activeTracks.length}_Parça.wav`);
    }
    return mergedBuffer;
  }

  async exportMergedDirectly() {
    const mergedBuffer = await this.performMergeOnly();
    if (!mergedBuffer) return;
    const activeTracks = this.tracks.filter(t => t.enabled !== false);
    this.engine.setBuffer(mergedBuffer, true, `Birlestirilmis_${activeTracks.length}_Parca.wav`);
    if (window.flovaApp && window.flovaApp.exportModal) {
      window.flovaApp.exportModal.open(0, mergedBuffer.duration);
    }
  }

  render() {
    const activeCount = this.tracks.filter(t => t.enabled !== false).length;
    const totalMergedSec = this.calculateTotalMergedDuration();

    this.container.innerHTML = `
      <div class="merger-section">
        
        <!-- Header Bar with Integrated Transition Controls -->
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; flex-wrap: wrap; gap: 12px; background: rgba(15, 23, 42, 0.7); border: 1px solid rgba(56, 189, 248, 0.25); border-radius: 10px; padding: 10px 16px;">
          <div style="display: flex; align-items: center; gap: 14px; flex-wrap: wrap;">
            <div style="display: flex; align-items: center; gap: 10px;">
              <h3 style="font-size: 1.05rem; font-weight: 700; margin: 0; color: #fff;">Parça Listesi (${this.tracks.length} Parça, ${activeCount} Aktif)</h3>
              ${this.tracks.length > 0 ? `
                <span id="mergerHeaderTotalDuration" style="font-family: var(--font-mono); font-size: 0.78rem; font-weight: 700; color: #38bdf8; background: rgba(56, 189, 248, 0.12); border: 1px solid rgba(56, 189, 248, 0.3); padding: 2px 8px; border-radius: 6px;" title="Tüm aktif parçaların geçişler sonrası net toplam süresi">
                  ${this.formatTime(totalMergedSec)}
                </span>
              ` : ''}
            </div>

            ${this.tracks.length > 1 ? `
              <!-- Top-Bar Crossfade Mode Switcher (Always visible without scrolling!) -->
              <div style="display: inline-flex; align-items: center; gap: 8px; background: rgba(0, 0, 0, 0.45); padding: 4px 10px; border-radius: 8px; border: 1px solid rgba(56, 189, 248, 0.3);">
                <span style="font-size: 0.78rem; font-weight: 700; color: #38bdf8; text-transform: uppercase; letter-spacing: 0.04em;">Geçiş Modu:</span>
                <div style="display: flex; align-items: center; gap: 4px; background: rgba(255,255,255,0.06); padding: 2px 4px; border-radius: 20px;">
                  <button type="button" class="merger-mode-pill ${this.crossfadeMode === 'auto' ? 'active' : ''}" 
                    style="padding: 3px 10px; font-size: 0.76rem;"
                    onclick="window.flovaMerger.setCrossfadeMode('auto')"
                    title="Parçaların Fade Out ve Fade In süreleri kadar şarkılar kesintisiz ve tam örtüşerek iç içe geçer.">
                    Otomatik Fade
                  </button>
                  <button type="button" class="merger-mode-pill ${this.crossfadeMode === 'manual' ? 'active' : ''}" 
                    style="padding: 3px 10px; font-size: 0.76rem;"
                    onclick="window.flovaMerger.setCrossfadeMode('manual')"
                    title="Belirleyeceğiniz saniye kadar şarkılar iç içe geçer.">
                    Manuel Süre
                  </button>
                </div>

                ${this.crossfadeMode === 'manual' ? `
                  <div style="display: flex; align-items: center; gap: 6px;">
                    <input type="range" id="headerCrossfadeSlider" min="0" max="10" step="0.1" value="${this.crossfadeSec}" 
                      class="studio-slider" style="width: 80px; height: 4px;"
                      oninput="window.flovaMerger.setCrossfade(this.value)" />
                    <input type="number" id="headerCrossfadeNumInput" min="0" max="10" step="0.1" value="${this.crossfadeSec.toFixed(1)}" 
                      style="width: 52px; background: rgba(0,0,0,0.5); border: 1px solid var(--border-glass); color: var(--accent-cyan); font-family: var(--font-mono); font-weight: 700; font-size: 0.8rem; padding: 2px 4px; border-radius: 4px; outline: none;"
                      oninput="window.flovaMerger.setCrossfade(this.value)" />
                    <span style="font-family: var(--font-mono); color: var(--accent-cyan); font-weight: 700; font-size: 0.76rem;">sn</span>
                  </div>
                ` : ''}
              </div>
            ` : ''}
          </div>

          <div style="display: flex; gap: 8px; align-items: center;">
            <button id="playAllBtn" class="btn btn-emerald btn-sm" onclick="window.flovaMerger.togglePlayAll()">
              ▶ Önizle (Space)
            </button>
            <button type="button" class="btn btn-secondary btn-sm" onclick="window.flovaMerger.triggerAddTrack()">
              + Parça Ekle
            </button>
            <input type="file" id="mergerFileInput" accept="audio/*" multiple style="display: none;" />
          </div>
        </div>

        ${this.tracks.length === 0 ? `
          <div id="mergerDropZone" class="drop-zone" style="margin-top: 10px; cursor: pointer;" onclick="window.flovaMerger.triggerAddTrack()">
            <div class="drop-zone-icon" style="color: var(--accent-primary);">
              <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M12 5v14M5 12h14"></path>
              </svg>
            </div>
            <h2 class="drop-zone-title">Ses Dosyası Bırakın veya Seçin</h2>
            <p class="drop-zone-sub">Birden fazla MP3, WAV, FLAC, M4A sürükleyip bırakabilirsiniz</p>
            <button type="button" class="btn btn-primary btn-sm" onclick="event.stopPropagation(); window.flovaMerger.triggerAddTrack();">
              + Parça Ekle
            </button>
            <input type="file" id="mergerFileInputEmpty" accept="audio/*" multiple style="display: none;" />
          </div>
        ` : `
          <div class="merger-tracks-list">
            ${this.tracks.map((track, idx) => {
              const isLast = idx === this.tracks.length - 1;
              const nextTrack = !isLast ? this.tracks[idx + 1] : null;
              const overlapSec = nextTrack ? this.getCrossfadeDurationForPair(track, nextTrack) : 0;
              const modeLabel = this.crossfadeMode === 'auto' ? 'Otomatik Fade' : 'Manuel Fade';

              return `
              <div class="merger-track-card" data-id="${track.id}" style="${!track.enabled ? 'opacity: 0.45; filter: grayscale(0.8);' : ''}">
                
                <!-- Top Row Info & Controls -->
                <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; width: 100%; flex-wrap: wrap; gap: 8px;">
                  <div style="display: flex; align-items: center; gap: 10px;">
                    <input type="checkbox" ${track.enabled ? 'checked' : ''} 
                      title="Birleştirmeye dahil et"
                      style="accent-color: var(--accent-primary); width: 17px; height: 17px; cursor: pointer;"
                      onchange="window.flovaMerger.toggleTrackEnabled('${track.id}', this.checked)" />
                    <div class="track-order-badge">${idx + 1}</div>
                    <div class="merger-track-title">${track.name}</div>
                    <div class="merger-track-meta">${this.formatTime(track.duration)}</div>
                    <span id="bpm_badge_${track.id}" style="${track.bpm ? '' : 'display: none;'} font-size: 0.72rem; padding: 1px 6px; background: rgba(56, 189, 248, 0.12); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.25); border-radius: 4px; font-weight: 600;">
                      ${track.bpm ? `${track.bpm} BPM` : ''}
                    </span>
                  </div>

                  <div style="display: flex; align-items: center; gap: 8px;">
                    <button id="preview_btn_${track.id}" class="btn btn-secondary btn-sm" style="padding: 4px 10px; font-size: 0.78rem; display: inline-flex; align-items: center; gap: 4px;" onclick="window.flovaMerger.playSequentialFromTrack(${idx}, ${track.trimStart})">
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg> Çal
                    </button>
                    <button class="btn btn-secondary btn-sm" ${idx === 0 ? 'disabled' : ''} onclick="window.flovaMerger.moveTrack(${idx}, -1)" title="Yukarı">▲</button>
                    <button class="btn btn-secondary btn-sm" ${idx === this.tracks.length - 1 ? 'disabled' : ''} onclick="window.flovaMerger.moveTrack(${idx}, 1)" title="Aşağı">▼</button>
                    <button class="btn btn-danger btn-sm" onclick="window.flovaMerger.removeTrack('${track.id}')" title="Kaldır" style="padding: 4px 8px; display: inline-flex; align-items: center;">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                    </button>
                  </div>
                </div>

                <!-- Per-Track Dedicated Selection & Action Bar -->
                <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; background: rgba(0,0,0,0.35); padding: 6px 12px; border-radius: 6px; margin-bottom: 8px; border: 1px solid rgba(255,255,255,0.05);">
                  <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">
                    <span style="font-size: 0.76rem; font-weight: 700; color: var(--accent-cyan); text-transform: uppercase; letter-spacing: 0.5px;">
                      Aralık:
                    </span>
                    
                    <div style="display: flex; align-items: center; gap: 4px;">
                      <span style="font-size: 0.75rem; color: var(--text-muted);">Baş:</span>
                      <input type="text" id="trim_start_input_${track.id}" value="${this.formatTime(track.trimStart)}"
                        title="Başlangıç süresi"
                        style="width: 78px; background: rgba(0,0,0,0.5); border: 1px solid var(--border-glass); color: #fff; font-family: var(--font-mono); font-weight: 600; font-size: 0.78rem; padding: 2px 6px; border-radius: 4px; text-align: center;"
                        onchange="window.flovaMerger.setTrackTrimStart('${track.id}', this.value)" />
                    </div>

                    <div style="display: flex; align-items: center; gap: 4px;">
                      <span style="font-size: 0.75rem; color: var(--text-muted);">Bit:</span>
                      <input type="text" id="trim_end_input_${track.id}" value="${this.formatTime(track.trimEnd)}"
                        title="Bitiş süresi"
                        style="width: 78px; background: rgba(0,0,0,0.5); border: 1px solid var(--border-glass); color: #fff; font-family: var(--font-mono); font-weight: 600; font-size: 0.78rem; padding: 2px 6px; border-radius: 4px; text-align: center;"
                        onchange="window.flovaMerger.setTrackTrimEnd('${track.id}', this.value)" />
                    </div>

                    <span id="trim_dur_${track.id}" style="color: var(--accent-cyan); font-family: var(--font-mono); font-size: 0.78rem; font-weight: 700;">
                      (${ (track.trimEnd - track.trimStart).toFixed(1) } sn)
                    </span>
                  </div>

                  <!-- Per-Track Action Buttons -->
                  <div style="display: flex; align-items: center; gap: 6px;">
                    <button class="btn btn-primary btn-sm" style="padding: 3px 8px; font-size: 0.75rem;" 
                      onclick="window.flovaMerger.trimTrack('${track.id}')" title="Seçili alanı sakla, dışındakileri sil">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="6" cy="6" r="3"></circle><circle cx="6" cy="18" r="3"></circle><line x1="20" y1="4" x2="8.12" y2="15.88"></line><line x1="14.47" y1="14.48" x2="20" y2="20"></line><line x1="8.12" y1="8.12" x2="12" y2="12"></line></svg>
                      Kırp
                    </button>
                    <button class="btn btn-secondary btn-sm" style="padding: 3px 8px; font-size: 0.75rem;" 
                      onclick="window.flovaMerger.cutOutTrackSelection('${track.id}')" title="Seçili alanı parçadan çıkarıp sil">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                      Sil
                    </button>
                    <button class="btn btn-secondary btn-sm" style="padding: 3px 8px; font-size: 0.75rem;" 
                      onclick="window.flovaMerger.silenceTrackSelection('${track.id}')" title="Seçili alanı sessizleştir">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="1" y1="1" x2="23" y2="23"></line><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"></path></svg>
                      Sessiz
                    </button>
                    ${track.history && track.history.length > 0 ? `
                      <button class="btn btn-secondary btn-sm" style="padding: 3px 8px; font-size: 0.75rem;" 
                        onclick="window.flovaMerger.undoTrack('${track.id}')" title="Geri Al">
                        ↩ Geri Al
                      </button>
                    ` : ''}
                  </div>
                </div>

                <!-- Full-Width Waveform with Draggable Handles -->
                <div style="width: 100%; margin-bottom: 8px;">
                  <div class="merger-waveform-wrapper" style="position: relative; height: 130px; background: #05070d; border: 1px solid rgba(255,255,255,0.07); border-radius: 8px; overflow: hidden;">
                    <canvas id="waveform_canvas_${track.id}" style="width: 100%; height: 100%; display: block;"></canvas>
                  </div>
                  <!-- Track Zoom Scrollbar -->
                  <div id="track_scrollbar_${track.id}" class="merger-track-scrollbar-wrap" style="display: none;">
                    <div class="merger-track-scrollbar-track" title="Gezinmek için kaydırın veya tıklayın">
                      <div class="merger-track-scrollbar-thumb"></div>
                    </div>
                    <span class="merger-zoom-badge">1.0x</span>
                  </div>
                </div>

                <!-- Bottom Controls: Volume, Fade In & Fade Out (Slider + Typed Inputs) -->
                <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 16px; font-size: 0.78rem; color: var(--text-muted); border-top: 1px solid rgba(255,255,255,0.05); padding-top: 8px;">
                  
                  <!-- Volume -->
                  <div style="display: flex; align-items: center; gap: 6px;">
                    <span>Ses:</span>
                    <input type="range" min="0" max="2" step="0.05" value="${track.volume}" 
                      class="studio-slider" style="width: 80px; height: 4px;"
                      oninput="window.flovaMerger.setVolume('${track.id}', this.value)" />
                    <span id="vol_val_${track.id}" style="font-family: var(--font-mono); color: var(--accent-cyan); font-weight: 600;">${Math.round(track.volume * 100)}%</span>
                  </div>

                  <!-- Per-Track Fade In (Slider + Typable Number Box) -->
                  <div style="display: flex; align-items: center; gap: 6px;">
                    <span style="color: #10b981; font-weight: 600;">Fade In:</span>
                    <input type="range" id="fadein_slider_${track.id}" min="0" max="10.0" step="0.1" value="${track.fadeInSec}" 
                      class="studio-slider" style="width: 75px; height: 4px;"
                      oninput="window.flovaMerger.setFadeIn('${track.id}', this.value)" />
                    <input type="number" id="fadein_num_${track.id}" min="0" max="10.0" step="0.1" value="${track.fadeInSec.toFixed(1)}" 
                      style="width: 55px; background: rgba(0,0,0,0.5); border: 1px solid var(--border-glass); color: #10b981; font-family: var(--font-mono); font-weight: 600; font-size: 0.78rem; padding: 2px 4px; border-radius: 4px; outline: none;"
                      oninput="window.flovaMerger.setFadeIn('${track.id}', this.value)" />
                    <span style="color: var(--text-dim); font-size: 0.72rem;">sn</span>
                  </div>

                  <!-- Per-Track Fade Out (Slider + Typable Number Box) -->
                  <div style="display: flex; align-items: center; gap: 6px;">
                    <span style="color: #f43f5e; font-weight: 600;">Fade Out:</span>
                    <input type="range" id="fadeout_slider_${track.id}" min="0" max="10.0" step="0.1" value="${track.fadeOutSec}" 
                      class="studio-slider" style="width: 75px; height: 4px;"
                      oninput="window.flovaMerger.setFadeOut('${track.id}', this.value)" />
                    <input type="number" id="fadeout_num_${track.id}" min="0" max="10.0" step="0.1" value="${track.fadeOutSec.toFixed(1)}" 
                      style="width: 55px; background: rgba(0,0,0,0.5); border: 1px solid var(--border-glass); color: #f43f5e; font-family: var(--font-mono); font-weight: 600; font-size: 0.78rem; padding: 2px 4px; border-radius: 4px; outline: none;"
                      oninput="window.flovaMerger.setFadeOut('${track.id}', this.value)" />
                    <span style="color: var(--text-dim); font-size: 0.72rem;">sn</span>
                  </div>

                </div>

              </div>

              ${!isLast ? `
                <div class="merger-transition-connector" id="connector_${track.id}" style="margin: 8px 0;">
                  <div class="merger-transition-line"></div>
                  <div class="merger-transition-badge" id="connector_badge_${track.id}" 
                    title="Geçiş Ayarları: Tıklayarak Otomatik ve Manuel mod arasında geçiş yapabilirsiniz"
                    onclick="window.flovaMerger.toggleCrossfadeMode()"
                    style="cursor: pointer;">
                    <strong>${overlapSec.toFixed(1)} sn</strong> geçiş
                    <span style="opacity: 0.85; font-size: 0.72rem; margin-left: 4px; color: var(--accent-cyan);">(${modeLabel})</span>
                  </div>
                  <div class="merger-transition-line"></div>
                </div>
              ` : ''}
              `;
            }).join('')}

            <!-- Prominent Add Next Track Drop Zone Card -->
            <div id="mergerAddNextCard" class="merger-add-track-card" onclick="window.flovaMerger.triggerAddTrack()">
              <div style="margin-bottom: 3px; color: var(--accent-cyan);">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
              </div>
              <div style="font-weight: 700; color: #fff; font-size: 0.92rem;">Yeni Parça Ekle (${this.tracks.length + 1}. Şarkıyı Seçin veya Sürükleyin)</div>
              <div style="font-size: 0.76rem; color: var(--text-muted); margin-top: 2px;">Tıklayarak dosya seçebilir veya şarkıyı doğrudan bu alana sürükleyip bırakabilirsiniz</div>
            </div>
          </div>

          <!-- Merger Settings Bar: Crossfade Mode & Duration Controls & Action Buttons -->
          <div style="background: rgba(10, 14, 24, 0.75); border: 1px solid var(--border-glass); border-radius: var(--radius-md); padding: 14px 18px; margin-top: 12px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 14px;">
            <div style="display: flex; align-items: center; gap: 14px; flex-wrap: wrap;">
              
              <!-- Mode Selection Switcher Pills -->
              <div style="display: flex; align-items: center; gap: 6px; background: rgba(0,0,0,0.3); padding: 3px 5px; border-radius: 24px; border: 1px solid var(--border-glass);">
                <button type="button" class="merger-mode-pill ${this.crossfadeMode === 'auto' ? 'active' : ''}" 
                  onclick="window.flovaMerger.setCrossfadeMode('auto')"
                  title="Parçaların Fade Out ve Fade In sürelerini otomatik algılayıp şarkıları tam o süre boyunca kesintisiz iç içe geçirir.">
                  Otomatik Fade Eşleme
                </button>
                <button type="button" class="merger-mode-pill ${this.crossfadeMode === 'manual' ? 'active' : ''}" 
                  onclick="window.flovaMerger.setCrossfadeMode('manual')"
                  title="Tüm parçalar arasında elle belirlediğiniz süre kadar çapraz geçiş (iç içe geçme) uygular.">
                  Manuel Süre
                </button>
              </div>

              <!-- Crossfade Curve Selector -->
              <div style="display: flex; align-items: center; gap: 6px;">
                <span style="font-size: 0.78rem; font-weight: 600; color: var(--text-dim);">Eğri:</span>
                <select class="theme-select-pill" onchange="window.flovaMerger.setCrossfadeCurve(this.value)" title="Crossfade Geçiş Eğrisi">
                  <option value="equal-power" ${this.crossfadeCurve === 'equal-power' ? 'selected' : ''}>Eşit Güç (DJ Miks)</option>
                  <option value="exponential" ${this.crossfadeCurve === 'exponential' ? 'selected' : ''}>S-Eğrisi (Yumuşak)</option>
                  <option value="linear" ${this.crossfadeCurve === 'linear' ? 'selected' : ''}>Doğrusal (Linear)</option>
                </select>
              </div>

              <!-- Controls for Manual Duration or Info for Auto -->
              <div style="display: flex; align-items: center; gap: 8px;">
                ${this.crossfadeMode === 'manual' ? `
                  <span style="font-size: 0.85rem; font-weight: 600; color: var(--accent-cyan);">Geçiş Süresi:</span>
                  <input type="range" id="crossfadeSlider" min="0" max="10" step="0.1" value="${this.crossfadeSec}" 
                    class="studio-slider" style="width: 120px;"
                    oninput="window.flovaMerger.setCrossfade(this.value)" />
                  <input type="number" id="crossfadeNumInput" min="0" max="10" step="0.1" value="${this.crossfadeSec.toFixed(1)}" 
                    style="width: 60px; background: rgba(0,0,0,0.5); border: 1px solid var(--border-glass); color: var(--accent-cyan); font-family: var(--font-mono); font-weight: 700; font-size: 0.85rem; padding: 3px 6px; border-radius: 4px; outline: none;"
                    oninput="window.flovaMerger.setCrossfade(this.value)" />
                  <span style="font-family: var(--font-mono); color: var(--accent-cyan); font-weight: 700; font-size: 0.85rem;">sn</span>
                ` : ''}
              </div>
            </div>

            <div style="display: flex; align-items: center; gap: 12px; flex-wrap: wrap;">
              <!-- Bottom Total Duration Badge -->
              <div id="mergerTotalDurationBadge" 
                style="display: inline-flex; align-items: center; gap: 6px; background: rgba(56, 189, 248, 0.1); border: 1.5px solid rgba(56, 189, 248, 0.4); padding: 7px 16px; border-radius: 8px; font-family: var(--font-mono); font-size: 0.85rem; color: #38bdf8; box-shadow: 0 0 14px rgba(56, 189, 248, 0.18);"
                title="Geçişler ve kırpmalar dahil birleştirilmiş dosyanın net toplam süresi">
                <span style="font-size: 0.75rem; color: var(--text-dim); text-transform: uppercase;">Toplam:</span> <strong style="color: #fff; font-size: 0.96rem;">${this.formatTime(totalMergedSec)}</strong>
                <span style="font-size: 0.75rem; opacity: 0.85; color: var(--accent-cyan);">(${totalMergedSec.toFixed(1)} sn)</span>
              </div>

              <button class="btn btn-secondary" onclick="window.flovaMerger.exportMergedDirectly()" title="Doğrudan dışa aktar">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path><polyline points="17 21 17 13 7 13 7 21"></polyline><polyline points="7 3 7 8 15 8"></polyline></svg>
                Dışa Aktar
              </button>
              <button class="btn btn-emerald" onclick="window.flovaMerger.performMerge()">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>
                Birleştir (${activeCount} Parça)
              </button>
            </div>
          </div>
        `}
      </div>
    `;

    // Initialize Waveform Canvas instances with Click-to-Play listener
    this.trackWaveforms.clear();
    this.tracks.forEach((track, idx) => {
      const canvas = this.container.querySelector(`#waveform_canvas_${track.id}`);
      const scrollbarWrap = this.container.querySelector(`#track_scrollbar_${track.id}`);
      if (canvas) {
        const wf = new MergerTrackWaveform(
          canvas,
          track,
          (start, end) => {
            this.updateTrackTrimBadge(track);
          },
          (seekTrack, seekTime) => {
            this.playSequentialFromTrack(idx, seekTime);
          },
          scrollbarWrap,
          (start, end) => {
            this.pushTrackHistory(track);
          }
        );
        this.trackWaveforms.set(track.id, wf);
      }
    });

    // File inputs
    const fileInputs = [
      this.container.querySelector('#mergerFileInput'),
      this.container.querySelector('#mergerFileInputEmpty')
    ];

    fileInputs.forEach(input => {
      if (input) {
        input.addEventListener('change', async (e) => {
          if (e.target.files && e.target.files.length) {
            await this.handleFiles(e.target.files);
          }
          input.value = '';
        });
      }
    });

    const mergerDropZone = this.container.querySelector('#mergerDropZone');
    if (mergerDropZone) {
      ['dragenter', 'dragover'].forEach(name => {
        mergerDropZone.addEventListener(name, (e) => {
          e.preventDefault();
          e.stopPropagation();
          mergerDropZone.classList.add('dragover', 'drop-zone-drag');
        });
      });

      ['dragleave', 'drop'].forEach(name => {
        mergerDropZone.addEventListener(name, (e) => {
          e.preventDefault();
          e.stopPropagation();
          mergerDropZone.classList.remove('dragover', 'drop-zone-drag');
        });
      });

      mergerDropZone.addEventListener('drop', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        mergerDropZone.classList.remove('dragover', 'drop-zone-drag');
        if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
          await this.handleFiles(e.dataTransfer.files);
        }
      });
    }

    const addNextCard = this.container.querySelector('#mergerAddNextCard');
    if (addNextCard) {
      ['dragenter', 'dragover'].forEach(name => {
        addNextCard.addEventListener(name, (e) => {
          e.preventDefault();
          e.stopPropagation();
          addNextCard.classList.add('dragover');
        });
      });

      ['dragleave', 'drop'].forEach(name => {
        addNextCard.addEventListener(name, (e) => {
          e.preventDefault();
          e.stopPropagation();
          addNextCard.classList.remove('dragover');
        });
      });

      addNextCard.addEventListener('drop', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        addNextCard.classList.remove('dragover');
        if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
          await this.handleFiles(e.dataTransfer.files);
        }
      });
    }
  }

  async handleFiles(files) {
    if (!files || !files.length) return;
    const fileList = Array.from(files);
    for (const file of fileList) {
      if (file.type.startsWith('audio/') || /\.(mp3|wav|ogg|flac|m4a|aac|wma|aiff)$/i.test(file.name)) {
        try {
          if (window.flovaApp) {
            window.flovaApp.showToast(`"${file.name}" ekleniyor...`, 'info');
          }
          const arrayBuffer = await file.arrayBuffer();
          this.engine.ensureContext();
          const buffer = await this.engine.ctx.decodeAudioData(arrayBuffer.slice(0));
          this.addTrack(file, buffer);
          if (window.flovaApp) {
            window.flovaApp.showToast(`"${file.name}" başarıyla eklendi!`, 'success');
          }
        } catch (err) {
          console.error('Dosya yüklenemedi:', err);
          if (window.flovaApp) {
            window.flovaApp.showToast(`"${file.name}" yüklenemedi: ${err.message || err}`, 'error');
          }
        }
      }
    }
  }

  formatTime(sec) {
    const mins = Math.floor(sec / 60);
    const secs = Math.floor(sec % 60);
    const ms = Math.floor((sec % 1) * 10);
    return `${mins}:${secs.toString().padStart(2, '0')}.${ms}`;
  }
}
