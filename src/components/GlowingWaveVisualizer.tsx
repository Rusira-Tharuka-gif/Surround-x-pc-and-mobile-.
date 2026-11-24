import { useEffect, useRef } from 'react';
import type { ChannelLevels } from '../utils/stageAudioPlayer';
import type { TrackEnergyFrame } from '../utils/channelMath';
import {
  computeEdgeTaper,
  computeWaveEnergy,
  stepFullWidthStudioWave,
  STUDIO_BAND_COUNT,
  synthesizeChannelBands,
  type FullWidthWaveState,
} from '../utils/waveMath';

export type WaveActivityMode = 'idle' | 'loaded' | 'playing' | 'converting' | 'sweeping';

interface GlowingWaveVisualizerProps {
  liveLevelsRef: React.MutableRefObject<ChannelLevels>;
  energyProfile: TrackEnergyFrame[];
  activityMode: WaveActivityMode;
}

function drawSmoothRibbonSpline(
  ctx: CanvasRenderingContext2D,
  values: Float32Array,
  padX: number,
  spanW: number,
  midY: number,
  maxExcursion: number,
) {
  const n = values.length;
  if (n < 2) return;

  ctx.beginPath();
  ctx.moveTo(padX, midY + values[0] * maxExcursion);

  for (let i = 1; i < n - 1; i++) {
    const x = padX + (i / (n - 1)) * spanW;
    const y = midY + values[i] * maxExcursion;
    const nextX = padX + ((i + 1) / (n - 1)) * spanW;
    const nextY = midY + values[i + 1] * maxExcursion;
    ctx.quadraticCurveTo(x, y, (x + nextX) * 0.5, (y + nextY) * 0.5);
  }

  ctx.lineTo(padX + spanW, midY + values[n - 1] * maxExcursion);
  ctx.stroke();
}

export function GlowingWaveVisualizer({
  liveLevelsRef,
  energyProfile,
  activityMode,
}: GlowingWaveVisualizerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const waveStateRef = useRef<FullWidthWaveState>({
    bands: new Float32Array(STUDIO_BAND_COUNT),
    peakCaps: new Float32Array(STUDIO_BAND_COUNT),
    primaryWave: new Float32Array(STUDIO_BAND_COUNT),
    secondaryWave: new Float32Array(STUDIO_BAND_COUNT),
    phase: 0,
  });
  const synthBandsRef = useRef<Float32Array>(new Float32Array(STUDIO_BAND_COUNT));
  const smoothedEnergyRef = useRef<number>(0);

  const stateRef = useRef({
    activityMode,
    energyProfile,
  });
  stateRef.current = {
    activityMode,
    energyProfile,
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const reducedMotion =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    let cssWidth = Math.max(240, container.clientWidth || 640);
    let cssHeight = Math.max(56, container.clientHeight || 72);
    let dpr = Math.min(2.5, window.devicePixelRatio || 1);

    const syncSize = () => {
      const w = Math.max(240, container.clientWidth || 640);
      const h = Math.max(56, container.clientHeight || 72);
      dpr = Math.min(2.5, window.devicePixelRatio || 1);
      cssWidth = w;
      cssHeight = h;
      const backingW = Math.round(w * dpr);
      const backingH = Math.round(h * dpr);
      if (canvas.width !== backingW || canvas.height !== backingH) {
        canvas.width = backingW;
        canvas.height = backingH;
      }
    };

    syncSize();

    const resizeObserver =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => {
            syncSize();
            if (reducedMotion) {
              drawFrame(performance.now(), true);
            }
          })
        : null;
    resizeObserver?.observe(container);

    let rafId = 0;
    let lastNow = performance.now();
    let lastPaint = 0;

    const drawFrame = (now: number, force = false) => {
      if (!force && now - lastPaint < 20) {
        if (!reducedMotion) {
          rafId = requestAnimationFrame((ts) => drawFrame(ts, false));
        }
        return;
      }
      lastPaint = now;

      const dtSec = Math.min(0.033, Math.max(0.004, (now - lastNow) * 0.001));
      lastNow = now;
      const t = now * 0.001;

      const { activityMode: mode, energyProfile: profile } = stateRef.current;

      let targetEnergy = 0;
      let targetBands: Float32Array | null = null;
      const isActive = mode === 'playing' || mode === 'sweeping' || mode === 'converting';

      if (mode === 'playing') {
        const levels = liveLevelsRef.current;
        targetEnergy = computeWaveEnergy(levels, true);
        if (levels.spectrum && levels.spectrum.length === STUDIO_BAND_COUNT) {
          targetBands = levels.spectrum;
        } else {
          targetBands = synthesizeChannelBands(levels, t, synthBandsRef.current);
        }
      } else if (mode === 'sweeping') {
        targetEnergy = 0.48 + 0.14 * Math.sin(t * 6);
        targetBands = synthesizeChannelBands(
          {
            FL: 0.52 + 0.18 * Math.sin(t * 4.2),
            FR: 0.52 + 0.18 * Math.cos(t * 4.2),
            C: 0.55,
            LFE: 0.62,
            SL: 0.48 + 0.16 * Math.sin(t * 3.1 + 1),
            SR: 0.48 + 0.16 * Math.cos(t * 3.1 + 1),
            lfeBeat: 0.58,
          },
          t,
          synthBandsRef.current,
        );
      } else if (mode === 'converting') {
        if (profile.length > 0) {
          const frame = profile[Math.floor((t * 10) % profile.length)];
          const frameLevels: ChannelLevels = {
            FL: frame.FL,
            FR: frame.FR,
            C: frame.C,
            LFE: frame.LFE,
            SL: frame.SL,
            SR: frame.SR,
            lfeBeat: frame.lfeBeat,
          };
          targetEnergy = computeWaveEnergy(frameLevels, true);
          targetBands = synthesizeChannelBands(frameLevels, t, synthBandsRef.current);
        } else {
          const pulse = 0.52 + 0.18 * Math.sin(t * 3.5);
          targetEnergy = pulse;
          targetBands = synthesizeChannelBands(
            {
              FL: pulse,
              FR: pulse,
              C: 0.48 + 0.12 * Math.cos(t * 2.4),
              LFE: 0.56 + 0.22 * Math.sin(t * 4.8),
              SL: 0.45 + 0.15 * Math.sin(t * 2.8 + 0.9),
              SR: 0.45 + 0.15 * Math.cos(t * 2.8 + 0.9),
              lfeBeat: 0.54 + 0.2 * Math.sin(t * 4.8),
            },
            t,
            synthBandsRef.current,
          );
        }
      }

      const prevE = smoothedEnergyRef.current;
      const eRate = targetEnergy >= prevE ? 10.5 : 3.8;
      const eAlpha = 1 - Math.exp(-dtSec * eRate);
      const smoothE = prevE + (targetEnergy - prevE) * eAlpha;
      smoothedEnergyRef.current = smoothE < 0.002 ? 0 : smoothE;

      const waveState = waveStateRef.current;
      stepFullWidthStudioWave(
        waveState,
        targetBands,
        reducedMotion ? 0.5 : t,
        reducedMotion ? 0 : smoothedEnergyRef.current,
        dtSec,
        !reducedMotion && isActive,
      );

      ctx.save();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssWidth, cssHeight);

      const padX = 8;
      const spanW = Math.max(40, cssWidth - padX * 2);
      const midY = cssHeight * 0.5;
      const maxExcursion = cssHeight * 0.44;
      const n = STUDIO_BAND_COUNT;

      // Subtle center studio baseline hairline
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.1)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padX, midY);
      ctx.lineTo(padX + spanW, midY);
      ctx.stroke();

      // 1. Symmetric logarithmic studio spectrum backdrop ribbon (spans full width cleanly)
      const specGrad = ctx.createLinearGradient(padX, 0, padX + spanW, 0);
      specGrad.addColorStop(0, 'rgba(0, 240, 255, 0.22)');
      specGrad.addColorStop(0.5, 'rgba(56, 189, 248, 0.2)');
      specGrad.addColorStop(1, 'rgba(168, 85, 247, 0.24)');

      const stepW = spanW / n;
      const barW = Math.max(1.5, stepW * 0.54);
      ctx.fillStyle = specGrad;
      for (let i = 0; i < n; i++) {
        const u = n > 1 ? i / (n - 1) : 0.5;
        const taper = computeEdgeTaper(u, 0.48);
        const amp = Math.max(0.035, waveState.bands[i] * taper * 0.85);
        const barH = amp * maxExcursion * 2;
        const bx = padX + i * stepW + (stepW - barW) * 0.5;
        const by = midY - barH * 0.5;
        if (typeof ctx.roundRect === 'function') {
          ctx.beginPath();
          ctx.roundRect(bx, by, barW, barH, Math.min(2, barW * 0.5));
          ctx.fill();
        } else {
          ctx.fillRect(bx, by, barW, barH);
        }
      }

      // 2. Subtle mirrored peak-envelope shimmer contour when active
      if (smoothedEnergyRef.current > 0.015) {
        ctx.save();
        ctx.strokeStyle = 'rgba(56, 189, 248, 0.24)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let i = 0; i < n; i++) {
          const x = padX + (i / (n - 1)) * spanW;
          const y = midY - waveState.peakCaps[i] * maxExcursion * 0.92;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();

        ctx.beginPath();
        for (let i = 0; i < n; i++) {
          const x = padX + (i / (n - 1)) * spanW;
          const y = midY + waveState.peakCaps[i] * maxExcursion * 0.92;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.restore();
      }

      // 3. Secondary dual-layer harmonic overtone glow
      const secondaryGrad = ctx.createLinearGradient(padX, 0, padX + spanW, 0);
      secondaryGrad.addColorStop(0, 'rgba(168, 85, 247, 0.46)');
      secondaryGrad.addColorStop(0.5, 'rgba(56, 189, 248, 0.42)');
      secondaryGrad.addColorStop(1, 'rgba(0, 240, 255, 0.48)');

      ctx.strokeStyle = secondaryGrad;
      ctx.lineWidth = 1.45 + smoothedEnergyRef.current * 0.45;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      drawSmoothRibbonSpline(ctx, waveState.secondaryWave, padX, spanW, midY, maxExcursion);

      // 4. Primary crisp neon cyan -> sky -> electric violet master ribbon (fast layered halo + bright core)
      const glowGrad = ctx.createLinearGradient(padX, 0, padX + spanW, 0);
      glowGrad.addColorStop(0, 'rgba(0, 240, 255, 0.22)');
      glowGrad.addColorStop(0.5, 'rgba(56, 189, 248, 0.2)');
      glowGrad.addColorStop(1, 'rgba(168, 85, 247, 0.24)');
      ctx.strokeStyle = glowGrad;
      ctx.lineWidth = 6 + smoothedEnergyRef.current * 2.5;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      drawSmoothRibbonSpline(ctx, waveState.primaryWave, padX, spanW, midY, maxExcursion);

      const primaryGrad = ctx.createLinearGradient(padX, 0, padX + spanW, 0);
      primaryGrad.addColorStop(0, '#00F0FF');
      primaryGrad.addColorStop(0.5, '#38BDF8');
      primaryGrad.addColorStop(1, '#A855F7');

      ctx.strokeStyle = primaryGrad;
      ctx.lineWidth = 2.15 + smoothedEnergyRef.current * 0.85;
      drawSmoothRibbonSpline(ctx, waveState.primaryWave, padX, spanW, midY, maxExcursion);

      ctx.restore();

      if (!reducedMotion && document.visibilityState !== 'hidden') {
        rafId = requestAnimationFrame((ts) => drawFrame(ts, false));
      }
    };

    const handleVisibility = () => {
      if (document.visibilityState === 'visible' && !reducedMotion) {
        if (rafId) cancelAnimationFrame(rafId);
        lastNow = performance.now();
        rafId = requestAnimationFrame((ts) => drawFrame(ts, true));
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);

    drawFrame(performance.now(), true);

    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      document.removeEventListener('visibilitychange', handleVisibility);
      resizeObserver?.disconnect();
    };
  }, [liveLevelsRef]);

  return (
    <div
      ref={containerRef}
      data-testid="glowing-wave-visualizer"
      data-wave-mode={activityMode}
      className="relative w-full h-16 sm:h-20 min-w-0 max-w-full rounded-xl bg-[#07090E]/92 border border-cyan-400/20 shadow-[inset_0_1px_0_rgba(226,232,240,0.08),inset_0_-1px_8px_rgba(0,0,0,0.75)] overflow-hidden"
      aria-hidden="true"
    >
      <canvas
        ref={canvasRef}
        className="w-full h-full block pointer-events-none"
      />
    </div>
  );
}
