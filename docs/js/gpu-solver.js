// D3Q19 lattice Boltzmann wind tunnel on the GPU with WebGL2.
//
// The 3D lattice is stored as a 2D "atlas": z-slices tiled across a texture.
// The 19 populations live in five RGBA32F textures (20 channels, the last one
// unused), stored as deviations from the rest weights (f_i - w_i) to keep
// float32 precision. One fragment-shader pass per time step streams (pull),
// applies the boundaries, collides (BGK + Smagorinsky), and writes the new
// populations plus the macroscopic fields and per-node momentum-exchange
// forces through multiple render targets (7 of the 8 guaranteed).
//
// The shader source is generated from the same lattice tables as the CPU
// reference solver (lattice.js), and implements the same scheme line for line.

import { C, Q, W, OPP, REFL_Y, REFL_Z, REFL_YZ } from './lattice.js';
import { program, texture, framebuffer, FULLSCREEN_VS, bindTextures } from './gl-util.js';

const NT = 5; // population textures
const SW = ['x', 'y', 'z', 'w'];
const fl = (v) => (Number.isInteger(v) ? `${v}.0` : `${v}`);
const wConst = (i) => `${W[i].toPrecision(17)}`;

/** Choose a z-slice tiling that keeps the atlas close to square. */
export function atlasLayout(nx, ny, nz, maxSize = 8192) {
  let best = null;
  for (let tx = 1; tx <= nz; tx++) {
    const ty = Math.ceil(nz / tx);
    const w = nx * tx, h = ny * ty;
    if (w > maxSize || h > maxSize) continue;
    const score = Math.abs(Math.log(w / h)) + 0.01 * (tx * ty - nz);
    if (!best || score < best.score) best = { tx, ty, w, h, score };
  }
  if (!best) throw new Error('grid too large for this GPU');
  return best;
}

export const ATLAS_GLSL = `
uniform ivec3 uN;
uniform int uTX;
ivec2 toAtlas(ivec3 p) { return ivec2(p.x + (p.z % uTX) * uN.x, p.y + (p.z / uTX) * uN.y); }
ivec3 fromAtlas(ivec2 a) {
  int tx = a.x / uN.x, ty = a.y / uN.y;
  return ivec3(a.x - tx * uN.x, a.y - ty * uN.y, ty * uTX + tx);
}`;

function fetchDir(d, atlasVar) {
  return `texelFetch(uF${d >> 2}, ${atlasVar}, 0).${SW[d & 3]}`;
}

function stepShader() {
  const lines = [];
  lines.push(`#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
${ATLAS_GLSL}
uniform sampler2D uF0, uF1, uF2, uF3, uF4, uMask;
uniform float uTau, uCs, uSpongeTau;
uniform int uSpongeStart, uSponge;
uniform vec3 uUin, uGround;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
layout(location = 2) out vec4 o2;
layout(location = 3) out vec4 o3;
layout(location = 4) out vec4 o4;
layout(location = 5) out vec4 oMacro;
layout(location = 6) out vec4 oForce;

// Mask: 0 = fluid, 1 = body (counts toward the force), 0.5 = ground (moving belt).
float maskAt(ivec2 a) { return texelFetch(uMask, a, 0).r; }
bool solidAt(ivec2 a) { return maskAt(a) > 0.25; }

void writeAll(float d[20]) {
  o0 = vec4(d[0], d[1], d[2], d[3]);
  o1 = vec4(d[4], d[5], d[6], d[7]);
  o2 = vec4(d[8], d[9], d[10], d[11]);
  o3 = vec4(d[12], d[13], d[14], d[15]);
  o4 = vec4(d[16], d[17], d[18], 0.0);
}

void main() {
  ivec2 a = ivec2(gl_FragCoord.xy);
  ivec3 p = fromAtlas(a);
  float d[20];
  for (int i = 0; i < 20; i++) d[i] = 0.0;
  if (p.z >= uN.z) { writeAll(d); oMacro = vec4(0.0, 0.0, 0.0, 1.0); oForce = vec4(0.0); return; }
  if (solidAt(a)) { writeAll(d); oMacro = vec4(0.0, 0.0, 0.0, 1.0); oForce = vec4(0.0, 0.0, 0.0, 1.0); return; }

  vec3 force = vec3(0.0);
  ivec3 s; ivec2 sa; bool oy, oz; float mv;
  d[0] = ${fetchDir(0, 'a')};`);

  for (let i = 1; i < Q; i++) {
    const [cx, cy, cz] = C[i];
    const o = OPP[i];
    const co = C[o];
    lines.push(`
  // direction ${i}: c = (${cx}, ${cy}, ${cz})
  s = p - ivec3(${cx}, ${cy}, ${cz});
  oy = s.y < 0 || s.y >= uN.y;
  oz = s.z < 0 || s.z >= uN.z;
  if (oy) s.y = p.y;
  if (oz) s.z = p.z;
  s.x = clamp(s.x, 0, uN.x - 1);
  sa = toAtlas(s);
  mv = maskAt(sa);
  if (mv > 0.75) {
    d[${i}] = ${fetchDir(o, 'a')};
    force += ${fl(2)} * vec3(${fl(co[0])}, ${fl(co[1])}, ${fl(co[2])}) * (d[${i}] + ${wConst(o)});
  } else if (mv > 0.25) {
    d[${i}] = ${fetchDir(o, 'a')} + ${(6 * W[i]).toPrecision(17)} * dot(vec3(${fl(cx)}, ${fl(cy)}, ${fl(cz)}), uGround);
  } else if (oy && oz) d[${i}] = ${fetchDir(REFL_YZ[i], 'sa')};
  else if (oy) d[${i}] = ${fetchDir(REFL_Y[i], 'sa')};
  else if (oz) d[${i}] = ${fetchDir(REFL_Z[i], 'sa')};
  else d[${i}] = ${fetchDir(i, 'sa')};`);
  }

  // Equilibrium deviation: f_eq - w = w (rho' + rho (3 cu + 4.5 cu^2 - 1.5 uu)).
  const eqLines = (target, rhoP, rho, u) => C.map((c, i) => {
    const cu = [c[0] && `${c[0] < 0 ? '-' : ''}${u}.x`, c[1] && `${c[1] < 0 ? '-' : ''}${u}.y`, c[2] && `${c[2] < 0 ? '-' : ''}${u}.z`]
      .filter(Boolean).join(' + ').replace(/\+ -/g, '- ') || '0.0';
    return `  { float cu = ${cu}; ${target}[${i}] = ${wConst(i)} * (${rhoP} + ${rho} * (3.0 * cu + 4.5 * cu * cu - 1.5 * uu)); }`;
  }).join('\n');

  lines.push(`

  if (p.x == 0) {
    // Inlet: equilibrium at the free-stream velocity and unit density.
    vec3 u = uUin; float uu = dot(u, u);
    float e[20]; e[19] = 0.0;
${eqLines('e', '0.0', '1.0', 'u')}
    writeAll(e);
    oMacro = vec4(u, 1.0);
    oForce = vec4(force, 0.0);
    return;
  }

  float rhoP = 0.0; vec3 m = vec3(0.0);`);
  for (let i = 0; i < Q; i++) {
    const [cx, cy, cz] = C[i];
    const terms = [];
    lines.push(`  rhoP += d[${i}];`);
    if (cx || cy || cz) {
      if (cx) terms.push(`m.x ${cx > 0 ? '+=' : '-='} d[${i}];`);
      if (cy) terms.push(`m.y ${cy > 0 ? '+=' : '-='} d[${i}];`);
      if (cz) terms.push(`m.z ${cz > 0 ? '+=' : '-='} d[${i}];`);
      lines.push(`  ${terms.join(' ')}`);
    }
  }
  lines.push(`
  float rho = 1.0 + rhoP;
  vec3 u = m / rho;
  float uu = dot(u, u);
  float e[20]; e[19] = 0.0;
${eqLines('e', 'rhoP', 'rho', 'u')}

  float tau = uTau;
  if (uSponge > 0 && p.x >= uSpongeStart) {
    float sp = float(p.x - uSpongeStart + 1) / float(uSponge);
    tau += (uSpongeTau - uTau) * sp * sp;
  }
  if (uCs > 0.0) {
    float pxx = 0.0, pyy = 0.0, pzz = 0.0, pxy = 0.0, pxz = 0.0, pyz = 0.0, ne;`);
  for (let i = 1; i < Q; i++) {
    const [cx, cy, cz] = C[i];
    const t = [`ne = d[${i}] - e[${i}];`];
    if (cx) t.push('pxx += ne;');
    if (cy) t.push('pyy += ne;');
    if (cz) t.push('pzz += ne;');
    if (cx && cy) t.push(`pxy ${cx * cy > 0 ? '+=' : '-='} ne;`);
    if (cx && cz) t.push(`pxz ${cx * cz > 0 ? '+=' : '-='} ne;`);
    if (cy && cz) t.push(`pyz ${cy * cz > 0 ? '+=' : '-='} ne;`);
    lines.push(`    ${t.join(' ')}`);
  }
  lines.push(`    float pn = sqrt(pxx * pxx + pyy * pyy + pzz * pzz + 2.0 * (pxy * pxy + pxz * pxz + pyz * pyz));
    tau = 0.5 * (tau + sqrt(tau * tau + ${(18 * Math.SQRT2).toPrecision(17)} * uCs * uCs * pn / rho));
  }
  float om = 1.0 / tau;
  for (int i = 0; i < 19; i++) d[i] -= om * (d[i] - e[i]);
  d[19] = 0.0;
  writeAll(d);
  oMacro = vec4(u, rho);
  oForce = vec4(force, 0.0);
}`);
  return lines.join('\n');
}

function initShader() {
  const eq = C.map((c, i) => {
    const cu = `${fl(c[0])} * u.x + ${fl(c[1])} * u.y + ${fl(c[2])} * u.z`;
    return `  { float cu = ${cu}; e[${i}] = ${wConst(i)} * (3.0 * cu + 4.5 * cu * cu - 1.5 * uu); }`;
  }).join('\n');
  return `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
${ATLAS_GLSL}
uniform sampler2D uMask;
uniform vec3 uU;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
layout(location = 2) out vec4 o2;
layout(location = 3) out vec4 o3;
layout(location = 4) out vec4 o4;
layout(location = 5) out vec4 oMacro;
layout(location = 6) out vec4 oForce;
void main() {
  ivec2 a = ivec2(gl_FragCoord.xy);
  ivec3 p = fromAtlas(a);
  float e[20];
  for (int i = 0; i < 20; i++) e[i] = 0.0;
  bool solid = p.z >= uN.z || texelFetch(uMask, a, 0).r > 0.25;
  vec3 u = solid ? vec3(0.0) : uU;
  float uu = dot(u, u);
  if (!solid) {
${eq}
  }
  o0 = vec4(e[0], e[1], e[2], e[3]);
  o1 = vec4(e[4], e[5], e[6], e[7]);
  o2 = vec4(e[8], e[9], e[10], e[11]);
  o3 = vec4(e[12], e[13], e[14], e[15]);
  o4 = vec4(e[16], e[17], e[18], 0.0);
  oMacro = vec4(u, 1.0);
  oForce = vec4(0.0, 0.0, 0.0, solid ? 1.0 : 0.0);
}`;
}

const REDUCE_FS = `#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D uSrc;
uniform ivec2 uSrcSize;
out vec4 o;
void main() {
  ivec2 b = ivec2(gl_FragCoord.xy) * 8;
  vec4 s = vec4(0.0);
  for (int j = 0; j < 8; j++) for (int i = 0; i < 8; i++) {
    ivec2 q = b + ivec2(i, j);
    if (q.x < uSrcSize.x && q.y < uSrcSize.y) s += texelFetch(uSrc, q, 0);
  }
  o = s;
}`;

export class GPUSolver {
  constructor(gl, { nx, ny, nz }) {
    this.gl = gl;
    if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('This browser cannot render to float textures (EXT_color_buffer_float).');
    if (gl.getParameter(gl.MAX_DRAW_BUFFERS) < 7) throw new Error('This GPU supports too few render targets.');
    this.nx = nx; this.ny = ny; this.nz = nz;
    const L = atlasLayout(nx, ny, nz, gl.getParameter(gl.MAX_TEXTURE_SIZE));
    this.tx = L.tx; this.width = L.w; this.height = L.h;
    this.tau = 0.56; this.cs = 0.17; this.sponge = Math.round(nx * 0.12); this.spongeTau = 1.0;
    this.uIn = [0.08, 0, 0]; this.ramp = 400;
    this.movingGround = false;
    this.time = 0;

    this.stepProg = program(gl, FULLSCREEN_VS, stepShader());
    this.initProg = program(gl, FULLSCREEN_VS, initShader());
    this.reduceProg = program(gl, FULLSCREEN_VS, REDUCE_FS);

    const mk = () => texture(gl, this.width, this.height);
    this.fA = Array.from({ length: NT }, mk);
    this.fB = Array.from({ length: NT }, mk);
    this.macro = mk();
    this.forceTex = mk();
    this.mask = texture(gl, this.width, this.height, { internal: gl.R8, format: gl.RED, type: gl.UNSIGNED_BYTE });
    this.fbA = framebuffer(gl, [...this.fA, this.macro, this.forceTex]);
    this.fbB = framebuffer(gl, [...this.fB, this.macro, this.forceTex]);
    this.cur = 'A';
    this.drawBuffers = Array.from({ length: 7 }, (_, i) => gl.COLOR_ATTACHMENT0 + i);

    // Reduction chain for the total force.
    this.reduce = [];
    let w = this.width, h = this.height;
    while (w > 1 || h > 1) {
      const nw = Math.ceil(w / 8), nh = Math.ceil(h / 8);
      const t = texture(gl, nw, nh);
      this.reduce.push({ tex: t, fb: framebuffer(gl, [t]), w: nw, h: nh, sw: w, sh: h });
      w = nw; h = nh;
    }
    this.vao = gl.createVertexArray();
    this.setSolid(new Uint8Array(nx * ny * nz));
    this.reset();
  }

  get fCurrent() { return this.cur === 'A' ? this.fA : this.fB; }

  /** Upload a solid mask (1 = body, 2 = ground) indexed x + nx*(y + ny*z). */
  setSolid(solid) {
    const { gl, nx, ny, nz, width, tx } = this;
    const atlas = new Uint8Array(this.width * this.height);
    for (let z = 0; z < nz; z++) {
      const ox = (z % tx) * nx, oy = Math.floor(z / tx) * ny;
      for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
        const v = solid[x + nx * (y + ny * z)];
        atlas[ox + x + width * (oy + y)] = v === 1 ? 255 : v ? 128 : 0;
      }
    }
    gl.bindTexture(gl.TEXTURE_2D, this.mask);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.width, this.height, gl.RED, gl.UNSIGNED_BYTE, atlas);
  }

  inletVelocity() {
    const s = this.ramp > 0 ? Math.min(1, this.time / this.ramp) : 1;
    return this.uIn.map((v) => v * s);
  }

  _common(p) {
    const gl = this.gl;
    gl.uniform3i(p.u.uN, this.nx, this.ny, this.nz);
    gl.uniform1i(p.u.uTX, this.tx);
  }

  /** Restart from a uniform flow (at the current, possibly ramped, inlet speed). */
  reset({ restartRamp = true } = {}) {
    const gl = this.gl;
    if (restartRamp) this.time = 0;
    const p = this.initProg;
    gl.useProgram(p.prog);
    this._common(p);
    gl.uniform3fv(p.u.uU, this.inletVelocity());
    bindTextures(gl, p, [['uMask', this.mask]]);
    this._drawInto(this.cur === 'A' ? this.fbA : this.fbB);
  }

  _drawInto(fb) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.drawBuffers(this.drawBuffers);
    gl.viewport(0, 0, this.width, this.height);
    gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  step(n = 1) {
    const gl = this.gl;
    const p = this.stepProg;
    gl.useProgram(p.prog);
    this._common(p);
    gl.uniform1f(p.u.uTau, this.tau);
    gl.uniform1f(p.u.uCs, this.cs);
    gl.uniform1f(p.u.uSpongeTau, this.spongeTau);
    gl.uniform1i(p.u.uSponge, this.sponge);
    gl.uniform1i(p.u.uSpongeStart, this.nx - this.sponge);
    for (let k = 0; k < n; k++) {
      const uin = this.inletVelocity();
      gl.uniform3fv(p.u.uUin, uin);
      gl.uniform3fv(p.u.uGround, this.movingGround ? uin : [0, 0, 0]);
      const src = this.fCurrent;
      bindTextures(gl, p, [['uF0', src[0]], ['uF1', src[1]], ['uF2', src[2]], ['uF3', src[3]], ['uF4', src[4]], ['uMask', this.mask]]);
      this._drawInto(this.cur === 'A' ? this.fbB : this.fbA);
      this.cur = this.cur === 'A' ? 'B' : 'A';
      this.time++;
    }
  }

  /** Total momentum-exchange force on all solids from the last step. */
  totalForce() {
    const gl = this.gl;
    const p = this.reduceProg;
    gl.useProgram(p.prog);
    gl.bindVertexArray(this.vao);
    let src = this.forceTex;
    for (const r of this.reduce) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, r.fb);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
      gl.viewport(0, 0, r.w, r.h);
      bindTextures(gl, p, [['uSrc', src]]);
      gl.uniform2i(p.u.uSrcSize, r.sw, r.sh);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      src = r.tex;
    }
    const out = new Float32Array(4);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, out);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return [out[0], out[1], out[2]];
  }

  /** Read an atlas texture back as a Float32Array (RGBA per texel). */
  readAtlas(tex) {
    const gl = this.gl;
    const fb = framebuffer(gl, [tex]);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    const out = new Float32Array(this.width * this.height * 4);
    gl.readPixels(0, 0, this.width, this.height, gl.RGBA, gl.FLOAT, out);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fb);
    return out;
  }

  /** Macroscopic fields as {rho, ux, uy, uz} Float32Arrays in x + nx*(y + ny*z) order. */
  readMacros() {
    const a = this.readAtlas(this.macro);
    const { nx, ny, nz, tx, width } = this;
    const n = nx * ny * nz;
    const r = { rho: new Float32Array(n), ux: new Float32Array(n), uy: new Float32Array(n), uz: new Float32Array(n) };
    for (let z = 0; z < nz; z++) {
      const ox = (z % tx) * nx, oy = Math.floor(z / tx) * ny;
      for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
        const k = x + nx * (y + ny * z), t = 4 * (ox + x + width * (oy + y));
        r.ux[k] = a[t]; r.uy[k] = a[t + 1]; r.uz[k] = a[t + 2]; r.rho[k] = a[t + 3];
      }
    }
    return r;
  }
}
