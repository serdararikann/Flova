/**
 * Flova Studio - Auto-Tune (pitch correction), offline. Same method as the mobile app's AutoTune.kt:
 * 1. pitch track with YIN on a ~11 kHz mono copy every 9 ms (voicing by YIN's dip and loudness, isolated frames
 *    dropped, 3-frame median);
 * 2. target: the nearest note of the scale, with hysteresis; the correction glides with a time constant of
 *    `speed` ms (0 = instant, the robotic effect);
 * 3. TD-PSOLA: two-period Hann grains taken at pitch marks (each placed where the waveform best matches the previous
 *    period) and laid down at the corrected period, normalized by the summed windows. Length and timbre stay;
 *    unvoiced parts pass through.
 * Works best on a single voice (a separated vocal).
 */

const HOP_SECONDS = 0.009;
const MIN_F0 = 70;
const MAX_F0 = 1000;
const YIN_THRESHOLD = 0.15;
const SILENCE_RMS = 0.003; // about -50 dBFS
const HYSTERESIS = 0.6; // semitones past the halfway point before switching notes
const UNVOICED_PERIOD_SECONDS = 0.01;

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
   * @param {AudioBuffer} audioBuffer
   * @param {{root?: string, scale?: string, speed?: number, amount?: number}} options speed: retune time in ms
   *   (0 robotic … 80 natural); amount: share of the correction applied (1 = all)
   * @param {BaseAudioContext} audioCtx
   * @returns {AudioBuffer}
   */
  static process(audioBuffer, options = {}, audioCtx) {
    const { root = 'C', scale = 'major', speed = 25, amount = 1 } = options;
    const sr = audioBuffer.sampleRate;
    const length = audioBuffer.length;
    const channels = [];
    for (let c = 0; c < audioBuffer.numberOfChannels; c++) channels.push(audioBuffer.getChannelData(c));
    const out = audioCtx.createBuffer(channels.length, length, sr);
    if (length < sr / 10) {
      channels.forEach((ch, c) => out.copyToChannel(ch, c));
      return out;
    }
    const mono = new Float32Array(length);
    for (const ch of channels) for (let i = 0; i < length; i++) mono[i] += ch[i] / channels.length;

    const allowed = new Set((this.SCALES[scale] || this.SCALES.major).map(n => (n + (this.ROOT_NOTES[root] || 0)) % 12));
    const track = this.trackPitch(mono, sr);
    const ratios = this._correction(track, allowed, speed, amount);
    const marks = this._pitchMarks(mono, sr, track);
    channels.forEach((ch, c) => out.copyToChannel(this._psola(ch, sr, marks, track, ratios), c));
    return out;
  }

  /** Pitch per hop ({f0: Float64Array Hz, 0 = unvoiced; hop: samples at the original rate; sampleRate}). */
  static trackPitch(mono, sr) {
    const factor = Math.max(1, Math.round(sr / 11025));
    const rate = sr / factor;
    const n = Math.floor(mono.length / factor);
    // Box low-pass + decimation: enough for pitch detection
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let k = 0; k < factor; k++) s += mono[i * factor + k];
      x[i] = s / factor;
    }
    const hop = Math.max(1, Math.round(HOP_SECONDS * rate));
    const maxLag = Math.floor(rate / MIN_F0);
    const minLag = Math.max(2, Math.floor(rate / MAX_F0));
    const win = maxLag;
    const frames = Math.max(0, Math.floor((n - win - maxLag) / hop) + 1);
    const f0 = new Float64Array(frames);
    const d = new Float64Array(maxLag + 1);
    for (let f = 0; f < frames; f++) {
      const start = f * hop;
      let energy = 0;
      for (let j = 0; j < win; j++) energy += x[start + j] * x[start + j];
      if (Math.sqrt(energy / win) < SILENCE_RMS) continue;
      // YIN difference function and its cumulative mean normalization
      for (let tau = 1; tau <= maxLag; tau++) {
        let s = 0;
        for (let j = 0; j < win; j++) {
          const diff = x[start + j] - x[start + j + tau];
          s += diff * diff;
        }
        d[tau] = s;
      }
      let running = 0, bestVal = Infinity, bestLag = -1;
      for (let tau = 1; tau <= maxLag; tau++) {
        running += d[tau];
        const norm = running > 0 ? d[tau] * tau / running : 1;
        d[tau] = norm;
        if (tau >= minLag && norm < bestVal) { bestVal = norm; bestLag = tau; }
      }
      let lag = -1;
      for (let tau = minLag; tau <= maxLag; tau++) {
        if (d[tau] < YIN_THRESHOLD) {
          while (tau + 1 <= maxLag && d[tau + 1] < d[tau]) tau++;
          lag = tau;
          break;
        }
      }
      if (lag < 0) {
        if (bestVal < 0.25) lag = bestLag; else continue;
      }
      // Parabolic interpolation around the dip
      let refined = lag;
      if (lag >= 2 && lag < maxLag) {
        const a = d[lag - 1], b = d[lag], c = d[lag + 1];
        const den = a - 2 * b + c;
        if (Math.abs(den) > 1e-12) refined = lag + 0.5 * (a - c) / den;
      }
      f0[f] = rate / refined;
    }
    // Drop isolated voiced frames, then a 3-frame median over voiced runs
    const cleaned = Float64Array.from(f0);
    for (let i = 0; i < f0.length; i++) {
      const prev = i > 0 ? f0[i - 1] : 0;
      const next = i + 1 < f0.length ? f0[i + 1] : 0;
      if (f0[i] > 0 && prev === 0 && next === 0) cleaned[i] = 0;
    }
    const smoothed = Float64Array.from(cleaned);
    for (let i = 1; i < cleaned.length - 1; i++) {
      if (cleaned[i - 1] > 0 && cleaned[i] > 0 && cleaned[i + 1] > 0) {
        smoothed[i] = [cleaned[i - 1], cleaned[i], cleaned[i + 1]].sort((p, q) => p - q)[1];
      }
    }
    return { f0: smoothed, hop: hop * factor, sampleRate: sr };
  }

  static _at(track, sample) {
    const i = Math.min(track.f0.length - 1, Math.max(0, Math.floor(sample / track.hop)));
    return track.f0[i] || 0;
  }

  /** Pitch ratio per hop (1 where unvoiced). */
  static _correction(track, allowed, speedMs, amount) {
    const ratios = new Float64Array(track.f0.length).fill(1);
    const hopMs = track.hop * 1000 / track.sampleRate;
    const alpha = speedMs <= 0 ? 1 : 1 - Math.exp(-hopMs / speedMs);
    let target = null;
    let applied = 0;
    for (let i = 0; i < track.f0.length; i++) {
      const f = track.f0[i];
      if (f <= 0) {
        target = null;
        applied *= 0.5;
        continue;
      }
      const midi = 69 + 12 * Math.log2(f / 440);
      if (target === null || Math.abs(midi - target) > 0.5 + HYSTERESIS || !allowed.has(((target % 12) + 12) % 12)) {
        target = this._nearestInScale(midi, allowed);
      } else {
        const nearest = this._nearestInScale(midi, allowed);
        if (nearest !== target && Math.abs(midi - nearest) + HYSTERESIS < Math.abs(midi - target)) target = nearest;
      }
      const wanted = (target - midi) * amount;
      applied += (wanted - applied) * alpha;
      ratios[i] = Math.pow(2, applied / 12);
    }
    return ratios;
  }

  static _nearestInScale(midi, allowed) {
    const rounded = Math.round(midi);
    let best = rounded, bestDist = Infinity;
    for (let t = rounded - 6; t <= rounded + 6; t++) {
      if (allowed.has(((t % 12) + 12) % 12)) {
        const dist = Math.abs(t - midi);
        if (dist < bestDist) { bestDist = dist; best = t; }
      }
    }
    return best;
  }

  /** Analysis marks one period apart, each where the waveform best matches the period before the previous mark. */
  static _pitchMarks(mono, sr, track) {
    const marks = [];
    const unvoiced = Math.round(UNVOICED_PERIOD_SECONDS * sr);
    const n = mono.length;
    let t = 0;
    let voicedBefore = false;
    while (t < n) {
      marks.push(t);
      const f = this._at(track, t);
      if (f <= 0) {
        t += unvoiced;
        voicedBefore = false;
        continue;
      }
      const period = sr / f;
      const p = Math.round(period);
      const predicted = Math.round(t + period);
      const reach = Math.max(1, Math.round(period * 0.25));
      let best = predicted;
      if (voicedBefore || t >= p) {
        let bestScore = -Infinity;
        const half = Math.floor(p / 2);
        for (let k = Math.max(t + 1, predicted - reach); k <= Math.min(n - 1, predicted + reach); k++) {
          let score = 0;
          for (let j = -half; j < half; j++) {
            const a = t + j, b = k + j;
            if (a < 0 || b >= n) continue;
            score += mono[a] * mono[b];
          }
          if (score > bestScore) { bestScore = score; best = k; }
        }
      }
      voicedBefore = true;
      t = Math.max(t + 1, best);
    }
    return marks;
  }

  /** Overlap-adds two-period Hann grains from the analysis marks at synthesis marks spaced by period / ratio. */
  static _psola(x, sr, marks, track, ratios) {
    const n = x.length;
    const out = new Float64Array(n);
    const weight = new Float64Array(n);
    const unvoiced = UNVOICED_PERIOD_SECONDS * sr;
    let ts = marks[0];
    let m = 0;
    while (ts < n) {
      while (m + 1 < marks.length && Math.abs(marks[m + 1] - ts) <= Math.abs(marks[m] - ts)) m++;
      const a = marks[m];
      const f = this._at(track, a);
      const period = f > 0 ? sr / f : unvoiced;
      const ratio = f > 0 ? ratios[Math.min(ratios.length - 1, Math.max(0, Math.floor(a / track.hop)))] : 1;
      const half = Math.max(2, Math.round(period));
      const center = Math.round(ts);
      for (let k = -half; k < half; k++) {
        const src = a + k, dst = center + k;
        if (src < 0 || src >= n || dst < 0 || dst >= n) continue;
        const w = 0.5 - 0.5 * Math.cos(Math.PI * (k + half) / half);
        out[dst] += x[src] * w;
        weight[dst] += w;
      }
      ts += period / ratio;
    }
    // Normalized by the summed windows; where no grain reached (the very edges) the input passes through
    const result = new Float32Array(n);
    for (let i = 0; i < n; i++) result[i] = weight[i] > 0.1 ? out[i] / weight[i] : x[i];
    return result;
  }
}
