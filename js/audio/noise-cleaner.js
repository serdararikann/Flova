/**
 * Flova Studio - AI Noise Cleaner & Denoise Engine
 * Supports both client-side spectral gating and backend deep noise reduction
 */

export class NoiseCleaner {
  /**
   * Perform noise reduction using backend AI or client-side fallback
   * @param {AudioBuffer} audioBuffer 
   * @param {Object} options
   * @param {number} options.strength 0.1 to 1.0 (amount of noise reduction)
   * @param {boolean} options.useBackend Whether to use Python backend noisereduce
   * @param {AudioContext} audioCtx
   * @returns {Promise<AudioBuffer>}
   */
  static async denoise(audioBuffer, options = {}, audioCtx) {
    const { strength = 0.8, useBackend = true } = options;

    if (useBackend) {
      try {
        const cleanedBuffer = await this._denoiseViaBackend(audioBuffer, strength, audioCtx);
        if (cleanedBuffer) return cleanedBuffer;
      } catch (err) {
        console.warn('[NoiseCleaner] Backend denoise unavailable, falling back to client-side DSP:', err);
      }
    }

    return this._denoiseClientSide(audioBuffer, strength, audioCtx);
  }

  /**
   * Send audio to /api/ai/denoise on Python server
   */
  static async _denoiseViaBackend(audioBuffer, strength, audioCtx) {
    // Convert audioBuffer to WAV blob
    const wavBlob = await this._audioBufferToWavBlob(audioBuffer);
    const formData = new FormData();
    formData.append('audio', wavBlob, 'input.wav');
    formData.append('strength', strength.toString());

    const resp = await fetch(`/api/ai/denoise?strength=${strength}`, {
      method: 'POST',
      body: wavBlob,
      headers: {
        'Content-Type': 'audio/wav'
      }
    });

    if (!resp.ok) {
      throw new Error(`Server returned status ${resp.status}`);
    }

    const arrayBuffer = await resp.arrayBuffer();
    return await audioCtx.decodeAudioData(arrayBuffer);
  }

  /**
   * Fast client-side Spectral Gating & High-Pass / Low-Pass Noise Suppression
   */
  static _denoiseClientSide(audioBuffer, strength, audioCtx) {
    const sampleRate = audioBuffer.sampleRate;
    const numChannels = audioBuffer.numberOfChannels;
    const length = audioBuffer.length;
    const newBuffer = audioCtx.createBuffer(numChannels, length, sampleRate);

    // Spectral noise gating parameters
    const windowSize = 2048;
    const hopSize = 512;
    const reductionFactor = Math.min(0.95, Math.max(0.1, strength));

    for (let c = 0; c < numChannels; c++) {
      const input = audioBuffer.getChannelData(c);
      const output = newBuffer.getChannelData(c);

      // Estimate noise floor from the lowest 10% energy frames
      let frameEnergies = [];
      for (let i = 0; i < input.length - windowSize; i += hopSize * 4) {
        let energy = 0;
        for (let j = 0; j < windowSize; j += 4) {
          energy += input[i + j] * input[i + j];
        }
        frameEnergies.push(energy);
      }
      frameEnergies.sort((a, b) => a - b);
      const noiseFloorEnergy = frameEnergies.length > 0 
        ? frameEnergies[Math.floor(frameEnergies.length * 0.15)] 
        : 0.0001;
      
      const noiseThreshold = Math.sqrt(noiseFloorEnergy / (windowSize / 4)) * (1.2 + strength);

      // Soft spectral gate with smooth decay
      let prevGain = 1.0;
      for (let i = 0; i < length; i++) {
        const val = input[i];
        const absVal = Math.abs(val);

        let targetGain = 1.0;
        if (absVal < noiseThreshold) {
          // Attenuate noise
          const ratio = absVal / (noiseThreshold + 1e-6);
          targetGain = (1 - reductionFactor) + reductionFactor * Math.pow(ratio, 2);
        }

        // Smooth smoothing filter to avoid musical noise / robotic artifacts
        const gain = prevGain * 0.9 + targetGain * 0.1;
        prevGain = gain;

        output[i] = val * gain;
      }
    }

    return newBuffer;
  }

  /**
   * Encode AudioBuffer into standard 16-bit PCM WAV Blob
   */
  static _audioBufferToWavBlob(buffer) {
    const numChannels = buffer.numberOfChannels;
    const sampleRate = buffer.sampleRate;
    const length = buffer.length * numChannels * 2;
    const bufferArray = new ArrayBuffer(44 + length);
    const view = new DataView(bufferArray);

    function writeString(view, offset, string) {
      for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
      }
    }

    writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + length, true);
    writeString(view, 8, 'WAVE');
    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * numChannels * 2, true);
    view.setUint16(32, numChannels * 2, true);
    view.setUint16(34, 16, true);
    writeString(view, 36, 'data');
    view.setUint32(40, length, true);

    let offset = 44;
    for (let i = 0; i < buffer.length; i++) {
      for (let c = 0; c < numChannels; c++) {
        let sample = buffer.getChannelData(c)[i];
        sample = Math.max(-1, Math.min(1, sample));
        view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true);
        offset += 2;
      }
    }

    return new Blob([view], { type: 'audio/wav' });
  }
}
