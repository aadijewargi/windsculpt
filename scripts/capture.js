// Records the README media by driving the real app in headless Chromium.
//
//   node scripts/capture.js --preset car --out docs/media/car.gif
//
// The flow is warmed up first (no frames saved), then `frames` frames are
// captured `every` lattice steps apart and assembled with ffmpeg.
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serve } from './serve.js';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1]]);
  return acc;
}, []));
const opt = {
  hash: args.hash ?? `preset=${args.preset ?? 'car'}&res=${args.res ?? 'low'}&re=${args.re ?? 2000}`,
  warm: +(args.warm ?? 2400),
  frames: +(args.frames ?? 72),
  every: +(args.every ?? 8),
  width: +(args.width ?? 960),
  height: +(args.height ?? 540),
  out: args.out ?? 'docs/media/hero.gif',
  png: args.png,                   // also save a full-page PNG after the frames
  pngWait: +(args.pngWait ?? 20000), // ms of live running first, so the HUD fills in
  setup: args.setup ?? '',         // JS run in the page after the body is built
  fps: +(args.fps ?? 24),
  gifWidth: +(args.gifWidth ?? 760),
};

const server = await serve(8790);
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: opt.width, height: opt.height }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.error('page error:', e.message));
await page.goto(`http://localhost:8790/index.html#${opt.hash}`);
await page.waitForFunction(() => window.windsculpt?.body.bounds);
await page.evaluate((setup) => {
  const w = window.windsculpt;
  w.state.running = false;
  // eslint-disable-next-line no-new-func
  if (setup) new Function('w', setup)(w);
  w.syncControls();
}, opt.setup);
await page.waitForTimeout(500);
// Rebuild in case the setup changed the body, then wait for the worker.
await page.evaluate(() => { window.windsculpt.body.bounds = null; window.windsculpt.requestBuild(); });
await page.waitForFunction(() => window.windsculpt.body.bounds);

const t0 = Date.now();
const sync = () => page.evaluate(() => { const g = window.windsculpt.solver.gl; g.finish(); return window.windsculpt.solver.time; });
for (let done = 0; done < opt.warm; done += 40) {
  const smoke = done > opt.warm - 900;
  await page.evaluate(([n, smoke]) => {
    const w = window.windsculpt;
    for (let k = 0; k < n; k += 8) { w.solver.step(8); if (smoke) w.renderer.advectSmoke(8); }
  }, [40, smoke]);
  const t = await sync();
  if (done % 400 === 0) console.log(`warm-up step ${t} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'windsculpt-'));
for (let f = 0; f < opt.frames; f++) {
  await page.evaluate((n) => { const w = window.windsculpt; w.solver.step(n); w.renderer.advectSmoke(n); w.sampleForces(); }, opt.every);
  await sync();
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.locator('#view').screenshot({ path: path.join(dir, `f${String(f).padStart(4, '0')}.png`) });
}
const stats = await page.evaluate(() => {
  const w = window.windsculpt;
  // Sample the force a few times for the log (the HUD is paused while capturing).
  return { time: w.solver.time, tau: w.solver.tau, area: w.body.frontalArea, force: w.solver.totalForce(), U: w.solver.inletVelocity()[0] };
});
const q = 0.5 * stats.U * stats.U * stats.area;
console.log(`captured at step ${stats.time}, tau ${stats.tau.toFixed(4)}, Cd ${(stats.force[0] / q).toFixed(3)}, Cl ${(stats.force[1] / q).toFixed(3)}`);
if (opt.png) {
  // Fill the HUD from the forces sampled during the frames, then let it run live briefly.
  await page.evaluate(() => { const w = window.windsculpt; w.updateHud(0); w.state.running = true; });
  await page.waitForTimeout(opt.pngWait);
  await page.evaluate(() => { const w = window.windsculpt; w.state.running = false; w.updateHud(0); });
  await page.waitForTimeout(500);
  await page.screenshot({ path: opt.png });
}
await browser.close();
server.close();

fs.mkdirSync(path.dirname(opt.out), { recursive: true });
if (opt.out.endsWith('.gif')) {
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(opt.fps), '-i', path.join(dir, 'f%04d.png'),
    '-vf', `scale=${opt.gifWidth}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=160:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`,
    opt.out]);
} else {
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(opt.fps), '-i', path.join(dir, 'f%04d.png'),
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-crf', '24', opt.out]);
}
fs.copyFileSync(path.join(dir, `f${String(opt.frames - 1).padStart(4, '0')}.png`), opt.out.replace(/\.(gif|mp4)$/, '-still.png'));
console.log(`wrote ${opt.out} (${(fs.statSync(opt.out).size / 1e6).toFixed(2)} MB)`);
