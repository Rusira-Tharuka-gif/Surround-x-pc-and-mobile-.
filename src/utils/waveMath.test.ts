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

test('real-time frequency-driven mapping selectively differentiates bass drops vs high treble', () => {
  // 1. Bass-only signal (bins 1 to 6 active, 40-140 Hz, e.g. 808 kick)
  const bassOnlyBins = new Uint8Array(1024);
  for (let b = 1; b <= 6; b++) bassOnlyBins[b] = 230;
  const bassBands = extractLogFrequencyBands(bassOnlyBins, 48000, 2048);

  const bassState = {
    bands: new Float32Array(STUDIO_BAND_COUNT),
    peakCaps: new Float32Array(STUDIO_BAND_COUNT),
    primaryWave: new Float32Array(STUDIO_BAND_COUNT),
    secondaryWave: new Float32Array(STUDIO_BAND_COUNT),
    phase: 0,
  };

  for (let f = 0; f < 30; f++) {
    stepFullWidthStudioWave(bassState, bassBands, f * 0.02, 0.75, 0.02, true);
  }

  // Left bass bands should be significantly higher than right treble bands
  const leftBassBandAvg = (bassState.bands[1] + bassState.bands[3] + bassState.bands[5]) / 3;
  const rightTrebleBandAvg = (bassState.bands[58] + bassState.bands[60] + bassState.bands[62]) / 3;
  assert.ok(leftBassBandAvg > 0.45, `expected strong bass band excitation, got ${leftBassBandAvg}`);
  assert.ok(
    leftBassBandAvg > rightTrebleBandAvg * 3,
    `bass bands (${leftBassBandAvg}) should dominate over treble (${rightTrebleBandAvg}) on bass hit`,
  );

  // 2. Treble-only signal (bins 200 to 500 active, 5 kHz - 12 kHz, e.g. hi-hats/cymbals)
  const trebleOnlyBins = new Uint8Array(1024);
  for (let b = 200; b <= 500; b++) trebleOnlyBins[b] = 220;
  const trebleBands = extractLogFrequencyBands(trebleOnlyBins, 48000, 2048);

  const trebleState = {
    bands: new Float32Array(STUDIO_BAND_COUNT),
    peakCaps: new Float32Array(STUDIO_BAND_COUNT),
    primaryWave: new Float32Array(STUDIO_BAND_COUNT),
    secondaryWave: new Float32Array(STUDIO_BAND_COUNT),
    phase: 0,
  };

  for (let f = 0; f < 30; f++) {
    stepFullWidthStudioWave(trebleState, trebleBands, f * 0.02, 0.72, 0.02, true);
  }

  const leftBassBandAvg2 = (trebleState.bands[1] + trebleState.bands[3] + trebleState.bands[5]) / 3;
  const rightTrebleBandAvg2 =
    (trebleState.bands[50] + trebleState.bands[55] + trebleState.bands[60]) / 3;
  assert.ok(
    rightTrebleBandAvg2 > 0.4,
    `expected strong treble excitation, got ${rightTrebleBandAvg2}`,
  );
  assert.ok(
    rightTrebleBandAvg2 > leftBassBandAvg2 * 2,
    `treble bands (${rightTrebleBandAvg2}) should dominate over bass (${leftBassBandAvg2}) on hi-hat/treble signal`,
  );

  // 3. Standby / Paused state decays smoothly to gentle breathing wave
  for (let f = 0; f < 60; f++) {
    stepFullWidthStudioWave(bassState, null, (30 + f) * 0.02, 0, 0.02, false);
  }

  let standbyMax = 0;
  for (let i = 0; i < STUDIO_BAND_COUNT; i++) {
    assert.ok(bassState.bands[i] < 0.01, `bands should decay to near 0 on pause`);
    standbyMax = Math.max(standbyMax, Math.abs(bassState.primaryWave[i]));
  }
  assert.ok(standbyMax > 0.005 && standbyMax < 0.15, `expected calm standby wave, got ${standbyMax}`);
});

