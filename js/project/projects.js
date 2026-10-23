/* ====================================================================
   FLOVA AUDIO STUDIO - CLOUD PROJECTS
   Each screen as a cloud project, in the same document the mobile app
   saves (SessionDoc in the app's project/ProjectModel.kt), one kind per
   project:
     editor: { mode: 'Editor', editor: { name, source, steps, applied,
               selectionStart/End (fractions), markers, fadeIn, fadeOut,
               loop, beatGrid }, fx, lyrics }
     merger: { mode: 'Merger', merger: { sampleRate, tracks: [{ name,
               asset, steps, trimStart, trimEnd, volume, fadeIn, fadeOut,
               enabled }], mode: Auto|Manual, curve, crossfade } }
     vocal / stems: { mode: 'Vocal'|'Stems', vocal|stems: { name, source,
               stemCount, stems: [{ key, asset, gain, pan, muted }],
               alignLag, abMode, preset } }
   Assets are { id: <sha256>, ext } files in flova-media/<user>/.
   Steps are replayed on open: trim/cut/silence {start,end} seconds,
   reverse, normalize, fade {fadeIn,fadeOut}, fadeRange {start,end,fadeIn},
   replace {asset, label} (a stored result that can't be replayed).
   ==================================================================== */

import { supabaseService, MAX_FILE_BYTES } from '../db/supabase-client.js';
import { AudioProcessor } from '../audio/audio-processor.js';
import { encodeFlac } from '../audio/flac-encoder.js';

export const FORMAT_VERSION = 1;

export const KIND_LABELS = { editor: 'Düzenleyici', merger: 'Birleştirici', vocal: 'Vokal', stems: 'Enstrümanlar' };
/** The site's screen (app.activeMode) of each project kind. */
export const KIND_SCREENS = { editor: 'editor', merger: 'merger', vocal: 'vocal-splitter', stems: 'stem-splitter' };

/** Formats both the mobile app (MediaExtractor) and browsers decode; others are re-encoded to FLAC. */
const PORTABLE_EXTS = ['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'opus'];

const EQ_BANDS = ['band60', 'band250', 'band1000', 'band4000', 'band12000'];
const EQ_PRESETS = {
  flat: [0, 0, 0, 0, 0],
  bassBoost: [8, 4, 0, -2, -3],
  vocalBoost: [-3, 2, 6, 4, 2],
  electronic: [6, 1, -2, 3, 7],
  acoustic: [3, 2, 1, 4, 5],
  rock: [5, 2, -3, 5, 4]
};
/** Site preset key ↔ the app's MasteringPreset name. */
const MASTERING = { bypass: 'Bypass', spotify: 'Spotify', youtube: 'YouTube', podcast: 'Podcast', club: 'Club' };
/** Site crossfade curve ↔ the app's CrossfadeCurve. */
const CURVES = { 'equal-power': 'EqualPower', exponential: 'SCurve', linear: 'Linear' };
/** Site stem preset ↔ the app's preset name. */
const STEM_PRESETS = { all: 'Tümü', vocal: 'Vokal', karaoke: 'Karaoke', rhythm: 'Ritim+Bas' };
const STEM_KEYS = ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other'];

const keyOf = (map, value, fallback) => Object.keys(map).find((k) => map[k] === value) || fallback;
const extOf = (name) => (String(name || '').includes('.') ? String(name).split('.').pop().toLowerCase() : '');
const baseName = (name) => String(name || '').replace(/\.[^/.]+$/, '').trim();

/** MIME type the bucket accepts for an audio extension (as in the app's audioMime). */
export function audioMime(ext) {
  switch ((ext || '').toLowerCase()) {
    case 'mp3': return 'audio/mpeg';
    case 'wav': return 'audio/wav';
    case 'flac': return 'audio/flac';
    case 'm4a': case 'mp4': case 'aac': return 'audio/mp4';
    case 'ogg': case 'opus': case 'oga': return 'audio/ogg';
    default: return 'audio/mpeg';
  }
}

async function sha256Hex(arrayBuffer) {
  const digest = await crypto.subtle.digest('SHA-256', arrayBuffer);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

const round = (v, digits = 4) => {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};

function roundStep(step) {
  const out = { ...step };
  for (const k of ['start', 'end', 'fadeIn', 'fadeOut']) {
    if (typeof out[k] === 'number') out[k] = round(out[k], 6);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------------------------------------------

/** Stored files by their blob or buffer, so saving again doesn't hash or encode twice. */
const fileCache = new WeakMap();

/**
 * The file a source ({ blob?, ext?, buffer }) is stored as: the original when it is portable and fits,
 * otherwise the decoded audio as FLAC. [label] names it in the progress line.
 */
async function sourceFile(source, label, onStatus) {
  if (source.file) return source.file;
  const cacheKey = source.blob || source.buffer;
  if (cacheKey && fileCache.has(cacheKey)) return fileCache.get(cacheKey);
  let blob = null;
  let ext = (source.ext || '').toLowerCase();
  if (source.blob && PORTABLE_EXTS.includes(ext) && source.blob.size <= MAX_FILE_BYTES) {
    blob = source.blob;
  } else {
    if (!source.buffer) throw new Error('Parçanın sesi bulunamadı.');
    const what = label ? `${label}: ses` : 'Ses';
    onStatus?.(`${what} kayıpsız sıkıştırılıyor (FLAC)...`);
    const bytes = await encodeFlac(source.buffer, (p) => onStatus?.(`${what} kayıpsız sıkıştırılıyor (FLAC) %${Math.round(p * 100)}`));
    blob = new Blob([bytes], { type: 'audio/flac' });
    ext = 'flac';
  }
  if (blob.size > MAX_FILE_BYTES) {
    throw new Error(`${label || 'Parça'} bulut için çok büyük (${(blob.size / 1048576).toFixed(0)} MB; en fazla 50 MB).`);
  }
  const sha256 = await sha256Hex(await blob.arrayBuffer());
  const file = { sha256, ext, blob, mime: audioMime(ext) };
  if (cacheKey) fileCache.set(cacheKey, file);
  return file;
}

const refOf = (file) => ({ id: file.sha256, ext: file.ext });

/** Makes sure the files are in the user's bucket and registered; returns their asset rows by sha256. */
async function ensureAssets(files, onStatus) {
  const unique = [...new Map(files.map((f) => [f.sha256, f])).values()];
  const shas = unique.map((f) => f.sha256);
  let rows = await supabaseService.assetsBySha(shas);
  const have = new Set(rows.map((r) => r.sha256));
  const missing = unique.filter((f) => !have.has(f.sha256));
  for (const [i, f] of missing.entries()) {
    const mb = (f.blob.size / 1048576).toFixed(1);
    onStatus?.(missing.length > 1 ? `Ses dosyası yükleniyor (${i + 1}/${missing.length}, ${mb} MB)...` : `Ses dosyası yükleniyor (${mb} MB)...`);
    const storageKey = supabaseService.storageKey(f.sha256, f.ext);
    await supabaseService.uploadFile(storageKey, f.blob, f.mime);
    await supabaseService.addAssets([{ sha256: f.sha256, storageKey, mime: f.mime, bytes: f.blob.size, title: f.title }]);
  }
  if (missing.length) rows = await supabaseService.assetsBySha(shas);
  const byHash = new Map(rows.map((r) => [r.sha256, r]));
  if (unique.some((f) => !byHash.has(f.sha256))) throw new Error('Ses dosyası buluta kaydedilemedi.');
  return byHash;
}

/** Downloads and decodes one asset ({ id: sha256, ext }); the result keeps the file for saving again. */
async function loadAsset(ctx, ref, assetsBySha) {
  const row = assetsBySha.get(ref.id);
  const key = row?.storage_key || supabaseService.storageKey(ref.id, ref.ext);
  const blob = await supabaseService.downloadFile(key);
  const bytes = await blob.arrayBuffer();
  let buffer;
  try {
    buffer = await ctx.decodeAudioData(bytes.slice(0));
  } catch (_) {
    throw new Error(`Bu tarayıcı projenin ses dosyasını (.${ref.ext}) açamıyor.`);
  }
  const typed = new Blob([bytes], { type: audioMime(ref.ext) });
  const file = { sha256: ref.id, ext: ref.ext, blob: typed, mime: audioMime(ref.ext) };
  fileCache.set(buffer, file);
  return { buffer, source: { blob: typed, ext: ref.ext, buffer, file } };
}

/** Applies one replayable step (the same operations as the app's EditStep.applyTo). */
function applyStep(ctx, buffer, step) {
  switch (step.op) {
    case 'trim': return AudioProcessor.trimBuffer(ctx, buffer, step.start, step.end);
    case 'cut': return AudioProcessor.cutOutRange(ctx, buffer, step.start, step.end);
    case 'silence': return AudioProcessor.silenceRange(ctx, buffer, step.start, step.end);
    case 'reverse': return AudioProcessor.reverseBuffer(ctx, buffer);
    case 'normalize': return AudioProcessor.normalizeBuffer(ctx, buffer, -0.1).buffer;
    case 'fade': return AudioProcessor.applyFade(ctx, buffer, step.fadeIn || 0, step.fadeOut || 0);
    case 'fadeRange': return AudioProcessor.applyFadeRange(ctx, buffer, step.start, step.end, step.fadeIn === false ? 'out' : 'in');
    default: throw new Error(`Bilinmeyen düzenleme adımı: ${step.op}`);
  }
}

/**
 * A stem shifted by [lagSeconds] (the app removes the AAC encoder delay this way) and fitted to [frames],
 * like the app's Pcm16Audio.aligned.
 */
function alignBuffer(ctx, buffer, lagSeconds, frames) {
  const lag = Math.round(lagSeconds * buffer.sampleRate);
  if (lag === 0 && buffer.length === frames) return buffer;
  const out = ctx.createBuffer(buffer.numberOfChannels, Math.max(1, frames), buffer.sampleRate);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const src = buffer.getChannelData(c);
    const from = Math.max(0, Math.min(src.length, lag));
    const part = src.subarray(from, Math.min(src.length, from + frames));
    out.getChannelData(c).set(part, lag < 0 ? Math.min(frames, -lag) : 0);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// What can be saved
// ---------------------------------------------------------------------------------------------------------------

/** The kinds that have work in them now, with a default title for each. */
export function savableWork(app) {
  const out = [];
  if (app.engine?.currentBuffer && app.engine.recipe) {
    out.push({ kind: 'editor', title: baseName(app.engine.currentFileName) || 'Flova Parçası', duration: app.engine.currentBuffer.duration });
  }
  const m = app.merger;
  if (m?.tracks?.length) {
    out.push({ kind: 'merger', title: `Birleştirme (${m.tracks.length} parça)`, duration: m.calculateTotalMergedDuration?.() || 0 });
  }
  const v = app.vocalSplitter;
  if (v?.vocalBuffer && v.instBuffer && !v.isProcessing) {
    out.push({ kind: 'vocal', title: `${baseName(v.sourceFileName) || 'Parça'} (Vokal)`, duration: v.sourceBuffer?.duration || v.duration || 0 });
  }
  const s = app.stemSplitter;
  if (s && !s.isProcessing && STEM_KEYS.some((k) => s.stems[k]?.buffer)) {
    out.push({ kind: 'stems', title: `${baseName(s.sourceFileName) || 'Parça'} (Enstrümanlar)`, duration: s.sourceBuffer?.duration || s.duration || 0 });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Building documents
// ---------------------------------------------------------------------------------------------------------------

function currentEqPreset(eq) {
  const match = Object.entries(EQ_PRESETS).find(([, values]) => values.every((v, i) => Math.abs(v - eq[i]) < 0.01));
  return match ? match[0] : '';
}

function fxDoc(rack) {
  const p = rack.params;
  const eq = EQ_BANDS.map((b) => Number(p.eq[b]) || 0);
  return {
    volume: round(p.volume),
    playbackRate: round(p.playbackRate),
    pan: round(p.pan),
    autoPan: !!p.autoPan,
    eq,
    eqPreset: currentEqPreset(eq),
    reverbWet: round(p.reverbWet),
    echoWet: round(p.echoWet),
    echoTime: round(p.echoTime),
    mastering: MASTERING[rack.masteringRack?.currentPreset] || 'Bypass',
    makeup: round(p.makeup ?? 1)
  };
}

async function editorProject(app, onStatus) {
  const engine = app.engine;
  const recipe = engine.recipe;
  if (!engine.currentBuffer || !recipe) throw new Error('Kaydedilecek bir parça yok. Önce bir ses dosyası açın.');
  const file = await sourceFile(recipe.source, null, onStatus);
  file.title = engine.currentFileName;
  const duration = engine.currentBuffer.duration || 1;
  const hasSelection = app.selectionEnd > app.selectionStart;
  const fadeIn = parseFloat(app.editorFadeInNum?.value);
  const fadeOut = parseFloat(app.editorFadeOutNum?.value);
  return {
    files: [file],
    durationSeconds: engine.currentBuffer.duration,
    sampleRate: engine.currentBuffer.sampleRate,
    state: {
      formatVersion: FORMAT_VERSION,
      mode: 'Editor',
      editor: {
        name: engine.currentFileName || 'Flova Parçası',
        source: refOf(file),
        steps: recipe.steps.map(roundStep),
        applied: recipe.steps.length,
        selectionStart: hasSelection ? round(Math.max(0, app.selectionStart / duration), 6) : 0,
        selectionEnd: hasSelection ? round(Math.min(1, app.selectionEnd / duration), 6) : 0,
        markers: (app.waveform?.markers || []).map((m) => round(m.time)),
        fadeIn: Number.isFinite(fadeIn) ? fadeIn : 3,
        fadeOut: Number.isFinite(fadeOut) ? fadeOut : 3,
        loop: !!engine.isLooping,
        beatGrid: !!app.waveform?.showBeatGrid
      },
      fx: fxDoc(engine.effectsRack),
      lyrics: (app.lyricsModal?.lines || []).map((l) => ({ time: round(l.time, 3), text: String(l.text ?? '') }))
    }
  };
}

async function mergerProject(app, onStatus) {
  const m = app.merger;
  if (!m?.tracks?.length) throw new Error('Birleştiricide parça yok.');
  const files = [];
  const tracks = [];
  for (const [i, t] of m.tracks.entries()) {
    const file = await sourceFile(t.source || { buffer: t.buffer }, `${i + 1}. parça`, onStatus);
    file.title = t.name;
    files.push(file);
    tracks.push({
      name: t.name,
      asset: refOf(file),
      steps: (t.steps || []).map(roundStep),
      trimStart: round(t.trimStart || 0, 3),
      trimEnd: round(t.trimEnd ?? t.duration, 3),
      volume: round(t.volume ?? 1),
      fadeIn: round(t.fadeInSec || 0, 3),
      fadeOut: round(t.fadeOutSec || 0, 3),
      enabled: t.enabled !== false
    });
  }
  const rate = m.tracks[0].buffer.sampleRate;
  return {
    files,
    durationSeconds: m.calculateTotalMergedDuration?.() || 0,
    sampleRate: rate,
    state: {
      formatVersion: FORMAT_VERSION,
      mode: 'Merger',
      merger: {
        sampleRate: rate,
        tracks,
        mode: m.crossfadeMode === 'manual' ? 'Manual' : 'Auto',
        curve: CURVES[m.crossfadeCurve] || 'EqualPower',
        crossfade: round(m.crossfadeSec ?? 2, 3)
      }
    }
  };
}

async function splitterSource(splitter, onStatus) {
  const ext = extOf(splitter.sourceFileName);
  const source = splitter.sourceFile instanceof Blob ? { blob: splitter.sourceFile, ext, buffer: splitter.sourceBuffer } : { buffer: splitter.sourceBuffer };
  const file = await sourceFile(source, 'Kaynak parça', onStatus);
  file.title = splitter.sourceFileName;
  return file;
}

async function vocalProject(app, onStatus) {
  const v = app.vocalSplitter;
  if (!v?.vocalBuffer || !v.instBuffer) throw new Error('Önce vokal ayrıştırmasını tamamlayın.');
  const source = await splitterSource(v, onStatus);
  const vocal = await sourceFile({ buffer: v.vocalBuffer }, 'Vokal', onStatus);
  const inst = await sourceFile({ buffer: v.instBuffer }, 'Altyapı', onStatus);
  // The app's A/B: 0 mix, 1 vocal only, 2 instrumental only (the other channel muted).
  const abMode = v.vocalSolo && !v.instSolo ? 1 : v.instSolo && !v.vocalSolo ? 2 : 0;
  return {
    files: [source, vocal, inst],
    durationSeconds: v.sourceBuffer.duration,
    sampleRate: v.sourceBuffer.sampleRate,
    state: {
      formatVersion: FORMAT_VERSION,
      mode: 'Vocal',
      vocal: {
        name: v.sourceFileName || 'Parça',
        source: refOf(source),
        stemCount: 2,
        stems: [
          { key: 'vocal', asset: refOf(vocal), gain: round(v.vocalGain ?? 1), pan: 0, muted: !!v.vocalMuted || abMode === 2 },
          { key: 'inst', asset: refOf(inst), gain: round(v.instGain ?? 1), pan: 0, muted: !!v.instMuted || abMode === 1 }
        ],
        alignLag: 0,
        abMode,
        preset: 'Tümü'
      }
    }
  };
}

async function stemsProject(app, onStatus) {
  const s = app.stemSplitter;
  const keys = STEM_KEYS.filter((k) => s?.stems[k]?.buffer);
  if (!keys.length) throw new Error('Önce enstrüman ayrıştırmasını tamamlayın.');
  const source = await splitterSource(s, onStatus);
  const anySolo = keys.some((k) => s.stems[k].solo);
  const files = [source];
  const stems = [];
  for (const key of keys) {
    const st = s.stems[key];
    const file = await sourceFile({ buffer: st.buffer }, key, onStatus);
    files.push(file);
    stems.push({ key, asset: refOf(file), gain: round(st.gain ?? 1), pan: round(st.pan ?? 0), muted: !!st.muted || (anySolo && !st.solo) });
  }
  return {
    files,
    durationSeconds: s.sourceBuffer.duration,
    sampleRate: s.sourceBuffer.sampleRate,
    state: {
      formatVersion: FORMAT_VERSION,
      mode: 'Stems',
      stems: {
        name: s.sourceFileName || 'Parça',
        source: refOf(source),
        stemCount: s.separationMode === '6s' ? 6 : 4,
        stems,
        alignLag: 0,
        abMode: s.isComparingOriginal ? 0 : 1,
        preset: STEM_PRESETS[s.activePreset] || 'Tümü'
      }
    }
  };
}

const BUILDERS = { editor: editorProject, merger: mergerProject, vocal: vocalProject, stems: stemsProject };

/**
 * Saves [kind]'s screen as cloud project [projectId] (null: a new one) at [revision] (null: overwrite whatever
 * is there). Throws a ConflictError when another device saved in between. Returns the saved row.
 */
export async function saveProject(app, kind, { projectId = null, revision = null, title }, onStatus) {
  const build = BUILDERS[kind];
  if (!build) throw new Error('Bu ekran buluta kaydedilemiyor.');
  const user = supabaseService.requireUser();
  onStatus?.('Ses hazırlanıyor...');
  const { files, state, durationSeconds, sampleRate } = await build(app, onStatus);
  const assets = await ensureAssets(files, onStatus);

  onStatus?.('Proje kaydediliyor...');
  state.owner = user.id;
  const fields = { kind, title, durationSeconds: round(durationSeconds || 0, 3), sampleRate, formatVersion: FORMAT_VERSION };
  const row = projectId
    ? await supabaseService.updateProject(projectId, revision, fields, state)
    : await supabaseService.createProject(fields, state);
  const ids = [...new Set(files.map((f) => assets.get(f.sha256).id))];
  await supabaseService.linkAssets(row.id, ids);
  return row;
}

// ---------------------------------------------------------------------------------------------------------------
// Opening
// ---------------------------------------------------------------------------------------------------------------

/** True when opening a [kind] project would replace work on that screen. */
export function hasWork(app, kind) {
  return savableWork(app).some((w) => w.kind === kind) || (kind === 'vocal' && !!app.vocalSplitter?.sourceBuffer) || (kind === 'stems' && !!app.stemSplitter?.sourceBuffer);
}

/** Opens a cloud project on its screen: downloads its audio, replays edits, restores the settings. */
export async function openProject(app, project, onStatus) {
  const engine = app.engine;
  engine.ensureContext();
  const ctx = engine.ctx;
  const assets = new Map((await supabaseService.projectAssets(project.id)).map((a) => [a.sha256, a]));
  const state = project.state || {};
  switch (project.kind) {
    case 'editor': return openEditor(app, ctx, project, state, assets, onStatus);
    case 'merger': return openMerger(app, ctx, state.merger, assets, onStatus);
    case 'vocal': return openVocal(app, ctx, project, state.vocal, assets, onStatus);
    case 'stems': return openStems(app, ctx, project, state.stems, assets, onStatus);
    default: throw new Error('Bu proje türü açılamıyor.');
  }
}

async function openEditor(app, ctx, project, state, assets, onStatus) {
  const doc = state.editor;
  if (!doc?.source?.id) throw new Error('Projede düzenleyici verisi yok.');
  const engine = app.engine;
  const steps = Array.isArray(doc.steps) ? doc.steps : [];
  const applied = Math.max(0, Math.min(steps.length, Number.isInteger(doc.applied) ? doc.applied : steps.length));

  // Start from the last stored full result instead of replaying everything before it.
  let from = -1;
  for (let i = applied - 1; i >= 0; i--) if (steps[i].op === 'replace') { from = i; break; }
  onStatus?.('Ses dosyası indiriliyor...');
  let { buffer, source } = await loadAsset(ctx, from >= 0 ? steps[from].asset : doc.source, assets);
  onStatus?.('Düzenlemeler uygulanıyor...');
  const replayed = [];
  for (let i = from + 1; i < applied; i++) {
    buffer = applyStep(ctx, buffer, steps[i]);
    replayed.push(steps[i]);
  }

  const duration = buffer.duration;
  const selection = doc.selectionEnd > doc.selectionStart ? { start: doc.selectionStart * duration, end: doc.selectionEnd * duration } : null;
  app.switchMode?.('editor');
  engine.loadFromRecipe(buffer, { source, steps: replayed }, doc.name || project.title, selection);
  if (app.visualizer) app.visualizer.setAnalyser(engine.analyser);
  restoreEditorUi(app, doc, selection);
  if (state.fx) restoreFx(app, state.fx);
  if (app.lyricsModal) {
    app.lyricsModal.lines = (state.lyrics || []).map((l) => ({ time: Number(l.time) || 0, text: String(l.text ?? '') }));
    app.lyricsModal._renderLines?.();
  }
}

async function openMerger(app, ctx, doc, assets, onStatus) {
  if (!doc?.tracks?.length) throw new Error('Projede birleştirici verisi yok.');
  const tracks = [];
  for (const [i, t] of doc.tracks.entries()) {
    onStatus?.(`Parçalar indiriliyor (${i + 1}/${doc.tracks.length})...`);
    let { buffer, source } = await loadAsset(ctx, t.asset, assets);
    for (const step of t.steps || []) buffer = applyStep(ctx, buffer, step);
    tracks.push({ ...t, buffer, source, trimEnd: t.trimEnd ?? buffer.duration });
  }
  app.switchMode?.('merger');
  app.merger.restoreSession(tracks, {
    mode: doc.mode === 'Manual' ? 'manual' : 'auto',
    curve: keyOf(CURVES, doc.curve, 'equal-power'),
    crossfadeSec: Number.isFinite(doc.crossfade) ? doc.crossfade : 2
  });
}

/** The source and the stems of a splitter project, stems lined up with the source as in the app. */
async function loadSplitter(ctx, project, doc, assets, onStatus) {
  onStatus?.('Kaynak parça indiriliyor...');
  const src = await loadAsset(ctx, doc.source, assets);
  const stems = [];
  for (const [i, s] of (doc.stems || []).entries()) {
    onStatus?.(`Kanallar indiriliyor (${i + 1}/${doc.stems.length})...`);
    const { buffer } = await loadAsset(ctx, s.asset, assets);
    // alignLag is in frames at the source's sample rate (the project row's sample_rate).
    const lagSeconds = (Number(doc.alignLag) || 0) / (project.sample_rate || buffer.sampleRate);
    stems.push({ ...s, buffer: alignBuffer(ctx, buffer, lagSeconds, src.buffer.length) });
  }
  return { src, stems };
}

async function openVocal(app, ctx, project, doc, assets, onStatus) {
  if (!doc?.source?.id) throw new Error('Projede vokal verisi yok.');
  const v = app.vocalSplitter;
  const { src, stems } = await loadSplitter(ctx, project, doc, assets, onStatus);
  app.switchMode?.('vocal-splitter');
  const vocal = stems.find((s) => s.key === 'vocal');
  const inst = stems.find((s) => s.key === 'inst');
  if (!vocal || !inst) {
    // Saved before the separation: the site separates on load.
    await v.loadBuffer(src.buffer, doc.name || project.title, src.source.blob);
    return;
  }
  v.stop();
  v.sourceBuffer = src.buffer;
  v.sourceFile = src.source.blob;
  v.sourceFileName = doc.name || project.title;
  v.vocalBuffer = vocal.buffer;
  v.instBuffer = inst.buffer;
  v.vocalGain = vocal.gain ?? 1;
  v.instGain = inst.gain ?? 1;
  v.vocalSolo = doc.abMode === 1;
  v.instSolo = doc.abMode === 2;
  // In the app the A/B choice mutes the other channel; here solo does that.
  v.vocalMuted = !!vocal.muted && doc.abMode !== 2;
  v.instMuted = !!inst.muted && doc.abMode !== 1;
  v.engineMode = 'ai';
  v.isProcessing = false;
  v.currentProgress = null;
  v.duration = vocal.buffer.duration;
  v.currentTime = 0;
  v.pausedOffset = 0;
  v.render();
  v.updateTimeDisplays?.();
  setTimeout(() => v.drawWaveforms?.(), 80);
}

async function openStems(app, ctx, project, doc, assets, onStatus) {
  if (!doc?.source?.id) throw new Error('Projede enstrüman verisi yok.');
  const s = app.stemSplitter;
  const { src, stems } = await loadSplitter(ctx, project, doc, assets, onStatus);
  app.switchMode?.('stem-splitter');
  if (!stems.length) {
    s.separationMode = doc.stemCount === 6 ? '6s' : '4s';
    await s.loadBuffer(src.buffer, doc.name || project.title, src.source.blob);
    return;
  }
  s.stop();
  s.sourceBuffer = src.buffer;
  s.sourceFile = src.source.blob;
  s.sourceFileName = doc.name || project.title;
  s.separationMode = doc.stemCount === 6 ? '6s' : '4s';
  for (const key of STEM_KEYS) Object.assign(s.stems[key], { buffer: null, gain: 1, pan: 0, muted: false, solo: false });
  for (const st of stems) {
    if (!s.stems[st.key]) continue;
    Object.assign(s.stems[st.key], { buffer: st.buffer, gain: st.gain ?? 1, pan: st.pan ?? 0, muted: !!st.muted, solo: false });
  }
  s.activePreset = keyOf(STEM_PRESETS, doc.preset, 'all');
  s.isComparingOriginal = doc.abMode === 0;
  s.isProcessing = false;
  s.currentProgress = null;
  s.duration = src.buffer.duration;
  s.currentTime = 0;
  s.pausedOffset = 0;
  s.render();
  s.updateTimeDisplays?.();
  setTimeout(() => s.drawAllWaveforms?.(), 100);
}

function restoreEditorUi(app, doc, selection) {
  const engine = app.engine;
  if (selection) {
    app.selectionStart = selection.start;
    app.selectionEnd = selection.end;
    app.waveform?.setSelection(selection.start, selection.end);
  }
  if (app.waveform) {
    app.waveform.clearMarkers();
    (doc.markers || []).forEach((t, i) => app.waveform.addMarker(t, `Bölüm ${i + 1}`));
    if (!!doc.beatGrid !== !!app.waveform.showBeatGrid) app.beatGridToggleBtn?.click();
  }
  const setFade = (num, slider, v) => {
    if (num && Number.isFinite(v)) num.value = Number(v).toFixed(1);
    if (slider && Number.isFinite(v)) slider.value = v;
  };
  setFade(app.editorFadeInNum, app.editorFadeInSlider, doc.fadeIn);
  setFade(app.editorFadeOutNum, app.editorFadeOutSlider, doc.fadeOut);
  if (!!doc.loop !== !!engine.isLooping) {
    engine.isLooping = !!doc.loop;
    engine.useLoopRegion = engine.isLooping;
    app.loopBtn?.classList.toggle('active', engine.isLooping);
  }
}

/** Sets the effect controls the way a user would (their own handlers update the rack and the labels). */
function restoreFx(app, fx) {
  const rack = app.engine.effectsRack;
  const set = (id, value) => {
    const el = document.getElementById(id);
    if (!el || value === undefined || value === null || !Number.isFinite(Number(value))) return;
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  set('masterVolumeSlider', fx.volume);
  set('speedSlider', fx.playbackRate);
  set('panSlider', fx.pan);
  set('reverbWetSlider', fx.reverbWet);
  set('echoWetSlider', fx.echoWet);
  set('echoTimeSlider', fx.echoTime);
  (fx.eq || []).slice(0, EQ_BANDS.length).forEach((v, i) => set(`eq_${EQ_BANDS[i]}`, v));

  const autoPan = document.getElementById('autoPanCheckbox');
  if (autoPan && autoPan.checked !== !!fx.autoPan) {
    autoPan.checked = !!fx.autoPan;
    rack.setAutoPan(autoPan.checked);
  }

  const key = keyOf(MASTERING, fx.mastering, 'bypass');
  rack.applyMasteringPreset(key);
  document.querySelectorAll('[data-lufs]').forEach((c) => c.classList.toggle('active', c.dataset.lufs === key));
  const badge = document.getElementById('masterLufsReductionVal');
  if (badge) badge.textContent = key === 'bypass' ? 'Bypass' : `${key.toUpperCase()} Aktif`;
  set('masterMakeupSlider', fx.makeup);
}
