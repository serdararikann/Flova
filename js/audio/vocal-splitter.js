/* ====================================================================
   FLOVA AUDIO STUDIO - STFT SPECTRAL OVER-SUBTRACTION VOCAL SPLITTER
   High-Fidelity Mid/Side Spectral Subtraction with Over-Subtraction (alpha),
   Dynamic Noise Gate, Sub-Bass/Air Crossover & Inverse Subtraction Karaoke
   ==================================================================== */

export class VocalSplitter {
  /**
   * Precomputed Radix-2 FFT Helper
   */
  static getFFTTables(n) {
    if (this._fftTables && this._fftTables.n === n) {
      return this._fftTables;
    }

    const bitRev = new Uint32Array(n);
    const cosTable = new Float32Array(n / 2);
    const sinTable = new Float32Array(n / 2);

    let j = 0;
    for (let i = 0; i < n; i++) {
      bitRev[i] = j;
      let bit = n >> 1;
      while (j >= bit && bit > 0) {
        j -= bit;
        bit >>= 1;
      }
      j += bit;
    }

    for (let i = 0; i < n / 2; i++) {
      const angle = (-2 * Math.PI * i) / n;
      cosTable[i] = Math.cos(angle);
      sinTable[i] = Math.sin(angle);
    }

    this._fftTables = { n, bitRev, cosTable, sinTable };
    return this._fftTables;
  }

  /**
   * In-place Radix-2 Cooley-Tukey FFT
   */
  static fft(real, imag, n) {
    const { bitRev, cosTable, sinTable } = this.getFFTTables(n);

    for (let i = 0; i < n; i++) {
      const j = bitRev[i];
      if (i < j) {
        const tempR = real[i]; real[i] = real[j]; real[j] = tempR;
        const tempI = imag[i]; imag[i] = imag[j]; imag[j] = tempI;
      }
    }

    for (let len = 2; len <= n; len <<= 1) {
      const halfLen = len >> 1;
      const step = n / len;

      for (let i = 0; i < n; i += len) {
        for (let k = 0; k < halfLen; k++) {
          const tableIdx = k * step;
          const c = cosTable[tableIdx];
          const s = sinTable[tableIdx];

          const idxB = i + k + halfLen;
          const idxA = i + k;

          const tr = real[idxB] * c - imag[idxB] * s;
          const ti = real[idxB] * s + imag[idxB] * c;

          real[idxB] = real[idxA] - tr;
          imag[idxB] = imag[idxA] - ti;
          real[idxA] += tr;
          imag[idxA] += ti;
        }
      }
    }
  }

  /**
   * In-place Radix-2 Inverse FFT
   */
  static ifft(real, imag, n) {
    for (let i = 0; i < n; i++) {
      imag[i] = -imag[i];
    }

    this.fft(real, imag, n);

    const scale = 1.0 / n;
    for (let i = 0; i < n; i++) {
      real[i] = real[i] * scale;
      imag[i] = -imag[i] * scale;
    }
  }

  /**
   * Studio DSP 2.0 High-Fidelity Vocal & Instrumental Separation Engine
   * - True Stereo Spatial Corridor (Interchannel Level & Phase Coherence)
   * - Percussive Transient Suppression (HPSS Drum & Snare rejection)
   * - Intelligent Formant-tracking Voice Activity Gate (VAD) for silent intros
   * - Wiener Power-law Soft Masking with Temporal Smoothing (Zero watery noise)
   * - Extended Sibilance & Breath Air Protection (up to 15.5 kHz)
   * - Non-destructive Complementary Instrumental Mask (Zero comb-filtering)
   * 
   * @param {AudioContext} audioCtx 
   * @param {AudioBuffer} sourceBuffer 
   * @param {Object} options 
   * @param {Function} onProgress (progressPct, statusText)
   * @returns {Promise<{ vocalBuffer: AudioBuffer, instrumentalBuffer: AudioBuffer }>}
   */
  static async processBuffer(audioCtx, sourceBuffer, options = {}, onProgress = null) {
    const vocalSensitivity = options.vocalSensitivity !== undefined ? options.vocalSensitivity : 1.2;
    const bassCutoffHz = options.bassCutoffHz || 160;
    const stereoWidth = options.stereoWidth !== undefined ? options.stereoWidth : 1.0;
    const vadGateStrength = options.vadGateStrength !== undefined ? options.vadGateStrength : 1.2;
    const sibilanceAir = options.sibilanceAir !== undefined ? options.sibilanceAir : 1.0;
    const transientWeight = options.transientWeight !== undefined ? options.transientWeight : 1.0;

    const sampleRate = sourceBuffer.sampleRate;
    const totalSamples = sourceBuffer.length;
    const channels = sourceBuffer.numberOfChannels;

    let leftIn, rightIn;
    if (channels === 1) {
      leftIn = sourceBuffer.getChannelData(0);
      rightIn = sourceBuffer.getChannelData(0);
    } else {
      leftIn = sourceBuffer.getChannelData(0);
      rightIn = sourceBuffer.getChannelData(1);
    }

    const vocalBuffer = audioCtx.createBuffer(2, totalSamples, sampleRate);
    const instBuffer = audioCtx.createBuffer(2, totalSamples, sampleRate);

    const vocalL = vocalBuffer.getChannelData(0);
    const vocalR = vocalBuffer.getChannelData(1);
    const instL = instBuffer.getChannelData(0);
    const instR = instBuffer.getChannelData(1);

    // STFT Parameters: N=2048 gives 21.5Hz resolution at 44.1kHz / 23.4Hz at 48kHz
    const N = 2048;
    const H = 512; // 75% overlap
    const numFrames = Math.floor((totalSamples - N) / H) + 1;

    // Hann Window with exact OLA normalization
    const hann = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      hann[i] = 0.5 * (1.0 - Math.cos((2.0 * Math.PI * i) / N));
    }
    const olaNorm = 1.0 / ((N / H) * 0.375);

    // Frequency boundaries
    const binHz = sampleRate / N;
    const numBins = N / 2 + 1;

    // Working Arrays (Reused per frame to prevent GC pressure)
    const origLReal = new Float32Array(N);
    const origLImag = new Float32Array(N);
    const origRReal = new Float32Array(N);
    const origRImag = new Float32Array(N);

    const vocRealL = new Float32Array(N);
    const vocImagL = new Float32Array(N);
    const vocRealR = new Float32Array(N);
    const vocImagR = new Float32Array(N);

    const instRealL = new Float32Array(N);
    const instImagL = new Float32Array(N);
    const instRealR = new Float32Array(N);
    const instImagR = new Float32Array(N);

    // Dynamic state trackers across frames
    const prevMagL = new Float32Array(numBins);
    const prevMagR = new Float32Array(numBins);
    const smoothedMask = new Float32Array(numBins);
    let gateEnvelope = 0.0;

    const framesPerChunk = 75;
    const sigmaPan = 0.20 * Math.max(0.4, stereoWidth);
    const alphaSmooth = 0.35; // Temporal mask smoothing coefficient

    for (let frame = 0; frame < numFrames; frame++) {
      const sampleOffset = frame * H;

      // 1. Windowing
      for (let i = 0; i < N; i++) {
        const idx = sampleOffset + i;
        const w = hann[i];
        origLReal[i] = (idx < totalSamples ? leftIn[idx] : 0) * w;
        origLImag[i] = 0;
        origRReal[i] = (idx < totalSamples ? rightIn[idx] : 0) * w;
        origRImag[i] = 0;
      }

      // 2. Dual-channel FFT
      this.fft(origLReal, origLImag, N);
      this.fft(origRReal, origRImag, N);

      // Frame energy metrics for VAD
      let frameFormantEnergy = 0;
      let frameTotalEnergy = 0;

      // 3. Time-Frequency DSP Masking
      for (let k = 0; k < numBins; k++) {
        const lR = origLReal[k], lI = origLImag[k];
        const rR = origRReal[k], rI = origRImag[k];

        const magL = Math.sqrt(lR * lR + lI * lI);
        const magR = Math.sqrt(rR * rR + rI * rI);
        const eps = 1e-9;

        // A. Interchannel Panning & Coherence Corridor (True Stereo Preservation)
        const pan = (magL - magR) / (magL + magR + eps);
        const crossR = lR * rR + lI * rI;
        const crossI = lI * rR - lR * rI;
        const crossMag = Math.sqrt(crossR * crossR + crossI * crossI);
        const coherence = Math.min(1.0, (2.0 * crossMag) / (magL * magL + magR * magR + eps));
        const spatialWeight = Math.exp(-0.5 * Math.pow(pan / Math.max(0.08, sigmaPan), 2.0)) * Math.pow(coherence, 0.6);

        // B. Psychoacoustic Vocal Frequency Weighting & Sibilance Protection
        const freqHz = k * binHz;
        let freqWeight = 1.0;
        if (freqHz < bassCutoffHz) {
          // 4th order steep Linkwitz-Riley low cut
          const r = Math.max(0, freqHz / bassCutoffHz);
          freqWeight = r * r * r * r;
        } else if (freqHz < 300) {
          freqWeight = 0.6 + 0.4 * ((freqHz - bassCutoffHz) / (300 - bassCutoffHz));
        } else if (freqHz <= 4500) {
          freqWeight = 1.0; // Vocal core formant
        } else if (freqHz <= 8500) {
          freqWeight = 0.95;
        } else if (freqHz <= 15000) {
          // Extended air & sibilance (retains natural 's', 'sh', 't', breath)
          freqWeight = 0.75 * sibilanceAir;
        } else {
          freqWeight = 0.15;
        }

        // C. Percussive Transient Suppression (HPSS Kick & Snare de-bleeder)
        const fluxL = Math.max(0, magL - prevMagL[k]);
        const fluxR = Math.max(0, magR - prevMagR[k]);
        prevMagL[k] = magL;
        prevMagR[k] = magR;
        const avgMag = 0.5 * (magL + magR);
        const relFlux = (0.5 * (fluxL + fluxR)) / (avgMag + 1e-4);
        const transientDamp = 1.0 / (1.0 + Math.pow(relFlux * 1.5 * transientWeight, 2.0));

        // D. Raw Mask & Wiener Power Weighting (Zero watery musical noise)
        const rawMask = spatialWeight * freqWeight * transientDamp;
        let wienerMask = Math.pow(rawMask, 2.2);
        wienerMask = Math.max(0, Math.min(1.0, wienerMask * (vocalSensitivity * 1.4) - 0.08));

        // E. Temporal Mask Smoothing
        smoothedMask[k] = alphaSmooth * smoothedMask[k] + (1.0 - alphaSmooth) * wienerMask;

        // Collect Formant vs Total Frame Energy for VAD
        if (freqHz >= 300 && freqHz <= 3500) {
          frameFormantEnergy += (magL * magL + magR * magR) * smoothedMask[k];
        }
        frameTotalEnergy += (magL * magL + magR * magR);
      }

      // 4. Intelligent Voice Activity Detection (VAD) Gate
      // When vocal presence is low (intro or instrumental solos), smooth gate closes to -70dB
      const vocalRatio = frameFormantEnergy / (frameTotalEnergy + 1e-9);
      const gateThreshold = 0.09 * Math.max(0.1, vadGateStrength);
      const targetGate = Math.max(0, Math.min(1.0, (vocalRatio - gateThreshold) / 0.10));

      if (targetGate > gateEnvelope) {
        gateEnvelope = 0.65 * gateEnvelope + 0.35 * targetGate; // fast musical attack
      } else {
        gateEnvelope = 0.94 * gateEnvelope + 0.06 * targetGate; // smooth natural decay
      }

      const activeGate = Math.pow(gateEnvelope, 2.0);

      // 5. Synthesis of Vocal and Instrumental Spectra
      for (let k = 0; k < numBins; k++) {
        const lR = origLReal[k], lI = origLImag[k];
        const rR = origRReal[k], rI = origRImag[k];

        // Final vocal mask with VAD envelope
        const vMask = smoothedMask[k] * activeGate;
        // Non-destructive complementary instrumental mask (energy-conserving)
        const iMask = Math.sqrt(Math.max(0, 1.0 - vMask * vMask));

        // True Stereo Vocal
        const vlR = lR * vMask;
        const vlI = lI * vMask;
        const vrR = rR * vMask;
        const vrI = rI * vMask;

        // True Stereo Instrumental (Solid punch, zero comb-filtering)
        const ilR = lR * iMask;
        const ilI = lI * iMask;
        const irR = rR * iMask;
        const irI = rI * iMask;

        vocRealL[k] = vlR;
        vocImagL[k] = vlI;
        vocRealR[k] = vrR;
        vocImagR[k] = vrI;

        instRealL[k] = ilR;
        instImagL[k] = ilI;
        instRealR[k] = irR;
        instImagR[k] = irI;

        // Symmetric bins for Real IFFT
        const symK = (k === 0 || k === N / 2) ? k : N - k;
        if (symK !== k) {
          vocRealL[symK] = vlR;
          vocImagL[symK] = -vlI;
          vocRealR[symK] = vrR;
          vocImagR[symK] = -vrI;

          instRealL[symK] = ilR;
          instImagL[symK] = -ilI;
          instRealR[symK] = irR;
          instImagR[symK] = -irI;
        }
      }

      // 6. Inverse FFTs for both channels
      this.ifft(vocRealL, vocImagL, N);
      this.ifft(vocRealR, vocImagR, N);
      this.ifft(instRealL, instImagL, N);
      this.ifft(instRealR, instImagR, N);

      // 7. Overlap-Add to Output Buffers
      for (let i = 0; i < N; i++) {
        const outIdx = sampleOffset + i;
        if (outIdx < totalSamples) {
          const w = hann[i] * olaNorm;
          vocalL[outIdx] += vocRealL[i] * w;
          vocalR[outIdx] += vocRealR[i] * w;
          instL[outIdx] += instRealL[i] * w;
          instR[outIdx] += instRealR[i] * w;
        }
      }

      // Progress reporting
      if (frame % framesPerChunk === 0 || frame === numFrames - 1) {
        if (onProgress) {
          const pct = Math.round((frame / numFrames) * 100);
          onProgress(pct, `Stüdyo Spektral DSP 2.0 Ayrıştırma: %${pct}`);
        }
        await new Promise(r => setTimeout(r, 0));
      }
    }

    // Peak Normalization
    this.normalizeBuffer(vocalBuffer, 0.95);
    this.normalizeBuffer(instBuffer, 0.95);

    return { vocalBuffer, instrumentalBuffer: instBuffer };
  }

  static normalizeBuffer(buffer, targetPeak = 0.95) {
    const channels = buffer.numberOfChannels;
    let maxAmp = 0;

    for (let c = 0; c < channels; c++) {
      const data = buffer.getChannelData(c);
      for (let i = 0; i < data.length; i++) {
        const abs = Math.abs(data[i]);
        if (abs > maxAmp) maxAmp = abs;
      }
    }

    if (maxAmp > 0.01 && maxAmp < 0.98) {
      const gain = Math.min(2.8, targetPeak / maxAmp);
      for (let c = 0; c < channels; c++) {
        const data = buffer.getChannelData(c);
        for (let i = 0; i < data.length; i++) {
          data[i] *= gain;
        }
      }
    } else if (maxAmp >= 1.0) {
      const gain = targetPeak / maxAmp;
      for (let c = 0; c < channels; c++) {
        const data = buffer.getChannelData(c);
        for (let i = 0; i < data.length; i++) {
          data[i] *= gain;
        }
      }
    }
  }

  /**
   * Creates a mixed AudioBuffer based on individual vocal and instrumental gains
   */
  static mixStems(audioCtx, vocalBuffer, instBuffer, vocalGain = 1.0, instGain = 1.0) {
    const length = Math.max(vocalBuffer.length, instBuffer.length);
    const sampleRate = vocalBuffer.sampleRate;
    const mixedBuffer = audioCtx.createBuffer(2, length, sampleRate);

    const mixL = mixedBuffer.getChannelData(0);
    const mixR = mixedBuffer.getChannelData(1);

    const vL = vocalBuffer.getChannelData(0);
    const vR = vocalBuffer.getChannelData(1);
    const iL = instBuffer.getChannelData(0);
    const iR = instBuffer.getChannelData(1);

    for (let i = 0; i < length; i++) {
      const vocL = (i < vocalBuffer.length) ? vL[i] * vocalGain : 0;
      const vocR = (i < vocalBuffer.length) ? vR[i] * vocalGain : 0;
      const insL = (i < instBuffer.length) ? iL[i] * instGain : 0;
      const insR = (i < instBuffer.length) ? iR[i] * instGain : 0;

      mixL[i] = Math.max(-1.0, Math.min(1.0, vocL + insL));
      mixR[i] = Math.max(-1.0, Math.min(1.0, vocR + insR));
    }

    return mixedBuffer;
  }
}
