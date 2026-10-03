/* ====================================================================
   FLOVA AUDIO STUDIO - AUDIO PROCESSOR & BUFFER MANIPULATOR
   High-performance AudioBuffer trimming, cutting, merging, fading, reversing
   ==================================================================== */

export class AudioProcessor {
  /**
   * Trims an audio buffer keeping only the range [startTime, endTime]
   */
  static trimBuffer(audioCtx, buffer, startTime, endTime) {
    const sampleRate = buffer.sampleRate;
    const channels = buffer.numberOfChannels;

    const startSample = Math.max(0, Math.floor(startTime * sampleRate));
    const endSample = Math.min(buffer.length, Math.floor(endTime * sampleRate));
    const newLength = Math.max(1, endSample - startSample);

    const newBuffer = audioCtx.createBuffer(channels, newLength, sampleRate);

    for (let c = 0; c < channels; c++) {
      const srcData = buffer.getChannelData(c);
      const destData = newBuffer.getChannelData(c);
      for (let i = 0; i < newLength; i++) {
        destData[i] = srcData[startSample + i];
      }
    }

    return newBuffer;
  }

  /**
   * Cuts out (removes) the range [startTime, endTime] and joins the rest seamlessly
   * with a micro-crossfade to eliminate any pop/click at the splice point
   */
  static cutOutRange(audioCtx, buffer, startTime, endTime, crossfadeMs = 8) {
    const sampleRate = buffer.sampleRate;
    const channels = buffer.numberOfChannels;

    const startSample = Math.max(0, Math.floor(startTime * sampleRate));
    const endSample = Math.min(buffer.length, Math.floor(endTime * sampleRate));
    const cutLength = endSample - startSample;

    if (cutLength <= 0) {
      return buffer;
    }

    const newLength = buffer.length - cutLength;
    if (newLength <= 0) {
      return audioCtx.createBuffer(channels, sampleRate, sampleRate);
    }

    const newBuffer = audioCtx.createBuffer(channels, newLength, sampleRate);

    // Micro-crossfade around splice point (prevents DC offset or phase pop)
    const isInteriorCut = startSample > 0 && endSample < buffer.length;
    const maxPossibleXfade = isInteriorCut
      ? Math.min(startSample, buffer.length - endSample, Math.floor(cutLength / 2))
      : 0;
    const xfadeSamples = Math.min(Math.floor((crossfadeMs / 1000) * sampleRate), maxPossibleXfade);

    for (let c = 0; c < channels; c++) {
      const srcData = buffer.getChannelData(c);
      const destData = newBuffer.getChannelData(c);

      // Copy before cut
      for (let i = 0; i < startSample; i++) {
        destData[i] = srcData[i];
      }
      // Copy after cut
      for (let i = endSample; i < buffer.length; i++) {
        destData[startSample + (i - endSample)] = srcData[i];
      }

      // Smooth equal-power micro-crossfade at the splice point
      if (xfadeSamples > 2) {
        for (let j = 0; j < xfadeSamples; j++) {
          const ratio = j / xfadeSamples;
          const fadeIn = Math.sin(ratio * Math.PI * 0.5);
          const fadeOut = Math.cos(ratio * Math.PI * 0.5);

          const destIdx = startSample - xfadeSamples + j;
          const preVal = srcData[destIdx];
          const postVal = srcData[endSample + j];
          destData[destIdx] = preVal * fadeOut + postVal * fadeIn;
        }
      }
    }

    return newBuffer;
  }

  /**
   * Silences (mutes) the selected region [startTime, endTime]
   */
  static silenceRange(audioCtx, buffer, startTime, endTime) {
    const sampleRate = buffer.sampleRate;
    const channels = buffer.numberOfChannels;

    const startSample = Math.max(0, Math.floor(startTime * sampleRate));
    const endSample = Math.min(buffer.length, Math.floor(endTime * sampleRate));

    const newBuffer = audioCtx.createBuffer(channels, buffer.length, sampleRate);

    for (let c = 0; c < channels; c++) {
      const srcData = buffer.getChannelData(c);
      const destData = newBuffer.getChannelData(c);
      destData.set(srcData);

      for (let i = startSample; i < endSample; i++) {
        destData[i] = 0;
      }
    }

    return newBuffer;
  }

  /**
   * Reverses an AudioBuffer
   */
  static reverseBuffer(audioCtx, buffer) {
    const channels = buffer.numberOfChannels;
    const newBuffer = audioCtx.createBuffer(channels, buffer.length, buffer.sampleRate);

    for (let c = 0; c < channels; c++) {
      const srcData = buffer.getChannelData(c);
      const destData = newBuffer.getChannelData(c);
      for (let i = 0; i < buffer.length; i++) {
        destData[i] = srcData[buffer.length - 1 - i];
      }
    }

    return newBuffer;
  }

  /**
   * Applies Fade-In and Fade-Out envelopes to an AudioBuffer
   */
  static applyFade(audioCtx, buffer, fadeInSec = 0, fadeOutSec = 0) {
    const sampleRate = buffer.sampleRate;
    const channels = buffer.numberOfChannels;
    const totalSamples = buffer.length;

    const fadeInSamples = Math.min(totalSamples, Math.floor(fadeInSec * sampleRate));
    const fadeOutSamples = Math.min(totalSamples, Math.floor(fadeOutSec * sampleRate));

    const newBuffer = audioCtx.createBuffer(channels, totalSamples, sampleRate);

    for (let c = 0; c < channels; c++) {
      const srcData = buffer.getChannelData(c);
      const destData = newBuffer.getChannelData(c);
      destData.set(srcData);

      // Fade In (Smooth S-curve)
      if (fadeInSamples > 0) {
        for (let i = 0; i < fadeInSamples; i++) {
          const progress = i / fadeInSamples;
          const gain = 0.5 * (1 - Math.cos(Math.PI * progress));
          destData[i] *= gain;
        }
      }

      // Fade Out (Smooth S-curve)
      if (fadeOutSamples > 0) {
        const startFadeOut = totalSamples - fadeOutSamples;
        for (let i = 0; i < fadeOutSamples; i++) {
          const progress = i / fadeOutSamples;
          const gain = 0.5 * (1 + Math.cos(Math.PI * progress));
          destData[startFadeOut + i] *= gain;
        }
      }
    }

    return newBuffer;
  }

  /**
   * Applies Fade-In or Fade-Out directly to a specific region [startTime, endTime] of an AudioBuffer
   */
  static applyFadeRange(audioCtx, buffer, startTime, endTime, type = 'in') {
    const sampleRate = buffer.sampleRate;
    const channels = buffer.numberOfChannels;
    const totalSamples = buffer.length;

    const startSample = Math.max(0, Math.min(totalSamples, Math.floor(startTime * sampleRate)));
    const endSample = Math.max(startSample, Math.min(totalSamples, Math.floor(endTime * sampleRate)));
    const rangeSamples = endSample - startSample;
    if (rangeSamples <= 0) return buffer;

    const newBuffer = audioCtx.createBuffer(channels, totalSamples, sampleRate);

    for (let c = 0; c < channels; c++) {
      const srcData = buffer.getChannelData(c);
      const destData = newBuffer.getChannelData(c);
      destData.set(srcData);

      for (let i = 0; i < rangeSamples; i++) {
        const progress = i / rangeSamples;
        const gain = type === 'in'
          ? 0.5 * (1 - Math.cos(Math.PI * progress))
          : 0.5 * (1 + Math.cos(Math.PI * progress));
        destData[startSample + i] *= gain;
      }
    }

    return newBuffer;
  }

  /**
   * Normalizes an AudioBuffer to target peak dBFS (default -0.1 dBFS, studio safe peak)
   */
  static normalizeBuffer(audioCtx, buffer, targetPeakDb = -0.1) {
    const channels = buffer.numberOfChannels;
    const totalSamples = buffer.length;
    let maxAmp = 0;

    for (let c = 0; c < channels; c++) {
      const data = buffer.getChannelData(c);
      for (let i = 0; i < totalSamples; i++) {
        const abs = Math.abs(data[i]);
        if (abs > maxAmp) maxAmp = abs;
      }
    }

    if (maxAmp < 0.00001) {
      return { buffer, originalPeakDb: -100, gainDb: 0 };
    }

    const targetAmp = Math.pow(10, targetPeakDb / 20);
    const multiplier = targetAmp / maxAmp;
    const originalPeakDb = 20 * Math.log10(maxAmp);
    const gainDb = 20 * Math.log10(multiplier);

    const newBuffer = audioCtx.createBuffer(channels, totalSamples, buffer.sampleRate);
    for (let c = 0; c < channels; c++) {
      const src = buffer.getChannelData(c);
      const dest = newBuffer.getChannelData(c);
      for (let i = 0; i < totalSamples; i++) {
        dest[i] = src[i] * multiplier;
      }
    }

    return {
      buffer: newBuffer,
      originalPeakDb,
      gainDb
    };
  }

  /**
   * Generates mathematical crossfade curves:
   * - 'equal-power': sin/cos DJ curve (keeps energy constant at overlap)
   * - 'exponential': smooth S-curve
   * - 'linear': standard linear slope
   */
  static createFadeCurve(type = 'equal-power', isFadeIn = true, steps = 128) {
    const curve = new Float32Array(steps);
    for (let i = 0; i < steps; i++) {
      const p = i / (steps - 1);
      if (type === 'equal-power') {
        curve[i] = isFadeIn ? Math.sin(p * 0.5 * Math.PI) : Math.cos(p * 0.5 * Math.PI);
      } else if (type === 'exponential') {
        curve[i] = isFadeIn ? 0.5 * (1 - Math.cos(Math.PI * p)) : 0.5 * (1 + Math.cos(Math.PI * p));
      } else {
        curve[i] = isFadeIn ? p : (1 - p);
      }
    }
    return curve;
  }

  /**
   * Merges multiple audio tracks into one single AudioBuffer with seamless crossfading & gapless overlapping
   * Supports 'auto' and 'manual' modes, and 'equal-power' | 'exponential' | 'linear' crossfade curves
   * @param {Array<{ buffer: AudioBuffer, volume?: number, fadeInSec?: number, fadeOutSec?: number }>} trackList
   * @param {number|{ mode?: 'auto'|'manual', crossfadeSec?: number, curve?: 'equal-power'|'linear'|'exponential' }} options
   * @returns {Promise<AudioBuffer>}
   */
  static async mergeTracks(trackList, options = {}) {
    if (!trackList || trackList.length === 0) return null;
    if (trackList.length === 1) {
      const single = trackList[0];
      const hasFade = (single.fadeInSec && single.fadeInSec > 0) || (single.fadeOutSec && single.fadeOutSec > 0);
      const hasVol = single.volume !== undefined && Math.abs(single.volume - 1.0) > 0.01;
      if (!hasFade && !hasVol) {
        return single.buffer;
      }
    }

    const crossfadeSec = typeof options === 'number' 
      ? options 
      : (options.crossfadeSec !== undefined ? options.crossfadeSec : 1.0);
    const mode = typeof options === 'object' && options.mode ? options.mode : 'auto';
    const curveType = typeof options === 'object' && options.curve ? options.curve : 'equal-power';

    const sampleRate = trackList[0].buffer.sampleRate;
    const channels = 2; // Standardize to stereo

    // Step 1: Calculate the exact overlap (crossfade) between each adjacent pair
    const overlaps = [];
    for (let i = 0; i < trackList.length - 1; i++) {
      const curTrack = trackList[i];
      const nextTrack = trackList[i + 1];
      const curDur = curTrack.buffer.duration;
      const nextDur = nextTrack.buffer.duration;

      let overlap = 0;
      if (mode === 'auto') {
        const curFadeOut = curTrack.fadeOutSec || 0;
        const nextFadeIn = nextTrack.fadeInSec || 0;
        if (curFadeOut > 0 || nextFadeIn > 0) {
          overlap = Math.max(curFadeOut, nextFadeIn);
        } else {
          overlap = crossfadeSec > 0 ? crossfadeSec : 1.5;
        }
      } else {
        overlap = crossfadeSec;
      }

      // Safe limit: cannot exceed 48% of either track duration
      const maxAllowed = Math.min(curDur * 0.48, nextDur * 0.48);
      overlap = Math.max(0, Math.min(overlap, maxAllowed));
      overlaps.push(overlap);
    }

    // Step 2: Compute start times for each track along the merged timeline
    const startTimes = [0];
    let totalDuration = trackList[0].buffer.duration;

    for (let i = 0; i < trackList.length - 1; i++) {
      const overlap = overlaps[i];
      const nextStart = Math.max(0, startTimes[i] + trackList[i].buffer.duration - overlap);
      startTimes.push(nextStart);
      totalDuration = nextStart + trackList[i + 1].buffer.duration;
    }

    const totalSamples = Math.max(1, Math.ceil(totalDuration * sampleRate));
    const offlineCtx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(
      channels,
      totalSamples,
      sampleRate
    );

    // Step 3: Schedule each track with sample-accurate gain envelopes
    for (let i = 0; i < trackList.length; i++) {
      const track = trackList[i];
      const buffer = track.buffer;
      const volume = track.volume !== undefined ? track.volume : 1.0;
      const startTime = startTimes[i];
      const duration = buffer.duration;
      const endTime = startTime + duration;

      const source = offlineCtx.createBufferSource();
      source.buffer = buffer;

      const gainNode = offlineCtx.createGain();

      // Fade In Calculation
      let fadeInDuration = 0;
      if (i === 0) {
        fadeInDuration = track.fadeInSec || 0;
      } else {
        const prevOverlap = overlaps[i - 1];
        fadeInDuration = Math.max(track.fadeInSec || 0, prevOverlap);
      }
      fadeInDuration = Math.min(fadeInDuration, duration * 0.48);

      // Fade Out Calculation
      let fadeOutDuration = 0;
      if (i < trackList.length - 1) {
        const curOverlap = overlaps[i];
        fadeOutDuration = Math.max(track.fadeOutSec || 0, curOverlap);
      } else {
        fadeOutDuration = track.fadeOutSec || 0;
      }
      fadeOutDuration = Math.min(fadeOutDuration, duration * 0.48);

      // Schedule Gain Envelope using curves
      if (fadeInDuration > 0.01) {
        const inCurve = AudioProcessor.createFadeCurve(curveType, true, 128);
        if (volume !== 1.0) {
          for (let k = 0; k < inCurve.length; k++) inCurve[k] *= volume;
        }
        gainNode.gain.setValueCurveAtTime(inCurve, startTime, fadeInDuration);
      } else {
        gainNode.gain.setValueAtTime(volume, startTime);
      }

      if (fadeOutDuration > 0.01) {
        const fadeOutStartTime = Math.max(startTime + fadeInDuration, endTime - fadeOutDuration);
        const outCurve = AudioProcessor.createFadeCurve(curveType, false, 128);
        if (volume !== 1.0) {
          for (let k = 0; k < outCurve.length; k++) outCurve[k] *= volume;
        }
        gainNode.gain.setValueCurveAtTime(outCurve, fadeOutStartTime, fadeOutDuration);
      } else {
        gainNode.gain.setValueAtTime(volume, endTime);
      }

      source.connect(gainNode);
      gainNode.connect(offlineCtx.destination);

      source.start(startTime);
    }

    return await offlineCtx.startRendering();
  }

  /**
   * Renders an AudioBuffer through the full DSP Effects Rack offline
   */
  static async renderEffectsOffline(buffer, fxParams) {
    const sampleRate = buffer.sampleRate;
    const channels = 2;
    const totalSamples = Math.floor(buffer.length / (fxParams.playbackRate || 1.0));

    const offlineCtx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(
      channels,
      totalSamples + Math.floor(sampleRate * 2.0), // Reverb tail headroom
      sampleRate
    );

    const source = offlineCtx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = fxParams.playbackRate || 1.0;

    // 1. EQ
    const eq60 = offlineCtx.createBiquadFilter();
    eq60.type = 'lowshelf';
    eq60.frequency.value = 60;
    eq60.gain.value = fxParams.eq?.band60 || 0;

    const eq250 = offlineCtx.createBiquadFilter();
    eq250.type = 'peaking';
    eq250.frequency.value = 250;
    eq250.gain.value = fxParams.eq?.band250 || 0;

    const eq1000 = offlineCtx.createBiquadFilter();
    eq1000.type = 'peaking';
    eq1000.frequency.value = 1000;
    eq1000.gain.value = fxParams.eq?.band1000 || 0;

    const eq4000 = offlineCtx.createBiquadFilter();
    eq4000.type = 'peaking';
    eq4000.frequency.value = 4000;
    eq4000.gain.value = fxParams.eq?.band4000 || 0;

    const eq12000 = offlineCtx.createBiquadFilter();
    eq12000.type = 'highshelf';
    eq12000.frequency.value = 12000;
    eq12000.gain.value = fxParams.eq?.band12000 || 0;

    source.connect(eq60);
    eq60.connect(eq250);
    eq250.connect(eq1000);
    eq1000.connect(eq4000);
    eq4000.connect(eq12000);

    const postEq = eq12000;

    // 2. Master Gain
    const masterGain = offlineCtx.createGain();
    masterGain.gain.value = fxParams.volume || 1.0;

    // Dry Path
    postEq.connect(masterGain);

    // 3. Reverb if wet > 0
    if (fxParams.reverbWet > 0) {
      const conv = offlineCtx.createConvolver();
      const revGain = offlineCtx.createGain();
      revGain.gain.value = fxParams.reverbWet;

      const decay = fxParams.reverbDecay || 2.0;
      const revLen = Math.floor(sampleRate * decay);
      const impulse = offlineCtx.createBuffer(2, revLen, sampleRate);
      for (let c = 0; c < 2; c++) {
        const d = impulse.getChannelData(c);
        for (let i = 0; i < revLen; i++) {
          d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (sampleRate * (decay * 0.45)));
        }
      }
      conv.buffer = impulse;
      postEq.connect(conv);
      conv.connect(revGain);
      revGain.connect(masterGain);
    }

    // 4. Echo if wet > 0
    if (fxParams.echoWet > 0) {
      const delay = offlineCtx.createDelay(2.0);
      delay.delayTime.value = fxParams.echoTime || 0.3;
      const feedback = offlineCtx.createGain();
      feedback.gain.value = fxParams.echoFeedback || 0.3;
      const echoGain = offlineCtx.createGain();
      echoGain.gain.value = fxParams.echoWet;

      postEq.connect(delay);
      delay.connect(feedback);
      feedback.connect(delay);
      delay.connect(echoGain);
      echoGain.connect(masterGain);
    }

    masterGain.connect(offlineCtx.destination);
    source.start(0);

    return await offlineCtx.startRendering();
  }
}
