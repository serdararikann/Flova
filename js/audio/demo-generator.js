/* ====================================================================
   FLOVA AUDIO STUDIO - PROCEDURAL DEMO MUSIC GENERATOR
   Synthesizes an uplifting modern electronic / synthwave audio track
   ==================================================================== */

export class DemoAudioGenerator {
  /**
   * Generates a 16-second synthetic music demo track
   * @param {AudioContext} audioCtx
   * @returns {Promise<AudioBuffer>}
   */
  static async generateDemoTrack(audioCtx) {
    const sampleRate = audioCtx.sampleRate || 44100;
    const duration = 16.0; // 16 seconds demo track (4 bars at 120 BPM)
    const bpm = 120;
    const secondsPerBeat = 60 / bpm;
    const totalSamples = Math.floor(sampleRate * duration);

    // Create an OfflineAudioContext to render music with high fidelity
    const offlineCtx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(
      2,
      totalSamples,
      sampleRate
    );

    // Master bus
    const masterGain = offlineCtx.createGain();
    masterGain.gain.setValueAtTime(0.85, 0);

    // Master limiter/compressor
    const compressor = offlineCtx.createDynamicsCompressor();
    compressor.threshold.setValueAtTime(-12, 0);
    compressor.knee.setValueAtTime(30, 0);
    compressor.ratio.setValueAtTime(12, 0);
    compressor.attack.setValueAtTime(0.003, 0);
    compressor.release.setValueAtTime(0.25, 0);

    masterGain.connect(compressor);
    compressor.connect(offlineCtx.destination);

    // 1. Kick Drum (Punchy electronic 808 style)
    const totalBeats = duration / secondsPerBeat;
    for (let beat = 0; beat < totalBeats; beat++) {
      const t = beat * secondsPerBeat;
      this.playKick(offlineCtx, masterGain, t);
    }

    // 2. Snare / Clap on beats 2 & 4
    for (let beat = 1; beat < totalBeats; beat += 2) {
      const t = beat * secondsPerBeat;
      this.playSnare(offlineCtx, masterGain, t);
    }

    // 3. Hi-Hats (16th notes with velocity groove)
    const total16ths = totalBeats * 4;
    for (let i = 0; i < total16ths; i++) {
      const t = i * (secondsPerBeat / 4);
      const isAccented = i % 4 === 2;
      this.playHiHat(offlineCtx, masterGain, t, isAccented ? 0.45 : 0.2);
    }

    // 4. Bassline (Punchy sawtooth synth bass, progression: Am - F - C - G)
    const chords = [
      { bass: 55.0, name: 'A' },   // A1
      { bass: 43.65, name: 'F' },  // F1
      { bass: 65.41, name: 'C' },  // C2
      { bass: 49.0, name: 'G' }    // G1
    ];

    const barDuration = secondsPerBeat * 4;
    for (let bar = 0; bar < 4; bar++) {
      const chord = chords[bar % chords.length];
      const barStart = bar * barDuration;

      // 8th note rolling bassline
      for (let eighth = 0; eighth < 8; eighth++) {
        const t = barStart + eighth * (secondsPerBeat / 2);
        const freq = chord.bass * (eighth % 2 === 1 ? 2 : 1); // Octave jump
        this.playBassNote(offlineCtx, masterGain, t, freq, secondsPerBeat * 0.4);
      }
    }

    // 5. Stereo Panned Synth Chords / Arpeggio
    const melodyScale = [220, 261.63, 329.63, 392.0, 440, 523.25, 659.25]; // A minor pentatonic
    for (let i = 0; i < total16ths; i++) {
      const t = i * (secondsPerBeat / 4);
      const noteIndex = (i * 3 + (i % 5)) % melodyScale.length;
      const freq = melodyScale[noteIndex];
      const pan = (i % 2 === 0 ? -0.7 : 0.7); // Stereo panned instruments
      this.playSynthLead(offlineCtx, masterGain, t, freq, secondsPerBeat * 0.22, pan);
    }

    // 6. Distinct Center-Panned Singing Vocal Chops ("Ah / Oh / Da" Human Formants)
    const vocalNotes = [
      { beat: 0, freq: 440.0, dur: 1.2, vowel: 'aah' },   // A4
      { beat: 2.5, freq: 392.0, dur: 0.8, vowel: 'ooh' }, // G4
      { beat: 4, freq: 523.25, dur: 1.5, vowel: 'aah' },  // C5
      { beat: 7, freq: 440.0, dur: 0.9, vowel: 'ooh' },   // A4
      { beat: 8, freq: 659.25, dur: 1.2, vowel: 'aah' },  // E5
      { beat: 10.5, freq: 587.33, dur: 0.8, vowel: 'ooh' }, // D5
      { beat: 12, freq: 523.25, dur: 1.8, vowel: 'aah' }, // C5
      { beat: 15, freq: 440.0, dur: 0.9, vowel: 'ooh' }   // A4
    ];

    vocalNotes.forEach(note => {
      const t = note.beat * secondsPerBeat;
      this.playVocalFormant(offlineCtx, masterGain, t, note.freq, note.dur, note.vowel);
    });

    // Render the procedural buffer
    return await offlineCtx.startRendering();
  }

  static playKick(ctx, dest, time) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.frequency.setValueAtTime(150, time);
    osc.frequency.exponentialRampToValueAtTime(38, time + 0.12);

    gain.gain.setValueAtTime(1.0, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.35);

    osc.connect(gain);
    gain.connect(dest);

    osc.start(time);
    osc.stop(time + 0.36);
  }

  static playSnare(ctx, dest, time) {
    // Noise buffer
    const bufferSize = ctx.sampleRate * 0.2;
    const noiseBuffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const output = noiseBuffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      output[i] = Math.random() * 2 - 1;
    }

    const whiteNoise = ctx.createBufferSource();
    whiteNoise.buffer = noiseBuffer;

    const filter = ctx.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.setValueAtTime(800, time);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.6, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.18);

    whiteNoise.connect(filter);
    filter.connect(gain);
    gain.connect(dest);

    whiteNoise.start(time);
    whiteNoise.stop(time + 0.19);
  }

  static playHiHat(ctx, dest, time, vol = 0.3) {
    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.setValueAtTime(7500, time);

    const filter = ctx.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.setValueAtTime(6000, time);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(vol, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.05);

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(dest);

    osc.start(time);
    osc.stop(time + 0.06);
  }

  static playBassNote(ctx, dest, time, freq, dur) {
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(freq, time);

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(450, time);
    filter.frequency.exponentialRampToValueAtTime(180, time + dur);
    filter.Q.setValueAtTime(4, time);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.5, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + dur);

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(dest);

    osc.start(time);
    osc.stop(time + dur + 0.05);
  }

  static playSynthLead(ctx, dest, time, freq, dur, pan = 0) {
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(freq, time);

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(freq * 1.5, time);
    filter.Q.setValueAtTime(2, time);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.22, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + dur);

    const panner = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    if (panner) panner.pan.setValueAtTime(pan, time);

    osc.connect(filter);
    filter.connect(gain);
    if (panner) {
      gain.connect(panner);
      panner.connect(dest);
    } else {
      gain.connect(dest);
    }

    osc.start(time);
    osc.stop(time + dur + 0.02);
  }

  static playVocalFormant(ctx, dest, time, freq, dur, vowel = 'aah') {
    // Center-panned Human Vocal Formant Synthesizer (F1 & F2 throat/mouth resonance)
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(freq, time);

    // Vibrato LFO (5Hz pitch modulation for human-like singing)
    const lfo = ctx.createOscillator();
    const lfoGain = ctx.createGain();
    lfo.frequency.setValueAtTime(5.5, time);
    lfoGain.gain.setValueAtTime(3.5, time);
    lfo.connect(osc.frequency);
    lfo.start(time);
    lfo.stop(time + dur + 0.1);

    // Formant filter 1 (F1: 700Hz for Aah, 350Hz for Ooh)
    const f1 = ctx.createBiquadFilter();
    f1.type = 'bandpass';
    f1.frequency.setValueAtTime(vowel === 'aah' ? 750 : 380, time);
    f1.Q.setValueAtTime(4.5, time);

    // Formant filter 2 (F2: 1250Hz for Aah, 850Hz for Ooh)
    const f2 = ctx.createBiquadFilter();
    f2.type = 'bandpass';
    f2.frequency.setValueAtTime(vowel === 'aah' ? 1300 : 850, time);
    f2.Q.setValueAtTime(5.0, time);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.001, time);
    gain.gain.linearRampToValueAtTime(0.45, time + 0.06); // Soft vocal onset
    gain.gain.setValueAtTime(0.45, time + dur - 0.08);
    gain.gain.linearRampToValueAtTime(0.001, time + dur); // Smooth vocal release

    osc.connect(f1);
    osc.connect(f2);
    f1.connect(gain);
    f2.connect(gain);
    gain.connect(dest); // Connected dead-center to destination!

    osc.start(time);
    osc.stop(time + dur + 0.05);
  }
}
