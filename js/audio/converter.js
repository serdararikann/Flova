/* ====================================================================
   FLOVA AUDIO STUDIO - FORMAT CONVERTER
   The web side of the app's "Dönüştürücü" (audio/Convert.kt): same formats,
   presets, size estimates and options. Everything runs in the browser:
   the file is decoded (resampled by the decoder to the output rate),
   trimmed, mapped to the output channels and encoded; nothing is uploaded.
   ==================================================================== */

import { AudioEncoders } from './audio-encoders.js';
import { encodeFlac } from './flac-encoder.js';
import { canEncode, encodeM4a, encodeOggOpus } from './webcodecs-encoders.js';
import { probeHeader, readTags, readWavTailTags, hasTags, addWavTags, addFlacTags, id3v2Tag } from './media-info.js';

export const FORMATS = {
  wav: { label: 'WAV', ext: 'wav', mime: 'audio/wav', lossless: true },
  flac: { label: 'FLAC', ext: 'flac', mime: 'audio/flac', lossless: true },
  m4a: { label: 'M4A (AAC)', ext: 'm4a', mime: 'audio/mp4', lossless: false },
  opus: { label: 'OGG (Opus)', ext: 'ogg', mime: 'audio/ogg', lossless: false },
  mp3: { label: 'MP3', ext: 'mp3', mime: 'audio/mpeg', lossless: false },
};

export const FORMAT_HINTS = {
  wav: 'Sıkıştırılmamış, her programda açılır; dakikada ~10 MB (16-bit stereo).',
  flac: 'Kayıpsız sıkıştırma (16-bit): WAV ile aynı ses, yaklaşık yarı boyut.',
  m4a: 'AAC: MP3\'ten daha verimli, tüm telefon ve bilgisayarlarda çalar.',
  opus: 'En verimli kayıplı format; düşük bit hızında bile iyi ses. Bazı eski cihazlar desteklemez.',
  mp3: 'Her yerde çalar.',
};

/** Same presets as the app's ConvertPreset. */
export const PRESETS = [
  { id: 'everywhere', label: 'Her yerde çalsın', hint: 'MP3 192 kbps: her cihaz ve programda çalar.', format: 'mp3', kbps: 192 },
  { id: 'voice', label: 'Sesli mesaj', hint: 'OGG Opus 32 kbps mono: WhatsApp/Telegram sesli mesaj formatı, çok küçük dosya.', format: 'opus', kbps: 32, channels: 1 },
  { id: 'ringtone', label: 'Zil sesi', hint: 'M4A 192 kbps: Android ve iPhone zil sesi. Kırp ile 30 sn\'lik bir bölüm seçin.', format: 'm4a', kbps: 192 },
  { id: 'speech', label: 'Konuşma / Podcast', hint: 'M4A 64 kbps mono: konuşma için yeterli kalite, dakikada ~0,5 MB.', format: 'm4a', kbps: 64, sampleRate: 44100, channels: 1 },
  { id: 'studio', label: 'Stüdyo (DAW)', hint: 'WAV 24-bit 48 kHz: video ve müzik programlarında düzenlemek için.', format: 'wav', bitDepth: 24, sampleRate: 48000 },
  { id: 'archive', label: 'Arşiv', hint: 'FLAC: kayıpsız, WAV\'ın yaklaşık yarısı boyutunda.', format: 'flac' },
];

export function presetMatches(p, o, aacKbps) {
  const lossless = FORMATS[p.format].lossless;
  return o.format === p.format && o.sampleRate === (p.sampleRate ?? null) && o.channels === (p.channels ?? null) &&
    (lossless || o.kbps === presetKbps(p, aacKbps)) && (p.format !== 'wav' || o.bitDepth === (p.bitDepth ?? 16));
}

/** Bit rates offered per lossy format (the app's lists). */
export const KBPS = { m4a: [64, 128, 192, 256, 320], opus: [32, 64, 96, 128, 192], mp3: [64, 128, 192, 256, 320] };

export const nearest = (list, k) => list.reduce((best, x) => (Math.abs(x - k) < Math.abs(best - k) ? x : best), list[0]);

/** A preset's bit rate; AAC snaps to what this browser's encoder accepts (Windows: 96–192 kbps). */
let aacKbps = KBPS.m4a;
export function presetKbps(p, list = aacKbps) {
  const k = p.kbps ?? 192;
  return p.format === 'm4a' ? nearest(list, k) : k;
}

/**
 * Formats this browser can make (WAV/FLAC/MP3 always; AAC and Opus need WebCodecs encoders) and the AAC bit rates
 * its encoder takes.
 */
export async function detectFormats() {
  const [m4a, opus] = await Promise.all([canEncode('aac', 44100, 2, 192), canEncode('opus', 48000, 2, 128)]);
  if (m4a) {
    const ok = [];
    for (const k of [64, 96, 128, 160, 192, 256, 320]) if (await canEncode('aac', 44100, 2, k)) ok.push(k);
    if (ok.length) aacKbps = ok;
  }
  return { wav: true, flac: true, mp3: typeof window.lamejs !== 'undefined', m4a, opus, aacKbps };
}

/** AAC is made at 44.1 or 48 kHz (all browser encoders take those; Windows' takes nothing else). */
export const AAC_RATES = [44100, 48000];

export function outputRate(o, inputRate) {
  if (o.format === 'opus') return 48000;
  const r = o.sampleRate || inputRate || 48000;
  if (o.format === 'm4a' && !AAC_RATES.includes(r)) return r > 44100 ? 48000 : 44100;
  return r;
}
export const outputChannels = (o, inputChannels) => Math.max(1, Math.min(2, o.channels || inputChannels || 2));

export function outputSeconds(o, total) {
  const end = Math.min(o.endSeconds ?? total, total);
  return Math.max(0, end - (o.startSeconds || 0));
}

/** Expected output size in bytes (FLAC is approximate), as estimateConvertedBytes in the app. */
export function estimateBytes(info, o) {
  const rate = outputRate(o, info.sampleRate);
  const ch = outputChannels(o, info.channels);
  const s = outputSeconds(o, info.duration || 0);
  if (o.format === 'wav') return s * rate * ch * (o.bitDepth / 8) + 44;
  if (o.format === 'flac') return s * rate * ch * 2 * 0.58;
  return s * o.kbps * 125;
}

export function convertedName(name, format) {
  const base = name.replace(/\.[^/.]+$/, '') || 'flova';
  return `${base}.${FORMATS[format].ext}`;
}

/** Duration from the browser's media element (cheap: no decoding). */
function mediaDuration(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const el = document.createElement(file.type.startsWith('video/') ? 'video' : 'audio');
    const done = (v) => { URL.revokeObjectURL(url); el.removeAttribute('src'); resolve(v); };
    el.preload = 'metadata';
    el.onloadedmetadata = () => done(Number.isFinite(el.duration) ? el.duration : null);
    el.onerror = () => done(null);
    setTimeout(() => done(null), 8000);
    el.src = url;
  });
}

/** { codec, sampleRate, channels, duration, size, lossy, tags } or null when it isn't readable audio. */
export async function probeFile(file) {
  const headBytes = new Uint8Array(await file.slice(0, 256 * 1024).arrayBuffer());
  const header = probeHeader(headBytes);
  const duration = await mediaDuration(file);
  if (!header && duration == null) return null;
  // MP4 keeps its tags (moov) anywhere, often at the end: read the whole file for those, the head for the rest
  const tagBytes = header && /AAC|MP4|Video/.test(header.codec) && file.size > headBytes.length && file.size < 200 * 1024 * 1024
    ? new Uint8Array(await file.arrayBuffer())
    : headBytes;
  let tags = readTags(tagBytes);
  if (header?.codec.startsWith('WAV') && !hasTags(tags) && file.size > headBytes.length) {
    tags = readWavTailTags(new Uint8Array(await file.slice(Math.max(0, file.size - 256 * 1024)).arrayBuffer()));
  }
  return {
    codec: header?.codec || (file.type.split('/')[1] || 'Ses').toUpperCase(),
    sampleRate: header?.sampleRate || null,
    channels: header?.channels || null,
    duration,
    size: file.size,
    lossy: header ? header.lossy : true,
    video: !!header?.video || file.type.startsWith('video/'),
    tags,
  };
}

function abortError() {
  return new DOMException('İptal edildi', 'AbortError');
}

/**
 * Converts [file] (probed as [info]) with options
 * { format, bitDepth, kbps, sampleRate, channels, startSeconds, endSeconds, keepTags } → Blob.
 */
export async function convertFile(file, info, o, onProgress, signal) {
  const report = (p) => onProgress?.(Math.max(0, Math.min(1, p)));
  report(0);
  const rate = outputRate(o, info.sampleRate);

  // 1. Decode at the output rate (the decoder resamples)
  const bytes = await file.arrayBuffer();
  if (signal?.aborted) throw abortError();
  let decoded;
  try {
    const ctx = new OfflineAudioContext(1, 1, rate);
    decoded = await ctx.decodeAudioData(bytes);
  } catch (e) {
    throw new Error('Dosya çözülemedi; bu tarayıcı bu formatı (veya videonun ses izini) okuyamıyor.');
  }
  report(0.15);

  // 2. Trim and map channels
  const from = Math.max(0, Math.floor((o.startSeconds || 0) * rate));
  const to = Math.min(decoded.length, o.endSeconds != null ? Math.floor(o.endSeconds * rate) : decoded.length);
  if (to <= from) throw new Error('Seçilen bölüm boş.');
  const outCh = outputChannels(o, decoded.numberOfChannels);
  const src = Array.from({ length: decoded.numberOfChannels }, (_, c) => decoded.getChannelData(c).subarray(from, to));
  let channels;
  if (outCh === src.length) channels = src;
  else if (outCh === 1) {
    const mono = new Float32Array(to - from);
    for (const ch of src) for (let i = 0; i < mono.length; i++) mono[i] += ch[i] / src.length;
    channels = [mono];
  } else if (src.length === 1) channels = [src[0], src[0]];
  else channels = [src[0], src[1]]; // more than stereo: keep front left/right
  decoded = null;

  const tags = o.keepTags ? info.tags : null;
  const encodeProgress = (p) => report(0.15 + p * 0.85);

  // 3. Encode
  let blob;
  if (o.format === 'wav' || o.format === 'mp3' || o.format === 'flac') {
    // The site's encoders take an AudioBuffer
    const buffer = new AudioBuffer({ numberOfChannels: channels.length, length: channels[0].length, sampleRate: rate });
    channels.forEach((ch, c) => buffer.copyToChannel(ch, c));
    if (o.format === 'wav') {
      const wav = new Uint8Array(await AudioEncoders.bufferToWave(buffer, { bitDepth: o.bitDepth }).arrayBuffer());
      blob = new Blob([addWavTags(wav, tags)], { type: FORMATS.wav.mime });
    } else if (o.format === 'flac') {
      const flac = await encodeFlac(buffer, (p) => { if (signal?.aborted) throw abortError(); encodeProgress(p); });
      blob = new Blob([addFlacTags(flac, tags)], { type: FORMATS.flac.mime });
    } else {
      const mp3 = await AudioEncoders.bufferToMp3(buffer, { kbps: o.kbps }, (p) => { if (signal?.aborted) throw abortError(); encodeProgress(p); });
      blob = new Blob([id3v2Tag(tags), mp3], { type: FORMATS.mp3.mime });
    }
  } else if (o.format === 'm4a') {
    const kbps = (await canEncode('aac', rate, channels.length, o.kbps)) ? o.kbps : nearest(aacKbps, o.kbps);
    if (!(await canEncode('aac', rate, channels.length, kbps))) {
      throw new Error(`Bu tarayıcı AAC'yi bu ayarlarla kodlayamıyor (${rate / 1000} kHz, ${channels.length === 1 ? 'mono' : 'stereo'}).`);
    }
    blob = await encodeM4a(channels, rate, kbps, tags, encodeProgress, signal);
  } else {
    blob = await encodeOggOpus(channels, info.sampleRate, o.kbps, tags, encodeProgress, signal);
  }
  if (signal?.aborted) throw abortError();
  report(1);
  return blob;
}
