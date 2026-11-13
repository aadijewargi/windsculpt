import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeProfile, decodeProfile } from '../docs/js/share.js';
import { circle, polygonArea, naca4 } from '../docs/js/shapes.js';

test('a profile survives the share-link round trip', () => {
  for (const pts of [circle(0.8, 200), naca4('2412')]) {
    const back = decodeProfile(encodeProfile(pts));
    assert.equal(back.length, 48);
    const a0 = Math.abs(polygonArea(pts)), a1 = Math.abs(polygonArea(back));
    assert.ok(Math.abs(a1 - a0) / a0 < 0.05, `area ${a1} vs ${a0}`);
  }
});

test('the encoding is URL-safe', () => {
  assert.match(encodeProfile(circle(1)), /^[-0-9_.]+$/);
});

test('malformed share strings are rejected', () => {
  for (const bad of ['', '1_2', '1_2.3_4', 'a_b.c_d.e_f', '1_2_3.4_5.6_7', '1_2.3_4.5_', '1e9_2.3_4.5_6', '9999_0.0_0.0_9999', null, 'x'.repeat(5000)]) {
    assert.equal(decodeProfile(bad), null, String(bad).slice(0, 20));
  }
});
