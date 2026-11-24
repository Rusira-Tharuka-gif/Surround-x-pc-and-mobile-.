import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeEdgeTaper,
  computeWaveEnergy,
  extractLogFrequencyBands,
  stepFullWidthStudioWave,
  stepSmoothedWavePoints,
  STUDIO_BAND_COUNT,
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

test('computeEdgeTaper keeps healthy minimum floor at both ends without edge dead zones', () => {
  const leftEdge = computeEdgeTaper(0, 0.44);
  const center = computeEdgeTaper(0.5, 0.44);
  const rightEdge = computeEdgeTaper(1, 0.44);

  assert.ok(Math.abs(leftEdge - 0.44) < 0.001);
  assert.ok(Math.abs(rightEdge - 0.44) < 0.001);
  assert.ok(Math.abs(center - 1.0) < 0.001);
});

test('extractLogFrequencyBands and stepFullWidthStudioWave produce responsive edge and center motion', () => {
  const fftBins = new Uint8Array(1024);
  fftBins.fill(150); // broadband signal across low, mid, and high bins
  const bands = extractLogFrequencyBands(fftBins, 48000, 2048);

  assert.equal(bands.length, STUDIO_BAND_COUNT);
  assert.ok(bands[0] > 0.4, `expected active low-frequency left band, got ${bands[0]}`);
  assert.ok(bands[32] > 0.4, `expected active mid band, got ${bands[32]}`);
  assert.ok(bands[63] > 0.4, `expected active high-frequency right band, got ${bands[63]}`);

  const state = {
    bands: new Float32Array(STUDIO_BAND_COUNT),
    peakCaps: new Float32Array(STUDIO_BAND_COUNT),
    primaryWave: new Float32Array(STUDIO_BAND_COUNT),
    secondaryWave: new Float32Array(STUDIO_BAND_COUNT),
    phase: 0,
  };

  let edgeLeftMax = 0;
  let edgeRightMax = 0;
  let centerMax = 0;

  for (let f = 0; f < 45; f++) {
    stepFullWidthStudioWave(state, bands, f * 0.02, 0.82, 0.02, true);
    edgeLeftMax = Math.max(edgeLeftMax, Math.abs(state.primaryWave[2]));
    edgeRightMax = Math.max(edgeRightMax, Math.abs(state.primaryWave[STUDIO_BAND_COUNT - 3]));
    centerMax = Math.max(centerMax, Math.abs(state.primaryWave[STUDIO_BAND_COUNT / 2]));
  }

  assert.ok(edgeLeftMax > 0.16, `expected active left edge excursion, got ${edgeLeftMax}`);
  assert.ok(edgeRightMax > 0.16, `expected active right edge excursion, got ${edgeRightMax}`);
  assert.ok(centerMax > 0.24, `expected active center excursion, got ${centerMax}`);

  // Regression: sharp energy swing even at huge session uptime (e.g., 500s) must NOT cause phase jumps/racing
  const prevWave = new Float32Array(state.primaryWave);
  stepFullWidthStudioWave(state, bands, 500.0, 0.15, 0.016, true);
  let maxStepDelta = 0;
  for (let i = 0; i < STUDIO_BAND_COUNT; i++) {
    maxStepDelta = Math.max(maxStepDelta, Math.abs(state.primaryWave[i] - prevWave[i]));
  }
  assert.ok(
    maxStepDelta < 0.25,
    `expected smooth frame-to-frame dance without phase jump, got ${maxStepDelta}`,
  );
});

