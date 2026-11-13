// Turning 2D drawings into 3D bodies.
//
// A body is defined by one or two closed profiles drawn in normalized
// coordinates [-1, 1]^2:
//   side profile  (u, v): u = streamwise (flow goes +u), v = vertical
//   top profile   (u, w): u = streamwise, w = spanwise
// and a mode:
//   'carve'   - solid = (side extruded across the span) ∩ (top extruded vertically)
//   'revolve' - the side profile spun around the streamwise axis
//   'extrude' - the side profile extruded across the whole tunnel (2.5D)
// Each profile becomes a 2D signed distance field (negative inside), and the
// body's 3D field is combined from those. The lattice solid mask is
// field < 0, and the rendered surface is the zero level set of the same field,
// so what you see is what the solver sees.

const GRID_EXTENT = 1.5; // 2D SDF grids cover [-1.5, 1.5]^2
const GRID_RES = 192;

// ------------------------------------------------------------ polygon tools

export function polygonArea(pts) {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    a += (pts[j][0] - pts[i][0]) * (pts[j][1] + pts[i][1]);
  }
  return a / 2;
}

export function pointInPolygon(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Signed distance from (x, y) to a closed polygon (negative inside). */
export function polygonSDF(x, y, pts) {
  let d2 = Infinity;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [ax, ay] = pts[j], [bx, by] = pts[i];
    const ex = bx - ax, ey = by - ay;
    const l2 = ex * ex + ey * ey;
    let t = l2 > 0 ? ((x - ax) * ex + (y - ay) * ey) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const dx = x - ax - t * ex, dy = y - ay - t * ey;
    const dd = dx * dx + dy * dy;
    if (dd < d2) d2 = dd;
  }
  const d = Math.sqrt(d2);
  return pointInPolygon(x, y, pts) ? -d : d;
}

/** Chaikin corner cutting on a closed polygon. */
export function chaikin(pts, iterations = 1) {
  let p = pts;
  for (let it = 0; it < iterations; it++) {
    const q = [];
    for (let i = 0; i < p.length; i++) {
      const a = p[i], b = p[(i + 1) % p.length];
      q.push([0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]]);
      q.push([0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]]);
    }
    p = q;
  }
  return p;
}

/** Resample a closed polygon to n points evenly spaced along its perimeter. */
export function resample(pts, n) {
  const seg = [];
  let total = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    seg.push(l); total += l;
  }
  if (total === 0) return pts.slice();
  const out = [];
  let i = 0, acc = 0;
  for (let k = 0; k < n; k++) {
    const target = (k / n) * total;
    while (acc + seg[i] < target && i < pts.length - 1) { acc += seg[i]; i++; }
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const t = seg[i] > 0 ? (target - acc) / seg[i] : 0;
    out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
  }
  return out;
}

/**
 * Clean up a freehand stroke: drop near-duplicate points, close it, smooth it
 * and resample it. Returns null if the stroke encloses (almost) no area.
 */
export function cleanStroke(raw, { minArea = 0.01, points = 160 } = {}) {
  const p = [];
  for (const q of raw) {
    const last = p[p.length - 1];
    if (!last || Math.hypot(q[0] - last[0], q[1] - last[1]) > 0.004) p.push([q[0], q[1]]);
  }
  if (p.length < 3) return null;
  const smooth = resample(chaikin(resample(p, Math.max(48, Math.min(400, p.length))), 2), points);
  if (Math.abs(polygonArea(smooth)) < minArea) return null;
  return smooth;
}

// ------------------------------------------------------------ 2D SDF grids

/** Rasterize a polygon's signed distance onto a grid for fast lookup. */
export function sdfGrid(pts, res = GRID_RES) {
  const data = new Float32Array(res * res);
  const h = (2 * GRID_EXTENT) / (res - 1);
  for (let j = 0; j < res; j++) {
    const y = -GRID_EXTENT + j * h;
    for (let i = 0; i < res; i++) data[i + res * j] = polygonSDF(-GRID_EXTENT + i * h, y, pts);
  }
  return { data, res, h };
}

/** Bilinear lookup; outside the grid the distance grows with the overshoot. */
export function sampleGrid(g, x, y) {
  const { data, res, h } = g;
  let gx = (x + GRID_EXTENT) / h, gy = (y + GRID_EXTENT) / h;
  let extra = 0;
  const max = res - 1;
  if (gx < 0 || gx > max || gy < 0 || gy > max) {
    const cx = Math.min(Math.max(gx, 0), max), cy = Math.min(Math.max(gy, 0), max);
    extra = Math.hypot(gx - cx, gy - cy) * h;
    gx = cx; gy = cy;
  }
  const i = Math.min(Math.floor(gx), max - 1), j = Math.min(Math.floor(gy), max - 1);
  const fx = gx - i, fy = gy - j;
  const a = data[i + res * j], b = data[i + 1 + res * j];
  const c = data[i + res * (j + 1)], d = data[i + 1 + res * (j + 1)];
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy + extra;
}

// ------------------------------------------------------------ 3D bodies

/** Normalized signed distance function of a body: (u, v, w) -> distance. */
export function bodySDF(shape) {
  const S = sdfGrid(shape.side);
  const [sx, sy, sz] = shape.stretch ?? [1, 1, 1];
  const k = Math.min(sx, sy, sz); // keeps the field a (conservative) distance
  if (shape.mode === 'revolve') {
    return (u, v, w) => {
      const r = Math.hypot(v / sy, w / sz);
      return Math.min(sampleGrid(S, u / sx, r), sampleGrid(S, u / sx, -r)) * k;
    };
  }
  if (shape.mode === 'extrude') return (u, v) => sampleGrid(S, u / sx, v / sy) * k;
  const T = sdfGrid(shape.top);
  return (u, v, w) => Math.max(sampleGrid(S, u / sx, v / sy), sampleGrid(T, u / sx, w / sz)) * k;
}

/**
 * Place a body in the lattice and voxelize it.
 * @param shape   {mode, side, top?, stretch?}
 * @param grid    {nx, ny, nz}
 * @param place   {center: [x,y,z] in cells, length: body length in cells,
 *                 pitch: nose-up angle in degrees, yaw: degrees}
 * @returns {solid, field, frontalArea, bounds}
 *   field is the signed distance in lattice cells at every node.
 */
export function voxelize(shape, grid, place) {
  const { nx, ny, nz } = grid;
  const n = nx * ny * nz;
  const sdf = bodySDF(shape);
  const scale = place.length / 2; // cells per normalized unit
  const [cx, cy, cz] = place.center;
  const a = ((place.pitch ?? 0) * Math.PI) / 180;
  const b = ((place.yaw ?? 0) * Math.PI) / 180;
  const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b);
  const field = new Float32Array(n);
  const solid = new Uint8Array(n);
  const reach = Math.hypot(...(shape.stretch ?? [1, 1, 1])) * 1.5 * scale + 2;
  const extrude = shape.mode === 'extrude';
  let minX = nx, minY = ny, minZ = nz, maxX = -1, maxY = -1, maxZ = -1;
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const k = x + nx * (y + ny * z);
    let px = x - cx, py = y - cy, pz = z - cz;
    if (!extrude && Math.hypot(px, py, pz) > reach) { field[k] = reach; continue; }
    // Undo yaw (about the vertical axis), then pitch (about the span axis).
    // A positive pitch raises the nose (upstream end, u = -1).
    const qx = cb * px - sb * pz, qz = sb * px + cb * pz;
    px = qx; pz = qz;
    const rx = ca * px - sa * py, ry = sa * px + ca * py;
    const d = sdf(rx / scale, ry / scale, pz / scale) * scale;
    field[k] = d;
    if (d < 0) {
      solid[k] = 1;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
  }
  // Never let the body touch the inlet or the outlet planes.
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) {
    for (const x of [0, 1, nx - 1]) solid[x + nx * (y + ny * z)] = 0;
  }
  return { solid, field, frontalArea: frontalArea(solid, grid), bounds: { minX, minY, minZ, maxX, maxY, maxZ } };
}

/** Number of (y, z) columns that contain any solid node: the projected area. */
export function frontalArea(solid, { nx, ny, nz }) {
  let a = 0;
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) if (solid[x + nx * (y + ny * z)]) { a++; break; }
  }
  return a;
}

// ------------------------------------------------------------ surface mesh

/**
 * Naive surface nets on a node-centred scalar field: one vertex per cube that
 * straddles the zero level, placed at the mean of the edge crossings, and one
 * quad per sign-changing edge. Returns positions/normals in lattice units.
 */
export function surfaceNets(field, { nx, ny, nz }) {
  const id = (x, y, z) => x + nx * (y + ny * z);
  const vIndex = new Int32Array((nx - 1) * (ny - 1) * (nz - 1)).fill(-1);
  const cid = (x, y, z) => x + (nx - 1) * (y + (ny - 1) * z);
  const pos = [], nor = [], idx = [];
  const grad = (x, y, z) => {
    const xi = Math.min(Math.max(Math.round(x), 1), nx - 2);
    const yi = Math.min(Math.max(Math.round(y), 1), ny - 2);
    const zi = Math.min(Math.max(Math.round(z), 1), nz - 2);
    const gx = field[id(xi + 1, yi, zi)] - field[id(xi - 1, yi, zi)];
    const gy = field[id(xi, yi + 1, zi)] - field[id(xi, yi - 1, zi)];
    const gz = field[id(xi, yi, zi + 1)] - field[id(xi, yi, zi - 1)];
    const l = Math.hypot(gx, gy, gz) || 1;
    return [gx / l, gy / l, gz / l];
  };
  const corners = [];
  for (let c = 0; c < 8; c++) corners.push([c & 1, (c >> 1) & 1, (c >> 2) & 1]);
  const edges = [];
  for (let a = 0; a < 8; a++) for (let b = a + 1; b < 8; b++) {
    const d = (a ^ b);
    if (d === 1 || d === 2 || d === 4) edges.push([a, b]);
  }
  const v = new Float32Array(8);
  for (let z = 0; z < nz - 1; z++) for (let y = 0; y < ny - 1; y++) for (let x = 0; x < nx - 1; x++) {
    let mask = 0;
    for (let c = 0; c < 8; c++) {
      v[c] = field[id(x + corners[c][0], y + corners[c][1], z + corners[c][2])];
      if (v[c] < 0) mask |= 1 << c;
    }
    if (mask === 0 || mask === 255) continue;
    let sx = 0, sy = 0, sz = 0, cnt = 0;
    for (const [a, b] of edges) {
      if ((v[a] < 0) === (v[b] < 0)) continue;
      const t = v[a] / (v[a] - v[b]);
      sx += corners[a][0] + t * (corners[b][0] - corners[a][0]);
      sy += corners[a][1] + t * (corners[b][1] - corners[a][1]);
      sz += corners[a][2] + t * (corners[b][2] - corners[a][2]);
      cnt++;
    }
    const p = [x + sx / cnt, y + sy / cnt, z + sz / cnt];
    vIndex[cid(x, y, z)] = pos.length / 3;
    pos.push(...p);
    nor.push(...grad(...p));
  }
  // Quads around each sign-changing lattice edge.
  const quad = (a, b, c, d, flip) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) idx.push(a, c, b, a, d, c); else idx.push(a, b, c, a, c, d);
  };
  for (let z = 1; z < nz - 1; z++) for (let y = 1; y < ny - 1; y++) for (let x = 1; x < nx - 1; x++) {
    const inside = field[id(x, y, z)] < 0;
    if (x < nx - 1 && (field[id(x + 1, y, z)] < 0) !== inside) {
      quad(vIndex[cid(x, y - 1, z - 1)], vIndex[cid(x, y, z - 1)], vIndex[cid(x, y, z)], vIndex[cid(x, y - 1, z)], !inside);
    }
    if (y < ny - 1 && (field[id(x, y + 1, z)] < 0) !== inside) {
      quad(vIndex[cid(x - 1, y, z - 1)], vIndex[cid(x - 1, y, z)], vIndex[cid(x, y, z)], vIndex[cid(x, y, z - 1)], !inside);
    }
    if (z < nz - 1 && (field[id(x, y, z + 1)] < 0) !== inside) {
      quad(vIndex[cid(x - 1, y - 1, z)], vIndex[cid(x, y - 1, z)], vIndex[cid(x, y, z)], vIndex[cid(x - 1, y, z)], !inside);
    }
  }
  return { positions: new Float32Array(pos), normals: new Float32Array(nor), indices: new Uint32Array(idx) };
}

// ------------------------------------------------------------ presets

export function circle(r = 1, n = 128, cx = 0, cy = 0) {
  return Array.from({ length: n }, (_, k) => {
    const t = (2 * Math.PI * k) / n;
    return [cx + r * Math.cos(t), cy + r * Math.sin(t)];
  });
}

export function roundedRect(x0, y0, x1, y1, r, n = 160) {
  const pts = [];
  const cs = [[x1 - r, y1 - r, 0], [x0 + r, y1 - r, 90], [x0 + r, y0 + r, 180], [x1 - r, y0 + r, 270]];
  const per = Math.max(2, Math.floor(n / 4));
  for (const [cx, cy, a0] of cs) {
    for (let k = 0; k <= per; k++) {
      const t = ((a0 + (90 * k) / per) * Math.PI) / 180;
      pts.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]);
    }
  }
  return pts;
}

/** NACA 4-digit airfoil, chord from u = -1 (leading edge) to u = 1. */
export function naca4(code = '2412', n = 120) {
  const m = +code[0] / 100, p = +code[1] / 10, t = +code.slice(2) / 100;
  const upper = [], lower = [];
  for (let k = 0; k <= n; k++) {
    const x = 0.5 * (1 - Math.cos((Math.PI * k) / n)); // cosine spacing
    const yt = 5 * t * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1036 * x ** 4);
    let yc = 0, dy = 0;
    if (m > 0) {
      if (x < p) { yc = (m / (p * p)) * (2 * p * x - x * x); dy = ((2 * m) / (p * p)) * (p - x); }
      else { yc = (m / ((1 - p) ** 2)) * (1 - 2 * p + 2 * p * x - x * x); dy = ((2 * m) / ((1 - p) ** 2)) * (p - x); }
    }
    const th = Math.atan(dy);
    upper.push([2 * (x - yt * Math.sin(th)) - 1, 2 * (yc + yt * Math.cos(th))]);
    lower.push([2 * (x + yt * Math.sin(th)) - 1, 2 * (yc - yt * Math.cos(th))]);
  }
  return [...upper.reverse(), ...lower.slice(1, -1)];
}

const car = chaikin([
  [-1, -0.32], [-1, -0.08], [-0.92, 0.0], [-0.55, 0.06], [-0.22, 0.34], [0.25, 0.36],
  [0.62, 0.12], [0.98, 0.08], [1, -0.14], [0.96, -0.32],
], 3);

const ahmed = (() => {
  const H = 0.276, R = 0.19, slant = 0.385, drop = 0.18;
  const pts = [];
  pts.push([1, -H], [1, H - drop], [1 - slant, H]);
  for (let k = 0; k <= 16; k++) { const t = Math.PI / 2 + (k / 16) * (Math.PI / 2); pts.push([-1 + R + R * Math.cos(t), H - R + R * Math.sin(t)]); }
  for (let k = 0; k <= 16; k++) { const t = Math.PI + (k / 16) * (Math.PI / 2); pts.push([-1 + R + R * Math.cos(t), -H + R + R * Math.sin(t)]); }
  return pts;
})();

const ahmedTop = (() => {
  const Wd = 0.3725, R = 0.19, pts = [[1, -Wd], [1, Wd]];
  for (let k = 0; k <= 16; k++) { const t = Math.PI / 2 + (k / 16) * (Math.PI / 2); pts.push([-1 + R + R * Math.cos(t), Wd - R + R * Math.sin(t)]); }
  for (let k = 0; k <= 16; k++) { const t = Math.PI + (k / 16) * (Math.PI / 2); pts.push([-1 + R + R * Math.cos(t), -Wd + R + R * Math.sin(t)]); }
  return pts;
})();

const bullet = (() => {
  // Tangent ogive nose on a cylindrical body with a flat base.
  const pts = [];
  const r = 0.32, Ln = 0.9;
  const rho = (r * r + Ln * Ln) / (2 * r);
  for (let k = 0; k <= 30; k++) {
    const x = (k / 30) * Ln;
    const y = Math.sqrt(rho * rho - (Ln - x) ** 2) + r - rho;
    pts.push([-1 + x, Math.max(y, 0)]);
  }
  pts.push([1, r], [1, -r]);
  for (let k = 30; k >= 0; k--) {
    const x = (k / 30) * Ln;
    const y = Math.sqrt(rho * rho - (Ln - x) ** 2) + r - rho;
    pts.push([-1 + x, -Math.max(y, 0)]);
  }
  return pts;
})();

export const PRESETS = {
  sphere: { label: 'Sphere', mode: 'revolve', side: circle(1) },
  teardrop: { label: 'Teardrop', mode: 'revolve', side: naca4('0040') },
  bullet: { label: 'Bullet', mode: 'revolve', side: bullet },
  cube: { label: 'Cube', mode: 'carve', side: roundedRect(-0.8, -0.8, 0.8, 0.8, 0.02), top: roundedRect(-0.8, -0.8, 0.8, 0.8, 0.02) },
  plate: { label: 'Flat plate', mode: 'carve', side: roundedRect(-0.08, -1, 0.08, 1, 0.02), top: roundedRect(-0.08, -1, 0.08, 1, 0.02) },
  cylinder: { label: 'Cylinder', mode: 'extrude', side: circle(0.8) },
  wing: { label: 'Wing', mode: 'carve', side: naca4('2412'), top: roundedRect(-1.02, -0.95, 1.02, 0.95, 0.3), stretch: [1, 1, 1.6] },
  car: { label: 'Car', mode: 'carve', side: car, top: roundedRect(-1, -0.42, 1, 0.42, 0.18) },
  ahmed: { label: 'Ahmed body', mode: 'carve', side: ahmed, top: ahmedTop },
};
