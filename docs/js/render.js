// Drawing the tunnel: the body (coloured by surface pressure), a slice through
// the flow, and smoke streaks advected through the live velocity field.
//
// Everything reads the solver's macroscopic atlas (ux, uy, uz, rho) directly
// on the GPU, so nothing is copied back to the CPU per frame.

import { ATLAS_GLSL } from './gpu-solver.js';
import { program, texture, framebuffer, FULLSCREEN_VS, bindTextures } from './gl-util.js';

const FIELD_GLSL = `${ATLAS_GLSL}
uniform highp sampler2D uMacro;
uniform highp sampler2D uMask;
vec4 fetchM(ivec3 p) { p = clamp(p, ivec3(0), uN - 1); return texelFetch(uMacro, toAtlas(p), 0); }
// Trilinear interpolation of (ux, uy, uz, rho) at a continuous lattice position.
vec4 sampleM(vec3 q) {
  q = clamp(q, vec3(0.0), vec3(uN - 1));
  ivec3 i = min(ivec3(floor(q)), uN - 2);
  vec3 f = q - vec3(i);
  vec4 c000 = fetchM(i), c100 = fetchM(i + ivec3(1, 0, 0));
  vec4 c010 = fetchM(i + ivec3(0, 1, 0)), c110 = fetchM(i + ivec3(1, 1, 0));
  vec4 c001 = fetchM(i + ivec3(0, 0, 1)), c101 = fetchM(i + ivec3(1, 0, 1));
  vec4 c011 = fetchM(i + ivec3(0, 1, 1)), c111 = fetchM(i + ivec3(1, 1, 1));
  return mix(mix(mix(c000, c100, f.x), mix(c010, c110, f.x), f.y),
             mix(mix(c001, c101, f.x), mix(c011, c111, f.x), f.y), f.z);
}
float maskAt(vec3 q) {
  ivec3 i = clamp(ivec3(floor(q + 0.5)), ivec3(0), uN - 1);
  return texelFetch(uMask, toAtlas(i), 0).r;
}
// Smooth signed distance to the body (cells, negative inside), trilinear.
uniform highp sampler2D uSDF;
float fetchS(ivec3 p) { p = clamp(p, ivec3(0), uN - 1); return texelFetch(uSDF, toAtlas(p), 0).r; }
float sdfAt(vec3 q) {
  q = clamp(q, vec3(0.0), vec3(uN - 1));
  ivec3 i = min(ivec3(floor(q)), uN - 2);
  vec3 f = q - vec3(i);
  return mix(mix(mix(fetchS(i), fetchS(i + ivec3(1, 0, 0)), f.x), mix(fetchS(i + ivec3(0, 1, 0)), fetchS(i + ivec3(1, 1, 0)), f.x), f.y),
             mix(mix(fetchS(i + ivec3(0, 0, 1)), fetchS(i + ivec3(1, 0, 1)), f.x), mix(fetchS(i + ivec3(0, 1, 1)), fetchS(i + ivec3(1, 1, 1)), f.x), f.y), f.z);
}`;

const COLOR_GLSL = `
// Sequential: tunnel steel -> teal -> pale ice -> warm white.
vec3 seqMap(float t) {
  t = clamp(t, 0.0, 1.0);
  vec3 a = vec3(0.10, 0.16, 0.24), b = vec3(0.09, 0.42, 0.52), c = vec3(0.55, 0.82, 0.84), d = vec3(1.0, 0.95, 0.80);
  return t < 0.4 ? mix(a, b, t / 0.4) : t < 0.75 ? mix(b, c, (t - 0.4) / 0.35) : mix(c, d, (t - 0.75) / 0.25);
}
// Diverging: blue (suction, negative) -> paper -> orange (pressure, positive).
vec3 divMap(float t) {
  t = clamp(t, -1.0, 1.0);
  vec3 neg = vec3(0.16, 0.42, 0.72), mid = vec3(0.91, 0.93, 0.94), pos = vec3(0.87, 0.42, 0.13);
  return t < 0.0 ? mix(mid, neg, -t) : mix(mid, pos, t);
}`;

const HEADER = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
`;

// ------------------------------------------------------------------ body mesh
const MESH_VS = `${HEADER}${FIELD_GLSL}
in vec3 aPos;
in vec3 aNor;
uniform mat4 uViewProj;
uniform float uU;
out vec3 vNor;
out vec3 vPos;
out float vCp;
void main() {
  // Pressure coefficient just outside the wall: Cp = (p - p_inf) / (rho U^2 / 2), p = rho / 3.
  vec4 m = sampleM(aPos + aNor * 1.2);
  vCp = (m.w - 1.0) / 3.0 / (0.5 * uU * uU);
  vNor = aNor;
  vPos = aPos;
  gl_Position = uViewProj * vec4(aPos, 1.0);
}`;

const MESH_FS = `${HEADER}${COLOR_GLSL}
in vec3 vNor;
in vec3 vPos;
in float vCp;
uniform int uColorMode;
uniform vec3 uEye;
out vec4 o;
void main() {
  vec3 n = normalize(vNor);
  vec3 v = normalize(uEye - vPos);
  if (dot(n, v) < 0.0) n = -n;
  vec3 base = uColorMode == 1 ? divMap(vCp / 1.0) : vec3(0.78, 0.76, 0.72);
  vec3 L = normalize(vec3(-0.35, 0.85, 0.45));
  float diff = max(dot(n, L), 0.0);
  float hemi = 0.5 + 0.5 * n.y;
  float spec = pow(max(dot(reflect(-L, n), v), 0.0), 32.0) * 0.25;
  float rim = pow(1.0 - max(dot(n, v), 0.0), 3.0) * 0.25;
  vec3 c = base * (0.30 + 0.25 * hemi + 0.60 * diff) + spec + rim * vec3(0.6, 0.75, 0.85);
  o = vec4(c, 1.0);
}`;

// ------------------------------------------------------------------ slice plane
const SLICE_VS = `${HEADER}${ATLAS_GLSL}
uniform mat4 uViewProj;
uniform int uAxis;     // 0: x = const (cross-flow), 1: y = const (plan), 2: z = const (side)
uniform float uPos;
out vec3 vQ;
void main() {
  int k = gl_VertexID;
  vec2 c = vec2(k == 1 || k == 2 || k == 4 ? 1.0 : 0.0, k == 2 || k == 4 || k == 5 ? 1.0 : 0.0);
  vec3 hi = vec3(uN - 1);
  vec3 q;
  if (uAxis == 0) q = vec3(uPos, c.x * hi.y, c.y * hi.z);
  else if (uAxis == 1) q = vec3(c.x * hi.x, uPos, c.y * hi.z);
  else q = vec3(c.x * hi.x, c.y * hi.y, uPos);
  vQ = q;
  gl_Position = uViewProj * vec4(q, 1.0);
}`;

const SLICE_FS = `${HEADER}${FIELD_GLSL}${COLOR_GLSL}
in vec3 vQ;
uniform int uField;    // 0 speed, 1 pressure, 2 vorticity
uniform float uU, uL;
out vec4 o;
void main() {
  if (sdfAt(vQ) < 0.0) discard;
  vec3 c;
  if (uField == 0) {
    vec4 m = sampleM(vQ);
    c = seqMap(length(m.xyz) / (1.45 * uU));
    if (m.x < -0.03 * uU) c = mix(c, vec3(0.62, 0.36, 0.78), 0.55); // reversed flow
  } else if (uField == 1) {
    vec4 m = sampleM(vQ);
    c = divMap((m.w - 1.0) / 3.0 / (0.5 * uU * uU));
  } else {
    vec4 xp = sampleM(vQ + vec3(1, 0, 0)), xm = sampleM(vQ - vec3(1, 0, 0));
    vec4 yp = sampleM(vQ + vec3(0, 1, 0)), ym = sampleM(vQ - vec3(0, 1, 0));
    vec4 zp = sampleM(vQ + vec3(0, 0, 1)), zm = sampleM(vQ - vec3(0, 0, 1));
    vec3 w = 0.5 * vec3((yp.z - ym.z) - (zp.y - zm.y), (zp.x - zm.x) - (xp.z - xm.z), (xp.y - xm.y) - (yp.x - ym.x));
    c = seqMap(length(w) * uL / uU / 12.0);
  }
  o = vec4(c, 1.0);
}`;

// ------------------------------------------------------------------ smoke
const HASH_GLSL = `
float hash(uint x) {
  x ^= x >> 16; x *= 0x7feb352du; x ^= x >> 15; x *= 0x846ca68bu; x ^= x >> 16;
  return float(x) / 4294967295.0;
}`;

const SMOKE_UPDATE_FS = `${HEADER}${FIELD_GLSL}${HASH_GLSL}
uniform sampler2D uState;
uniform float uSteps, uLife;
uniform uint uFrame;
uniform vec2 uRakeMin, uRakeMax;
uniform ivec2 uRakeCount;
out vec4 o;
vec3 emitter(uint id) {
  int streams = uRakeCount.x * uRakeCount.y;
  int s = int(id % uint(streams));
  vec2 g = (vec2(s % uRakeCount.x, s / uRakeCount.x) + 0.5) / vec2(uRakeCount);
  return vec3(1.0, mix(uRakeMin, uRakeMax, g));
}
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  uint id = uint(t.x + t.y * textureSize(uState, 0).x);
  vec4 s = texelFetch(uState, t, 0);
  vec3 p = s.xyz;
  float age = s.w;
  if (uSteps > 0.0) {
    // Midpoint (RK2) step through the trilinearly interpolated velocity field.
    vec3 u1 = sampleM(p).xyz;
    vec3 u2 = sampleM(p + 0.5 * uSteps * u1).xyz;
    p += uSteps * u2;
    age += uSteps;
  }
  vec3 hi = vec3(uN - 1);
  bool dead = p.x > hi.x - 1.0 || p.x < 0.0 || p.y < 0.0 || p.y > hi.y || p.z < 0.0 || p.z > hi.z
           || sdfAt(p) < 0.3 || maskAt(p) > 0.25 || age > uLife * (0.7 + 0.3 * hash(id * 7u + 3u));
  if (dead) {
    p = emitter(id);
    p.x += hash(id ^ (uFrame * 2654435761u)) * max(uSteps, 1.0) * 0.08;
    age = 0.0;
  }
  o = vec4(p, age);
}`;

const SMOKE_VS = `${HEADER}${FIELD_GLSL}
uniform sampler2D uState;
uniform mat4 uViewProj;
uniform float uU, uStreak, uAlpha;
out vec4 vColor;
void main() {
  int id = gl_VertexID / 2, end = gl_VertexID % 2;
  int w = textureSize(uState, 0).x;
  vec4 s = texelFetch(uState, ivec2(id % w, id / w), 0);
  vec3 u = sampleM(s.xyz).xyz;
  vec3 p = s.xyz - float(end) * u * uStreak;
  float sp = length(u) / uU;
  // Slow smoke glows warm, fast smoke is cold white-blue.
  vec3 c = mix(vec3(1.0, 0.72, 0.38), vec3(0.80, 0.92, 1.0), clamp(sp - 0.3, 0.0, 1.0));
  float fade = clamp(s.w / 60.0, 0.0, 1.0) * (end == 1 ? 0.15 : 1.0);
  vColor = vec4(c, uAlpha * fade);
  gl_Position = uViewProj * vec4(p, 1.0);
}`;

const SMOKE_FS = `${HEADER}
in vec4 vColor;
out vec4 o;
void main() { o = vColor; }`;

// ------------------------------------------------------------------ tunnel
const FLOOR_VS = `${HEADER}${ATLAS_GLSL}
uniform mat4 uViewProj;
out vec2 vXZ;
void main() {
  int k = gl_VertexID;
  vec2 c = vec2(k == 1 || k == 2 || k == 4 ? 1.0 : 0.0, k == 2 || k == 4 || k == 5 ? 1.0 : 0.0);
  vec3 q = vec3(c.x * float(uN.x - 1), 0.5, c.y * float(uN.z - 1));
  vXZ = q.xz;
  gl_Position = uViewProj * vec4(q, 1.0);
}`;

const FLOOR_FS = `${HEADER}
in vec2 vXZ;
uniform float uBelt;     // belt travel in cells, or < 0 for a fixed floor
out vec4 o;
void main() {
  vec3 c = vec3(0.13, 0.18, 0.23);
  vec2 g = abs(fract(vXZ / 8.0 + 0.5) - 0.5) * 8.0;
  float line = 1.0 - smoothstep(0.0, 0.12, min(g.x, g.y));
  c += line * 0.05;
  if (uBelt >= 0.0) {
    float stripe = step(0.5, fract((vXZ.x - uBelt) / 12.0));
    c = mix(vec3(0.17, 0.19, 0.21), vec3(0.22, 0.24, 0.26), stripe);
  }
  o = vec4(c, 1.0);
}`;

const LINE_VS = `${HEADER}
in vec3 aPos;
uniform mat4 uViewProj;
void main() { gl_Position = uViewProj * vec4(aPos, 1.0); }`;
const LINE_FS = `${HEADER}
uniform vec4 uColor;
out vec4 o;
void main() { o = uColor; }`;

export class Renderer {
  constructor(gl, solver, { particles = 65536 } = {}) {
    this.gl = gl;
    this.solver = solver;
    this.meshProg = program(gl, MESH_VS, MESH_FS);
    this.sliceProg = program(gl, SLICE_VS, SLICE_FS);
    this.smokeUpdate = program(gl, FULLSCREEN_VS, SMOKE_UPDATE_FS);
    this.smokeProg = program(gl, SMOKE_VS, SMOKE_FS);
    this.floorProg = program(gl, FLOOR_VS, FLOOR_FS);
    this.lineProg = program(gl, LINE_VS, LINE_FS);
    this.emptyVao = gl.createVertexArray();
    this.frame = 0;

    // Particle state: two RGBA32F textures (position, age), ping-ponged.
    this.pw = 256;
    this.ph = Math.ceil(particles / this.pw);
    this.np = this.pw * this.ph;
    this.state = [texture(gl, this.pw, this.ph), texture(gl, this.pw, this.ph)];
    this.stateFb = this.state.map((t) => framebuffer(gl, [t]));
    this.cur = 0;

    // Tunnel edges.
    const { nx, ny, nz } = solver;
    const X = nx - 1, Y = ny - 1, Z = nz - 1;
    const P = [[0, 0, 0], [X, 0, 0], [X, Y, 0], [0, Y, 0], [0, 0, Z], [X, 0, Z], [X, Y, Z], [0, Y, Z]];
    const E = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
    this.edgeVao = gl.createVertexArray();
    gl.bindVertexArray(this.edgeVao);
    const eb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, eb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(E.flatMap(([a, b]) => [...P[a], ...P[b]])), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(this.lineProg.prog, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 3, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    this.edgeCount = E.length * 2;

    this.mesh = null;
    this.sdf = texture(gl, solver.width, solver.height, { internal: gl.R32F, format: gl.RED });
  }

  /** Upload the body's signed distance field (cells) into an atlas texture. */
  setField(field) {
    const { gl, solver: s } = this;
    const atlas = new Float32Array(s.width * s.height).fill(1e3);
    for (let z = 0; z < s.nz; z++) {
      const ox = (z % s.tx) * s.nx, oy = Math.floor(z / s.tx) * s.ny;
      for (let y = 0; y < s.ny; y++) {
        const row = (oy + y) * s.width + ox, src = s.nx * (y + s.ny * z);
        atlas.set(field.subarray(src, src + s.nx), row);
      }
    }
    gl.bindTexture(gl.TEXTURE_2D, this.sdf);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, s.width, s.height, gl.RED, gl.FLOAT, atlas);
  }

  /** Upload the body surface (lattice-unit positions and normals). */
  setMesh({ positions, normals, indices }) {
    const gl = this.gl;
    if (!this.mesh) {
      this.mesh = { vao: gl.createVertexArray(), pos: gl.createBuffer(), nor: gl.createBuffer(), idx: gl.createBuffer() };
    }
    const m = this.mesh;
    const p = this.meshProg.prog;
    gl.bindVertexArray(m.vao);
    const posLoc = gl.getAttribLocation(p, 'aPos'), norLoc = gl.getAttribLocation(p, 'aNor');
    gl.bindBuffer(gl.ARRAY_BUFFER, m.pos);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, m.nor);
    gl.bufferData(gl.ARRAY_BUFFER, normals, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(norLoc);
    gl.vertexAttribPointer(norLoc, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, m.idx);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    m.count = indices.length;
    gl.bindVertexArray(null);
  }

  /**
   * Re-seed the smoke. The rake is a grid of emitters on the inlet plane,
   * spanning [yz0, yz1] with count = [ny, nz] streams.
   */
  setRake({ min, max, count }) {
    this.rake = { min, max, count };
    const { nx } = this.solver;
    const data = new Float32Array(this.np * 4);
    const streams = count[0] * count[1];
    for (let id = 0; id < this.np; id++) {
      const s = id % streams;
      const gy = ((s % count[0]) + 0.5) / count[0], gz = (Math.floor(s / count[0]) + 0.5) / count[1];
      data[4 * id] = 1 + Math.random() * (nx - 3);
      data[4 * id + 1] = min[0] + gy * (max[0] - min[0]);
      data[4 * id + 2] = min[1] + gz * (max[1] - min[1]);
      data[4 * id + 3] = 60 + Math.random() * 1000;
    }
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.state[this.cur]);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.pw, this.ph, gl.RGBA, gl.FLOAT, data);
  }

  _field(p) {
    const gl = this.gl, s = this.solver;
    gl.uniform3i(p.u.uN, s.nx, s.ny, s.nz);
    gl.uniform1i(p.u.uTX, s.tx);
  }

  /** Advance smoke by `steps` lattice time steps through the current field. */
  advectSmoke(steps) {
    if (!this.rake) return;
    const gl = this.gl, s = this.solver, p = this.smokeUpdate;
    gl.useProgram(p.prog);
    this._field(p);
    bindTextures(gl, p, [['uMacro', s.macro], ['uMask', s.mask], ['uState', this.state[this.cur]], ['uSDF', this.sdf]]);
    gl.uniform1f(p.u.uSteps, steps);
    gl.uniform1f(p.u.uLife, (s.nx * 2.2) / Math.max(1e-3, Math.hypot(...s.uIn)));
    gl.uniform1ui(p.u.uFrame, this.frame++);
    gl.uniform2fv(p.u.uRakeMin, this.rake.min);
    gl.uniform2fv(p.u.uRakeMax, this.rake.max);
    gl.uniform2i(p.u.uRakeCount, this.rake.count[0], this.rake.count[1]);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.stateFb[1 - this.cur]);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    gl.viewport(0, 0, this.pw, this.ph);
    gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST);
    gl.bindVertexArray(this.emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.cur = 1 - this.cur;
  }

  /**
   * @param cam  {viewProj, eye}
   * @param o    {width, height, U, L, bodyColor: 'clay'|'pressure', slice: {field, axis, pos}|null,
   *              smoke: bool, ground: bool, belt: number}
   */
  render(cam, o) {
    const gl = this.gl, s = this.solver;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, o.width, o.height);
    gl.clearColor(0.122, 0.165, 0.208, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    const U = Math.max(o.U, 1e-3);

    // Floor.
    let p = this.floorProg;
    gl.useProgram(p.prog);
    this._field(p);
    gl.uniformMatrix4fv(p.u.uViewProj, false, cam.viewProj);
    gl.uniform1f(p.u.uBelt, o.ground ? o.belt : -1);
    gl.bindVertexArray(this.emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // Body.
    if (this.mesh && this.mesh.count) {
      p = this.meshProg;
      gl.useProgram(p.prog);
      this._field(p);
      bindTextures(gl, p, [['uMacro', s.macro], ['uMask', s.mask]]);
      gl.uniformMatrix4fv(p.u.uViewProj, false, cam.viewProj);
      gl.uniform3fv(p.u.uEye, cam.eye);
      gl.uniform1f(p.u.uU, U);
      gl.uniform1i(p.u.uColorMode, o.bodyColor === 'pressure' ? 1 : 0);
      gl.bindVertexArray(this.mesh.vao);
      gl.drawElements(gl.TRIANGLES, this.mesh.count, gl.UNSIGNED_INT, 0);
    }

    // Slice.
    if (o.slice) {
      p = this.sliceProg;
      gl.useProgram(p.prog);
      this._field(p);
      bindTextures(gl, p, [['uMacro', s.macro], ['uMask', s.mask], ['uSDF', this.sdf]]);
      gl.uniformMatrix4fv(p.u.uViewProj, false, cam.viewProj);
      gl.uniform1i(p.u.uAxis, o.slice.axis);
      gl.uniform1f(p.u.uPos, o.slice.pos);
      gl.uniform1i(p.u.uField, o.slice.field);
      gl.uniform1f(p.u.uU, U);
      gl.uniform1f(p.u.uL, o.L);
      gl.bindVertexArray(this.emptyVao);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    // Tunnel edges.
    p = this.lineProg;
    gl.useProgram(p.prog);
    gl.uniformMatrix4fv(p.u.uViewProj, false, cam.viewProj);
    gl.uniform4f(p.u.uColor, 0.45, 0.55, 0.62, 1);
    gl.bindVertexArray(this.edgeVao);
    gl.drawArrays(gl.LINES, 0, this.edgeCount);

    // Smoke: additive streaks, depth-tested but not depth-writing.
    if (o.smoke && this.rake) {
      p = this.smokeProg;
      gl.useProgram(p.prog);
      this._field(p);
      bindTextures(gl, p, [['uMacro', s.macro], ['uMask', s.mask], ['uState', this.state[this.cur]]]);
      gl.uniformMatrix4fv(p.u.uViewProj, false, cam.viewProj);
      gl.uniform1f(p.u.uU, U);
      gl.uniform1f(p.u.uStreak, 1.6 / U);
      gl.uniform1f(p.u.uAlpha, o.smokeAlpha ?? 0.55);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
      gl.depthMask(false);
      gl.bindVertexArray(this.emptyVao);
      gl.drawArrays(gl.LINES, 0, this.np * 2);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
    }
    gl.bindVertexArray(null);
  }
}
