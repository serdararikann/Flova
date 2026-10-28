/* ====================================================================
   FLOVA AUDIO STUDIO - ACCOUNT MODAL (Supabase Auth + flova_profiles)
   - Sign in, sign up (with e-mail confirmation), forgotten password
   - New password after a reset link (PASSWORD_RECOVERY)
   - Profile: display name, plan, storage used, sign out
   - Header button with the signed-in user
   ==================================================================== */

import { supabaseService, GOOGLE_SIGN_IN } from '../db/supabase-client.js';

/** Whether new accounts can be created on the site (false shows the "Kayıt Ol" tab disabled, "Yakında"). */
const SIGNUP_ENABLED = true;

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function displayName(user, profile) {
  return profile?.display_name || user?.user_metadata?.full_name || (user?.email || '').split('@')[0] || 'Flova';
}

function formatBytes(bytes) {
  if (!bytes) return '0 MB';
  if (bytes < 1048576) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

const ICON_USER = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>';
const ICON_LOGIN = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"></path><polyline points="10 17 15 12 10 7"></polyline><line x1="15" y1="12" x2="3" y2="12"></line></svg>';

export class AuthModal {
  constructor(containerElement, onAuthChangeCallback = null) {
    this.container = containerElement;
    this.onAuthChange = onAuthChangeCallback;
    this.isOpen = false;
    this.activeTab = 'signin'; // 'signin' | 'signup' | 'forgot'
    this.isLoading = false;
    this.errorMessage = '';
    this.successMessage = '';
    this.email = '';

    this.render();
    this.setupListeners();
  }

  setupListeners() {
    supabaseService.onAuthStateChange(({ event, user, profile }) => {
      this.updateHeaderAuthBtn(user, profile);
      if (this.onAuthChange) this.onAuthChange({ event, user, profile });
      if (event === 'PASSWORD_RECOVERY') this.open('signin');
      else if (event === 'IDLE_SIGNED_OUT') {
        this.open('signin');
        this.errorMessage = 'Uzun süre kullanılmadığı için oturumunuz kapatıldı. Lütfen tekrar giriş yapın.';
        this.renderContent();
      } else if (this.isOpen && !this.isLoading) this.renderContent();
    });
    // An e-mail link that failed (expired, already used): say so once.
    if (supabaseService.linkError) {
      setTimeout(() => {
        this.open('signin');
        this.errorMessage = supabaseService.linkError;
        supabaseService.linkError = null;
        this.renderContent();
      }, 300);
    }
  }

  updateHeaderAuthBtn(user, profile) {
    const btn = document.getElementById('authBtn');
    if (!btn) return;

    if (user) {
      const name = displayName(user, profile);
      const tier = profile?.tier || 'free';
      btn.className = 'btn btn-secondary btn-sm auth-btn logged-in';
      btn.innerHTML = `
        <span class="auth-user-avatar" style="width: 18px; height: 18px; border-radius: 50%; background: linear-gradient(135deg, var(--accent-cyan), var(--accent-primary)); display: inline-flex; align-items: center; justify-content: center; font-size: 0.65rem; font-weight: bold; color: var(--text);">${escapeHtml(name.charAt(0).toLocaleUpperCase('tr-TR'))}</span>
        <span style="max-width: 90px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(name)}</span>
        ${tier !== 'free' ? `<span style="background: var(--positive); color: var(--text); font-size: 0.65rem; padding: 1px 6px; border-radius: 99px; font-weight: 700;">${escapeHtml(tier.toLocaleUpperCase('tr-TR'))}</span>` : ''}
      `;
      btn.title = `Giriş yapıldı: ${user.email} (hesabı yönetmek için tıklayın)`;
    } else {
      btn.className = 'btn btn-secondary btn-sm auth-btn';
      btn.innerHTML = `${ICON_USER}<span>Giriş yap</span>`;
      btn.title = SIGNUP_ENABLED ? 'Hesabınıza giriş yapın veya kayıt olun' : 'Hesabınıza giriş yapın';
    }
  }

  open(initialTab = 'signin') {
    this.activeTab = initialTab === 'signup' && !SIGNUP_ENABLED ? 'signin' : initialTab;
    this.errorMessage = '';
    this.successMessage = '';
    this.isOpen = true;
    this.renderContent();
    this.container.classList.add('active');
    this.container.style.display = 'flex';
  }

  close() {
    this.isOpen = false;
    this.container.classList.remove('active');
    this.container.style.display = 'none';
  }

  render() {
    this.container.className = 'modal-backdrop';
    this.container.style.display = 'none';
    this.container.addEventListener('click', (e) => {
      if (e.target === this.container && !this.isLoading) this.close();
    });
  }

  alerts() {
    return `
      ${this.errorMessage ? `<div style="background: color-mix(in srgb, var(--danger) 14%, transparent); border: 1px solid var(--line); color: var(--danger); padding: 8px 12px; border-radius: var(--radius-sm); font-size: 0.82rem; line-height: 1.4;">${escapeHtml(this.errorMessage)}</div>` : ''}
      ${this.successMessage ? `<div style="background: color-mix(in srgb, var(--positive) 14%, transparent); border: 1px solid var(--line); color: var(--positive); padding: 8px 12px; border-radius: var(--radius-sm); font-size: 0.82rem; line-height: 1.4;">${escapeHtml(this.successMessage)}</div>` : ''}
    `;
  }

  shell(title, body, maxWidth = 420) {
    return `
      <div class="modal-card glass-card auth-modal-card" style="max-width: ${maxWidth}px;">
        <div class="modal-header">
          <div class="modal-title-row">
            <span class="modal-icon" style="color: var(--accent-cyan); display: inline-flex; align-items: center;">${ICON_LOGIN}</span>
            <div><h3 class="modal-title">${title}</h3></div>
          </div>
          <button class="modal-close-btn" id="closeAuthModalBtn" title="Kapat" ${this.isLoading ? 'disabled' : ''}>✕</button>
        </div>
        <div class="modal-body" style="display: flex; flex-direction: column; gap: 14px;">${body}</div>
      </div>
    `;
  }

  field(id, label, type, attrs = '') {
    return `
      <div class="form-group">
        <label for="${id}" style="font-size: 0.8rem; font-weight: 600; color: var(--text-muted); margin-bottom: 4px; display: block;">${label}</label>
        <input type="${type}" id="${id}" class="studio-input" style="width: 100%; box-sizing: border-box;" ${attrs} />
      </div>
    `;
  }

  submitButton(label) {
    return `<button type="submit" id="authSubmitBtn" class="btn btn-primary" style="margin-top: 6px; padding: 10px; font-weight: 600;" ${this.isLoading ? 'disabled' : ''}>${this.isLoading ? 'İşleniyor...' : label}</button>`;
  }

  renderContent() {
    const user = supabaseService.currentUser;
    if (user && supabaseService.recovering) this.container.innerHTML = this.recoveryView();
    else if (user) this.container.innerHTML = this.profileView(user, supabaseService.currentProfile);
    else if (this.activeTab === 'forgot') this.container.innerHTML = this.forgotView();
    else this.container.innerHTML = this.signInView();
    this.bindEvents();
  }

  signInView() {
    const isSignIn = this.activeTab === 'signin';
    const email = escapeHtml(this.email);
    return this.shell(isSignIn ? 'Flova Hesabına Giriş Yap' : 'Flova Hesabı Oluştur', `
      <div style="display: flex; background: var(--inset); padding: 3px; border-radius: var(--radius-sm); border: 1px solid var(--border-glass);">
        <button id="tabAuthSignIn" class="mode-tab-btn ${isSignIn ? 'active' : ''}" style="flex: 1; padding: 6px; font-size: 0.85rem;">Giriş Yap</button>
        ${SIGNUP_ENABLED
          ? `<button id="tabAuthSignUp" class="mode-tab-btn ${!isSignIn ? 'active' : ''}" style="flex: 1; padding: 6px; font-size: 0.85rem;">Kayıt Ol</button>`
          : `<button class="mode-tab-btn" disabled title="Yeni hesap açımı yakında" style="flex: 1; padding: 6px; font-size: 0.85rem; opacity: 0.45; cursor: not-allowed;">Kayıt Ol <span style="font-size: 0.65rem; border: 1px solid currentColor; border-radius: 4px; padding: 0 4px; margin-left: 4px;">Yakında</span></button>`}
      </div>
      ${this.alerts()}
      <form id="authForm" style="display: flex; flex-direction: column; gap: 12px;">
        ${!isSignIn ? this.field('authDisplayName', 'İsim / Sahne Adı', 'text', 'placeholder="Adınız" maxlength="60" autocomplete="nickname" required') : ''}
        ${this.field('authEmail', 'E-posta Adresi', 'email', `placeholder="ornek@eposta.com" value="${email}" autocomplete="email" required`)}
        ${this.field('authPassword', 'Şifre', 'password', `placeholder="••••••••" minlength="6" autocomplete="${isSignIn ? 'current-password' : 'new-password'}" required`)}
        <label style="display: flex; align-items: center; gap: 8px; font-size: 0.82rem; color: var(--text-muted); cursor: pointer;" title="İşaretli değilse oturum sekme kapanınca ya da 30 dakika kullanılmayınca kapanır">
          <input type="checkbox" id="authRemember" ${supabaseService.remembered ? 'checked' : ''} style="accent-color: var(--accent-cyan);" />
          Beni hatırla
        </label>
        ${this.submitButton(isSignIn ? 'Giriş Yap' : 'Hesap Oluştur')}
      </form>
      ${GOOGLE_SIGN_IN ? `
      <div style="display: flex; align-items: center; gap: 10px; font-size: 0.78rem; color: var(--text-muted);">
        <span style="flex: 1; height: 1px; background: var(--border-glass);"></span>veya<span style="flex: 1; height: 1px; background: var(--border-glass);"></span>
      </div>
      <button type="button" id="authGoogleBtn" class="btn" style="padding: 10px; font-weight: 600; display: flex; align-items: center; justify-content: center; gap: 8px;" ${this.isLoading ? 'disabled' : ''}>
        <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>
        Google ile devam et
      </button>` : ''}
      <div style="font-size: 0.78rem; color: var(--text-dim, var(--muted)); text-align: center; display: flex; flex-direction: column; gap: 6px;">
        ${isSignIn
          ? `<a href="#" id="authForgotLink" style="color: var(--accent-cyan); text-decoration: none;">Şifremi unuttum</a>
             <span>${SIGNUP_ENABLED
               ? 'Hesabınız yok mu? "Kayıt Ol" sekmesinden ücretsiz hesap açabilirsiniz.'
               : 'Yeni hesap açımı şimdilik kapalı; mevcut hesabınızla giriş yapabilirsiniz.'}</span>`
          : '<span>Projeleriniz hesabınızda saklanır; web sitesinde ve mobil uygulamada aynı hesapla açabilirsiniz.</span>'}
      </div>
    `);
  }

  forgotView() {
    return this.shell('Şifre Sıfırlama', `
      ${this.alerts()}
      <p style="margin: 0; font-size: 0.85rem; color: var(--text-muted); line-height: 1.5;">Hesabınızın e-posta adresini girin; şifrenizi yenilemeniz için bir bağlantı gönderelim.</p>
      <form id="authForm" style="display: flex; flex-direction: column; gap: 12px;">
        ${this.field('authEmail', 'E-posta Adresi', 'email', `placeholder="ornek@eposta.com" value="${escapeHtml(this.email)}" autocomplete="email" required`)}
        ${this.submitButton('Bağlantı Gönder')}
      </form>
      <a href="#" id="authBackLink" style="font-size: 0.8rem; color: var(--accent-cyan); text-decoration: none; text-align: center;">Girişe dön</a>
    `);
  }

  recoveryView() {
    return this.shell('Yeni Şifre Belirleyin', `
      ${this.alerts()}
      <form id="authForm" style="display: flex; flex-direction: column; gap: 12px;">
        ${this.field('authPassword', 'Yeni Şifre', 'password', 'placeholder="••••••••" minlength="6" autocomplete="new-password" required')}
        ${this.field('authPasswordRepeat', 'Yeni Şifre (Tekrar)', 'password', 'placeholder="••••••••" minlength="6" autocomplete="new-password" required')}
        ${this.submitButton('Şifreyi Kaydet')}
      </form>
    `);
  }

  profileView(user, profile) {
    const name = displayName(user, profile);
    const tier = profile?.tier || 'free';
    return this.shell('Flova Hesabı', `
      ${this.alerts()}
      <div style="background: var(--hover); border: 1px solid var(--border-glass); border-radius: var(--radius-md); padding: 16px; display: flex; align-items: center; gap: 14px;">
        <div style="width: 48px; height: 48px; flex-shrink: 0; border-radius: 50%; background: linear-gradient(135deg, var(--accent-cyan), var(--accent-primary)); display: flex; align-items: center; justify-content: center; font-size: 1.3rem; font-weight: 700; color: var(--text);">${escapeHtml(name.charAt(0).toLocaleUpperCase('tr-TR'))}</div>
        <div style="flex: 1; min-width: 0;">
          <div style="display: flex; align-items: center; gap: 8px;">
            <span style="font-weight: 700; font-size: 1rem; color: var(--text-main); text-overflow: ellipsis; overflow: hidden; white-space: nowrap;">${escapeHtml(name)}</span>
            <span style="font-size: 0.7rem; padding: 2px 8px; border-radius: 99px; font-weight: 700; background: ${tier === 'free' ? 'var(--raised)' : 'var(--accent)'}; color: ${tier === 'free' ? 'var(--text)' : 'var(--on-accent)'};">${escapeHtml(tier.toLocaleUpperCase('tr-TR'))}</span>
          </div>
          <div style="font-size: 0.82rem; color: var(--text-muted); margin-top: 3px; text-overflow: ellipsis; overflow: hidden; white-space: nowrap;">${escapeHtml(user.email)}</div>
          <div style="font-size: 0.75rem; color: var(--text-dim, var(--muted)); margin-top: 3px;">Bulutta kullanılan alan: ${formatBytes(profile?.storage_used_bytes)}</div>
        </div>
      </div>

      <form id="authProfileForm" style="display: flex; gap: 8px; align-items: flex-end;">
        <div style="flex: 1;">${this.field('authProfileName', 'Görünen Ad', 'text', `value="${escapeHtml(profile?.display_name || '')}" maxlength="60" placeholder="${escapeHtml(name)}"`)}</div>
        <button type="submit" class="btn btn-secondary btn-sm" style="padding: 8px 12px;" ${this.isLoading ? 'disabled' : ''}>Kaydet</button>
      </form>

      <button id="authOpenProjectsBtn" class="btn btn-secondary" style="display: flex; align-items: center; justify-content: center; gap: 8px; width: 100%; padding: 10px;">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>
        <span>Projelerim</span>
      </button>
      <button id="authSignOutBtn" class="btn" style="background: color-mix(in srgb, var(--danger) 14%, transparent); border: 1px solid var(--line); color: var(--danger); display: flex; align-items: center; justify-content: center; gap: 8px; width: 100%; padding: 10px;">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path><polyline points="16 17 21 12 16 7"></polyline><line x1="21" y1="12" x2="9" y2="12"></line></svg>
        <span>Oturumu Kapat</span>
      </button>
      <div class="auth-footer-links"><a href="./gizlilik.html" target="_blank" rel="noopener">Gizlilik politikası</a><button id="authDeleteAccountBtn" class="auth-delete-link" type="button">Hesabı sil</button></div>
    `, 440);
  }

  async run(task) {
    this.isLoading = true;
    this.errorMessage = '';
    this.successMessage = '';
    this.renderContent();
    try {
      await task();
    } catch (err) {
      console.error('[Flova Auth Error]', err);
      this.errorMessage = err.message || 'Bir hata oluştu. Lütfen tekrar deneyin.';
    } finally {
      this.isLoading = false;
      if (this.isOpen) this.renderContent();
    }
  }

  bindEvents() {
    const on = (id, fn) => {
      const el = document.getElementById(id);
      if (el) el.onclick = (e) => { e.preventDefault(); fn(); };
    };
    const value = (id) => document.getElementById(id)?.value ?? '';
    const switchTab = (tab) => {
      this.email = value('authEmail').trim() || this.email;
      this.activeTab = tab;
      this.errorMessage = '';
      this.successMessage = '';
      this.renderContent();
    };

    on('closeAuthModalBtn', () => this.close());
    on('tabAuthSignIn', () => switchTab('signin'));
    on('tabAuthSignUp', () => switchTab('signup'));
    on('authForgotLink', () => switchTab('forgot'));
    on('authGoogleBtn', () => {
      const rememberBox = document.getElementById('authRemember');
      if (rememberBox) supabaseService.setRemember(rememberBox.checked);
      // The page leaves for Google; a failure to start shows here
      this.run(() => supabaseService.signInWithGoogle());
    });
    on('authBackLink', () => switchTab('signin'));

    const form = document.getElementById('authForm');
    if (form) {
      form.onsubmit = (e) => {
        e.preventDefault();
        const email = value('authEmail').trim();
        const password = value('authPassword');
        if (email) this.email = email;
        const rememberBox = document.getElementById('authRemember');
        if (rememberBox) supabaseService.setRemember(rememberBox.checked);

        if (supabaseService.recovering) {
          if (password !== value('authPasswordRepeat')) {
            this.errorMessage = 'Şifreler birbiriyle aynı değil.';
            this.renderContent();
            return;
          }
          this.run(async () => {
            await supabaseService.updatePassword(password);
            this.successMessage = 'Şifreniz güncellendi.';
            window.flovaApp?.showToast('Şifreniz güncellendi.', 'success');
          });
        } else if (this.activeTab === 'forgot') {
          this.run(async () => {
            await supabaseService.sendPasswordReset(email);
            this.successMessage = `${email} adresine bir sıfırlama bağlantısı gönderdik (gelmezse gereksiz klasörüne de bakın). Bağlantı sizi bu siteye geri getirir.`;
          });
        } else if (this.activeTab === 'signin') {
          this.run(async () => {
            supabaseService.freshSignIn = true;
            await supabaseService.signIn(email, password);
            window.flovaApp?.showToast('Giriş yapıldı. Hoş geldiniz!', 'success');
            this.close();
          });
        } else if (SIGNUP_ENABLED) {
          const name = value('authDisplayName').trim();
          this.run(async () => {
            supabaseService.freshSignIn = true;
            const { needsConfirm } = await supabaseService.signUp(email, password, name);
            if (needsConfirm) {
              this.activeTab = 'signin';
              this.successMessage = `Hesabınız oluşturuldu. ${email} adresine gönderdiğimiz bağlantıya tıklayarak e-postanızı onaylayın; ardından giriş yapabilirsiniz.`;
            } else {
              window.flovaApp?.showToast('Hesabınız oluşturuldu!', 'success');
              this.close();
            }
          });
        }
      };
    }

    const profileForm = document.getElementById('authProfileForm');
    if (profileForm) {
      profileForm.onsubmit = (e) => {
        e.preventDefault();
        const name = value('authProfileName');
        this.run(async () => {
          await supabaseService.updateProfile({ displayName: name });
          this.successMessage = 'Profiliniz kaydedildi.';
          this.updateHeaderAuthBtn(supabaseService.currentUser, supabaseService.currentProfile);
        });
      };
    }

    on('authSignOutBtn', async () => {
      if (!window.confirm('Oturum kapatılsın mı? Buluttaki projeleriniz hesabınızda kalır.')) return;
      await supabaseService.signOut();
      window.flovaApp?.showToast('Oturum kapatıldı.', 'info');
      this.close();
    });

    on('authDeleteAccountBtn', () => {
      if (!window.confirm('Hesabınız, buluttaki tüm projeleriniz ve ses dosyalarınız kalıcı olarak silinecek. Bu işlem geri alınamaz. Devam edilsin mi?')) return;
      this.run(async () => {
        if (!supabaseService.deleteAccount) throw new Error('Site güncellendi; lütfen sayfayı yenileyip tekrar deneyin.');
        await supabaseService.deleteAccount();
        window.flovaApp?.showToast('Hesabınız silindi.', 'success');
        this.close();
      });
    });

    on('authOpenProjectsBtn', () => {
      this.close();
      window.flovaApp?.projectsModal?.open();
    });
  }
}
