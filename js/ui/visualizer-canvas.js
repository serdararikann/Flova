/* ====================================================================
   FLOVA AUDIO STUDIO - LIVE SPECTRUM & FREQUENCY VISUALIZER
   60fps spectrum bars in the Konsol look (text-colored, accent near the top)
   ==================================================================== */

import { themeColors, withAlpha } from './theme-colors.js';

export class VisualizerCanvas {
  constructor(canvasElement, analyserNode) {
    this.canvas = canvasElement;
    this.ctx = this.canvas.getContext('2d');
    this.analyser = analyserNode;
    this.animationId = null;
    this.mode = 'bars'; // 'bars' | 'wave'

    this.dataArray = null;
    this.bufferLength = 0;

    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.start();
  }

  setAnalyser(analyserNode) {
    this.analyser = analyserNode;
    if (this.analyser) {
      this.bufferLength = this.analyser.frequencyBinCount;
      this.dataArray = new Uint8Array(this.bufferLength);
    }
  }

  resize() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.width = rect.width;
    this.height = rect.height;
    this.canvas.width = this.width * dpr;
    this.canvas.height = this.height * dpr;
    this.ctx.scale(dpr, dpr);
  }

  start() {
    if (this.animationId) return;

    const render = () => {
      this.draw();
      this.animationId = requestAnimationFrame(render);
    };
    this.animationId = requestAnimationFrame(render);
  }

  stop() {
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
  }

  draw() {
    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;

    ctx.clearRect(0, 0, w, h);
    const c = themeColors();

    if (!this.analyser) {
      // Idle idle animated ambient line
      this.drawIdle(ctx, w, h, c);
      return;
    }

    if (!this.dataArray || this.dataArray.length !== this.analyser.frequencyBinCount) {
      this.bufferLength = this.analyser.frequencyBinCount;
      this.dataArray = new Uint8Array(this.bufferLength);
    }

    this.analyser.getByteFrequencyData(this.dataArray);

    const numBars = 48;
    const barWidth = (w / numBars) - 2;
    const step = Math.floor(this.bufferLength / numBars);

    for (let i = 0; i < numBars; i++) {
      let sum = 0;
      for (let j = 0; j < step; j++) {
        sum += this.dataArray[i * step + j] || 0;
      }
      const val = sum / step;
      const level = val / 255;
      const barHeight = Math.max(2, level * (h - 6));

      const x = i * (barWidth + 2);
      const y = h - barHeight;

      ctx.fillStyle = level > 0.85 ? c.accent : c.text;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x, y, barWidth, barHeight, [1, 1, 0, 0]);
      else ctx.rect(x, y, barWidth, barHeight);
      ctx.fill();
    }
  }

  drawIdle(ctx, w, h, c) {
    const t = Date.now() * 0.002;
    ctx.strokeStyle = withAlpha(c.muted, 0.35);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let x = 0; x < w; x += 4) {
      const y = (h / 2) + Math.sin(x * 0.04 + t) * 4;
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
}
