/* ====================================================================
   FLOVA AUDIO STUDIO - AUDIO EFFECTS RACK
   Realtime Web Audio DSP: 5-Band EQ, Reverb, Echo, Pan & Gain
   ==================================================================== */

export class AudioEffectsRack {
  constructor(audioCtx) {
    this.ctx = audioCtx;

    // Effect Parameters State
    this.params = {
      volume: 1.0,        // 0.0 to 3.0
      playbackRate: 1.0,  // 0.25 to 2.0
      pan: 0.0,           // -1.0 (L) to +1.0 (R)
      autoPan: false,     // 8D Audio simulation
      reverbWet: 0.0,     // 0.0 to 1.0
      reverbDecay: 2.0,   // seconds
      echoTime: 0.3,      // seconds
      echoFeedback: 0.0,  // 0.0 to 0.9
      echoWet: 0.0,       // 0.0 to 1.0
      eq: {
        band60: 0,        // -15 to +15 dB (Bass)
        band250: 0,       // -15 to +15 dB (Low-Mid)
        band1000: 0,      // -15 to +15 dB (Mid)
        band4000: 0,      // -15 to +15 dB (High-Mid)
        band12000: 0      // -15 to +15 dB (Treble)
      }
    };

    this.initNodes();
  }

  initNodes() {
    const ctx = this.ctx;

    // Input Bus
    this.inputNode = ctx.createGain();

    // 1. Equalizer Filter Chain
    this.eqFilters = {
      band60: ctx.createBiquadFilter(),
      band250: ctx.createBiquadFilter(),
      band1000: ctx.createBiquadFilter(),
      band4000: ctx.createBiquadFilter(),
      band12000: ctx.createBiquadFilter()
    };

    this.eqFilters.band60.type = 'lowshelf';
    this.eqFilters.band60.frequency.value = 60;

    this.eqFilters.band250.type = 'peaking';
    this.eqFilters.band250.frequency.value = 250;
    this.eqFilters.band250.Q.value = 1.0;

    this.eqFilters.band1000.type = 'peaking';
    this.eqFilters.band1000.frequency.value = 1000;
    this.eqFilters.band1000.Q.value = 1.0;

    this.eqFilters.band4000.type = 'peaking';
    this.eqFilters.band4000.frequency.value = 4000;
    this.eqFilters.band4000.Q.value = 1.0;

    this.eqFilters.band12000.type = 'highshelf';
    this.eqFilters.band12000.frequency.value = 12000;

    // Connect EQ filters in series
    this.inputNode.connect(this.eqFilters.band60);
    this.eqFilters.band60.connect(this.eqFilters.band250);
    this.eqFilters.band250.connect(this.eqFilters.band1000);
    this.eqFilters.band1000.connect(this.eqFilters.band4000);
    this.eqFilters.band4000.connect(this.eqFilters.band12000);

    const postEqNode = this.eqFilters.band12000;

    // 2. Echo / Delay Effect (Dry / Wet topology)
    this.delayNode = ctx.createDelay(2.0);
    this.delayNode.delayTime.value = this.params.echoTime;

    this.delayFeedbackNode = ctx.createGain();
    this.delayFeedbackNode.gain.value = this.params.echoFeedback;

    this.delayWetNode = ctx.createGain();
    this.delayWetNode.gain.value = this.params.echoWet;

    // Echo feedback loop with gentle damping filter
    this.delayFilter = ctx.createBiquadFilter();
    this.delayFilter.type = 'lowpass';
    this.delayFilter.frequency.value = 4000;

    postEqNode.connect(this.delayNode);
    this.delayNode.connect(this.delayFilter);
    this.delayFilter.connect(this.delayFeedbackNode);
    this.delayFeedbackNode.connect(this.delayNode);
    this.delayFilter.connect(this.delayWetNode);

    // 3. Reverb Effect (Convolver)
    this.convolverNode = ctx.createConvolver();
    this.reverbWetNode = ctx.createGain();
    this.reverbWetNode.gain.value = this.params.reverbWet;
    this.updateReverbImpulse();

    postEqNode.connect(this.convolverNode);
    this.convolverNode.connect(this.reverbWetNode);

    // Dry Summing Bus
    this.dryGain = ctx.createGain();
    this.dryGain.gain.value = 1.0;
    postEqNode.connect(this.dryGain);

    // FX Mix Bus (sums dry + delay + reverb)
    this.fxMixBus = ctx.createGain();
    this.dryGain.connect(this.fxMixBus);
    this.delayWetNode.connect(this.fxMixBus);
    this.reverbWetNode.connect(this.fxMixBus);

    // 4. Stereo Panner
    this.pannerNode = ctx.createStereoPanner ? ctx.createStereoPanner() : ctx.createGain();
    if (this.pannerNode.pan) {
      this.pannerNode.pan.value = this.params.pan;
    }
    this.fxMixBus.connect(this.pannerNode);

    // 5. Master Output Gain
    this.masterGain = ctx.createGain();
    this.masterGain.gain.value = this.params.volume;
    this.pannerNode.connect(this.masterGain);

    // Output bus
    this.outputNode = this.masterGain;

    // Start 8D Audio Auto-pan LFO loop
    this.startAutoPanLoop();
  }

  setVolume(val) {
    this.params.volume = Math.max(0, Math.min(3.0, val));
    if (this.masterGain) {
      this.masterGain.gain.setTargetAtTime(this.params.volume, this.ctx.currentTime, 0.02);
    }
  }

  setPan(val) {
    this.params.pan = Math.max(-1.0, Math.min(1.0, val));
    if (this.pannerNode && this.pannerNode.pan) {
      this.pannerNode.pan.setTargetAtTime(this.params.pan, this.ctx.currentTime, 0.02);
    }
  }

  setAutoPan(enabled) {
    this.params.autoPan = !!enabled;
  }

  setEQBand(bandName, gainDb) {
    if (this.eqFilters[bandName]) {
      this.params.eq[bandName] = gainDb;
      this.eqFilters[bandName].gain.setTargetAtTime(gainDb, this.ctx.currentTime, 0.03);
    }
  }

  applyEQPreset(presetName) {
    const presets = {
      flat: { band60: 0, band250: 0, band1000: 0, band4000: 0, band12000: 0 },
      bassBoost: { band60: 8, band250: 4, band1000: 0, band4000: -2, band12000: -3 },
      vocalBoost: { band60: -3, band250: 2, band1000: 6, band4000: 4, band12000: 2 },
      electronic: { band60: 6, band250: 1, band1000: -2, band4000: 3, band12000: 7 },
      acoustic: { band60: 3, band250: 2, band1000: 1, band4000: 4, band12000: 5 },
      rock: { band60: 5, band250: 2, band1000: -3, band4000: 5, band12000: 4 }
    };

    const target = presets[presetName] || presets.flat;
    Object.keys(target).forEach(band => {
      this.setEQBand(band, target[band]);
    });
    return target;
  }

  setEcho(wet, time, feedback) {
    if (wet !== undefined) {
      this.params.echoWet = Math.max(0, Math.min(1, wet));
      this.delayWetNode.gain.setTargetAtTime(this.params.echoWet, this.ctx.currentTime, 0.02);
    }
    if (time !== undefined) {
      this.params.echoTime = Math.max(0.05, Math.min(1.5, time));
      this.delayNode.delayTime.setTargetAtTime(this.params.echoTime, this.ctx.currentTime, 0.02);
    }
    if (feedback !== undefined) {
      this.params.echoFeedback = Math.max(0, Math.min(0.85, feedback));
      this.delayFeedbackNode.gain.setTargetAtTime(this.params.echoFeedback, this.ctx.currentTime, 0.02);
    }
  }

  setReverb(wet, decay) {
    if (wet !== undefined) {
      this.params.reverbWet = Math.max(0, Math.min(1, wet));
      this.reverbWetNode.gain.setTargetAtTime(this.params.reverbWet, this.ctx.currentTime, 0.02);
    }
    if (decay !== undefined && decay !== this.params.reverbDecay) {
      this.params.reverbDecay = Math.max(0.5, Math.min(6.0, decay));
      this.updateReverbImpulse();
    }
  }

  updateReverbImpulse() {
    const rate = this.ctx.sampleRate;
    const length = rate * this.params.reverbDecay;
    const impulse = this.ctx.createBuffer(2, length, rate);
    const left = impulse.getChannelData(0);
    const right = impulse.getChannelData(1);

    for (let i = 0; i < length; i++) {
      const decay = Math.exp(-i / (rate * (this.params.reverbDecay * 0.45)));
      left[i] = (Math.random() * 2 - 1) * decay;
      right[i] = (Math.random() * 2 - 1) * decay;
    }

    this.convolverNode.buffer = impulse;
  }

  startAutoPanLoop() {
    let phase = 0;
    const step = () => {
      if (this.params.autoPan && this.pannerNode && this.pannerNode.pan) {
        phase += 0.035;
        const panVal = Math.sin(phase) * 0.85;
        this.pannerNode.pan.setValueAtTime(panVal, this.ctx.currentTime);
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
}
