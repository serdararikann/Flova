/* ====================================================================
   FLOVA AUDIO STUDIO - AUDIO MERGER UI CONTROLLER
   - Typed Number Inputs & Sliders for Crossfade, Fade In & Fade Out
   - Resume Playback Exactly Where Paused on Space Key
   - Persistent Track List & Continuous Session Editing After Merge
   - Real-time Waveform Canvas with Draggable Handles & Fade Envelopes
   ==================================================================== */

import { AudioProcessor } from '../audio/audio-processor.js';

/**
 * Interactive waveform canvas for an individual track in the Merger
 */
class MergerTrackWaveform {
  constructor(canvasElement, track, onRangeChange, onSeek) {
    this.canvas = canvasElement;
    this.ctx = this.canvas.getContext('2d');
    this.track = track;
    this.onRangeChange = onRangeChange;
    this.onSeek = onSeek;

    this.isDragging = false;
    this.dragTarget = null; // 'start' | 'end' | 'region'
    this.dragStartX = 0;
    this.dragInitialRange = { start: track.trimStart, end: track.trimEnd };
    this.currentPlayTime = null;

    this.resize();
    this.initEvents();
  }

  resize() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.width = rect.width || 600;
    this.height = 130;

    this.canvas.width = Math.floor(this.width * dpr);
    this.canvas.height = Math.floor(this.height * dpr);

    this.ctx.resetTransform ? this.ctx.resetTransform() : this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.scale(dpr, dpr);
    this.draw();
  }

  setPlayheadTime(time) {
    this.currentPlayTime = time;
    this.draw();
  }

  timeToX(time) {
    if (!this.track.duration || !this.width) return 0;
    return (time / this.track.duration) * this.width;
  }

  xToTime(x) {
    if (!this.width || !this.track.duration) return 0;
    return Math.max(0, Math.min(this.track.duration, (x / this.width) * this.track.duration));
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

    // 1. Draw Waveform Peaks
    const barWidth = 2;
    const gap = 1;
    const step = Math.max(1, Math.floor(totalSamples / (w * 1.5)));

    for (let x = 0; x < w; x += (barWidth + gap)) {
      const sampleStart = Math.floor((x / w) * totalSamples);
      const sampleEnd = Math.min(totalSamples, sampleStart + step);

      let min = 1.0;
      let max = -1.0;
      const stride = Math.max(1, Math.floor((sampleEnd - sampleStart) / 30));

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
      const isInside = currentTime >= track.trimStart && currentTime <= track.trimEnd;

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

    // 2. Dimmed Overlays outside selection
    const startX = this.timeToX(track.trimStart);
    const endX = this.timeToX(track.trimEnd);

    ctx.fillStyle = 'rgba(0, 0, 0, 0.65)';
    ctx.fillRect(0, 0, startX, h);
    ctx.fillRect(endX, 0, w - endX, h);

    // 3. Selection Region Highlight
    ctx.fillStyle = 'rgba(99, 102, 241, 0.12)';
    ctx.fillRect(startX, 0, endX - startX, h);

    // 4. Draw Fade In & Fade Out Visual Curves on Waveform
    if (track.fadeInSec > 0) {
      const fadeStartX = startX;
      const fadeEndX = Math.min(endX, this.timeToX(track.trimStart + track.fadeInSec));
      ctx.fillStyle = 'rgba(16, 185, 129, 0.18)';
      ctx.beginPath();
      ctx.moveTo(fadeStartX, h);
      ctx.lineTo(fadeEndX, 0);
      ctx.lineTo(fadeStartX, 0);
      ctx.closePath();
      ctx.fill();

      ctx.strokeStyle = '#10b981';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(fadeStartX, h);
      ctx.lineTo(fadeEndX, 0);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    if (track.fadeOutSec > 0) {
      const fadeOutStartX = Math.max(startX, this.timeToX(track.trimEnd - track.fadeOutSec));
      const fadeOutEndX = endX;
      ctx.fillStyle = 'rgba(244, 63, 94, 0.18)';
      ctx.beginPath();
      ctx.moveTo(fadeOutStartX, 0);
      ctx.lineTo(fadeOutEndX, h);
      ctx.lineTo(fadeOutEndX, 0);
      ctx.closePath();
      ctx.fill();

      ctx.strokeStyle = '#f43f5e';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(fadeOutStartX, 0);
      ctx.lineTo(fadeOutEndX, h);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Top and bottom selection borders
    ctx.strokeStyle = '#818cf8';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(startX, 0);
    ctx.lineTo(endX, 0);
    ctx.moveTo(startX, h);
    ctx.lineTo(endX, h);
    ctx.stroke();

    // 5. Draggable Handles (Left & Right)
    this.drawHandle(ctx, startX, h, true);
    this.drawHandle(ctx, endX, h, false);

    // 6. Draw Live Moving Playhead Cursor (if playing)
    if (this.currentPlayTime !== null && this.currentPlayTime >= 0) {
      const playX = this.timeToX(this.currentPlayTime);
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

    canvas.addEventListener('mousedown', (e) => {
      const x = getX(e);
      const time = this.xToTime(x);

      const startX = this.timeToX(this.track.trimStart);
      const endX = this.timeToX(this.track.trimEnd);
      const threshold = 16;

      if (Math.abs(x - startX) <= threshold) {
        this.isDragging = true;
        this.dragTarget = 'start';
      } else if (Math.abs(x - endX) <= threshold) {
        this.isDragging = true;
        this.dragTarget = 'end';
      } else if (x > startX + threshold && x < endX - threshold && e.shiftKey) {
        this.isDragging = true;
        this.dragTarget = 'region';
        this.dragStartX = x;
        this.dragInitialRange = { start: this.track.trimStart, end: this.track.trimEnd };
      } else {
        // Natural click & drag selection across the waveform (like Kesici view!)
        this.isDragging = true;
        this.dragTarget = 'newSelection';
        this.dragStartX = x;
        this.dragStartTime = time;
        this.track.trimStart = time;
        this.track.trimEnd = time;
        this.draw();
      }
    });

    window.addEventListener('mousemove', (e) => {
      if (!this.isDragging) {
        const rect = canvas.getBoundingClientRect();
        if (e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom) {
          const x = e.clientX - rect.left;
          const startX = this.timeToX(this.track.trimStart);
          const endX = this.timeToX(this.track.trimEnd);
          const threshold = 14;

          if (Math.abs(x - startX) <= threshold || Math.abs(x - endX) <= threshold) {
            canvas.style.cursor = 'ew-resize';
          } else {
            canvas.style.cursor = 'crosshair';
          }
        }
        return;
      }

      const x = getX(e);
      const time = this.xToTime(x);

      if (this.dragTarget === 'newSelection') {
        const start = Math.min(this.dragStartTime, time);
        const end = Math.max(this.dragStartTime, time);
        this.track.trimStart = Math.max(0, start);
        this.track.trimEnd = Math.min(this.track.duration, end);
        this.draw();
        if (this.onRangeChange) this.onRangeChange(this.track.trimStart, this.track.trimEnd);
      } else if (this.dragTarget === 'start') {
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
        if (this.dragTarget === 'newSelection') {
          const rect = canvas.getBoundingClientRect();
          const curX = e.clientX - rect.left;
          const dragDist = Math.abs(curX - this.dragStartX);

          if (dragDist < 6 || (this.track.trimEnd - this.track.trimStart < 0.05)) {
            // If it was a simple single-click without dragging:
            // Keep full track or seek & play from this point
            this.track.trimStart = 0;
            this.track.trimEnd = this.track.duration;
            this.draw();
            if (this.onRangeChange) this.onRangeChange(this.track.trimStart, this.track.trimEnd);
            if (this.onSeek) {
              this.onSeek(this.track, this.dragStartTime);
            }
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
    this.crossfadeSec = 1.0;
    this.onMerged = options.onMerged || null;

    // Continuous Sequential Preview Player State (with accurate pause/resume memory)
    this.playback = {
      isPlaying: false,
      currentTrackIndex: null,
      sourceNode: null,
      gainNode: null,
      trackStartTimeInCtx: 0,
      trackOffset: 0,
      animFrameId: null,
      pausedTrackIndex: null,
      pausedOffsetSec: null
    };

    this.render();
    window.addEventListener('resize', () => {
      this.trackWaveforms.forEach(wf => wf.resize());
    });
  }

  addTrack(file, buffer) {
    const track = {
      id: 'track_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
      name: file.name || 'Parça ' + (this.tracks.length + 1),
      buffer: buffer,
      volume: 1.0,
      duration: buffer.duration,
      trimStart: 0,
      trimEnd: buffer.duration,
      fadeInSec: 0,
      fadeOutSec: 0,
      enabled: true
    };
    this.tracks.push(track);
    this.render();
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
      if (this.playback.isPlaying && this.playback.gainNode && this.tracks[this.playback.currentTrackIndex]?.id === id) {
        this.playback.gainNode.gain.setValueAtTime(track.volume, this.engine.ctx.currentTime);
      }
    }
  }

  setCrossfade(sec) {
    const val = Math.max(0, Math.min(10, parseFloat(sec) || 0));
    this.crossfadeSec = val;
    const slider = this.container.querySelector('#crossfadeSlider');
    const numInput = this.container.querySelector('#crossfadeNumInput');
    if (slider && parseFloat(slider.value) !== val) slider.value = val;
    if (numInput && parseFloat(numInput.value) !== val) numInput.value = val.toFixed(1);
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
  }

  trimTrack(id) {
    const track = this.tracks.find(t => t.id === id);
    if (!track || !track.buffer) return;
    if (track.trimEnd <= track.trimStart) {
      if (window.flovaApp) window.flovaApp.showToast('Lütfen geçerli bir aralık seçin.', 'info');
      return;
    }
    this.stopPlayback(true);
    if (!track.history) track.history = [];
    track.history.push(track.buffer);

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
    if (!track.history) track.history = [];
    track.history.push(track.buffer);

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
    if (!track.history) track.history = [];
    track.history.push(track.buffer);

    this.engine.ensureContext();
    track.buffer = AudioProcessor.silenceRange(this.engine.ctx, track.buffer, track.trimStart, track.trimEnd);
    const wf = this.trackWaveforms.get(id);
    if (wf) wf.draw();
    if (window.flovaApp) window.flovaApp.showToast(`"${track.name}" seçili alanı sessize alındı!`, 'success');
  }

  undoTrack(id) {
    const track = this.tracks.find(t => t.id === id);
    if (!track || !track.history || track.history.length === 0) {
      if (window.flovaApp) window.flovaApp.showToast('Geri alınacak işlem bulunamadı.', 'info');
      return;
    }
    this.stopPlayback(true);
    track.buffer = track.history.pop();
    track.duration = track.buffer.duration;
    track.trimStart = 0;
    track.trimEnd = track.duration;
    this.render();
    if (window.flovaApp) window.flovaApp.showToast(`"${track.name}" geri alındı!`, 'info');
  }

  /* ====================================================================
     SEAMLESS CONTINUOUS SEQUENTIAL PLAYBACK & PAUSE/RESUME
     ==================================================================== */
  playSequentialFromTrack(trackIndex, startOffsetSec = null) {
    this.engine.ensureContext();
    const ctx = this.engine.ctx;

    const activeTracks = this.tracks.map((t, idx) => ({ track: t, origIndex: idx })).filter(item => item.track.enabled !== false);
    if (activeTracks.length === 0) return;

    let activePos = activeTracks.findIndex(item => item.origIndex === trackIndex);
    if (activePos === -1) activePos = 0;

    this.stopCurrentSourceOnly();

    const currentItem = activeTracks[activePos];
    const track = currentItem.track;
    const offset = startOffsetSec !== null ? startOffsetSec : track.trimStart;
    const playOffset = Math.max(track.trimStart, Math.min(track.trimEnd, offset));
    const remainingDur = Math.max(0.01, track.trimEnd - playOffset);

    const source = ctx.createBufferSource();
    source.buffer = track.buffer;

    const gain = ctx.createGain();
    const now = ctx.currentTime;

    gain.gain.setValueAtTime(track.volume, now);

    // Apply Fade In if starting in fade in range
    if (track.fadeInSec > 0 && playOffset < track.trimStart + track.fadeInSec) {
      const fadeProgress = (playOffset - track.trimStart) / track.fadeInSec;
      const initialGain = track.volume * fadeProgress;
      const fadeRemaining = track.fadeInSec * (1 - fadeProgress);
      gain.gain.setValueAtTime(initialGain, now);
      gain.gain.linearRampToValueAtTime(track.volume, now + fadeRemaining);
    }

    // Apply Fade Out before trimEnd
    if (track.fadeOutSec > 0) {
      const fadeOutStartTime = now + Math.max(0, remainingDur - track.fadeOutSec);
      gain.gain.setValueAtTime(track.volume, fadeOutStartTime);
      gain.gain.linearRampToValueAtTime(0.001, now + remainingDur);
    }

    source.connect(gain);
    gain.connect(ctx.destination);

    source.start(now, playOffset, remainingDur);

    this.playback.isPlaying = true;
    this.playback.currentTrackIndex = currentItem.origIndex;
    this.playback.sourceNode = source;
    this.playback.gainNode = gain;
    this.playback.trackStartTimeInCtx = now;
    this.playback.trackOffset = playOffset;
    this.playback.pausedTrackIndex = currentItem.origIndex;
    this.playback.pausedOffsetSec = playOffset;

    this.trackWaveforms.forEach(wf => wf.setPlayheadTime(null));

    // When this track reaches trimEnd, transition to NEXT track!
    source.onended = () => {
      if (!this.playback.isPlaying || this.playback.currentTrackIndex !== currentItem.origIndex) return;

      const nextActivePos = activePos + 1;
      if (nextActivePos < activeTracks.length) {
        const nextItem = activeTracks[nextActivePos];
        this.playSequentialFromTrack(nextItem.origIndex, nextItem.track.trimStart);
      } else {
        // Complete playback finished, reset pause memory
        this.stopPlayback(true);
      }
    };

    this.startPlayheadAnimation();
    this.updateGlobalPlayButtons();
  }

  startPlayheadAnimation() {
    if (this.playback.animFrameId) cancelAnimationFrame(this.playback.animFrameId);

    const tick = () => {
      if (!this.playback.isPlaying) return;

      const currentTrack = this.tracks[this.playback.currentTrackIndex];
      if (currentTrack) {
        const elapsed = this.engine.ctx.currentTime - this.playback.trackStartTimeInCtx;
        const curTime = this.playback.trackOffset + elapsed;
        this.playback.pausedOffsetSec = curTime; // Real-time pause memory

        const wf = this.trackWaveforms.get(currentTrack.id);
        if (wf) {
          wf.setPlayheadTime(curTime);
        }
      }

      this.playback.animFrameId = requestAnimationFrame(tick);
    };
    this.playback.animFrameId = requestAnimationFrame(tick);
  }

  stopCurrentSourceOnly() {
    if (this.playback.sourceNode) {
      try {
        this.playback.sourceNode.stop();
        this.playback.sourceNode.disconnect();
      } catch (e) {}
      this.playback.sourceNode = null;
    }
  }

  /**
   * Stops playback. If resetPosition is false, preserves paused position so Space resumes right there!
   */
  stopPlayback(resetPosition = false) {
    if (this.playback.isPlaying && !resetPosition) {
      // Record exact pause time
      if (this.playback.currentTrackIndex !== null) {
        const elapsed = this.engine.ctx ? (this.engine.ctx.currentTime - this.playback.trackStartTimeInCtx) : 0;
        this.playback.pausedOffsetSec = this.playback.trackOffset + elapsed;
        this.playback.pausedTrackIndex = this.playback.currentTrackIndex;
      }
    }

    this.stopCurrentSourceOnly();
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
        if (this.playback.isPlaying && this.playback.currentTrackIndex === idx) {
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

    // Prepare each track with custom cut/trimmed buffer AND individual Fade In / Fade Out
    const processedTracks = activeTracks.map(track => {
      const isCustomTrim = track.trimStart > 0.05 || track.trimEnd < track.duration - 0.05;
      let buf = isCustomTrim 
        ? AudioProcessor.trimBuffer(ctx, track.buffer, track.trimStart, track.trimEnd)
        : track.buffer;

      if (track.fadeInSec > 0 || track.fadeOutSec > 0) {
        buf = AudioProcessor.applyFade(ctx, buf, track.fadeInSec, track.fadeOutSec);
      }

      return {
        buffer: buf,
        volume: track.volume
      };
    });

    return await AudioProcessor.mergeTracks(processedTracks, this.crossfadeSec);
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

    this.container.innerHTML = `
      <div class="merger-section">
        
        <!-- Header Bar -->
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; flex-wrap: wrap; gap: 10px;">
          <div>
            <h3 style="font-size: 1.1rem; font-weight: 700;">Parça Listesi (${this.tracks.length} Parça, ${activeCount} Aktif)</h3>
          </div>
          <div style="display: flex; gap: 8px; align-items: center;">
            <button id="playAllBtn" class="btn btn-emerald btn-sm" onclick="window.flovaMerger.togglePlayAll()">
              ▶ Önizle (Space)
            </button>
            <label class="btn btn-secondary btn-sm" style="cursor: pointer;">
              + Parça Ekle
              <input type="file" id="mergerFileInput" accept="audio/*" multiple style="display: none;" />
            </label>
          </div>
        </div>

        ${this.tracks.length === 0 ? `
          <div style="padding: 50px 20px; text-align: center; border: 2px dashed rgba(255,255,255,0.08); border-radius: var(--radius-md); color: var(--text-dim);">
            <p style="margin-bottom: 12px; font-weight: 600; font-size: 1.05rem;">Henüz parça eklenmedi</p>
            <label class="btn btn-primary btn-sm" style="cursor: pointer;">
              Dosya Seç veya Bırak
              <input type="file" id="mergerFileInputEmpty" accept="audio/*" multiple style="display: none;" />
            </label>
          </div>
        ` : `
          <div class="merger-tracks-list">
            ${this.tracks.map((track, idx) => `
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
                  </div>

                  <div style="display: flex; align-items: center; gap: 8px;">
                    <button id="preview_btn_${track.id}" class="btn btn-secondary btn-sm" style="padding: 4px 10px; font-size: 0.78rem;" onclick="window.flovaMerger.playSequentialFromTrack(${idx}, ${track.trimStart})">
                      ▶ Çal
                    </button>
                    <button class="btn btn-secondary btn-sm" ${idx === 0 ? 'disabled' : ''} onclick="window.flovaMerger.moveTrack(${idx}, -1)" title="Yukarı">▲</button>
                    <button class="btn btn-secondary btn-sm" ${idx === this.tracks.length - 1 ? 'disabled' : ''} onclick="window.flovaMerger.moveTrack(${idx}, 1)" title="Aşağı">▼</button>
                    <button class="btn btn-danger btn-sm" onclick="window.flovaMerger.removeTrack('${track.id}')" title="Kaldır">✕</button>
                  </div>
                </div>

                <!-- Per-Track Dedicated Selection & Action Bar -->
                <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; background: rgba(0,0,0,0.35); padding: 6px 12px; border-radius: 6px; margin-bottom: 8px; border: 1px solid rgba(255,255,255,0.05);">
                  <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">
                    <span style="font-size: 0.78rem; font-weight: 700; color: var(--accent-cyan); text-transform: uppercase; letter-spacing: 0.5px;">
                      📍 Aralık:
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
                      ✂️ Kırp
                    </button>
                    <button class="btn btn-secondary btn-sm" style="padding: 3px 8px; font-size: 0.75rem;" 
                      onclick="window.flovaMerger.cutOutTrackSelection('${track.id}')" title="Seçili alanı parçadan çıkarıp sil">
                      🗑️ Sil
                    </button>
                    <button class="btn btn-secondary btn-sm" style="padding: 3px 8px; font-size: 0.75rem;" 
                      onclick="window.flovaMerger.silenceTrackSelection('${track.id}')" title="Seçili alanı sessizleştir">
                      🔇 Sessiz
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
                    <span style="color: #10b981; font-weight: 600;">📈 Fade In:</span>
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
                    <span style="color: #f43f5e; font-weight: 600;">📉 Fade Out:</span>
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
            `).join('')}
          </div>

          <!-- Merger Settings Bar: Crossfade Slider + Typable Input & Action Buttons -->
          <div style="background: rgba(10, 14, 24, 0.75); border: 1px solid var(--border-glass); border-radius: var(--radius-md); padding: 14px 18px; margin-top: 12px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 14px;">
            <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">
              <span style="font-size: 0.88rem; font-weight: 600;">Crossfade:</span>
              <input type="range" id="crossfadeSlider" min="0" max="10" step="0.1" value="${this.crossfadeSec}" 
                class="studio-slider" style="width: 130px;"
                oninput="window.flovaMerger.setCrossfade(this.value)" />
              <input type="number" id="crossfadeNumInput" min="0" max="10" step="0.1" value="${this.crossfadeSec.toFixed(1)}" 
                style="width: 60px; background: rgba(0,0,0,0.5); border: 1px solid var(--border-glass); color: var(--accent-cyan); font-family: var(--font-mono); font-weight: 700; font-size: 0.85rem; padding: 3px 6px; border-radius: 4px; outline: none;"
                oninput="window.flovaMerger.setCrossfade(this.value)" />
              <span style="font-family: var(--font-mono); color: var(--accent-cyan); font-weight: 700; font-size: 0.85rem;">sn</span>
            </div>

            <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">
              <button class="btn btn-secondary" onclick="window.flovaMerger.exportMergedDirectly()" title="Doğrudan dışa aktar">
                💾 Dışa Aktar
              </button>
              <button class="btn btn-emerald" onclick="window.flovaMerger.performMerge()">
                🔗 Birleştir (${activeCount} Parça)
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
      if (canvas) {
        const wf = new MergerTrackWaveform(
          canvas,
          track,
          (start, end) => {
            this.updateTrackTrimBadge(track);
          },
          (seekTrack, seekTime) => {
            this.playSequentialFromTrack(idx, seekTime);
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
          const files = Array.from(e.target.files);
          for (const file of files) {
            try {
              const arrayBuffer = await file.arrayBuffer();
              this.engine.ensureContext();
              const buffer = await this.engine.ctx.decodeAudioData(arrayBuffer);
              this.addTrack(file, buffer);
            } catch (err) {
              console.error('Dosya yüklenemedi:', err);
            }
          }
        });
      }
    });
  }

  formatTime(sec) {
    const mins = Math.floor(sec / 60);
    const secs = Math.floor(sec % 60);
    const ms = Math.floor((sec % 1) * 10);
    return `${mins}:${secs.toString().padStart(2, '0')}.${ms}`;
  }
}
