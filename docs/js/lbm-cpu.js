// Reference D3Q19 lattice Boltzmann solver in plain JavaScript (Float64).
//
// It implements exactly the same scheme as the GPU solver (pull streaming,
// halfway bounce-back, free-slip tunnel walls, equilibrium inlet,
// zero-gradient outlet, BGK + Smagorinsky collision, outlet sponge), so the
// GPU result can be checked against it. It also supports periodic boxes and a
// Guo body force, which the validation tests use.

import {
  C, Q, W, OPP, REFL_Y, REFL_Z, REFL_YZ, feq, smagorinskyTau,
} from './lattice.js';

export class LBMSolver {
  /**
   * @param {object} o
   * @param {number} o.nx, o.ny, o.nz  grid size
   * @param {number} o.tau             BGK relaxation time (> 0.5)
   * @param {'tunnel'|'periodic'} [o.boundary='tunnel']
   * @param {number[]} [o.uIn=[0.05,0,0]] inlet velocity (tunnel only)
   * @param {number} [o.smagorinsky=0]  Smagorinsky constant Cs (0 = off)
   * @param {number} [o.sponge=0]       outlet sponge length in cells
   * @param {number} [o.spongeTau=1]    relaxation time at the very end of the sponge
   * @param {number} [o.ramp=0]         steps over which the inlet ramps up
   * @param {number[]} [o.force=[0,0,0]] uniform body force density (Guo scheme)
   * @param {Uint8Array} [o.solid]      1 = solid node, indexed x + nx*(y + ny*z)
   */
  constructor(o) {
    this.nx = o.nx; this.ny = o.ny; this.nz = o.nz;
    this.n = this.nx * this.ny * this.nz;
    this.tau = o.tau;
    this.boundary = o.boundary ?? 'tunnel';
    this.uIn = o.uIn ?? [0.05, 0, 0];
    this.cs = o.smagorinsky ?? 0;
    this.sponge = o.sponge ?? 0;
    this.spongeTau = o.spongeTau ?? 1;
    this.ramp = o.ramp ?? 0;
    this.force = o.force ?? [0, 0, 0];
    this.solid = o.solid ?? new Uint8Array(this.n);
    this.f = new Float64Array(Q * this.n);
    this.g = new Float64Array(Q * this.n);
    this.rho = new Float64Array(this.n);
    this.ux = new Float64Array(this.n);
    this.uy = new Float64Array(this.n);
    this.uz = new Float64Array(this.n);
    this.bodyForce = [0, 0, 0]; // force exerted by the fluid on solids, last step
    this.time = 0;
    this.initUniform(this.boundary === 'tunnel' ? this.inletVelocity() : [0, 0, 0]);
  }

  idx(x, y, z) { return x + this.nx * (y + this.ny * z); }

  inletVelocity() {
    const s = this.ramp > 0 ? Math.min(1, this.time / this.ramp) : 1;
    return [this.uIn[0] * s, this.uIn[1] * s, this.uIn[2] * s];
  }

  /** Fill every fluid node with equilibrium at rho = 1 and velocity u. */
  initUniform(u) {
    for (let k = 0; k < this.n; k++) {
      const s = this.solid[k];
      for (let i = 0; i < Q; i++) {
        this.f[i * this.n + k] = s ? W[i] : feq(i, 1, u[0], u[1], u[2]);
      }
    }
    this.computeMacros();
  }

  /** Set populations from a velocity/density field given per node. */
  initFromField(fn) {
    for (let z = 0; z < this.nz; z++) for (let y = 0; y < this.ny; y++) for (let x = 0; x < this.nx; x++) {
      const k = this.idx(x, y, z);
      const [rho, ux, uy, uz] = fn(x, y, z);
      for (let i = 0; i < Q; i++) this.f[i * this.n + k] = this.solid[k] ? W[i] : feq(i, rho, ux, uy, uz);
    }
    this.computeMacros();
  }

  computeMacros() {
    const { n, f } = this;
    for (let k = 0; k < n; k++) {
      let r = 0, mx = 0, my = 0, mz = 0;
      for (let i = 0; i < Q; i++) {
        const v = f[i * n + k];
        r += v; mx += C[i][0] * v; my += C[i][1] * v; mz += C[i][2] * v;
      }
      this.rho[k] = r;
      // Guo: physical velocity includes half the force impulse.
      this.ux[k] = (mx + 0.5 * this.force[0]) / r;
      this.uy[k] = (my + 0.5 * this.force[1]) / r;
      this.uz[k] = (mz + 0.5 * this.force[2]) / r;
      if (this.solid[k]) { this.ux[k] = this.uy[k] = this.uz[k] = 0; }
    }
  }

  /** Total mass in fluid nodes. */
  mass() {
    let m = 0;
    for (let k = 0; k < this.n; k++) if (!this.solid[k]) m += this.rho[k];
    return m;
  }

  /** Advance one time step: stream (pull) + collide. */
  step() {
    const { nx, ny, nz, n, f, g, solid } = this;
    const periodic = this.boundary === 'periodic';
    const [Fx, Fy, Fz] = this.force;
    const hasForce = Fx !== 0 || Fy !== 0 || Fz !== 0;
    const uin = this.inletVelocity();
    const spongeStart = nx - this.sponge;
    const fi = new Float64Array(Q);
    let bfx = 0, bfy = 0, bfz = 0;

    for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      const k = x + nx * (y + ny * z);
      if (solid[k]) {
        for (let i = 0; i < Q; i++) g[i * n + k] = W[i];
        continue;
      }
      // ---- streaming (pull) with boundary handling ----
      for (let i = 0; i < Q; i++) {
        const c = C[i];
        let sx = x - c[0], sy = y - c[1], sz = z - c[2];
        let d = i;
        if (periodic) {
          sx = (sx + nx) % nx; sy = (sy + ny) % ny; sz = (sz + nz) % nz;
        } else {
          const oy = sy < 0 || sy >= ny;
          const oz = sz < 0 || sz >= nz;
          if (oy) sy = y;
          if (oz) sz = z;
          if (oy && oz) d = REFL_YZ[i]; else if (oy) d = REFL_Y[i]; else if (oz) d = REFL_Z[i];
          sx = sx < 0 ? 0 : sx >= nx ? nx - 1 : sx;
        }
        const ks = sx + nx * (sy + ny * sz);
        if (solid[ks]) {
          // Halfway bounce-back: the population that left toward the wall returns reversed.
          const o = OPP[i];
          const v = f[o * n + k];
          fi[i] = v;
          // Momentum exchange: the fluid gives 2 c_o f_o to the solid.
          bfx += 2 * C[o][0] * v; bfy += 2 * C[o][1] * v; bfz += 2 * C[o][2] * v;
        } else {
          fi[i] = f[d * n + ks];
        }
      }

      // ---- inlet: impose equilibrium at the free-stream velocity ----
      if (!periodic && x === 0) {
        for (let i = 0; i < Q; i++) g[i * n + k] = feq(i, 1, uin[0], uin[1], uin[2]);
        continue;
      }

      // ---- macroscopic moments ----
      let rho = 0, mx = 0, my = 0, mz = 0;
      for (let i = 0; i < Q; i++) {
        const v = fi[i];
        rho += v; mx += C[i][0] * v; my += C[i][1] * v; mz += C[i][2] * v;
      }
      const ux = (mx + 0.5 * Fx) / rho, uy = (my + 0.5 * Fy) / rho, uz = (mz + 0.5 * Fz) / rho;

      // ---- relaxation time: sponge + Smagorinsky ----
      let tau = this.tau;
      if (!periodic && this.sponge > 0 && x >= spongeStart) {
        const s = (x - spongeStart + 1) / this.sponge;
        tau += (this.spongeTau - this.tau) * s * s;
      }
      if (this.cs > 0) {
        let pxx = 0, pyy = 0, pzz = 0, pxy = 0, pxz = 0, pyz = 0;
        for (let i = 0; i < Q; i++) {
          const ne = fi[i] - feq(i, rho, ux, uy, uz);
          const c = C[i];
          pxx += c[0] * c[0] * ne; pyy += c[1] * c[1] * ne; pzz += c[2] * c[2] * ne;
          pxy += c[0] * c[1] * ne; pxz += c[0] * c[2] * ne; pyz += c[1] * c[2] * ne;
        }
        const pn = Math.sqrt(pxx * pxx + pyy * pyy + pzz * pzz + 2 * (pxy * pxy + pxz * pxz + pyz * pyz));
        tau = smagorinskyTau(tau, this.cs, pn, rho);
      }

      // ---- BGK collision (+ Guo forcing) ----
      const om = 1 / tau;
      for (let i = 0; i < Q; i++) {
        let v = fi[i] - om * (fi[i] - feq(i, rho, ux, uy, uz));
        if (hasForce) {
          const c = C[i];
          const cu = c[0] * ux + c[1] * uy + c[2] * uz;
          const gx = 3 * (c[0] - ux) + 9 * cu * c[0];
          const gy = 3 * (c[1] - uy) + 9 * cu * c[1];
          const gz = 3 * (c[2] - uz) + 9 * cu * c[2];
          v += (1 - 0.5 * om) * W[i] * (gx * Fx + gy * Fy + gz * Fz);
        }
        g[i * n + k] = v;
      }
    }

    this.f = g; this.g = f;
    this.bodyForce = [bfx, bfy, bfz];
    this.time++;
    this.computeMacros();
  }

  run(steps) { for (let s = 0; s < steps; s++) this.step(); }
}
