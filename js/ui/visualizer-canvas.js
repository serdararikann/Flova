/* ====================================================================
   FLOVA AUDIO STUDIO - LIVE SPECTRUM & FREQUENCY VISUALIZER
   Ultra-smooth 60fps Neon Audio Spectrum & Oscilloscope
   ==================================================================== */

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

    // Background
    ctx.fillStyle = '#090c16';
    ctx.fillRect(0, 0, w, h);

    if (!this.analyser) {
      // Idle idle animated ambient line
      this.drawIdle(ctx, w, h);
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
      const barHeight = Math.max(3, (val / 255) * (h - 10));

      const x = i * (barWidth + 2);
      const y = h - barHeight;

      // Dynamic color gradient based on frequency
      const hue = 190 + (i / numBars) * 90; // Cyan -> Purple
      const gradient = ctx.createLinearGradient(0, y, 0, h);
      gradient.addColorStop(0, `hsl(${hue}, 90%, 65%)`);
      gradient.addColorStop(1, `hsl(${hue}, 80%, 35%)`);

      ctx.fillStyle = gradient;
      ctx.shadowColor = `hsl(${hue}, 100%, 60%)`;
      ctx.shadowBlur = val > 120 ? 8 : 2;

      ctx.beginPath();
      ctx.roundRect(x, y, barWidth, barHeight, [3, 3, 0, 0]);
      ctx.fill();
    }
    ctx.shadowBlur = 0;
  }

  drawIdle(ctx, w, h) {
    const t = Date.now() * 0.002;
    ctx.strokeStyle = 'rgba(99, 102, 241, 0.25)';
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
