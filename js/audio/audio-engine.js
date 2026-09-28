/* ====================================================================
   FLOVA AUDIO STUDIO - MAIN AUDIO ENGINE
   Master AudioContext, Playback, Analyser, Undo/Redo & State
   ==================================================================== */

import { AudioEffectsRack } from './audio-effects.js';
import { AudioProcessor } from './audio-processor.js';
import { DemoAudioGenerator } from './demo-generator.js';

export class AudioEngine {
  constructor() {
    // Lazy initialize AudioContext on user interaction
    this.ctx = null;
    this.effectsRack = null;
    this.analyser = null;

    // Active Audio Source & Buffer
    this.currentBuffer = null;
    this.currentFileName = 'İsimsiz Parça';
    this.sourceNode = null;

    // Playback State
    this.isPlaying = false;
    this.startTime = 0;
    this.pauseOffset = 0;
    this.isLooping = false;
    this.loopStart = 0;
    this.loopEnd = 0;
    this.useLoopRegion = false;

    // Undo / Redo History Stack
    this.historyStack = [];
    this.historyIndex = -1;
    this.maxHistory = 15;

    // Event Callbacks
    this.onTimeUpdate = null;
    this.onPlayStateChange = null;
    this.onBufferChange = null;
    this.onEnded = null;

    this.animationFrameId = null;
  }

  ensureContext() {
    if (!this.ctx) {
      const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AudioCtxClass();

      // Master Analyser Node
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyser.smoothingTimeConstant = 0.85;

      // Effects Rack
      this.effectsRack = new AudioEffectsRack(this.ctx);

      // Connect FX to Analyser, Analyser to Speaker Output
      this.effectsRack.outputNode.connect(this.analyser);
      this.analyser.connect(this.ctx.destination);
    }

    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  async loadFile(file) {
    this.ensureContext();
    const arrayBuffer = await file.arrayBuffer();
    const decodedBuffer = await this.ctx.decodeAudioData(arrayBuffer);
    
    this.currentFileName = file.name || 'Ses Dosyası';
    this.historyStack = [];
    this.historyIndex = -1;
    this.setBuffer(decodedBuffer, true);
    return decodedBuffer;
  }

  async loadDemoTrack() {
    this.ensureContext();
    this.currentFileName = 'Flova Synthwave Demo.wav';
    this.historyStack = [];
    this.historyIndex = -1;
    const demoBuffer = await DemoAudioGenerator.generateDemoTrack(this.ctx);
    this.setBuffer(demoBuffer, true);
    return demoBuffer;
  }

  setBuffer(audioBuffer, pushHistory = true, selectionRange = null) {
    this.stop();
    this.currentBuffer = audioBuffer;
    this.pauseOffset = 0;
    this.loopStart = selectionRange ? selectionRange.start : 0;
    this.loopEnd = selectionRange ? selectionRange.end : (audioBuffer ? audioBuffer.duration : 0);

    if (pushHistory && audioBuffer) {
      // Remove any redo steps ahead
      this.historyStack = this.historyStack.slice(0, this.historyIndex + 1);
      this.historyStack.push({
        buffer: audioBuffer,
        name: this.currentFileName,
        selectionStart: this.loopStart,
        selectionEnd: this.loopEnd
      });
      if (this.historyStack.length > this.maxHistory) {
        this.historyStack.shift();
      }
      this.historyIndex = this.historyStack.length - 1;
    }

    if (this.onBufferChange) {
      this.onBufferChange(this.currentBuffer, { start: this.loopStart, end: this.loopEnd });
    }
  }

  pushSelectionState(start, end) {
    if (!this.currentBuffer) return;
    const lastState = this.historyStack[this.historyIndex];
    if (lastState && Math.abs(lastState.selectionStart - start) < 0.05 && Math.abs(lastState.selectionEnd - end) < 0.05) {
      return;
    }
    this.historyStack = this.historyStack.slice(0, this.historyIndex + 1);
    this.historyStack.push({
      buffer: this.currentBuffer,
      name: this.currentFileName,
      selectionStart: start,
      selectionEnd: end
    });
    if (this.historyStack.length > this.maxHistory) {
      this.historyStack.shift();
    }
    this.historyIndex = this.historyStack.length - 1;
  }

  undo() {
    if (this.historyIndex > 0) {
      this.historyIndex--;
      const state = this.historyStack[this.historyIndex];
      this.currentFileName = state.name;
      this.setBuffer(state.buffer, false, { start: state.selectionStart, end: state.selectionEnd });
      return true;
    }
    return false;
  }

  redo() {
    if (this.historyIndex < this.historyStack.length - 1) {
      this.historyIndex++;
      const state = this.historyStack[this.historyIndex];
      this.currentFileName = state.name;
      this.setBuffer(state.buffer, false, { start: state.selectionStart, end: state.selectionEnd });
      return true;
    }
    return false;
  }

  canUndo() {
    return this.historyIndex > 0;
  }

  canRedo() {
    return this.historyIndex < this.historyStack.length - 1;
  }

  play(offset = null) {
    if (!this.currentBuffer) return;
    this.ensureContext();

    if (this.isPlaying) {
      this.stopSource();
    }

    const hasCustomBounds = this.loopEnd > this.loopStart && (this.loopStart > 0.05 || this.loopEnd < this.currentBuffer.duration - 0.05);

    let startPos = offset !== null ? offset : this.pauseOffset;
    if (hasCustomBounds) {
      if (startPos < this.loopStart || startPos >= this.loopEnd - 0.05) {
        startPos = this.loopStart;
      }
    }
    this.pauseOffset = Math.max(0, Math.min(this.currentBuffer.duration, startPos));

    this.sourceNode = this.ctx.createBufferSource();
    this.sourceNode.buffer = this.currentBuffer;
    this.sourceNode.playbackRate.value = this.effectsRack.params.playbackRate;

    if (this.isLooping || (this.useLoopRegion && this.isLooping)) {
      this.sourceNode.loop = true;
      this.sourceNode.loopStart = hasCustomBounds ? this.loopStart : 0;
      this.sourceNode.loopEnd = hasCustomBounds ? this.loopEnd : this.currentBuffer.duration;
    }

    this.sourceNode.connect(this.effectsRack.inputNode);

    this.startTime = this.ctx.currentTime - (this.pauseOffset / this.effectsRack.params.playbackRate);

    if (hasCustomBounds && !this.isLooping) {
      const playDuration = Math.max(0, (this.loopEnd - this.pauseOffset) / this.effectsRack.params.playbackRate);
      this.sourceNode.start(0, this.pauseOffset, playDuration);
    } else {
      this.sourceNode.start(0, this.pauseOffset);
    }
    this.isPlaying = true;

    this.sourceNode.onended = () => {
      if (this.isPlaying) {
        this.pauseOffset = hasCustomBounds ? this.loopStart : 0;
        this.isPlaying = false;
        if (this.onEnded) this.onEnded();
        if (this.onPlayStateChange) this.onPlayStateChange(false);
        this.stopTimer();
        if (this.onTimeUpdate) this.onTimeUpdate(this.pauseOffset);
      }
    };

    if (this.onPlayStateChange) {
      this.onPlayStateChange(true);
    }

    this.startTimer();
  }

  pause() {
    if (!this.isPlaying) return;
    this.pauseOffset = this.getCurrentTime();
    this.stopSource();
    this.isPlaying = false;
    this.stopTimer();

    if (this.onPlayStateChange) {
      this.onPlayStateChange(false);
    }
  }

  stop() {
    this.stopSource();
    this.isPlaying = false;
    const hasCustomBounds = this.loopEnd > this.loopStart && (this.loopStart > 0.05 || this.loopEnd < (this.currentBuffer ? this.currentBuffer.duration - 0.05 : 0));
    this.pauseOffset = hasCustomBounds ? this.loopStart : 0;
    this.stopTimer();

    if (this.onPlayStateChange) {
      this.onPlayStateChange(false);
    }
    if (this.onTimeUpdate) {
      this.onTimeUpdate(this.pauseOffset);
    }
  }

  seek(timeInSeconds) {
    if (!this.currentBuffer) return;
    const hasCustomBounds = this.loopEnd > this.loopStart && (this.loopStart > 0.05 || this.loopEnd < this.currentBuffer.duration - 0.05);
    let targetTime = timeInSeconds;
    if (hasCustomBounds) {
      if (targetTime < this.loopStart || targetTime > this.loopEnd) {
        targetTime = this.loopStart;
      }
    }
    const clampedTime = Math.max(0, Math.min(this.currentBuffer.duration, targetTime));
    const wasPlaying = this.isPlaying;

    if (wasPlaying) {
      this.stopSource();
    }
    this.pauseOffset = clampedTime;

    if (wasPlaying) {
      this.play(clampedTime);
    } else {
      if (this.onTimeUpdate) {
        this.onTimeUpdate(clampedTime);
      }
    }
  }

  getCurrentTime() {
    if (!this.isPlaying || !this.ctx) {
      return this.pauseOffset;
    }
    const elapsed = (this.ctx.currentTime - this.startTime) * this.effectsRack.params.playbackRate;
    return Math.min(this.currentBuffer ? this.currentBuffer.duration : 0, elapsed);
  }

  setPlaybackRate(rate) {
    const clamped = Math.max(0.25, Math.min(2.0, rate));
    this.effectsRack.params.playbackRate = clamped;
    if (this.sourceNode && this.isPlaying) {
      this.sourceNode.playbackRate.setValueAtTime(clamped, this.ctx.currentTime);
      // Recalculate start time to avoid jumping
      const currentPos = this.pauseOffset;
      this.startTime = this.ctx.currentTime - (currentPos / clamped);
    }
  }

  stopSource() {
    if (this.sourceNode) {
      try {
        this.sourceNode.stop();
        this.sourceNode.disconnect();
      } catch (e) {
        // Ignore already stopped errors
      }
      this.sourceNode = null;
    }
  }

  startTimer() {
    this.stopTimer();
    const tick = () => {
      if (this.isPlaying && this.onTimeUpdate) {
        this.onTimeUpdate(this.getCurrentTime());
      }
      this.animationFrameId = requestAnimationFrame(tick);
    };
    this.animationFrameId = requestAnimationFrame(tick);
  }

  stopTimer() {
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
  }

  // Audio Operations Handlers
  trimCurrent(startTime, endTime) {
    if (!this.currentBuffer) return;
    const newBuffer = AudioProcessor.trimBuffer(this.ctx, this.currentBuffer, startTime, endTime);
    this.setBuffer(newBuffer, true);
  }

  cutOutCurrent(startTime, endTime) {
    if (!this.currentBuffer) return;
    const newBuffer = AudioProcessor.cutOutRange(this.ctx, this.currentBuffer, startTime, endTime);
    this.setBuffer(newBuffer, true);
  }

  silenceCurrent(startTime, endTime) {
    if (!this.currentBuffer) return;
    const newBuffer = AudioProcessor.silenceRange(this.ctx, this.currentBuffer, startTime, endTime);
    this.setBuffer(newBuffer, true);
  }

  reverseCurrent() {
    if (!this.currentBuffer) return;
    const newBuffer = AudioProcessor.reverseBuffer(this.ctx, this.currentBuffer);
    this.setBuffer(newBuffer, true);
  }

  applyFadeToCurrent(fadeInSec, fadeOutSec, customRange = null) {
    if (!this.currentBuffer) return;
    let newBuffer;
    if (customRange && customRange.end > customRange.start) {
      newBuffer = AudioProcessor.applyFadeRange(this.ctx, this.currentBuffer, customRange.start, customRange.end, customRange.type);
    } else {
      newBuffer = AudioProcessor.applyFade(this.ctx, this.currentBuffer, fadeInSec, fadeOutSec);
    }
    this.setBuffer(newBuffer, true);
  }
}
