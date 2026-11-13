import test from 'node:test';
import assert from 'node:assert/strict';
import {
  polygonSDF, pointInPolygon, polygonArea, cleanStroke, sdfGrid, sampleGrid,
  voxelize, surfaceNets, circle, roundedRect, naca4, PRESETS,
} from '../docs/js/shapes.js';

const square = [[-1, -1], [1, -1], [1, 1], [-1, 1]];

test('polygon signed distance is negative inside and exact for a square', () => {
  assert.equal(polygonSDF(0, 0, square), -1);
  assert.ok(Math.abs(polygonSDF(2, 0, square) - 1) < 1e-12);
  assert.ok(Math.abs(polygonSDF(2, 2, square) - Math.SQRT2) < 1e-12);
  assert.ok(pointInPolygon(0.5, 0.5, square) && !pointInPolygon(1.5, 0, square));
});

test('SDF grid lookup matches the exact distance (also outside the grid)', () => {
  const pts = circle(0.7, 256);
  const g = sdfGrid(pts);
  for (const [x, y] of [[0, 0], [0.3, -0.2], [1.2, 0.4], [3, 0]]) {
    const exact = Math.hypot(x, y) - 0.7;
    assert.ok(Math.abs(sampleGrid(g, x, y) - exact) < 0.02, `${x},${y}: ${sampleGrid(g, x, y)} vs ${exact}`);
  }
});

test('a scribbled loop is cleaned into a closed polygon; a line is rejected', () => {
  const loop = [];
  for (let k = 0; k < 300; k++) {
    const t = (2 * Math.PI * k) / 300;
    loop.push([0.6 * Math.cos(t) + 0.01 * Math.sin(37 * t), 0.4 * Math.sin(t)]);
  }
  const p = cleanStroke(loop);
  assert.equal(p.length, 160);
  assert.ok(Math.abs(Math.abs(polygonArea(p)) - Math.PI * 0.6 * 0.4) < 0.03);
  assert.equal(cleanStroke([[0, 0], [0.5, 0.5], [1, 1]]), null);
});

test('NACA 0012 has 12% thickness and NACA 2412 has 2% camber', () => {
  const thick = (pts) => {
    let best = 0;
    for (let x = -0.9; x < 0.9; x += 0.01) {
      const ys = [];
      for (let y = -0.5; y < 0.5; y += 0.0005) if (pointInPolygon(x, y, pts)) ys.push(y);
      if (ys.length) best = Math.max(best, ys[ys.length - 1] - ys[0]);
    }
    return best / 2; // chord is 2
  };
  assert.ok(Math.abs(thick(naca4('0012')) - 0.12) < 0.003);
  const a = naca4('2412');
  const meanY = (x) => {
    const ys = [];
    for (let y = -0.5; y < 0.5; y += 0.0005) if (pointInPolygon(x, y, a)) ys.push(y);
    return (ys[0] + ys[ys.length - 1]) / 2;
  };
  assert.ok(Math.abs(meanY(-0.2) / 2 - 0.02) < 0.002, `camber ${meanY(-0.2) / 2}`);
});

const grid = { nx: 64, ny: 48, nz: 48 };
const place = { center: [24, 24, 24], length: 30, pitch: 0, yaw: 0 };
const countSolid = (s) => s.reduce((a, b) => a + b, 0);

test('a revolved circle voxelizes to a sphere of the right volume and frontal area', () => {
  const { solid, frontalArea } = voxelize(PRESETS.sphere, grid, place);
  const r = 15;
  const vol = countSolid(solid);
  assert.ok(Math.abs(vol / ((4 / 3) * Math.PI * r ** 3) - 1) < 0.03, `volume ${vol}`);
  assert.ok(Math.abs(frontalArea / (Math.PI * r * r) - 1) < 0.05, `area ${frontalArea}`);
});

test('carving two squares gives a cube; extrusion spans the whole tunnel', () => {
  const cube = { mode: 'carve', side: square, top: square };
  // Centre between nodes so the faces fall halfway between lattice nodes.
  const { solid } = voxelize(cube, grid, { ...place, center: [24.5, 24.5, 24.5], length: 20 });
  assert.equal(countSolid(solid), 20 * 20 * 20);
  const cyl = voxelize({ mode: 'extrude', side: circle(1, 256) }, grid, { ...place, length: 20 });
  for (const z of [0, 24, 47]) assert.equal(cyl.solid[24 + 64 * (24 + 48 * z)], 1);
});

test('positive pitch raises the nose (upstream end) of a flat plate', () => {
  const plank = { mode: 'carve', side: roundedRect(-1, -0.05, 1, 0.05, 0.01), top: square };
  const { solid } = voxelize(plank, grid, { ...place, pitch: 20 });
  const at = (x, y) => solid[x + 64 * (y + 48 * 24)];
  const dy = Math.round(13 * Math.tan((20 * Math.PI) / 180));
  assert.equal(at(24 - 13, 24 + dy), 1, 'nose up');
  assert.equal(at(24 - 13, 24 - dy), 0);
  assert.equal(at(24 + 13, 24 - dy), 1, 'tail down');
});

test('surface nets produce a closed, consistently sized mesh around a sphere', () => {
  const { field } = voxelize(PRESETS.sphere, grid, place);
  const m = surfaceNets(field, grid);
  assert.ok(m.indices.length > 1000 && m.indices.length % 3 === 0);
  for (let i = 0; i < m.positions.length; i += 3) {
    const r = Math.hypot(m.positions[i] - 24, m.positions[i + 1] - 24, m.positions[i + 2] - 24);
    assert.ok(Math.abs(r - 15) < 0.6, `vertex radius ${r}`);
  }
  // Closed surface: every edge is shared by exactly two triangles.
  const edges = new Map();
  for (let t = 0; t < m.indices.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = m.indices[t + e], b = m.indices[t + ((e + 1) % 3)];
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  for (const c of edges.values()) assert.equal(c, 2);
});

test('every preset voxelizes to a non-empty body that stays inside the tunnel', () => {
  for (const [name, s] of Object.entries(PRESETS)) {
    const { solid, bounds } = voxelize(s, grid, place);
    assert.ok(countSolid(solid) > 200, name);
    assert.ok(bounds.minX > 1 && bounds.maxX < grid.nx - 2, name);
  }
});
