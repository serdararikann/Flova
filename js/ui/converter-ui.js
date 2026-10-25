/* ====================================================================
   FLOVA AUDIO STUDIO - "DÖNÜŞTÜRÜCÜ" (FORMAT CONVERTER) SCREEN
   Same screen as the app's ConverterScreen: a list of files (audio or the
   sound of videos), one output setting, per-file trim; converts one file
   after the other in the browser and downloads each result.
   ==================================================================== */

import {
  FORMATS, FORMAT_HINTS, PRESETS, KBPS, AAC_RATES, nearest, presetKbps, presetMatches, detectFormats, estimateBytes,
  convertedName, probeFile, convertFile,
} from '../audio/converter.js';

const MIN_TRIM = 0.5;

const ICONS = {
  folder: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>',
  plus: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>',
  trash: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>',
  music: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>',
  video: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"></polygon><rect x="1" y="5" width="15" height="14" rx="2"></rect></svg>',
  check: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>',
  alert: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>',
  scissors: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="3"></circle><circle cx="6" cy="18" r="3"></circle><line x1="20" y1="4" x2="8.12" y2="15.88"></line><line x1="14.47" y1="14.48" x2="20" y2="20"></line><line x1="8.12" y1="8.12" x2="12" y2="12"></line></svg>',
  close: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>',
  download: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>',
  convert: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 3 20 7 16 11"></polyline><line x1="20" y1="7" x2="4" y2="7"></line><polyline points="8 21 4 17 8 13"></polyline><line x1="4" y1="17" x2="20" y2="17"></line></svg>',
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function formatTime(sec, millis = true) {
  if (!Number.isFinite(sec)) return '--:--';
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  const whole = Math.floor(s);
  const base = `${String(m).padStart(2, '0')}:${String(whole).padStart(2, '0')}`;
  return millis ? `${base}.${String(Math.floor((s - whole) * 1000)).padStart(3, '0')}` : base;
}

export function formatMegabytes(bytes) {
  const mb = bytes / (1024 * 1024);
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`.replace('.', ',');
}

function describe(info) {
  const parts = [info.codec];
  if (info.sampleRate) parts.push(`${(info.sampleRate / 1000).toLocaleString('tr-TR', { maximumFractionDigits: 2 })} kHz`);
  if (info.channels) parts.push(info.channels === 1 ? 'Mono' : info.channels === 2 ? 'Stereo' : `${info.channels} kanal`);
  if (info.duration) parts.push(formatTime(info.duration, false));
  parts.push(formatMegabytes(info.size));
  return parts.join(' · ');
}

let nextId = 1;

export class ConverterUI {
  constructor(container, { showToast } = {}) {
    this.container = container;
    this.showToast = showToast || (() => {});
    this.items = [];
    this.options = { format: 'wav', bitDepth: 16, kbps: 192, sampleRate: null, channels: null, keepTags: true };
    this.supported = { wav: true, flac: true, mp3: true, m4a: true, opus: true, aacKbps: KBPS.m4a };
    this.running = false;
    this.abort = null;
    this.startedAt = 0;
    this.openTrim = new Set();
    detectFormats().then((s) => { this.supported = s; this.render(); });
    this.render();
  }

  get pending() {
    return this.items.filter((it) => it.info && it.status !== 'done');
  }

  optionsFor(item) {
    return { ...this.options, startSeconds: item.trimStart, endSeconds: item.trimEnd };
  }

  /** Opens the file picker (also used by the header's "Dosya aç" in this mode). */
  pick() {
    if (this.running) return;
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = 'audio/*,video/*,.mp3,.wav,.flac,.m4a,.aac,.ogg,.opus,.wma,.aiff,.mp4,.mov,.mkv,.webm';
    input.onchange = () => this.addFiles(input.files);
    input.click();
  }

  async addFiles(fileList) {
    if (this.running) return;
    const files = [...(fileList || [])];
    if (!files.length) return;
    const added = files.map((file) => ({
      id: nextId++, file, info: null, probing: true, status: 'waiting', progress: 0, message: null,
      trimStart: 0, trimEnd: null, blob: null, url: null,
    }));
    this.items.push(...added);
    this.render();
    for (const item of added) {
      try {
        item.info = await probeFile(item.file);
      } catch (e) {
        item.info = null;
      }
      item.probing = false;
      if (!item.info) {
        item.status = 'failed';
        item.message = 'Ses izi okunamadı; bu dosya desteklenmiyor.';
      }
      this.render();
    }
  }

  remove(id) {
    const item = this.items.find((it) => it.id === id);
    if (!item || (this.running && item.status === 'running')) return;
    if (item.url) URL.revokeObjectURL(item.url);
    this.items = this.items.filter((it) => it !== item);
    this.render();
  }

  clear() {
    if (this.running) return;
    this.items.forEach((it) => it.url && URL.revokeObjectURL(it.url));
    this.items = [];
    this.render();
  }

  /** Bit rates offered for the current format (AAC: what this browser's encoder takes). */
  kbpsList(format = this.options.format) {
    return format === 'm4a' ? this.supported.aacKbps : KBPS[format] || [];
  }

  selectFormat(f) {
    if (this.running || !this.supported[f] || f === this.options.format) return;
    this.options.format = f;
    // Sensible bit rate per codec: AAC 192 kbps is transparent, Opus reaches that at 128
    this.options.kbps = nearest(this.kbpsList(f), f === 'opus' ? 128 : 192);
    if (f === 'm4a' && this.options.sampleRate && !AAC_RATES.includes(this.options.sampleRate)) this.options.sampleRate = null;
    this.render();
  }

  applyPreset(id) {
    const p = PRESETS.find((x) => x.id === id);
    if (!p || this.running || !this.supported[p.format]) return;
    Object.assign(this.options, {
      format: p.format, kbps: presetKbps(p, this.supported.aacKbps), bitDepth: p.bitDepth ?? 16, sampleRate: p.sampleRate ?? null, channels: p.channels ?? null,
    });
    this.render();
  }

  setTrim(item, start, end) {
    const duration = item.info?.duration;
    if (!(duration >= 2 * MIN_TRIM)) return;
    const s = Math.min(Math.max(0, start), Math.max(0, duration - MIN_TRIM));
    const e = Math.min(Math.max(end, s + MIN_TRIM), duration);
    item.trimStart = s < 0.05 ? 0 : s;
    item.trimEnd = e > duration - 0.05 ? null : e;
    if (item.status === 'done') item.status = 'waiting';
  }

  download(item) {
    if (!item.url) return;
    const a = document.createElement('a');
    a.href = item.url;
    a.download = convertedName(item.file.name, item.format);
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  async downloadZip() {
    const done = this.items.filter((it) => it.blob);
    if (!done.length || typeof window.JSZip === 'undefined') return;
    const zip = new window.JSZip();
    const used = new Set();
    for (const it of done) {
      let name = convertedName(it.file.name, it.format);
      for (let n = 2; used.has(name); n++) name = name.replace(/(\.[^.]+)$/, ` (${n})$1`);
      used.add(name);
      zip.file(name, it.blob);
    }
    const blob = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'flova-donusturulenler.zip';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  cancel() {
    this.abort?.abort();
  }

  async convertAll() {
    if (this.running) return;
    const batch = this.pending;
    if (!batch.length) return;
    this.running = true;
    this.startedAt = Date.now();
    this.abort = new AbortController();
    const signal = this.abort.signal;
    const options = { ...this.options };
    let ok = 0;
    let failed = 0;
    this.render();
    this.clock = setInterval(() => this.updateClock(), 1000);
    try {
      for (const item of batch) {
        if (signal.aborted) break;
        item.status = 'running';
        item.progress = 0;
        item.message = null;
        this.render();
        try {
          const opts = { ...options, startSeconds: item.trimStart, endSeconds: item.trimEnd };
          const blob = await convertFile(item.file, item.info, opts, (p) => this.updateProgress(item, p), signal);
          if (item.url) URL.revokeObjectURL(item.url);
          item.blob = blob;
          item.url = URL.createObjectURL(blob);
          item.format = options.format;
          item.status = 'done';
          item.message = `${convertedName(item.file.name, options.format)} · ${formatMegabytes(blob.size)}`;
          ok++;
          this.download(item);
        } catch (e) {
          if (e?.name === 'AbortError') {
            item.status = 'waiting';
            break;
          }
          console.warn('[Flova] Dönüştürme hatası:', e);
          item.status = 'failed';
          item.message = e?.name === 'RangeError' || /memory/i.test(e?.message || '') ? 'Bellek yetersiz.' : (e?.message || 'Dönüştürme başarısız oldu.');
          failed++;
        }
        this.render();
      }
    } finally {
      this.running = false;
      this.abort = null;
      clearInterval(this.clock);
      this.render();
    }
    if (signal.aborted) this.showToast('Dönüştürme iptal edildi.', 'info');
    else if (failed) this.showToast(`${ok} dosya dönüştürüldü, ${failed} dosya başarısız.`, ok ? 'info' : 'error');
    else this.showToast(ok > 1 ? `${ok} dosya dönüştürüldü ve indirildi.` : 'Dosya dönüştürüldü ve indirildi.', 'success');
  }

  updateProgress(item, p) {
    item.progress = p;
    const row = this.container.querySelector(`[data-item="${item.id}"]`);
    if (!row) return;
    const fill = row.querySelector('.progress-fill');
    if (fill) fill.style.width = `${Math.max(2, p * 100)}%`;
    const pct = row.querySelector('.conv-pct');
    if (pct) pct.textContent = `%${Math.round(p * 100)}`;
  }

  updateClock() {
    const el = this.container.querySelector('.conv-clock');
    if (el) el.textContent = formatTime((Date.now() - this.startedAt) / 1000, false);
  }

  /* ------------------------------------------------------------------ */
  /* Rendering                                                           */
  /* ------------------------------------------------------------------ */

  chip(label, active, attrs, disabled = false, title = '') {
    return `<button type="button" class="preset-chip${active ? ' active' : ''}${disabled ? ' disabled' : ''}" ${attrs}${disabled ? ' disabled' : ''}${title ? ` title="${esc(title)}"` : ''}>${esc(label)}</button>`;
  }

  renderEmpty() {
    return `
      <div class="drop-zone conv-drop" data-action="pick">
        <div class="drop-zone-icon">${ICONS.convert.replace('width="16" height="16"', 'width="28" height="28"')}</div>
        <h2 class="drop-zone-title">Dönüştürülecek dosyaları seçin</h2>
        <p class="drop-zone-sub">MP3, WAV, FLAC, M4A, OGG, AAC… veya bir videonun sesi</p>
        <div style="margin-top: 16px; display: flex; justify-content: center;">
          <button type="button" class="btn btn-primary btn-sm" data-action="pick">${ICONS.folder} Dosya ekle</button>
        </div>
      </div>
      <p class="conv-note" style="margin-top: 12px;">Dönüştürme tarayıcınızda yapılır; dosyalar sunucuya gönderilmez. Birden fazla dosyayı birlikte seçebilir veya sürükleyip bırakabilirsiniz.</p>`;
  }

  renderRow(item) {
    const info = item.info;
    const duration = info?.duration || 0;
    const canTrim = duration >= 2 * MIN_TRIM && item.status !== 'failed';
    const trimOpen = this.openTrim.has(item.id) && canTrim && !this.running;
    const trimmed = item.trimStart > 0 || item.trimEnd != null;
    const icon = item.status === 'done' ? ICONS.check : item.status === 'failed' ? ICONS.alert : info?.video ? ICONS.video : ICONS.music;
    const iconClass = item.status === 'done' ? 'is-done' : item.status === 'failed' ? 'is-failed' : '';
    let actions = '';
    if (item.status === 'running') {
      actions = `<span class="conv-pct mono">%${Math.round(item.progress * 100)}</span>`;
    } else if (!this.running) {
      actions = [
        item.status === 'done' ? `<button type="button" class="btn btn-secondary btn-sm" data-action="download" data-id="${item.id}">${ICONS.download} İndir</button>` : '',
        canTrim ? `<button type="button" class="icon-btn${trimOpen || trimmed ? ' is-on' : ''}" data-action="trim" data-id="${item.id}" title="Kırp" aria-label="Kırp">${ICONS.scissors}</button>` : '',
        `<button type="button" class="icon-btn" data-action="remove" data-id="${item.id}" title="Listeden çıkar" aria-label="Listeden çıkar">${ICONS.close}</button>`,
      ].join('');
    }
    const end = item.trimEnd ?? duration;
    const trimPanel = trimOpen ? `
      <div class="conv-trim">
        <label class="conv-trim-row"><span>Baş</span>
          <input type="range" class="studio-slider" min="0" max="${duration}" step="0.01" value="${item.trimStart}" data-trim="start" data-id="${item.id}" />
        </label>
        <label class="conv-trim-row"><span>Bit</span>
          <input type="range" class="studio-slider" min="0" max="${duration}" step="0.01" value="${end}" data-trim="end" data-id="${item.id}" />
        </label>
        <div class="conv-times">
          <div class="time-input-box"><span class="time-input-label">Başlangıç</span><div class="time-input-row"><input type="text" readonly value="${formatTime(item.trimStart)}" data-time="start" /></div></div>
          <div class="time-input-box"><span class="time-input-label">Bitiş</span><div class="time-input-row"><input type="text" readonly value="${formatTime(end)}" data-time="end" /></div></div>
          <div class="time-input-box"><span class="time-input-label">Süre</span><div class="time-input-row"><input type="text" readonly value="${formatTime(end - item.trimStart)}" data-time="length" /></div></div>
        </div>
        <div class="chip-row">
          ${this.chip('Baş −0,1', false, `data-action="nudge" data-id="${item.id}" data-s="-0.1" data-e="0"`)}
          ${this.chip('Baş +0,1', false, `data-action="nudge" data-id="${item.id}" data-s="0.1" data-e="0"`)}
          ${this.chip('Bit −0,1', false, `data-action="nudge" data-id="${item.id}" data-s="0" data-e="-0.1"`)}
          ${this.chip('Bit +0,1', false, `data-action="nudge" data-id="${item.id}" data-s="0" data-e="0.1"`)}
          ${duration > 30 ? this.chip('İlk 30 sn', false, `data-action="first30" data-id="${item.id}"`) : ''}
          ${trimmed ? this.chip('Kırpmayı kaldır', false, `data-action="untrim" data-id="${item.id}"`) : ''}
        </div>
      </div>` : '';
    let status = '';
    if (item.status === 'running') status = '<div class="progress-track"><div class="progress-fill" style="width: 2%;"></div></div>';
    else if (item.status === 'done' && item.message) status = `<div class="conv-msg is-done">İndirildi: ${esc(item.message)}</div>`;
    else if (item.status === 'failed' && item.message) status = `<div class="conv-msg is-failed">${esc(item.message)}</div>`;
    return `
      <div class="conv-row" data-item="${item.id}">
        <div class="conv-row-main">
          <span class="conv-icon ${iconClass}">${icon}</span>
          <div class="conv-text">
            <div class="conv-name">${esc(item.file.name)}</div>
            <div class="conv-meta mono">${info ? esc(describe(info)) : item.probing ? 'Okunuyor…' : ''}</div>
            ${trimmed ? `<div class="conv-meta mono is-accent">Kırpıldı: ${formatTime(item.trimStart)} – ${formatTime(end)}</div>` : ''}
          </div>
          <div class="conv-actions">${actions}</div>
        </div>
        ${trimPanel}
        ${status}
      </div>`;
  }

  renderSettings() {
    const o = this.options;
    const running = this.running;
    const preset = PRESETS.find((p) => presetMatches(p, o, this.supported.aacKbps));
    const lossy = !FORMATS[o.format].lossless;
    const pending = this.pending;
    const unsupported = 'Bu tarayıcı bu formatı kodlayamıyor (Chrome veya Edge deneyin).';

    let quality = '';
    if (o.format === 'wav') {
      quality = `<div class="field-label">Bit derinliği</div><div class="chip-row">${
        [[16, '16-bit (CD)'], [24, '24-bit (Stüdyo)'], [32, '32-bit Float']].map(([d, l]) => this.chip(l, o.bitDepth === d, `data-set="bitDepth" data-value="${d}"`, running)).join('')}</div>`;
    } else if (lossy) {
      quality = `<div class="field-label">Kalite</div><div class="chip-row">${
        this.kbpsList().map((k) => this.chip(`${k} kbps`, o.kbps === k, `data-set="kbps" data-value="${k}"`, running)).join('')}</div>`;
    }

    const rates = [[null, 'Orijinal'], [44100, '44,1 kHz'], [48000, '48 kHz'], [22050, '22,05 kHz'], [16000, '16 kHz']]
      .filter(([r]) => o.format !== 'm4a' || r === null || AAC_RATES.includes(r));
    const rateRow = o.format === 'opus'
      ? '<p class="conv-note">Opus her zaman 48 kHz kodlanır.</p>'
      : `<div class="chip-row">${rates.map(([r, l]) => this.chip(l, o.sampleRate === r, `data-set="sampleRate" data-value="${r ?? ''}"`, running)).join('')}</div>${
        o.format === 'm4a' ? '<p class="conv-note">AAC 44,1 veya 48 kHz kodlanır; başka hızlar en yakınına çevrilir.</p>' : ''}`;

    const upconverts = FORMATS[o.format].lossless && pending.some((it) => it.info.lossy);
    const total = pending.reduce((n, it) => n + estimateBytes(it.info, this.optionsFor(it)), 0);
    const doneCount = this.items.filter((it) => it.blob).length;

    return `
      <div class="panel-heading"><span class="panel-title">Çıktı ayarları</span></div>
      <div class="field-label">Hazır ayarlar</div>
      <div class="chip-row">${PRESETS.map((p) => this.chip(p.label, preset?.id === p.id, `data-action="preset" data-id="${p.id}"`, running || !this.supported[p.format], this.supported[p.format] ? '' : unsupported)).join('')}</div>
      ${preset ? `<p class="conv-note">${esc(preset.hint)}</p>` : ''}

      <div class="field-label">Format</div>
      <div class="chip-row">${Object.entries(FORMATS).map(([id, f]) => this.chip(f.label, o.format === id, `data-action="format" data-id="${id}"`, running || !this.supported[id], this.supported[id] ? '' : unsupported)).join('')}</div>
      <p class="conv-note">${esc(FORMAT_HINTS[o.format])}</p>

      ${quality}

      <div class="field-label">Örnekleme hızı</div>
      ${rateRow}

      <div class="field-label">Kanallar</div>
      <div class="chip-row">${[[null, 'Orijinal'], [2, 'Stereo'], [1, 'Mono']].map(([c, l]) => this.chip(l, o.channels === c, `data-set="channels" data-value="${c ?? ''}"`, running)).join('')}</div>

      <div class="field-label">Etiketler</div>
      <div class="chip-row">${this.chip('Koru', o.keepTags, 'data-set="keepTags" data-value="1"', running)}${this.chip('Kaldır', !o.keepTags, 'data-set="keepTags" data-value="0"', running)}</div>
      <p class="conv-note">${o.keepTags ? 'Şarkı adı, sanatçı, albüm, tür, yıl ve parça numarası yeni dosyaya aktarılır.' : 'Yeni dosyada şarkı bilgisi olmaz.'}</p>

      ${upconverts ? `<p class="conv-note is-accent">Not: MP3 gibi kayıplı bir dosyayı ${esc(FORMATS[o.format].label)} formatına çevirmek kaliteyi artırmaz; dosya yalnızca daha geniş uyumluluk kazanır.</p>` : ''}

      <div class="hairline" style="margin: 14px 0;"></div>
      ${pending.length ? `<div class="conv-estimate"><span>Tahmini toplam boyut</span><span class="mono">~${formatMegabytes(total)}</span></div>` : ''}
      ${running ? `<div class="conv-busy"><span class="spinner-sm"></span><span>Dönüştürülüyor: ${esc(this.items.find((it) => it.status === 'running')?.file.name || '')}</span><span class="conv-clock mono">${formatTime((Date.now() - this.startedAt) / 1000, false)}</span></div>` : ''}
      <div class="conv-buttons">
        ${running ? `<button type="button" class="btn btn-secondary" data-action="cancel">${ICONS.close} İptal</button>` : ''}
        <button type="button" class="btn btn-primary" data-action="convert" ${running || !pending.length ? 'disabled' : ''}>${ICONS.convert} ${running ? 'Dönüştürülüyor…' : pending.length > 1 ? `${pending.length} dosyayı dönüştür` : 'Dönüştür'}</button>
        ${!running && doneCount > 1 && window.JSZip ? `<button type="button" class="btn btn-secondary" data-action="zip">${ICONS.download} Hepsini ZIP olarak indir</button>` : ''}
      </div>
      <p class="conv-note">Dosyalar tarayıcınızda dönüştürülür ve indirilenler klasörünüze kaydedilir. İnternet kullanılmaz.</p>`;
  }

  render() {
    if (!this.items.length) {
      this.container.innerHTML = this.renderEmpty();
    } else {
      this.container.innerHTML = `
        <div class="conv-layout">
          <section class="conv-files">
            <div class="panel-heading">
              <span class="panel-title">Dosyalar <span class="mono conv-count">${this.items.length}</span></span>
              <div class="conv-head-actions">
                <button type="button" class="btn btn-secondary btn-sm" data-action="pick" ${this.running ? 'disabled' : ''}>${ICONS.plus} Ekle</button>
                <button type="button" class="btn btn-secondary btn-sm" data-action="clear" ${this.running ? 'disabled' : ''}>${ICONS.trash} Temizle</button>
              </div>
            </div>
            <div class="conv-list">${this.items.map((it) => this.renderRow(it)).join('')}</div>
          </section>
          <section class="conv-settings">${this.renderSettings()}</section>
        </div>`;
      this.items.filter((it) => it.status === 'running').forEach((it) => this.updateProgress(it, it.progress));
    }
    this.bind();
  }

  bind() {
    const root = this.container;
    root.onclick = (e) => {
      const el = e.target.closest('[data-action], [data-set]');
      if (!el || el.disabled) return;
      const id = Number(el.dataset.id);
      const item = this.items.find((it) => it.id === id);
      if (el.dataset.set) {
        if (this.running) return;
        const key = el.dataset.set;
        const raw = el.dataset.value;
        this.options[key] = key === 'keepTags' ? raw === '1' : raw === '' ? null : Number(raw);
        this.render();
        return;
      }
      switch (el.dataset.action) {
        case 'pick': this.pick(); break;
        case 'clear': this.clear(); break;
        case 'remove': this.remove(id); break;
        case 'download': if (item) this.download(item); break;
        case 'zip': this.downloadZip(); break;
        case 'convert': this.convertAll(); break;
        case 'cancel': this.cancel(); break;
        case 'format': this.selectFormat(el.dataset.id); break;
        case 'preset': this.applyPreset(el.dataset.id); break;
        case 'trim':
          if (this.openTrim.has(id)) this.openTrim.delete(id); else this.openTrim.add(id);
          this.render();
          break;
        case 'nudge':
          if (item) { this.setTrim(item, item.trimStart + Number(el.dataset.s), (item.trimEnd ?? item.info.duration) + Number(el.dataset.e)); this.render(); }
          break;
        case 'first30':
          if (item) { this.setTrim(item, 0, 30); this.render(); }
          break;
        case 'untrim':
          if (item) { item.trimStart = 0; item.trimEnd = null; this.render(); }
          break;
        default:
      }
    };
    // Trim sliders: update the numbers live, re-render (size estimate, labels) when released
    root.querySelectorAll('[data-trim]').forEach((input) => {
      const item = this.items.find((it) => it.id === Number(input.dataset.id));
      input.oninput = () => {
        const end = item.trimEnd ?? item.info.duration;
        if (input.dataset.trim === 'start') this.setTrim(item, Number(input.value), end);
        else this.setTrim(item, item.trimStart, Number(input.value));
        const row = input.closest('.conv-row');
        const e = item.trimEnd ?? item.info.duration;
        row.querySelector('[data-time="start"]').value = formatTime(item.trimStart);
        row.querySelector('[data-time="end"]').value = formatTime(e);
        row.querySelector('[data-time="length"]').value = formatTime(e - item.trimStart);
      };
      input.onchange = () => this.render();
    });
    // Drag and drop onto the screen
    root.ondragover = (e) => { e.preventDefault(); root.classList.add('is-dragover'); };
    root.ondragleave = () => root.classList.remove('is-dragover');
    root.ondrop = (e) => {
      e.preventDefault();
      e.stopPropagation();
      root.classList.remove('is-dragover');
      this.addFiles(e.dataTransfer?.files);
    };
  }
}
