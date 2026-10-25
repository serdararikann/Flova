/* ====================================================================
   FLOVA AUDIO STUDIO - MEDIA HEADERS & TAGS
   Reads the codec / sample rate / channels of a file from its header and
   the song tags (title, artist, album, genre, year, track) of MP3 (ID3v2),
   FLAC and Ogg (Vorbis comments), MP4/M4A (iTunes ilst) and WAV (LIST INFO);
   writes them into the converter's outputs (same fields as the app's Tags.kt).
   ==================================================================== */

export const TAG_FIELDS = ['title', 'artist', 'album', 'genre', 'year', 'track'];

const latin1 = new TextDecoder('latin1');
const utf8 = new TextDecoder('utf-8');
const utf8Enc = new TextEncoder();

const str4 = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
const u16be = (b, o) => (b[o] << 8) | b[o + 1];
const u32be = (b, o) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
const u16le = (b, o) => b[o] | (b[o + 1] << 8);
const u32le = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + ((b[o + 3] << 24) >>> 0);
const syncsafe = (b, o) => (b[o] << 21) | (b[o + 1] << 14) | (b[o + 2] << 7) | b[o + 3];

function indexOfAscii(b, text, from = 0, to = b.length) {
  const t = [...text].map((c) => c.charCodeAt(0));
  outer: for (let i = from; i <= to - t.length; i++) {
    for (let k = 0; k < t.length; k++) if (b[i + k] !== t[k]) continue outer;
    return i;
  }
  return -1;
}

/* ------------------------------------------------------------------ */
/* Header probe                                                        */
/* ------------------------------------------------------------------ */

const MP3_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
const ADTS_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

/**
 * { codec, sampleRate, channels, lossy } from the first bytes of a file; sampleRate/channels are null when the
 * header doesn't say (the converter then decodes at 48 kHz). Returns null for bytes that aren't a known audio/video file.
 */
export function probeHeader(b) {
  if (b.length < 12) return null;
  const head = str4(b, 0);

  if (head === 'RIFF' && str4(b, 8) === 'WAVE') {
    for (let o = 12; o + 8 <= b.length;) {
      const id = str4(b, o), size = u32le(b, o + 4);
      if (id === 'fmt ') {
        const format = u16le(b, o + 8);
        return { codec: format === 3 ? 'WAV (float)' : 'WAV', channels: u16le(b, o + 10), sampleRate: u32le(b, o + 12), lossy: false };
      }
      o += 8 + size + (size & 1);
    }
    return { codec: 'WAV', channels: null, sampleRate: null, lossy: false };
  }

  if (head === 'fLaC') {
    // STREAMINFO: 20-bit rate and 3-bit channels-1 at byte 18 of the file
    const rate = (b[18] << 12) | (b[19] << 4) | (b[20] >> 4);
    return { codec: 'FLAC', sampleRate: rate, channels: ((b[20] >> 1) & 7) + 1, lossy: false };
  }

  if (head === 'OggS') {
    const opus = indexOfAscii(b, 'OpusHead', 0, Math.min(b.length, 512));
    if (opus >= 0) return { codec: 'Opus', sampleRate: 48000, channels: b[opus + 9], lossy: true };
    const vorbis = indexOfAscii(b, '\x01vorbis', 0, Math.min(b.length, 512));
    if (vorbis >= 0) return { codec: 'Vorbis', sampleRate: u32le(b, vorbis + 12), channels: b[vorbis + 11], lossy: true };
    if (indexOfAscii(b, 'fLaC', 0, 512) >= 0) return { codec: 'FLAC', sampleRate: null, channels: null, lossy: false };
    return { codec: 'Ogg', sampleRate: null, channels: null, lossy: true };
  }

  if (str4(b, 4) === 'ftyp') {
    const video = /^(qt  |mp4|iso|avc|3gp|M4V)/.test(str4(b, 8)) && indexOfAscii(b, 'vide') >= 0;
    // mp4a sample entry: 8 reserved + 8 (version, revision, vendor), then channels, sample size, 4 bytes, rate 16.16
    const entry = indexOfAscii(b, 'mp4a');
    if (entry >= 0 && entry + 30 < b.length) {
      const base = entry + 4 + 16;
      return { codec: 'AAC', channels: u16be(b, base), sampleRate: u16be(b, base + 8), lossy: true, video };
    }
    return { codec: video ? 'Video' : 'MP4', sampleRate: null, channels: null, lossy: true, video };
  }

  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) {
    return { codec: 'WebM', sampleRate: null, channels: null, lossy: true, video: indexOfAscii(b, 'V_VP') >= 0 || indexOfAscii(b, 'V_AV1') >= 0 };
  }

  // ADTS AAC
  if (b[0] === 0xff && (b[1] & 0xf6) === 0xf0) {
    return { codec: 'AAC', sampleRate: ADTS_RATES[(b[2] >> 2) & 15] || null, channels: ((b[2] & 1) << 2) | (b[3] >> 6) || null, lossy: true };
  }

  // MP3 (after an optional ID3v2 tag)
  let o = 0;
  if (str4(b, 0).startsWith('ID3')) o = 10 + syncsafe(b, 6);
  for (let i = o; i < Math.min(b.length - 4, o + 65536); i++) {
    if (b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) continue;
    const version = (b[i + 1] >> 3) & 3, layer = (b[i + 1] >> 1) & 3, rateIdx = (b[i + 2] >> 2) & 3;
    if (version === 1 || layer === 0 || rateIdx === 3 || (b[i + 2] >> 4) === 15) continue;
    return { codec: layer === 1 ? 'MP3' : 'MPEG', sampleRate: MP3_RATES[version][rateIdx], channels: (b[i + 3] >> 6) === 3 ? 1 : 2, lossy: true };
  }
  if (o > 0) return { codec: 'MP3', sampleRate: null, channels: null, lossy: true };
  return null;
}

/* ------------------------------------------------------------------ */
/* Tag reading                                                         */
/* ------------------------------------------------------------------ */

function clean(tags) {
  const out = {};
  for (const k of TAG_FIELDS) {
    const v = (tags[k] ?? '').toString().replace(/\0+$/g, '').trim();
    if (v) out[k] = v;
  }
  return out;
}

function decodeId3Text(b, o, end) {
  const enc = b[o];
  const body = b.subarray(o + 1, end);
  if (enc === 0) return latin1.decode(body);
  if (enc === 3) return utf8.decode(body);
  if (enc === 1) return new TextDecoder(body[0] === 0xfe ? 'utf-16be' : 'utf-16le').decode(body.subarray(2));
  return new TextDecoder('utf-16be').decode(body);
}

function readId3(b) {
  const major = b[3];
  const size = syncsafe(b, 6);
  const map = { TIT2: 'title', TPE1: 'artist', TALB: 'album', TCON: 'genre', TYER: 'year', TDRC: 'year', TRCK: 'track' };
  const tags = {};
  let o = 10;
  if (b[5] & 0x40) o += major === 4 ? syncsafe(b, 10) : 4 + u32be(b, 10); // extended header
  while (o + 10 <= Math.min(b.length, 10 + size)) {
    const id = str4(b, o);
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const len = major === 4 ? syncsafe(b, o + 4) : u32be(b, o + 4);
    if (len <= 0 || o + 10 + len > b.length) break;
    if (map[id] && !tags[map[id]]) tags[map[id]] = decodeId3Text(b, o + 10, o + 10 + len);
    o += 10 + len;
  }
  // "(13)" or "Rock" genres; "3/12" track numbers
  if (tags.genre) tags.genre = tags.genre.replace(/^\(\d+\)/, '').trim() || tags.genre;
  if (tags.track) tags.track = tags.track.split('/')[0];
  if (tags.year) tags.year = tags.year.slice(0, 4);
  return tags;
}

function readVorbisComments(b, o) {
  const tags = {};
  const vendorLen = u32le(b, o);
  o += 4 + vendorLen;
  const count = u32le(b, o);
  o += 4;
  const map = { TITLE: 'title', ARTIST: 'artist', ALBUM: 'album', GENRE: 'genre', DATE: 'year', YEAR: 'year', TRACKNUMBER: 'track' };
  for (let i = 0; i < count && o + 4 <= b.length; i++) {
    const len = u32le(b, o);
    const text = utf8.decode(b.subarray(o + 4, o + 4 + len));
    o += 4 + len;
    const eq = text.indexOf('=');
    const key = map[text.slice(0, eq).toUpperCase()];
    if (key && !tags[key]) tags[key] = text.slice(eq + 1);
  }
  if (tags.year) tags.year = tags.year.slice(0, 4);
  if (tags.track) tags.track = tags.track.split('/')[0];
  return tags;
}

function readFlacTags(b) {
  for (let o = 4; o + 4 <= b.length;) {
    const last = b[o] & 0x80, type = b[o] & 0x7f;
    const len = (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3];
    if (type === 4) return readVorbisComments(b, o + 4);
    if (last) break;
    o += 4 + len;
  }
  return {};
}

function readOggTags(b) {
  const limit = Math.min(b.length, 1 << 20);
  const opus = indexOfAscii(b, 'OpusTags', 0, limit);
  if (opus >= 0) return readVorbisComments(b, opus + 8);
  const vorbis = indexOfAscii(b, '\x03vorbis', 0, limit);
  if (vorbis >= 0) return readVorbisComments(b, vorbis + 7);
  return {};
}

function* boxes(b, from, to) {
  for (let o = from; o + 8 <= to;) {
    let size = u32be(b, o);
    const type = str4(b, o + 4);
    let header = 8;
    if (size === 1) { size = u32be(b, o + 8) * 2 ** 32 + u32be(b, o + 12); header = 16; }
    if (size === 0) size = to - o;
    if (size < header) return;
    yield { type, start: o, body: o + header, end: Math.min(o + size, to) };
    o += size;
  }
}

function child(b, parent, type) {
  for (const box of boxes(b, parent.body, parent.end)) if (box.type === type) return box;
  return null;
}

function readMp4Tags(b) {
  let moov = null;
  for (const box of boxes(b, 0, b.length)) if (box.type === 'moov') moov = box;
  const udta = moov && child(b, moov, 'udta');
  const meta = udta && child(b, udta, 'meta');
  if (!meta) return {};
  const ilst = child(b, { body: meta.body + 4, end: meta.end }, 'ilst');
  if (!ilst) return {};
  const map = { '\xa9nam': 'title', '\xa9ART': 'artist', 'aART': 'artist', '\xa9alb': 'album', '\xa9gen': 'genre', '\xa9day': 'year', trkn: 'track' };
  const tags = {};
  for (const item of boxes(b, ilst.body, ilst.end)) {
    const key = map[item.type];
    const data = key && child(b, item, 'data');
    if (!data || tags[key]) continue;
    const value = b.subarray(data.body + 8, data.end);
    tags[key] = key === 'track' ? String(u16be(value, 2) || '') : utf8.decode(value);
  }
  if (tags.year) tags.year = tags.year.slice(0, 4);
  return tags;
}

/** Tags of the LIST/INFO chunk starting at [o] ("LIST" at o). */
function readInfoList(b, o, tags = {}) {
  const map = { INAM: 'title', IART: 'artist', IPRD: 'album', IGNR: 'genre', ICRD: 'year', ITRK: 'track', IPRT: 'track' };
  const end = Math.min(b.length, o + 8 + u32le(b, o + 4));
  for (let p = o + 12; p + 8 <= end;) {
    const sub = str4(b, p), len = u32le(b, p + 4);
    if (map[sub] && !tags[map[sub]]) tags[map[sub]] = utf8.decode(b.subarray(p + 8, Math.min(end, p + 8 + len)));
    p += 8 + len + (len & 1);
  }
  return tags;
}

function readWavInfo(b) {
  for (let o = 12; o + 8 <= b.length;) {
    const id = str4(b, o), size = u32le(b, o + 4);
    if (id === 'LIST' && str4(b, o + 8) === 'INFO') return readInfoList(b, o);
    o += 8 + size + (size & 1);
  }
  return {};
}

/** WAV tags from the file's last bytes, where the LIST chunk usually is (after the audio). */
export function readWavTailTags(tail) {
  for (let i = tail.length - 12; i >= 0; i--) {
    if (tail[i] === 0x4c && str4(tail, i) === 'LIST' && str4(tail, i + 8) === 'INFO') return clean(readInfoList(tail, i));
  }
  return {};
}

/** Song tags of a whole file's bytes ({} when there are none or the format has none we read). */
export function readTags(b) {
  try {
    const head = str4(b, 0);
    if (head.startsWith('ID3')) return clean(readId3(b));
    if (head === 'fLaC') return clean(readFlacTags(b));
    if (head === 'OggS') return clean(readOggTags(b));
    if (str4(b, 4) === 'ftyp') return clean(readMp4Tags(b));
    if (head === 'RIFF') return clean(readWavInfo(b));
  } catch (e) {
    console.warn('[Flova] Etiketler okunamadı:', e);
  }
  return {};
}

export const hasTags = (tags) => !!tags && TAG_FIELDS.some((k) => tags[k]);

/* ------------------------------------------------------------------ */
/* Tag writing                                                         */
/* ------------------------------------------------------------------ */

function concat(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

const be32 = (n) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const le32 = (n) => new Uint8Array([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]);
const ascii = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 255);

/** WAV with a LIST/INFO chunk appended after the audio (RIFF size patched). */
export function addWavTags(bytes, tags) {
  if (!hasTags(tags)) return bytes;
  const ids = { title: 'INAM', artist: 'IART', album: 'IPRD', genre: 'IGNR', year: 'ICRD', track: 'ITRK' };
  const subs = [];
  for (const k of TAG_FIELDS) {
    if (!tags[k]) continue;
    const text = concat([utf8Enc.encode(tags[k]), new Uint8Array(1)]);
    subs.push(ascii(ids[k]), le32(text.length), text);
    if (text.length & 1) subs.push(new Uint8Array(1));
  }
  const body = concat([ascii('INFO'), ...subs]);
  const out = concat([bytes, ascii('LIST'), le32(body.length), body]);
  new DataView(out.buffer).setUint32(4, out.length - 8, true);
  return out;
}

function vorbisCommentBody(tags) {
  const keys = { title: 'TITLE', artist: 'ARTIST', album: 'ALBUM', genre: 'GENRE', year: 'DATE', track: 'TRACKNUMBER' };
  const vendor = utf8Enc.encode('Flova Audio Studio');
  const parts = [le32(vendor.length), vendor];
  const comments = TAG_FIELDS.filter((k) => tags[k]).map((k) => utf8Enc.encode(`${keys[k]}=${tags[k]}`));
  parts.push(le32(comments.length));
  for (const c of comments) parts.push(le32(c.length), c);
  return concat(parts);
}

/** FLAC from encodeFlac (STREAMINFO only) with a VORBIS_COMMENT block after STREAMINFO. */
export function addFlacTags(bytes, tags) {
  if (!hasTags(tags)) return bytes;
  const body = vorbisCommentBody(tags);
  const streaminfoEnd = 4 + 4 + 34;
  const head = bytes.slice(0, streaminfoEnd);
  head[4] &= 0x7f; // STREAMINFO is no longer the last block
  const block = concat([new Uint8Array([0x84, (body.length >> 16) & 255, (body.length >> 8) & 255, body.length & 255]), body]);
  return concat([head, block, bytes.subarray(streaminfoEnd)]);
}

/** ID3v2.3 tag (UTF-16 text frames) to put in front of an MP3. */
export function id3v2Tag(tags) {
  if (!hasTags(tags)) return new Uint8Array(0);
  const ids = { title: 'TIT2', artist: 'TPE1', album: 'TALB', genre: 'TCON', year: 'TYER', track: 'TRCK' };
  const frames = [];
  for (const k of TAG_FIELDS) {
    if (!tags[k]) continue;
    const text = new Uint8Array(2 + tags[k].length * 2);
    text[0] = 0xff; text[1] = 0xfe; // BOM, UTF-16LE
    for (let i = 0; i < tags[k].length; i++) {
      const c = tags[k].charCodeAt(i);
      text[2 + i * 2] = c & 255;
      text[3 + i * 2] = c >> 8;
    }
    const data = concat([new Uint8Array([1]), text]);
    frames.push(ascii(ids[k]), be32(data.length), new Uint8Array(2), data);
  }
  const body = concat(frames);
  const n = body.length;
  return concat([ascii('ID3'), new Uint8Array([3, 0, 0, (n >> 21) & 127, (n >> 14) & 127, (n >> 7) & 127, n & 127]), body]);
}

/** "OpusTags" packet for an Ogg Opus stream (always written; empty comments when there are no tags). */
export function opusTagsPacket(tags) {
  return concat([ascii('OpusTags'), vorbisCommentBody(tags || {})]);
}

/** iTunes-style udta/meta/ilst box for an M4A (null when there are no tags). */
export function mp4TagsBox(tags, box) {
  if (!hasTags(tags)) return null;
  const types = { title: '\xa9nam', artist: '\xa9ART', album: '\xa9alb', genre: '\xa9gen', year: '\xa9day', track: 'trkn' };
  const items = [];
  for (const k of TAG_FIELDS) {
    if (!tags[k]) continue;
    let data;
    if (k === 'track') {
      const n = parseInt(tags[k], 10);
      if (!(n > 0)) continue;
      data = box('data', be32(0), be32(0), new Uint8Array([0, 0, (n >> 8) & 255, n & 255, 0, 0, 0, 0]));
    } else {
      data = box('data', be32(1), be32(0), utf8Enc.encode(tags[k]));
    }
    items.push(box(types[k], data));
  }
  const hdlr = box('hdlr', be32(0), be32(0), ascii('mdirappl'), new Uint8Array(9));
  return box('udta', box('meta', be32(0), hdlr, box('ilst', ...items)));
}
