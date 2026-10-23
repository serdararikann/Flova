/* ====================================================================
   FLOVA AUDIO STUDIO - FLAC ENCODER (16-bit)
   Lossless upload format for cloud projects (about half the size of WAV),
   readable by every browser and by the mobile app.
   Fixed predictors (order 0-4), Rice-coded residuals with partitions and
   the best of independent / left-side / right-side / mid-side stereo.
   ==================================================================== */

const BLOCK_SIZE = 4096;
const BPS = 16;

class BitWriter {
  constructor(capacity = 1 << 20) {
    this.buf = new Uint8Array(capacity);
    this.pos = 0;    // bytes written
    this.acc = 0;    // pending bits (msb first)
    this.nbits = 0;
  }

  ensure(extra) {
    if (this.pos + extra <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.pos + extra) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.pos));
    this.buf = next;
  }

  /** Writes the low [n] bits of [value] (n <= 24). */
  write(value, n) {
    if (n === 0) return;
    this.acc = (this.acc * (1 << n)) + (value & ((1 << n) - 1));
    this.nbits += n;
    if (this.nbits >= 8) {
      this.ensure(4);
      while (this.nbits >= 8) {
        this.nbits -= 8;
        this.buf[this.pos++] = Math.floor(this.acc / (1 << this.nbits)) & 0xff;
      }
      this.acc &= (1 << this.nbits) - 1;
    }
  }

  writeLong(value, n) {
    // For values wider than 24 bits (sample counts): split into 24 + rest.
    if (n <= 24) return this.write(value, n);
    const high = Math.floor(value / 2 ** 24);
    this.write(high, n - 24);
    this.write(value % 2 ** 24, 24);
  }

  writeSigned(value, n) {
    this.write(value < 0 ? value + (1 << n) : value, n);
  }

  /** Unary quotient (q zeros and a one) then the k low bits. */
  writeRice(u, k) {
    let q = u >>> k;
    while (q >= 24) { this.write(0, 24); q -= 24; }
    this.write(1, q + 1);
    if (k) this.write(u & ((1 << k) - 1), k);
  }

  alignToByte() {
    if (this.nbits) this.write(0, 8 - this.nbits);
  }

  get bytes() {
    return this.buf.subarray(0, this.pos);
  }
}

const CRC8 = new Uint8Array(256);
const CRC16 = new Uint16Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
  CRC8[i] = c;
  let d = i << 8;
  for (let j = 0; j < 8; j++) d = d & 0x8000 ? ((d << 1) ^ 0x8005) & 0xffff : (d << 1) & 0xffff;
  CRC16[i] = d;
}

function crc8(bytes, from, to) {
  let c = 0;
  for (let i = from; i < to; i++) c = CRC8[c ^ bytes[i]];
  return c;
}

function crc16(bytes, from, to) {
  let c = 0;
  for (let i = from; i < to; i++) c = ((c << 8) & 0xffff) ^ CRC16[(c >> 8) ^ bytes[i]];
  return c;
}

/** Residual of fixed predictor [order] for x[i] (i >= order). */
function residual(x, i, order) {
  switch (order) {
    case 0: return x[i];
    case 1: return x[i] - x[i - 1];
    case 2: return x[i] - 2 * x[i - 1] + x[i - 2];
    case 3: return x[i] - 3 * x[i - 1] + 3 * x[i - 2] - x[i - 3];
    default: return x[i] - 4 * x[i - 1] + 6 * x[i - 2] - 4 * x[i - 3] + x[i - 4];
  }
}

const zigzag = (r) => (r >= 0 ? r * 2 : -r * 2 - 1);

/** Rice bits for values whose zigzag sum is [sum] over [n] samples, at the best parameter (estimated). */
function riceCost(us, from, to) {
  const n = to - from;
  if (n <= 0) return { bits: 0, k: 0 };
  let sum = 0;
  for (let i = from; i < to; i++) sum += us[i];
  const mean = sum / n;
  let k0 = mean > 1 ? Math.floor(Math.log2(mean)) : 0;
  let best = null;
  for (let k = Math.max(0, k0 - 1); k <= Math.min(14, k0 + 1); k++) {
    let bits = n * (k + 1);
    for (let i = from; i < to; i++) bits += us[i] >>> k;
    if (!best || bits < best.bits) best = { bits, k };
  }
  return best;
}

/**
 * Picks the predictor order and partitioning for one channel block. Returns the encoded description
 * (type, order, partition order, rice parameters, zigzagged residuals) and its size in bits.
 */
function planSubframe(x, n, bps) {
  // Constant block (silence): one sample.
  let constant = true;
  for (let i = 1; i < n; i++) if (x[i] !== x[0]) { constant = false; break; }
  if (constant) return { type: 'constant', bits: 8 + bps };

  // Order by the sum of absolute residuals (cheap and close to the real size).
  let order = 0;
  let bestAbs = Infinity;
  const maxOrder = Math.min(4, n - 1);
  for (let o = 0; o <= maxOrder; o++) {
    let s = 0;
    for (let i = o; i < n; i++) s += Math.abs(residual(x, i, o));
    if (s < bestAbs) { bestAbs = s; order = o; }
  }

  const us = new Uint32Array(n);
  for (let i = order; i < n; i++) us[i] = zigzag(residual(x, i, order));

  let plan = null;
  for (let p = 0; p <= 6; p++) {
    const parts = 1 << p;
    if (n % parts !== 0 || (n >> p) <= order) break;
    const size = n >> p;
    let bits = 6; // coding method + partition order
    const ks = [];
    for (let j = 0; j < parts; j++) {
      const from = j === 0 ? order : j * size;
      const c = riceCost(us, from, (j + 1) * size);
      bits += 4 + c.bits;
      ks.push(c.k);
    }
    if (!plan || bits < plan.residualBits) plan = { p, ks, residualBits: bits };
  }

  const bits = 8 + order * bps + plan.residualBits;
  const verbatimBits = 8 + n * bps;
  if (verbatimBits <= bits) return { type: 'verbatim', bits: verbatimBits };
  return { type: 'fixed', order, us, p: plan.p, ks: plan.ks, bits };
}

function writeSubframe(w, x, n, bps, plan) {
  if (plan.type === 'constant') {
    w.write(0b00000000, 8);
    w.writeSigned(x[0], bps);
  } else if (plan.type === 'verbatim') {
    w.write(0b00000010, 8);
    for (let i = 0; i < n; i++) w.writeSigned(x[i], bps);
  } else {
    w.write(0b00010000 | (plan.order << 1), 8);
    for (let i = 0; i < plan.order; i++) w.writeSigned(x[i], bps);
    w.write(0, 2); // Rice, 4-bit parameters
    w.write(plan.p, 4);
    const size = n >> plan.p;
    for (let j = 0; j < plan.ks.length; j++) {
      const k = plan.ks[j];
      w.write(k, 4);
      const from = j === 0 ? plan.order : j * size;
      const to = (j + 1) * size;
      for (let i = from; i < to; i++) w.writeRice(plan.us[i], k);
    }
  }
}

function writeUtf8Number(w, v) {
  if (v < 0x80) { w.write(v, 8); return; }
  const bytes = [];
  let rest = v;
  let count = 1;
  while (rest >= (1 << (7 - count))) {
    bytes.unshift(0x80 | (rest & 0x3f));
    rest = Math.floor(rest / 64);
    count++;
  }
  const lead = (0xff << (8 - count)) & 0xff;
  w.write(lead | rest, 8);
  for (const b of bytes) w.write(b, 8);
}

/** Frame header sample rate: a 4-bit code, or (12-14) the rate written after the block size. */
function sampleRateCode(rate) {
  const code = { 88200: 1, 176400: 2, 192000: 3, 8000: 4, 16000: 5, 22050: 6, 24000: 7, 32000: 8, 44100: 9, 48000: 10, 96000: 11 }[rate];
  if (code) return { code };
  if (rate < 65536) return { code: 13, extra: rate, bits: 16 };
  if (rate % 10 === 0 && rate / 10 < 65536) return { code: 14, extra: rate / 10, bits: 16 };
  return { code: 0 }; // from STREAMINFO
}

function toInt16(data) {
  const out = new Int32Array(data.length);
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    out[i] = v >= 1 ? 32767 : v <= -1 ? -32768 : Math.round(v * 32767);
  }
  return out;
}

/**
 * Encodes planar float audio ({ numberOfChannels, sampleRate, length, getChannelData } like an AudioBuffer)
 * as a 16-bit FLAC file. Yields to the browser between frames so long songs don't freeze the page.
 */
export async function encodeFlac(buffer, onProgress = null) {
  const channels = Math.min(8, buffer.numberOfChannels);
  const rate = buffer.sampleRate;
  const total = buffer.length;
  const pcm = [];
  for (let c = 0; c < channels; c++) pcm.push(toInt16(buffer.getChannelData(c)));

  const w = new BitWriter(Math.max(1 << 16, Math.floor(total * channels * 1.2)));
  // "fLaC" + STREAMINFO (last metadata block)
  [0x66, 0x4c, 0x61, 0x43].forEach((b) => w.write(b, 8));
  w.write(0x80, 8);
  w.write(34, 24);
  w.write(BLOCK_SIZE, 16);
  w.write(BLOCK_SIZE, 16);
  w.write(0, 24);
  w.write(0, 24);
  w.write(rate, 20);
  w.write(channels - 1, 3);
  w.write(BPS - 1, 5);
  w.writeLong(total, 36);
  for (let i = 0; i < 16; i++) w.write(0, 8); // MD5 unknown

  const rateCode = sampleRateCode(rate);
  const blockX = Array.from({ length: Math.max(channels, 2) + 2 }, () => new Int32Array(BLOCK_SIZE));
  let frame = 0;
  let lastYield = performance.now();

  for (let start = 0; start < total; start += BLOCK_SIZE, frame++) {
    const n = Math.min(BLOCK_SIZE, total - start);
    for (let c = 0; c < channels; c++) blockX[c].set(pcm[c].subarray(start, start + n));

    let assignment = channels - 1;
    let subframes = [];
    if (channels === 2) {
      const L = blockX[0], R = blockX[1], S = blockX[2], M = blockX[3];
      for (let i = 0; i < n; i++) {
        S[i] = L[i] - R[i];
        M[i] = (L[i] + R[i]) >> 1;
      }
      const pL = planSubframe(L, n, BPS);
      const pR = planSubframe(R, n, BPS);
      const pS = planSubframe(S, n, BPS + 1);
      const pM = planSubframe(M, n, BPS);
      const options = [
        { a: 1, bits: pL.bits + pR.bits, subs: [[L, BPS, pL], [R, BPS, pR]] },
        { a: 8, bits: pL.bits + pS.bits, subs: [[L, BPS, pL], [S, BPS + 1, pS]] },
        { a: 9, bits: pS.bits + pR.bits, subs: [[S, BPS + 1, pS], [R, BPS, pR]] },
        { a: 10, bits: pM.bits + pS.bits, subs: [[M, BPS, pM], [S, BPS + 1, pS]] }
      ];
      const best = options.reduce((a, b) => (b.bits < a.bits ? b : a));
      assignment = best.a;
      subframes = best.subs;
    } else {
      for (let c = 0; c < channels; c++) subframes.push([blockX[c], BPS, planSubframe(blockX[c], n, BPS)]);
    }

    w.ensure(n * channels * 3 + 64);
    const frameStart = w.pos;
    w.write(0xfff8, 16);              // sync, fixed block size
    w.write(0b0111, 4);               // block size: 16 bits at the end of the header
    w.write(rateCode.code, 4);
    w.write(assignment, 4);
    w.write(0b100, 3);                // 16 bits per sample
    w.write(0, 1);
    writeUtf8Number(w, frame);
    w.write(n - 1, 16);
    if (rateCode.extra) w.write(rateCode.extra, rateCode.bits);
    w.write(crc8(w.buf, frameStart, w.pos), 8);

    for (const [x, bps, plan] of subframes) writeSubframe(w, x, n, bps, plan);
    w.alignToByte();
    w.write(crc16(w.buf, frameStart, w.pos), 16);

    if (performance.now() - lastYield > 30) {
      if (onProgress) onProgress(start / total);
      await new Promise((r) => setTimeout(r, 0));
      lastYield = performance.now();
    }
  }
  if (onProgress) onProgress(1);
  return w.bytes.slice();
}
