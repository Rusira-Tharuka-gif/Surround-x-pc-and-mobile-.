import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeWaveEnergy,
  stepSmoothedWavePoints,
  WAVE_POINT_COUNT,
} from './waveMath';
import { ZERO_LEVELS } from './stageAudioPlayer';

test('computeWaveEnergy returns 0 when inactive or silent and scales smoothly when active', () => {
  assert.equal(computeWaveEnergy(ZERO_LEVELS, false), 0);
  assert.equal(computeWaveEnergy(ZERO_LEVELS, true), 0);

  const high = computeWaveEnergy(
    { FL: 0.8, FR: 0.8, C: 0.7, LFE: 0.9, SL: 0.6, SR: 0.6, lfeBeat: 0.85 },
    true,
  );
  const low = computeWaveEnergy(
    { FL: 0.15, FR: 0.15, C: 0.1, LFE: 0.1, SL: 0.08, SR: 0.08, lfeBeat: 0.1 },
    true,
  );

  assert.ok(high > low, 'higher audio energy should yield higher wave energy');
  assert.ok(high > 0.7 && high <= 1, `expected bounded high energy, got ${high}`);
  assert.equal(
    computeWaveEnergy(
      { FL: 0.9, FR: 0.9, C: 0.9, LFE: 0.9, SL: 0.9, SR: 0.9, lfeBeat: 0.9 },
      false,
    ),
    0,
  );
});

test('stepSmoothedWavePoints tapers endpoints to 0 and stays jitter-free and bounded', () => {
  let pts: Float32Array<ArrayBufferLike> = new Float32Array(WAVE_POINT_COUNT);

  for (let frame = 0; frame < 40; frame++) {
    pts = stepSmoothedWavePoints(pts, frame * 0.02, 0.85, 0.02);
  }

  assert.equal(pts[0], 0);
  assert.equal(pts[WAVE_POINT_COUNT - 1], 0);

  let maxVal = 0;
  let maxDelta = 0;
  for (let i = 0; i < pts.length; i++) {
    assert.ok(Number.isFinite(pts[i]));
    maxVal = Math.max(maxVal, Math.abs(pts[i]));
    if (i > 0) {
      maxDelta = Math.max(maxDelta, Math.abs(pts[i] - pts[i - 1]));
    }
  }

  assert.ok(maxVal > 0.25 && maxVal <= 1, `expected active wave excursion, got ${maxVal}`);
  assert.ok(maxDelta < 0.35, `expected smooth adjacent curve delta, got ${maxDelta}`);

  // When audio stops (energy = 0), wave settles gently down to calm idle amplitude
  for (let frame = 40; frame < 220; frame++) {
    pts = stepSmoothedWavePoints(pts, frame * 0.02, 0, 0.02);
  }

  let idleMax = 0;
  for (let i = 0; i < pts.length; i++) {
    idleMax = Math.max(idleMax, Math.abs(pts[i]));
  }
  assert.ok(idleMax > 0.01 && idleMax < 0.18, `expected calm idle wave, got ${idleMax}`);
});
