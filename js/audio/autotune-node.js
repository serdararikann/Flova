/**
 * Flova Studio - Smart Auto-Tune & Pitch Correction Engine
 * Quantizes vocal pitch to musical scales with selectable correction speed and scale presets.
 */

export class AutoTuneEngine {
  static SCALES = {
    chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    major: [0, 2, 4, 5, 7, 9, 11],
    minor: [0, 2, 3, 5, 7, 8, 10],
    pentatonicMajor: [0, 2, 4, 7, 9],
    pentatonicMinor: [0, 3, 5, 7, 10],
    blues: [0, 3, 5, 6, 7, 10]
  };

  static ROOT_NOTES = {
    'C': 0, 'C#': 1, 'D': 2, 'D#': 3, 'E': 4, 'F': 5,
    'F#': 6, 'G': 7, 'G#': 8, 'A': 9, 'A#': 10, 'B': 11
  };

  /**
   * Process an AudioBuffer with Auto-Tune Pitch Correction
   * @param {AudioBuffer} audioBuffer 
   * @param {Object} options 
   * @param {string} options.root Root note (e.g. 'C', 'G#')
   * @param {string} options.scale Scale name ('major', 'minor', 'chromatic', 'blues')
   * @param {number} options.speed Correction speed: 0 = Hard T-Pain snap, 50 = Pop, 100 = Natural
   * @param {number} options.amount 0.0 to 1.0 (wet mix)
   * @param {AudioContext} audioCtx
   * @returns {AudioBuffer}
   */
  static process(audioBuffer, options = {}, audioCtx) {
    const {
      root = 'C',
      scale = 'major',
      speed = 10,
      amount = 0.9
    } = options;

    const sampleRate = audioBuffer.sampleRate;
    const numChannels = audioBuffer.numberOfChannels;
    const length = audioBuffer.length;
    const outBuffer = audioCtx.createBuffer(numChannels, length, sampleRate);

    const rootOffset = this.ROOT_NOTES[root] || 0;
    const allowedScaleNotes = (this.SCALES[scale] || this.SCALES.major).map(n => (n + rootOffset) % 12);

    // Frame size for pitch tracking: ~40ms (1024 or 2048 samples)
    const frameSize = 2048;
    const hopSize = 512;
    const numFrames = Math.floor(length / hopSize);

    // Speed parameter maps to smoothing factor (0 = instantaneous robot snap, 100 = slow smooth)
    const smoothingAlpha = Math.min(0.95, Math.max(0.0, speed / 100));

    for (let c = 0; c < numChannels; c++) {
      const input = audioBuffer.getChannelData(c);
      const output = outBuffer.getChannelData(c);

      // Pitch shift phase accumulator
      let currentShiftFactor = 1.0;

      for (let f = 0; f < numFrames; f++) {
        const frameStart = f * hopSize;
        const frameEnd = Math.min(length, frameStart + frameSize);

        // Detect fundamental frequency (F0) using simplified YIN / Autocorrelation
        const pitch = this._detectPitch(input, frameStart, frameEnd, sampleRate);

        if (pitch > 60 && pitch < 1200) {
          // Convert Hz to MIDI note
          const midiNote = 69 + 12 * Math.log2(pitch / 440);
          const targetMidi = this._findClosestScaleNote(midiNote, allowedScaleNotes);
          const semitoneDiff = targetMidi - midiNote;
          
          // Target pitch shift factor
          const targetShift = Math.pow(2, (semitoneDiff * amount) / 12);
          currentShiftFactor = currentShiftFactor * smoothingAlpha + targetShift * (1 - smoothingAlpha);
        } else {
          // Unvoiced or silent, return to 1.0
          currentShiftFactor = currentShiftFactor * 0.9 + 1.0 * 0.1;
        }

        // Apply time-domain pitch shift interpolator for this hop
        for (let i = 0; i < hopSize; i++) {
          const idx = frameStart + i;
          if (idx >= length) break;

          // Simple phase-vocoder / resampling interpolation
          const readIdx = frameStart + Math.floor(i * currentShiftFactor) % frameSize;
          const safeRead = Math.min(length - 1, Math.max(0, readIdx));
          
          output[idx] = input[idx] * (1 - amount) + input[safeRead] * amount;
        }
      }
    }

    return outBuffer;
  }

  /**
   * Fast autocorrelation pitch detector for vocal range (80Hz to 1000Hz)
   */
  static _detectPitch(signal, start, end, sampleRate) {
    const minLag = Math.floor(sampleRate / 1000); // 1000 Hz
    const maxLag = Math.floor(sampleRate / 75);   // 75 Hz
    const len = end - start;

    if (len < maxLag * 2) return -1;

    let bestLag = -1;
    let maxCorr = 0.2;

    for (let lag = minLag; lag <= maxLag; lag++) {
      let sum = 0;
      let norm1 = 0;
      let norm2 = 0;

      for (let i = 0; i < len - lag; i += 2) {
        const s1 = signal[start + i];
        const s2 = signal[start + i + lag];
        sum += s1 * s2;
        norm1 += s1 * s1;
        norm2 += s2 * s2;
      }

      const denom = Math.sqrt(norm1 * norm2) + 1e-6;
      const corr = sum / denom;

      if (corr > maxCorr) {
        maxCorr = corr;
        bestLag = lag;
      }
    }

    if (bestLag > 0 && maxCorr > 0.45) {
      return sampleRate / bestLag;
    }
    return -1;
  }

  /**
   * Find closest scale note to detected continuous MIDI note
   */
  static _findClosestScaleNote(midiNote, allowedPitchClasses) {
    const rounded = Math.round(midiNote);
    let bestNote = rounded;
    let minDistance = 999;

    // Check +/- 6 semitones
    for (let test = rounded - 6; test <= rounded + 6; test++) {
      const pitchClass = ((test % 12) + 12) % 12;
      if (allowedPitchClasses.includes(pitchClass)) {
        const dist = Math.abs(test - midiNote);
        if (dist < minDistance) {
          minDistance = dist;
          bestNote = test;
        }
      }
    }

    return bestNote;
  }
}
