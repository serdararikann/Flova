/* ====================================================================
   FLOVA AUDIO STUDIO - SUPABASE CLIENT & CLOUD DATABASE SERVICE
   - Authentication (sign in/up/out, password reset, e-mail links)
   - Profile (flova_profiles: display name, settings, storage use)
   - Cloud projects, shared with the mobile app (supabase/schema.sql):
     flova_projects (state = SessionDoc, revision, deleted_at trash),
     flova_assets (audio files by sha256), flova_project_assets,
     private flova-media bucket (<user>/<sha256>.<ext>)
   ==================================================================== */

export const SUPABASE_CONFIG = {
  url: 'https://wmtlmgxnsvjsuegutbce.supabase.co',
  anonKey: 'sb_publishable_PzBm4mWIQtsKzdqRRSIV1Q_YiFeQiQI'
};

/** "Google ile devam et": on once Google is enabled in Supabase (Authentication > Providers > Google). */
export const GOOGLE_SIGN_IN = true;
/** Set before leaving for Google: the session that comes back is a new sign-in (the account's settings win). */
const OAUTH_PENDING_KEY = 'flova_oauth_pending';

export const MEDIA_BUCKET = 'flova-media';
/** Supabase free tier: 50 MB per file. */
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
/** Days a deleted project stays in the trash before it is removed for good (with the app). */
export const TRASH_DAYS = 30;

/** Saving with a stale revision: the project changed on another device since it was opened here. */
export class ConflictError extends Error {
  constructor() {
    super('Bu proje başka bir cihazda değiştirilmiş.');
    this.name = 'ConflictError';
  }
}

/** Turkish text for Supabase Auth errors (same wording as the mobile app). */
export function authErrorMessage(err) {
  const code = err?.code || err?.error_code || '';
  const msg = String(err?.message || err?.error_description || '');
  const has = (t) => msg.toLowerCase().includes(t.toLowerCase());
  if (code === 'invalid_credentials' || has('Invalid login credentials')) return 'E-posta veya şifre hatalı.';
  if (code === 'email_not_confirmed' || has('Email not confirmed')) return 'E-posta adresiniz henüz onaylanmadı. Gelen kutunuzdaki onay bağlantısına tıklayın.';
  if (code === 'user_already_exists' || code === 'email_exists' || has('already registered')) return 'Bu e-posta adresiyle zaten bir hesap var. Giriş yapmayı deneyin.';
  if (code === 'weak_password' || has('Password should be')) return 'Şifre çok zayıf; en az 6 karakter olmalı.';
  if (code === 'same_password') return 'Yeni şifre eskisiyle aynı olamaz.';
  if (code === 'reauthentication_needed') return 'Güvenlik için lütfen çıkış yapıp tekrar giriş yaptıktan sonra deneyin.';
  if (code === 'email_address_invalid' || code === 'validation_failed' || has('invalid format')) return 'Geçerli bir e-posta adresi girin.';
  if (code === 'signup_disabled') return 'Şu anda yeni kayıt alınmıyor.';
  if (code === 'otp_expired') return 'Bağlantının süresi dolmuş ya da daha önce kullanılmış. Lütfen yeni bir bağlantı isteyin.';
  if (['refresh_token_not_found', 'refresh_token_already_used', 'session_not_found'].includes(code)) return 'Oturumunuzun süresi doldu, lütfen tekrar giriş yapın.';
  if (err?.status === 429 || code.startsWith('over_')) return 'Çok fazla deneme yapıldı. Lütfen biraz sonra tekrar deneyin.';
  if (err?.status >= 500) return 'Sunucu şu anda yanıt vermiyor. Lütfen daha sonra tekrar deneyin.';
  if (has('Failed to fetch') || has('NetworkError') || has('Load failed')) return 'Sunucuya ulaşılamadı. İnternet bağlantınızı kontrol edin.';
  return msg || 'Bir hata oluştu. Lütfen tekrar deneyin.';
}

/** Turkish text for PostgREST / Storage errors. */
function cloudError(err, fallback = 'Bulut işlemi başarısız oldu.') {
  const status = Number(err?.status || err?.statusCode || 0);
  const msg = String(err?.message || '');
  if (status === 401 || /JWT|expired/i.test(msg)) return new Error('Oturumunuzun süresi doldu, lütfen tekrar giriş yapın.');
  if (status === 403 || /row-level security/i.test(msg)) return new Error('Bu işlem için yetkiniz yok.');
  if (/maximum allowed size|Payload too large/i.test(msg) || status === 413) return new Error('Dosya bulut için çok büyük (en fazla 50 MB).');
  if (/mime type/i.test(msg)) return new Error('Bu dosya türü buluta yüklenemiyor.');
  if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) return new Error('Sunucuya ulaşılamadı. İnternet bağlantınızı kontrol edin.');
  return new Error(fallback + (status ? ` (${status})` : ''));
}

/** Where e-mail links (sign-up confirmation, password reset) come back to: this site. */
function siteUrl() {
  return window.location.origin + '/';
}

const PROFILE_COLUMNS = 'id, display_name, avatar_url, tier, storage_used_bytes, settings';

const REMEMBER_KEY = 'flova_remember_me';
const HIDDEN_SINCE_KEY = 'flova_hidden_since';
/** A session that isn't remembered ends after this long in the background (as in the mobile app). */
export const IDLE_SIGN_OUT_MS = 30 * 60 * 1000;

function rememberSession() {
  // Off unless chosen, as in the mobile app.
  try { return localStorage.getItem(REMEMBER_KEY) === '1'; } catch (_) { return false; }
}

/**
 * Where supabase-js keeps the session. With "Beni hatırla" it is localStorage (survives closing the browser);
 * without it sessionStorage, so it ends with the tab, like the app's in-memory session.
 */
const sessionStore = {
  getItem(key) {
    try { return sessionStorage.getItem(key) ?? localStorage.getItem(key); } catch (_) { return null; }
  },
  setItem(key, value) {
    try {
      const [target, other] = rememberSession() ? [localStorage, sessionStorage] : [sessionStorage, localStorage];
      target.setItem(key, value);
      other.removeItem(key);
    } catch (_) { /* storage blocked: the session lasts until the page closes */ }
  },
  removeItem(key) {
    try { localStorage.removeItem(key); sessionStorage.removeItem(key); } catch (_) {}
  }
};

class SupabaseService {
  constructor() {
    this.client = null;
    this.currentUser = null;
    this.currentSession = null;
    this.currentProfile = null;
    this.authListeners = [];
    this.isInitialized = false;
    /** An error carried by an e-mail link (e.g. an expired reset link), shown once by the account window. */
    this.linkError = null;
    /** True after a password-reset link signed the user in: the account window asks for a new password. */
    this.recovering = false;

    this.readLinkError();
    this.init();
  }

  /** Supabase puts link errors in the fragment (#error=...&error_code=otp_expired&error_description=...). */
  readLinkError() {
    try {
      const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
      if (!hash.get('error') && !hash.get('error_code')) return;
      this.linkError = authErrorMessage({ code: hash.get('error_code') || '', message: hash.get('error_description') || '' });
      history.replaceState(null, '', window.location.pathname + window.location.search);
    } catch (_) { /* no usable URL */ }
  }

  init() {
    if (typeof window !== 'undefined' && window.supabase && window.supabase.createClient) {
      try {
        this.client = window.supabase.createClient(SUPABASE_CONFIG.url, SUPABASE_CONFIG.anonKey, {
          auth: {
            persistSession: true,
            autoRefreshToken: true,
            detectSessionInUrl: true,
            storage: sessionStore
          }
        });
        this.isInitialized = true;
        this.setupAuthListener();
        this.setupIdleSignOut();
      } catch (err) {
        console.error('[Flova Supabase] Initialization error:', err);
      }
    } else {
      // CDN script might still be loading, wait for it
      window.addEventListener('load', () => {
        if (!this.client && window.supabase && window.supabase.createClient) {
          this.init();
        }
      });
    }
  }

  setupAuthListener() {
    if (!this.client) return;

    this.client.auth.onAuthStateChange((event, session) => {
      const previousUser = this.currentUser?.id || null;
      this.currentSession = session;
      this.currentUser = session ? session.user : null;
      if (event === 'PASSWORD_RECOVERY') this.recovering = true;
      if (!this.currentUser) {
        this.currentProfile = null;
        this.recovering = false;
      }
      // Supabase awaits this callback: other auth calls made from inside it would deadlock.
      setTimeout(async () => {
        if (this.currentUser && (this.currentUser.id !== previousUser || !this.currentProfile)) {
          await this.fetchProfile();
        }
        this.notifyAuthListeners(event, session);
      }, 0);
    });
  }

  get remembered() {
    return rememberSession();
  }

  /** Signs out a session that isn't remembered after IDLE_SIGN_OUT_MS with the page in the background. */
  setupIdleSignOut() {
    const check = () => {
      let since = null;
      try { since = Number(sessionStorage.getItem(HIDDEN_SINCE_KEY)) || null; } catch (_) {}
      if (since && this.currentUser && !rememberSession() && Date.now() - since >= IDLE_SIGN_OUT_MS) {
        this.idleSignedOut = true;
        this.signOut().then(() => this.notifyAuthListeners('IDLE_SIGNED_OUT'));
      }
    };
    document.addEventListener('visibilitychange', () => {
      try {
        if (document.hidden) sessionStorage.setItem(HIDDEN_SINCE_KEY, String(Date.now()));
        else {
          check();
          sessionStorage.removeItem(HIDDEN_SINCE_KEY);
        }
      } catch (_) {}
    });
    // The tab may also have been reloaded after a long time in the background.
    this.client.auth.getSession().then(() => {
      if (!document.hidden) {
        check();
        try { sessionStorage.removeItem(HIDDEN_SINCE_KEY); } catch (_) {}
      }
    });
  }

  isLoggedIn() {
    return !!(this.currentSession && this.currentUser);
  }

  /**
   * Subscribe to auth state changes (callbacks receive { event, user, profile })
   */
  onAuthStateChange(callback) {
    this.authListeners.push(callback);
    if (this.isInitialized) {
      callback({ event: 'SUBSCRIBED', user: this.currentUser, profile: this.currentProfile });
    }
    return () => {
      this.authListeners = this.authListeners.filter(cb => cb !== callback);
    };
  }

  notifyAuthListeners(event, session = this.currentSession) {
    const payload = { event, session, user: this.currentUser, profile: this.currentProfile };
    this.authListeners.forEach(cb => {
      try {
        cb(payload);
      } catch (e) {
        console.error('[Flova Supabase] Auth listener callback error:', e);
      }
    });
  }

  requireClient() {
    if (!this.client) throw new Error('Bulut hizmeti yüklenemedi. Sayfayı yenileyip tekrar deneyin.');
  }

  requireUser() {
    this.requireClient();
    if (!this.currentUser) throw new Error('Oturumunuz aktif değil. Lütfen önce giriş yapın.');
    return this.currentUser;
  }

  // ==========================================
  // AUTHENTICATION
  // ==========================================

  /** Returns { needsConfirm: true } when the project asks new users to confirm their e-mail first. */
  /** "Beni hatırla": set before signing in, it decides where the new session is stored. */
  setRemember(remember) {
    try { localStorage.setItem(REMEMBER_KEY, remember ? '1' : '0'); } catch (_) {}
  }

  async signUp(email, password, displayName = '') {
    this.requireClient();
    const { data, error } = await this.client.auth.signUp({
      email,
      password,
      options: {
        // lang: the language Supabase's e-mails use for this account (the app keeps it on its UI language)
        data: { full_name: displayName || email.split('@')[0], lang: 'tr' },
        emailRedirectTo: siteUrl()
      }
    });
    if (error) throw new Error(authErrorMessage(error));
    // With "Confirm email" on, an address that is already registered also comes back without a session
    // and without identities (Supabase hides that it exists).
    if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
      throw new Error(authErrorMessage({ code: 'user_already_exists' }));
    }
    return { needsConfirm: !data.session };
  }

  async signIn(email, password) {
    this.requireClient();
    const { error } = await this.client.auth.signInWithPassword({ email, password });
    if (error) throw new Error(authErrorMessage(error));
  }

  /** Leaves for Google's account page; supabase-js picks the session up when it comes back (detectSessionInUrl). */
  async signInWithGoogle() {
    this.requireClient();
    try { sessionStorage.setItem(OAUTH_PENDING_KEY, '1'); } catch (_) {}
    const { error } = await this.client.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: siteUrl() } });
    if (error) {
      try { sessionStorage.removeItem(OAUTH_PENDING_KEY); } catch (_) {}
      throw new Error(authErrorMessage(error));
    }
  }

  /** True once after coming back from Google signed in. */
  takeOAuthReturn() {
    try {
      const pending = sessionStorage.getItem(OAUTH_PENDING_KEY) === '1';
      sessionStorage.removeItem(OAUTH_PENDING_KEY);
      return pending;
    } catch (_) { return false; }
  }

  async signOut() {
    if (!this.client) return;
    // 'local': ends this browser's session even when offline or the token already expired.
    const { error } = await this.client.auth.signOut({ scope: 'local' });
    if (error) console.warn('[Flova Supabase] Sign out:', error);
    this.currentSession = null;
    this.currentUser = null;
    this.currentProfile = null;
    this.recovering = false;
  }

  async sendPasswordReset(email) {
    this.requireClient();
    const { error } = await this.client.auth.resetPasswordForEmail(email, { redirectTo: siteUrl() });
    if (error) throw new Error(authErrorMessage(error));
  }

  async updatePassword(password) {
    this.requireUser();
    const { error } = await this.client.auth.updateUser({ password });
    if (error) throw new Error(authErrorMessage(error));
    this.recovering = false;
  }

  // ==========================================
  // PROFILE (flova_profiles)
  // ==========================================

  async fetchProfile() {
    if (!this.client || !this.currentUser) return null;
    try {
      const { data, error } = await this.client
        .from('flova_profiles')
        .select(PROFILE_COLUMNS)
        .eq('id', this.currentUser.id)
        .maybeSingle();
      if (!error && data) {
        this.currentProfile = data;
        return data;
      }
    } catch (e) {
      console.warn('[Flova Supabase] Could not fetch profile:', e);
    }
    return null;
  }

  /** Updates the display name and/or merges keys into settings (the mobile app's keys are kept). */
  async updateProfile({ displayName, settings } = {}) {
    const user = this.requireUser();
    const patch = {};
    if (displayName !== undefined) patch.display_name = String(displayName).trim().slice(0, 60) || null;
    if (settings) patch.settings = { ...(this.currentProfile?.settings || {}), ...settings };
    if (!Object.keys(patch).length) return this.currentProfile;
    const { data, error } = await this.client
      .from('flova_profiles')
      .update(patch)
      .eq('id', user.id)
      .select(PROFILE_COLUMNS)
      .maybeSingle();
    if (error) throw cloudError(error, 'Profil kaydedilemedi.');
    if (data) this.currentProfile = data;
    return this.currentProfile;
  }

  // ==========================================
  // CLOUD PROJECTS (flova_projects)
  // ==========================================

  async listProjects() {
    this.requireUser();
    const { data, error } = await this.client
      .from('flova_projects')
      .select('id, kind, title, revision, duration_seconds, updated_at, flova_project_assets(flova_assets(bytes))')
      .is('deleted_at', null)
      .order('updated_at', { ascending: false });
    if (error) throw cloudError(error, 'Projeler yüklenemedi.');
    return (data || []).map((p) => ({
      ...p,
      fileCount: (p.flova_project_assets || []).length,
      sizeBytes: (p.flova_project_assets || []).reduce((sum, row) => sum + (row.flova_assets?.bytes || 0), 0)
    }));
  }

  async getProject(id) {
    this.requireUser();
    const { data, error } = await this.client
      .from('flova_projects')
      .select('id, kind, title, revision, state, format_version, sample_rate, deleted_at')
      .eq('id', id)
      .maybeSingle();
    if (error) throw cloudError(error, 'Proje açılamadı.');
    if (!data || data.deleted_at) throw new Error('Proje bulunamadı (silinmiş olabilir).');
    return data;
  }

  projectRow({ kind, title, durationSeconds, sampleRate, formatVersion }, state) {
    return {
      kind,
      title: (title || '').trim().slice(0, 120) || 'Adsız Proje',
      state,
      format_version: formatVersion || 1,
      duration_seconds: durationSeconds || 0,
      sample_rate: sampleRate || null
    };
  }

  async createProject(fields, state) {
    this.requireUser();
    const { data, error } = await this.client
      .from('flova_projects')
      .insert(this.projectRow(fields, state))
      .select('id, kind, title, revision, duration_seconds, updated_at')
      .single();
    if (error) throw cloudError(error, 'Proje kaydedilemedi.');
    return data;
  }

  /** Saves over [id] if it is still at [revision] (null: overwrite whatever is there). */
  async updateProject(id, revision, fields, state) {
    this.requireUser();
    let query = this.client.from('flova_projects').update(this.projectRow(fields, state)).eq('id', id);
    if (revision != null) query = query.eq('revision', revision);
    const { data, error } = await query.select('id, kind, title, revision, duration_seconds, updated_at');
    if (error) throw cloudError(error, 'Proje kaydedilemedi.');
    if (!data || !data.length) throw new ConflictError();
    return data[0];
  }

  async renameProject(id, title) {
    this.requireUser();
    const { error } = await this.client
      .from('flova_projects')
      .update({ title: (title || '').trim().slice(0, 120) || 'Adsız Proje' })
      .eq('id', id);
    if (error) throw cloudError(error, 'Proje adı değiştirilemedi.');
  }

  /** Moves the project to the trash (deleted_at), so the deletion also reaches the other devices. */
  async trashProject(id) {
    this.requireUser();
    const { error } = await this.client
      .from('flova_projects')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', id);
    if (error) throw cloudError(error, 'Proje silinemedi.');
  }

  /** Projects in the trash, most recently deleted first. */
  async listTrash() {
    this.requireUser();
    const { data, error } = await this.client
      .from('flova_projects')
      .select('id, kind, title, duration_seconds, deleted_at')
      .not('deleted_at', 'is', null)
      .order('deleted_at', { ascending: false });
    if (error) throw cloudError(error, 'Çöp kutusu yüklenemedi.');
    return data || [];
  }

  async restoreProject(id) {
    this.requireUser();
    const { error } = await this.client.from('flova_projects').update({ deleted_at: null }).eq('id', id);
    if (error) throw cloudError(error, 'Proje geri alınamadı.');
  }

  /** Deletes a project for good; its files go with the next purge. */
  async deleteProjectForever(id) {
    this.requireUser();
    const { error } = await this.client.from('flova_projects').delete().eq('id', id);
    if (error) throw cloudError(error, 'Proje silinemedi.');
  }

  /**
   * Empties the trash of projects older than [TRASH_DAYS] and deletes the audio files no project uses
   * (flova_purge in schema.sql). Returns { files, bytes } removed; quietly does nothing on a database
   * without the function.
   */
  async purgeUnused() {
    this.requireUser();
    const { data, error } = await this.client.rpc('flova_purge', { trash_days: TRASH_DAYS });
    if (error) {
      if (error.code === 'PGRST202' || error.code === '42883') return { files: 0, bytes: 0 };
      throw cloudError(error, 'Bulut temizliği yapılamadı.');
    }
    let files = 0;
    let bytes = 0;
    for (const row of data || []) {
      // The row first: if a save linked the file in the meantime, the row can't be deleted and the file stays.
      const { error: rowError, count } = await this.client.from('flova_assets').delete({ count: 'exact' }).eq('id', row.asset_id);
      if (rowError || !count) continue;
      await this.client.storage.from(MEDIA_BUCKET).remove([row.asset_key]);
      files++;
      bytes += Number(row.asset_bytes) || 0;
    }
    if (files) await this.fetchProfile();
    return { files, bytes };
  }

  /**
   * Deletes the account for good, as the app does: every file in the user's flova-media folder, then the rows and the
   * auth user (flova_delete_account in schema.sql). Signs out afterwards.
   */
  async deleteAccount() {
    const user = this.requireUser();
    const bucket = this.client.storage.from(MEDIA_BUCKET);
    for (;;) {
      const { data, error } = await bucket.list(user.id, { limit: 1000 });
      if (error) throw cloudError(error, 'Dosyalar silinemedi.');
      const files = (data || []).filter((f) => f.id); // folders have no id
      if (!files.length) break;
      const { error: removeError } = await bucket.remove(files.map((f) => `${user.id}/${f.name}`));
      if (removeError) throw cloudError(removeError, 'Dosyalar silinemedi.');
    }
    const { error } = await this.client.rpc('flova_delete_account');
    if (error) {
      if (error.code === 'PGRST202' || error.code === '42883') throw new Error('Hesap silme sunucuda henüz etkin değil. Lütfen daha sonra tekrar deneyin.');
      throw cloudError(error, 'Hesap silinemedi.');
    }
    await this.signOut();
  }

  // ==========================================
  // AUDIO ASSETS (flova_assets + flova-media)
  // ==========================================

  storageKey(sha256, ext) {
    return `${this.requireUser().id}/${sha256}.${ext}`;
  }

  /** The user's asset rows with these hashes (the files already uploaded). */
  async assetsBySha(shas) {
    this.requireUser();
    if (!shas.length) return [];
    const { data, error } = await this.client
      .from('flova_assets')
      .select('id, sha256, storage_key, mime, bytes')
      .in('sha256', shas);
    if (error) throw cloudError(error);
    return data || [];
  }

  /** The asset rows a project uses. */
  async projectAssets(projectId) {
    this.requireUser();
    const { data, error } = await this.client
      .from('flova_project_assets')
      .select('asset:flova_assets(id, sha256, storage_key, mime, bytes)')
      .eq('project_id', projectId);
    if (error) throw cloudError(error);
    return (data || []).map((r) => r.asset).filter(Boolean);
  }

  /** Uploads one file; a file already there (same content, same name) counts as done. */
  async uploadFile(storageKey, blob, mime) {
    this.requireUser();
    const { error } = await this.client.storage.from(MEDIA_BUCKET).upload(storageKey, blob, { contentType: mime, upsert: false });
    if (!error) return;
    const msg = String(error.message || '');
    if (/Duplicate|already exists/i.test(msg) || String(error.statusCode) === '409' || error.status === 409) return;
    throw cloudError(error, 'Dosya yüklenemedi.');
  }

  /** Registers uploaded files (rows that already exist are left alone). */
  async addAssets(assets) {
    this.requireUser();
    if (!assets.length) return;
    const { error } = await this.client
      .from('flova_assets')
      .upsert(assets.map((a) => ({
        sha256: a.sha256,
        storage_key: a.storageKey,
        mime: a.mime,
        bytes: a.bytes,
        title: a.title ? String(a.title).slice(0, 200) : null
      })), { onConflict: 'user_id,sha256', ignoreDuplicates: true });
    if (error) throw cloudError(error, 'Dosya kaydedilemedi.');
  }

  /** Points [projectId] at exactly [assetIds]. */
  async linkAssets(projectId, assetIds) {
    this.requireUser();
    const { error: delError } = await this.client.from('flova_project_assets').delete().eq('project_id', projectId);
    if (delError) throw cloudError(delError);
    if (!assetIds.length) return;
    const { error } = await this.client
      .from('flova_project_assets')
      .insert([...new Set(assetIds)].map((id) => ({ project_id: projectId, asset_id: id })));
    if (error) throw cloudError(error);
  }

  async downloadFile(storageKey) {
    this.requireUser();
    const { data, error } = await this.client.storage.from(MEDIA_BUCKET).download(storageKey);
    if (error) throw cloudError(error, 'Ses dosyası indirilemedi.');
    return data;
  }
}

// One service per page even if this module is loaded twice (the dev server imports it with and without the
// ?v= query): two auth clients would both refresh, and spend, the same refresh token.
export const supabaseService = window.__flovaSupabaseService || (window.__flovaSupabaseService = new SupabaseService());
