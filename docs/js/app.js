// windsculpt: wiring the sketch pads, the solver, the renderer and the UI.

import { GPUSolver } from './gpu-solver.js';
import { Renderer } from './render.js';
import { OrbitCamera } from './math3d.js';
import { SketchPad } from './sketch.js';
import { PRESETS, resample } from './shapes.js';
import { tauFromViscosity } from './lattice.js';

const GRIDS = {
  low: { nx: 96, ny: 48, nz: 48, particles: 32768 },
  medium: { nx: 128, ny: 64, nz: 64, particles: 65536 },
  high: { nx: 192, ny: 96, nz: 96, particles: 131072 },
};

// Per-preset placement defaults: size = body length / tunnel length.
const PRESET_DEFAULTS = {
  sphere: { size: 0.18 }, teardrop: { size: 0.26 }, bullet: { size: 0.3 }, cube: { size: 0.16 },
  plate: { size: 0.2 }, cylinder: { size: 0.14 }, wing: { size: 0.26, pitch: 6 },
  car: { size: 0.34, ground: true }, ahmed: { size: 0.32, ground: true },
};

const U_LATTICE = 0.07; // inlet speed in lattice units (Mach ~0.12)
const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------------ state

const state = {
  preset: 'sphere',
  mode: 'revolve',
  side: PRESETS.sphere.side,
  top: PRESETS.cube.top,
  stretch: [1, 1, 1],
  size: 0.18,
  pitch: 0,
  yaw: 0,
  ground: false,
  re: 1000,
  res: matchMedia('(max-width: 720px)').matches ? 'low' : 'medium',
  running: true,
  rake: 'sheet',
  sliceField: 'speed',
  sliceAxis: 'side',
  slicePos: 0.5,
  bodyColor: 'pressure',
};

// ------------------------------------------------------------------ share links

const q = (v) => Math.round(v * 100);
function encodeProfile(pts) { return resample(pts, 48).map(([u, v]) => `${q(u)}_${q(v)}`).join('.'); }
function decodeProfile(s) {
  const pts = s.split('.').map((p) => p.split('_').map((n) => +n / 100));
  return pts.length >= 3 && pts.every((p) => p.length === 2 && p.every(Number.isFinite)) ? pts : null;
}

function writeHash() {
  const p = new URLSearchParams();
  if (state.preset) p.set('preset', state.preset);
  else {
    p.set('mode', state.mode);
    p.set('side', encodeProfile(state.side));
    if (state.mode === 'carve') p.set('top', encodeProfile(state.top));
  }
  p.set('size', state.size.toFixed(2));
  p.set('pitch', state.pitch);
  p.set('yaw', state.yaw);
  p.set('re', Math.round(state.re));
  if (state.ground) p.set('ground', '1');
  if (state.res !== 'medium') p.set('res', state.res);
  history.replaceState(null, '', `#${p}`);
}

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  const preset = p.get('preset');
  if (preset && PRESETS[preset]) applyPreset(preset, false);
  else if (p.get('side')) {
    const side = decodeProfile(p.get('side'));
    if (side) {
      state.preset = null;
      state.side = side;
      state.mode = ['carve', 'revolve', 'extrude'].includes(p.get('mode')) ? p.get('mode') : 'revolve';
      state.top = (p.get('top') && decodeProfile(p.get('top'))) || state.top;
      state.stretch = [1, 1, 1];
    }
  }
  const num = (k, lo, hi) => { const v = parseFloat(p.get(k)); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : null; };
  state.size = num('size', 0.08, 0.5) ?? state.size;
  state.pitch = num('pitch', -30, 30) ?? state.pitch;
  state.yaw = num('yaw', -45, 45) ?? state.yaw;
  state.re = num('re', 10, 50000) ?? state.re;
  if (p.has('ground')) state.ground = p.get('ground') === '1';
  if (GRIDS[p.get('res')]) state.res = p.get('res');
}

function applyPreset(name, rebuild = true) {
  const P = PRESETS[name], D = PRESET_DEFAULTS[name] ?? {};
  state.preset = name;
  state.mode = P.mode;
  state.side = P.side;
  if (P.top) state.top = P.top;
  state.stretch = P.stretch ?? [1, 1, 1];
  state.size = D.size ?? 0.25;
  state.pitch = D.pitch ?? 0;
  state.yaw = 0;
  state.ground = D.ground ?? false;
  if (rebuild) { syncControls(); requestBuild(); }
}

// ------------------------------------------------------------------ WebGL setup

const canvas = $('view');
const gl = canvas.getContext('webgl2', { antialias: true, preserveDrawingBuffer: false });
const grid = GRIDS[(readHash(), state.res)];
let solver, renderer;
try {
  if (!gl) throw new Error('This browser does not support WebGL2.');
  solver = new GPUSolver(gl, grid);
  renderer = new Renderer(gl, solver, { particles: grid.particles });
} catch (err) {
  $('fallback').hidden = false;
  $('fallback-reason').textContent = err.message;
  throw err;
}
solver.uIn = [U_LATTICE, 0, 0];
solver.cs = 0.17;
solver.sponge = Math.round(grid.nx * 0.12);

const camera = new OrbitCamera([grid.nx * 0.45, grid.ny * 0.42, grid.nz * 0.5], grid.nx * 1.15);

// ------------------------------------------------------------------ body building

const worker = new Worker(new URL('./shape-worker.js', import.meta.url), { type: 'module' });
let buildId = 0, building = false, pendingBuild = false;
const body = { frontalArea: 1, length: 1, bounds: null };

function placement() {
  const L = state.size * grid.nx;
  const scale = L / 2;
  let bottom; // distance from the body's centre to its lowest point, in cells
  if (state.mode === 'revolve') bottom = Math.max(...state.side.map(([, v]) => Math.abs(v))) * state.stretch[1] * scale;
  else bottom = -Math.min(...state.side.map(([, v]) => v)) * state.stretch[1] * scale;
  const cy = state.ground ? 1 + 0.05 * L + bottom : (grid.ny - 1) / 2;
  return { center: [grid.nx * 0.3, cy, (grid.nz - 1) / 2], length: L, pitch: state.pitch, yaw: state.yaw };
}

function requestBuild() {
  if (building) { pendingBuild = true; return; }
  building = true;
  const shape = { mode: state.mode, side: state.side, top: state.top, stretch: state.stretch };
  worker.postMessage({ id: ++buildId, shape, grid, place: placement(), ground: state.ground });
  writeHash();
}

worker.onmessage = (e) => {
  const r = e.data;
  building = false;
  solver.setSolid(r.solid);
  solver.movingGround = state.ground;
  renderer.setMesh(r.mesh);
  renderer.setField(r.field);
  body.frontalArea = Math.max(1, r.frontalArea);
  body.length = state.size * grid.nx;
  body.bounds = r.bounds;
  updateViscosity();
  setRake();
  const b = r.bounds;
  if (r.volume === 0) hint('That outline is too thin for this grid. Draw it bigger or raise the size.');
  else if (b.minY <= 1 && !state.ground || b.maxY >= grid.ny - 2 || b.minZ <= 1 && state.mode !== 'extrude' || b.maxZ >= grid.nz - 2 && state.mode !== 'extrude') {
    hint('The body touches the tunnel walls. Lower the size for a cleaner result.');
  }
  resetStats();
  if (pendingBuild) { pendingBuild = false; requestBuild(); }
};

function updateViscosity() {
  const nu = (U_LATTICE * body.length) / state.re;
  solver.tau = Math.max(0.5005, tauFromViscosity(nu));
}

function setRake() {
  const b = body.bounds;
  if (!b || state.rake === 'off') return;
  const cy = (b.minY + b.maxY) / 2, cz = (b.minZ + b.maxZ) / 2;
  const hy = Math.max(4, (b.maxY - b.minY) * 0.8), hz = Math.max(4, (b.maxZ - b.minZ) * 0.8);
  const clampY = (v) => Math.min(grid.ny - 2, Math.max(state.ground ? 1.5 : 1, v));
  const clampZ = (v) => Math.min(grid.nz - 2, Math.max(1, v));
  const ext = state.mode === 'extrude';
  const rakes = {
    sheet: { min: [cy, clampZ(cz - hz * 1.3)], max: [cy, clampZ(cz + hz * 1.3)], count: [1, 40] },
    curtain: { min: [clampY(cy - hy * 1.3), cz], max: [clampY(cy + hy * 1.3), cz], count: [40, 1] },
    grid: { min: [clampY(cy - hy), clampZ(ext ? 4 : cz - hz)], max: [clampY(cy + hy), clampZ(ext ? grid.nz - 5 : cz + hz)], count: [14, 14] },
  };
  renderer.setRake(rakes[state.rake]);
}

// ------------------------------------------------------------------ sketch pads

const sidePad = new SketchPad($('pad-side'), {
  range: [-1.35, 1.35, -1.1, 1.1], vLabel: 'up',
  onChange: (pts) => { state.preset = null; state.side = pts; state.stretch = [1, 1, 1]; syncControls(); requestBuild(); },
  onHint: hint,
});
const topPad = new SketchPad($('pad-top'), {
  range: [-1.35, 1.35, -1.1, 1.1], vLabel: 'span',
  onChange: (pts) => { state.preset = null; state.top = pts; state.stretch = [1, 1, 1]; syncControls(); requestBuild(); },
  onHint: hint,
});

const MODE_NOTES = {
  carve: 'Side view and top view are both cut out of a block, like a sculptor working from two drawings.',
  revolve: 'The side view is spun around the dashed axis, like a part on a lathe.',
  extrude: 'The side view is stretched across the whole tunnel, so you see the 2D flow past a long beam.',
};

// ------------------------------------------------------------------ controls

const reFromSlider = (v) => 10 ** v;
const fmtRe = (re) => (re >= 1000 ? `${(re / 1000).toFixed(re >= 10000 ? 0 : 1)}k` : `${Math.round(re)}`);

function syncControls() {
  document.querySelectorAll('[data-preset]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.preset === state.preset)));
  document.querySelectorAll('[data-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === state.mode)));
  $('mode-note').textContent = MODE_NOTES[state.mode];
  sidePad.setProfile(state.side);
  sidePad.setRevolve(state.mode === 'revolve');
  topPad.setProfile(state.top);
  topPad.setEnabled(state.mode === 'carve', state.mode === 'revolve' ? 'Not used: revolved bodies are round' : 'Not used: extruded bodies span the tunnel');
  $('pitch').value = state.pitch; $('pitch-out').textContent = `${state.pitch}°`;
  $('yaw').value = state.yaw; $('yaw-out').textContent = `${state.yaw}°`;
  $('size').value = state.size; $('size-out').textContent = `${Math.round(state.size * grid.nx)} cells`;
  $('re').value = Math.log10(state.re); $('re-out').textContent = fmtRe(state.re);
  $('ground').checked = state.ground;
  $('res').value = state.res;
  $('rake').value = state.rake;
  $('slice-field').value = state.sliceField;
  $('slice-axis').value = state.sliceAxis;
  $('slice-pos').value = state.slicePos;
  $('body-color').value = state.bodyColor;
  $('run').textContent = state.running ? 'Pause' : 'Run';
  updateLegend();
}

function bind(id, ev, fn) { $(id).addEventListener(ev, fn); }

document.querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', () => applyPreset(b.dataset.preset)));
document.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => {
  state.mode = b.dataset.mode; state.preset = null; syncControls(); requestBuild();
}));
bind('pitch', 'input', (e) => { state.pitch = +e.target.value; $('pitch-out').textContent = `${state.pitch}°`; requestBuild(); });
bind('yaw', 'input', (e) => { state.yaw = +e.target.value; $('yaw-out').textContent = `${state.yaw}°`; requestBuild(); });
bind('size', 'input', (e) => { state.size = +e.target.value; $('size-out').textContent = `${Math.round(state.size * grid.nx)} cells`; requestBuild(); });
bind('re', 'input', (e) => { state.re = reFromSlider(+e.target.value); $('re-out').textContent = fmtRe(state.re); updateViscosity(); writeHash(); });
bind('ground', 'change', (e) => { state.ground = e.target.checked; requestBuild(); });
bind('res', 'change', (e) => { state.res = e.target.value; writeHash(); location.reload(); });
bind('rake', 'change', (e) => { state.rake = e.target.value; setRake(); });
bind('slice-field', 'change', (e) => { state.sliceField = e.target.value; updateLegend(); });
bind('slice-axis', 'change', (e) => { state.sliceAxis = e.target.value; });
bind('slice-pos', 'input', (e) => { state.slicePos = +e.target.value; });
bind('body-color', 'change', (e) => { state.bodyColor = e.target.value; updateLegend(); });
bind('run', 'click', toggleRun);
bind('restart', 'click', () => { solver.reset(); resetStats(); setRake(); });
bind('share', 'click', async () => {
  writeHash();
  try { await navigator.clipboard.writeText(location.href); hint('Link copied. It opens this exact shape and setup.'); }
  catch { hint('Copy the address bar to share this setup.'); }
});
bind('snapshot', 'click', () => { wantSnapshot = true; });

function toggleRun() { state.running = !state.running; $('run').textContent = state.running ? 'Pause' : 'Run'; }
addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !['INPUT', 'SELECT', 'BUTTON', 'TEXTAREA'].includes(document.activeElement?.tagName)) {
    e.preventDefault(); toggleRun();
  }
});

let hintTimer;
function hint(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => { t.hidden = true; }, 4200);
}

const LEGENDS = {
  speed: ['Air speed', 'still', 'free stream', 'fast', 'seq', 'Purple tint: air flowing backwards (recirculation).'],
  pressure: ['Pressure coefficient', '−1 suction', '0', '+1 stagnation', 'div', ''],
  vorticity: ['Vorticity (swirl)', 'calm', '', 'strong', 'seq', ''],
};
function updateLegend() {
  const f = state.sliceField !== 'off' ? state.sliceField : state.bodyColor === 'pressure' ? 'pressure' : null;
  const el = $('legend');
  el.hidden = !f;
  if (!f) return;
  const [title, lo, mid, hi, kind, note] = LEGENDS[f];
  el.querySelector('.legend-title').textContent = title;
  el.querySelector('.legend-bar').dataset.kind = kind;
  const ticks = el.querySelectorAll('.legend-ticks span');
  ticks[0].textContent = lo; ticks[1].textContent = mid; ticks[2].textContent = hi;
  el.querySelector('.legend-note').textContent = note;
}

// ------------------------------------------------------------------ camera input

const pointers = new Map();
let pinch = null;
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, button: e.button, shift: e.shiftKey });
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    pinch = Math.hypot(a.x - b.x, a.y - b.y);
  }
});
canvas.addEventListener('pointermove', (e) => {
  const p = pointers.get(e.pointerId);
  if (!p) return;
  const dx = e.clientX - p.x, dy = e.clientY - p.y;
  p.x = e.clientX; p.y = e.clientY;
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    if (pinch) camera.zoom(pinch / d, grid.nx * 0.3, grid.nx * 4);
    pinch = d;
  } else if (p.button === 2 || p.shift) camera.pan(dx, dy);
  else camera.rotate(dx, dy);
});
const release = (e) => { pointers.delete(e.pointerId); pinch = null; };
canvas.addEventListener('pointerup', release);
canvas.addEventListener('pointercancel', release);
canvas.addEventListener('wheel', (e) => { e.preventDefault(); camera.zoom(Math.exp(e.deltaY * 0.0012), grid.nx * 0.3, grid.nx * 4); }, { passive: false });

// ------------------------------------------------------------------ forces and stats

const hist = { cd: [], cl: [], max: 360 };
let avg = { cd: NaN, cl: NaN, n: 0 };
function resetStats() { hist.cd.length = 0; hist.cl.length = 0; avg = { cd: NaN, cl: NaN, n: 0 }; }

function sampleForces() {
  const [fx, fy] = solver.totalForce();
  const U = solver.inletVelocity()[0];
  if (!Number.isFinite(fx) || !Number.isFinite(fy) || Math.abs(fx) > 1e6) {
    solver.reset(); resetStats(); setRake();
    hint('The flow went unstable and restarted. Lower the Reynolds number or switch to a finer grid.');
    return;
  }
  if (solver.time < solver.ramp + 50) return;
  const qA = 0.5 * U * U * body.frontalArea;
  const cd = fx / qA, cl = fy / qA;
  hist.cd.push(cd); hist.cl.push(cl);
  if (hist.cd.length > hist.max) { hist.cd.shift(); hist.cl.shift(); }
  // Running average over the recent history (vortex shedding makes forces oscillate).
  const n = Math.min(hist.cd.length, 160);
  avg.cd = hist.cd.slice(-n).reduce((a, b) => a + b, 0) / n;
  avg.cl = hist.cl.slice(-n).reduce((a, b) => a + b, 0) / n;
}

function drawChart() {
  const c = $('chart'), ctx = c.getContext('2d');
  const dpr = devicePixelRatio || 1;
  const w = Math.round(c.clientWidth * dpr), h = Math.round(c.clientHeight * dpr);
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  ctx.clearRect(0, 0, w, h);
  const all = [...hist.cd, ...hist.cl, 0];
  let lo = Math.min(...all), hi = Math.max(...all);
  if (hi - lo < 0.2) { const m = (hi + lo) / 2; lo = m - 0.1; hi = m + 0.1; }
  const pad = (hi - lo) * 0.1; lo -= pad; hi += pad;
  const Y = (v) => h - ((v - lo) / (hi - lo)) * h;
  ctx.strokeStyle = 'rgba(159,179,195,0.35)'; ctx.lineWidth = dpr;
  ctx.beginPath(); ctx.moveTo(0, Y(0)); ctx.lineTo(w, Y(0)); ctx.stroke();
  const line = (arr, color) => {
    if (arr.length < 2) return;
    ctx.strokeStyle = color; ctx.lineWidth = 1.5 * dpr; ctx.beginPath();
    arr.forEach((v, i) => { const x = (i / (hist.max - 1)) * w; i ? ctx.lineTo(x, Y(v)) : ctx.moveTo(x, Y(v)); });
    ctx.stroke();
  };
  line(hist.cl, '#8ec5e8');
  line(hist.cd, '#f2c230');
}

const fmt = (v) => (Number.isFinite(v) ? (Math.abs(v) < 0.005 ? '0.00' : v.toFixed(2)) : '–');

function updateHud(stepsPerSec) {
  const warming = solver.time < solver.ramp + 50 || !Number.isFinite(avg.cd);
  $('cd').textContent = warming ? '–' : fmt(avg.cd);
  $('cl').textContent = warming ? '–' : fmt(avg.cl);
  $('re-hud').textContent = fmtRe(state.re);
  $('status').textContent = warming
    ? 'Starting the wind…'
    : `${grid.nx}×${grid.ny}×${grid.nz} grid, ${Math.round(stepsPerSec)} steps per second, air has passed ${(solver.time * U_LATTICE / body.length).toFixed(0)} body lengths`;
  drawChart();
}

// ------------------------------------------------------------------ main loop

let stepsPerFrame = 4, frameAvg = 16, last = performance.now(), frameCount = 0, wantSnapshot = false;
let stepCounter = 0, stepClock = performance.now(), stepsPerSec = 0;
const SLICE_AXES = { wake: 0, top: 1, side: 2 };
const SLICE_FIELDS = { speed: 0, pressure: 1, vorticity: 2 };

function sliceCoord() {
  const b = body.bounds;
  const t = state.slicePos;
  if (state.sliceAxis === 'wake') {
    const start = b ? b.minX : grid.nx * 0.2;
    return start + t * (grid.nx * 0.85 - start);
  }
  const n = state.sliceAxis === 'top' ? grid.ny : grid.nz;
  const c = b ? (state.sliceAxis === 'top' ? (b.minY + b.maxY) / 2 : (b.minZ + b.maxZ) / 2) : n / 2;
  return Math.min(n - 1.5, Math.max(0.5, c + (t - 0.5) * n * 0.9));
}

function frame(now) {
  const dt = now - last; last = now;
  frameAvg = 0.9 * frameAvg + 0.1 * dt;
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }

  if (state.running) {
    // Adapt the work per frame to keep the page responsive.
    if (frameAvg < 20 && stepsPerFrame < 24) stepsPerFrame++;
    else if (frameAvg > 34 && stepsPerFrame > 1) stepsPerFrame--;
    solver.step(stepsPerFrame);
    if (state.rake !== 'off') renderer.advectSmoke(stepsPerFrame);
    stepCounter += stepsPerFrame;
    if (++frameCount % 6 === 0) sampleForces();
  }
  if (now - stepClock > 1000) { stepsPerSec = (stepCounter * 1000) / (now - stepClock); stepCounter = 0; stepClock = now; }
  if (frameCount % 15 === 0 || !state.running) updateHud(stepsPerSec);

  renderer.render(camera.matrices(w / h), {
    width: w, height: h, U: solver.inletVelocity()[0], L: body.length,
    bodyColor: state.bodyColor, smoke: state.rake !== 'off',
    slice: state.sliceField === 'off' ? null : { field: SLICE_FIELDS[state.sliceField], axis: SLICE_AXES[state.sliceAxis], pos: sliceCoord() },
    ground: state.ground, belt: (solver.time * U_LATTICE) % 1e4,
  });
  if (wantSnapshot) {
    wantSnapshot = false;
    canvas.toBlob((b) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(b);
      a.download = 'windsculpt.png';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    });
  }
  requestAnimationFrame(frame);
}

syncControls();
requestBuild();
requestAnimationFrame(frame);

// Handle for scripted captures (scripts/capture.js).
window.windsculpt = { state, solver, renderer, camera, applyPreset, requestBuild, syncControls, setRake, hist, avg: () => avg, body };
