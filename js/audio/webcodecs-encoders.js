/* ====================================================================
   FLOVA AUDIO STUDIO - AAC (M4A) & OPUS (OGG) ENCODING
   Uses the browser's WebCodecs AudioEncoder and writes the container
   ourselves: a single-track MP4 (moov in front, so it plays while
   downloading) for AAC and an Ogg stream (RFC 7845) for Opus.
   ==================================================================== */

import { mp4TagsBox, opusTagsPacket } from './media-info.js';

const CODECS = { aac: 'mp4a.40.2', opus: 'opus' };

/** Whether this browser can encode [kind] ('aac' | 'opus') with these settings. */
export async function canEncode(kind, sampleRate = 48000, channels = 2, kbps = 128) {
  if (typeof window.AudioEncoder === 'undefined') return false;
  try {
    const { supported } = await AudioEncoder.isConfigSupported({
      codec: CODECS[kind], sampleRate, numberOfChannels: channels, bitrate: kbps * 1000,
    });
    return !!supported;
  } catch (_) {
    return false;
  }
}

/**
 * Encodes planar float [channels] (one Float32Array per channel) and returns the encoded packets plus the
 * decoder description. [onProgress] gets 0..1; [signal] (AbortSignal) stops it.
 */
async function encodePackets(kind, channels, sampleRate, kbps, onProgress, signal) {
  const packets = [];
  let description = null;
  let failure = null;
  const encoder = new AudioEncoder({
    output: (chunk, meta) => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      packets.push({ data, duration: chunk.duration || 0 });
      if (meta?.decoderConfig?.description && !description) {
        description = new Uint8Array(meta.decoderConfig.description instanceof ArrayBuffer
          ? meta.decoderConfig.description
          : meta.decoderConfig.description.buffer.slice(0));
      }
    },
    error: (e) => { failure = e; },
  });
  const config = { codec: CODECS[kind], sampleRate, numberOfChannels: channels.length, bitrate: kbps * 1000 };
  if (kind === 'aac') config.aac = { format: 'aac' };
  encoder.configure(config);

  const total = channels[0].length;
  const block = 8192;
  for (let start = 0; start < total; start += block) {
    if (signal?.aborted) { encoder.close(); throw new DOMException('İptal edildi', 'AbortError'); }
    if (failure) throw failure;
    const n = Math.min(block, total - start);
    const planar = new Float32Array(n * channels.length);
    channels.forEach((ch, c) => planar.set(ch.subarray(start, start + n), c * n));
    const data = new AudioData({
      format: 'f32-planar', sampleRate, numberOfFrames: n, numberOfChannels: channels.length,
      timestamp: Math.round((start / sampleRate) * 1e6), data: planar,
    });
    encoder.encode(data);
    data.close();
    // Back-pressure: keep the queue short and let the page breathe
    while (encoder.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 1));
    if ((start / block) % 16 === 0) {
      onProgress?.(start / total);
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  await encoder.flush();
  encoder.close();
  if (failure) throw failure;
  onProgress?.(1);
  return { packets, description };
}

/* ------------------------------------------------------------------ */
/* MP4 (AAC)                                                           */
/* ------------------------------------------------------------------ */

const enc = new TextEncoder();

function concat(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

const u8 = (...v) => new Uint8Array(v);
const u16 = (n) => u8((n >> 8) & 255, n & 255);
const u32 = (n) => u8((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
const zeros = (n) => new Uint8Array(n);
const type4 = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 255);

function box(type, ...parts) {
  const body = concat(parts);
  return concat([u32(body.length + 8), type4(type), body]);
}

const fullBox = (type, version, flags, ...parts) => box(type, u8(version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255), ...parts);

const MATRIX = concat([u32(0x00010000), u32(0), u32(0), u32(0), u32(0x00010000), u32(0), u32(0), u32(0), u32(0x40000000)]);
const AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

/** AudioSpecificConfig for AAC-LC when the encoder doesn't hand one over. */
function audioSpecificConfig(sampleRate, channels) {
  const idx = Math.max(0, AAC_RATES.indexOf(sampleRate));
  return u8((2 << 3) | (idx >> 1), ((idx & 1) << 7) | (channels << 3));
}

function descriptor(tag, body) {
  return concat([u8(tag, body.length), body]);
}

function esds(asc, kbps) {
  const bitrate = kbps * 1000;
  const dsi = descriptor(5, asc);
  const dcd = descriptor(4, concat([u8(0x40, 0x15), u8(0, 0x18, 0), u32(bitrate), u32(bitrate), dsi]));
  const sl = descriptor(6, u8(2));
  return fullBox('esds', 0, 0, descriptor(3, concat([u16(0), u8(0), dcd, sl])));
}

function buildMoov({ sampleRate, channels, kbps, sizes, frames, asc, mdatOffset, tags }) {
  const durationMs = Math.round((frames / sampleRate) * 1000);
  const mvhd = fullBox('mvhd', 0, 0, u32(0), u32(0), u32(1000), u32(durationMs), u32(0x00010000), u16(0x0100), zeros(10), MATRIX, zeros(24), u32(2));
  const tkhd = fullBox('tkhd', 0, 3, u32(0), u32(0), u32(1), u32(0), u32(durationMs), zeros(8), u16(0), u16(0), u16(0x0100), u16(0), MATRIX, u32(0), u32(0));
  const mdhd = fullBox('mdhd', 0, 0, u32(0), u32(0), u32(sampleRate), u32(frames), u16(0x55c4), u16(0));
  const hdlr = fullBox('hdlr', 0, 0, u32(0), type4('soun'), zeros(12), enc.encode('SoundHandler\0'));
  const mp4a = box('mp4a', zeros(6), u16(1), zeros(8), u16(channels), u16(16), u16(0), u16(0), u32(sampleRate << 16 >>> 0), esds(asc, kbps));
  const stsd = fullBox('stsd', 0, 0, u32(1), mp4a);
  // Every AAC frame is 1024 samples
  const stts = fullBox('stts', 0, 0, u32(1), u32(sizes.length), u32(1024));
  const stsc = fullBox('stsc', 0, 0, u32(1), u32(1), u32(sizes.length), u32(1));
  const stsz = fullBox('stsz', 0, 0, u32(0), u32(sizes.length), concat(sizes.map(u32)));
  const stco = fullBox('stco', 0, 0, u32(1), u32(mdatOffset));
  const stbl = box('stbl', stsd, stts, stsc, stsz, stco);
  const dref = fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1));
  const minf = box('minf', fullBox('smhd', 0, 0, u16(0), u16(0)), box('dinf', dref), stbl);
  const trak = box('trak', tkhd, box('mdia', mdhd, hdlr, minf));
  const udta = mp4TagsBox(tags, box);
  return udta ? box('moov', mvhd, trak, udta) : box('moov', mvhd, trak);
}

/** AAC-LC in an .m4a file. */
export async function encodeM4a(channels, sampleRate, kbps, tags, onProgress, signal) {
  const { packets, description } = await encodePackets('aac', channels, sampleRate, kbps, onProgress, signal);
  const asc = description && description.length >= 2 ? description : audioSpecificConfig(sampleRate, channels.length);
  const sizes = packets.map((p) => p.data.length);
  const ftyp = box('ftyp', type4('M4A '), u32(0), type4('M4A '), type4('mp42'), type4('isom'));
  const args = { sampleRate, channels: channels.length, kbps, sizes, frames: channels[0].length, asc, tags };
  // The chunk offset depends on the moov size, which doesn't depend on the offset's value
  const probe = buildMoov({ ...args, mdatOffset: 0 });
  const moov = buildMoov({ ...args, mdatOffset: ftyp.length + probe.length + 8 });
  const mdatSize = 8 + sizes.reduce((a, b) => a + b, 0);
  return new Blob([ftyp, moov, u32(mdatSize), type4('mdat'), ...packets.map((p) => p.data)], { type: 'audio/mp4' });
}

/* ------------------------------------------------------------------ */
/* Ogg (Opus)                                                          */
/* ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let k = 0; k < 8; k++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    t[i] = r >>> 0;
  }
  return t;
})();

function oggCrc(bytes) {
  let crc = 0;
  for (let i = 0; i < bytes.length; i++) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ bytes[i]) & 255]) >>> 0;
  return crc;
}

function oggPage(packets, { serial, seq, granule, bos = false, eos = false }) {
  const lacing = [];
  for (const p of packets) {
    let n = p.length;
    while (n >= 255) { lacing.push(255); n -= 255; }
    lacing.push(n);
  }
  const header = new Uint8Array(27 + lacing.length);
  const view = new DataView(header.buffer);
  header.set(type4('OggS'), 0);
  header[5] = (bos ? 2 : 0) | (eos ? 4 : 0);
  view.setUint32(6, granule % 2 ** 32, true);
  view.setUint32(10, Math.floor(granule / 2 ** 32), true);
  view.setUint32(14, serial, true);
  view.setUint32(18, seq, true);
  header[26] = lacing.length;
  header.set(lacing, 27);
  const page = concat([header, ...packets]);
  new DataView(page.buffer).setUint32(22, oggCrc(page), true);
  return page;
}

/** Opus in an .ogg file (48 kHz; [inputRate] is only recorded in the header). */
export async function encodeOggOpus(channels, inputRate, kbps, tags, onProgress, signal) {
  const { packets, description } = await encodePackets('opus', channels, 48000, kbps, onProgress, signal);
  const isHead = description && description.length >= 19 && String.fromCharCode(...description.subarray(0, 8)) === 'OpusHead';
  const preSkip = isHead ? (description[10] | (description[11] << 8)) : 312;
  const head = new Uint8Array(19);
  head.set(type4('OpusHead'));
  head[8] = 1;
  head[9] = channels.length;
  new DataView(head.buffer).setUint16(10, preSkip, true);
  new DataView(head.buffer).setUint32(12, inputRate || 48000, true);

  const serial = (Math.random() * 2 ** 32) >>> 0;
  let seq = 0;
  const pages = [
    oggPage([head], { serial, seq: seq++, granule: 0, bos: true }),
    oggPage([opusTagsPacket(tags)], { serial, seq: seq++, granule: 0 }),
  ];
  const totalFrames = channels[0].length;
  let granule = preSkip;
  let batch = [];
  let segments = 0;
  packets.forEach((p, i) => {
    const segs = Math.floor(p.data.length / 255) + 1;
    if (segments + segs > 255) {
      pages.push(oggPage(batch, { serial, seq: seq++, granule }));
      batch = [];
      segments = 0;
    }
    batch.push(p.data);
    segments += segs;
    granule += p.duration ? Math.round((p.duration * 48000) / 1e6) : 960;
    if (i === packets.length - 1) {
      // The last page's granule marks the real end, so players drop the encoder's padding
      pages.push(oggPage(batch, { serial, seq: seq++, granule: Math.min(granule, preSkip + totalFrames), eos: true }));
    } else if (segments >= 200) {
      pages.push(oggPage(batch, { serial, seq: seq++, granule }));
      batch = [];
      segments = 0;
    }
  });
  return new Blob(pages, { type: 'audio/ogg' });
}
