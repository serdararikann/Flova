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
   * Cuts out (removes) the range [startTime, endTime] and joins the rest
   */
  static cutOutRange(audioCtx, buffer, startTime, endTime) {
    const sampleRate = buffer.sampleRate;
    const channels = buffer.numberOfChannels;

    const startSample = Math.max(0, Math.floor(startTime * sampleRate));
    const endSample = Math.min(buffer.length, Math.floor(endTime * sampleRate));
    const cutLength = endSample - startSample;
    const newLength = buffer.length - cutLength;

    if (newLength <= 0) {
      return audioCtx.createBuffer(channels, sampleRate, sampleRate);
    }

    const newBuffer = audioCtx.createBuffer(channels, newLength, sampleRate);

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
   * Merges multiple audio tracks into one single AudioBuffer with optional crossfade
   * @param {Array<{ buffer: AudioBuffer, volume?: number }>} trackList
   * @param {number} crossfadeSec
   * @returns {Promise<AudioBuffer>}
   */
  static async mergeTracks(trackList, crossfadeSec = 0) {
    if (!trackList || trackList.length === 0) return null;
    if (trackList.length === 1) return trackList[0].buffer;

    const sampleRate = trackList[0].buffer.sampleRate;
    const channels = 2; // Standardize to stereo

    // Calculate total duration considering crossfades
    let totalDuration = 0;
    for (let i = 0; i < trackList.length; i++) {
      const dur = trackList[i].buffer.duration;
      if (i === 0) {
        totalDuration += dur;
      } else {
        const cross = Math.min(crossfadeSec, dur * 0.4, trackList[i - 1].buffer.duration * 0.4);
        totalDuration += dur - cross;
      }
    }

    const totalSamples = Math.max(1, Math.ceil(totalDuration * sampleRate));
    const offlineCtx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(
      channels,
      totalSamples,
      sampleRate
    );

    let currentStartTime = 0;

    for (let i = 0; i < trackList.length; i++) {
      const track = trackList[i];
      const buffer = track.buffer;
      const volume = track.volume !== undefined ? track.volume : 1.0;

      const source = offlineCtx.createBufferSource();
      source.buffer = buffer;

      const gainNode = offlineCtx.createGain();
      gainNode.gain.setValueAtTime(volume, currentStartTime);

      // Apply crossfade in/out curves
      if (i > 0 && crossfadeSec > 0) {
        const cross = Math.min(crossfadeSec, buffer.duration * 0.4);
        gainNode.gain.setValueAtTime(0, currentStartTime);
        gainNode.gain.linearRampToValueAtTime(volume, currentStartTime + cross);
      }

      if (i < trackList.length - 1 && crossfadeSec > 0) {
        const nextDur = trackList[i + 1].buffer.duration;
        const cross = Math.min(crossfadeSec, buffer.duration * 0.4, nextDur * 0.4);
        const fadeOutStart = currentStartTime + buffer.duration - cross;
        gainNode.gain.setValueAtTime(volume, fadeOutStart);
        gainNode.gain.linearRampToValueAtTime(0, currentStartTime + buffer.duration);
      }

      source.connect(gainNode);
      gainNode.connect(offlineCtx.destination);

      source.start(currentStartTime);

      // Advance start time for next track
      if (i < trackList.length - 1) {
        const nextDur = trackList[i + 1].buffer.duration;
        const cross = Math.min(crossfadeSec, buffer.duration * 0.4, nextDur * 0.4);
        currentStartTime += buffer.duration - cross;
      }
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
