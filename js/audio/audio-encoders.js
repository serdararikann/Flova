/* ====================================================================
   FLOVA AUDIO STUDIO - AUDIO ENCODERS
   WAV (16-bit / 24-bit / 32-bit float) and MP3 Encoding
   ==================================================================== */

export class AudioEncoders {
  /**
   * Encodes an AudioBuffer into a WAV Blob
   * @param {AudioBuffer} audioBuffer
   * @param {Object} options - { bitDepth: 16 | 24 | 32 }
   * @returns {Blob}
   */
  static bufferToWave(audioBuffer, options = { bitDepth: 16 }) {
    const numChannels = audioBuffer.numberOfChannels;
    const sampleRate = audioBuffer.sampleRate;
    const length = audioBuffer.length;
    const bitDepth = options.bitDepth || 16;
    const bytesPerSample = bitDepth / 8;
    const blockAlign = numChannels * bytesPerSample;
    const byteRate = sampleRate * blockAlign;
    const dataSize = length * blockAlign;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);

    // RIFF Chunk
    this.writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    this.writeString(view, 8, 'WAVE');

    // FMT Sub-chunk
    this.writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true); // Subchunk1Size for PCM
    const format = bitDepth === 32 ? 3 : 1; // 3 for IEEE float, 1 for PCM
    view.setUint16(20, format, true); // AudioFormat
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitDepth, true);

    // DATA Sub-chunk
    this.writeString(view, 36, 'data');
    view.setUint32(40, dataSize, true);

    // Write audio samples
    const channels = [];
    for (let i = 0; i < numChannels; i++) {
      channels.push(audioBuffer.getChannelData(i));
    }

    let offset = 44;
    for (let i = 0; i < length; i++) {
      for (let ch = 0; ch < numChannels; ch++) {
        let sample = channels[ch][i];
        // Clip sample between -1 and 1
        sample = Math.max(-1, Math.min(1, sample));

        if (bitDepth === 16) {
          const intSample = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
          view.setInt16(offset, intSample, true);
          offset += 2;
        } else if (bitDepth === 24) {
          const intSample = sample < 0 ? sample * 0x800000 : sample * 0x7FFFFF;
          view.setUint8(offset, intSample & 0xFF);
          view.setUint8(offset + 1, (intSample >> 8) & 0xFF);
          view.setUint8(offset + 2, (intSample >> 16) & 0xFF);
          offset += 3;
        } else if (bitDepth === 32) {
          view.setFloat32(offset, sample, true);
          offset += 4;
        }
      }
    }

    return new Blob([buffer], { type: 'audio/wav' });
  }

  /**
   * Encodes an AudioBuffer into an MP3 Blob using Lamejs or fallback
   * @param {AudioBuffer} audioBuffer
   * @param {Object} options - { kbps: 128 | 192 | 320 }
   * @param {Function} onProgress - (progress: number 0-1) => void
   * @returns {Promise<Blob>}
   */
  static async bufferToMp3(audioBuffer, options = { kbps: 192 }, onProgress = null) {
    // If lamejs is available in window
    if (typeof window.lamejs !== 'undefined') {
      const numChannels = audioBuffer.numberOfChannels;
      const sampleRate = audioBuffer.sampleRate;
      const kbps = options.kbps || 192;
      const mp3encoder = new window.lamejs.Mp3Encoder(numChannels, sampleRate, kbps);
      const mp3Data = [];

      const left = audioBuffer.getChannelData(0);
      const right = numChannels > 1 ? audioBuffer.getChannelData(1) : left;

      // Convert Float32 to Int16
      const sampleBlockSize = 1152;
      const totalSamples = left.length;
      
      const leftInt16 = new Int16Array(sampleBlockSize);
      const rightInt16 = new Int16Array(sampleBlockSize);

      let processed = 0;

      while (processed < totalSamples) {
        const chunkLen = Math.min(sampleBlockSize, totalSamples - processed);

        for (let i = 0; i < chunkLen; i++) {
          const l = Math.max(-1, Math.min(1, left[processed + i]));
          const r = Math.max(-1, Math.min(1, right[processed + i]));
          leftInt16[i] = l < 0 ? l * 0x8000 : l * 0x7FFF;
          rightInt16[i] = r < 0 ? r * 0x8000 : r * 0x7FFF;
        }

        let mp3buf;
        if (numChannels === 1) {
          mp3buf = mp3encoder.encodeBuffer(leftInt16.subarray(0, chunkLen));
        } else {
          mp3buf = mp3encoder.encodeBuffer(
            leftInt16.subarray(0, chunkLen),
            rightInt16.subarray(0, chunkLen)
          );
        }

        if (mp3buf.length > 0) {
          mp3Data.push(mp3buf);
        }

        processed += chunkLen;

        if (onProgress && processed % (sampleBlockSize * 10) === 0) {
          onProgress(processed / totalSamples);
          // Yield to UI thread
          await new Promise(r => setTimeout(r, 0));
        }
      }

      const endBuf = mp3encoder.flush();
      if (endBuf.length > 0) {
        mp3Data.push(endBuf);
      }

      if (onProgress) onProgress(1.0);
      return new Blob(mp3Data, { type: 'audio/mp3' });
    } else {
      // High quality WAV fallback if MP3 library is not loaded
      console.warn('Lamejs not found, falling back to WAV encoder');
      if (onProgress) onProgress(1.0);
      return this.bufferToWave(audioBuffer, { bitDepth: 16 });
    }
  }

  static writeString(view, offset, string) {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  }
}
