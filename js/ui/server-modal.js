/* ====================================================================
   FLOVA AUDIO STUDIO - AI SERVER SETTINGS MODAL
   - Live Connection Status Indicator & Ping Tester
   - Custom Cloud Backend URL Configuration
   - Clear Explanations of Client-Side vs Server-Side Features
   ==================================================================== */

import { ApiClient } from '../audio/api-client.js';

export class ServerModal {
  constructor(containerElement, onServerUpdatedCallback = null) {
    this.container = containerElement;
    this.onServerUpdated = onServerUpdatedCallback;
    this.isOpen = false;
    this.isTesting = false;
    this.healthStatus = null; // { ok: bool, latency: number, error?: string }

    this.render();
    this.checkInitialStatus();
  }

  async checkInitialStatus() {
    this.healthStatus = await ApiClient.checkHealth();
    this.updateStatusPill();
    if (this.isOpen) this.renderContent();
  }

  updateStatusPill() {
    const btn = document.getElementById('serverStatusBtn');
    if (!btn) return;
    const dot = btn.querySelector('.server-status-dot');
    const text = btn.querySelector('.server-status-text');

    if (this.healthStatus && this.healthStatus.ok) {
      if (dot) {
        dot.className = 'server-status-dot online';
      }
      if (text) {
        text.textContent = `AI: ${this.healthStatus.latency}ms`;
      }
      btn.title = `Yapay Zeka Sunucusu Bağlı (${this.healthStatus.url}) - Gecikme: ${this.healthStatus.latency}ms`;
    } else {
      if (dot) {
        dot.className = 'server-status-dot offline';
      }
      if (text) {
        text.textContent = 'AI Sunucu';
      }
      btn.title = 'Yapay Zeka Sunucusu Çevrimdışı (Tıklayıp Ayarları Açın)';
    }
  }

  open() {
    this.isOpen = true;
    this.renderContent();
    this.container.classList.add('active');
    this.container.style.display = 'flex';
    // Auto re-test on open
    this.testConnection();
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
      if (e.target === this.container) {
        this.close();
      }
    });
  }

  renderContent() {
    const currentUrl = ApiClient.getBaseUrl();
    const isOk = this.healthStatus && this.healthStatus.ok;

    this.container.innerHTML = `
      <div class="modal-card glass-card server-modal-card" style="max-width: 580px;">
        <!-- Header -->
        <div class="modal-header">
          <div class="modal-title-row">
            <span class="modal-icon">🤖</span>
            <div>
              <h3 class="modal-title">Yapay Zeka & Bulut Sunucu Ayarları</h3>
              <p class="modal-subtitle">Demucs Vokal & 6-Stem Ayrıştırma ve YouTube İndirme Motoru</p>
            </div>
          </div>
          <button class="modal-close-btn" id="closeServerModalBtn" title="Kapat">✕</button>
        </div>

        <!-- Body -->
        <div class="modal-body" style="display: flex; flex-direction: column; gap: 16px;">
          
          <!-- Connection Status Card -->
          <div class="server-status-banner ${isOk ? 'status-ok' : 'status-err'}">
            <div class="status-indicator-circle ${isOk ? 'pulse-green' : 'pulse-red'}"></div>
            <div style="flex: 1;">
              <div style="font-weight: 700; font-size: 0.95rem; color: #fff;">
                ${isOk ? '🟢 AI Sunucusu Bağlantısı Aktif' : '🔴 AI Sunucusu Çevrimdışı / Erişilemiyor'}
              </div>
              <div style="font-size: 0.82rem; color: #94a3b8; margin-top: 2px;">
                ${isOk 
                  ? `Sunucu yanıt verdi (${this.healthStatus.latency} ms). Tüm AI ve YouTube özellikleri kullanılabilir.` 
                  : (this.healthStatus?.error ? `Hata: ${this.healthStatus.error}` : 'Henüz sunucuya bağlanılamadı. Yerel veya bulut sunucu URL\'sini girin.')
                }
              </div>
            </div>
            <button id="testServerBtn" class="btn btn-secondary btn-sm" ${this.isTesting ? 'disabled' : ''}>
              ${this.isTesting ? '⏳ Sınanıyor...' : '⚡ Bağlantıyı Sına'}
            </button>
          </div>

          <!-- Feature Distinction Info Box -->
          <div class="server-info-box">
            <div style="font-weight: 600; color: #c7d2fe; margin-bottom: 4px; font-size: 0.85rem;">
              💡 Hangi özellikler sunucu gerektirir?
            </div>
            <ul style="font-size: 0.82rem; color: #94a3b8; margin: 0; padding-left: 18px; line-height: 1.6;">
              <li><strong>Sunucusuz (Her Cihazda Çalışır):</strong> Ses Düzenleyici (Trim, Cut, Fade, Reverse), Parça Birleştirici, 5-Bant EQ, Reverb/Echo, Spektrum Analizi, LUFS Mastering, MP3/WAV Dışa Aktarma ve Spektral DSP Vokal Ayırıcı.</li>
              <li><strong>Sunucu Gerektiren:</strong> Demucs v4 Derin Öğrenme Vokal Ayırma, 6-Stem Enstrüman Ayırma ve YouTube İndirici.</li>
            </ul>
          </div>

          <!-- Backend URL Input -->
          <div class="form-group">
            <label style="display: flex; justify-content: space-between; font-size: 0.85rem; font-weight: 600; margin-bottom: 6px;">
              <span>AI Sunucu Adresi (Backend URL)</span>
              <span style="font-size: 0.75rem; color: #64748b;">(Örn: https://xxx.trycloudflare.com veya http://localhost:3000)</span>
            </label>
            <div style="display: flex; gap: 8px;">
              <input 
                type="text" 
                id="serverUrlInput" 
                class="studio-input" 
                style="flex: 1; font-family: monospace; font-size: 0.85rem;" 
                placeholder="http://localhost:3000 veya https://sunucunuz.com" 
                value="${ApiClient.getBaseUrl()}"
              />
              <button id="saveServerUrlBtn" class="btn btn-primary btn-sm">💾 Kaydet</button>
            </div>
          </div>

          <!-- Quick Presets -->
          <div class="quick-presets-row" style="display: flex; gap: 8px; flex-wrap: wrap;">
            <button class="preset-chip" id="presetLocalhost">🏠 Yerel (localhost:3000)</button>
            <button class="preset-chip" id="presetResetDefault">🔄 Sıfırla (Otomatik Algıla)</button>
          </div>

          <!-- Cloud Hosting Guide Tip -->
          <div style="background: rgba(255, 107, 0, 0.08); border: 1px solid rgba(255, 107, 0, 0.25); border-radius: 8px; padding: 12px; font-size: 0.82rem; color: #fdba74;">
            <strong>🚀 Başka bilgisayarlardan ve mobilden erişmek için:</strong>
            <div style="margin-top: 4px; color: #e2e8f0; line-height: 1.5;">
              Kendi bilgisayarınızda açık olan sunucuyu tüm dünyaya tek komutla açabilirsiniz:
              <br/><code style="background: rgba(0,0,0,0.4); padding: 2px 6px; border-radius: 4px; color: #38bdf8;">npx cloudflared tunnel --url http://localhost:3000</code>
              <br/>Çıkan bağlantıyı yukarıdaki kutuya yapıştırıp Kaydet'e basmanız yeterlidir.
            </div>
          </div>

        </div>

        <!-- Footer -->
        <div class="modal-footer" style="margin-top: 18px; display: flex; justify-content: flex-end;">
          <button class="btn btn-secondary btn-sm" id="closeServerModalFooterBtn">Kapat</button>
        </div>
      </div>
    `;

    this.bindEvents();
  }

  bindEvents() {
    const closeBtn = document.getElementById('closeServerModalBtn');
    if (closeBtn) closeBtn.onclick = () => this.close();

    const closeFooterBtn = document.getElementById('closeServerModalFooterBtn');
    if (closeFooterBtn) closeFooterBtn.onclick = () => this.close();

    const saveBtn = document.getElementById('saveServerUrlBtn');
    const input = document.getElementById('serverUrlInput');
    if (saveBtn && input) {
      saveBtn.onclick = async () => {
        ApiClient.setBaseUrl(input.value.trim());
        if (window.flovaApp) {
          window.flovaApp.showToast('Sunucu adresi kaydedildi. Bağlantı sınanıyor...', 'info');
        }
        await this.testConnection();
        if (this.onServerUpdated) this.onServerUpdated(ApiClient.getBaseUrl());
      };
    }

    const testBtn = document.getElementById('testServerBtn');
    if (testBtn) {
      testBtn.onclick = () => this.testConnection();
    }

    const presetLocal = document.getElementById('presetLocalhost');
    if (presetLocal && input) {
      presetLocal.onclick = () => {
        input.value = 'http://localhost:3000';
      };
    }

    const presetReset = document.getElementById('presetResetDefault');
    if (presetReset && input) {
      presetReset.onclick = () => {
        ApiClient.setBaseUrl('');
        input.value = ApiClient.getBaseUrl();
        this.testConnection();
      };
    }
  }

  async testConnection() {
    const input = document.getElementById('serverUrlInput');
    const targetUrl = input ? input.value.trim() : null;

    this.isTesting = true;
    this.renderContent();

    this.healthStatus = await ApiClient.checkHealth(targetUrl);
    this.isTesting = false;
    this.updateStatusPill();
    this.renderContent();

    if (window.flovaApp) {
      if (this.healthStatus.ok) {
        window.flovaApp.showToast(`Sunucuya başarıyla bağlanıldı (${this.healthStatus.latency} ms)!`, 'success');
      } else {
        window.flovaApp.showToast(`Sunucuya bağlanılamadı: ${this.healthStatus.error}`, 'error');
      }
    }
  }
}
