/* ====================================================================
   FLOVA AUDIO STUDIO - CODE GUARD & REVERSE ENGINEERING DETERRENT
   - Context Menu & Source Inspection Deterrent
   - DevTools Shortcut Safeguards
   ==================================================================== */

export class CodeGuard {
  static init() {
    // Only apply in production or if explicitly enabled
    if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
      console.log('%c[Flova Studio]%c Geliştirici modu etkin (Localhost).', 'color: #6366f1; font-weight: bold;', 'color: #94a3b8;');
      return;
    }

    // Disable right click context menu on production
    document.addEventListener('contextmenu', (e) => {
      // Allow right click inside text inputs or textareas if needed
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      e.preventDefault();
    });

    // Deterrent for keyboard shortcuts: F12, Ctrl+Shift+I, Ctrl+Shift+J, Ctrl+U, Ctrl+S
    document.addEventListener('keydown', (e) => {
      if (
        e.key === 'F12' ||
        (e.ctrlKey && e.shiftKey && (e.key === 'I' || e.key === 'i' || e.key === 'J' || e.key === 'j' || e.key === 'C' || e.key === 'c')) ||
        (e.ctrlKey && (e.key === 'U' || e.key === 'u' || e.key === 'S' || e.key === 's'))
      ) {
        // Only block if not focused in an input
        if (e.target.tagName !== 'INPUT' && e.target.tagName !== 'TEXTAREA') {
          e.preventDefault();
          e.stopPropagation();
        }
      }
    });

    // Console warning watermark
    try {
      console.clear();
      console.log(
        '%cFLOVA AUDIO STUDIO PRO%c\nBu yazılımın telif hakları saklıdır. Kaynak kodları karartılmış ve korunmuştur.',
        'color: #ff6b00; font-size: 20px; font-weight: 800; text-shadow: 0 0 10px rgba(255,107,0,0.5);',
        'color: #94a3b8; font-size: 12px; margin-top: 5px;'
      );
    } catch (_) {}
  }
}
