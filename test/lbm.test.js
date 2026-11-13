// Physics validation of the reference solver against analytic results.
import test from 'node:test';
import assert from 'node:assert/strict';
import { LBMSolver } from '../docs/js/lbm-cpu.js';
import { viscosity } from '../docs/js/lattice.js';

test('mass is conserved exactly in a periodic box with an obstacle', () => {
  const nx = 12, ny = 10, nz = 8;
  const solid = new Uint8Array(nx * ny * nz);
  for (let z = 3; z < 5; z++) for (let y = 3; y < 6; y++) for (let x = 4; x < 7; x++) solid[x + nx * (y + ny * z)] = 1;
  const s = new LBMSolver({ nx, ny, nz, tau: 0.7, boundary: 'periodic', solid, smagorinsky: 0.15 });
  let seed = 1;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5);
  s.initFromField(() => [1 + 0.01 * rnd(), 0.03 * rnd(), 0.03 * rnd(), 0.03 * rnd()]);
  const m0 = s.mass();
  s.run(200);
  assert.ok(Math.abs(s.mass() - m0) / m0 < 1e-12, `mass drift ${s.mass() - m0}`);
});

test('uniform free stream is an exact steady state of the empty tunnel', () => {
  const s = new LBMSolver({ nx: 16, ny: 8, nz: 8, tau: 0.6, uIn: [0.08, 0, 0], sponge: 4, smagorinsky: 0.17 });
  s.run(100);
  let err = 0;
  for (let k = 0; k < s.n; k++) {
    err = Math.max(err, Math.abs(s.ux[k] - 0.08), Math.abs(s.uy[k]), Math.abs(s.uz[k]), Math.abs(s.rho[k] - 1));
  }
  assert.ok(err < 1e-12, `max deviation ${err}`);
});

test('a rolling road moving with the free stream leaves the flow undisturbed; a fixed floor does not', () => {
  const nx = 16, ny = 10, nz = 6;
  const solid = new Uint8Array(nx * ny * nz);
  for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) solid[x + nx * (0 + ny * z)] = 2;
  const opts = { nx, ny, nz, tau: 0.6, uIn: [0.08, 0, 0], sponge: 4, smagorinsky: 0.17, solid };
  const moving = new LBMSolver({ ...opts, movingGround: true });
  moving.run(100);
  let err = 0;
  for (let k = 0; k < moving.n; k++) {
    if (solid[k]) continue;
    err = Math.max(err, Math.abs(moving.ux[k] - 0.08), Math.abs(moving.uy[k]), Math.abs(moving.uz[k]), Math.abs(moving.rho[k] - 1));
  }
  assert.ok(err < 1e-6, `moving ground disturbed the flow by ${err}`);
  assert.deepEqual(moving.bodyForce, [0, 0, 0], 'ground is not part of the body force');

  const fixed = new LBMSolver({ ...opts, movingGround: false });
  fixed.run(100);
  const nearWall = fixed.ux[fixed.idx(nx / 2, 1, nz / 2)];
  assert.ok(nearWall < 0.07, `a fixed floor should slow the flow next to it (u = ${nearWall})`);
});

test('Taylor-Green vortex decays at the rate set by nu = (tau - 1/2)/3', () => {
  const N = 32, tau = 0.8, U = 0.01, k = (2 * Math.PI) / N;
  const s = new LBMSolver({ nx: N, ny: N, nz: 2, tau, boundary: 'periodic' });
  s.initFromField((x, y) => [
    1 - 0.75 * U * U * (Math.cos(2 * k * x) + Math.cos(2 * k * y)),
    U * Math.sin(k * x) * Math.cos(k * y),
    -U * Math.cos(k * x) * Math.sin(k * y),
    0,
  ]);
  const amp = () => {
    let num = 0, den = 0;
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const b = Math.sin(k * x) * Math.cos(k * y);
      num += s.ux[s.idx(x, y, 0)] * b; den += b * b;
    }
    return num / den;
  };
  const a0 = amp();
  const T = 400;
  s.run(T);
  const rate = -Math.log(amp() / a0) / T;
  const expected = 2 * viscosity(tau) * k * k;
  assert.ok(Math.abs(rate - expected) / expected < 0.01, `rate ${rate} vs ${expected}`);
});

test('force-driven channel flow matches the Poiseuille parabola, and momentum exchange balances the drive', () => {
  const nx = 2, ny = 20, nz = 2, tau = 0.8, F = 1e-6;
  const solid = new Uint8Array(nx * ny * nz);
  for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
    solid[x + nx * (0 + ny * z)] = 1;
    solid[x + nx * (ny - 1 + ny * z)] = 1;
  }
  const s = new LBMSolver({ nx, ny, nz, tau, boundary: 'periodic', solid, force: [F, 0, 0] });
  s.run(8000);
  const nu = viscosity(tau);
  // Halfway bounce-back puts the walls midway between fluid and solid nodes.
  const y0 = 0.5, y1 = ny - 1.5;
  const uExact = (y) => (F / (2 * nu)) * (y - y0) * (y1 - y);
  const umax = uExact((y0 + y1) / 2);
  let err = 0;
  for (let y = 1; y < ny - 1; y++) err = Math.max(err, Math.abs(s.ux[s.idx(0, y, 0)] - uExact(y)));
  assert.ok(err / umax < 0.01, `relative L-inf error ${err / umax}`);

  // At steady state the walls must carry exactly the total applied force.
  const fluidNodes = nx * (ny - 2) * nz;
  const applied = F * fluidNodes;
  assert.ok(Math.abs(s.bodyForce[0] - applied) / applied < 0.01, `wall force ${s.bodyForce[0]} vs ${applied}`);
  assert.ok(Math.abs(s.bodyForce[1]) < 1e-3 * applied);
});
