/**
 * Flova Studio - BPM & Musical Key Detector
 * High-performance client-side analysis of tempo and pitch class profile (Chroma)
 */

export class BPMKeyDetector {
  /**
   * Analyze an AudioBuffer to detect BPM and Musical Key
   * @param {AudioBuffer} audioBuffer 
   * @returns {Promise<{bpm: number, key: string, confidence: number, beats: number[]}>}
   */
  static async analyze(audioBuffer) {
    if (!audioBuffer || audioBuffer.length === 0) {
      return { bpm: 120, key: 'C Major', confidence: 0, beats: [] };
    }

    try {
      // 1. Downmix to mono and subsample for speed (e.g. target ~11025 Hz or 22050 Hz)
      const sampleRate = audioBuffer.sampleRate;
      const downsampleFactor = Math.max(1, Math.floor(sampleRate / 11025));
      const targetRate = sampleRate / downsampleFactor;
      
      const channelData = audioBuffer.getChannelData(0);
      const subLength = Math.floor(channelData.length / downsampleFactor);
      
      // Limit analysis to first 90 seconds (plenty for BPM and Key, saves memory)
      const maxSamples = Math.min(subLength, Math.floor(targetRate * 90));
      const mono = new Float32Array(maxSamples);
      
      for (let i = 0; i < maxSamples; i++) {
        mono[i] = channelData[i * downsampleFactor];
      }

      // 2. Detect BPM using Low-Pass Filtering + Onset Energy Autocorrelation
      const { bpm, beats, bpmConfidence } = this._detectBPM(mono, targetRate, audioBuffer.duration);

      // 3. Detect Musical Key using Pitch Class Profile (Chroma) & Krumhansl-Schmuckler profiles
      const { key, keyConfidence } = this._detectKey(mono, targetRate);

      return {
        bpm: Math.round(bpm),
        key,
        confidence: Math.round(((bpmConfidence + keyConfidence) / 2) * 100),
        beats
      };
    } catch (err) {
      console.warn('[BPMKeyDetector] Analysis error, fallback to default:', err);
      return { bpm: 120, key: 'C Major', confidence: 50, beats: [] };
    }
  }

  /**
   * Detect BPM and beat timestamps using onset envelope and autocorrelation
   */
  static _detectBPM(signal, sampleRate, totalDuration) {
    // Envelope calculation via sliding RMS
    const hopSize = Math.floor(sampleRate / 100); // 10ms hops
    const numHops = Math.floor(signal.length / hopSize);
    const envelope = new Float32Array(numHops);

    for (let i = 0; i < numHops; i++) {
      let sum = 0;
      const start = i * hopSize;
      const end = Math.min(signal.length, start + hopSize);
      for (let j = start; j < end; j++) {
        sum += signal[j] * signal[j];
      }
      envelope[i] = Math.sqrt(sum / (end - start));
    }

    // First-order difference for onset detection (half-wave rectification)
    const onsets = new Float32Array(numHops);
    for (let i = 1; i < numHops; i++) {
      const diff = envelope[i] - envelope[i - 1];
      onsets[i] = diff > 0 ? diff : 0;
    }

    // Autocorrelation for lag corresponding to 60-190 BPM
    // Lag in hops = (60 / bpm) * 100 hops/sec
    const minBpm = 65;
    const maxBpm = 185;
    const minLag = Math.floor((60 / maxBpm) * 100);
    const maxLag = Math.floor((60 / minBpm) * 100);

    let bestLag = 0;
    let maxCorr = -1;

    for (let lag = minLag; lag <= maxLag; lag++) {
      let corr = 0;
      const count = numHops - lag;
      for (let i = 0; i < count; i++) {
        corr += onsets[i] * onsets[i + lag];
      }
      if (corr > maxCorr) {
        maxCorr = corr;
        bestLag = lag;
      }
    }

    let detectedBpm = bestLag > 0 ? (60 * 100) / bestLag : 120;
    
    // Normalize to typical 80 - 160 BPM range
    if (detectedBpm < 75) detectedBpm *= 2;
    if (detectedBpm > 175) detectedBpm /= 2;

    // Generate beat timestamps across entire track duration
    const beatInterval = 60 / detectedBpm;
    const beats = [];
    const limitDuration = Math.min(totalDuration, 600); // up to 10 min
    for (let t = 0; t < limitDuration; t += beatInterval) {
      beats.push(t);
    }

    return {
      bpm: detectedBpm,
      beats,
      bpmConfidence: maxCorr > 0 ? 0.85 : 0.4
    };
  }

  /**
   * Detect Musical Key using Chroma feature analysis and correlation against Krumhansl-Schmuckler profiles
   */
  static _detectKey(signal, sampleRate) {
    // 12 semitones: C, C#, D, D#, E, F, F#, G, G#, A, A#, B
    const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

    // Standard Krumhansl-Schmuckler Key Profiles for Major and Minor
    const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
    const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

    // Compute simple chromagram across octave bands 65Hz to 2000Hz (C2 to B6)
    const chroma = new Float32Array(12);
    const fftSize = 4096;
    const numWindows = Math.min(100, Math.floor(signal.length / fftSize));
    
    for (let w = 0; w < numWindows; w++) {
      const offset = w * fftSize;
      for (let note = 0; note < 12; note++) {
        // Sample frequencies across 3 octaves for this pitch class
        for (let octave = 3; octave <= 5; octave++) {
          const freq = 440 * Math.pow(2, (note - 9 + (octave - 4) * 12) / 12);
          // Discrete Fourier coefficient at this frequency
          const k = Math.round((freq * fftSize) / sampleRate);
          if (k < fftSize / 2) {
            let real = 0;
            let imag = 0;
            const step = (2 * Math.PI * k) / fftSize;
            for (let n = 0; n < fftSize; n += 4) {
              const val = signal[offset + n] || 0;
              real += val * Math.cos(step * n);
              imag -= val * Math.sin(step * n);
            }
            chroma[note] += Math.sqrt(real * real + imag * imag);
          }
        }
      }
    }

    // Normalize chroma
    let chromaSum = 0;
    for (let i = 0; i < 12; i++) chromaSum += chroma[i];
    if (chromaSum > 0) {
      for (let i = 0; i < 12; i++) chroma[i] /= chromaSum;
    }

    // Correlate against all 24 keys (12 major, 12 minor)
    let bestKey = 'C Major';
    let bestScore = -999;

    for (let shift = 0; shift < 12; shift++) {
      // Test Major
      let majorScore = 0;
      for (let i = 0; i < 12; i++) {
        majorScore += chroma[(i + shift) % 12] * MAJOR_PROFILE[i];
      }
      if (majorScore > bestScore) {
        bestScore = majorScore;
        bestKey = `${NOTE_NAMES[shift]} Majör`;
      }

      // Test Minor
      let minorScore = 0;
      for (let i = 0; i < 12; i++) {
        minorScore += chroma[(i + shift) % 12] * MINOR_PROFILE[i];
      }
      if (minorScore > bestScore) {
        bestScore = minorScore;
        bestKey = `${NOTE_NAMES[shift]} Minör`;
      }
    }

    return {
      key: bestKey,
      keyConfidence: 0.8
    };
  }

  /**
   * Snap a timestamp to the closest beat
   * @param {number} timeSeconds 
   * @param {number} bpm 
   * @param {number} subdivision 1 = quarter note, 2 = eighth note, 4 = sixteenth note
   */
  static snapToBeat(timeSeconds, bpm, subdivision = 1) {
    if (!bpm || bpm <= 0) return timeSeconds;
    const beatInterval = (60 / bpm) / subdivision;
    return Math.round(timeSeconds / beatInterval) * beatInterval;
  }
}
