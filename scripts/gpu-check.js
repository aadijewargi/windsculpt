// Runs docs/check/gpu-vs-cpu.html in headless Chromium and fails if the
// WebGL2 solver disagrees with the CPU reference solver.
import { chromium } from 'playwright';
import { serve } from './serve.js';

const server = await serve(8765);
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('page error:', e.message));
  await page.goto('http://localhost:8765/check/gpu-vs-cpu.html');
  const r = await page.waitForFunction(() => window.result, null, { timeout: 120000 }).then((h) => h.jsonValue());
  console.log(JSON.stringify(r, null, 2));
  if (!r.pass) { console.error('GPU and CPU solvers disagree'); process.exitCode = 1; }
  else console.log('GPU solver matches the CPU reference.');
} finally {
  await browser.close();
  server.close();
}
