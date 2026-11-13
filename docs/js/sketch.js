// A drawing pad for one 2D profile. You draw a closed outline with the mouse,
// pen or a finger; it is cleaned up (smoothed, closed, resampled) and handed
// to onChange as a polygon in normalized coordinates.

import { cleanStroke } from './shapes.js';

const PAPER = '#f4f7f8', RULE = '#cfdae2', AXIS = '#9fb3c3', INK = '#2a2f35', PENCIL = '#5b6670';

export class SketchPad {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} o
   * @param {[number, number, number, number]} o.range  [umin, umax, vmin, vmax]
   * @param {string} o.vLabel   name of the vertical axis ("up" or "span")
   * @param {(pts: number[][]) => void} o.onChange
   * @param {(msg: string) => void} [o.onHint]
   */
  constructor(canvas, o) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.range = o.range;
    this.vLabel = o.vLabel;
    this.onChange = o.onChange;
    this.onHint = o.onHint ?? (() => {});
    this.profile = null;
    this.stroke = null;
    this.enabled = true;
    this.revolve = false;
    this.disabledNote = '';

    canvas.addEventListener('pointerdown', (e) => this._down(e));
    canvas.addEventListener('pointermove', (e) => this._move(e));
    canvas.addEventListener('pointerup', (e) => this._up(e));
    canvas.addEventListener('pointercancel', () => { this.stroke = null; this.draw(); });
    new ResizeObserver(() => this.draw()).observe(canvas);
  }

  setProfile(pts) { this.profile = pts; this.draw(); }
  setEnabled(on, note = '') { this.enabled = on; this.disabledNote = note; this.draw(); }
  setRevolve(on) { this.revolve = on; this.draw(); }

  _toUV(e) {
    const r = this.canvas.getBoundingClientRect();
    const [u0, u1, v0, v1] = this.range;
    return [u0 + ((e.clientX - r.left) / r.width) * (u1 - u0), v1 - ((e.clientY - r.top) / r.height) * (v1 - v0)];
  }

  _down(e) {
    if (!this.enabled) return;
    this.canvas.setPointerCapture(e.pointerId);
    this.stroke = [this._toUV(e)];
    this.draw();
  }

  _move(e) {
    if (!this.stroke) return;
    for (const ev of e.getCoalescedEvents?.() ?? [e]) this.stroke.push(this._toUV(ev));
    this.draw();
  }

  _up() {
    if (!this.stroke) return;
    const raw = this.stroke;
    this.stroke = null;
    const pts = cleanStroke(raw);
    if (!pts) {
      this.onHint('Draw a closed outline: a loop that ends near where it started.');
      this.draw();
      return;
    }
    this.profile = pts;
    this.draw();
    this.onChange(pts);
  }

  draw() {
    const c = this.canvas, ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(c.clientWidth * dpr), h = Math.round(c.clientHeight * dpr);
    if (!w || !h) return;
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const [u0, u1, v0, v1] = this.range;
    const X = (u) => ((u - u0) / (u1 - u0)) * w;
    const Y = (v) => ((v1 - v) / (v1 - v0)) * h;

    ctx.fillStyle = PAPER;
    ctx.fillRect(0, 0, w, h);

    // Graph-paper rules every 0.25 units, axes through the origin.
    ctx.lineWidth = dpr;
    ctx.strokeStyle = RULE;
    ctx.beginPath();
    for (let u = Math.ceil(u0 * 4) / 4; u <= u1; u += 0.25) { ctx.moveTo(X(u), 0); ctx.lineTo(X(u), h); }
    for (let v = Math.ceil(v0 * 4) / 4; v <= v1; v += 0.25) { ctx.moveTo(0, Y(v)); ctx.lineTo(w, Y(v)); }
    ctx.stroke();
    ctx.strokeStyle = AXIS;
    ctx.beginPath();
    ctx.moveTo(X(0), 0); ctx.lineTo(X(0), h);
    ctx.moveTo(0, Y(0)); ctx.lineTo(w, Y(0));
    ctx.stroke();

    // Body length guide: the profile's -1..1 streamwise extent sets the body length.
    ctx.setLineDash([4 * dpr, 4 * dpr]);
    ctx.strokeStyle = AXIS;
    ctx.strokeRect(X(-1), Y(1), X(1) - X(-1), Y(-1) - Y(1));
    ctx.setLineDash([]);

    // Flow direction arrow.
    ctx.strokeStyle = PENCIL; ctx.fillStyle = PENCIL;
    ctx.lineWidth = 1.5 * dpr;
    const ay = 12 * dpr, ax = 10 * dpr;
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(ax + 34 * dpr, ay); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(ax + 40 * dpr, ay); ctx.lineTo(ax + 32 * dpr, ay - 4 * dpr); ctx.lineTo(ax + 32 * dpr, ay + 4 * dpr); ctx.fill();
    ctx.font = `${11 * dpr}px Barlow, system-ui, sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.fillText('wind', ax + 46 * dpr, ay);
    ctx.textAlign = 'right';
    ctx.fillText(this.vLabel, w - 8 * dpr, ay);
    ctx.textAlign = 'left';

    if (this.revolve) {
      ctx.setLineDash([10 * dpr, 4 * dpr, 2 * dpr, 4 * dpr]);
      ctx.strokeStyle = INK;
      ctx.lineWidth = dpr;
      ctx.beginPath(); ctx.moveTo(0, Y(0)); ctx.lineTo(w, Y(0)); ctx.stroke();
      ctx.setLineDash([]);
    }

    const path = (pts) => {
      ctx.beginPath();
      pts.forEach(([u, v], i) => (i ? ctx.lineTo(X(u), Y(v)) : ctx.moveTo(X(u), Y(v))));
    };

    if (this.profile) {
      ctx.globalAlpha = this.enabled ? 1 : 0.35;
      path(this.profile); ctx.closePath();
      ctx.fillStyle = 'rgba(42, 47, 53, 0.16)'; ctx.fill();
      ctx.strokeStyle = INK; ctx.lineWidth = 2 * dpr; ctx.stroke();
      ctx.globalAlpha = 1;
    }

    if (this.stroke && this.stroke.length > 1) {
      path(this.stroke);
      ctx.strokeStyle = '#b7860b'; ctx.lineWidth = 2.5 * dpr; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.stroke();
    }

    if (!this.enabled && this.disabledNote) {
      ctx.fillStyle = 'rgba(244, 247, 248, 0.82)';
      ctx.fillRect(0, h / 2 - 16 * dpr, w, 32 * dpr);
      ctx.fillStyle = INK;
      ctx.textAlign = 'center';
      ctx.font = `${12 * dpr}px Barlow, system-ui, sans-serif`;
      ctx.fillText(this.disabledNote, w / 2, h / 2);
      ctx.textAlign = 'left';
    }
  }
}
