/* ====================================================================
   FLOVA AUDIO STUDIO - MAIN AUDIO ENGINE
   Master AudioContext, Playback, Analyser, Undo/Redo & State
   ==================================================================== */

import { AudioEffectsRack } from './audio-effects.js';
import { AudioProcessor } from './audio-processor.js';
import { DemoAudioGenerator } from './demo-generator.js';
import { readTags } from './media-info.js';

export class AudioEngine {
  constructor() {
    // Lazy initialize AudioContext on user interaction
    this.ctx = null;
    this.effectsRack = null;
    this.analyser = null;

    // Active Audio Source & Buffer
    this.currentBuffer = null;
    this.currentFileName = 'Flova Parçası';
    // Title/artist written in the opened file (finds its lyrics when the file name doesn't say)
    this.currentTags = {};
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
    // How the next history entry was made ({ source, steps }); see takeRecipe().
    this.pendingRecipe = null;

    // Event Callbacks
    this.onTimeUpdate = null;
    this.onPlayStateChange = null;
    this.onBufferChange = null;
    this.onEnded = null;
    this.onHistoryChange = null;

    this.animationFrameId = null;
  }

  get audioBuffer() {
    return this.currentBuffer;
  }

  get buffer() {
    return this.currentBuffer;
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
    // Before decoding, which detaches the buffer
    const tags = readTags(new Uint8Array(arrayBuffer));
    const decodedBuffer = await this.ctx.decodeAudioData(arrayBuffer);
    this.currentTags = tags;
    
    const baseName = file.name ? file.name.replace(/\.[^/.]+$/, "") : 'Ses Dosyası';
    this.currentFileName = baseName;
    this.historyStack = [];
    this.historyIndex = -1;
    const ext = (file.name || '').split('.').pop().toLowerCase();
    this.pendingRecipe = { source: { blob: file, ext, buffer: decodedBuffer }, steps: [] };
    this.setBuffer(decodedBuffer, true);
    return decodedBuffer;
  }

  async loadDemoTrack() {
    this.ensureContext();
    this.currentFileName = 'Flova Synthwave Demo';
    this.currentTags = {};
    this.historyStack = [];
    this.historyIndex = -1;
    const demoBuffer = await DemoAudioGenerator.generateDemoTrack(this.ctx);
    // The synthesized mix peaks above full scale (clips on output and in 16-bit files): bring it to -0.4 dBFS.
    let peak = 0;
    for (let c = 0; c < demoBuffer.numberOfChannels; c++) {
      const data = demoBuffer.getChannelData(c);
      for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
    }
    if (peak > 0.95) {
      const gain = 0.95 / peak;
      for (let c = 0; c < demoBuffer.numberOfChannels; c++) {
        const data = demoBuffer.getChannelData(c);
        for (let i = 0; i < data.length; i++) data[i] *= gain;
      }
    }
    this.setBuffer(demoBuffer, true);
    return demoBuffer;
  }

  setBuffer(audioBuffer, pushHistory = true, selectionRange = null) {
    this.stop();
    this.currentBuffer = audioBuffer;
    this.pauseOffset = 0;
    // Some callers pass a file name here; only a { start, end } object is a selection.
    const range = selectionRange && typeof selectionRange === 'object' ? selectionRange : null;
    this.loopStart = range ? range.start : 0;
    this.loopEnd = range ? range.end : (audioBuffer ? audioBuffer.duration : 0);
    const recipe = this.takeRecipe(audioBuffer);

    if (pushHistory && audioBuffer) {
      // Remove any redo steps ahead
      this.historyStack = this.historyStack.slice(0, this.historyIndex + 1);
      this.historyStack.push({
        buffer: audioBuffer,
        name: this.currentFileName,
        selectionStart: this.loopStart,
        selectionEnd: this.loopEnd,
        recipe
      });
      if (this.historyStack.length > this.maxHistory) {
        this.historyStack.shift();
      }
      this.historyIndex = this.historyStack.length - 1;
    }

    if (this.onBufferChange) {
      this.onBufferChange(this.currentBuffer, { start: this.loopStart, end: this.loopEnd });
    }
    if (this.onHistoryChange) {
      this.onHistoryChange(this.canUndo(), this.canRedo());
    }
  }

  /**
   * How the audio of the next history entry was made, as a cloud project stores it (the same document as the
   * mobile app): a source (the original file, or a buffer that is uploaded as it is) and the edit steps replayed
   * on it ({ op: 'trim', start, end }, ...). Audio set without a recipe (smart tools, imports from the other
   * screens) becomes a new source.
   */
  takeRecipe(audioBuffer) {
    const recipe = this.pendingRecipe;
    this.pendingRecipe = null;
    return recipe || { source: { buffer: audioBuffer }, steps: [] };
  }

  /** The recipe of what is in the editor now (null when it is empty). */
  get recipe() {
    return this.historyStack[this.historyIndex]?.recipe || null;
  }

  withStep(step) {
    const current = this.recipe;
    return current ? { source: current.source, steps: [...current.steps, step] } : null;
  }

  /** Shows audio rebuilt from a saved project: a fresh history whose only entry is [recipe]. */
  loadFromRecipe(audioBuffer, recipe, name, selectionRange = null) {
    this.ensureContext();
    this.currentFileName = name;
    this.currentTags = {};
    this.historyStack = [];
    this.historyIndex = -1;
    this.pendingRecipe = recipe;
    this.setBuffer(audioBuffer, true, selectionRange);
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
      selectionEnd: end,
      recipe: lastState?.recipe || { source: { buffer: this.currentBuffer }, steps: [] }
    });
    if (this.historyStack.length > this.maxHistory) {
      this.historyStack.shift();
    }
    this.historyIndex = this.historyStack.length - 1;
    if (this.onHistoryChange) {
      this.onHistoryChange(this.canUndo(), this.canRedo());
    }
  }

  undo() {
    if (this.historyIndex > 0) {
      this.historyIndex--;
      const state = this.historyStack[this.historyIndex];
      if (state.name && state.name !== 'İsimsiz Parça' && state.name !== 'Yeni Proje') {
        this.currentFileName = state.name;
      }
      this.setBuffer(state.buffer, false, { start: state.selectionStart, end: state.selectionEnd });
      if (this.onHistoryChange) this.onHistoryChange(this.canUndo(), this.canRedo());
      return true;
    }
    return false;
  }

  redo() {
    if (this.historyIndex < this.historyStack.length - 1) {
      this.historyIndex++;
      const state = this.historyStack[this.historyIndex];
      if (state.name && state.name !== 'İsimsiz Parça' && state.name !== 'Yeni Proje') {
        this.currentFileName = state.name;
      }
      this.setBuffer(state.buffer, false, { start: state.selectionStart, end: state.selectionEnd });
      if (this.onHistoryChange) this.onHistoryChange(this.canUndo(), this.canRedo());
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

    const isRegionLoop = this.isLooping && this.loopEnd > this.loopStart && (this.loopStart > 0.05 || this.loopEnd < this.currentBuffer.duration - 0.05);

    let startPos = offset !== null ? offset : this.pauseOffset;
    if (isRegionLoop) {
      if (startPos < this.loopStart || startPos >= this.loopEnd - 0.05) {
        startPos = this.loopStart;
      }
    }
    this.pauseOffset = Math.max(0, Math.min(this.currentBuffer.duration, startPos));

    this.sourceNode = this.ctx.createBufferSource();
    this.sourceNode.buffer = this.currentBuffer;
    this.sourceNode.playbackRate.value = this.effectsRack.params.playbackRate;

    if (this.isLooping) {
      this.sourceNode.loop = true;
      this.sourceNode.loopStart = isRegionLoop ? this.loopStart : 0;
      this.sourceNode.loopEnd = isRegionLoop ? this.loopEnd : this.currentBuffer.duration;
    }

    this.sourceNode.connect(this.effectsRack.inputNode);

    this.startTime = this.ctx.currentTime - (this.pauseOffset / this.effectsRack.params.playbackRate);

    this.sourceNode.start(0, this.pauseOffset);
    this.isPlaying = true;

    this.sourceNode.onended = () => {
      if (this.isPlaying) {
        this.pauseOffset = isRegionLoop ? this.loopStart : 0;
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
    this.isPlaying = false;
    this.stopSource();
    this.stopTimer();

    if (this.onPlayStateChange) {
      this.onPlayStateChange(false);
    }
  }

  stop() {
    this.isPlaying = false;
    this.stopSource();
    const isRegionLoop = this.isLooping && this.loopEnd > this.loopStart && (this.loopStart > 0.05 || this.loopEnd < (this.currentBuffer ? this.currentBuffer.duration - 0.05 : 0));
    this.pauseOffset = isRegionLoop ? this.loopStart : 0;
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
    let targetTime = timeInSeconds;
    if (this.isLooping && this.loopEnd > this.loopStart && (this.loopStart > 0.05 || this.loopEnd < this.currentBuffer.duration - 0.05)) {
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
        this.sourceNode.onended = null;
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
    this.pendingRecipe = this.withStep({ op: 'trim', start: startTime, end: endTime });
    this.setBuffer(newBuffer, true);
  }

  cutOutCurrent(startTime, endTime) {
    if (!this.currentBuffer) return;
    const newBuffer = AudioProcessor.cutOutRange(this.ctx, this.currentBuffer, startTime, endTime);
    this.pendingRecipe = this.withStep({ op: 'cut', start: startTime, end: endTime });
    this.setBuffer(newBuffer, true);
  }

  silenceCurrent(startTime, endTime) {
    if (!this.currentBuffer) return;
    const newBuffer = AudioProcessor.silenceRange(this.ctx, this.currentBuffer, startTime, endTime);
    this.pendingRecipe = this.withStep({ op: 'silence', start: startTime, end: endTime });
    this.setBuffer(newBuffer, true);
  }

  reverseCurrent() {
    if (!this.currentBuffer) return;
    const newBuffer = AudioProcessor.reverseBuffer(this.ctx, this.currentBuffer);
    this.pendingRecipe = this.withStep({ op: 'reverse' });
    this.setBuffer(newBuffer, true);
  }

  applyFadeToCurrent(fadeInSec, fadeOutSec, customRange = null) {
    if (!this.currentBuffer) return;
    let newBuffer;
    if (customRange && customRange.end > customRange.start) {
      newBuffer = AudioProcessor.applyFadeRange(this.ctx, this.currentBuffer, customRange.start, customRange.end, customRange.type);
      this.pendingRecipe = this.withStep({ op: 'fadeRange', start: customRange.start, end: customRange.end, fadeIn: customRange.type !== 'out' });
    } else {
      newBuffer = AudioProcessor.applyFade(this.ctx, this.currentBuffer, fadeInSec, fadeOutSec);
      this.pendingRecipe = this.withStep({ op: 'fade', fadeIn: fadeInSec, fadeOut: fadeOutSec });
    }
    this.setBuffer(newBuffer, true);
  }

  normalizeCurrent(targetPeakDb = -0.1) {
    if (!this.currentBuffer) return null;
    this.ensureContext();
    const result = AudioProcessor.normalizeBuffer(this.ctx, this.currentBuffer, targetPeakDb);
    // A saved step always normalizes to -0.1 dBFS; another target is kept as the result itself.
    this.pendingRecipe = targetPeakDb === -0.1 ? this.withStep({ op: 'normalize' }) : null;
    this.setBuffer(result.buffer, true, { start: this.loopStart, end: this.loopEnd });
    return result;
  }
}
