import test from 'node:test';
import assert from 'node:assert/strict';
import { C, Q, W, OPP, REFL_Y, REFL_Z, REFL_YZ, CS2, feq, smagorinskyTau } from '../docs/js/lattice.js';

const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} ${a} vs ${b}`);

test('D3Q19 has 19 velocities and weights summing to 1', () => {
  assert.equal(Q, 19);
  close(W.reduce((s, w) => s + w, 0), 1, 1e-15);
});

test('lattice tensors are isotropic up to 4th order', () => {
  const d = (a, b) => (a === b ? 1 : 0);
  for (let a = 0; a < 3; a++) {
    close(W.reduce((s, w, i) => s + w * C[i][a], 0), 0, 1e-15, 'first moment');
    for (let b = 0; b < 3; b++) {
      const m2 = W.reduce((s, w, i) => s + w * C[i][a] * C[i][b], 0);
      close(m2, CS2 * d(a, b), 1e-15, 'second moment');
      for (let c = 0; c < 3; c++) for (let e = 0; e < 3; e++) {
        const m4 = W.reduce((s, w, i) => s + w * C[i][a] * C[i][b] * C[i][c] * C[i][e], 0);
        const want = CS2 * CS2 * (d(a, b) * d(c, e) + d(a, c) * d(b, e) + d(a, e) * d(b, c));
        close(m4, want, 1e-15, 'fourth moment');
      }
    }
  }
});

test('opposite and mirror tables are involutions with the right sign flips', () => {
  for (let i = 0; i < Q; i++) {
    assert.equal(OPP[OPP[i]], i);
    assert.deepEqual(C[OPP[i]], C[i].map((v) => -v + 0));
    assert.deepEqual(C[REFL_Y[i]], [C[i][0], -C[i][1] + 0, C[i][2]]);
    assert.deepEqual(C[REFL_Z[i]], [C[i][0], C[i][1], -C[i][2] + 0]);
    assert.deepEqual(C[REFL_YZ[i]], [C[i][0], -C[i][1] + 0, -C[i][2] + 0]);
  }
});

test('equilibrium reproduces density, momentum and momentum flux', () => {
  const rho = 1.07, u = [0.04, -0.03, 0.02];
  let r = 0; const m = [0, 0, 0]; const P = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < Q; i++) {
    const f = feq(i, rho, ...u);
    r += f;
    for (let a = 0; a < 3; a++) {
      m[a] += C[i][a] * f;
      for (let b = 0; b < 3; b++) P[a][b] += C[i][a] * C[i][b] * f;
    }
  }
  close(r, rho, 1e-14, 'density');
  for (let a = 0; a < 3; a++) {
    close(m[a], rho * u[a], 1e-14, 'momentum');
    for (let b = 0; b < 3; b++) {
      close(P[a][b], rho * CS2 * (a === b ? 1 : 0) + rho * u[a] * u[b], 1e-14, 'flux');
    }
  }
});

test('Smagorinsky relaxation time reduces to tau without strain and grows with it', () => {
  assert.equal(smagorinskyTau(0.6, 0.15, 0, 1), 0.6);
  assert.equal(smagorinskyTau(0.6, 0, 1, 1), 0.6);
  assert.ok(smagorinskyTau(0.6, 0.15, 1e-3, 1) > 0.6);
});
