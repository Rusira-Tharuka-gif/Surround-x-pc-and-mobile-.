import type { ChannelLevels } from './stageAudioPlayer';

export const WAVE_POINT_COUNT = 40;

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

  const weighted = front * 0.38 + center * 0.24 + surround * 0.22 + bass * 0.32;
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
