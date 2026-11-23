import { useEffect, useRef } from 'react';
import type { ChannelLevels } from '../utils/stageAudioPlayer';
import type { TrackEnergyFrame } from '../utils/channelMath';
import {
  computeWaveEnergy,
  stepSmoothedWavePoints,
  WAVE_POINT_COUNT,
} from '../utils/waveMath';

export type WaveActivityMode = 'idle' | 'loaded' | 'playing' | 'converting' | 'sweeping';

interface GlowingWaveVisualizerProps {
  liveLevelsRef: React.MutableRefObject<ChannelLevels>;
  energyProfile: TrackEnergyFrame[];
  activityMode: WaveActivityMode;
}

export function GlowingWaveVisualizer({
  liveLevelsRef,
  energyProfile,
  activityMode,
}: GlowingWaveVisualizerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pointsRef = useRef<Float32Array>(new Float32Array(WAVE_POINT_COUNT));
  const scratchPointsRef = useRef<Float32Array>(new Float32Array(WAVE_POINT_COUNT));
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
    let cssHeight = Math.max(48, container.clientHeight || 56);
    let dpr = Math.min(2, window.devicePixelRatio || 1);

    const syncSize = () => {
      const w = Math.max(240, container.clientWidth || 640);
      const h = Math.max(48, container.clientHeight || 56);
      dpr = Math.min(2, window.devicePixelRatio || 1);
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

      const dtSec = Math.min(0.05, Math.max(0.008, (now - lastNow) * 0.001));
      lastNow = now;
      const t = now * 0.001;

      const { activityMode: mode, energyProfile: profile } = stateRef.current;

      let targetEnergy = 0;
      if (mode === 'playing') {
        targetEnergy = computeWaveEnergy(liveLevelsRef.current, true);
      } else if (mode === 'sweeping') {
        targetEnergy = 0.42 + 0.14 * Math.sin(t * 6);
      } else if (mode === 'converting') {
        if (profile.length > 0) {
          const frame = profile[Math.floor((t * 10) % profile.length)];
          targetEnergy = computeWaveEnergy(
            {
              FL: frame.FL,
              FR: frame.FR,
              C: frame.C,
              LFE: frame.LFE,
              SL: frame.SL,
              SR: frame.SR,
              lfeBeat: frame.lfeBeat,
            },
            true,
          );
        } else {
          targetEnergy = 0.48 + 0.18 * Math.sin(t * 3.5);
        }
      }

      // Heavy exponential smoothing on global energy for fluid glow & amplitude transitions
      const prevE = smoothedEnergyRef.current;
      const eAlpha = targetEnergy >= prevE ? Math.min(0.24, dtSec * 8) : Math.min(0.12, dtSec * 4);
      const smoothE = prevE + (targetEnergy - prevE) * eAlpha;
      smoothedEnergyRef.current = smoothE < 0.002 ? 0 : smoothE;

      // Update wave spline points
      const nextPoints = stepSmoothedWavePoints(
        pointsRef.current,
        reducedMotion ? 0.5 : t,
        reducedMotion ? 0 : smoothedEnergyRef.current,
        dtSec,
        scratchPointsRef.current,
      );
      scratchPointsRef.current = pointsRef.current;
      pointsRef.current = nextPoints;

      ctx.save();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssWidth, cssHeight);

      const midY = cssHeight * 0.5;
      const maxExcursion = cssHeight * 0.42;

      // Subtle dark-obsidian baseline hairline
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.08)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(12, midY);
      ctx.lineTo(cssWidth - 12, midY);
      ctx.stroke();

      // Single continuous smooth glowing wave line (electric cyan -> sky blue -> neon violet)
      const grad = ctx.createLinearGradient(12, 0, cssWidth - 12, 0);
      grad.addColorStop(0, '#00F0FF');
      grad.addColorStop(0.5, '#38BDF8');
      grad.addColorStop(1, '#A855F7');

      ctx.strokeStyle = grad;
      ctx.lineWidth = 2 + smoothedEnergyRef.current * 0.85;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.shadowColor =
        smoothedEnergyRef.current > 0.35
          ? 'rgba(0, 240, 255, 0.85)'
          : 'rgba(56, 189, 248, 0.65)';
      ctx.shadowBlur = 9 + smoothedEnergyRef.current * 14;

      const n = nextPoints.length;
      const padX = 12;
      const spanW = Math.max(40, cssWidth - padX * 2);

      ctx.beginPath();
      const firstX = padX;
      const firstY = midY + nextPoints[0] * maxExcursion;
      ctx.moveTo(firstX, firstY);

      for (let i = 1; i < n - 1; i++) {
        const x = padX + (i / (n - 1)) * spanW;
        const y = midY + nextPoints[i] * maxExcursion;
        const nextX = padX + ((i + 1) / (n - 1)) * spanW;
        const nextY = midY + nextPoints[i + 1] * maxExcursion;
        const midX = (x + nextX) * 0.5;
        const midPtY = (y + nextY) * 0.5;
        ctx.quadraticCurveTo(x, y, midX, midPtY);
      }

      const lastX = padX + spanW;
      const lastY = midY + nextPoints[n - 1] * maxExcursion;
      ctx.lineTo(lastX, lastY);
      ctx.stroke();
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
      className="relative w-full h-14 sm:h-16 min-w-0 max-w-full rounded-xl bg-[#07090E]/92 border border-cyan-400/20 shadow-[inset_0_1px_0_rgba(226,232,240,0.08),inset_0_-1px_8px_rgba(0,0,0,0.75)] overflow-hidden"
      aria-hidden="true"
    >
      <canvas
        ref={canvasRef}
        className="w-full h-full block pointer-events-none"
      />
    </div>
  );
}
