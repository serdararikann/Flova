/**
 * Flova Studio - Mastering Compressor & LUFS Normalizer Rack
 * Professional dynamic range control, broadcast limiting, and target loudness calibration.
 */

export class MasteringRack {
  constructor(audioCtx) {
    this.ctx = audioCtx;

    // Dynamics Compressor Node
    this.compressor = this.ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -18; // dB
    this.compressor.knee.value = 6;       // dB
    this.compressor.ratio.value = 3.0;    // 3:1
    this.compressor.attack.value = 0.005; // 5ms
    this.compressor.release.value = 0.15; // 150ms

    // Post-compression Makeup Gain
    this.makeupGain = this.ctx.createGain();
    this.makeupGain.gain.value = 1.0;

    // Peak Soft Limiter (Waveshaper)
    this.limiter = this.ctx.createWaveShaper();
    this.limiter.curve = this._createLimiterCurve();
    this.limiter.oversample = '4x';

    // Bypass switch
    this.bypassGain = this.ctx.createGain();
    this.bypassGain.gain.value = 1.0;
    this.isBypassed = true;

    // Connections
    this.input = this.ctx.createGain();
    this.output = this.ctx.createGain();

    this._updateRouting();
  }

  _updateRouting() {
    try { this.input.disconnect(); } catch (e) {}
    try { this.compressor.disconnect(); } catch (e) {}
    try { this.makeupGain.disconnect(); } catch (e) {}
    try { this.limiter.disconnect(); } catch (e) {}

    if (this.isBypassed) {
      this.input.connect(this.output);
    } else {
      this.input.connect(this.compressor);
      this.compressor.connect(this.makeupGain);
      this.makeupGain.connect(this.limiter);
      this.limiter.connect(this.output);
    }
  }

  setBypass(bypassed) {
    this.isBypassed = !!bypassed;
    this._updateRouting();
  }

  applyPreset(presetName) {
    switch (presetName) {
      case 'spotify': // -14 LUFS standard streaming
        this.isBypassed = false;
        this.compressor.threshold.value = -16;
        this.compressor.ratio.value = 3.2;
        this.compressor.attack.value = 0.008;
        this.compressor.release.value = 0.2;
        this.makeupGain.gain.value = 1.35;
        break;

      case 'youtube': // -14 LUFS with slightly more vocal forward dynamic
        this.isBypassed = false;
        this.compressor.threshold.value = -15;
        this.compressor.ratio.value = 2.8;
        this.compressor.attack.value = 0.005;
        this.compressor.release.value = 0.18;
        this.makeupGain.gain.value = 1.4;
        break;

      case 'podcast': // -16 LUFS broadcast voice clarity
        this.isBypassed = false;
        this.compressor.threshold.value = -20;
        this.compressor.ratio.value = 4.0;
        this.compressor.attack.value = 0.003;
        this.compressor.release.value = 0.1;
        this.makeupGain.gain.value = 1.6;
        break;

      case 'club': // -9 LUFS loud EDM / Dance punch
        this.isBypassed = false;
        this.compressor.threshold.value = -24;
        this.compressor.ratio.value = 6.0;
        this.compressor.attack.value = 0.015;
        this.compressor.release.value = 0.08;
        this.makeupGain.gain.value = 2.2;
        break;

      case 'bypass':
      default:
        this.isBypassed = true;
        break;
    }
    this._updateRouting();
  }

  /**
   * Return current real-time gain reduction in dB
   */
  getGainReductionDb() {
    if (this.isBypassed) return 0;
    return this.compressor.reduction; // already in negative dB
  }

  /**
   * Brickwall / Soft-Clipping Limiter Curve
   */
  _createLimiterCurve() {
    const samples = 4096;
    const curve = new Float32Array(samples);
    const deg = Math.PI / 180;

    for (let i = 0; i < samples; i++) {
      const x = (i * 2) / samples - 1;
      // Hyperbolic tangent soft knee saturation curve
      curve[i] = Math.tanh(x * 1.05) / Math.tanh(1.05);
    }
    return curve;
  }

  /**
   * Offline LUFS / Peak Normalization of an AudioBuffer
   * @param {AudioBuffer} audioBuffer 
   * @param {number} targetLufs default -14 dB
   * @param {AudioContext} audioCtx
   * @returns {AudioBuffer}
   */
  static normalizeBuffer(audioBuffer, targetLufs = -14, audioCtx) {
    if (!audioBuffer) return audioBuffer;

    const numChannels = audioBuffer.numberOfChannels;
    const length = audioBuffer.length;
    const sampleRate = audioBuffer.sampleRate;

    // Approximate integrated loudness using K-weighting / RMS
    let sumSquares = 0;
    const totalSamples = length * numChannels;

    for (let c = 0; c < numChannels; c++) {
      const data = audioBuffer.getChannelData(c);
      for (let i = 0; i < length; i++) {
        sumSquares += data[i] * data[i];
      }
    }

    const currentRms = Math.sqrt(sumSquares / (totalSamples + 1e-6));
    const currentRmsDb = 20 * Math.log10(Math.max(1e-5, currentRms));

    // Approximate LUFS: RMS dB - 3dB
    const estimatedLufs = currentRmsDb - 3.0;
    const gainDb = targetLufs - estimatedLufs;
    const gainLinear = Math.pow(10, gainDb / 20);

    // Create normalized buffer with peak limiting to avoid clipping
    const outBuffer = audioCtx.createBuffer(numChannels, length, sampleRate);

    for (let c = 0; c < numChannels; c++) {
      const src = audioBuffer.getChannelData(c);
      const dst = outBuffer.getChannelData(c);

      for (let i = 0; i < length; i++) {
        let val = src[i] * gainLinear;
        // Soft ceiling at -0.1 dB (0.988)
        if (val > 0.98) val = 0.98 + (val - 0.98) * 0.1;
        if (val < -0.98) val = -0.98 + (val + 0.98) * 0.1;
        dst[i] = Math.max(-0.999, Math.min(0.999, val));
      }
    }

    return outBuffer;
  }
}
