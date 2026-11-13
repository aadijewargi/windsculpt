// Voxelizing and meshing a body takes a few hundred milliseconds on a large
// grid, so it runs off the main thread to keep the sliders smooth.

import { voxelize, surfaceNets } from './shapes.js';

self.onmessage = (e) => {
  const { id, shape, grid, place, ground } = e.data;
  const t0 = performance.now();
  const body = voxelize(shape, grid, place);
  const mesh = surfaceNets(body.field, grid);
  const { nx, ny, nz } = grid;
  const solid = body.solid;
  if (ground) {
    for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) solid[x + nx * (0 + ny * z)] = 2;
  }
  let volume = 0;
  for (let k = 0; k < solid.length; k++) if (solid[k] === 1) volume++;
  const field = body.field;
  self.postMessage(
    { id, solid, field, mesh, frontalArea: body.frontalArea, bounds: body.bounds, volume, ms: performance.now() - t0 },
    [solid.buffer, field.buffer, mesh.positions.buffer, mesh.normals.buffer, mesh.indices.buffer],
  );
};
