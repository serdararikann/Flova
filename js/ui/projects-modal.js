/* ====================================================================
   FLOVA AUDIO STUDIO - CLOUD PROJECTS MODAL ("Projelerim")
   - Save a screen (editor, merger, vocal or stem splitter) as a cloud
     project; Ctrl+S saves over the screen's open project
   - Save as a new project, rename, move to the trash
   - Open any project on its screen (the same projects as the mobile app)
   - Trash: restore or delete for good; old trash and unused files are
     cleaned in the background
   ==================================================================== */

import { supabaseService, TRASH_DAYS } from '../db/supabase-client.js';
import { saveProject, openProject, savableWork, hasWork, KIND_LABELS, KIND_SCREENS } from '../project/projects.js';

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cleanTitle = (s) => String(s || '').replace(/\.[^/.]+$/, '').replace(/\s*Bulut\s*$/, '').trim();
const KINDS = ['editor', 'merger', 'vocal', 'stems'];

function formatBytes(bytes) {
  if (!bytes) return '';
  if (bytes < 1048576) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function formatDuration(sec) {
  const s = Math.round(Number(sec) || 0);
  if (!s) return '';
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export class ProjectsModal {
  constructor(containerElement, studioApp) {
    this.container = containerElement;
    this.app = studioApp;
    this.isOpen = false;
    this.isLoading = false;
    this.isSaving = false;
    this.busyId = null;          // project being opened
    this.status = '';            // progress line while saving / opening
    this.error = '';
    this.projectsList = [];
    this.trashList = [];
    this.showTrash = false;
    this.loaded = false;
    this.selectedKind = null;

    /**
     * Screen → the cloud project it came from or was saved to ({ id, revision, title, anchor }); saving that
     * screen again updates it. A splitter's link holds while it shows the same source ([anchor]).
     */
    this.links = {};

    this.render();
    supabaseService.onAuthStateChange(({ event, user }) => {
      if (!user) {
        // Signed out: the open projects aren't this browser's to save any more.
        const hadEditor = !!this.links.editor;
        this.links = {};
        if (hadEditor && typeof this.app?.renderTrackTitle === 'function') this.app.renderTrackTitle();
        this.projectsList = [];
        this.trashList = [];
        this.loaded = false;
        this.purged = false;
      } else if (event === 'SIGNED_IN' && this.isOpen) {
        this.fetchProjects();
      }
      if (this.isOpen) this.renderContent();
    });
  }

  // The editor's link, as app.js knows it (track title, "Bulut" badge).
  get currentLoadedProjectId() { return this.links.editor?.id || null; }
  get currentLoadedProjectTitle() { return this.links.editor?.title || null; }
  set currentLoadedProjectTitle(title) {
    if (this.links.editor) this.links.editor.title = title;
  }

  /** The link of [kind]'s screen if it still shows that project's work. */
  linkFor(kind) {
    const link = this.links[kind];
    if (!link) return null;
    if (kind === 'merger' && !this.app?.merger?.tracks?.length) return null;
    if (kind === 'vocal' && link.anchor !== this.app?.vocalSplitter?.sourceBuffer) return null;
    if (kind === 'stems' && link.anchor !== this.app?.stemSplitter?.sourceBuffer) return null;
    return link;
  }

  anchorFor(kind) {
    if (kind === 'vocal') return this.app?.vocalSplitter?.sourceBuffer || null;
    if (kind === 'stems') return this.app?.stemSplitter?.sourceBuffer || null;
    return null;
  }

  /** The project kind of the screen shown now. */
  currentKind() {
    return KINDS.find((k) => KIND_SCREENS[k] === this.app?.activeMode) || 'editor';
  }

  open(kind = null) {
    this.isOpen = true;
    this.error = '';
    this.selectedKind = kind || this.currentKind();
    this.container.classList.add('active');
    this.container.style.display = 'flex';
    this.renderContent();
    if (supabaseService.isLoggedIn()) this.fetchProjects();
  }

  close() {
    this.isOpen = false;
    this.container.classList.remove('active');
    this.container.style.display = 'none';
  }

  /** A new file was opened in the editor: it isn't the linked project's track any more. */
  clearLoadedProject() {
    delete this.links.editor;
    const titleInput = document.getElementById('saveProjectTitleInput');
    if (titleInput && this.selectedKind === 'editor' && this.app?.engine?.currentFileName) {
      titleInput.value = cleanTitle(this.app.engine.currentFileName);
    }
  }

  render() {
    this.container.className = 'modal-backdrop';
    this.container.style.display = 'none';
    this.container.addEventListener('click', (e) => {
      if (e.target === this.container && !this.isSaving && !this.busyId) this.close();
    });
  }

  toast(msg, type = 'info') {
    this.app?.showToast?.(msg, type);
  }

  setStatus(text) {
    this.status = text;
    const el = document.getElementById('projectsStatusLine');
    if (el) el.textContent = text;
  }

  async fetchProjects() {
    this.isLoading = true;
    this.renderContent();
    try {
      [this.projectsList, this.trashList] = await Promise.all([supabaseService.listProjects(), supabaseService.listTrash()]);
      this.loaded = true;
      this.error = '';
      // A linked project may have been deleted or renamed on another device.
      for (const kind of KINDS) {
        const link = this.links[kind];
        if (!link) continue;
        const row = this.projectsList.find((p) => p.id === link.id);
        if (!row) delete this.links[kind];
        else link.title = row.title;
      }
      this.purgeOnce();
    } catch (err) {
      console.error('[Flova Projects] Fetch error:', err);
      this.error = err.message;
    } finally {
      this.isLoading = false;
      this.renderContent();
    }
  }

  /** Once per visit: empties old trash and deletes unused files in the background. */
  purgeOnce() {
    if (this.purged) return;
    this.purged = true;
    this.purge();
  }

  async purge() {
    try {
      const { files, bytes } = await supabaseService.purgeUnused();
      if (files) {
        console.info(`[Flova Projects] ${files} kullanılmayan dosya silindi (${formatBytes(bytes)}).`);
        this.renderContent();
      }
    } catch (err) {
      console.warn('[Flova Projects] Cleanup:', err);
    }
  }

  /** The work that can be saved, and which of it the save section is about. */
  saveTarget() {
    const work = savableWork(this.app);
    const selected = work.find((w) => w.kind === this.selectedKind) || work.find((w) => w.kind === this.currentKind()) || work[0] || null;
    if (selected) this.selectedKind = selected.kind;
    return { work, selected };
  }

  titleFor(target) {
    const link = target && this.linkFor(target.kind);
    return cleanTitle(link?.title || (target?.kind === 'editor' ? this.app?.trackNameElem?.dataset?.rawTitle : null) || target?.title) || 'Adsız Proje';
  }

  renderContent() {
    if (!this.isOpen) return;
    if (!supabaseService.isLoggedIn()) {
      this.renderGuest();
      return;
    }

    const busy = this.isSaving || !!this.busyId;
    const { work, selected } = this.saveTarget();
    const link = selected && this.linkFor(selected.kind);
    const usedBytes = supabaseService.currentProfile?.storage_used_bytes || 0;

    this.container.innerHTML = `
      <div class="modal-card glass-card" style="max-width: 650px; width: 95%;">
        <div class="modal-header">
          <div class="modal-title-row">
            <span class="modal-icon" style="color: var(--accent-cyan); display: inline-flex; align-items: center;">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>
            </span>
            <div>
              <h3 class="modal-title">Projelerim</h3>
              <p style="margin: 0; font-size: 0.75rem; color: var(--text-muted);">Mobil uygulamayla aynı projeler${usedBytes ? ` · Kullanılan alan: ${formatBytes(usedBytes)}` : ''}</p>
            </div>
          </div>
          <button class="modal-close-btn" id="closeProjectsModalBtn" title="Kapat" ${busy ? 'disabled' : ''}>✕</button>
        </div>

        <div class="modal-body" style="display: flex; flex-direction: column; gap: 18px; max-height: 70vh; overflow-y: auto;">
          ${this.renderSave(work, selected, link, busy)}

          ${this.error ? `<div style="background: rgba(244, 63, 94, 0.15); border: 1px solid rgba(244, 63, 94, 0.4); color: #fda4af; padding: 8px 12px; border-radius: var(--radius-sm); font-size: 0.82rem;">${escapeHtml(this.error)}</div>` : ''}

          <div>
            <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px;">
              <span style="font-size: 0.85rem; font-weight: 700; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em;">Kayıtlı Projeler (${this.projectsList.length})</span>
              <button id="refreshProjectsBtn" class="btn btn-secondary btn-sm" style="padding: 3px 8px; font-size: 0.75rem;" ${busy || this.isLoading ? 'disabled' : ''}>Yenile</button>
            </div>
            ${this.renderList(busy)}
          </div>
          ${this.renderTrash(busy)}
        </div>
      </div>
    `;
    this.bindEvents();
  }

  renderSave(work, selected, link, busy) {
    if (!selected) {
      return `
        <div style="background: rgba(255,255,255,0.03); border: 1px solid var(--border-glass); border-radius: var(--radius-md); padding: 14px; font-size: 0.82rem; color: var(--text-muted); line-height: 1.5;">
          Şu an kaydedilecek bir çalışma yok. Düzenleyicide, birleştiricide veya ayırıcılarda açtığınız işler burada kaydedilebilir.
        </div>`;
    }
    const chips = work.length > 1 ? `
      <div style="display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 10px;">
        ${work.map((w) => `<button class="btn btn-sm ${w.kind === selected.kind ? 'btn-primary' : 'btn-secondary'} save-kind-btn" data-kind="${w.kind}" ${busy ? 'disabled' : ''} style="font-size: 0.75rem; padding: 3px 10px;">${KIND_LABELS[w.kind]}${this.linkFor(w.kind) ? ' ·  bulutta' : ''}</button>`).join('')}
      </div>` : '';
    return `
      <div style="background: ${link ? 'rgba(56, 189, 248, 0.05)' : 'rgba(255,255,255,0.03)'}; border: 1px solid ${link ? 'rgba(56, 189, 248, 0.3)' : 'var(--border-glass)'}; border-radius: var(--radius-md); padding: 14px;">
        ${chips}
        <div style="font-size: 0.85rem; font-weight: 700; color: var(--text-main); margin-bottom: 8px; display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap;">
          <span>${link ? `Açık proje: <span style="color: var(--accent-cyan);">${escapeHtml(link.title)}</span>` : `${KIND_LABELS[selected.kind]} çalışmasını kaydet`}</span>
          <span style="font-size: 0.72rem; color: var(--text-muted); font-family: var(--font-mono, monospace);">${[formatDuration(selected.duration), 'Ctrl + S'].filter(Boolean).join(' · ')}</span>
        </div>
        <div style="display: flex; gap: 8px; flex-wrap: wrap;">
          <input type="text" id="saveProjectTitleInput" class="studio-input" placeholder="Proje adı..." maxlength="120" value="${escapeHtml(this.titleFor(selected))}" style="flex: 1; min-width: 160px;" ${busy ? 'disabled' : ''} />
          ${link ? `
            <button id="updateProjectBtn" class="btn btn-emerald btn-sm" ${busy ? 'disabled' : ''}>Üzerine Kaydet</button>
            <button id="saveAsNewProjectBtn" class="btn btn-secondary btn-sm" ${busy ? 'disabled' : ''}>Farklı Kaydet</button>
          ` : `
            <button id="saveProjectBtn" class="btn btn-emerald btn-sm" ${busy ? 'disabled' : ''}>Buluta Kaydet</button>
          `}
        </div>
        <div id="projectsStatusLine" style="font-size: 0.78rem; color: var(--accent-cyan); margin-top: 8px; min-height: 1em;">${escapeHtml(this.status)}</div>
        <div style="font-size: 0.72rem; color: var(--text-dim); margin-top: 2px; line-height: 1.4;">
          Ses dosyaları bir kez yüklenir; düzenlemeler ve ayarlar proje olarak saklanır.
        </div>
      </div>`;
  }

  renderList(busy) {
    if (this.isLoading && !this.loaded) {
      return `<div style="text-align: center; padding: 30px; color: var(--text-muted); font-size: 0.85rem;">Projeler getiriliyor...</div>`;
    }
    if (!this.projectsList.length) {
      return `<div style="text-align: center; padding: 30px; background: rgba(0,0,0,0.2); border-radius: var(--radius-sm); border: 1px dashed var(--border-glass); color: var(--text-dim); font-size: 0.85rem;">Henüz kayıtlı projeniz yok.</div>`;
    }
    const openIds = new Set(KINDS.map((k) => this.linkFor(k)?.id).filter(Boolean));
    return `<div style="display: flex; flex-direction: column; gap: 8px;">${this.projectsList.map((p) => {
      const isCurrent = openIds.has(p.id);
      const date = new Date(p.updated_at).toLocaleString('tr-TR', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
      const meta = [date, formatDuration(p.duration_seconds), formatBytes(p.sizeBytes), p.fileCount > 1 ? `${p.fileCount} ses dosyası` : ''].filter(Boolean).join(' · ');
      return `
        <div style="background: ${isCurrent ? 'rgba(56, 189, 248, 0.06)' : 'rgba(255,255,255,0.02)'}; border: 1px solid ${isCurrent ? 'rgba(56, 189, 248, 0.3)' : 'var(--border-glass)'}; border-radius: var(--radius-sm); padding: 12px; display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap;">
          <div style="flex: 1; min-width: 160px;">
            <div style="display: flex; align-items: center; gap: 8px; min-width: 0;">
              <span style="font-weight: 700; color: var(--text-main); font-size: 0.95rem; text-overflow: ellipsis; overflow: hidden; white-space: nowrap;">${escapeHtml(p.title)}</span>
              <span style="font-size: 0.65rem; border: 1px solid var(--border-glass); color: var(--text-muted); padding: 1px 6px; border-radius: 4px; white-space: nowrap;">${escapeHtml(KIND_LABELS[p.kind] || p.kind)}</span>
              ${isCurrent ? `<span style="font-size: 0.65rem; background: var(--accent-cyan); color: #000; font-weight: 700; padding: 1px 6px; border-radius: 4px; white-space: nowrap;">AÇIK</span>` : ''}
            </div>
            <div style="font-size: 0.75rem; color: var(--text-muted); margin-top: 3px;">${escapeHtml(meta)}</div>
          </div>
          <div style="display: flex; gap: 6px;">
            <button class="btn ${isCurrent ? 'btn-primary' : 'btn-secondary'} btn-sm load-proj-btn" data-id="${escapeHtml(p.id)}" ${busy || !KIND_LABELS[p.kind] ? 'disabled' : ''} title="${escapeHtml(KIND_LABELS[p.kind] || '')} ekranında aç">${this.busyId === p.id ? 'Açılıyor...' : isCurrent ? 'Yeniden Yükle' : 'Aç'}</button>
            <button class="btn btn-secondary btn-sm rename-proj-btn" data-id="${escapeHtml(p.id)}" ${busy ? 'disabled' : ''} title="Yeniden adlandır">Ad</button>
            <button class="btn btn-secondary btn-sm delete-proj-btn" data-id="${escapeHtml(p.id)}" style="color: #fb7185; padding: 4px 8px;" ${busy ? 'disabled' : ''} title="Çöp kutusuna taşı">✕</button>
          </div>
        </div>`;
    }).join('')}</div>`;
  }

  renderTrash(busy) {
    if (!this.trashList.length) return '';
    const daysLeft = (deletedAt) => Math.max(0, TRASH_DAYS - Math.floor((Date.now() - new Date(deletedAt).getTime()) / 86400000));
    return `
      <div>
        <button id="toggleTrashBtn" class="btn btn-secondary btn-sm" style="width: 100%; display: flex; justify-content: space-between; font-size: 0.78rem;">
          <span>Çöp Kutusu (${this.trashList.length})</span><span>${this.showTrash ? '▲' : '▼'}</span>
        </button>
        ${this.showTrash ? `
          <div style="font-size: 0.72rem; color: var(--text-dim); margin: 8px 2px;">Silinen projeler ${TRASH_DAYS} gün sonra ses dosyalarıyla birlikte kalıcı olarak silinir.</div>
          <div style="display: flex; flex-direction: column; gap: 6px;">${this.trashList.map((p) => `
            <div style="border: 1px dashed var(--border-glass); border-radius: var(--radius-sm); padding: 10px 12px; display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap;">
              <div style="flex: 1; min-width: 140px;">
                <div style="font-weight: 600; color: var(--text-muted); font-size: 0.88rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(p.title)}</div>
                <div style="font-size: 0.72rem; color: var(--text-dim);">${escapeHtml(KIND_LABELS[p.kind] || p.kind)} · ${daysLeft(p.deleted_at)} gün sonra silinecek</div>
              </div>
              <div style="display: flex; gap: 6px;">
                <button class="btn btn-secondary btn-sm restore-proj-btn" data-id="${escapeHtml(p.id)}" ${busy ? 'disabled' : ''}>Geri Al</button>
                <button class="btn btn-secondary btn-sm purge-proj-btn" data-id="${escapeHtml(p.id)}" style="color: #fb7185;" ${busy ? 'disabled' : ''}>Kalıcı Sil</button>
              </div>
            </div>`).join('')}
          </div>` : ''}
      </div>`;
  }

  renderGuest() {
    this.container.innerHTML = `
      <div class="modal-card glass-card" style="max-width: 500px;">
        <div class="modal-header">
          <div class="modal-title-row">
            <span class="modal-icon" style="color: var(--accent-cyan); display: inline-flex; align-items: center;">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>
            </span>
            <div><h3 class="modal-title">Projelerim</h3></div>
          </div>
          <button class="modal-close-btn" id="closeProjectsModalBtn" title="Kapat">✕</button>
        </div>
        <div class="modal-body" style="text-align: center; padding: 24px 12px;">
          <h4 style="color: var(--text-main); margin-bottom: 8px; font-size: 1.1rem;">Projelerinizi Bulutta Saklayın</h4>
          <p style="color: var(--text-muted); font-size: 0.85rem; line-height: 1.5; margin-bottom: 20px;">
            Parçalarınızı, düzenlemelerinizi ve ayarlarınızı kaydedip web sitesinde veya Flova mobil uygulamasında kaldığınız yerden devam etmek için giriş yapın.
          </p>
          <button id="projectLoginPromptBtn" class="btn btn-primary" style="padding: 10px 24px; font-weight: 600;">Giriş Yap veya Kayıt Ol</button>
        </div>
      </div>
    `;
    document.getElementById('closeProjectsModalBtn').onclick = () => this.close();
    document.getElementById('projectLoginPromptBtn').onclick = () => {
      this.close();
      this.app?.authModal?.open('signin');
    };
  }

  bindEvents() {
    const on = (id, fn) => {
      const el = document.getElementById(id);
      if (el) el.onclick = fn;
    };
    const all = (cls, fn) => this.container.querySelectorAll(cls).forEach((btn) => { btn.onclick = () => fn(btn.dataset); });
    on('closeProjectsModalBtn', () => this.close());
    on('refreshProjectsBtn', () => this.fetchProjects());
    on('updateProjectBtn', () => this.executeSave({ isUpdate: true }));
    on('saveAsNewProjectBtn', () => this.executeSave({ isUpdate: false }));
    on('saveProjectBtn', () => this.executeSave({ isUpdate: false }));
    on('toggleTrashBtn', () => {
      this.showTrash = !this.showTrash;
      this.renderContent();
    });

    const titleInput = document.getElementById('saveProjectTitleInput');
    if (titleInput) {
      titleInput.onkeydown = (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          this.executeSave({ isUpdate: !!this.linkFor(this.selectedKind) });
        }
      };
    }

    all('.save-kind-btn', ({ kind }) => {
      this.selectedKind = kind;
      this.renderContent();
    });
    all('.load-proj-btn', ({ id }) => this.openProject(id));
    all('.rename-proj-btn', ({ id }) => this.renameProject(id));
    all('.delete-proj-btn', ({ id }) => this.deleteProject(id));
    all('.restore-proj-btn', ({ id }) => this.restoreProject(id));
    all('.purge-proj-btn', ({ id }) => this.deleteForever(id));
  }

  /** Saves the selected screen over its open project ([isUpdate]) or as a new one. */
  async executeSave({ isUpdate = false, kind = this.selectedKind } = {}) {
    if (this.isSaving || !kind) return;
    const link = this.linkFor(kind);
    const target = savableWork(this.app).find((w) => w.kind === kind);
    if (!target) return;
    const input = document.getElementById('saveProjectTitleInput');
    let title = cleanTitle(this.isOpen && input?.value ? input.value : this.titleFor(target)) || 'Adsız Proje';
    if (!isUpdate && link && title === link.title) title = `${title} (Kopya)`;

    this.isSaving = true;
    this.error = '';
    this.status = 'Hazırlanıyor...';
    this.renderContent();
    // In the window every step is shown; with the window closed (Ctrl+S) only each new kind of step is toasted.
    let lastStep = '';
    const onStatus = (text) => {
      this.setStatus(text);
      const step = text.replace(/\s*%\d+$/, '');
      if (!this.isOpen && step !== lastStep) this.toast(step, 'info');
      lastStep = step;
    };

    try {
      const id = isUpdate && link ? link.id : null;
      let saved;
      try {
        saved = await saveProject(this.app, kind, { projectId: id, revision: id ? link.revision : null, title }, onStatus);
      } catch (err) {
        if (err?.name !== 'ConflictError') throw err;
        const overwrite = window.confirm('Bu proje başka bir cihazda değiştirilmiş. Oradaki değişikliklerin üzerine yazılsın mı?\n\n"İptal" derseniz yeni bir proje olarak kaydedilir.');
        saved = await saveProject(this.app, kind, overwrite ? { projectId: id, revision: null, title } : { title: `${title} (Kopya)` }, onStatus);
      }
      this.links[kind] = { id: saved.id, revision: saved.revision, title: saved.title, anchor: this.anchorFor(kind) };
      if (kind === 'editor') this.app?.setTrackTitle?.(saved.title, { quiet: true });
      this.toast(saved.id === id ? `"${saved.title}" güncellendi.` : `"${saved.title}" buluta kaydedildi.`, 'success');
      supabaseService.fetchProfile().then(() => this.renderContent());
      if (this.isOpen) this.fetchProjects();
    } catch (err) {
      console.error('[Flova Projects] Save error:', err);
      this.error = err.message || 'Kaydedilemedi.';
      if (!this.isOpen) this.toast('Kayıt hatası: ' + this.error, 'error');
    } finally {
      this.isSaving = false;
      this.status = '';
      this.renderContent();
    }
  }

  /** Ctrl+S: saves the shown screen over its open project, otherwise opens this window to name a new one. */
  async quickSaveCurrentProject() {
    if (!supabaseService.isLoggedIn()) {
      this.toast('Projeyi buluta kaydetmek için lütfen giriş yapın.', 'info');
      if (this.app?.authModal) this.app.authModal.open('signin');
      else this.open();
      return;
    }
    const work = savableWork(this.app);
    const kind = work.some((w) => w.kind === this.currentKind()) ? this.currentKind() : work[0]?.kind;
    if (!kind) {
      this.toast('Kaydedilecek bir çalışma yok.', 'info');
      return;
    }
    this.selectedKind = kind;
    if (this.linkFor(kind)) await this.executeSave({ isUpdate: true, kind });
    else this.open(kind);
  }

  async openProject(id) {
    if (this.busyId) return;
    const row = this.projectsList.find((p) => p.id === id);
    const kind = row?.kind;
    if (kind && this.linkFor(kind)?.id !== id && hasWork(this.app, kind) &&
        !window.confirm(`${KIND_LABELS[kind]} ekranındaki çalışma kapatılacak (kaydedilmemiş değişiklikler kaybolur). Devam edilsin mi?`)) return;

    this.busyId = id;
    this.error = '';
    this.status = 'Proje getiriliyor...';
    this.renderContent();
    let opened = false;
    try {
      const project = await supabaseService.getProject(id);
      if ((project.format_version || 1) > 1) throw new Error('Bu proje daha yeni bir Flova sürümüyle kaydedilmiş. Sayfayı yenileyip tekrar deneyin.');
      await openProject(this.app, project, (t) => this.setStatus(t));
      this.links[project.kind] = { id: project.id, revision: project.revision, title: project.title, anchor: this.anchorFor(project.kind) };
      if (project.kind === 'editor' && typeof this.app?.renderTrackTitle === 'function') this.app.renderTrackTitle();
      this.toast(`"${project.title}" açıldı.`, 'success');
      opened = true;
    } catch (err) {
      console.error('[Flova Projects] Open error:', err);
      this.error = err.message || 'Proje açılamadı.';
    } finally {
      this.busyId = null;
      this.status = '';
      if (opened) this.close();
      else this.renderContent();
    }
  }

  async renameProject(id) {
    const project = this.projectsList.find((p) => p.id === id);
    if (!project) return;
    const title = cleanTitle(window.prompt('Projenin yeni adı:', project.title) || '');
    if (!title || title === project.title) return;
    try {
      await supabaseService.renameProject(id, title);
      await this.fetchProjects();
      // Renaming bumps the revision; the copy open here is still the latest.
      for (const kind of KINDS) {
        const link = this.links[kind];
        if (link?.id !== id) continue;
        link.revision = this.projectsList.find((p) => p.id === id)?.revision ?? null;
        link.title = title;
        if (kind === 'editor') this.app?.setTrackTitle?.(title, { quiet: true });
      }
      this.renderContent();
    } catch (err) {
      this.error = err.message;
      this.renderContent();
    }
  }

  async deleteProject(id) {
    const project = this.projectsList.find((p) => p.id === id);
    if (!project) return;
    if (!window.confirm(`"${project.title}" çöp kutusuna taşınsın mı? ${TRASH_DAYS} gün içinde geri alabilirsiniz.`)) return;
    try {
      await supabaseService.trashProject(id);
      for (const kind of KINDS) {
        if (this.links[kind]?.id !== id) continue;
        delete this.links[kind];
        if (kind === 'editor' && typeof this.app?.renderTrackTitle === 'function') this.app.renderTrackTitle();
      }
      this.toast('Proje çöp kutusuna taşındı.', 'info');
      await this.fetchProjects();
    } catch (err) {
      this.error = err.message;
      this.renderContent();
    }
  }

  async restoreProject(id) {
    try {
      await supabaseService.restoreProject(id);
      this.toast('Proje geri alındı.', 'success');
      await this.fetchProjects();
    } catch (err) {
      this.error = err.message;
      this.renderContent();
    }
  }

  async deleteForever(id) {
    const project = this.trashList.find((p) => p.id === id);
    if (!project || !window.confirm(`"${project.title}" kalıcı olarak silinsin mi? Bu işlem geri alınamaz.`)) return;
    try {
      await supabaseService.deleteProjectForever(id);
      this.toast('Proje kalıcı olarak silindi.', 'info');
      await this.fetchProjects();
      this.purge();
    } catch (err) {
      this.error = err.message;
      this.renderContent();
    }
  }
}
