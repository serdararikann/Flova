/* ====================================================================
   FLOVA AUDIO STUDIO - KEYBOARD SHORTCUTS (HOTKEYS) MODAL
   Hardware DAW shortcuts table & fast navigation reference
   ==================================================================== */

export class HotkeysModal {
  constructor(containerElement) {
    this.container = containerElement;
    this.isOpen = false;
    this.render();
  }

  render() {
    this.container.className = 'modal-backdrop';
    this.container.style.display = 'none';
  }

  open() {
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

  renderContent() {
    this.container.innerHTML = `
      <div class="modal-card glass-card server-modal-card" style="max-width: 640px;">
        <div class="modal-header">
          <div class="modal-title-row">
            <span class="modal-icon" style="color: var(--accent-cyan); display: inline-flex; align-items: center;">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="4" width="20" height="16" rx="2"></rect><line x1="6" y1="8" x2="6" y2="8.01"></line><line x1="10" y1="8" x2="10" y2="8.01"></line><line x1="14" y1="8" x2="14" y2="8.01"></line><line x1="18" y1="8" x2="18" y2="8.01"></line><line x1="6" y1="12" x2="6" y2="12.01"></line><line x1="18" y1="12" x2="18" y2="12.01"></line><line x1="8" y1="16" x2="16" y2="16"></line></svg>
            </span>
            <div>
              <h3 class="modal-title">Stüdyo Klavye Kısayolları</h3>
              <p style="font-size: 0.78rem; color: var(--text-dim); margin-top: 2px;">Masaüstü DAW verimliliği için tasarlanmış tuş takımı</p>
            </div>
          </div>
          <button class="modal-close-btn" id="closeHotkeysModalBtn" title="Kapat">✕</button>
        </div>

        <div class="modal-body" style="padding: 10px 0;">
          <table class="hotkeys-table">
            <thead>
              <tr>
                <th style="width: 38%;">Kısayol</th>
                <th>İşlev</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><kbd>Space</kbd></td>
                <td>Oynat / Duraklat (Play / Pause)</td>
              </tr>
              <tr>
                <td><kbd>Ctrl</kbd> + <kbd>Z</kbd></td>
                <td>Geri Al (Undo)</td>
              </tr>
              <tr>
                <td><kbd>Ctrl</kbd> + <kbd>Y</kbd> / <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd></td>
                <td>Yinele / İleri Al (Redo)</td>
              </tr>
              <tr>
                <td><kbd>Delete</kbd> / <kbd>Backspace</kbd></td>
                <td>Seçili Alanı Sil & Birleştir (Ripple Delete)</td>
              </tr>
              <tr>
                <td><kbd>S</kbd></td>
                <td>Seçili Alanı Kırp (Trim selection)</td>
              </tr>
              <tr>
                <td><kbd>M</kbd></td>
                <td>Mevcut Konuma İşaretçi (Cue Marker) Ekle</td>
              </tr>
              <tr>
                <td><kbd>N</kbd></td>
                <td>Sesi Stüdyo Standardına (-0.1 dB) Normalize Et</td>
              </tr>
              <tr>
                <td><kbd>L</kbd></td>
                <td>Döngü Modunu (Loop) Aç / Kapat</td>
              </tr>
              <tr>
                <td><kbd>1</kbd> - <kbd>5</kbd></td>
                <td>Sekmeler Arası Geçiş (Düzenleyici, Vokal, Stem, Birleştirici, YouTube)</td>
              </tr>
              <tr>
                <td><kbd>Ctrl</kbd> + <kbd>Fare Tekerleği</kbd></td>
                <td>Dalga Formuna Yakınlaş / Uzaklaş (Zoom In/Out)</td>
              </tr>
              <tr>
                <td><kbd>Esc</kbd></td>
                <td>Açık Pencereleri Kapat / Seçimi Bırak</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="modal-footer" style="display: flex; justify-content: flex-end; margin-top: 14px;">
          <button class="btn btn-secondary btn-sm" id="closeHotkeysModalFooterBtn">Anladım</button>
        </div>
      </div>
    `;

    this.container.querySelector('#closeHotkeysModalBtn')?.addEventListener('click', () => this.close());
    this.container.querySelector('#closeHotkeysModalFooterBtn')?.addEventListener('click', () => this.close());
    this.container.addEventListener('click', (e) => {
      if (e.target === this.container) this.close();
    });
  }
}
