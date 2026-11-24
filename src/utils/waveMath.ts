import type { ChannelLevels } from './stageAudioPlayer';

export const WAVE_POINT_COUNT = 40;
export const STUDIO_BAND_COUNT = 64;

export function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

export function computeWaveEnergy(
  levels: ChannelLevels | null | undefined,
  isActive: boolean,
): number {
  if (!isActive || !levels) return 0;

  const front = ((levels.FL ?? 0) + (levels.FR ?? 0)) * 0.5;
  const center = levels.C ?? 0;
  const surround = ((levels.SL ?? 0) + (levels.SR ?? 0)) * 0.5;
  const bass = Math.max(levels.LFE ?? 0, levels.lfeBeat ?? 0);

  let weighted = front * 0.36 + center * 0.22 + surround * 0.2 + bass * 0.34;

  if (levels.spectrum && levels.spectrum.length > 0) {
    let specSum = 0;
    const slen = levels.spectrum.length;
    for (let i = 0; i < slen; i++) {
      specSum += levels.spectrum[i] ?? 0;
    }
    const specAvg = specSum / slen;
    weighted = Math.max(weighted, specAvg * 1.15);
  }

  const clamped = clampUnit(weighted);
  if (clamped <= 0.002) return 0;

  return clampUnit(Math.pow(clamped, 0.58));
}

export function stepSmoothedWavePoints(
  prevPoints: Float32Array,
  timeSec: number,
  energy: number,
  dtSec: number,
  targetOut?: Float32Array,
): Float32Array {
  const n = prevPoints.length;
  const next = targetOut && targetOut.length === n ? targetOut : new Float32Array(n);
  const safeEnergy = clampUnit(energy);
  const safeDt = Math.max(0.004, Math.min(0.05, Number.isFinite(dtSec) ? dtSec : 0.016));

  // Calm idle breathing amplitude when quiet/paused; expands fluidly when audio rises
  const amplitude = 0.08 + safeEnergy * 1.12;
  const speedBoost = 1 + safeEnergy * 1.65;
  const phase = timeSec * speedBoost;

  const attackAlpha = Math.max(0.1, Math.min(0.36, safeDt * 12));
  const releaseAlpha = Math.max(0.05, Math.min(0.18, safeDt * 5.2));

  for (let i = 0; i < n; i++) {
    const u = n > 1 ? i / (n - 1) : 0;
    // Smooth bell-shaped envelope tapering cleanly to 0 at both endpoints
    const envelope = Math.pow(Math.sin(Math.PI * u), 1.25);

    const h1 = Math.sin(u * Math.PI * 2.2 - phase * 1.9);
    const h2 = 0.54 * Math.sin(u * Math.PI * 4.2 + phase * 2.5 + 0.7);
    const h3 = 0.28 * Math.sin(u * Math.PI * 6.4 - phase * 3.3 + 1.4);

    const rawWave = (h1 + h2 + h3) / 1.55;
    const target = Math.max(-1, Math.min(1, rawWave * amplitude * envelope));

    const prev = Number.isFinite(prevPoints[i]) ? prevPoints[i] : 0;
    const alpha = Math.abs(target) >= Math.abs(prev) ? attackAlpha : releaseAlpha;
    next[i] = prev + (target - prev) * alpha;
  }

  // Gentle 3-tap spatial smoothing on interior points to prevent sharp spikes
  for (let i = 1; i < n - 1; i++) {
    next[i] = Math.max(-1, Math.min(1, next[i - 1] * 0.18 + next[i] * 0.64 + next[i + 1] * 0.18));
  }
  if (n > 0) {
    next[0] = 0;
    next[n - 1] = 0;
  }

  return next;
}

/**
 * Raised-cosine (Hanning) window with a healthy 44% minimum floor so both left and right
 * spectrum edges remain vibrantly active without collapsing into flat dead zones.
 */
export function computeEdgeTaper(u: number, minFloor = 0.44): number {
  const clampedU = clampUnit(u);
  const hanning = 0.5 - 0.5 * Math.cos(2 * Math.PI * clampedU);
  return minFloor + (1 - minFloor) * hanning;
}

/**
 * Maps linear Web Audio FFT bins logarithmically across 30 Hz – 15.5 kHz with perceptual
 * high-frequency tilt compensation and soft-knee compression so sub-bass, mids, and highs
 * produce balanced full-width motion.
 */
export function extractLogFrequencyBands(
  fftBins: Uint8Array,
  sampleRate = 48000,
  fftSize = 2048,
  outBands?: Float32Array,
): Float32Array {
  const count = outBands ? outBands.length : STUDIO_BAND_COUNT;
  const out = outBands ?? new Float32Array(count);
  const binCount = fftBins.length;
  if (binCount === 0 || count === 0) {
    out.fill(0);
    return out;
  }

  const nyquist = Math.max(8000, sampleRate * 0.5);
  const minFreq = 30;
  const maxFreq = Math.min(nyquist * 0.9, 12000);
  const hzPerBin = sampleRate / Math.max(64, fftSize);
  const ratio = maxFreq / minFreq;

  for (let i = 0; i < count; i++) {
    const u0 = i / count;
    const u1 = (i + 1) / count;
    const uMid = (i + 0.5) / Math.max(1, count);

    const fStart = minFreq * Math.pow(ratio, u0);
    const fEnd = minFreq * Math.pow(ratio, u1);
    const bStart = fStart / hzPerBin;
    const bEnd = fEnd / hzPerBin;

    let rawNorm = 0;
    if (bEnd - bStart < 1) {
      // Smooth fractional linear interpolation across sparse low-frequency bins
      const centerBin = (bStart + bEnd) * 0.5;
      const idx0 = Math.max(0, Math.min(binCount - 1, Math.floor(centerBin)));
      const idx1 = Math.max(0, Math.min(binCount - 1, idx0 + 1));
      const frac = centerBin - idx0;
      const v = (fftBins[idx0] ?? 0) * (1 - frac) + (fftBins[idx1] ?? 0) * frac;
      rawNorm = v / 255;
    } else {
      const i0 = Math.max(0, Math.min(binCount - 1, Math.floor(bStart)));
      const i1 = Math.max(i0, Math.min(binCount - 1, Math.ceil(bEnd)));
      let sum = 0;
      let peak = 0;
      let nBins = 0;
      for (let b = i0; b <= i1; b++) {
        const val = fftBins[b] ?? 0;
        if (val > peak) peak = val;
        sum += val;
        nBins++;
      }
      const avg = nBins > 0 ? sum / nBins : 0;
      rawNorm = (peak * 0.55 + avg * 0.45) / 255;
    }

    // Perceptual tilt compensation counteracts natural -3dB/oct music rolloff at high freqs
    const perceptualTilt = 0.92 + 0.72 * Math.pow(uMid, 0.85);
    const gated = Math.max(0, (rawNorm - 0.032) / 0.968);
    const normalized = Math.pow(Math.min(1.35, gated * perceptualTilt), 0.74);
    out[i] = clampUnit(normalized);
  }

  return out;
}

/**
 * Generates balanced full-span spectral bands from 5.1 channel levels when converting or
 * running calibration sweeps (ensuring both ends and center move expressively).
 */
export function synthesizeChannelBands(
  levels: ChannelLevels | null | undefined,
  timeSec: number,
  outBands?: Float32Array,
): Float32Array {
  const count = outBands ? outBands.length : STUDIO_BAND_COUNT;
  const out = outBands ?? new Float32Array(count);
  if (!levels) {
    out.fill(0);
    return out;
  }

  const lfe = Math.max(levels.LFE ?? 0, levels.lfeBeat ?? 0);
  const front = ((levels.FL ?? 0) + (levels.FR ?? 0)) * 0.5;
  const center = levels.C ?? 0;
  const surround = ((levels.SL ?? 0) + (levels.SR ?? 0)) * 0.5;

  for (let i = 0; i < count; i++) {
    const u = count > 1 ? i / (count - 1) : 0.5;
    // Left = sub/bass (LFE+Front), Center = vocals/mids (C+Front), Right = air/reverb (Surround+Front)
    const bassWeight = Math.exp(-Math.pow(u / 0.34, 2));
    const midWeight = Math.exp(-Math.pow((u - 0.5) / 0.32, 2));
    const airWeight = Math.exp(-Math.pow((1 - u) / 0.36, 2));

    const ripple =
      0.84 +
      0.16 * Math.sin(u * Math.PI * 5 - timeSec * 4.2) * Math.cos(u * Math.PI * 2 + timeSec * 2.1);

    const val = (lfe * bassWeight + (center * 0.6 + front * 0.55) * midWeight + (surround * 0.75 + front * 0.45) * airWeight) * ripple;
    out[i] = clampUnit(val);
  }
  return out;
}

export interface FullWidthWaveState {
  bands: Float32Array;
  peakCaps: Float32Array;
  primaryWave: Float32Array;
  secondaryWave: Float32Array;
  phase: number;
}

/**
 * Steps smoothed full-span studio waveform + dual-layer harmonic + peak envelope buffers
 * directly driven by real-time frequency analysis. Low frequencies (bass/beat), mids, and
 * highs map dynamically across the full span with snappy attack, silky release, and calm standby.
 */
export function stepFullWidthStudioWave(
  state: FullWidthWaveState,
  targetBands: Float32Array | null,
  _timeSec: number,
  energy: number,
  dtSec: number,
  isActive: boolean,
): void {
  const n = state.bands.length;
  const safeDt = Math.max(0.004, Math.min(0.033, Number.isFinite(dtSec) ? dtSec : 0.016));
  const safeEnergy = isActive ? clampUnit(energy) : 0;

  // Frame-rate-independent attack/release damping (snappy 22/s attack for beats, silky 4.8/s release)
  const attackAlpha = 1 - Math.exp(-safeDt * 22.0);
  const releaseAlpha = 1 - Math.exp(-safeDt * 4.8);
  const peakDecay = safeDt * 0.38;

  for (let i = 0; i < n; i++) {
    const rawTarget = isActive && targetBands ? clampUnit(targetBands[i] ?? 0) : 0;
    const prev = Number.isFinite(state.bands[i]) ? state.bands[i] : 0;
    const alpha = rawTarget >= prev ? attackAlpha : releaseAlpha;
    const smoothed = prev + (rawTarget - prev) * alpha;
    state.bands[i] = smoothed < 0.001 ? 0 : smoothed;
  }

  // Dual-pass spatial smoothing keeps adjacent frequencies continuous and musical
  for (let pass = 0; pass < 2; pass++) {
    let prevVal = state.bands[0] ?? 0;
    for (let i = 1; i < n - 1; i++) {
      const cur = state.bands[i];
      const next = state.bands[i + 1];
      const blended = prevVal * 0.18 + cur * 0.64 + next * 0.18;
      prevVal = cur;
      state.bands[i] = clampUnit(blended);
    }
  }

  // Incremental phase integration prevents jumping or racing when energy fluctuates
  const currentPhase = Number.isFinite(state.phase) ? state.phase : 0;
  const phaseRate = 0.72 + safeEnergy * 0.58;
  const nextPhase = (currentPhase + safeDt * phaseRate) % (Math.PI * 200);
  state.phase = nextPhase;

  for (let i = 0; i < n; i++) {
    const u = n > 1 ? i / (n - 1) : 0.5;
    const taper = computeEdgeTaper(u, 0.48);
    const bandAmp = state.bands[i];

    // Smooth peak cap envelope
    const weightedBand = clampUnit(bandAmp * taper * 1.08);
    const prevPeak = Number.isFinite(state.peakCaps[i]) ? state.peakCaps[i] : 0;
    state.peakCaps[i] =
      weightedBand >= prevPeak ? weightedBand : Math.max(weightedBand, prevPeak - peakDecay);

    // Spatial carrier scales with frequency: longer wavelengths on left (bass), tighter on right (highs)
    const k1 = 1.85 + 3.15 * u;
    const carrier1 =
      Math.sin(u * Math.PI * k1 - nextPhase * (1.15 + 0.45 * u)) * 0.68 +
      Math.cos(u * Math.PI * (k1 * 1.5) + nextPhase * 0.85) * 0.32;

    const k2 = 2.35 + 3.85 * u;
    const carrier2 =
      Math.cos(u * Math.PI * k2 + nextPhase * (1.05 + 0.35 * u) + 0.6) * 0.62 +
      Math.sin(u * Math.PI * (k2 * 1.4) - nextPhase * 0.75) * 0.38;

    // Real-time frequency-driven displacement across the full width
    const activeDrive1 = bandAmp * 1.12 + safeEnergy * 0.16;
    const activeDrive2 = bandAmp * 0.78 + safeEnergy * 0.12;

    // Calm standby breathing wave when paused or quiet
    const idleDrive1 = 0.075 * Math.sin(u * Math.PI * 2 - nextPhase * 0.8);
    const idleDrive2 = 0.052 * Math.cos(u * Math.PI * 2.2 + nextPhase * 0.65);

    const targetWave1 = Math.max(
      -1,
      Math.min(1, (idleDrive1 * (1 - safeEnergy) + carrier1 * activeDrive1) * taper),
    );
    const targetWave2 = Math.max(
      -1,
      Math.min(1, (idleDrive2 * (1 - safeEnergy) + carrier2 * activeDrive2) * taper),
    );

    const prevW1 = Number.isFinite(state.primaryWave[i]) ? state.primaryWave[i] : 0;
    const prevW2 = Number.isFinite(state.secondaryWave[i]) ? state.secondaryWave[i] : 0;
    const waveBlend = 1 - Math.exp(-safeDt * 20.0);
    state.primaryWave[i] = prevW1 + (targetWave1 - prevW1) * waveBlend;
    state.secondaryWave[i] = prevW2 + (targetWave2 - prevW2) * waveBlend;
  }
}

