/* ====================================================================
   FLOVA AUDIO STUDIO - CENTRAL API CLIENT & BACKEND CONNECTOR
   - Cloud & Local Server URL Management
   - Auto Health Check & Ping
   - Resilient Fallback for Cross-Device & Static Deployments
   ==================================================================== */

const STORAGE_KEY = 'flova_backend_url';

// Default global cloud backend for live production (Hugging Face Spaces)
export const DEFAULT_CLOUD_BACKEND = 'https://nergall-flova.hf.space'; 

export class ApiClient {
  /**
   * Returns the configured backend base URL without trailing slash.
   */
  static getBaseUrl() {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && saved.trim()) {
      return saved.trim().replace(/\/+$/, '');
    }
    // If running on localhost or 127.0.0.1, default to port 3000
    if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
      return `http://${window.location.hostname}:3000`;
    }
    // If a default cloud backend URL is set, use it for all live users
    if (DEFAULT_CLOUD_BACKEND && DEFAULT_CLOUD_BACKEND.trim()) {
      return DEFAULT_CLOUD_BACKEND.trim().replace(/\/+$/, '');
    }
    // Fallback to origin
    return window.location.origin;
  }

  /**
   * Save a new backend URL to localStorage
   */
  static setBaseUrl(url) {
    if (!url || !url.trim()) {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      let clean = url.trim().replace(/\/+$/, '');
      if (!clean.startsWith('http://') && !clean.startsWith('https://')) {
        clean = 'https://' + clean;
      }
      localStorage.setItem(STORAGE_KEY, clean);
    }
  }

  /**
   * Prepend the backend base URL to any API path
   */
  static getApiUrl(path) {
    if (!path) return '';
    if (path.startsWith('http://') || path.startsWith('https://')) {
      return path;
    }
    const base = this.getBaseUrl();
    const cleanPath = path.startsWith('/') ? path : `/${path}`;
    return `${base}${cleanPath}`;
  }

  /**
   * Perform a quick health check to see if server.py is online
   */
  static async checkHealth(customUrl = null) {
    const base = customUrl ? customUrl.trim().replace(/\/+$/, '') : this.getBaseUrl();
    const startTime = performance.now();
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3500);
      const res = await fetch(`${base}/api/health`, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = await res.json();
      const latency = Math.round(performance.now() - startTime);
      return { ok: true, latency, data, url: base };
    } catch (err) {
      const latency = Math.round(performance.now() - startTime);
      return { ok: false, error: err.name === 'AbortError' ? 'Zaman aşımı (3.5 sn)' : (err.message || 'Erişilemedi'), latency, url: base };
    }
  }
}
