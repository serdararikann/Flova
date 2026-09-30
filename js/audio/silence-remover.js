/**
 * Flova Studio - Silence Remover & Speech Normalizer
 * Detects silent gaps in audio buffers and trims or slices them automatically.
 */

export class SilenceRemover {
  /**
   * Detect silent regions in an AudioBuffer
   * @param {AudioBuffer} audioBuffer 
   * @param {Object} options 
   * @param {number} options.thresholdDb Minimum dB for silence (default -40 dB)
   * @param {number} options.minDurationSec Minimum duration of silence to detect (default 0.35s)
   * @param {number} options.paddingSec Keep a tiny padding around speech to prevent cut-off attacks (default 0.05s)
   * @returns {{silences: Array<{start: number, end: number, duration: number}>, totalSilenceSec: number, percentSilence: number}}
   */
  static detectSilence(audioBuffer, options = {}) {
    const {
      thresholdDb = -40,
      minDurationSec = 0.35,
      paddingSec = 0.05
    } = options;

    if (!audioBuffer) return { silences: [], totalSilenceSec: 0, percentSilence: 0 };

    const sampleRate = audioBuffer.sampleRate;
    const numChannels = audioBuffer.numberOfChannels;
    const length = audioBuffer.length;
    const thresholdLinear = Math.pow(10, thresholdDb / 20);

    // Window size for RMS: 20ms
    const windowSize = Math.floor(sampleRate * 0.02);
    const numWindows = Math.floor(length / windowSize);

    // Precompute RMS values
    const isSilentWindow = new Uint8Array(numWindows);
    const channels = [];
    for (let c = 0; c < numChannels; c++) {
      channels.push(audioBuffer.getChannelData(c));
    }

    for (let w = 0; w < numWindows; w++) {
      const start = w * windowSize;
      const end = Math.min(length, start + windowSize);
      let maxRms = 0;

      for (let c = 0; c < numChannels; c++) {
        const data = channels[c];
        let sum = 0;
        for (let i = start; i < end; i++) {
          sum += data[i] * data[i];
        }
        const rms = Math.sqrt(sum / (end - start));
        if (rms > maxRms) maxRms = rms;
      }

      isSilentWindow[w] = maxRms < thresholdLinear ? 1 : 0;
    }

    // Find contiguous silent sequences
    const minSilentWindows = Math.floor(minDurationSec / 0.02);
    const silences = [];
    let silenceStart = null;

    for (let w = 0; w < numWindows; w++) {
      if (isSilentWindow[w] === 1) {
        if (silenceStart === null) silenceStart = w;
      } else {
        if (silenceStart !== null) {
          const durationWindows = w - silenceStart;
          if (durationWindows >= minSilentWindows) {
            const startSec = (silenceStart * windowSize) / sampleRate;
            const endSec = (w * windowSize) / sampleRate;
            silences.push({
              start: Math.max(0, startSec + paddingSec),
              end: Math.min(audioBuffer.duration, endSec - paddingSec),
              duration: Math.max(0, (endSec - paddingSec) - (startSec + paddingSec))
            });
          }
          silenceStart = null;
        }
      }
    }

    if (silenceStart !== null) {
      const durationWindows = numWindows - silenceStart;
      if (durationWindows >= minSilentWindows) {
        const startSec = (silenceStart * windowSize) / sampleRate;
        const endSec = audioBuffer.duration;
        silences.push({
          start: Math.max(0, startSec + paddingSec),
          end: endSec,
          duration: Math.max(0, endSec - (startSec + paddingSec))
        });
      }
    }

    // Filter out invalid or zero-length silences
    const validSilences = silences.filter(s => s.duration > 0.05 && s.end > s.start);
    const totalSilenceSec = validSilences.reduce((acc, s) => acc + s.duration, 0);
    const percentSilence = audioBuffer.duration > 0 ? (totalSilenceSec / audioBuffer.duration) * 100 : 0;

    return {
      silences: validSilences,
      totalSilenceSec: Math.round(totalSilenceSec * 100) / 100,
      percentSilence: Math.round(percentSilence * 10) / 10
    };
  }

  /**
   * Splice and remove silent sections from an AudioBuffer, returning a trimmed AudioBuffer
   * @param {AudioBuffer} audioBuffer 
   * @param {Array<{start: number, end: number}>} silences 
   * @param {AudioContext} audioCtx 
   * @returns {AudioBuffer}
   */
  static removeSilence(audioBuffer, silences, audioCtx) {
    if (!audioBuffer || !silences || silences.length === 0) return audioBuffer;

    const sampleRate = audioBuffer.sampleRate;
    const numChannels = audioBuffer.numberOfChannels;
    const totalLength = audioBuffer.length;

    // Build speech (non-silent) segments
    const speechSegments = [];
    let currentPos = 0;

    const sortedSilences = [...silences].sort((a, b) => a.start - b.start);

    for (const silence of sortedSilences) {
      const startSample = Math.max(0, Math.floor(silence.start * sampleRate));
      const endSample = Math.min(totalLength, Math.floor(silence.end * sampleRate));

      if (startSample > currentPos) {
        speechSegments.push({ start: currentPos, end: startSample });
      }
      currentPos = Math.max(currentPos, endSample);
    }

    if (currentPos < totalLength) {
      speechSegments.push({ start: currentPos, end: totalLength });
    }

    // Calculate total output length
    const outLength = speechSegments.reduce((sum, seg) => sum + (seg.end - seg.start), 0);
    if (outLength <= 0) return audioBuffer;

    const newBuffer = audioCtx.createBuffer(numChannels, outLength, sampleRate);

    // Copy with 2ms micro-crossfade to prevent clicks at boundaries
    const fadeSamples = Math.min(128, Math.floor(sampleRate * 0.003));

    for (let c = 0; c < numChannels; c++) {
      const srcData = audioBuffer.getChannelData(c);
      const dstData = newBuffer.getChannelData(c);
      let writeOffset = 0;

      for (let s = 0; s < speechSegments.length; s++) {
        const seg = speechSegments[s];
        const segLen = seg.end - seg.start;

        for (let i = 0; i < segLen; i++) {
          let val = srcData[seg.start + i];

          // Micro fade-in at segment start
          if (s > 0 && i < fadeSamples) {
            val *= (i / fadeSamples);
          }
          // Micro fade-out at segment end
          if (s < speechSegments.length - 1 && i >= segLen - fadeSamples) {
            val *= ((segLen - i) / fadeSamples);
          }

          dstData[writeOffset + i] = val;
        }

        writeOffset += segLen;
      }
    }

    return newBuffer;
  }
}
