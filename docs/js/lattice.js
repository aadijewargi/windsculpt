// D3Q19 lattice: velocity set, weights and helpers shared by the CPU
// reference solver and the GPU (WebGL2) solver, so both use exactly the same
// ordering and constants.

/** Discrete velocities c_i. Index 0 is the rest population. */
export const C = [
  [0, 0, 0],
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
  [1, 1, 0], [-1, -1, 0], [1, -1, 0], [-1, 1, 0],
  [1, 0, 1], [-1, 0, -1], [1, 0, -1], [-1, 0, 1],
  [0, 1, 1], [0, -1, -1], [0, 1, -1], [0, -1, 1],
];

export const Q = C.length; // 19

/** Lattice weights w_i (sum to 1). */
export const W = C.map(([x, y, z]) => {
  const n = Math.abs(x) + Math.abs(y) + Math.abs(z);
  return n === 0 ? 1 / 3 : n === 1 ? 1 / 18 : 1 / 36;
});

/** Speed of sound squared, in lattice units. */
export const CS2 = 1 / 3;

function indexOf(v) {
  const i = C.findIndex((c) => c[0] === v[0] && c[1] === v[1] && c[2] === v[2]);
  if (i < 0) throw new Error(`no lattice direction ${v}`);
  return i;
}

/** OPP[i] is the direction with c = -c_i (bounce-back partner). */
export const OPP = C.map(([x, y, z]) => indexOf([-x, -y, -z]));
/** Direction with the y component mirrored (free-slip wall normal to y). */
export const REFL_Y = C.map(([x, y, z]) => indexOf([x, -y, z]));
/** Direction with the z component mirrored (free-slip wall normal to z). */
export const REFL_Z = C.map(([x, y, z]) => indexOf([x, y, -z]));
/** Both y and z mirrored (edge where two free-slip walls meet). */
export const REFL_YZ = C.map(([x, y, z]) => indexOf([x, -y, -z]));

/**
 * Second-order equilibrium
 *   f_i^eq = w_i rho [1 + c.u/cs^2 + (c.u)^2/(2 cs^4) - u.u/(2 cs^2)].
 */
export function feq(i, rho, ux, uy, uz) {
  const c = C[i];
  const cu = c[0] * ux + c[1] * uy + c[2] * uz;
  const uu = ux * ux + uy * uy + uz * uz;
  return W[i] * rho * (1 + 3 * cu + 4.5 * cu * cu - 1.5 * uu);
}

/** Kinematic viscosity for a BGK relaxation time tau: nu = cs^2 (tau - 1/2). */
export const viscosity = (tau) => CS2 * (tau - 0.5);
/** Relaxation time for a kinematic viscosity nu. */
export const tauFromViscosity = (nu) => nu / CS2 + 0.5;

/**
 * Relaxation time with the Smagorinsky subgrid model (Hou et al. 1996):
 *   tau_eff = (tau + sqrt(tau^2 + 18 sqrt(2) Cs^2 |Pi_neq| / rho)) / 2,
 * where |Pi_neq| is the Frobenius norm of the non-equilibrium momentum flux.
 */
export function smagorinskyTau(tau, cs, piNorm, rho) {
  if (cs <= 0) return tau;
  return 0.5 * (tau + Math.sqrt(tau * tau + 18 * Math.SQRT2 * cs * cs * piNorm / rho));
}
