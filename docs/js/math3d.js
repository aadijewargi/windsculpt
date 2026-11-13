// Minimal column-major 4x4 matrix helpers for the camera.

export function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, 2 * far * near * nf, 0,
  ]);
}

export function lookAt(eye, target, up) {
  let zx = eye[0] - target[0], zy = eye[1] - target[1], zz = eye[2] - target[2];
  let l = Math.hypot(zx, zy, zz); zx /= l; zy /= l; zz /= l;
  let xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx;
  l = Math.hypot(xx, xy, xz); xx /= l; xy /= l; xz /= l;
  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
  return new Float32Array([
    xx, yx, zx, 0,
    xy, yy, zy, 0,
    xz, yz, zz, 0,
    -(xx * eye[0] + xy * eye[1] + xz * eye[2]),
    -(yx * eye[0] + yy * eye[1] + yz * eye[2]),
    -(zx * eye[0] + zy * eye[1] + zz * eye[2]),
    1,
  ]);
}

export function multiply(a, b) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
    o[c * 4 + r] = s;
  }
  return o;
}

/** Orbit camera around a target, in a y-up world. */
export class OrbitCamera {
  constructor(target, distance) {
    this.target = target.slice();
    this.distance = distance;
    this.yaw = -0.75;   // around +y
    this.pitch = 0.42;  // above the horizon
  }

  eye() {
    const { yaw, pitch, distance: d, target: t } = this;
    return [
      t[0] + d * Math.cos(pitch) * Math.sin(yaw),
      t[1] + d * Math.sin(pitch),
      t[2] + d * Math.cos(pitch) * Math.cos(yaw),
    ];
  }

  rotate(dx, dy) {
    this.yaw -= dx * 0.008;
    this.pitch = Math.min(1.45, Math.max(-1.45, this.pitch + dy * 0.008));
  }

  zoom(factor, min, max) {
    this.distance = Math.min(max, Math.max(min, this.distance * factor));
  }

  pan(dx, dy) {
    const e = this.eye();
    const norm = (v) => { const l = Math.hypot(...v) || 1; return v.map((c) => c / l); };
    const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const f = norm([this.target[0] - e[0], this.target[1] - e[1], this.target[2] - e[2]]);
    const r = norm(cross(f, [0, 1, 0]));
    const u = cross(r, f);
    const s = this.distance * 0.0015;
    for (let k = 0; k < 3; k++) this.target[k] += (-dx * r[k] + dy * u[k]) * s;
  }

  matrices(aspect) {
    // On tall (phone) screens widen the vertical field of view so the tunnel's
    // length still fits across the width.
    const fovy = 2 * Math.atan(Math.tan(0.375) * Math.max(1, 1.5 / aspect));
    const proj = perspective(fovy, aspect, this.distance * 0.02, this.distance * 8);
    const view = lookAt(this.eye(), this.target, [0, 1, 0]);
    return { proj, view, viewProj: multiply(proj, view), eye: this.eye() };
  }
}
