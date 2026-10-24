/**
 * Konsol theme tokens for canvas drawing (canvases can't use CSS variables directly).
 * Read from the :root custom properties in css/style.css and cached until the theme changes
 * (app.js fires "flova-theme" from applyTheme).
 */
const TOKENS = ['bg', 'surface', 'raised', 'inset', 'line', 'line-soft', 'text', 'muted', 'dim',
  'accent', 'on-accent', 'accent-text', 'accent-soft', 'danger', 'positive', 'wave-idle'];

let cache = null;
const listeners = new Set();

window.addEventListener('flova-theme', () => {
  cache = null;
  // Redraw after the new custom properties apply
  requestAnimationFrame(() => listeners.forEach((fn) => { try { fn(); } catch (e) { console.warn(e); } }));
});

/** { bg, surface, ..., lineSoft, onAccent, accentText, accentSoft, waveIdle } as CSS color strings. */
export function themeColors() {
  if (cache) return cache;
  const style = getComputedStyle(document.documentElement);
  cache = {};
  for (const name of TOKENS) {
    const key = name.replace(/-(\w)/g, (_, ch) => ch.toUpperCase());
    cache[key] = style.getPropertyValue(`--${name}`).trim();
  }
  return cache;
}

/** Calls fn after each theme change (to redraw a canvas). */
export function onThemeChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** "#rrggbb" + alpha → rgba(); other strings are returned as they are. */
export function withAlpha(color, alpha) {
  const m = /^#([0-9a-f]{6})$/i.exec(color || '');
  if (!m) return color;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

export const MONO_FONT = "'JetBrains Mono', Consolas, monospace";
export const SANS_FONT = "Archivo, -apple-system, 'Segoe UI', sans-serif";
