// Drag on a sphere vs. the Schiller-Naumann correlation, using the same scheme
// and settings as the web app (CPU reference solver, which matches the GPU
// shader to ~1e-6).
//
//   node scripts/validate-sphere.js --re 100 --d 12 --steps 3500
//
// Prints one JSON line: Cd (time-averaged over the last third of the run),
// the correlation value, and a blockage-corrected Cd.

import { LBMSolver } from '../docs/js/lbm-cpu.js';
import { voxelize, PRESETS } from '../docs/js/shapes.js';
import { tauFromViscosity } from '../docs/js/lattice.js';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? +process.argv[i + 1] : d; };
const Re = arg('re', 100), D = arg('d', 12), steps = arg('steps', 3500);
const nx = arg('nx', 96), ny = arg('ny', 48), nz = arg('nz', 48);
const cs = arg('cs', 0.17);
const U = 0.07;

const grid = { nx, ny, nz };
const body = voxelize(PRESETS.sphere, grid, { center: [nx / 3, (ny - 1) / 2, (nz - 1) / 2], length: D });
const tau = tauFromViscosity((U * D) / Re);
const s = new LBMSolver({ ...grid, tau, solid: body.solid, uIn: [U, 0, 0], smagorinsky: cs, sponge: Math.round(nx * 0.12), spongeTau: 1, ramp: 400 });

const A = body.frontalArea;
const samples = [];
for (let t = 0; t < steps; t++) {
  s.step();
  if (t >= (2 * steps) / 3) samples.push(s.bodyForce[0] / (0.5 * U * U * A));
}
const cd = samples.reduce((a, b) => a + b, 0) / samples.length;
const sn = (24 / Re) * (1 + 0.15 * Re ** 0.687);
// First-order solid blockage correction: the air speeds up by about A / A_tunnel
// as it squeezes past the body, so Cd_free ~ Cd (1 - A / A_tunnel)^2.
const ratio = A / (ny * nz);
const cdCorrected = cd * (1 - ratio) ** 2;
console.log(JSON.stringify({ Re, D, grid: `${nx}x${ny}x${nz}`, steps, tau: +tau.toFixed(4), smagorinsky: cs,
  frontalArea: A, blockage: +ratio.toFixed(4), cd: +cd.toFixed(3), cdCorrected: +cdCorrected.toFixed(3),
  schillerNaumann: +sn.toFixed(3), error: +((cdCorrected - sn) / sn).toFixed(3) }));
